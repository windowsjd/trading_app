/** TC-D01 opt-in, disposable PostgreSQL. Final settlement and operator
 * participant exclusion must serialize on the season:
 *
 *   - a settled season never keeps an active/suspended account,
 *   - an excluded participant never receives a final rank or tier,
 *   - a final ranking valued BEFORE an exclusion is never published after it,
 *   - a failed settlement leaves no partial ranking/snapshot/account change.
 *
 * Real OperatorSeasonModerationService, SeasonSettlementJobService (through
 * BatchService), LimitOrderCancelService, OrdersService and wallet transfer,
 * each on its own connection pool. A barrier pauses a real method right AFTER
 * it returns, so every interleaving is deterministic; lock waits are observed
 * in pg_stat_activity. Each scenario asserts the final DB state, not just which
 * promise won. No provider/Redis/HTTP calls; fixtures are uniquely named and
 * removed by ID. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpException, Logger } from '@nestjs/common';
import { BatchService } from '../src/batch/batch.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from '../src/operator/operator-season-moderation.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OrdersService } from '../src/orders/orders.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';

// Writes fixtures: loopback, disposable databases only (same rule as the
// TC-D05 suite; CI's service container database is `trading_app`).
const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SEASON_SETTLEMENT_RACE_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !(
    target.pathname.endsWith('_test') ||
    (process.env.GITHUB_ACTIONS === 'true' &&
      target.pathname === '/trading_app')
  )
)
  throw new Error(
    'Requires NODE_ENV=test, SEASON_SETTLEMENT_RACE_DB_INTEGRATION=1 and a local disposable *_test DATABASE_URL.',
  );
process.env.LIMIT_ORDER_ENABLED = 'true';
Logger.overrideLogger(false);

// One pool per actor, so a paused transaction never starves another actor.
const db = new PrismaService(); // fixtures, assertions, lock observation
const opsDb = new PrismaService(); // settlement job
const adminDb = new PrismaService(); // operator moderation
const userDb = new PrismaService(); // user trading commands

const settlementJob = () =>
  new SeasonSettlementJobService(
    new BatchService(opsDb),
    opsDb,
    new PortfolioValuationService(opsDb),
  );
const moderation = (client: PrismaService = adminDb) =>
  new OperatorSeasonModerationService(
    client,
    new OperatorAuditService(adminDb),
    new LimitOrderCancelService(client, new OrderReservationService()),
  );
function userServices() {
  const access = new TradingAccountAccessService(userDb);
  const performanceService = new GeneralAccountPerformanceService(
    userDb,
    new PortfolioValuationService(userDb),
    new GeneralExternalFundingService(userDb),
  );
  const reservation = new OrderReservationService();
  const cancel = new LimitOrderCancelService(userDb, reservation);
  return {
    access,
    cancel,
    orders: new OrdersService(
      userDb,
      undefined,
      new LimitOrderCreateService(userDb, reservation),
      cancel,
      access,
      performanceService,
    ),
    transfers: new TradingAccountWalletTransferService(
      userDb,
      access,
      performanceService,
    ),
  };
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const d = (value: { toFixed(scale: number): string }) => value.toFixed(8);

type Outcome = { ok: true; value: unknown } | { ok: false; code: string };
/** Never rejects, so a paused command can be awaited later without leaking. */
async function outcome(command: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await command };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}
function codeOf(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string'
      ? body.error.code
      : `HTTP_${error.getStatus()}`;
  }
  return error instanceof Error
    ? `${error.constructor.name}: ${error.message.split('\n')[0].slice(0, 160)}`
    : String(error);
}
const describeOutcome = (o: Outcome) => (o.ok ? 'ok' : o.code);

type Barrier = { reached: Promise<void>; release: () => void };
/** Pauses `host[method]` once, right AFTER the real call returned. */
function pauseAfter(
  host: object,
  method: string,
  when: (args: unknown[]) => boolean = () => true,
): Barrier {
  const methods = host as Record<
    string,
    (this: unknown, ...args: unknown[]) => Promise<unknown>
  >;
  const original = methods[method];
  assert.equal(typeof original, 'function', `${method} is not patchable`);
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  let fired = false;
  methods[method] = async function (this: unknown, ...args: unknown[]) {
    const result: unknown = await original.apply(this, args);
    if (!fired && when(args)) {
      fired = true;
      reach();
      await released;
    }
    return result;
  };
  return { reached, release };
}

/** Pauses once right AFTER `tx[model][operation]` returned inside any
 * interactive transaction opened through the returned client. */
function pauseAfterTxCall(
  root: PrismaService,
  model: string,
  operation: string,
): { client: PrismaService; barrier: Barrier } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  let fired = false;
  const bind = (owner: object, value: unknown): unknown =>
    typeof value === 'function'
      ? ((value as (...args: unknown[]) => unknown).bind(owner) as unknown)
      : value;
  const wrapTx = (tx: object) =>
    new Proxy(tx, {
      get(txTarget, key) {
        const value: unknown = Reflect.get(txTarget, key, txTarget);
        if (key !== model) return bind(txTarget, value);
        return new Proxy(value as object, {
          get(delegate, op) {
            const fn: unknown = Reflect.get(delegate, op, delegate);
            if (op !== operation || typeof fn !== 'function')
              return bind(delegate, fn);
            return async (...args: unknown[]) => {
              const result: unknown = await (
                fn as (...a: unknown[]) => Promise<unknown>
              ).apply(delegate, args);
              if (!fired) {
                fired = true;
                reach();
                await released;
              }
              return result;
            };
          },
        });
      },
    });
  const client = new Proxy(root, {
    get(rootTarget, key) {
      if (key !== '$transaction')
        return bind(rootTarget, Reflect.get(rootTarget, key, rootTarget));
      return (work: unknown, options?: unknown) =>
        typeof work === 'function'
          ? rootTarget.$transaction(
              (tx) => (work as (t: object) => Promise<unknown>)(wrapTx(tx)),
              options as never,
            )
          : rootTarget.$transaction(work as never, options as never);
    },
  });
  return { client, barrier: { reached, release } };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Statements of THIS database currently waiting for a heavyweight/row lock. */
