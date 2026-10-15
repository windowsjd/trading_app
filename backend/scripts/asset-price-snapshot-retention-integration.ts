/**
 * Batch-delete safety test of the reference-aware asset price snapshot
 * retention (design v2.1 §8.5, stage 4) on a disposable local *_test
 * PostgreSQL. Seeds rows for every protection ①–⑦, computes the expected
 * candidates with an independent oracle (including any Season already in
 * the database), and checks: the FK list equals the live catalog, the
 * dry-run counts and changes nothing, batched and concurrent deletes remove
 * exactly the candidates, a reference added after the dry-run is honoured,
 * and a second pass deletes nothing.
 *
 * The exchange-local session date (③) is exercised where it can go wrong:
 * KST midnight and after-hours rows, US DST start and end, and PostgreSQL
 * sessions whose TimeZone is Asia/Seoul or America/New_York (dry-run and
 * deletes must equal the UTC session's). A reference inserted while a batch
 * runs locks its row, so the batch skips it.
 *
 *   ASSET_PRICE_SNAPSHOT_RETENTION_DB_INTEGRATION=1 DATABASE_URL=<local *_test> \
 *   pnpm tsx scripts/asset-price-snapshot-retention-integration.ts
 */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ASSET_PRICE_SNAPSHOT_REFERENCES,
  AssetPriceSnapshotRetentionService,
  SEASON_EVIDENCE_ROWS,
  SEASON_EVIDENCE_SCAN_ROWS,
  assetPriceSnapshotRetentionBatchSql,
  type PriceSnapshotRetentionCursor,
} from '../src/providers/asset-price-snapshot-retention.service';
import { AssetPriceSnapshotRetentionWorker } from '../src/providers/asset-price-snapshot-retention.worker';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { databaseFailureKind } from '../src/common/database-failure';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) &&
    dbUrl.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);

