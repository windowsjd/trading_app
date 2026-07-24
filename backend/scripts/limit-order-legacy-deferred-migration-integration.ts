/**
 * EXISTING-DATABASE UPGRADE runner for the deferred-candle revision
 * provenance migration (real PostgreSQL).
 *
 * WHAT THIS PROVES, AND WHY AN ORDINARY RUNTIME TEST CANNOT
 * --------------------------------------------------------
 * Every other path-B suite runs against a database with ALL migrations
 * applied and then manipulates rows. The defect closed here only exists in the
 * ORDER migrations were applied in, so it can only be reproduced by actually
 * upgrading a database through the intermediate state:
 *
 *   1. migrations up to 20260723210000 — `limit_order_deferred_candles` has no
 *      `candle_ingest_seq` column at all;
 *   2. revision 1 of a candle fails and is parked as PERMANENT (a real row,
 *      written while the column does not exist);
 *   3. the candle is CORRECTED — the ingest trigger re-sequences it to
 *      revision 2 — while the entry sits there;
 *   4. 20260723230000 adds the column and backfills it with the candle's
 *      CURRENT revision, so the permanent entry now asserts "revision 2 is
 *      tracked" — which nothing ever verified. From here revision 2 is
 *      unreachable: the forward scan excludes the candle (tracked >= current)
 *      and the retry loop skips the entry (permanent);
 *   5. 20260724120000 reopens it for re-verification.
 *
 * The runner then drives the REAL sweep to prove revision 2 is processed, that
 * a newly-qualifying submitted order fills once at the LIMIT price, and that
 * an already-executed order is untouched.
 *
 * Scenario B covers the unrecoverable case (the candle row is gone: parked as
 * a legacy orphan, blocking ONLY its own asset), and scenario C covers the
 * no-op case (a revision-aware entry written after step 4 keeps its retry
 * state).
 *
 * REQUIRES A DISPOSABLE POSTGRESQL SERVER. It creates its OWN scratch
 * database, upgrades that, and drops it again; DATABASE_URL is used only to
 * reach the server and to name the maintenance connection. The database the
 * rest of the suite uses is never migrated backwards and never written to.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { LimitOrderCandleReconciliationService } from '../src/orders/limit-matching/limit-order-candle-reconciliation.service';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import { LimitOrderMatchBoundaryService } from '../src/orders/limit-matching/limit-order-match-boundary.service';
import { LimitOrderReconciliationCheckpointRepository } from '../src/orders/limit-matching/limit-order-reconciliation-checkpoint.repository';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN = process.env.LIMIT_ORDER_LEGACY_DEFERRED_MIGRATION_INTEGRATION;
if (RUN !== '1') {
  console.log(
    'limit order legacy deferred migration integration skipped (set LIMIT_ORDER_LEGACY_DEFERRED_MIGRATION_INTEGRATION=1)',
  );
  process.exit(0);
}

// Like the other runners in this directory, this one is invoked from
// `backend/` (package script, or the spec that spawns it with that cwd). The
// assertion turns a wrong cwd into a clear failure instead of a confusing
// migration error.
const BACKEND_ROOT = resolve(process.cwd());
const MIGRATIONS_ROOT = join(BACKEND_ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = join(BACKEND_ROOT, 'prisma', 'schema.prisma');
assert.ok(
  existsSync(SCHEMA_PATH) && existsSync(MIGRATIONS_ROOT),
  'run this from the backend/ directory: prisma/schema.prisma was not found.',
);

/** Last migration BEFORE `candle_ingest_seq` existed on the deferred queue. */
const PHASE_1_THROUGH =
  '20260723210000_add_limit_order_window_completion_and_candle_revision';
/** The migration that introduced the column and its inferring backfill. */
const PHASE_2_THROUGH =
  '20260723230000_add_limit_order_deferred_candle_revision_and_completion_health';
/**
 * The first provenance migration. Its legacy criterion compared the
 * APPLICATION-written created_at to the DATABASE-written migration
 * finished_at — two different clock domains — so a legacy row whose
 * application clock ran ahead of the database escaped it (see phase 3
 * assertions below).
 */
const PROVENANCE_MIGRATION =
  '20260724120000_add_limit_order_deferred_revision_provenance_and_asset_gap';
/**
 * The clock-independent re-verification migration under test: any queue row
 * with neither revision_verified_at nor revision_migrated_at is reclassified,
 * whatever its created_at says.
 */
const REVERIFY_MIGRATION =
  '20260724200000_reverify_limit_order_deferred_unverified_revision_provenance';

const FIVE_MINUTES_MS = 5 * 60_000;
const SUFFIX = `${process.pid}_${Date.now()}`;
const SCRATCH_DB = `limit_order_legacy_upgrade_${SUFFIX}`;

const workdir = mkdtempSync(join(tmpdir(), 'limit-order-legacy-migration-'));