async function lockWaiters(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ query: string }>>`
    SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 140) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND wait_event_type = 'Lock'
  `;
  return rows.map((row) => row.query);
}

/** Either the command finished, or it is observed waiting on a lock. */
async function blockedOrFinished(
  command: Promise<Outcome>,
  ms = 4_000,
): Promise<{ blockedOn: string[] | null; finished: boolean }> {
  let finished = false;
  void command.then(() => (finished = true));
  // Monotonic: the WSL wall clock steps backwards (see wsl-clock notes).
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (finished) return { blockedOn: null, finished };
    const waiting = await lockWaiters();
    if (waiting.length > 0) return { blockedOn: waiting, finished: false };
    await sleep(15);
  }
  return { blockedOn: null, finished };
}

async function dbNow() {
  return (
    await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  )[0].now;
}

// ------------------------------------------------------------------ fixture

const KEYS = ['A', 'B', 'C'] as const;
type Key = (typeof KEYS)[number];
const KRW = { A: '1300000', B: '1200000', C: '1100000' } as const;
type Member = { userId: string; accountId: string; participantId: string };
type Fixture = {
  seasonId: string;
  endAt: Date;
  operator: { userId: string; role: 'admin' };
  members: Record<Key, Member>;
  batchKeys: string[];
  market?: { assetId: string; priceId: string; rateId: string };
};

async function fixture(
  status: 'active' | 'ended',
  options: { usd?: { securities?: string; spot?: string } } = {},
): Promise<Fixture> {
  const now = await dbNow();
  const day = 86_400_000;
  const startAt = new Date(now.getTime() - 30 * day);
  const endAt =
    status === 'ended'
      ? new Date(now.getTime() - 3_600_000)
      : new Date(now.getTime() + day);
  const season = await db.season.create({
    data: {
      name: `tc-d01-${randomUUID()}`,
      status,
      startAt,
      endAt,
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  const operator = await db.user.create({
    data: {
      email: `tc-d01-op-${randomUUID()}@example.invalid`,
      nickname: `tcop-${randomUUID().slice(0, 8)}`,
      passwordHash: 'test-only',
      role: 'admin',
    },
  });
  const members = {} as Record<Key, Member>;
  for (const key of KEYS) {
    const user = await db.user.create({
      data: {
        email: `tc-d01-${key}-${randomUUID()}@example.invalid`,
        nickname: `tc${key}-${randomUUID().slice(0, 8)}`,
        passwordHash: 'test-only',
      },
    });
    const account = await db.tradingAccount.create({
      data: {
        userId: user.id,
        mode: 'season',
        status: 'active',
        initialCapitalKrw: '1000000',
        openedAt: startAt,
      },
    });
    const participant = await db.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: account.id,
        participantStatus: 'active',
        joinedAt: startAt,
        initialCapitalKrw: '1000000',
        totalAssetKrw: KRW[key],
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: account.id,
          currencyCode: 'KRW',
          balanceAmount: KRW[key],
        },
        {
          tradingAccountId: account.id,
          currencyCode: 'USD',
          balanceAmount: options.usd?.securities ?? '0',
        },
        ...zeroCryptoCashWalletData(account.id).map((wallet) =>
          wallet.walletScope === 'crypto_spot' && options.usd?.spot
            ? { ...wallet, balanceAmount: options.usd.spot }
            : wallet,
        ),
      ],
    });
    members[key] = {
      userId: user.id,
      accountId: account.id,
      participantId: participant.id,
    };
  }
  return {
    seasonId: season.id,
    endAt,
    operator: { userId: operator.id, role: 'admin' },
    members,
    batchKeys: [],
  };
}

/** Crypto asset + Spot price + USD/KRW rate for real limit orders. */
async function addMarket(f: Fixture) {
  const now = await dbNow();
  const asset = await db.asset.create({
    data: {
      symbol: `TD${randomUUID().slice(0, 8)}`,
      name: 'TC-D01 test',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
      isActive: true,
    },
  });
  const price = await db.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      currencyCode: 'USD',
      price: '100',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      capturedAt: now,
      effectiveAt: now,
    },
  });
  const rate = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      capturedAt: now,
      effectiveAt: now,
    },
  });
  f.market = { assetId: asset.id, priceId: price.id, rateId: rate.id };
}

async function cleanup(f: Fixture) {
  const accountIds = KEYS.map((key) => f.members[key].accountId);
  const where = { tradingAccountId: { in: accountIds } };
  await db.operatorAuditLog.deleteMany({
    where: { actorUserId: f.operator.userId },
  });
  if (f.batchKeys.length > 0)
    await db.batchJobRun.deleteMany({
      where: { idempotencyKey: { in: f.batchKeys } },
    });
  await db.seasonRanking.deleteMany({ where: { seasonId: f.seasonId } });
  await db.equitySnapshot.deleteMany({ where });
  await db.walletTransaction.deleteMany({ where });
  await db.walletTransfer.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.quote.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.cashWallet.deleteMany({ where });
  await db.seasonParticipant.deleteMany({ where: { seasonId: f.seasonId } });
  await db.tradingAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.season.delete({ where: { id: f.seasonId } });
  if (f.market) {
    await db.assetPriceSnapshot.deleteMany({
      where: { assetId: f.market.assetId },
    });
    await db.asset.delete({ where: { id: f.market.assetId } });
    await db.fxRateSnapshot.delete({ where: { id: f.market.rateId } });
  }
  await db.user.deleteMany({
    where: {
      id: {
        in: [f.operator.userId, ...KEYS.map((key) => f.members[key].userId)],
      },
    },
  });
}

// ------------------------------------------------------------------ commands

const EXCLUDE_REASON = 'tc-d01 race';
const exclude = (
  service: OperatorSeasonModerationService,
  f: Fixture,
  key: Key = 'B',
) =>
  service.excludeParticipant(
    f.operator,
    f.seasonId,
    f.members[key].participantId,
    { reason: EXCLUDE_REASON },
    { requestId: `tc-d01-${randomUUID()}` },
  );