const DAY = 24 * 60 * 60_000;
const RETENTION_DAYS = 14;
const NOW = new Date();

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** Local wall time in a zone → instant. */
function zoned(date: string, time: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T${time}:00Z`);
  return new Date(
    guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone),
  );
}

function localDate(ms: number, timeZone: string): string {
  return new Date(ms + offsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

const kstDay = (daysAgo: number) =>
  localDate(NOW.getTime() - daysAgo * DAY, 'Asia/Seoul');
const etDay = (daysAgo: number) =>
  localDate(NOW.getTime() - daysAgo * DAY, 'America/New_York');

type Seed = {
  key: string;
  assetId: string;
  sourceType: 'provider_api' | 'admin_manual';
  sourceName: string | null;
  effectiveAt: Date;
  createdAt: Date;
};

const prisma = new PrismaService();
const ids = {
  assets: [] as string[],
  season: '',
  futureSeason: '',
  user: '',
  account: '',
};

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};
/** The batch must read one ordered range of the (asset_id, effective_at) index
 * and delete by primary key: no sequential or bitmap scan of the snapshot
 * table and no Sort or Hash over its rows, whatever the cost settings. */
function assertBatchPlan(explain: unknown, label: string) {
  const T = 'asset_price_snapshots';
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(
    (explain as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>)[0][
      'QUERY PLAN'
    ][0].Plan,
  );
  const shape = `${label}: ${nodes
    .map(
      (n) => `${n['Node Type']}:${n['Index Name'] ?? n['Relation Name'] ?? ''}`,
    )
    .join(' > ')}`;
  const readsTable = (node: PlanNode): boolean =>
    node['Relation Name'] === T ||
    (node.Plans ?? []).some((child) => readsTable(child));
  const indexes = (node: PlanNode): string[] => [
    ...(node['Index Name'] ? [node['Index Name']] : []),
    ...(node.Plans ?? []).flatMap(indexes),
  ];
  // A bitmap over the primary key (id = ANY of a bounded array) is a keyed
  // read; a bitmap over any other index would read rows out of order.
  const byPrimaryKey = (n: PlanNode) =>
    n['Relation Name'] === T &&
    ((n['Node Type'] === 'Index Scan' && n['Index Name'] === `${T}_pkey`) ||
      (n['Node Type'] === 'Bitmap Heap Scan' &&
        indexes(n).every((name) => name === `${T}_pkey`)));
  assert.equal(
    nodes.some(
      (n) =>
        n['Relation Name'] === T &&
        (n['Node Type'] === 'Seq Scan' ||
          (n['Node Type'] === 'Bitmap Heap Scan' && !byPrimaryKey(n))),
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some(
      (n) => ['Sort', 'Hash'].includes(n['Node Type']) && readsTable(n),
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some((n) => n['Index Name'] === `${T}_asset_id_effective_at_idx`),
    true,
    shape,
  );
  // The DELETE target itself is reached only through the primary key.
  const modify = nodes.find((n) => n['Node Type'] === 'ModifyTable');
  assert.equal(
    (modify?.Plans ?? []).some(
      (n) => n['Relation Name'] === T && byPrimaryKey(n),
    ),
    true,
    shape,
  );
}
const COST_PROFILES: Record<string, string[]> = {
  postgresDefaults: [
    'random_page_cost = 4',
    "effective_cache_size = '4GB'",
    "work_mem = '4MB'",
  ],
  production: [
    'random_page_cost = 1.1',
    "effective_cache_size = '768MB'",
    "work_mem = '6617kB'",
  ],
};

/** A client whose PostgreSQL session TimeZone is `zone`. */
function prismaInZone(zone: string): PrismaService {
  const saved = process.env.DATABASE_URL!;
  const url = new URL(saved);
  url.searchParams.set('options', `-c TimeZone=${zone}`);
  process.env.DATABASE_URL = url.toString();
  try {
    return new PrismaService();
  } finally {
    process.env.DATABASE_URL = saved;
  }
}
// ③ must not follow the session TimeZone: every dry-run and delete below
// runs from UTC, Seoul and New York sessions alike.
const sessions = ['UTC', 'Asia/Seoul', 'America/New_York'].map((zone) => {
  const client = prismaInZone(zone);
  return {
    zone,
    client,
    service: new AssetPriceSnapshotRetentionService(client),
  };
});

async function main() {
  await prisma.$connect();
  try {
    for (const session of sessions) {
      const [row] = await session.client.$queryRaw<
        Array<{ zone: string }>
      >`SELECT current_setting('TimeZone') AS zone`;
      assert.equal(row.zone, session.zone, 'the session TimeZone is set');
    }

    // ---- FK catalog guard --------------------------------------------------
    const catalog = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string }>
    >`SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'asset_price_snapshots'::regclass`;
    assert.deepEqual(
      catalog.map((row) => `${row.table_name}.${row.column_name}`).sort(),
      ASSET_PRICE_SNAPSHOT_REFERENCES.map(([t, c]) => `${t}.${c}`).sort(),
      'every FK to asset_price_snapshots is protected by ①',
    );
    const deleteRules = await prisma.$queryRaw<Array<{ rule: string }>>`
      SELECT DISTINCT confdeltype::text AS rule FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'asset_price_snapshots'::regclass`;
    assert.deepEqual(
      deleteRules.map((row) => row.rule),
      ['r'],
      'all references are ON DELETE RESTRICT (the final fence)',
    );

    // ---- fixtures ------------------------------------------------------------
    const base = randomInt(700000, 799999);
    const krx = await prisma.asset.create({
      data: {
        symbol: String(base),
        name: 'retention KRX fixture',
        market: 'KRX',
        assetType: 'domestic_stock',
        currencyCode: 'KRW',
        isActive: false,
      },
    });
    const us = await prisma.asset.create({
      data: {
        symbol: `RT${base}`,
        name: 'retention US fixture',
        market: 'NASDAQ',
        assetType: 'us_stock',
        currencyCode: 'USD',
        isActive: false,
      },
    });
    ids.assets.push(krx.id, us.id);
    const seasonEnd = zoned(kstDay(28), '12:00', 'Asia/Seoul');
    const season = await prisma.season.create({
      data: {
        name: `retention-${randomUUID()}`,
        status: 'ended',
        startAt: new Date(seasonEnd.getTime() - 7 * DAY),
        endAt: seasonEnd,
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
    });
    ids.season = season.id;

    const seeds: Seed[] = [];
    const old = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);
    const add = (
      key: string,
      assetId: string,
      effectiveAt: Date,
      over: Partial<Seed> = {},
    ) =>
      seeds.push({
        key,
        assetId,
        sourceType: 'provider_api',
        sourceName: assetId === krx.id ? 'koscom_krx_realtime_price' : 'kis_us',
        effectiveAt,
        createdAt: effectiveAt,
        ...over,
      });
    const kst = (daysAgo: number, time: string) =>
      zoned(kstDay(daysAgo), time, 'Asia/Seoul');
    // Day A: two intraday rows and the session's last row.
    add('A1000', krx.id, kst(30, '10:00'));
    add('A1100', krx.id, kst(30, '11:00'));
    add('A1529', krx.id, kst(30, '15:29'));
    // Day B: a quote pins 10:00.
    add('B1000', krx.id, kst(29, '10:00'));
    add('B1100', krx.id, kst(29, '11:00'));
    add('B1529', krx.id, kst(29, '15:29'));
    // Day C: Season ends at 12:00; 28 rows before, 2 after. ④ keeps the 20
    // newest before the end (settlement reads 10 per eligible source together).
    for (let i = 0; i < 28; i++) {
      const minutes = 7 * 60 + 20 + i * 10;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      add(`C${time.replace(':', '')}`, krx.id, kst(28, time));
    }
    add('C1300', krx.id, kst(28, '13:00'));
    add('C1529', krx.id, kst(28, '15:29'));
    // Day D: a late backfill (created yesterday) and the day's last row.
    add('D1000', krx.id, kst(27, '10:00'), { createdAt: old(1) });
    add('D1100', krx.id, kst(27, '11:00'));
    // admin_manual is never deleted.
    add('ADMIN1', krx.id, kst(30, '10:30'), {
      sourceType: 'admin_manual',
      sourceName: null,
    });
    add('ADMIN2', krx.id, kst(29, '10:30'), {
      sourceType: 'admin_manual',
      sourceName: null,
    });
    // Days F/G: KST midnight. 23:50 is F's last row although 00:10 G shares
    // its UTC date; 19:00 and 23:50 sit past 18:00 KST, where a date that
    // followed a UTC session used to roll over (after the fixture Season).
    add('F1000', krx.id, kst(25, '10:00'));
    add('F1529', krx.id, kst(25, '15:29'));
    add('F1900', krx.id, kst(25, '19:00'));
    add('F2350', krx.id, kst(25, '23:50'));
    add('G0010', krx.id, kst(24, '00:10'));
    add('G1000', krx.id, kst(24, '10:00'));
    add('G1529', krx.id, kst(24, '15:29'));
    // US: 09:30 and 15:59 New York are one ET session but two KST dates
    // (after the fixture Season's end, so only ③ decides).
    add('E0930', us.id, zoned(etDay(20), '09:30', 'America/New_York'));
    add('E1559', us.id, zoned(etDay(20), '15:59', 'America/New_York'));
    // US DST end (2025-11-02) and start (2026-03-08): each Thursday and
    // Monday 23:30 is its ET day's last row. A fixed -4h/-5h offset, or a
    // date that follows the session TimeZone, joins it to the next day.
    for (const [date, times] of [
      ['2025-10-30', ['15:59', '23:30']],
      ['2025-10-31', ['00:30', '15:59']],
      ['2025-11-03', ['00:30', '15:59', '23:30']],
      ['2025-11-04', ['00:30', '15:59']],
      ['2026-03-05', ['15:59', '23:30']],
      ['2026-03-06', ['00:30', '15:59']],
      ['2026-03-09', ['00:30', '15:59', '23:30']],
      ['2026-03-10', ['00:30', '15:59']],
    ] as const)
      for (const time of times)
        add(`ET ${date} ${time}`, us.id, zoned(date, time, 'America/New_York'));
    // One row a day (each its day's last) between the DST rows and the
    // fixture Season's end, so ④ does not decide the DST rows.
    for (let i = 0; i < SEASON_EVIDENCE_ROWS + 2; i++)
      add(`UF${i}`, us.id, zoned(etDay(40 + i), '12:00', 'America/New_York'));
    // Recent rows inside the retention (⑥) for both, newest = latest (②).
    for (let i = 0; i < 12; i++) {
      add(
        `KR${i}`,
        krx.id,
        new Date(NOW.getTime() - (3 * DAY + i * 3_600_000)),
      );
      add(`UR${i}`, us.id, new Date(NOW.getTime() - (3 * DAY + i * 3_600_000)));
    }
    const created = new Map<string, string>();
    for (const seed of seeds) {
      const row = await prisma.assetPriceSnapshot.create({
        data: {
          assetId: seed.assetId,
          price: '1000',
          currencyCode: seed.assetId === krx.id ? 'KRW' : 'USD',
          sourceType: seed.sourceType,
          sourceName: seed.sourceName,
          effectiveAt: seed.effectiveAt,
          capturedAt: seed.effectiveAt,
          createdAt: seed.createdAt,
        },
      });
      created.set(seed.key, row.id);
    }
    const user = await prisma.user.create({
      data: {
        email: `retention-${randomUUID()}@example.com`,
        nickname: `rt-${randomUUID().slice(0, 8)}`,
        passwordHash: 'fixture-only',
      },
    });
    ids.user = user.id;
    const account = await prisma.tradingAccount.create({
      data: {
        userId: user.id,
        mode: 'season',
        initialCapitalKrw: '10000000',
        openedAt: new Date(),
      },
    });
    ids.account = account.id;
    const pin = (key: string, db: Pick<PrismaService, 'quote'> = prisma) =>
      db.quote.create({
        data: {
          userId: user.id,
          tradingAccountId: account.id,
          quoteType: 'order',
          cashWalletScope: 'securities',
          assetId: krx.id,
          side: 'buy',
          orderType: 'market',
          quantity: '1',
          currencyCode: 'KRW',
          quotedPrice: '1000',
          assetPriceSnapshotId: created.get(key)!,
          maxChangeBps: '100',
          expiresAt: new Date(NOW.getTime() + 60_000),
          requestHash: `fixture-${key}`,
        },
      });
    await pin('B1000');

    // ---- oracle --------------------------------------------------------------
    const seasons = await prisma.season.findMany({ select: { endAt: true } });
    const references = new Set(['B1000']);
    const cutoff = NOW.getTime() - RETENTION_DAYS * DAY;
    const youngest = NOW.getTime() - 2 * DAY;
    const sameSource = (a: Seed, b: Seed) =>
      a.assetId === b.assetId &&
      a.sourceType === b.sourceType &&
      a.sourceName === b.sourceName;
    const newer = (n: Seed, m: Seed) =>
      n.effectiveAt.getTime() > m.effectiveAt.getTime() ||
      (n.effectiveAt.getTime() === m.effectiveAt.getTime() &&
        created.get(n.key)! > created.get(m.key)!);
    const zone = (seed: Seed) =>
      seed.assetId === us.id ? 'America/New_York' : 'Asia/Seoul';
    const expected = (refs: Set<string>) =>
      seeds
        .filter((m) => {
          if (m.effectiveAt.getTime() >= cutoff) return false; // ⑥
          if (m.sourceType === 'admin_manual') return false; // ⑤
          if (m.createdAt.getTime() >= youngest) return false; // ⑦
          if (refs.has(m.key)) return false; // ①
          const peers = seeds.filter((n) => sameSource(n, m));
          const day = localDate(m.effectiveAt.getTime(), zone(m));
          if (
            !peers.some(
              (n) =>
                newer(n, m) &&
                localDate(n.effectiveAt.getTime(), zone(m)) === day,
            )
          )
            return false; // ②③
          for (const s of seasons) {
            if (m.effectiveAt > s.endAt) continue;
            const before = peers.filter(
              (n) => n.effectiveAt > m.effectiveAt && n.effectiveAt <= s.endAt,
            ).length;
            if (before < SEASON_EVIDENCE_ROWS) return false; // ④
          }
          return true;
        })
        .map((m) => m.key)
        .sort();
    const explicit = [
      'A1000',
      'A1100',
      'B1100',
      'C0720',
      'C0730',
      'C0740',
      'C0750',
      'C0800',
      'C0810',
      'C0820',
      'C0830',
      'C1300',
      'E0930',
      'F1000',
      'F1529',
      'F1900',
      'G0010',
      'G1000',
      'ET 2025-10-30 15:59',
      'ET 2025-10-31 00:30',
      'ET 2025-11-03 00:30',
      'ET 2025-11-03 15:59',
      'ET 2025-11-04 00:30',
      'ET 2026-03-05 15:59',
      'ET 2026-03-06 00:30',
      'ET 2026-03-09 00:30',
      'ET 2026-03-09 15:59',
      'ET 2026-03-10 00:30',
    ].sort();
    assert.deepEqual(
      expected(references),
      explicit,
      'oracle agrees with the hand-derived candidate set',
    );

    // ---- dry-run: counts, read-only, equal in every session zone ------------
    const total = () =>
      prisma.assetPriceSnapshot.count({
        where: { assetId: { in: ids.assets } },
      });
    const before = await total();
    const dryRun = async (assetId: string) => {
      const [utc, ...others] = await Promise.all(
        sessions.map(({ service }) =>
          service.dryRun({ retentionDays: RETENTION_DAYS, assetId, now: NOW }),
        ),
      );
      for (const [i, other] of others.entries())
        assert.deepEqual(
          other,
          utc,
          `the ${sessions[i + 1].zone} session dry-run equals the UTC one`,
        );
      return utc;
    };
    const dryKrx = await dryRun(krx.id);
    const dryUs = await dryRun(us.id);
    const isUs = (key: string) =>
      seeds.find((seed) => seed.key === key)!.assetId === us.id;
    assert.equal(
      dryKrx.candidates,
      explicit.filter((key) => !isUs(key)).length,
      'KRX dry-run candidate count',
    );
    assert.equal(
      dryUs.candidates,
      explicit.filter(isUs).length,
      'US dry-run candidate count (ET session, DST)',
    );
    assert.equal(dryKrx.protectedReferenced, 1);
    assert.equal(dryKrx.protectedAdminManual, 2);
    assert.equal(dryKrx.protectedTooYoung, 1);
    assert.ok(dryKrx.protectedSeasonEvidence >= SEASON_EVIDENCE_ROWS);
    assert.equal(await total(), before, 'dry-run deletes nothing');

    // A quote pins a candidate after the dry-run: it must survive.
    await pin('C0720');
    references.add('C0720');

    // A reference still in flight when a batch runs: the quote's FK check
    // holds FOR KEY SHARE on the row, so FOR UPDATE … SKIP LOCKED passes over
    // it. The batch examines the three oldest KRX rows — A1000 (locked),
    // ADMIN1 (⑤) and A1100 — and deletes A1100 only. Once committed, ①
    // protects A1000.
    let deleted = 0;
    await prisma.$transaction(
      async (tx) => {
        await pin('A1000', tx);
        const batch = await sessions[1].service.deleteBatch({
          retentionDays: RETENTION_DAYS,
          assetId: krx.id,
          limit: 3,
          now: NOW,
        });
        assert.equal(batch.scanned, 3, 'the batch examined three rows');
        deleted += batch.deleted;
        const kept = await prisma.assetPriceSnapshot.findMany({
          where: { id: { in: [created.get('A1000')!, created.get('A1100')!] } },
          select: { id: true },
        });
        assert.equal(deleted, 1, 'the batch took one row');
        assert.deepEqual(
          kept.map((row) => row.id),
          [created.get('A1000')],
          'the in-flight reference kept A1000; A1100 went',
        );
      },
      { timeout: 30_000 },
    );
    references.add('A1000');
    const finalExpected = expected(references);

    // ---- batched + concurrent deletes from all three session zones -----------
    // Each session sweeps the asset with its own cursor, two rows a batch; a
    // row another sweep has locked is skipped and deleted by that sweep.
    const sweep = async (
      service: AssetPriceSnapshotRetentionService,
      assetId: string,
      limit: number,
    ) => {
      let removed = 0;
      let after: PriceSnapshotRetentionCursor | null = null;
      for (;;) {
        const batch = await service.deleteBatch({
          retentionDays: RETENTION_DAYS,
          assetId,
          limit,
          now: NOW,
          after,
        });
        removed += batch.deleted;
        after = batch.next;
        if (batch.scanned < limit) return removed;
      }
    };
    const drain = async (assetId: string) =>
      (
        await Promise.all(
          sessions.map(({ service }) => sweep(service, assetId, 2)),
        )
      ).reduce((sum, count) => sum + count, 0);
    deleted += await drain(krx.id);
    deleted += await drain(us.id);
    const survivors = new Set(
      (
        await prisma.assetPriceSnapshot.findMany({
          where: { assetId: { in: ids.assets } },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const gone = seeds
      .map((seed) => seed.key)
      .filter((key) => !survivors.has(created.get(key)!))
      .sort();
    assert.deepEqual(
      gone,
      finalExpected,
      'exactly the candidates were deleted',
    );
    assert.equal(deleted, finalExpected.length, 'no row was deleted twice');
    assert.equal(
      deleted,
      dryKrx.candidates + dryUs.candidates - 2,
      'the dry-run counted every deleted row and the two pinned after it',
    );
    for (const key of [
      'A1000',
      'B1000',
      'C0720',
      'A1529',
      'C1529',
      'D1000',
      'F2350',
      'G1529',
      'E1559',
      'ET 2025-10-30 23:30',
      'ET 2025-10-31 15:59',
      'ET 2025-11-03 23:30',
      'ET 2025-11-04 15:59',
      'ET 2026-03-05 23:30',
      'ET 2026-03-06 15:59',
      'ET 2026-03-09 23:30',
      'ET 2026-03-10 15:59',
      'ADMIN1',
    ])
      assert.ok(survivors.has(created.get(key)!), `${key} survives`);
    for (const assetId of ids.assets)
      assert.equal(
        (await dryRun(assetId)).candidates,
        0,
        'no candidate is left in any session zone',
      );
    assert.equal(
      await sweep(sessions[0].service, krx.id, 10),
      0,
      'a second pass deletes nothing',
    );
    await assert.rejects(
      sessions[0].service.deleteBatch({
        retentionDays: 1,
        assetId: krx.id,
        limit: 10,
        now: NOW,
      }),
      /retentionDays must be an explicit integer/,
    );
    console.log(
      `asset price snapshot retention correctness ok: ${seeds.length} rows, ${deleted} deleted, ${survivors.size} kept`,
    );

    // ---- scale: a 5 s Binance history, plan shape and bounded probes --------
    // A Season ending in the future makes ④ apply to every row, as in
    // production. Old rows: a dense WS feed (5 days at 5 s), a REST source that
    // wrote 30 rows and stopped, and a legacy source whose rows are 4,000 WS
    // rows apart (its successors lie beyond the ④ read bound, so all are kept).
    const future = await prisma.season.create({
      data: {
        name: `retention-future-${randomUUID()}`,
        status: 'upcoming',
        startAt: new Date(NOW.getTime() + DAY),
        endAt: new Date(NOW.getTime() + 30 * DAY),
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
    });
    ids.futureSeason = future.id;
    const scale = await prisma.asset.create({
      data: {
        symbol: `RTS${base}USDT`,
        name: 'retention scale fixture',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        isActive: false,
      },
    });
    ids.assets.push(scale.id);
    const wsStart = new Date(NOW.getTime() - 20 * DAY);
    const WS_ROWS = 5 * 17_280;
    const insertSeries = (
      source: string,
      from: Date,
      stepSeconds: number,
      count: number,
    ) => prisma.$executeRaw`
      INSERT INTO asset_price_snapshots
        (id, asset_id, price, currency_code, source_type, source_name, effective_at, captured_at, created_at)
      SELECT gen_random_uuid()::text, ${scale.id}, 100 + (n % 50), 'USD', 'provider_api', ${source},
        ${from}::timestamp + n * make_interval(secs => ${stepSeconds}),
        ${from}::timestamp + n * make_interval(secs => ${stepSeconds}),
        ${from}::timestamp + n * make_interval(secs => ${stepSeconds})
      FROM generate_series(0, ${count}::int - 1) n`;
    await insertSeries('binance_spot_ws_ticker', wsStart, 5, WS_ROWS);
    await insertSeries(
      'binance_public_rest_24hr_ticker',
      new Date(wsStart.getTime() - 3_600_000),
      60,
      30,
    );
    await insertSeries(
      'legacy_fixture_source',
      new Date(wsStart.getTime() + 2_500),
      20_000,
      Math.floor((WS_ROWS * 5) / 20_000),
    );
    // Recent rows inside the retention window: never touched.
    await insertSeries(
      'binance_spot_ws_ticker',
      new Date(NOW.getTime() - 3 * DAY),
      60,
      3 * 1440,
    );
    const scaleCutoff = new Date(NOW.getTime() - RETENTION_DAYS * DAY);
    const pinnedRow = await prisma.assetPriceSnapshot.findFirstOrThrow({
      where: {
        assetId: scale.id,
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: { gte: new Date(wsStart.getTime() + 2 * DAY) },
      },
      orderBy: { effectiveAt: 'asc' },
      select: { id: true },
    });
    await prisma.quote.create({
      data: {
        userId: user.id,
        tradingAccountId: account.id,
        quoteType: 'order',
        cashWalletScope: 'securities',
        assetId: scale.id,
        side: 'buy',
        orderType: 'market',
        quantity: '1',
        currencyCode: 'USD',
        quotedPrice: '100',
        assetPriceSnapshotId: pinnedRow.id,
        maxChangeBps: '100',
        expiresAt: new Date(NOW.getTime() + 60_000),
        requestHash: `fixture-scale-${randomUUID()}`,
      },
    });
    await prisma.$executeRaw`ANALYZE asset_price_snapshots`;
    // Expected survivors among old rows, from the rules directly.
    const [expectedKept] = await prisma.$queryRaw<
      Array<{ ws_day_last: number; legacy: number; old_total: number }>
    >`SELECT
        (SELECT count(DISTINCT timezone('Asia/Seoul', timezone('UTC', effective_at))::date)
         FROM asset_price_snapshots WHERE asset_id = ${scale.id}
           AND source_name = 'binance_spot_ws_ticker' AND effective_at < ${scaleCutoff})::int AS ws_day_last,
        (SELECT count(*) FROM asset_price_snapshots WHERE asset_id = ${scale.id}
           AND source_name = 'legacy_fixture_source')::int AS legacy,
        (SELECT count(*) FROM asset_price_snapshots WHERE asset_id = ${scale.id}
           AND effective_at < ${scaleCutoff})::int AS old_total`;
    assert.ok(expectedKept.legacy >= 20, 'legacy rows exceed the ④ count');
    for (const [profile, settings] of Object.entries(COST_PROFILES))
      for (const limit of [1000, 10000]) {
        const explain = await prisma.$transaction(async (tx) => {
          for (const setting of settings)
            await tx.$executeRawUnsafe(`SET LOCAL ${setting}`);
          return tx.$queryRaw(
            Prisma.sql`EXPLAIN (FORMAT JSON) ${assetPriceSnapshotRetentionBatchSql(
              {
                retentionDays: RETENTION_DAYS,
                assetId: scale.id,
                limit,
                now: NOW,
              },
            )}`,
          );
        });
        assertBatchPlan(explain, `${profile}, batch ${limit}`);
      }
    const scaleService = sessions[0].service;
    let scaleDeleted = 0;
    let scaleBatches = 0;
    let slowestMs = 0;
    let after: PriceSnapshotRetentionCursor | null = null;
    const sweepStart = performance.now();
    for (;;) {
      const t = performance.now();
      const batch = await scaleService.deleteBatch({
        retentionDays: RETENTION_DAYS,
        assetId: scale.id,
        limit: 1000,
        now: NOW,
        after,
      });
      slowestMs = Math.max(slowestMs, performance.now() - t);
      scaleBatches++;
      scaleDeleted += batch.deleted;
      after = batch.next;
      if (batch.scanned < 1000) break;
    }
    const sweepMs = performance.now() - sweepStart;
    // REST: the 20 newest are ④ evidence; legacy: all kept by the ④ bound.
    const keptOld = expectedKept.ws_day_last + 20 + expectedKept.legacy + 1;
    assert.equal(scaleDeleted, expectedKept.old_total - keptOld);
    const remaining = await prisma.$queryRaw<
      Array<{ source_name: string; rows: number }>
    >`SELECT source_name, count(*)::int AS rows FROM asset_price_snapshots
      WHERE asset_id = ${scale.id} AND effective_at < ${scaleCutoff}
      GROUP BY source_name ORDER BY source_name`;
    assert.deepEqual(
      Object.fromEntries(remaining.map((r) => [r.source_name, r.rows])),
      {
        binance_public_rest_24hr_ticker: 20,
        binance_spot_ws_ticker: expectedKept.ws_day_last + 1,
        legacy_fixture_source: expectedKept.legacy,
      },
    );
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: { id: pinnedRow.id } }),
      1,
      'the quoted row survives',
    );
    assert.equal(
      await prisma.assetPriceSnapshot.count({
        where: { assetId: scale.id, effectiveAt: { gte: scaleCutoff } },
      }),
      3 * 1440,
      'rows inside the retention window are untouched',
    );
    console.log(
      JSON.stringify({
        event: 'asset_price_snapshot_retention_scale',
        oldRows: expectedKept.old_total,
        deleted: scaleDeleted,
        batches: scaleBatches,
        sweepMs: Math.round(sweepMs),
        slowestBatchMs: Math.round(slowestMs),
        seasonEvidenceScanRows: SEASON_EVIDENCE_SCAN_ROWS,
      }),
    );

    // ---- scheduled worker: one lease, run records, failure and resume -------
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED = 'true';
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_BATCH_SIZE = '500';
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES = '3';
    const locks = new OpsJobLockService(prisma);
    const runs = new OpsJobRunService(prisma);
    const worker = () =>
      new AssetPriceSnapshotRetentionWorker(prisma, locks, runs);
    await insertSeries(
      'binance_spot_ws_ticker',
      new Date(wsStart.getTime() - 2 * DAY),
      5,
      4_000,
    );
    const pendingOld = () =>
      prisma.assetPriceSnapshot.count({
        where: {
          assetId: scale.id,
          sourceName: 'binance_spot_ws_ticker',
          effectiveAt: { lt: new Date(wsStart.getTime() - DAY) },
        },
      });
    assert.equal(await pendingOld(), 4_000);
    const [{ dates: workerDayLasts }] = await prisma.$queryRaw<
      Array<{ dates: number }>
    >`SELECT count(DISTINCT timezone('Asia/Seoul', timezone('UTC', effective_at))::date)::int AS dates
      FROM asset_price_snapshots WHERE asset_id = ${scale.id}
        AND source_name = 'binance_spot_ws_ticker'
        AND effective_at < ${new Date(wsStart.getTime() - DAY)}`;
    const [first, second] = await Promise.all([worker().run(), worker().run()]);
    assert.equal(
      [first, second].filter((r) => r === undefined).length,
      1,
      'one instance holds the lease',
    );
    const ran = (first ?? second)!;
    // The run stops once it has examined 3 × 500 rows (one batch may straddle).
    assert.equal(ran.batchLimitReached, true);
    assert.ok(ran.scannedCount >= 1_500 && ran.scannedCount < 2_000);
    // A real statement timeout after one committed batch: recorded with its
    // category and progress; the next run resumes from the database state.
    const failing = worker();
    const realTimeout = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '20ms'`;
        await tx.$queryRaw`SELECT pg_sleep(1)`;
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    assert.equal(databaseFailureKind(realTimeout), 'statement_timeout');
    const inner = (
      failing as unknown as { retention: AssetPriceSnapshotRetentionService }
    ).retention;
    const original = inner.deleteBatch.bind(inner);
    let calls = 0;
    inner.deleteBatch = async (scope) => {
      if (++calls === 2) throw realTimeout;
      return original(scope);
    };
    await assert.rejects(failing.run());
    const failedRun = await prisma.opsJobRun.findFirstOrThrow({
      where: { jobName: 'asset_price_snapshot_retention', status: 'failed' },
      orderBy: { startedAt: 'desc' },
    });
    assert.equal(failedRun.errorCode, 'ASSET_PRICE_SNAPSHOT_RETENTION_FAILED');
    const failedResult = failedRun.resultJson as Record<string, unknown>;
    assert.equal(failedResult.failureKind, 'statement_timeout');
    assert.equal(failedResult.batchCount, 1);
    assert.equal(failing.getStatus().lastFailureKind, 'statement_timeout');
    const resumer = worker();
    for (let k = 0; k < 50; k++) {
      const result = await resumer.run();
      if (result && !result.batchLimitReached) break;
    }
    // Of these 4,000 old rows only each KST date's last row remains (③).
    assert.equal(await pendingOld(), workerDayLasts);
    const succeeded = await prisma.opsJobRun.count({
      where: { jobName: 'asset_price_snapshot_retention', status: 'succeeded' },
    });
    assert.ok(succeeded >= 2, 'every finished run is recorded');
    delete process.env.ASSET_PRICE_SNAPSHOT_RETENTION_BATCH_SIZE;
    delete process.env.ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES;
    console.log(
      `asset price snapshot retention integration ok: correctness, scale (${scaleDeleted} deleted in ${scaleBatches} batches), worker`,
    );
  } finally {
    if (ids.account)
      await prisma.quote.deleteMany({
        where: { tradingAccountId: ids.account },
      });
    if (ids.assets.length)
      await prisma.assetPriceSnapshot.deleteMany({
        where: { assetId: { in: ids.assets } },
      });
    if (ids.assets.length)
      await prisma.asset.deleteMany({ where: { id: { in: ids.assets } } });
    if (ids.account)
      await prisma.tradingAccount.delete({ where: { id: ids.account } });
    if (ids.season) await prisma.season.delete({ where: { id: ids.season } });
    if (ids.futureSeason)
      await prisma.season.delete({ where: { id: ids.futureSeason } });
    await prisma.opsJobRun.deleteMany({
      where: { jobName: 'asset_price_snapshot_retention' },
    });
    if (ids.user) await prisma.user.delete({ where: { id: ids.user } });
    await prisma.$disconnect();
    for (const session of sessions) await session.client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