async function main(): Promise<void> {
  const serverUrl = requireDatabaseUrl();
  const scratchUrl = withDatabase(serverUrl, SCRATCH_DB);
  await createScratchDatabase(serverUrl);
  let client: Client | null = null;
  try {
    deployThrough('phase1', PHASE_1_THROUGH, scratchUrl);
    client = new Client({ connectionString: scratchUrl });
    await client.connect();

    const fixture = await seedLegacyState(client);
    deployThrough('phase2', PHASE_2_THROUGH, scratchUrl);
    await run(
      'the pre-fix backfill stamps a permanent entry with the CORRECTED revision',
      () => assertDefectReproduced(client!, fixture),
    );

    // A revision-aware entry written between the backfill migration and the
    // provenance migrations. Its revision WAS genuinely observed, but nothing
    // durable proves that (revision_verified_at did not exist yet), so the
    // clock-independent policy conservatively re-verifies it too.
    const modern = await seedModernDeferred(client, fixture);

    // Phase 3: the FIRST provenance migration alone. It classifies by
    // comparing the application-written created_at to the migration ledger's
    // finished_at — which is exactly what the clock-skew fixtures expose.
    deployThrough('phase3', PROVENANCE_MIGRATION, scratchUrl);
    await run(
      'the created_at boundary reopens past-clock rows but MISSES future-clock rows',
      () => assertClockSkewDefectReproduced(client!, fixture),
    );

    deployAll(scratchUrl);
    await run(
      'the provenance migration reopens the legacy permanent entry for re-verification',
      () => assertLegacyReactivated(client!, fixture),
    );
    await run(
      'a legacy entry whose candle is gone stays parked as an orphan',
      () => assertLegacyOrphan(client!, fixture),
    );
    await run(
      'a future-created_at legacy entry is reopened despite the clock skew',
      () => assertFutureSkewReactivated(client!, fixture),
    );
    await run(
      'a future-created_at legacy entry without a candle becomes an orphan',
      () => assertFutureSkewOrphan(client!, fixture),
    );
    await run(
      'an unverified revision-aware entry is conservatively re-verified',
      () => assertModernReverified(client!, modern),
    );
    const verified = await seedVerifiedModernDeferred(client, fixture);
    await run(
      'a runtime-verified entry is untouched by the re-verification migration',
      () => assertVerifiedModernUntouched(client!, verified),
    );
    await run('re-running the provenance migrations changes nothing', () =>
      assertMigrationIsIdempotent(client!, fixture, verified),
    );
    await run(
      'the reopened entry lets the sweep process the corrected revision',
      () => assertSweepRecoversRevisionTwo(scratchUrl, fixture),
    );

    console.log('limit order legacy deferred migration integration ok');
  } finally {
    if (client) await client.end().catch(() => undefined);
    await dropScratchDatabase(serverUrl);
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Scratch database + staged migration deploys
// ---------------------------------------------------------------------------

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  assert.ok(url, 'DATABASE_URL must be configured.');
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function createScratchDatabase(serverUrl: string): Promise<void> {
  const admin = new Client({
    connectionString: withDatabase(serverUrl, 'postgres'),
  });
  await admin.connect();
  try {
    // Identifier interpolation is unavoidable for CREATE DATABASE; the name is
    // generated here from a pid and a timestamp, never from input.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  } finally {
    await admin.end();
  }
}

async function dropScratchDatabase(serverUrl: string): Promise<void> {
  const admin = new Client({
    connectionString: withDatabase(serverUrl, 'postgres'),
  });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [SCRATCH_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Applies migrations up to and including `through`, using a temporary
 * migrations directory that contains only those folders. This is what makes
 * the intermediate schema state real rather than simulated: Prisma records
 * each one in `_prisma_migrations` with a genuine `finished_at`, which is the
 * boundary the provenance migration reads to tell legacy rows from new ones.
 */
function deployThrough(label: string, through: string, url: string): void {
  const migrations = join(workdir, `${label}-migrations`);
  cpSync(MIGRATIONS_ROOT, migrations, {
    recursive: true,
    filter: (source) => {
      const name = source.slice(MIGRATIONS_ROOT.length + 1);
      if (name === '' || name === 'migration_lock.toml') return true;
      const [folder] = name.split('/');
      return folder <= through;
    },
  });
  deployWithConfig(label, migrations, url);
}

/** Applies every migration in the repository, i.e. the real upgrade. */
function deployAll(url: string): void {
  deployWithConfig('final', MIGRATIONS_ROOT, url);
}

function deployWithConfig(
  label: string,
  migrationsPath: string,
  url: string,
): void {
  // A minimal config with no imports, so it can live outside the project and
  // still be loaded: `defineConfig` is only a typing helper.
  const configPath = join(workdir, `${label}.config.ts`);
  writeFileSync(
    configPath,
    `export default {
  schema: ${JSON.stringify(SCHEMA_PATH)},
  migrations: { path: ${JSON.stringify(migrationsPath)} },
  datasource: { url: process.env.LEGACY_UPGRADE_DATABASE_URL },
};
`,
    'utf8',
  );
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', configPath],
    {
      cwd: BACKEND_ROOT,
      env: { ...process.env, LEGACY_UPGRADE_DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `prisma migrate deploy (${label}) failed`,
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures, written directly in SQL against the intermediate schema
// ---------------------------------------------------------------------------

type Fixture = {
  assetA: string;
  assetB: string;
  /**
   * The application-clock-runs-AHEAD asset: its legacy queue rows carry a
   * created_at ten minutes in the DATABASE's future, so the created_at
   * boundary of the first provenance migration mistakes them for modern rows.
   */
  assetC: string;
  /** Future-created_at legacy entry whose candle row is already gone. */
  assetD: string;
  candleA: string;
  candleB: string;
  candleC: string;
  candleD: string;
  /** Ingest sequence of candle A at revision 1, before the correction. */
  revisionOne: string;
  /** Ingest sequence of candle A at revision 2, after the correction. */
  revisionTwo: string;
  /** Ingest sequences of candle C before and after ITS correction. */
  revisionOneC: string;
  revisionTwoC: string;
  openTime: Date;
  closeTime: Date;
  seasonId: string;
  /** Still SUBMITTED; the corrected low newly qualifies it. */
  pendingOrderId: string;
  /** Already EXECUTED before the correction; must never fill twice. */
  executedOrderId: string;
  pendingParticipantId: string;
  /** Asset C's pending/executed pair, mirroring asset A under future skew. */
  pendingOrderIdC: string;
  executedOrderIdC: string;
};

async function seedLegacyState(client: Client): Promise<Fixture> {
  const now = await databaseNow(client);
  // A window comfortably in the past but well inside retention, so nothing
  // here is a retention finding.
  const openTime = alignWindow(new Date(now.getTime() - 6 * 3_600_000));
  const closeTime = new Date(openTime.getTime() + FIVE_MINUTES_MS);

  const seasonId = randomUUID();
  await client.query(
    `INSERT INTO "seasons" (
       "id", "name", "status", "start_at", "end_at", "initial_capital_krw",
       "trade_fee_rate", "fx_fee_rate", "created_at", "updated_at"
     ) VALUES ($1, $2, 'active', $3, $4, '1300000', '0.001000', '0.001000', $5, $5)`,
    [
      seasonId,
      `legacy-upgrade-${SUFFIX}`,
      ts(new Date(now.getTime() - 86_400_000)),
      ts(new Date(now.getTime() + 86_400_000)),
      ts(now),
    ],
  );

  // Every path-B fill records an equity valuation in KRW, so the USD assets
  // below need a rate the ordinary FX pipeline would have supplied.
  await client.query(
    `INSERT INTO "fx_rate_snapshots" (
       "id", "base_currency", "quote_currency", "rate", "source_type",
       "source_name", "source_timestamp", "effective_at", "captured_at",
       "created_at"
     ) VALUES ($1, 'USD', 'KRW', '1300.00000000', 'provider_api',
       'exchange_rate_api', $2, $2, $2, $2)`,
    [randomUUID(), ts(now)],
  );

  const assetA = await insertAsset(client, 'A');
  const assetB = await insertAsset(client, 'B');
  const assetC = await insertAsset(client, 'C');
  const assetD = await insertAsset(client, 'D');
  await insertPriceSnapshot(client, assetA, now);
  await insertPriceSnapshot(client, assetB, now);
  await insertPriceSnapshot(client, assetC, now);
  await insertPriceSnapshot(client, assetD, now);

  // Both orders were activated for this window (eligibleFrom <= openTime).
  const pending = await insertSubmittedOrder(client, {
    seasonId,
    assetId: assetA,
    label: 'pending',
    // A limit BELOW revision 1's low and AT OR ABOVE revision 2's corrected
    // low: this is the order the correction newly qualifies.
    limitPrice: '95.00000000',
    openTime,
    now,
  });
  const executed = await insertSubmittedOrder(client, {
    seasonId,
    assetId: assetA,
    label: 'executed',
    limitPrice: '120.00000000',
    openTime,
    now,
  });
  // Mark the second one already filled, exactly as a path-A fill leaves it —
  // every column the `orders_executed_limit_amounts_check` constraint demands,
  // including the price snapshot only path A can produce. The status guard —
  // not this runner — is what must keep it filled once.
  const snapshotId = await latestPriceSnapshotId(client, assetA);
  await client.query(
    `UPDATE "orders"
        SET "status" = 'executed',
            "executed_price" = '120.00000000',
            "gross_amount" = '120.00000000',
            "fee_amount" = '0.12000000',
            "net_amount" = '120.12000000',
            "executed_at" = $2,
            "matched_at" = $2,
            "reservation_released_at" = $2,
            "matching_source" = 'live_trade_event',
            "trigger_event_id" = $3,
            "trigger_event_at" = $2,
            "asset_price_snapshot_id" = $4
      WHERE "id" = $1`,
    [executed.orderId, ts(now), `legacy-path-a-${SUFFIX}`, snapshotId],
  );

  // Asset C mirrors asset A exactly — a newly-qualified pending order and an
  // already-executed one — but its legacy queue rows will carry a FUTURE
  // created_at, which is the clock-skew case under test.
  const pendingC = await insertSubmittedOrder(client, {
    seasonId,
    assetId: assetC,
    label: 'pending-c',
    limitPrice: '95.00000000',
    openTime,
    now,
  });
  const executedC = await insertSubmittedOrder(client, {
    seasonId,
    assetId: assetC,
    label: 'executed-c',
    limitPrice: '120.00000000',
    openTime,
    now,
  });
  const snapshotIdC = await latestPriceSnapshotId(client, assetC);
  await client.query(
    `UPDATE "orders"
        SET "status" = 'executed',
            "executed_price" = '120.00000000',
            "gross_amount" = '120.00000000',
            "fee_amount" = '0.12000000',
            "net_amount" = '120.12000000',
            "executed_at" = $2,
            "matched_at" = $2,
            "reservation_released_at" = $2,
            "matching_source" = 'live_trade_event',
            "trigger_event_id" = $3,
            "trigger_event_at" = $2,
            "asset_price_snapshot_id" = $4
      WHERE "id" = $1`,
    [executedC.orderId, ts(now), `legacy-path-a-c-${SUFFIX}`, snapshotIdC],
  );

  const candleA = await insertClosedCandle(client, {
    assetId: assetA,
    openTime,
    closeTime,
    low: '99.00000000',
  });
  const candleB = await insertClosedCandle(client, {
    assetId: assetB,
    openTime,
    closeTime,
    low: '99.00000000',
  });
  const candleC = await insertClosedCandle(client, {
    assetId: assetC,
    openTime,
    closeTime,
    low: '99.00000000',
  });
  const candleD = await insertClosedCandle(client, {
    assetId: assetD,
    openTime,
    closeTime,
    low: '99.00000000',
  });
  const revisionOne = await ingestSeqOf(client, candleA);
  const revisionOneC = await ingestSeqOf(client, candleC);

  // The legacy queue rows: written while `candle_ingest_seq` does not exist,
  // which is exactly why their revision can never be reconstructed.
  //
  // created_at is written EXPLICITLY skewed in both directions. The runtime
  // stamps created_at from the APPLICATION clock (upsertDeferred passes its
  // own `now`), so relative to the database clock that the migration ledger
  // uses it can sit on either side of reality:
  //   A, B  ->  ten minutes in the DB past   (application clock BEHIND)
  //   C, D  ->  ten minutes in the DB future (application clock AHEAD)
  // A correct classification must not depend on that direction at all.
  const pastSkewMs = -10 * 60_000;
  const futureSkewMs = 10 * 60_000;
  await insertLegacyDeferred(client, {
    marketCandleId: candleA,
    assetId: assetA,
    openTime,
    closeTime,
    now,
    createdAtSkewMs: pastSkewMs,
  });
  await insertLegacyDeferred(client, {
    marketCandleId: candleB,
    assetId: assetB,
    openTime,
    closeTime,
    now,
    createdAtSkewMs: pastSkewMs,
  });
  await insertLegacyDeferred(client, {
    marketCandleId: candleC,
    assetId: assetC,
    openTime,
    closeTime,
    now,
    createdAtSkewMs: futureSkewMs,
  });
  await insertLegacyDeferred(client, {
    marketCandleId: candleD,
    assetId: assetD,
    openTime,
    closeTime,
    now,
    createdAtSkewMs: futureSkewMs,
  });

  // THE CORRECTION. A lower low is precisely a change that can make a window
  // newly fillable, and the ingest trigger re-sequences the row for it. Both
  // clock directions get the identical correction, so any divergence in the
  // outcome can only come from the classification policy.
  await client.query(
    `UPDATE "market_candles" SET "low" = '94.00000000', "updated_at" = $2 WHERE "id" = $1`,
    [candleA, ts(now)],
  );
  const revisionTwo = await ingestSeqOf(client, candleA);
  assert.ok(
    BigInt(revisionTwo) > BigInt(revisionOne),
    'the correction must have produced a new candle revision',
  );
  await client.query(
    `UPDATE "market_candles" SET "low" = '94.00000000', "updated_at" = $2 WHERE "id" = $1`,
    [candleC, ts(now)],
  );
  const revisionTwoC = await ingestSeqOf(client, candleC);
  assert.ok(
    BigInt(revisionTwoC) > BigInt(revisionOneC),
    'the correction must have produced a new revision of candle C',
  );

  // Scenario B's subject: asset B's candle row is removed by retention while
  // its legacy entry stays behind. Deleting it here (before the backfill) is
  // what makes the backfill leave that entry's revision NULL. Asset D is the
  // same loss under FUTURE clock skew.
  await client.query(`DELETE FROM "market_candles" WHERE "id" = $1`, [candleB]);
  await client.query(`DELETE FROM "market_candles" WHERE "id" = $1`, [candleD]);

  return {
    assetA,
    assetB,
    assetC,
    assetD,
    candleA,
    candleB,
    candleC,
    candleD,
    revisionOne,
    revisionTwo,
    revisionOneC,
    revisionTwoC,
    openTime,
    closeTime,
    seasonId,
    pendingOrderId: pending.orderId,
    executedOrderId: executed.orderId,
    pendingParticipantId: pending.participantId,
    pendingOrderIdC: pendingC.orderId,
    executedOrderIdC: executedC.orderId,
  };
}

async function insertAsset(client: Client, label: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "assets" (
       "id", "symbol", "name", "market", "asset_type", "currency_code",
       "price_currency", "settlement_currency", "is_active", "created_at", "updated_at"
     ) VALUES ($1, $2, $3, 'BINANCE', 'crypto', 'USD', 'USD', 'USD', true,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      `LG${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
      `legacy-${label}`,
    ],
  );
  return id;
}

async function latestPriceSnapshotId(
  client: Client,
  assetId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT "id" FROM "asset_price_snapshots" WHERE "asset_id" = $1
      ORDER BY "captured_at" DESC LIMIT 1`,
    [assetId],
  );
  assert.ok(rows[0], 'the fixture must have seeded a price snapshot');
  return rows[0].id;
}

async function insertPriceSnapshot(
  client: Client,
  assetId: string,
  now: Date,
): Promise<void> {
  // Path B records an equity valuation on every fill and reads the ordinary
  // market-price pipeline for it; the candle is evidence, never a price.
  await client.query(
    `INSERT INTO "asset_price_snapshots" (
       "id", "asset_id", "price", "currency_code", "source_type", "source_name",
       "source_timestamp", "effective_at", "captured_at", "created_at"
     ) VALUES ($1, $2, '100.00000000', 'USD', 'provider_api',
       'binance_spot_ws_trade', $3, $3, $3, $3)`,
    [randomUUID(), assetId, ts(now)],
  );
}

async function insertSubmittedOrder(
  client: Client,
  input: {
    seasonId: string;
    assetId: string;
    label: string;
    limitPrice: string;
    openTime: Date;
    now: Date;
  },
): Promise<{ orderId: string; participantId: string }> {
  const userId = randomUUID();
  const participantId = randomUUID();
  const orderId = randomUUID();
  const reserved = (Number(input.limitPrice) * 1.001).toFixed(8);
  await client.query(
    `INSERT INTO "users" (
       "id", "email", "password_hash", "nickname", "created_at", "updated_at"
     ) VALUES ($1, $2, 'integration-test-only', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      userId,
      `legacy-${input.label}-${SUFFIX}@example.com`,
      `legacy-${input.label}-${SUFFIX}`.slice(0, 40),
    ],
  );
  await client.query(
    `INSERT INTO "season_participants" (
       "id", "season_id", "user_id", "joined_at", "participant_status",
       "initial_capital_krw", "total_asset_krw", "total_return_rate",
       "max_drawdown", "created_at", "updated_at"
     ) VALUES ($1, $2, $3, $4, 'active', '1300000', '1300000', '0', '0', $4, $4)`,
    [participantId, input.seasonId, userId, ts(input.now)],
  );
  await client.query(
    `INSERT INTO "cash_wallets" (
       "id", "season_participant_id", "currency_code", "balance_amount",
       "reserved_amount", "created_at", "updated_at"
     ) VALUES ($1, $2, 'USD', '1000.00000000', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($4, $2, 'KRW', '0', '0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [randomUUID(), participantId, reserved, randomUUID()],
  );
  // Submitted exactly ON the window boundary, so eligibleFrom rounds up to
  // that same boundary and the order is activated for this window.
  await client.query(
    `INSERT INTO "orders" (
       "id", "season_participant_id", "asset_id", "side", "order_type", "status",
       "quantity", "limit_price", "currency_code", "reserved_amount",
       "reservation_fee_rate", "matching_activated_at",
       "matching_activation_stream_id", "candle_matching_eligible_from",
       "idempotency_key", "request_hash", "submitted_at", "created_at", "updated_at"
     ) VALUES ($1, $2, $3, 'buy', 'limit', 'submitted', '1.00000000', $4, 'USD',
       $5, '0.001000', $6, $7, $6, $8, $8, $6, $6, $6)`,
    [
      orderId,
      participantId,
      input.assetId,
      input.limitPrice,
      reserved,
      ts(input.openTime),
      `${input.openTime.getTime()}-0`,
      `legacy-${input.label}-${SUFFIX}`,
    ],
  );
  return { orderId, participantId };
}

async function insertClosedCandle(
  client: Client,
  input: { assetId: string; openTime: Date; closeTime: Date; low: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "market_candles" (
       "id", "asset_id", "interval", "open_time", "close_time", "open", "high",
       "low", "close", "volume", "amount", "is_closed", "source_provider",
       "source_updated_at", "created_at", "updated_at"
     ) VALUES ($1, $2, '5m', $3, $4, '100.00000000', '110.00000000', $5,
       '105.00000000', '10.00000000', '1000.00000000', true,
       'binance_spot_ws_5m_kline', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, input.assetId, ts(input.openTime), ts(input.closeTime), input.low],
  );
  return id;
}

/**
 * A queue row exactly as the pre-column code wrote it: no revision, retry
 * budget exhausted, parked as permanent.
 *
 * `createdAtSkewMs` shifts created_at relative to the database clock in
 * either direction, reproducing the application clock the runtime actually
 * writes there. The classification under test must be independent of it.
 */
async function insertLegacyDeferred(
  client: Client,
  input: {
    marketCandleId: string;
    assetId: string;
    openTime: Date;
    closeTime: Date;
    now: Date;
    createdAtSkewMs?: number;
  },
): Promise<void> {
  const createdAt = new Date(
    input.now.getTime() + (input.createdAtSkewMs ?? 0),
  );
  await client.query(
    `INSERT INTO "limit_order_deferred_candles" (
       "market_candle_id", "asset_id", "interval", "open_time", "close_time",
       "status", "first_deferred_at", "last_deferred_at", "attempt_count",
       "last_error_code", "last_error_message", "next_retry_at", "created_at",
       "updated_at"
     ) VALUES ($1, $2, '5m', $3, $4, 'permanent', $5, $5, 5,
       'LIMIT_ORDER_CANDLE_VALUATION_UNAVAILABLE', 'legacy failure', $5, $6, $6)`,
    [
      input.marketCandleId,
      input.assetId,
      ts(input.openTime),
      ts(input.closeTime),
      ts(input.now),
      ts(createdAt),
    ],
  );
}

/**
 * A revision-aware entry written AFTER the backfill migration but BEFORE the
 * provenance migrations, i.e. by code that observed the revision without yet
 * having anywhere to record that observation (revision_verified_at did not
 * exist). The clock-independent policy treats "no durable proof" as
 * "re-verify", so this row is EXPECTED to be conservatively reopened.
 */
async function seedModernDeferred(
  client: Client,
  fixture: Fixture,
): Promise<{ marketCandleId: string; assetId: string; attemptCount: number }> {
  const assetId = await insertAsset(client, 'modern');
  await insertPriceSnapshot(client, assetId, await databaseNow(client));
  const marketCandleId = await insertClosedCandle(client, {
    assetId,
    openTime: fixture.openTime,
    closeTime: fixture.closeTime,
    low: '99.00000000',
  });
  const seq = await ingestSeqOf(client, marketCandleId);
  await client.query(
    `INSERT INTO "limit_order_deferred_candles" (
       "market_candle_id", "candle_ingest_seq", "asset_id", "interval",
       "open_time", "close_time", "status", "first_deferred_at",
       "last_deferred_at", "attempt_count", "last_error_code",
       "last_error_message", "next_retry_at", "created_at", "updated_at"
     ) VALUES ($1, $2, $3, '5m', $4, $5, 'deferred', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, 3, 'LIMIT_ORDER_CANDLE_VALUATION_UNAVAILABLE',
       'modern failure', CURRENT_TIMESTAMP + interval '1 hour',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [marketCandleId, seq, assetId, ts(fixture.openTime), ts(fixture.closeTime)],
  );
  return { marketCandleId, assetId, attemptCount: 3 };
}

/**
 * An entry exactly as the CURRENT runtime leaves it: concrete observed
 * revision, revision_state 'current' and a DB-clock revision_verified_at.
 * This is the one class of row the re-verification migration must never
 * touch. Seeded after the full deploy (the columns exist by then); the
 * assertion re-applies the migration SQL by hand.
 */
async function seedVerifiedModernDeferred(
  client: Client,
  fixture: Fixture,
): Promise<{ marketCandleId: string; assetId: string; attemptCount: number }> {
  const assetId = await insertAsset(client, 'verified');
  await insertPriceSnapshot(client, assetId, await databaseNow(client));
  const marketCandleId = await insertClosedCandle(client, {
    assetId,
    openTime: fixture.openTime,
    closeTime: fixture.closeTime,
    low: '99.00000000',
  });
  const seq = await ingestSeqOf(client, marketCandleId);
  await client.query(
    `INSERT INTO "limit_order_deferred_candles" (
       "market_candle_id", "candle_ingest_seq", "asset_id", "interval",
       "open_time", "close_time", "status", "first_deferred_at",
       "last_deferred_at", "attempt_count", "last_error_code",
       "last_error_message", "next_retry_at", "revision_state",
       "revision_verified_at", "created_at", "updated_at"
     ) VALUES ($1, $2, $3, '5m', $4, $5, 'deferred', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, 3, 'LIMIT_ORDER_CANDLE_VALUATION_UNAVAILABLE',
       'verified failure', CURRENT_TIMESTAMP + interval '1 hour', 'current',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [marketCandleId, seq, assetId, ts(fixture.openTime), ts(fixture.closeTime)],
  );
  return { marketCandleId, assetId, attemptCount: 3 };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

type DeferredRow = {
  status: string;
  candle_ingest_seq: string | null;
  revision_state: string;
  revision_migrated_at: Date | null;
  revision_verified_at: Date | null;
  attempt_count: number;
  first_deferred_at: Date;
  next_retry_at: Date;
  last_error_code: string | null;
};

async function deferredRow(
  client: Client,
  marketCandleId: string,
): Promise<DeferredRow> {
  const { rows } = await client.query<DeferredRow>(
    `SELECT * FROM "limit_order_deferred_candles" WHERE "market_candle_id" = $1`,
    [marketCandleId],
  );
  assert.ok(rows[0], `deferred row for ${marketCandleId} must exist`);
  return rows[0];
}

/**
 * The state the OLD code left behind, asserted before the fix is applied. If
 * this ever stops holding, the fix below is protecting against nothing and the
 * suite must be re-derived rather than quietly passing.
 */
async function assertDefectReproduced(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  const row = await deferredRow(client, fixture.candleA);
  assert.equal(row.status, 'permanent');
  assert.equal(
    row.candle_ingest_seq,
    fixture.revisionTwo,
    'the backfill stamps the CORRECTED revision on an entry that never processed it',
  );

  // Both directions are closed, which is what makes the miss permanent.
  const { rows: scan } = await client.query(
    `SELECT 1 FROM "market_candles" c
      WHERE c."id" = $1
        AND NOT EXISTS (
          SELECT 1 FROM "limit_order_deferred_candles" d
          WHERE d."market_candle_id" = c."id"
            AND d."candle_ingest_seq" >= c."ingest_seq"
        )`,
    [fixture.candleA],
  );
  assert.equal(
    scan.length,
    0,
    'the forward scan must be excluding the corrected candle at this point',
  );
  const { rows: retryable } = await client.query(
    `SELECT 1 FROM "limit_order_deferred_candles"
      WHERE "market_candle_id" = $1 AND "status" = 'deferred'`,
    [fixture.candleA],
  );
  assert.equal(
    retryable.length,
    0,
    'the retry loop must be skipping the permanent entry at this point',
  );

  // Asset B's entry got no revision at all: its candle row was already gone.
  const orphan = await deferredRow(client, fixture.candleB);
  assert.equal(orphan.candle_ingest_seq, null);

  // The FUTURE-created_at rows are in the identical trap: C stamped with the
  // corrected revision it never processed, D with nothing at all.
  const futureRow = await deferredRow(client, fixture.candleC);
  assert.equal(futureRow.status, 'permanent');
  assert.equal(futureRow.candle_ingest_seq, fixture.revisionTwoC);
  const futureOrphan = await deferredRow(client, fixture.candleD);
  assert.equal(futureOrphan.candle_ingest_seq, null);
}

/**
 * Phase 3 = the FIRST provenance migration alone. Its created_at boundary
 * works for rows whose application clock was at or behind the database clock
 * (assets A and B), and silently MISSES rows whose application clock ran
 * ahead (assets C and D): they still look like trusted modern rows, so the
 * corrected revision of candle C remains unreachable from both directions.
 * This is the defect the clock-independent migration closes; if this
 * assertion ever stops holding, that migration protects against nothing.
 */
async function assertClockSkewDefectReproduced(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  // Past-skew rows: correctly reclassified by the created_at boundary.
  const past = await deferredRow(client, fixture.candleA);
  assert.equal(past.revision_state, 'legacy_unknown');
  assert.equal(past.status, 'deferred');
  const pastOrphan = await deferredRow(client, fixture.candleB);
  assert.equal(pastOrphan.revision_state, 'legacy_orphan');

  // Future-skew rows: MISSED. Still 'current', still permanent, still
  // asserting a revision nothing ever verified.
  const future = await deferredRow(client, fixture.candleC);
  assert.equal(
    future.revision_state,
    'current',
    'the created_at boundary must have mistaken the future-clock row for modern',
  );
  assert.equal(future.status, 'permanent');
  assert.equal(future.candle_ingest_seq, fixture.revisionTwoC);
  assert.equal(future.revision_migrated_at, null);
  assert.equal(future.revision_verified_at, null);

  // Both recovery directions are closed for candle C at this point.
  const { rows: scan } = await client.query(
    `SELECT 1 FROM "market_candles" c
      WHERE c."id" = $1
        AND NOT EXISTS (
          SELECT 1 FROM "limit_order_deferred_candles" d
          WHERE d."market_candle_id" = c."id"
            AND d."candle_ingest_seq" >= c."ingest_seq"
        )`,
    [fixture.candleC],
  );
  assert.equal(
    scan.length,
    0,
    'the forward scan must still be excluding the corrected candle C',
  );

  const futureOrphan = await deferredRow(client, fixture.candleD);
  assert.equal(futureOrphan.revision_state, 'current');
  assert.equal(futureOrphan.revision_migrated_at, null);
}

async function assertLegacyReactivated(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  const row = await deferredRow(client, fixture.candleA);
  assert.equal(row.status, 'deferred', 'the entry must be retryable again');
  assert.equal(
    row.candle_ingest_seq,
    null,
    'the inferred revision must be dropped so the entry suppresses nothing',
  );
  assert.equal(row.revision_state, 'legacy_unknown');
  assert.ok(row.revision_migrated_at, 'the reclassification must be recorded');
  assert.equal(
    row.revision_verified_at,
    null,
    'nothing has been verified against the candle yet',
  );
  assert.equal(
    row.attempt_count,
    1,
    'the retry budget must restart (1 is the table CHECK floor, and what the runtime writes on a revision replacement)',
  );
  assert.equal(
    row.last_error_code,
    'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
  );
  // firstDeferredAt is deliberately preserved: it is what the asset-scoped
  // health gate measures backlog age from, so resetting it would UNBLOCK the
  // asset while the re-verification is still outstanding.
  assert.ok(
    row.first_deferred_at.getTime() < row.next_retry_at.getTime(),
    'the original backlog age must survive the reactivation',
  );

  // The forward scan can reach the candle again.
  const { rows: scan } = await client.query(
    `SELECT 1 FROM "market_candles" c
      WHERE c."id" = $1
        AND NOT EXISTS (
          SELECT 1 FROM "limit_order_deferred_candles" d
          WHERE d."market_candle_id" = c."id"
            AND d."candle_ingest_seq" >= c."ingest_seq"
        )`,
    [fixture.candleA],
  );
  assert.equal(scan.length, 1, 'the corrected candle must be visible again');
}

async function assertLegacyOrphan(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  const row = await deferredRow(client, fixture.candleB);
  assert.equal(
    row.status,
    'permanent',
    'a candle that retention removed cannot be re-verified, so it stays parked',
  );
  assert.equal(row.revision_state, 'legacy_orphan');
  assert.ok(row.revision_migrated_at);
  assert.equal(row.last_error_code, 'LIMIT_ORDER_CANDLE_ROW_MISSING');
}

/**
 * The clock-skew recovery: after the clock-independent migration, the
 * future-created_at legacy entry is reopened exactly like the past one —
 * classification no longer depends on which way the clocks were skewed.
 */
async function assertFutureSkewReactivated(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  const row = await deferredRow(client, fixture.candleC);
  assert.equal(row.status, 'deferred', 'the entry must be retryable again');
  assert.equal(
    row.candle_ingest_seq,
    null,
    'the inferred revision must be dropped so the entry suppresses nothing',
  );
  assert.equal(row.revision_state, 'legacy_unknown');
  assert.ok(row.revision_migrated_at, 'the reclassification must be recorded');
  assert.equal(row.revision_verified_at, null);
  assert.equal(row.attempt_count, 1);
  assert.equal(
    row.last_error_code,
    'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
  );

  // The forward scan can reach candle C again.
  const { rows: scan } = await client.query(
    `SELECT 1 FROM "market_candles" c
      WHERE c."id" = $1
        AND NOT EXISTS (
          SELECT 1 FROM "limit_order_deferred_candles" d
          WHERE d."market_candle_id" = c."id"
            AND d."candle_ingest_seq" >= c."ingest_seq"
        )`,
    [fixture.candleC],
  );
  assert.equal(scan.length, 1, 'the corrected candle C must be visible again');
}

async function assertFutureSkewOrphan(
  client: Client,
  fixture: Fixture,
): Promise<void> {
  const row = await deferredRow(client, fixture.candleD);
  assert.equal(row.status, 'permanent');
  assert.equal(row.revision_state, 'legacy_orphan');
  assert.ok(row.revision_migrated_at);
  assert.equal(row.last_error_code, 'LIMIT_ORDER_CANDLE_ROW_MISSING');
}

/**
 * A revision that WAS observed but never durably recorded as observed is
 * indistinguishable from a backfill inference, so the conservative policy
 * reopens it. The cost is one extra sweep (its orders are protected by their
 * status guard); the alternative — trusting it — is the exact hole the
 * clock-skew rows fell into.
 */
async function assertModernReverified(
  client: Client,
  modern: { marketCandleId: string; attemptCount: number },
): Promise<void> {
  const row = await deferredRow(client, modern.marketCandleId);
  assert.equal(row.status, 'deferred');
  assert.equal(row.revision_state, 'legacy_unknown');
  assert.ok(row.revision_migrated_at, 'the reclassification must be recorded');
  assert.equal(
    row.candle_ingest_seq,
    null,
    'the unproven revision must be dropped for re-verification',
  );
  assert.equal(row.attempt_count, 1);
}

/**
 * The row the migration must never touch: the runtime observed the revision
 * AND durably recorded that observation (revision_verified_at). Status,
 * attempt budget, retry schedule and revision state all survive a re-run of
 * the migration verbatim.
 */
async function assertVerifiedModernUntouched(
  client: Client,
  verified: { marketCandleId: string; attemptCount: number },
): Promise<void> {
  const before = await deferredRow(client, verified.marketCandleId);
  await client.query(readMigrationSql(REVERIFY_MIGRATION));
  const row = await deferredRow(client, verified.marketCandleId);
  assert.equal(row.status, 'deferred');
  assert.equal(row.revision_state, 'current');
  assert.equal(
    row.revision_migrated_at,
    null,
    'a verified entry must not be reclassified',
  );
  assert.equal(
    row.attempt_count,
    verified.attemptCount,
    'its retry budget must not be reset',
  );
  assert.ok(row.candle_ingest_seq, 'its observed revision must survive');
  assert.equal(
    row.next_retry_at.toISOString(),
    before.next_retry_at.toISOString(),
    'its retry schedule must survive',
  );
  assert.ok(row.revision_verified_at, 'the observation record must survive');
}

/**
 * Both provenance migrations are written to be safe to re-apply — a rebuilt
 * environment, a replayed deploy, an operator running the files by hand.
 * Re-running them must not reset a retry budget a second time, and must not
 * reclassify anything.
 */
async function assertMigrationIsIdempotent(
  client: Client,
  fixture: Fixture,
  verified: { marketCandleId: string; attemptCount: number },
): Promise<void> {
  const subjects = [
    fixture.candleA,
    fixture.candleB,
    fixture.candleC,
    fixture.candleD,
    verified.marketCandleId,
  ];
  const before = await Promise.all(
    subjects.map((id) => deferredRow(client, id)),
  );
  await client.query(readMigrationSql(PROVENANCE_MIGRATION));
  await client.query(readMigrationSql(REVERIFY_MIGRATION));
  const after = await Promise.all(
    subjects.map((id) => deferredRow(client, id)),
  );
  for (const [index, row] of after.entries()) {
    assert.deepEqual(
      {
        status: row.status,
        seq: row.candle_ingest_seq,
        state: row.revision_state,
        attempts: row.attempt_count,
        migratedAt: row.revision_migrated_at?.toISOString() ?? null,
        verifiedAt: row.revision_verified_at?.toISOString() ?? null,
      },
      {
        status: before[index].status,
        seq: before[index].candle_ingest_seq,
        state: before[index].revision_state,
        attempts: before[index].attempt_count,
        migratedAt: before[index].revision_migrated_at?.toISOString() ?? null,
        verifiedAt: before[index].revision_verified_at?.toISOString() ?? null,
      },
      `row ${index} must be unchanged by a second application`,
    );
  }
}

/**
 * The end of the chain: with the entry reopened, the REAL sweep must process
 * the CORRECTED revision, fill the order the correction newly qualifies at the
 * LIMIT price, and leave the already-executed order exactly as it was.
 */
async function assertSweepRecoversRevisionTwo(
  scratchUrl: string,
  fixture: Fixture,
): Promise<void> {
  // PrismaService reads DATABASE_URL in its CONSTRUCTOR, so the scratch
  // database only has to be the process default while these services are
  // built — not while the module is loaded.
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = scratchUrl;
  try {
    const prisma = new PrismaService();
    const checkpoints = new LimitOrderReconciliationCheckpointRepository(
      prisma,
    );
    const sweep = new LimitOrderCandleReconciliationService(
      prisma,
      new LimitOrderCandidateRepository(prisma),
      new LimitOrderExecutionService(
        prisma,
        new PortfolioValuationService(prisma),
        // Ranking refresh is an after-the-fact projection, not part of the
        // fill; the same stub the other path-B runners use.
        {
          refreshCurrentRankingAfterParticipantChange: () =>
            Promise.resolve({ skipped: false }),
        } as never,
      ),
      new LimitOrderMatchBoundaryService(),
      checkpoints,
      // No window-completion supervisor: this runner is about the retry queue,
      // and the completion pass has its own suite.
      undefined,
    );

    try {
      // Two sweeps: the first bootstraps the durable position, the second is
      // the steady-state tick that drains the reopened entry.
      await sweep.reconcile({ now: new Date() });
      const summary = await sweep.reconcile({ now: new Date() });
      assert.equal(
        summary.gapDetected,
        false,
        'nothing here is a retention finding',
      );

      const processed = await prisma.limitOrderProcessedCandle.findUnique({
        where: { marketCandleId: fixture.candleA },
      });
      assert.ok(processed, 'the corrected revision must have been processed');
      assert.equal(
        processed.candleIngestSeq.toString(),
        fixture.revisionTwo,
        'the processed row must record the CORRECTED revision',
      );

      const pending = await prisma.order.findUniqueOrThrow({
        where: { id: fixture.pendingOrderId },
        select: {
          status: true,
          executedPrice: true,
          matchingSource: true,
          limitOrderCandleEvidenceId: true,
        },
      });
      assert.equal(
        pending.status,
        'executed',
        'the order the correction newly qualifies must fill',
      );
      assert.equal(
        pending.executedPrice?.toString(),
        '95',
        'path B always fills at the LIMIT price, never at the candle low',
      );
      assert.equal(pending.matchingSource, 'closed_5m_candle');
      assert.ok(
        pending.limitOrderCandleEvidenceId,
        'the fill must carry revision-scoped evidence',
      );

      const executed = await prisma.order.findUniqueOrThrow({
        where: { id: fixture.executedOrderId },
        select: { status: true, executedPrice: true, matchingSource: true },
      });
      assert.equal(executed.status, 'executed');
      assert.equal(
        executed.executedPrice?.toString(),
        '120',
        'an already-executed order must never be re-filled by the re-verification',
      );
      assert.equal(executed.matchingSource, 'live_trade_event');

      // The FUTURE-clock asset recovers identically: corrected revision
      // processed, newly-qualified order filled once at the LIMIT price, the
      // already-executed order untouched.
      const processedC = await prisma.limitOrderProcessedCandle.findUnique({
        where: { marketCandleId: fixture.candleC },
      });
      assert.ok(processedC, "candle C's corrected revision must be processed");
      assert.equal(processedC.candleIngestSeq.toString(), fixture.revisionTwoC);
      const pendingC = await prisma.order.findUniqueOrThrow({
        where: { id: fixture.pendingOrderIdC },
        select: { status: true, executedPrice: true, matchingSource: true },
      });
      assert.equal(
        pendingC.status,
        'executed',
        'the future-created_at legacy entry must not have cost the fill',
      );
      assert.equal(pendingC.executedPrice?.toString(), '95');
      assert.equal(pendingC.matchingSource, 'closed_5m_candle');
      const executedC = await prisma.order.findUniqueOrThrow({
        where: { id: fixture.executedOrderIdC },
        select: { status: true, executedPrice: true, matchingSource: true },
      });
      assert.equal(executedC.status, 'executed');
      assert.equal(executedC.executedPrice?.toString(), '120');
      assert.equal(executedC.matchingSource, 'live_trade_event');

      // The reopened entries are settled and gone, so their assets stop being
      // blocked by them.
      for (const candleId of [fixture.candleA, fixture.candleC]) {
        const remaining = await prisma.limitOrderDeferredCandle.findUnique({
          where: { marketCandleId: candleId },
        });
        assert.equal(
          remaining,
          null,
          'a successfully re-verified entry must leave the queue',
        );
      }

      // The orphaned assets (B past-skew, D future-skew) are still blocked;
      // the recovered assets are not blocked by them.
      for (const orphanAsset of [fixture.assetB, fixture.assetD]) {
        const backlog = await checkpoints.readAssetBacklog(orphanAsset);
        assert.equal(backlog.permanentCount, 1);
        assert.equal(backlog.legacyReviewCount, 1);
      }
      for (const recovered of [fixture.assetA, fixture.assetC]) {
        const backlog = await checkpoints.readAssetBacklog(recovered);
        assert.equal(backlog.permanentCount, 0);
        assert.equal(backlog.legacyReviewCount, 0);
      }
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readMigrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_ROOT, name, 'migration.sql'), 'utf8');
}

async function ingestSeqOf(
  client: Client,
  marketCandleId: string,
): Promise<string> {
  const { rows } = await client.query<{ ingest_seq: string | null }>(
    `SELECT "ingest_seq" FROM "market_candles" WHERE "id" = $1`,
    [marketCandleId],
  );
  assert.ok(
    rows[0]?.ingest_seq,
    'the ingest trigger must have assigned a value',
  );
  return rows[0].ingest_seq;
}

/**
 * Timestamp parameters are passed as explicit UTC ISO strings.
 *
 * Several of these columns are `timestamp WITHOUT time zone` (Order.submittedAt
 * and Order.candleMatchingEligibleFrom among them). node-postgres serializes a
 * JS Date using the PROCESS timezone, so on a non-UTC machine the wall-clock
 * part landed hours away from the value Prisma writes for the same instant —
 * enough to put an order's eligibility window on the wrong side of a candle.
 * PostgreSQL ignores the trailing `Z` for a non-tz column and honours it for a
 * tz column, so one ISO string is correct for both.
 */
function ts(value: Date): string {
  return value.toISOString();
}

async function databaseNow(client: Client): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS "now"',
  );
  return rows[0].now;
}

function alignWindow(value: Date): Date {
  return new Date(
    Math.floor(value.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