function settle(job: SeasonSettlementJobService, f: Fixture, key?: string) {
  const idempotencyKey = key ?? `tc-d01:${f.seasonId}:${randomUUID()}`;
  if (!f.batchKeys.includes(idempotencyKey)) f.batchKeys.push(idempotencyKey);
  return job.run({
    seasonId: f.seasonId,
    settlementDate: dateOnly(f.endAt),
    idempotencyKey,
    requestedBy: 'tc-d01-integration',
  });
}

type InternalSettlement = {
  createFinalSettlementAtomically(input: {
    seasonId: string;
    settlementDate: Date;
    capturedAt: Date;
    finalRows: readonly Record<string, unknown>[];
  }): Promise<unknown>;
};
/** The audit's reproduction shape: the internal final write with rows valued
 * beforehand, exactly as runSeasonSettlementJob hands them over. */
function finalRowsFor(
  f: Fixture,
  ranked: readonly Key[],
  tiers: readonly string[],
) {
  return ranked.map((key, index) => ({
    seasonParticipantId: f.members[key].participantId,
    userId: f.members[key].userId,
    totalAssetKrw: KRW[key],
    returnRate: String((Number(KRW[key]) - 1_000_000) / 10_000),
    krwCash: KRW[key],
    usdCashKrw: '0',
    domesticStockValueKrw: '0',
    usStockValueKrw: '0',
    cryptoValueKrw: '0',
    maxDrawdown: '0',
    totalFillCount: 0,
    reachedReturnAt: f.endAt,
    rank: index + 1,
    finalTier: tiers[index],
  }));
}
function internalFinalWrite(
  job: SeasonSettlementJobService,
  f: Fixture,
  rows: ReturnType<typeof finalRowsFor>,
) {
  return (job as unknown as InternalSettlement).createFinalSettlementAtomically(
    {
      seasonId: f.seasonId,
      settlementDate: new Date(`${dateOnly(f.endAt)}T00:00:00.000Z`),
      capturedAt: new Date(),
      finalRows: rows,
    },
  );
}

// ------------------------------------------------------------------ state

async function state(f: Fixture) {
  const accountIds = KEYS.map((key) => f.members[key].accountId);
  const keyOfParticipant = new Map(
    KEYS.map((key) => [f.members[key].participantId, key]),
  );
  const keyOfAccount = new Map(
    KEYS.map((key) => [f.members[key].accountId, key]),
  );
  const season = await db.season.findUniqueOrThrow({
    where: { id: f.seasonId },
  });
  const participants = await db.seasonParticipant.findMany({
    where: { seasonId: f.seasonId },
  });
  const accounts = await db.tradingAccount.findMany({
    where: { id: { in: accountIds } },
  });
  const finalRows = await db.seasonRanking.findMany({
    where: { seasonId: f.seasonId, rankType: 'final' },
    orderBy: [{ rank: 'asc' }],
  });
  const settlementSnapshots = await db.equitySnapshot.findMany({
    where: {
      tradingAccountId: { in: accountIds },
      snapshotReason: 'settlement',
    },
  });
  const audits = await db.operatorAuditLog.findMany({
    where: { actorUserId: f.operator.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const wallets = await db.cashWallet.findMany({
    where: { tradingAccountId: { in: accountIds }, walletScope: 'crypto_spot' },
  });
  const orders = await db.order.findMany({
    where: { tradingAccountId: { in: accountIds }, orderType: 'limit' },
  });
  const byKey = {} as Record<
    Key,
    {
      participant: string;
      finalRank: number | null;
      finalTier: string | null;
      currentRank: number | null;
      excludedReason: string | null;
      account: string;
      closedAtIsEndAt: boolean | null;
      spotUsd: string;
      spotReserved: string;
    }
  >;
  for (const participant of participants) {
    const key = keyOfParticipant.get(participant.id)!;
    const account = accounts.find(
      (a) => a.id === participant.tradingAccountId,
    )!;
    const wallet = wallets.find((w) => w.tradingAccountId === account.id)!;
    byKey[key] = {
      participant: participant.participantStatus,
      finalRank: participant.finalRank,
      finalTier: participant.finalTier,
      currentRank: participant.currentRank,
      excludedReason: participant.excludedReason,
      account: account.status,
      closedAtIsEndAt: account.closedAt
        ? account.closedAt.getTime() === season.endAt.getTime()
        : null,
      spotUsd: d(wallet.balanceAmount),
      spotReserved: d(wallet.reservedAmount),
    };
  }
  return {
    season: season.status,
    byKey,
    final: finalRows.map(
      (row) => `${keyOfParticipant.get(row.seasonParticipantId)}:${row.rank}`,
    ),
    finalScopeOk: finalRows.every(
      (row) =>
        keyOfAccount.get(row.tradingAccountId) ===
        keyOfParticipant.get(row.seasonParticipantId),
    ),
    settlementSnapshots: settlementSnapshots
      .map((row) => keyOfAccount.get(row.tradingAccountId))
      .sort(),
    audits: audits.map((row) =>
      [
        row.action.replace('operator.season_participant.', ''),
        row.result,
        row.errorCode,
      ]
        .filter(Boolean)
        .join(':'),
    ),
    orders: orders.map(
      (order) =>
        `${keyOfAccount.get(order.tradingAccountId)}:${order.status}:${order.cancelReason ?? '-'}`,
    ),
  };
}
type State = Awaited<ReturnType<typeof state>>;

/** Policy invariants that must hold at EVERY observed end state. */
function assertInvariants(s: State) {
  const eligible = KEYS.filter((key) =>
    ['finished', 'rewarded', 'active'].includes(s.byKey[key].participant),
  );
  for (const key of KEYS) {
    const member = s.byKey[key];
    if (member.participant === 'excluded') {
      assert.notEqual(member.account, 'active', `${key}: excluded but active`);
      assert.equal(member.finalRank, null, `${key}: excluded with finalRank`);
      assert.equal(member.finalTier, null, `${key}: excluded with finalTier`);
      assert.ok(
        !s.final.some((row) => row.startsWith(`${key}:`)),
        `${key}: excluded participant in final ranking`,
      );
    }
  }
  assert.ok(s.finalScopeOk, 'final ranking scope mismatch');
  assert.equal(
    new Set(s.final.map((row) => row.split(':')[0])).size,
    s.final.length,
    'duplicate final ranking rows for one participant',
  );
  if (s.season === 'settled') {
    for (const key of KEYS) {
      assert.equal(s.byKey[key].account, 'closed', `${key}: settled but live`);
      assert.equal(s.byKey[key].closedAtIsEndAt, true, `${key}: closedAt`);
      assert.notEqual(s.byKey[key].participant, 'active', `${key}: active`);
    }
    assert.deepEqual(
      s.final.map((row) => row.split(':')[0]).sort(),
      [...eligible].sort(),
      'final ranking set differs from eligible participants',
    );
  } else {
    // A failed settlement must not have published anything.
    assert.deepEqual(s.final, [], 'unsettled season has final rows');
    assert.deepEqual(s.settlementSnapshots, [], 'partial settlement snapshots');
    for (const key of KEYS)
      assert.notEqual(s.byKey[key].account, 'closed', `${key}: closed early`);
  }
}

/** B excluded first, then the season settled over A and C only. */
function assertExcludedThenSettled(s: State) {
  assertInvariants(s);
  assert.equal(s.season, 'settled');
  assert.deepEqual(s.final, ['A:1', 'C:2']);
  assert.deepEqual(s.settlementSnapshots, ['A', 'C']);
  assert.deepEqual(
    [s.byKey.A.finalTier, s.byKey.C.finalTier],
    ['master', 'silver'],
  );
  assert.equal(s.byKey.A.participant, 'finished');
  assert.equal(s.byKey.C.participant, 'finished');
  assert.equal(s.byKey.B.participant, 'excluded');
  assert.equal(s.byKey.B.excludedReason, EXCLUDE_REASON);
  assert.equal(s.byKey.B.currentRank, null);
  assert.ok(s.audits.includes('exclude:success'), 'exclusion audit missing');
}

/** Settled over all three first; the exclusion is refused and audited. */
function assertSettledThenRefused(s: State) {
  assertInvariants(s);
  assert.equal(s.season, 'settled');
  assert.deepEqual(s.final, ['A:1', 'B:2', 'C:3']);
  assert.deepEqual(
    KEYS.map((key) => s.byKey[key].finalTier),
    ['master', 'gold', 'silver'],
  );
  for (const key of KEYS) assert.equal(s.byKey[key].participant, 'finished');
  assert.equal(s.byKey.B.excludedReason, null);
  assert.ok(
    s.audits.includes('exclude.failed:failure:PARTICIPANT_EXCLUDE_NOT_ALLOWED'),
    `failure audit missing: ${JSON.stringify(s.audits)}`,
  );
  assert.ok(!s.audits.includes('exclude:success'));
}

/** The settlement failed BEFORE publishing; the exclusion stands. */
function assertExcludedAndUnsettled(s: State) {
  assertInvariants(s);
  assert.equal(s.season, 'ended');
  assert.equal(s.byKey.B.participant, 'excluded');
  assert.equal(s.byKey.B.account, 'suspended');
  assert.equal(s.byKey.A.account, 'active');
  assert.equal(s.byKey.A.participant, 'active');
}

async function batchRun(key: string) {
  return db.batchJobRun.findFirstOrThrow({ where: { idempotencyKey: key } });
}

// ------------------------------------------------------------------ scenarios

type Scenario = { name: string; run: () => Promise<Record<string, unknown>> };
/** The last observation of the running scenario, reported if it fails. */
let lastObserved: unknown = null;
const scenarios: Scenario[] = [];
const scenario = (name: string, run: Scenario['run']) =>
  scenarios.push({ name, run });

scenario('1 exclusion committed, then settlement', async () => {
  const f = await fixture('ended');
  try {
    const excluded = await outcome(exclude(moderation(), f));
    const settled = await outcome(settle(settlementJob(), f));
    const s = await state(f);
    const observed = {
      excluded: describeOutcome(excluded),
      settled: describeOutcome(settled),
      s,
    };
    lastObserved = observed;
    assert.ok(excluded.ok && settled.ok, JSON.stringify(observed));
    assertExcludedThenSettled(s);
    return observed;
  } finally {
    await cleanup(f);
  }
});

scenario('2 settlement committed, then exclusion', async () => {
  const f = await fixture('ended');
  try {
    const settled = await outcome(settle(settlementJob(), f));
    const excluded = await outcome(exclude(moderation(), f));
    const s = await state(f);
    const observed = {
      settled: describeOutcome(settled),
      excluded: describeOutcome(excluded),
      s,
    };
    lastObserved = observed;
    assert.ok(settled.ok, JSON.stringify(observed));
    assert.equal(describeOutcome(excluded), 'PARTICIPANT_EXCLUDE_NOT_ALLOWED');
    assertSettledThenRefused(s);
    return observed;
  } finally {
    await cleanup(f);
  }
});

for (const pausePoint of ['participant', 'account'] as const)
  scenario(
    `3${pausePoint === 'participant' ? 'a' : 'b'} audit shape: exclusion paused after its ${pausePoint} read, final write commits meanwhile`,
    async () => {
      const f = await fixture('ended');
      try {
        // 3b is the audit's exact barrier: right after the exclusion read the
        // linked account (status active) inside its transaction.
        const paused =
          pausePoint === 'account'
            ? pauseAfterTxCall(adminDb, 'tradingAccount', 'findUnique')
            : null;
        const mod = paused ? moderation(paused.client) : moderation();
        const read = paused
          ? paused.barrier
          : pauseAfter(mod, 'findParticipantOrThrow');
        const excluding = outcome(exclude(mod, f));
        await bounded(read.reached, 'exclusion read');
        const job = settlementJob();
        const writing = outcome(
          internalFinalWrite(
            job,
            f,
            finalRowsFor(f, ['A', 'B', 'C'], ['master', 'gold', 'silver']),
          ),
        );
        const observedWrite = await blockedOrFinished(writing);
        read.release();
        const [excluded, written] = await bounded(
          Promise.all([excluding, writing]),
          'scenario 3',
        );
        const afterRace = await state(f);
        const observed: Record<string, unknown> = {
          finalWriteBlockedOn: observedWrite.blockedOn,
          excluded: describeOutcome(excluded),
          finalWrite: describeOutcome(written),
          afterRace,
        };
        lastObserved = observed;
        assertInvariants(afterRace);
        assert.ok(observedWrite.blockedOn, JSON.stringify(observed));
        assert.ok(excluded.ok, JSON.stringify(observed));
        assert.equal(
          describeOutcome(written),
          'SETTLEMENT_PARTICIPANTS_CHANGED',
        );
        assertExcludedAndUnsettled(afterRace);
        // The retry values the season as it stands now.
        const retried = await outcome(settle(settlementJob(), f));
        const s = await state(f);
        observed.retry = describeOutcome(retried);
        observed.final = s;
        assert.ok(retried.ok, JSON.stringify(observed));
        assertExcludedThenSettled(s);
        return observed;
      } finally {
        await cleanup(f);
      }
    },
  );

scenario('4 settlement holds the season lock, exclusion arrives', async () => {
  const f = await fixture('ended');
  try {
    const job = settlementJob();
    const locked = pauseAfter(job, 'findSettlementAccountParticipants');
    const settling = outcome(settle(job, f));
    await bounded(locked.reached, 'settlement under lock');
    const excluding = outcome(exclude(moderation(), f));
    const observedExclusion = await blockedOrFinished(excluding);
    locked.release();
    const [settled, excluded] = await bounded(
      Promise.all([settling, excluding]),
      'scenario 4',
    );
    const s = await state(f);
    const observed = {
      exclusionBlockedOn: observedExclusion.blockedOn,
      settled: describeOutcome(settled),
      excluded: describeOutcome(excluded),
      s,
    };
    lastObserved = observed;
    assertInvariants(s);
    assert.ok(observedExclusion.blockedOn, JSON.stringify(observed));
    assert.ok(settled.ok, JSON.stringify(observed));
    assert.equal(describeOutcome(excluded), 'PARTICIPANT_EXCLUDE_NOT_ALLOWED');
    assertSettledThenRefused(s);
    return observed;
  } finally {
    await cleanup(f);
  }
});

scenario(
  '5 exclusion holds its locks, public settlement run arrives; failed run retried',
  async () => {
    const f = await fixture('ended');
    try {
      const mod = moderation();
      const read = pauseAfter(mod, 'findParticipantOrThrow');
      const excluding = outcome(exclude(mod, f));
      await bounded(read.reached, 'exclusion read');
      const job = settlementJob();
      const firstKey = `tc-d01:${f.seasonId}:first`;
      const settling = outcome(settle(job, f, firstKey));
      const observedSettlement = await blockedOrFinished(settling);
      read.release();
      const [excluded, settled] = await bounded(
        Promise.all([excluding, settling]),
        'scenario 5',
      );
      const afterRace = await state(f);
      const run = await batchRun(firstKey);
      const observed: Record<string, unknown> = {
        settlementBlockedOn: observedSettlement.blockedOn,
        excluded: describeOutcome(excluded),
        settled: describeOutcome(settled),
        batchRun: `${run.status}:${run.errorCode ?? '-'}`,
        afterRace,
      };
      lastObserved = observed;
      assertInvariants(afterRace);
      assert.ok(observedSettlement.blockedOn, JSON.stringify(observed));
      assert.ok(excluded.ok, JSON.stringify(observed));
      assert.equal(describeOutcome(settled), 'SETTLEMENT_PARTICIPANTS_CHANGED');
      assert.equal(observed.batchRun, 'failed:SETTLEMENT_PARTICIPANTS_CHANGED');
      assertExcludedAndUnsettled(afterRace);
      // Existing batch policy: a failed key is not silently re-run...
      const sameKey = await outcome(settle(settlementJob(), f, firstKey));
      observed.sameKeyRetry = describeOutcome(sameKey);
      assert.equal(
        observed.sameKeyRetry,
        'BATCH_JOB_RETRY_REQUIRES_NEW_IDEMPOTENCY_KEY',
      );
      // ...and a new key recomputes against the current participant set.
      const retried = await outcome(settle(settlementJob(), f));
      const s = await state(f);
      observed.retry = describeOutcome(retried);
      observed.final = s;
      assert.ok(retried.ok, JSON.stringify(observed));
      assertExcludedThenSettled(s);
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

scenario(
  '6 exclusion commits while settlement is valuing participants',
  async () => {
    const f = await fixture('ended');
    try {
      const job = settlementJob();
      const valued = pauseAfter(job, 'calculateFinalValuations');
      const settling = outcome(settle(job, f));
      await bounded(valued.reached, 'settlement valuation');
      const excluded = await bounded(
        outcome(exclude(moderation(), f)),
        'exclusion during valuation',
      );
      valued.release();
      const settled = await bounded(settling, 'scenario 6 settlement');
      const afterRace = await state(f);
      const observed: Record<string, unknown> = {
        excluded: describeOutcome(excluded),
        settled: describeOutcome(settled),
        afterRace,
      };
      lastObserved = observed;
      assertInvariants(afterRace);
      assert.ok(excluded.ok, JSON.stringify(observed));
      assert.equal(describeOutcome(settled), 'SETTLEMENT_PARTICIPANTS_CHANGED');
      assertExcludedAndUnsettled(afterRace);
      const retried = await outcome(settle(settlementJob(), f));
      const s = await state(f);
      observed.retry = describeOutcome(retried);
      observed.final = s;
      assert.ok(retried.ok, JSON.stringify(observed));
      assertExcludedThenSettled(s);
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

scenario(
  '7 precomputed final rows disagree with the eligible set at lock time',
  async () => {
    const f = await fixture('ended');
    try {
      assert.ok((await outcome(exclude(moderation(), f))).ok);
      // (a) rows still contain the now-excluded B.
      const stale = await outcome(
        internalFinalWrite(
          settlementJob(),
          f,
          finalRowsFor(f, ['A', 'B', 'C'], ['master', 'gold', 'silver']),
        ),
      );
      const afterStale = await state(f);
      // (b) rows miss the still-eligible C.
      const missing = await outcome(
        internalFinalWrite(
          settlementJob(),
          f,
          finalRowsFor(f, ['A'], ['master']),
        ),
      );
      const afterMissing = await state(f);
      const observed: Record<string, unknown> = {
        staleRows: describeOutcome(stale),
        missingRows: describeOutcome(missing),
        afterStale,
      };
      lastObserved = observed;
      assertInvariants(afterStale);
      assertInvariants(afterMissing);
      assert.equal(observed.staleRows, 'SETTLEMENT_PARTICIPANTS_CHANGED');
      assert.equal(observed.missingRows, 'SETTLEMENT_PARTICIPANTS_CHANGED');
      assertExcludedAndUnsettled(afterStale);
      assertExcludedAndUnsettled(afterMissing);
      const retried = await outcome(settle(settlementJob(), f));
      const s = await state(f);
      observed.retry = describeOutcome(retried);
      observed.final = s;
      assert.ok(retried.ok, JSON.stringify(observed));
      assertExcludedThenSettled(s);
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

scenario('8 duplicate and repeated settlement runs', async () => {
  const f = await fixture('ended');
  try {
    // Two concurrent runs: one publishes, the other must not publish a
    // second, different result (it may reuse it or fail closed).
    const [first, second] = await bounded(
      Promise.all([
        outcome(settle(settlementJob(), f)),
        outcome(settle(settlementJob(), f)),
      ]),
      'concurrent settlement runs',
    );
    const afterConcurrent = await state(f);
    const observed: Record<string, unknown> = {
      concurrent: [describeOutcome(first), describeOutcome(second)],
      afterConcurrent,
    };
    lastObserved = observed;
    assert.ok(first.ok || second.ok, JSON.stringify(observed));
    assertInvariants(afterConcurrent);
    assert.deepEqual(afterConcurrent.final, ['A:1', 'B:2', 'C:3']);
    // Re-run after settled (new key): reuse, nothing recomputed.
    const rerun = await outcome(settle(settlementJob(), f));
    const afterRerun = await state(f);
    observed.rerun = describeOutcome(rerun);
    assert.ok(rerun.ok, JSON.stringify(observed));
    assert.deepEqual(afterRerun, afterConcurrent);
    // Same key as a succeeded run: deduplicated, not re-executed.
    const succeededKey = f.batchKeys[first.ok ? 0 : 1];
    const replay = await settle(settlementJob(), f, succeededKey);
    observed.replay = replay.data;
    assert.equal(
      (replay.data as unknown as { deduplicated: boolean }).deduplicated,
      true,
    );
    assert.deepEqual(await state(f), afterConcurrent);
    return observed;
  } finally {
    await cleanup(f);
  }
});

scenario(
  '8b second run waits for the first run holding the final-write lock',
  async () => {
    const f = await fixture('ended');
    try {
      const firstJob = settlementJob();
      const locked = pauseAfter(firstJob, 'findSettlementAccountParticipants');
      const first = outcome(settle(firstJob, f));
      await bounded(locked.reached, 'first run under lock');
      const second = outcome(settle(settlementJob(), f));
      const observedSecond = await blockedOrFinished(second);
      locked.release();
      const [firstDone, secondDone] = await bounded(
        Promise.all([first, second]),
        'scenario 8b',
      );
      const s = await state(f);
      const observed = {
        secondBlockedOn: observedSecond.blockedOn,
        first: describeOutcome(firstDone),
        second: describeOutcome(secondDone),
        s,
      };
      lastObserved = observed;
      assertInvariants(s);
      assert.ok(observedSecond.blockedOn, JSON.stringify(observed));
      assert.ok(firstDone.ok, JSON.stringify(observed));
      // The waiter either reuses the published result or fails closed; it
      // never publishes a second one.
      assert.deepEqual(s.final, ['A:1', 'B:2', 'C:3']);
      assert.deepEqual(s.settlementSnapshots, ['A', 'B', 'C']);
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

scenario(
  '9 season trading command vs exclusion (both lock orders)',
  async () => {
    const f = await fixture('active', { usd: { securities: '100' } });
    try {
      const B = f.members.B;
      const wallets = await db.cashWallet.findMany({
        where: { tradingAccountId: B.accountId, currencyCode: 'USD' },
      });
      const source = wallets.find((w) => w.walletScope === 'securities')!;
      const destination = wallets.find((w) => w.walletScope === 'crypto_spot')!;
      const transferBody = () => ({
        sourceWalletId: source.id,
        destinationWalletId: destination.id,
        amount: '10',
        idempotencyKey: randomUUID(),
      });

      // (a) The transfer holds Season/Account/Participant SHARE locks.
      const tradingA = userServices();
      const inTx = pauseAfter(
        tradingA.access,
        'getOwnedAccountOrThrow',
        (args) => args[2] !== undefined,
      );
      const transferring = outcome(
        tradingA.transfers.transfer(B.userId, B.accountId, transferBody()),
      );
      await bounded(inTx.reached, 'transfer under locks');
      const excludingA = outcome(exclude(moderation(), f));
      const observedA = await blockedOrFinished(excludingA);
      inTx.release();
      const [transferredA, excludedA] = await bounded(
        Promise.all([transferring, excludingA]),
        'scenario 9a',
      );
      const afterA = await state(f);
      const observed: Record<string, unknown> = {
        a: {
          exclusionBlockedOn: observedA.blockedOn,
          transfer: describeOutcome(transferredA),
          excluded: describeOutcome(excludedA),
          spotUsd: afterA.byKey.B.spotUsd,
        },
      };
      lastObserved = observed;
      assertInvariants(afterA);
      assert.ok(transferredA.ok && excludedA.ok, JSON.stringify(observed));
      assert.equal(afterA.byKey.B.spotUsd, '10.00000000');
      assert.equal(afterA.byKey.B.participant, 'excluded');
      assert.equal(afterA.byKey.B.account, 'suspended');

      // (b) The exclusion of C holds its locks; C's transfer arrives.
      const C = f.members.C;
      const cWallets = await db.cashWallet.findMany({
        where: { tradingAccountId: C.accountId, currencyCode: 'USD' },
      });
      const mod = moderation();
      const read = pauseAfter(mod, 'findParticipantOrThrow');
      const excludingB = outcome(exclude(mod, f, 'C'));
      await bounded(read.reached, 'exclusion read');
      const transferringB = outcome(
        userServices().transfers.transfer(C.userId, C.accountId, {
          sourceWalletId: cWallets.find((w) => w.walletScope === 'securities')!
            .id,
          destinationWalletId: cWallets.find(
            (w) => w.walletScope === 'crypto_spot',
          )!.id,
          amount: '10',
          idempotencyKey: randomUUID(),
        }),
      );
      const observedB = await blockedOrFinished(transferringB);
      read.release();
      const [excludedB, transferredB] = await bounded(
        Promise.all([excludingB, transferringB]),
        'scenario 9b',
      );
      const afterB = await state(f);
      observed.b = {
        transferBlockedOn: observedB.blockedOn,
        excluded: describeOutcome(excludedB),
        transfer: describeOutcome(transferredB),
        spotUsd: afterB.byKey.C.spotUsd,
      };
      assertInvariants(afterB);
      assert.ok(excludedB.ok, JSON.stringify(observed));
      assert.equal(afterB.byKey.C.participant, 'excluded');
      // Either serialization is valid; a half-applied transfer is not.
      if (transferredB.ok) assert.equal(afterB.byKey.C.spotUsd, '10.00000000');
      else {
        assert.ok(
          ['TRADING_ACCOUNT_NOT_ACTIVE', 'PARTICIPANT_EXCLUDED'].includes(
            describeOutcome(transferredB),
          ),
          JSON.stringify(observed),
        );
        assert.equal(afterB.byKey.C.spotUsd, '0.00000000');
      }
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

async function refreshMarket(f: Fixture) {
  const now = await dbNow();
  await db.assetPriceSnapshot.update({
    where: { id: f.market!.priceId },
    data: { capturedAt: now, effectiveAt: now },
  });
  await db.fxRateSnapshot.update({
    where: { id: f.market!.rateId },
    data: { capturedAt: now, effectiveAt: now },
  });
}

async function placeLimitBuy(
  trading: ReturnType<typeof userServices>,
  f: Fixture,
  key: Key,
) {
  await refreshMarket(f);
  const member = f.members[key];
  const body = {
    assetId: f.market!.assetId,
    side: 'buy',
    orderType: 'limit',
    amount: '100',
    limitPrice: '90',
  };
  const quote = await trading.orders.quoteOrderForTradingAccount(
    member.userId,
    member.accountId,
    body,
  );
  const created = await trading.orders.createOrderForTradingAccount(
    member.userId,
    member.accountId,
    { ...body, quoteId: quote.data.quoteId!, idempotencyKey: randomUUID() },
  );
  const order = await db.order.findFirstOrThrow({
    where: { tradingAccountId: member.accountId, status: 'submitted' },
  });
  assert.ok(created);
  return order.id;
}

scenario(
  '10 limit reservation: user cancel and limit create vs exclusion',
  async () => {
    const f = await fixture('active', { usd: { spot: '1000' } });
    await addMarket(f);
    try {
      const B = f.members.B;
      const trading = userServices();
      // (a) Exclusion holds its locks; the user's own cancel arrives.
      const firstOrder = await placeLimitBuy(trading, f, 'B');
      const reserved = await state(f);
      const mod = moderation();
      const read = pauseAfter(mod, 'findParticipantOrThrow');
      const excluding = outcome(exclude(mod, f));
      await bounded(read.reached, 'exclusion read');
      const canceling = outcome(
        trading.cancel.cancelOwnedLimitBuyOrder({
          userId: B.userId,
          orderId: firstOrder,
          canceledAt: new Date(),
        }),
      );
      const observedA = await blockedOrFinished(canceling);
      read.release();
      const [excluded, canceled] = await bounded(
        Promise.all([excluding, canceling]),
        'scenario 10a',
      );
      const afterA = await state(f);
      const observed: Record<string, unknown> = {
        reservedBefore: reserved.byKey.B.spotReserved,
        a: {
          cancelBlockedOn: observedA.blockedOn,
          excluded: describeOutcome(excluded),
          canceled: describeOutcome(canceled),
          orders: afterA.orders,
          spot: [afterA.byKey.B.spotUsd, afterA.byKey.B.spotReserved],
        },
      };
      lastObserved = observed;
      assertInvariants(afterA);
      assert.notEqual(reserved.byKey.B.spotReserved, '0.00000000');
      assert.ok(excluded.ok, JSON.stringify(observed));
      assert.equal(afterA.orders.length, 1);
      assert.ok(afterA.orders[0].startsWith('B:canceled:'));
      // Released exactly once: full balance back, nothing reserved.
      assert.deepEqual(
        [afterA.byKey.B.spotUsd, afterA.byKey.B.spotReserved],
        ['1000.00000000', '0.00000000'],
      );

      // (c) Exclusion of A holds its locks; A's limit buy (quoted before)
      // arrives and must not reserve cash for an excluded participant.
      const A = f.members.A;
      await refreshMarket(f);
      const body = {
        assetId: f.market!.assetId,
        side: 'buy',
        orderType: 'limit',
        amount: '100',
        limitPrice: '90',
      };
      const quote = await trading.orders.quoteOrderForTradingAccount(
        A.userId,
        A.accountId,
        body,
      );
      const modA = moderation();
      const readA = pauseAfter(modA, 'findParticipantOrThrow');
      const excludingA = outcome(exclude(modA, f, 'A'));
      await bounded(readA.reached, 'exclusion of A read');
      const creating = outcome(
        trading.orders.createOrderForTradingAccount(A.userId, A.accountId, {
          ...body,
          quoteId: quote.data.quoteId!,
          idempotencyKey: randomUUID(),
        }),
      );
      const observedC = await blockedOrFinished(creating);
      readA.release();
      const [excludedA, created] = await bounded(
        Promise.all([excludingA, creating]),
        'scenario 10c',
      );
      const afterC = await state(f);
      observed.c = {
        createBlockedOn: observedC.blockedOn,
        excluded: describeOutcome(excludedA),
        created: describeOutcome(created),
        orders: afterC.orders,
        spot: [afterC.byKey.A.spotUsd, afterC.byKey.A.spotReserved],
      };
      assertInvariants(afterC);
      assert.ok(excludedA.ok, JSON.stringify(observed));
      // Either the order committed first and the exclusion canceled it, or it
      // was refused; an excluded participant never keeps a reservation.
      if (created.ok)
        assert.deepEqual(
          afterC.orders.filter((order) => order.startsWith('A:')),
          ['A:canceled:participant_excluded'],
        );
      else
        assert.ok(
          !afterC.orders.some((order) => order.startsWith('A:')),
          JSON.stringify(observed),
        );
      assert.deepEqual(
        [afterC.byKey.A.spotUsd, afterC.byKey.A.spotReserved],
        ['1000.00000000', '0.00000000'],
      );

      // (b) The user's cancel holds the order + wallet locks; C is excluded.
      const C = f.members.C;
      const secondOrder = await placeLimitBuy(trading, f, 'C');
      const userCancel = userServices().cancel;
      const releasing = pauseAfter(userCancel, 'releaseAndCancelLockedOrder');
      const cancelingB = outcome(
        userCancel.cancelOwnedLimitBuyOrder({
          userId: C.userId,
          orderId: secondOrder,
          canceledAt: new Date(),
        }),
      );
      await bounded(releasing.reached, 'user cancel under order lock');
      const excludingB = outcome(exclude(moderation(), f, 'C'));
      const observedB = await blockedOrFinished(excludingB);
      releasing.release();
      const [canceledB, excludedB] = await bounded(
        Promise.all([cancelingB, excludingB]),
        'scenario 10b',
      );
      const afterB = await state(f);
      observed.b = {
        exclusionBlockedOn: observedB.blockedOn,
        canceled: describeOutcome(canceledB),
        excluded: describeOutcome(excludedB),
        orders: afterB.orders,
        spot: [afterB.byKey.C.spotUsd, afterB.byKey.C.spotReserved],
      };
      assertInvariants(afterB);
      assert.ok(canceledB.ok && excludedB.ok, JSON.stringify(observed));
      assert.ok(
        afterB.orders.some((order) => order.startsWith('C:canceled:')),
        JSON.stringify(observed),
      );
      assert.deepEqual(
        [afterB.byKey.C.spotUsd, afterB.byKey.C.spotReserved],
        ['1000.00000000', '0.00000000'],
      );
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

scenario(
  '11 ended season with open limit reservations: exclusion, cleanup, settlement',
  async () => {
    const f = await fixture('active', { usd: { spot: '1000' } });
    await addMarket(f);
    try {
      const trading = userServices();
      await placeLimitBuy(trading, f, 'A');
      await placeLimitBuy(trading, f, 'B');
      // Lifecycle transition: the season has ended with both orders open.
      const endAt = await dbNow();
      await db.season.update({
        where: { id: f.seasonId },
        data: { status: 'ended', endAt },
      });
      f.endAt = endAt;
      const blocked = await outcome(settle(settlementJob(), f));
      const afterBlocked = await state(f);
      // Exclusion in the ended season releases B's reservation atomically.
      const excluded = await outcome(exclude(moderation(), f));
      const stillBlocked = await outcome(settle(settlementJob(), f));
      const swept = await trading.cancel.cleanupEndedSeasonLimitReservations({
        now: await dbNow(),
      });
      const settled = await outcome(settle(settlementJob(), f));
      const s = await state(f);
      const observed = {
        blocked: describeOutcome(blocked),
        excluded: describeOutcome(excluded),
        stillBlocked: describeOutcome(stillBlocked),
        cleanupCanceled: swept.canceledOrderCount,
        settled: describeOutcome(settled),
        s,
      };
      lastObserved = observed;
      assertInvariants(afterBlocked);
      assert.equal(observed.blocked, 'OPEN_LIMIT_ORDER_RESERVATIONS');
      assert.ok(excluded.ok, JSON.stringify(observed));
      assert.equal(observed.stillBlocked, 'OPEN_LIMIT_ORDER_RESERVATIONS');
      assert.ok(settled.ok, JSON.stringify(observed));
      assertInvariants(s);
      assert.deepEqual(s.final, ['A:1', 'C:2']);
      assert.deepEqual(s.orders.sort(), [
        'A:canceled:season_ended',
        'B:canceled:participant_excluded',
      ]);
      for (const key of KEYS)
        assert.deepEqual(
          [s.byKey[key].spotUsd, s.byKey[key].spotReserved],
          ['1000.00000000', '0.00000000'],
          key,
        );
      return observed;
    } finally {
      await cleanup(f);
    }
  },
);

// ------------------------------------------------------------------ main

async function main() {
  await Promise.all([db, opsDb, adminDb, userDb].map((c) => c.$connect()));
  const only = process.env.TC_D01_ONLY?.split(',').map((s) => s.trim());
  const results: Array<{ scenario: string; verdict: string; detail: unknown }> =
    [];
  for (const { name, run } of scenarios) {
    if (only && !only.some((prefix) => name.startsWith(`${prefix} `))) continue;
    const startedAt = performance.now();
    lastObserved = null;
    try {
      const detail = await run();
      results.push({ scenario: name, verdict: 'PASS', detail });
    } catch (error) {
      results.push({
        scenario: name,
        verdict: 'FAIL',
        detail: {
          error: error instanceof Error ? error.message : String(error),
          observed: lastObserved,
        },
      });
    }
    const last = results[results.length - 1];
    console.log(
      JSON.stringify({
        ...last,
        ms: Math.round(performance.now() - startedAt),
      }),
    );
  }
  const failed = results.filter((r) => r.verdict !== 'PASS');
  console.log(
    JSON.stringify({
      summary: {
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.map((r) => r.scenario),
      },
    }),
  );
  if (failed.length > 0) process.exitCode = 1;
  else console.log('season settlement exclusion race PostgreSQL ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() =>
    Promise.all([db, opsDb, adminDb, userDb].map((c) => c.$disconnect())),
  );
