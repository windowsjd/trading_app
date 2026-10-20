/** Self-service account deletion, opt-in disposable PostgreSQL
 * (docs/account-deletion-contract.md §10).
 *
 * Real AccountDeletionService, AuthService + AccessTokenGuard, email
 * verification (in-memory delivery), ProfileImageService (in-memory object
 * storage), season settlement through BatchService, RankingService, the
 * ranking/settlement audit, operator restore and the trading services that
 * create the account-scoped rows (F1 Futures fixtures). Every scenario asserts
 * the database end state: the member's rows are gone, other members' rows are
 * identical, settled final results keep their values under an anonymous
 * placeholder. Races are deterministic (row locks held by a second
 * transaction, barriers inside real methods, lock waits observed in
 * pg_stat_activity). No provider, Redis or network call. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from '../src/generated/prisma/client';
import {
  app,
  db,
  fixture,
  fxEvidence,
  fxEvidenceIds,
  newInstrument,
  now,
  price as lastPrice,
  spotPrice,
  type Scenario,
} from './futures-integration';
import { authEmailFixture } from './lib/auth-email-fixture';
import { releaseLearningAssets } from './lib/beginner-quest-practice';
import { auditRankingAndSettlement } from './lib/repair-ranking-scope';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import {
  ACCOUNT_DELETION_PLACEHOLDER_NICKNAME,
  isAccountDeletionPlaceholderEmail,
  lockDeletionScope,
  purgeDeletionScope,
} from '../src/auth/account-deletion.purge';
import { AccountDeletionService } from '../src/auth/account-deletion.service';
import { AuthService } from '../src/auth/auth.service';
import { CURRENT_TERMS_VERSION } from '../src/auth/terms.constants';
import { ProfileImageCleanupService } from '../src/auth/profile-image-cleanup.service';
import { EmailAuthCleanupService } from '../src/auth/email-auth-cleanup.service';
import { DataRetentionCleanupService } from '../src/auth/data-retention-cleanup.service';
import { ProfileImageCleanupWorker } from '../src/auth/profile-image-cleanup.worker';
import { ProfileImageService } from '../src/auth/profile-image.service';
import { ProfileImageStorageService } from '../src/auth/profile-image-storage.service';
import { BatchService } from '../src/batch/batch.service';
import { FinalTierAssignmentJobService } from '../src/batch/final-tier-assignment-job.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { ConditionalBuyService } from '../src/conditional/conditional-buy.service';
import { ConditionalSellService } from '../src/conditional/conditional-sell.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesTpSlService } from '../src/futures/futures-tp-sl.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorUserStatusService } from '../src/operator/operator-user-status.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OrdersService } from '../src/orders/orders.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RankingService } from '../src/ranking/ranking.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.ACCOUNT_DELETION_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !(
    target.pathname.endsWith('_test') ||
    (process.env.GITHUB_ACTIONS === 'true' &&
      target.pathname === '/trading_app')
  )
)
  throw new Error(
    'Requires NODE_ENV=test, ACCOUNT_DELETION_DB_INTEGRATION=1 and a local disposable *_test DATABASE_URL.',
  );
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'false';
process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'false';

// ------------------------------------------------------------------ logging
/** Every Nest log line of the run, so the end can prove no secret leaked. */
const logs: string[] = [];
const capture = (...parts: unknown[]) =>
  void logs.push(parts.map((part) => String(part)).join(' '));
Logger.overrideLogger({
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
});
const secrets = new Set<string>();

// ------------------------------------------------------------------ services
const PASSWORD = 'Deletion-password-123!';
secrets.add(PASSWORD);
const config = new ConfigService({
  JWT_ACCESS_SECRET: 'account-deletion-integration-secret',
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
  PROFILE_IMAGE_STORAGE_ENDPOINT: 'https://storage.example.invalid',
  PROFILE_IMAGE_STORAGE_REGION: 'auto',
  PROFILE_IMAGE_STORAGE_BUCKET: 'deletion-test',
  PROFILE_IMAGE_STORAGE_ACCESS_KEY_ID: 'fixture-access-key',
  PROFILE_IMAGE_STORAGE_SECRET_ACCESS_KEY: 'fixture-secret-key',
  PROFILE_IMAGE_PUBLIC_BASE_URL: 'https://images.example.com',
});
const jwt = new JwtService();
const mail = authEmailFixture(db);
const auth = new AuthService(db, jwt, config, mail.verification);
const guard = new AccessTokenGuard(jwt, db, new Reflector(), config);

/** In-memory object storage; no S3 request is ever sent. */
const stored = new Set<string>();
const storageControl = {
  failDelete: false,
  uploadGate: null as null | { reached: () => void; released: Promise<void> },
};
const storage = new ProfileImageStorageService(config);
storage.upload = async (key: string) => {
  const gate = storageControl.uploadGate;
  if (gate) {
    storageControl.uploadGate = null;
    gate.reached();
    await gate.released;
  }
  stored.add(key);
};
storage.delete = (key: string) => {
  if (storageControl.failDelete) {
    // @diagnosticSurface internal: In-memory storage fault for the cleanup retry scenario only.
    const outage = new Error('fixture storage outage');
    outage.name = 'StorageOutage';
    return Promise.reject(outage);
  }
  stored.delete(key);
  return Promise.resolve();
};
const cleanups = new ProfileImageCleanupService(db, storage);
const profile = new ProfileImageService(db, auth, storage, cleanups);
const deletion = new AccountDeletionService(
  db,
  auth,
  mail.verification,
  storage,
  cleanups,
);
const operatorStatus = new OperatorUserStatusService(
  db,
  new OperatorAuditService(db),
);
const ranking = new RankingService(db);
const settlementJob = new SeasonSettlementJobService(
  new BatchService(db),
  db,
  new PortfolioValuationService(db),
);
const tierJob = new FinalTierAssignmentJobService(new BatchService(db), db);
const access = new TradingAccountAccessService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  new PortfolioValuationService(db),
  new GeneralExternalFundingService(db),
);
const reservation = new OrderReservationService();
const orders = new OrdersService(
  db,
  undefined,
  new LimitOrderCreateService(db, reservation),
  new LimitOrderCancelService(db, reservation),
  access,
  performance,
);
const conditionalSell = new ConditionalSellService(db, access, orders);
const conditionalBuy = new ConditionalBuyService(db, access, orders);
const futuresLimits = new FuturesLimitService(db, access, app.futures);
const futuresEntries = new FuturesConditionalEntryService(
  db,
  access,
  app.futures,
  futuresLimits,
);
const futuresTpSl = new FuturesTpSlService(db, access, app.futures);
const jpeg = readFileSync(
  join(__dirname, '../test/fixtures/profile-image.jpg'),
);
const jpegFile = () => ({
  buffer: jpeg,
  size: jpeg.length,
  mimetype: 'image/jpeg',
});

// ------------------------------------------------------------------ helpers
let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS AccountDeletion ${label}`);
}
function codeOf(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string'
      ? body.error.code
      : `HTTP_${error.getStatus()}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message.split('\n')[0].slice(0, 160)}`
    : String(error);
}
async function rejects(work: Promise<unknown>, expected: string) {
  let observed = 'RESOLVED';
  try {
    await work;
  } catch (error) {
    observed = codeOf(error);
  }
  assert.equal(observed, expected);
}
async function settled<T>(work: Promise<T>) {
  try {
    return { ok: true as const, value: await work };
  } catch (error) {
    return { ok: false as const, code: codeOf(error) };
  }
}

const ips = new Set<string>();
/** A fresh client address per call keeps the shared IP budgets out of the
 * way; the rate limit itself is covered by the auth email suite. */
function meta() {
  const hex = () => randomBytes(2).toString('hex');
  const ipAddress = `2001:db8:${hex()}:${hex()}::${hex()}`;
  ips.add(ipAddress);
  return { ipAddress, userAgent: 'account-deletion-integration' };
}
const requestKeys: string[] = [];
const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
function requestKey() {
  const key = randomBytes(32).toString('base64url');
  requestKeys.push(key);
  secrets.add(key);
  return key;
}
async function allowed(token: string) {
  return guard.canActivate({
    getHandler: () => function protectedRoute() {},
    getClass: () => class Protected {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
    }),
  } as unknown as ExecutionContext);
}
async function lockWaiters(): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row.waiting;
}
async function untilLockWaiting() {
  const started = performance_now();
  while ((await lockWaiters()) === 0) {
    assert.ok(performance_now() - started < 8_000, 'no lock wait observed');
    await delay(15);
  }
}
const performance_now = () => Number(process.hrtime.bigint() / 1_000_000n);
function gate() {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return { reached, reachedPromise, released, release };
}
/** Pauses `host[method]` once, right AFTER the real call returned. */
function pauseAfter(host: object, method: string) {
  const methods = host as Record<
    string,
    (this: unknown, ...args: unknown[]) => Promise<unknown>
  >;
  const original = methods[method];
  assert.equal(typeof original, 'function', `${method} is not patchable`);
  const barrier = gate();
  let fired = false;
  methods[method] = async function (this: unknown, ...args: unknown[]) {
    const result: unknown = await original.apply(this, args);
    if (!fired) {
      fired = true;
      barrier.reached();
      await barrier.released;
    }
    return result;
  };
  return {
    reached: barrier.reachedPromise,
    release: barrier.release,
    restore: () => (methods[method] = original),
  };
}
/** A client whose interactive transactions pause once right AFTER
 * `tx[model][operation]` returned. */
function pausingClient(root: PrismaService, model: string, operation: string) {
  const barrier = gate();
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
                barrier.reached();
                await barrier.released;
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
  return {
    client,
    reached: barrier.reachedPromise,
    release: barrier.release,
  };
}
function deletionWith(client: PrismaService) {
  return new AccountDeletionService(
    client,
    auth,
    mail.verification,
    storage,
    new ProfileImageCleanupService(client, storage),
  );
}

// ------------------------------------------------------------------ fixtures
type Member = { userId: string; email: string; nickname: string };
const created = {
  users: new Set<string>(),
  seasons: new Set<string>(),
  batchKeys: new Set<string>(),
  instruments: [] as Scenario['instruments'],
  badges: new Set<string>(),
  emails: new Set<string>(),
  learning: [] as Array<{ assetIds: string[]; rateIds: string[] }>,
};

async function member(
  label: string,
  role: 'user' | 'operator' | 'admin' = 'user',
): Promise<Member> {
  const email = `del-${label}-${randomUUID()}@example.com`;
  const user = await db.user.create({
    data: {
      email,
      nickname: `del-${label}-${randomUUID().slice(0, 8)}`,
      passwordHash: await argon2.hash(PASSWORD),
      role,
    },
    select: { id: true, email: true, nickname: true },
  });
  created.users.add(user.id);
  created.emails.add(email);
  return { userId: user.id, email: user.email, nickname: user.nickname };
}
/** F1 fixture users carry a non-Argon2 test hash; give them a password. */
async function adopt(s: Scenario, label: string): Promise<Member> {
  const email = `del-${label}-${randomUUID()}@example.com`;
  const user = await db.user.update({
    where: { id: s.userId },
    data: { email, passwordHash: await argon2.hash(PASSWORD) },
    select: { id: true, email: true, nickname: true },
  });
  created.users.add(user.id);
  created.emails.add(email);
  created.instruments.push(...s.instruments);
  return { userId: user.id, email: user.email, nickname: user.nickname };
}
async function login(m: Member) {
  const response = await auth.login(
    { email: m.email, password: PASSWORD },
    meta(),
  );
  secrets.add(response.data.tokens.accessToken);
  secrets.add(response.data.tokens.refreshToken);
  return response.data.tokens;
}
async function fresh(s: Scenario, index: number, value = '100') {
  await lastPrice(s, value, index, 0);
  const at = await now();
  await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: s.instruments[index].instrument.id,
      symbol: s.instruments[index].asset.symbol,
      price: value,
      source: 'binance_usdm_mark_ws',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

type SeasonSeat = { member: Member; accountId: string; participantId: string };
async function seasonWith(
  status: 'active' | 'ended',
  members: Member[],
  krw: string[],
) {
  const clock = await now();
  const day = 86_400_000;
  const startAt = new Date(clock.getTime() - 30 * day);
  const endAt =
    status === 'ended'
      ? new Date(clock.getTime() - 3_600_000)
      : new Date(clock.getTime() + day);
  const season = await db.season.create({
    data: {
      name: `del-${randomUUID()}`,
      status,
      startAt,
      endAt,
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  created.seasons.add(season.id);
  const seats: SeasonSeat[] = [];
  for (const [index, m] of members.entries()) {
    const account = await db.tradingAccount.create({
      data: {
        userId: m.userId,
        mode: 'season',
        status: 'active',
        initialCapitalKrw: '1000000',
        openedAt: startAt,
      },
    });
    const participant = await db.seasonParticipant.create({
      data: {
        userId: m.userId,
        seasonId: season.id,
        tradingAccountId: account.id,
        participantStatus: 'active',
        joinedAt: startAt,
        initialCapitalKrw: '1000000',
        totalAssetKrw: krw[index],
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: account.id,
          currencyCode: 'KRW',
          balanceAmount: krw[index],
        },
        {
          tradingAccountId: account.id,
          currencyCode: 'USD',
          balanceAmount: '0',
        },
        ...zeroCryptoCashWalletData(account.id),
      ],
    });
    seats.push({
      member: m,
      accountId: account.id,
      participantId: participant.id,
    });
  }
  return { seasonId: season.id, endAt, seats };
}
async function dailyRows(
  seasonId: string,
  seats: SeasonSeat[],
  krw: string[],
  daysAgo: number,
) {
  const clock = await now();
  const day = new Date(clock.getTime() - daysAgo * 86_400_000);
  await db.seasonRanking.createMany({
    data: seats.map((seat, index) => ({
      seasonId,
      seasonParticipantId: seat.participantId,
      tradingAccountId: seat.accountId,
      rankType: 'daily' as const,
      rank: index + 1,
      totalAssetKrw: krw[index],
      returnRate: '0',
      rankingDate: new Date(`${dateOnly(day)}T00:00:00.000Z`),
      capturedAt: day,
    })),
  });
}
async function settle(seasonId: string, endAt: Date) {
  const idempotencyKey = `account-deletion:${seasonId}:${randomUUID()}`;
  created.batchKeys.add(idempotencyKey);
  return settlementJob.run({
    seasonId,
    settlementDate: dateOnly(endAt),
    idempotencyKey,
    requestedBy: 'account-deletion-integration',
  });
}
async function finalBoard(viewer: Member, seasonId: string) {
  const response = await ranking.getRanking(viewer.userId, {
    seasonId,
    rankType: 'final',
    limit: '50',
  });
  const data = response.data as unknown as {
    rankings: Array<Record<string, unknown>>;
    pagination?: { total?: number };
  };
  return {
    total: data.pagination?.total ?? null,
    rows: data.rankings.map((row) => ({
      rank: row.rank,
      userId: row.userId,
      nickname: row.nickname,
      profileImageUrl: row.profileImageUrl,
      totalAssetKrw: row.totalAssetKrw,
      returnRate: row.returnRate,
      percentile: row.percentile,
      finalTier: row.finalTier,
      totalFillCount: row.totalFillCount,
      maxDrawdown: row.maxDrawdown,
    })),
  };
}

/** Every row the member could own, by table (all must reach zero). */
async function ownedRowCounts(ids: {
  userId: string;
  email: string;
  accountIds: string[];
  participantIds: string[];
}) {
  const u = ids.userId;
  const a = ids.accountIds;
  const p = ids.participantIds;
  const byAccount = [
    'beginner_quest_acknowledgements',
    'entry_tp_sl_plans',
    'futures_tp_sl_settings',
    'conditional_sell_orders',
    'conditional_buy_orders',
    'futures_conditional_entries',
    'protection_groups',
    'protection_commands',
    'limit_on_close_orders',
    'futures_execute_requests',
    'futures_limit_orders',
    'futures_liquidation_closes',
    'futures_liquidations',
    'futures_season_closes',
    'futures_season_settlements',
    'futures_executions',
    'futures_positions',
    'wallet_transfer_execute_requests',
    'wallet_transfers',
    'fx_execute_requests',
    'general_account_resets',
    'ad_reward_claims',
    'wallet_transactions',
    'exchange_transactions',
    'orders',
    'quotes',
    'positions',
    'cash_wallets',
    'equity_snapshots',
    'daily_portfolio_snapshots',
    'season_rankings',
    'push_notifications',
  ];
  const byUser = [
    'trading_accounts',
    'season_participants',
    'quotes',
    'fx_execute_requests',
    'general_account_resets',
    'ad_reward_claims',
    'season_rewards',
    'reward_fulfillment_requests',
    'user_badges',
    'inquiries',
    'push_devices',
    'push_notifications',
    'notification_preferences',
    'refresh_token_sessions',
  ];
  const counts: Record<string, number> = {};
  for (const table of byAccount) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE trading_account_id = ANY($1)`,
      a,
    );
    counts[`${table}:account`] = row.n;
  }
  for (const table of byUser) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE user_id = $1`,
      u,
    );
    counts[`${table}:user`] = row.n;
  }
  const [other] = await db.$queryRaw<
    Array<{
      users: number;
      friendships: number;
      friendPushes: number;
      rankings: number;
      rewards: number;
      fulfillments: number;
      challenges: number;
      cleanups: number;
      answers: number;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM users WHERE id = ${u} OR email = ${ids.email}) AS users,
      (SELECT count(*)::int FROM friendships WHERE low_user_id = ${u} OR high_user_id = ${u} OR requester_user_id = ${u}) AS friendships,
      (SELECT count(*)::int FROM push_notifications WHERE starts_with(source_key, ${`friend:${u}:`})) AS "friendPushes",
      (SELECT count(*)::int FROM season_rankings WHERE season_participant_id = ANY(${p})) AS rankings,
      (SELECT count(*)::int FROM season_rewards WHERE season_participant_id = ANY(${p})) AS rewards,
      (SELECT count(*)::int FROM reward_fulfillment_requests WHERE season_participant_id = ANY(${p})) AS fulfillments,
      (SELECT count(*)::int FROM email_auth_challenges WHERE email = ${ids.email} OR target_user_id = ${u}) AS challenges,
      (SELECT count(*)::int FROM profile_image_cleanups WHERE starts_with(object_key, ${`profile-images/${u}/`})) AS cleanups,
      (SELECT count(*)::int FROM inquiry_answers a JOIN inquiries i ON i.id = a.inquiry_id WHERE i.user_id = ${u}) AS answers`;
  return { ...counts, ...other };
}
async function scopeOf(m: Member) {
  const accounts = await db.tradingAccount.findMany({
    where: { userId: m.userId },
    select: { id: true },
  });
  const participants = await db.seasonParticipant.findMany({
    where: { userId: m.userId },
    select: { id: true },
  });
  return {
    userId: m.userId,
    email: m.email,
    accountIds: accounts.map((row) => row.id),
    participantIds: participants.map((row) => row.id),
  };
}
async function assertGone(scope: Awaited<ReturnType<typeof scopeOf>>) {
  const counts = await ownedRowCounts(scope);
  const left = Object.entries(counts).filter(([, n]) => n !== 0);
  assert.deepEqual(
    left,
    [],
    `rows survived the deletion: ${JSON.stringify(left)}`,
  );
}

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint'
      ? item.toString()
      : item instanceof Prisma.Decimal
        ? item.toFixed()
        : item,
  );
/** Byte-for-byte state of other members (and of shared market data). */
async function othersState(others: Member[], deleted: Member[]) {
  const userIds = others.map((m) => m.userId);
  const accounts = await db.tradingAccount.findMany({
    where: { userId: { in: userIds } },
    orderBy: { id: 'asc' },
  });
  const accountIds = accounts.map((row) => row.id);
  const where = { tradingAccountId: { in: accountIds } };
  const deletedFriendKeys = deleted.map((m) => `friend:${m.userId}:`);
  const pushes = (
    await db.pushNotification.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
    })
  ).filter(
    (row) => !deletedFriendKeys.some((k) => row.sourceKey.startsWith(k)),
  );
  return json({
    users: await db.user.findMany({
      where: { id: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    accounts,
    participants: await db.seasonParticipant.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    rankings: await db.seasonRanking.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    wallets: await db.cashWallet.findMany({ where, orderBy: { id: 'asc' } }),
    ledger: await db.walletTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    orders: await db.order.findMany({ where, orderBy: { id: 'asc' } }),
    positions: await db.position.findMany({ where, orderBy: { id: 'asc' } }),
    futures: await db.futuresPosition.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    executions: await db.futuresExecution.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    equity: await db.equitySnapshot.findMany({ where, orderBy: { id: 'asc' } }),
    rewards: await db.seasonReward.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    friendships: await db.friendship.findMany({
      where: { lowUserId: { in: userIds }, highUserId: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    inquiries: await db.inquiry.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
      include: { answer: true },
    }),
    sessions: await db.refreshTokenSession.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    pushes,
    shared: await sharedState(),
  });
}
/** Bounded structural diff: never prints whole states (AGENTS.md test rule). */
function changedPaths(a: unknown, b: unknown, path = '', out: string[] = []) {
  if (out.length >= 12) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '$'} (type)`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      out.push(`${path} (length ${a.length} vs ${b.length})`);
    else a.forEach((item, i) => changedPaths(item, b[i], `${path}[${i}]`, out));
  } else if (a && b && typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      changedPaths(left[key], right[key], `${path}.${key}`, out);
  } else if (a !== b) out.push(path || '$');
  return out;
}
function assertSameState(actual: string, expected: string, label: string) {
  const same = actual === expected;
  if (!same)
    assert.fail(
      `${label}: changed at ${changedPaths(JSON.parse(actual), JSON.parse(expected)).join(', ')}`,
    );
}
async function sharedState() {
  const [row] = await db.$queryRaw<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::int FROM assets) AS assets,
      (SELECT count(*)::int FROM asset_price_snapshots) AS prices,
      (SELECT count(*)::int FROM futures_instruments) AS instruments,
      (SELECT count(*)::int FROM futures_last_price_snapshots) AS lasts,
      (SELECT count(*)::int FROM futures_mark_snapshots) AS marks,
      (SELECT count(*)::int FROM fx_rate_snapshots) AS fx,
      (SELECT count(*)::int FROM seasons) AS seasons,
      (SELECT count(*)::int FROM badges) AS badges,
      (SELECT count(*)::int FROM limit_order_candle_evidences) AS evidence,
      (SELECT count(*)::int FROM futures_season_prices) AS season_prices`;
  return row;
}

// ------------------------------------------------------------------ commands
async function deleteInApp(m: Member, key = requestKey(), service = deletion) {
  return service.deleteFromApp(
    m.userId,
    { password: PASSWORD, requestKey: key, confirm: true },
    meta(),
  );
}
async function deletionProof(email: string) {
  // Same-email sends are ≥60 s apart in production; age the previous ones.
  await db.emailAuthChallenge.updateMany({
    where: { email },
    data: { createdAt: new Date(Date.now() - 61 * 60_000) },
  });
  const proof = await mail.proof(email, 'account_deletion');
  secrets.add(proof);
  return proof;
}

// ------------------------------------------------------------------ scenarios

/** One member with every kind of row the purge removes, beside three other
 * members whose data must stay identical. */
async function fullMember() {
  const s = await fixture('general', '10000');
  const u = await adopt(s, 'full');
  const v = await member('v');
  const w = await member('w');
  const operator = await member('op', 'operator');
  const otherTrader = await adopt(await fixture('general', '10000'), 'x');
  await fxEvidence();

  // --- Futures (general account): position + TP/SL, limit entry + plan,
  // conditional entry. A third instrument keeps one pending entry each.
  s.instruments.push(await newInstrument());
  created.instruments.push(s.instruments[2]);
  await fresh(s, 0);
  const opened = await app.futures.execute(u.userId, s.accountId, {
    instrumentId: s.instruments[0].instrument.id,
    operation: 'open',
    direction: 'long',
    quantity: '1',
    leverage: 5,
    idempotencyKey: randomUUID(),
  });
  await futuresTpSl.create(u.userId, s.accountId, {
    positionId: opened.data.position.id,
    idempotencyKey: randomUUID(),
    stopLoss: { triggerPrice: '80', quantity: '1' },
  });
  await fresh(s, 1);
  await futuresLimits.create(u.userId, s.accountId, {
    instrumentId: s.instruments[1].instrument.id,
    direction: 'long',
    marginMode: 'isolated',
    quantity: '1',
    leverage: 5,
    limitPrice: '50',
    idempotencyKey: randomUUID(),
    entryTpSl: [{ kind: 'stop_loss', triggerPrice: '40', ratio: 100 }],
  });
  await fresh(s, 2);
  await futuresEntries.create(u.userId, s.accountId, {
    instrumentId: s.instruments[2].instrument.id,
    direction: 'long',
    marginMode: 'isolated',
    leverage: 5,
    quantity: '1',
    triggerCondition: 'at_or_below',
    triggerPrice: '50',
    executionType: 'market',
    idempotencyKey: randomUUID(),
  });

  // --- Spot: pending limit BUY (reserved cash + plan + LOC row), holding
  // with an independent stop-loss, conditional BUY watch.
  await spotPrice(s, '100', 0, 0);
  const payload = {
    assetId: s.instruments[0].asset.id,
    side: 'buy' as const,
    orderType: 'limit' as const,
    amount: '10',
    limitPrice: '50',
  };
  const quoted = await orders.quoteOrderForTradingAccount(
    u.userId,
    s.accountId,
    payload,
  );
  const limitOrder = await orders.createOrderForTradingAccount(
    u.userId,
    s.accountId,
    {
      ...payload,
      quoteId: quoted.data.quoteId,
      idempotencyKey: randomUUID(),
      entryTpSl: [{ kind: 'stop_loss', triggerPrice: '40', ratio: 100 }],
    },
  );
  const clock = await now();
  await db.limitOnCloseOrder.create({
    data: {
      orderId: limitOrder.data.order.orderId,
      tradingAccountId: s.accountId,
      assetId: s.instruments[0].asset.id,
      market: 'US',
      sessionDate: new Date(`${dateOnly(clock)}T00:00:00.000Z`),
      sessionOpenAt: new Date(clock.getTime() + 3_600_000),
      sessionCloseAt: new Date(clock.getTime() + 7_200_000),
      evidenceDeadlineAt: new Date(clock.getTime() + 10_800_000),
    },
  });
  await db.position.create({
    data: {
      tradingAccountId: s.accountId,
      assetId: s.instruments[0].asset.id,
      quantity: '2',
      averageCost: '100',
      currencyCode: 'USD',
    },
  });
  await conditionalSell.create(u.userId, s.accountId, {
    kind: 'protection',
    assetId: s.instruments[0].asset.id,
    stopLoss: { triggerPrice: '80', executionType: 'market', quantity: '2' },
    idempotencyKey: randomUUID(),
  });
  await conditionalBuy.create(u.userId, s.accountId, {
    assetId: s.instruments[0].asset.id,
    triggerCondition: 'at_or_below',
    triggerPrice: '95',
    executionType: 'market',
    amount: '10',
    idempotencyKey: randomUUID(),
  });

  // --- Cash: internal transfer and a composite FX transfer.
  await app.transfer.transfer(u.userId, s.accountId, {
    sourceWalletId: s.spotWalletId,
    destinationWalletId: s.futuresWalletId,
    amount: '10',
    idempotencyKey: randomUUID(),
  });
  await fxEvidence();
  const fxQuote = await app.composite.quote(u.userId, s.accountId, {
    sourceWalletId: s.futuresWalletId,
    destinationWalletId: s.krwWalletId,
    amount: '5',
  });
  await app.composite.execute(u.userId, s.accountId, {
    quoteId: fxQuote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
  await db.protectionCommand.create({
    data: {
      tradingAccountId: s.accountId,
      idempotencyKey: randomUUID(),
      requestHash: 'fixture',
      responsePayloadJson: {},
    },
  });
  await db.adRewardClaim.create({
    data: {
      userId: u.userId,
      tradingAccountId: s.accountId,
      provider: 'fixture',
      providerEventId: randomUUID(),
      status: 'rejected',
      rewardAmountKrw: '1000',
      requestedAt: clock,
      rejectedAt: clock,
    },
  });
  await db.dailyPortfolioSnapshot.create({
    data: {
      tradingAccountId: s.accountId,
      snapshotDate: new Date(`${dateOnly(clock)}T00:00:00.000Z`),
      totalAssetKrw: '10000000',
      returnRate: '0',
      krwCash: '10000000',
      usdCashKrw: '0',
      assetValueKrw: '0',
      realizedPnlKrw: '0',
      unrealizedPnlKrw: '0',
      capturedAt: clock,
    },
  });

  // --- A second (beginner) account.
  await app.general.openBeginnerAccount(u.userId);

  // --- Active season with history, and a settled season (real settlement):
  // the member ranks 2nd of 3 in both.
  const active = await seasonWith(
    'active',
    [v, u, w],
    ['1300000', '1200000', '1100000'],
  );
  await dailyRows(
    active.seasonId,
    active.seats,
    ['1300000', '1200000', '1100000'],
    1,
  );
  const closed = await seasonWith(
    'ended',
    [v, u, w],
    ['1300000', '1200000', '1100000'],
  );
  await dailyRows(
    closed.seasonId,
    closed.seats,
    ['1300000', '1200000', '1100000'],
    2,
  );
  await settle(closed.seasonId, closed.endAt);
  const badge = await db.badge.create({
    data: {
      badgeType: 'tier_badge',
      code: `del-${randomUUID()}`,
      name: 'fixture',
    },
  });
  created.badges.add(badge.id);
  const uSeat = closed.seats[1];
  await db.userBadge.create({
    data: {
      userId: u.userId,
      badgeId: badge.id,
      seasonId: closed.seasonId,
      awardedAt: clock,
    },
  });
  const fulfillment = await db.rewardFulfillmentRequest.create({
    data: {
      seasonId: closed.seasonId,
      seasonParticipantId: uSeat.participantId,
      userId: u.userId,
      rewardType: 'internal',
      rewardCode: 'fixture',
      rewardName: 'fixture reward',
      status: 'fulfilled',
      idempotencyKey: randomUUID(),
      requestHash: 'fixture',
      requestedByUserId: operator.userId,
      fulfilledAt: clock,
    },
  });
  await db.seasonReward.create({
    data: {
      seasonId: closed.seasonId,
      seasonParticipantId: uSeat.participantId,
      userId: u.userId,
      rewardType: 'internal',
      rewardCode: 'fixture',
      rewardName: 'fixture reward',
      fulfillmentRequestId: fulfillment.id,
      grantedAt: clock,
    },
  });

  // --- Social, support, push, sessions, email, profile image.
  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);
  const [lowV, highV] = pair(u.userId, v.userId);
  await db.friendship.create({
    data: {
      lowUserId: lowV,
      highUserId: highV,
      requesterUserId: v.userId,
      status: 'accepted',
    },
  });
  const [lowW, highW] = pair(u.userId, w.userId);
  const pending = await db.friendship.create({
    data: { lowUserId: lowW, highUserId: highW, requesterUserId: u.userId },
  });
  const [lowVW, highVW] = pair(v.userId, w.userId);
  const vwFriendship = await db.friendship.create({
    data: { lowUserId: lowVW, highUserId: highVW, requesterUserId: v.userId },
  });
  const push = (
    userId: string,
    type: 'friend_request' | 'trade_fill',
    sourceKey: string,
    body: string,
  ) =>
    db.pushNotification.create({
      data: {
        userId,
        type,
        sourceKey,
        title: type === 'friend_request' ? '친구 요청' : '체결',
        body,
        data: { v: 1, type, uid: userId },
        eventAt: clock,
        expiresAt: new Date(clock.getTime() + 86_400_000),
        nextAttemptAt: clock,
      },
    });
  await push(
    w.userId,
    'friend_request',
    `friend:${u.userId}:${pending.id}`,
    `${u.nickname}님이 친구 요청을 보냈어요.`,
  );
  await push(
    w.userId,
    'friend_request',
    `friend:${v.userId}:${vwFriendship.id}`,
    `${v.nickname}님이 친구 요청을 보냈어요.`,
  );
  await push(u.userId, 'trade_fill', `order:${randomUUID()}`, 'fixture');
  const inquiry = await db.inquiry.create({
    data: {
      userId: u.userId,
      clientRequestId: randomUUID(),
      category: 'account',
      title: '문의',
      content: '개인정보가 담긴 문의',
    },
  });
  await db.inquiryAnswer.create({
    data: {
      inquiryId: inquiry.id,
      answeredByUserId: operator.userId,
      idempotencyKey: randomUUID(),
      content: '답변',
    },
  });
  await db.pushDevice.create({
    data: {
      userId: u.userId,
      token: `ExponentPushToken[${randomUUID()}]`,
      platform: 'android',
      registeredAt: clock,
    },
  });
  await db.notificationPreference.create({
    data: { userId: u.userId, tradeFill: false },
  });
  const tokens = await login(u);
  await login(u);
  await mail.verification.request(
    { email: u.email, purpose: 'password_reset' },
    meta(),
  );
  await profile.upload(u.userId, jpegFile());
  await profile.upload(u.userId, jpegFile());
  const photo = await db.user.findUniqueOrThrow({
    where: { id: u.userId },
    select: { profileImageUrl: true },
  });
  const photoKey = storage.managedKey(photo.profileImageUrl, u.userId)!;
  assert.ok(stored.has(photoKey));
  assert.equal(stored.size >= 1, true);
  assert.equal(
    [...stored].filter((key) => key.includes(u.userId)).length,
    1,
    'the replaced photo was removed right after the swap',
  );
  pass('full member fixture covers every account-scoped domain');

  // --- Baselines.
  const others = [v, w, operator, otherTrader];
  const before = await othersState(others, [u]);
  const boardBefore = await finalBoard(v, closed.seasonId);
  assert.equal(boardBefore.rows.length, 3);
  const auditBefore = await auditRankingAndSettlement(db);
  const scope = await scopeOf(u);
  assert.equal(scope.accountIds.length, 4);

  // --- Deletion through the app flow.
  await rejects(
    deletion.checkPassword(u.userId, { password: 'wrong-password' }, meta()),
    'ACCOUNT_DELETION_PASSWORD_MISMATCH',
  );
  const checked = await deletion.checkPassword(
    u.userId,
    { password: PASSWORD },
    meta(),
  );
  assert.equal(checked.data.verified, true);
  assertSameState(await othersState(others, [u]), before, 'others');
  const result = await deleteInApp(u);
  assert.equal(result.data.deletion.status, 'completed');
  assert.ok(result.data.deletion.completedAt);
  assert.equal(stored.has(photoKey), false, 'profile image object removed');
  await assertGone(scope);
  pass(
    'app deletion removes every personal and virtual-trading row in one commit',
  );

  assertSameState(await othersState(others, [u]), before, 'others');
  pass('other members, shared market data and seasons are unchanged');

  const boardAfter = await finalBoard(v, closed.seasonId);
  assert.equal(boardAfter.rows.length, 3);
  assert.equal(boardAfter.total, boardBefore.total);
  for (const [index, row] of boardAfter.rows.entries()) {
    const was = boardBefore.rows[index];
    if (was.userId === u.userId) {
      assert.notEqual(row.userId, u.userId);
      assert.ok(
        String(row.nickname).startsWith(ACCOUNT_DELETION_PLACEHOLDER_NICKNAME),
      );
      assert.equal(row.profileImageUrl, null);
      for (const field of [
        'rank',
        'totalAssetKrw',
        'returnRate',
        'percentile',
        'finalTier',
        'totalFillCount',
        'maxDrawdown',
      ] as const)
        assert.deepEqual(row[field], was[field], `placeholder ${field}`);
    } else assert.deepEqual(row, was);
  }
  const placeholder = await db.user.findUniqueOrThrow({
    where: { id: String(boardAfter.rows[1].userId) },
    include: { tradingAccounts: true, seasonParticipants: true },
  });
  assert.ok(isAccountDeletionPlaceholderEmail(placeholder.email));
  assert.equal(placeholder.status, 'deleted');
  assert.equal(placeholder.profileImageUrl, null);
  assert.equal(placeholder.tradingAccounts.length, 1);
  assert.equal(placeholder.tradingAccounts[0].status, 'closed');
  assert.equal(placeholder.seasonParticipants.length, 1);
  assert.equal(
    await db.seasonRanking.count({
      where: { seasonParticipantId: placeholder.seasonParticipants[0].id },
    }),
    1,
    'only the final row is preserved',
  );
  assert.equal(
    await db.cashWallet.count({
      where: { tradingAccountId: placeholder.tradingAccounts[0].id },
    }),
    0,
  );
  assert.equal(
    await auth.verifyPassword(placeholder.passwordHash, PASSWORD),
    false,
  );
  pass(
    'settled final result is kept unchanged under an unlinkable anonymous placeholder',
  );

  // Settled-season checks that would re-derive or reject a changed set.
  const auditAfter = await auditRankingAndSettlement(db);
  const finalCodes = (findings: typeof auditAfter) =>
    findings
      .filter((f) => f.code !== 'SEASON_RANKING_RANK_SEQUENCE_BROKEN')
      .map((f) => `${f.code}:${f.count}`)
      .sort();
  assert.deepEqual(finalCodes(auditAfter), finalCodes(auditBefore));
  const gaps = (findings: typeof auditAfter) =>
    findings.find((f) => f.code === 'SEASON_RANKING_RANK_SEQUENCE_BROKEN')
      ?.count ?? 0;
  // Provisional daily sets of both seasons lose the member's row (rank 2 of 3).
  assert.equal(gaps(auditAfter) - gaps(auditBefore), 2);
  const replayKey = `account-deletion:replay:${randomUUID()}`;
  created.batchKeys.add(replayKey);
  await settlementJob.run({
    seasonId: closed.seasonId,
    settlementDate: dateOnly(closed.endAt),
    idempotencyKey: replayKey,
    requestedBy: 'account-deletion-integration',
  });
  const tierKey = `account-deletion:tier:${randomUUID()}`;
  created.batchKeys.add(tierKey);
  const finalRow = await db.seasonRanking.findFirstOrThrow({
    where: { seasonId: closed.seasonId, rankType: 'final' },
    select: { rankingDate: true },
  });
  await tierJob.run({
    seasonId: closed.seasonId,
    rankingDate: dateOnly(finalRow.rankingDate),
    idempotencyKey: tierKey,
    requestedBy: 'account-deletion-integration',
  });
  assert.deepEqual(await finalBoard(v, closed.seasonId), boardAfter);
  // The replay rewrites the same result values into participant rows, which
  // only moves their @updatedAt; every value must be the confirmed one.
  const replayed = (state: string) => {
    const parsed = JSON.parse(state) as {
      participants: Array<Record<string, unknown>>;
    };
    for (const row of parsed.participants) delete row.updatedAt;
    return JSON.stringify(parsed);
  };
  assertSameState(
    replayed(await othersState(others, [u])),
    replayed(before),
    'others after replay',
  );
  pass(
    'settlement replay and final tier job keep every confirmed rank and tier',
  );

  // Old credentials and the admin restore path.
  await rejects(allowed(tokens.accessToken), 'UNAUTHORIZED');
  await rejects(
    auth.refresh({ refreshToken: tokens.refreshToken }, meta()),
    'INVALID_REFRESH_TOKEN',
  );
  await rejects(
    auth.login({ email: u.email, password: PASSWORD }, meta()),
    'INVALID_CREDENTIALS',
  );
  const admin = await member('admin', 'admin');
  const actor = { userId: admin.userId, role: 'admin' as const };
  await rejects(
    operatorStatus.restoreUser(actor, u.userId, { reason: 'restore attempt' }),
    'TARGET_USER_NOT_FOUND',
  );
  await rejects(
    operatorStatus.restoreUser(actor, placeholder.id, {
      reason: 'restore attempt',
    }),
    'USER_RESTORE_NOT_ALLOWED',
  );
  await rejects(
    auth.login({ email: placeholder.email, password: PASSWORD }, meta()),
    'INVALID_CREDENTIALS',
  );
  pass('old tokens, login and admin restore cannot bring the account back');

  // The trading services refuse the deleted account and write nothing.
  const writes = await sharedState();
  await rejects(
    app.futures.execute(u.userId, s.accountId, {
      instrumentId: s.instruments[0].instrument.id,
      operation: 'open',
      direction: 'long',
      quantity: '1',
      leverage: 5,
      idempotencyKey: randomUUID(),
    }),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  assert.deepEqual(await sharedState(), writes);
  await assertGone(scope);
  pass('a late trading command for the deleted account fails without writes');

  // Same email signs up again as a brand-new member.
  const proof = await mail.proof(u.email, 'signup');
  const again = await auth.signup(
    {
      email: u.email,
      password: PASSWORD,
      nickname: u.nickname,
      verificationToken: proof,
      ageConfirmed: true,
      termsVersion: CURRENT_TERMS_VERSION,
    },
    meta(),
  );
  created.users.add(again.data.user.id);
  assert.notEqual(again.data.user.id, u.userId);
  assert.equal(
    await db.tradingAccount.count({ where: { userId: again.data.user.id } }),
    0,
  );
  assert.equal(
    await db.seasonParticipant.count({ where: { userId: again.data.user.id } }),
    0,
  );
  assert.equal(
    await db.friendship.count({
      where: {
        OR: [
          { lowUserId: again.data.user.id },
          { highUserId: again.data.user.id },
        ],
      },
    }),
    0,
  );
  pass(
    'the same email and nickname re-register as a new member with nothing restored',
  );
}

/** No trading account, beginner-only and several kinds of refusal. */
async function memberKindsAndRefusals() {
  // No trading account at all, deleted from the web.
  const plain = await member('plain');
  await login(plain);
  const scope = await scopeOf(plain);
  assert.equal(scope.accountIds.length, 0);
  const proof = await deletionProof(plain.email);
  const web = await deletion.deleteFromWeb(
    {
      email: plain.email,
      verificationToken: proof,
      requestKey: requestKey(),
      confirm: true,
    },
    meta(),
  );
  assert.equal(web.data.deletion.status, 'completed');
  await assertGone(scope);
  pass('a member without trading accounts is deleted from the web flow');

  // Beginner (learned: real quest orders and acknowledgements).
  const b = await fixture('beginner', '10000');
  const beginner = await adopt(b, 'beginner');
  assert.ok(
    (await db.beginnerQuestAcknowledgement.count({
      where: { tradingAccountId: b.accountId },
    })) > 0,
  );
  const beginnerScope = await scopeOf(beginner);
  // Shared learning market data stays; this run removes it at the end.
  created.learning.push({
    assetIds: (
      await db.asset.findMany({
        where: { name: `learning-fixture:${b.accountId}` },
        select: { id: true },
      })
    ).map((row) => row.id),
    rateIds: (
      await db.exchangeTransaction.findMany({
        where: { tradingAccountId: b.accountId },
        select: { fxRateSnapshotId: true },
      })
    )
      .map((row) => row.fxRateSnapshotId)
      .filter((id): id is string => !!id),
  });
  await deleteInApp(beginner);
  await assertGone(beginnerScope);
  pass('a beginner account with quest acknowledgements is deleted');

  // Refusals change nothing.
  const victim = await member('refused');
  const tokens = await login(victim);
  const state = async () => othersState([victim], []);
  const before = await state();
  const refusedKeys = [requestKey(), requestKey()];
  await rejects(
    deletion.deleteFromApp(
      victim.userId,
      { password: 'nope-nope-nope', requestKey: refusedKeys[0], confirm: true },
      meta(),
    ),
    'ACCOUNT_DELETION_PASSWORD_MISMATCH',
  );
  await rejects(
    deletion.deleteFromApp(
      victim.userId,
      { password: PASSWORD, requestKey: refusedKeys[1] },
      meta(),
    ),
    'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
  );
  await rejects(
    deletion.deleteFromApp(
      victim.userId,
      { password: PASSWORD, requestKey: 'short', confirm: true },
      meta(),
    ),
    'ACCOUNT_DELETION_REQUEST_KEY_INVALID',
  );
  await rejects(
    deletion.deleteFromApp(
      undefined,
      { password: PASSWORD, requestKey: requestKey(), confirm: true },
      meta(),
    ),
    'UNAUTHORIZED',
  );
  assertSameState(await state(), before, 'refused member');
  assert.equal(await allowed(tokens.accessToken), true);
  assert.equal(
    await db.accountDeletion.count({
      where: { requestKeyHash: { in: refusedKeys.map(hashOf) } },
    }),
    0,
  );
  pass('wrong password, missing confirmation or key change nothing');

  const op = await member('operator', 'operator');
  await rejects(deleteInApp(op), 'ACCOUNT_DELETION_ROLE_RESTRICTED');
  await rejects(
    deletion.checkPassword(op.userId, { password: PASSWORD }, meta()),
    'ACCOUNT_DELETION_ROLE_RESTRICTED',
  );
  const former = await member('former-operator');
  await db.operatorAuditLog.create({
    data: {
      actorUserId: former.userId,
      actorRole: 'operator',
      action: 'fixture',
      result: 'success',
    },
  });
  await rejects(deleteInApp(former), 'ACCOUNT_DELETION_REQUIRES_SUPPORT');
  const suspended = await member('suspended');
  await db.user.update({
    where: { id: suspended.userId },
    data: { status: 'suspended' },
  });
  await rejects(deleteInApp(suspended), 'USER_NOT_ACTIVE');
  assert.equal(
    await db.user.count({
      where: { id: { in: [op.userId, former.userId, suspended.userId] } },
    }),
    3,
  );
  pass('operators, former operators and inactive members are refused');
}

/** Web request flow: purpose separation, enumeration, expiry and replay. */
async function webFlow() {
  const owner = await member('web-owner');
  const attacker = await member('web-attacker');
  const unknown = `del-unknown-${randomUUID()}@example.com`;
  created.emails.add(unknown);
  const delivered = mail.deliveries.length;
  const known = await mail.verification.request(
    { email: owner.email, purpose: 'account_deletion' },
    meta(),
  );
  const missing = await mail.verification.request(
    { email: unknown, purpose: 'account_deletion' },
    meta(),
  );
  assert.equal(missing.data.message, known.data.message);
  assert.equal(
    Object.keys(missing.data).sort().join(),
    Object.keys(known.data).sort().join(),
  );
  assert.equal(
    mail.deliveries.length,
    delivered + 1,
    'unknown email gets no mail',
  );
  assert.equal(mail.deliveries.at(-1)?.purpose, 'account_deletion');
  pass('unknown emails get the same response and no mail');

  const real = mail.codes.get(known.data.challengeId);
  await rejects(
    mail.verification.verify(
      {
        email: owner.email,
        purpose: 'account_deletion',
        challengeId: known.data.challengeId,
        code: real === '000000' ? '111111' : '000000',
      },
      meta(),
    ),
    'EMAIL_CODE_INVALID',
  );
  // Proofs of other purposes, or of another email, never delete.
  await db.emailAuthChallenge.updateMany({
    where: { email: owner.email },
    data: { createdAt: new Date(Date.now() - 61 * 60_000) },
  });
  const resetProof = await mail.proof(owner.email, 'password_reset');
  await rejects(
    deletion.deleteFromWeb(
      {
        email: owner.email,
        verificationToken: resetProof,
        requestKey: requestKey(),
        confirm: true,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  const attackerProof = await deletionProof(attacker.email);
  await rejects(
    deletion.deleteFromWeb(
      {
        email: owner.email,
        verificationToken: attackerProof,
        requestKey: requestKey(),
        confirm: true,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  const ownerProof = await deletionProof(owner.email);
  await rejects(
    auth.resetPassword(
      {
        email: owner.email,
        password: 'New-password-123!',
        verificationToken: ownerProof,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  assert.equal(
    await db.user.count({
      where: { id: { in: [owner.userId, attacker.userId] } },
    }),
    2,
  );
  pass(
    'signup/reset/other-email proofs cannot delete, deletion proofs cannot reset',
  );

  // Expired proof.
  const expiring = await deletionProof(owner.email);
  await db.emailAuthChallenge.updateMany({
    where: { email: owner.email, consumedAt: null, verifiedAt: { not: null } },
    data: { proofExpiresAt: new Date(Date.now() - 1_000) },
  });
  await rejects(
    deletion.deleteFromWeb(
      {
        email: owner.email,
        verificationToken: expiring,
        requestKey: requestKey(),
        confirm: true,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  // A password reset after the code was issued invalidates the proof.
  const stale = await deletionProof(owner.email);
  await db.user.update({
    where: { id: owner.userId },
    data: { tokenVersion: { increment: 1 } },
  });
  await rejects(
    deletion.deleteFromWeb(
      {
        email: owner.email,
        verificationToken: stale,
        requestKey: requestKey(),
        confirm: true,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  assert.equal(await db.user.count({ where: { id: owner.userId } }), 1);
  pass('expired proofs and proofs issued before a password change are refused');

  // Success, replay and single use.
  const scope = await scopeOf(owner);
  const proof = await deletionProof(owner.email);
  const key = requestKey();
  const first = await deletion.deleteFromWeb(
    {
      email: owner.email,
      verificationToken: proof,
      requestKey: key,
      confirm: true,
    },
    meta(),
  );
  const replay = await deletion.deleteFromWeb(
    {
      email: owner.email,
      verificationToken: proof,
      requestKey: key,
      confirm: true,
    },
    meta(),
  );
  assert.deepEqual(replay, first);
  await rejects(
    deletion.deleteFromWeb(
      {
        email: owner.email,
        verificationToken: proof,
        requestKey: requestKey(),
        confirm: true,
      },
      meta(),
    ),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  assert.deepEqual(await deletion.status({ requestKey: key }, meta()), first);
  await rejects(
    deletion.status({ requestKey: requestKey() }, meta()),
    'ACCOUNT_DELETION_NOT_FOUND',
  );
  await assertGone(scope);
  const afterDelivery = mail.deliveries.length;
  await db.emailAuthChallenge.updateMany({
    where: { email: owner.email },
    data: { createdAt: new Date(Date.now() - 61 * 60_000) },
  });
  await mail.verification.request(
    { email: owner.email, purpose: 'account_deletion' },
    meta(),
  );
  assert.equal(
    mail.deliveries.length,
    afterDelivery,
    'no mail for a deleted account',
  );
  pass(
    'web deletion is single use, replayable by its request key and status is server-side',
  );
}

/** Concurrent duplicate requests, in-flight trades and token refresh. */
async function races() {
  // Same request key twice at once: one commit, the same receipt.
  const twin = await member('twin');
  const key = requestKey();
  const [one, two] = await Promise.all([
    deleteInApp(twin, key),
    deleteInApp(twin, key),
  ]);
  assert.deepEqual(one, two);
  assert.equal(await db.user.count({ where: { id: twin.userId } }), 0);
  // Different keys: the loser finds no member and no receipt of its own.
  const pair = await member('pair');
  const outcomes = await Promise.all([
    settled(deleteInApp(pair)),
    settled(deleteInApp(pair)),
  ]);
  assert.deepEqual(outcomes.map((o) => (o.ok ? 'ok' : o.code)).sort(), [
    'UNAUTHORIZED',
    'ok',
  ]);
  pass('concurrent deletion requests commit once');

  // An in-flight trade holding the account lock: the deletion waits, then
  // deletes what the trade committed.
  const s = await fixture('general', '10000');
  const trader = await adopt(s, 'inflight');
  const scope = await scopeOf(trader);
  let releaseTrade!: () => void;
  const tradeHeld = new Promise<void>((resolve) => (releaseTrade = resolve));
  let tradeLocked!: () => void;
  const locked = new Promise<void>((resolve) => (tradeLocked = resolve));
  const trade = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${s.accountId} FOR UPDATE`;
      const wallet = await tx.cashWallet.findFirstOrThrow({
        where: { tradingAccountId: s.accountId, currencyCode: 'KRW' },
      });
      await tx.walletTransaction.create({
        data: {
          tradingAccountId: s.accountId,
          walletId: wallet.id,
          currencyCode: 'KRW',
          direction: 'credit',
          txType: 'adjustment',
          referenceType: 'manual_adjustment',
          amount: '1',
          balanceAfter: wallet.balanceAmount.plus(1),
          occurredAt: new Date(),
        },
      });
      tradeLocked();
      await tradeHeld;
    },
    { timeout: 30_000 },
  );
  await locked;
  const pending = settled(deleteInApp(trader));
  await untilLockWaiting();
  releaseTrade();
  await trade;
  const result = await pending;
  assert.ok(
    result.ok,
    `deletion after the trade: ${result.ok ? '' : result.code}`,
  );
  await assertGone(scope);
  pass(
    'a deletion waits for an in-flight trade and removes its committed rows',
  );

  // Refresh racing the deletion: no session survives either order.
  const racer = await member('refresh');
  const tokens = await login(racer);
  const [refreshed, removed] = await Promise.all([
    settled(auth.refresh({ refreshToken: tokens.refreshToken }, meta())),
    settled(deleteInApp(racer)),
  ]);
  assert.ok(removed.ok);
  if (refreshed.ok) {
    secrets.add(refreshed.value.data.tokens.accessToken);
    secrets.add(refreshed.value.data.tokens.refreshToken);
    await rejects(
      allowed(refreshed.value.data.tokens.accessToken),
      'UNAUTHORIZED',
    );
    await rejects(
      auth.refresh(
        { refreshToken: refreshed.value.data.tokens.refreshToken },
        meta(),
      ),
      'INVALID_REFRESH_TOKEN',
    );
  } else assert.equal(refreshed.code, 'INVALID_REFRESH_TOKEN');
  assert.equal(
    await db.refreshTokenSession.count({ where: { userId: racer.userId } }),
    0,
  );
  pass('token refresh racing the deletion leaves no usable session');
}

/** Settlement before and around the deletion (season row lock). */
async function settlementRaces() {
  // Valued before the deletion, final write after: the participant set
  // changed, nothing is published, the rerun settles the rest.
  const [a, b, c] = [
    await member('sa'),
    await member('sb'),
    await member('sc'),
  ];
  const ended = await seasonWith(
    'ended',
    [a, b, c],
    ['1300000', '1200000', '1100000'],
  );
  const valued = pauseAfter(settlementJob, 'calculateFinalValuations');
  const first = settled(settle(ended.seasonId, ended.endAt));
  await valued.reached;
  await deleteInApp(b);
  valued.release();
  const outcome = await first;
  valued.restore();
  assert.equal(
    outcome.ok ? 'ok' : outcome.code,
    'SETTLEMENT_PARTICIPANTS_CHANGED',
  );
  assert.equal(
    await db.seasonRanking.count({
      where: { seasonId: ended.seasonId, rankType: 'final' },
    }),
    0,
  );
  await settle(ended.seasonId, ended.endAt);
  const board = await finalBoard(a, ended.seasonId);
  assert.deepEqual(
    board.rows.map((row) => [row.userId, row.rank]),
    [
      [a.userId, 1],
      [c.userId, 2],
    ],
  );
  pass(
    'a deletion between valuation and final write fails that settlement; the rerun ranks the rest',
  );

  // Settlement holding the season lock: the deletion waits for it, then
  // preserves the just-confirmed result anonymously.
  const [d, e, f] = [
    await member('sd'),
    await member('se'),
    await member('sf'),
  ];
  const ended2 = await seasonWith(
    'ended',
    [d, e, f],
    ['1300000', '1200000', '1100000'],
  );
  const inLock = pauseAfter(settlementJob, 'findSettlementAccountParticipants');
  const running = settle(ended2.seasonId, ended2.endAt);
  await inLock.reached;
  const waiting = settled(deleteInApp(e));
  await untilLockWaiting();
  inLock.release();
  await running;
  inLock.restore();
  const removed = await waiting;
  assert.ok(removed.ok, removed.ok ? '' : removed.code);
  const board2 = await finalBoard(d, ended2.seasonId);
  assert.deepEqual(
    board2.rows.map((row) => row.rank),
    [1, 2, 3],
  );
  assert.ok(
    String(board2.rows[1].nickname).startsWith(
      ACCOUNT_DELETION_PLACEHOLDER_NICKNAME,
    ),
  );
  assert.equal(board2.rows[1].totalAssetKrw, '1200000.00000000');
  assert.deepEqual(
    [board2.rows[0].userId, board2.rows[2].userId],
    [d.userId, f.userId],
  );
  pass('a deletion queued behind settlement keeps the new final result intact');
}

/** Profile image upload overlapping the deletion, and storage outages. */
async function storageRaces() {
  const m = await member('upload');
  const uploadGate = gate();
  storageControl.uploadGate = {
    reached: uploadGate.reached,
    released: uploadGate.released,
  };
  const upload = settled(profile.upload(m.userId, jpegFile()));
  await uploadGate.reachedPromise;
  const key = requestKey();
  const result = await deleteInApp(m, key);
  assert.equal(
    result.data.deletion.status,
    'cleanup_pending',
    'waits for the in-flight upload',
  );
  uploadGate.release();
  const uploaded = await upload;
  assert.equal(uploaded.ok ? 'ok' : uploaded.code, 'UNAUTHORIZED');
  assert.equal(
    [...stored].some((object) => object.includes(m.userId)),
    false,
  );
  assert.equal(
    (await deletion.status({ requestKey: key }, meta())).data.deletion.status,
    'completed',
  );
  pass(
    'an upload overlapping the deletion never survives it and the receipt waits for it',
  );

  // Storage outage at deletion time: committed, pending, retried by the worker.
  const n = await member('outage');
  await profile.upload(n.userId, jpegFile());
  storageControl.failDelete = true;
  const outageKey = requestKey();
  const pendingResult = await deleteInApp(n, outageKey);
  assert.equal(pendingResult.data.deletion.status, 'cleanup_pending');
  assert.equal(await db.user.count({ where: { id: n.userId } }), 0);
  const failed = await cleanups.runDue();
  assert.equal(failed.removed, 0);
  const row = await db.profileImageCleanup.findFirstOrThrow({
    where: { objectKey: { startsWith: `profile-images/${n.userId}/` } },
  });
  assert.equal(row.attempts, 1);
  assert.equal(row.lastErrorCode, 'STORAGE_DELETE_FAILED');
  // Past the 7-day target: reported, never dropped.
  await db.accountDeletion.updateMany({
    where: {
      status: 'cleanup_pending',
      profileImageCleanups: { some: { objectKey: row.objectKey } },
    },
    data: { deletedAt: new Date(Date.now() - 8 * 86_400_000) },
  });
  await db.profileImageCleanup.update({
    where: { objectKey: row.objectKey },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
  const overdue = await cleanups.runDue();
  assert.equal(overdue.overdue, 1);
  storageControl.failDelete = false;
  await db.profileImageCleanup.update({
    where: { objectKey: row.objectKey },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
  const worker = new ProfileImageCleanupWorker(
    storage,
    cleanups,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
    new EmailAuthCleanupService(db),
    new DataRetentionCleanupService(db),
  );
  await worker.tick();
  assert.equal(
    (await deletion.status({ requestKey: outageKey }, meta())).data.deletion
      .status,
    'completed',
  );
  assert.equal(
    [...stored].some((object) => object.includes(n.userId)),
    false,
  );
  const run = await db.opsJobRun.findFirstOrThrow({
    where: { jobName: 'account_deletion_cleanup' },
    orderBy: { startedAt: 'desc' },
  });
  assert.equal(run.status, 'succeeded');
  pass(
    'a storage outage leaves the receipt pending until the worker removes the object',
  );
}

/** Failures inside the transaction roll everything back. */
async function failures() {
  // Injected database error late in the purge.
  const m = await member('db-error');
  await db.inquiry.create({
    data: {
      userId: m.userId,
      clientRequestId: randomUUID(),
      category: 'other',
      title: 't',
      content: 'c',
    },
  });
  await login(m);
  const before = await othersState([m], []);
  const faultKey = requestKey();
  const fn = `account_deletion_fault_${randomBytes(4).toString('hex')}`;
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fault'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${fn} BEFORE DELETE ON inquiries FOR EACH ROW WHEN (OLD.user_id = '${m.userId}') EXECUTE FUNCTION ${fn}()`,
  );
  try {
    await rejects(deleteInApp(m, faultKey), 'ACCOUNT_DELETION_FAILED');
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON inquiries`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
  }
  assertSameState(await othersState([m], []), before, 'others');
  assert.equal(
    await db.accountDeletion.count({
      where: { requestKeyHash: hashOf(faultKey) },
    }),
    0,
  );
  const scope = await scopeOf(m);
  await deleteInApp(m);
  await assertGone(scope);
  pass('a database error mid-purge rolls back completely and a retry succeeds');

  // Connection killed mid-transaction (server restart).
  const k = await member('crash');
  await login(k);
  const crashBefore = await othersState([k], []);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `${previous}&application_name=account-deletion-crash`;
  const crashDb = new PrismaService();
  process.env.DATABASE_URL = previous;
  const paused = pausingClient(crashDb, 'accountDeletion', 'create');
  const crashKey = requestKey();
  const crashed = settled(
    deleteInApp(k, crashKey, deletionWith(paused.client)),
  );
  await paused.reached;
  await db.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'account-deletion-crash' AND pid <> pg_backend_pid()`;
  paused.release();
  const outcome = await crashed;
  assert.equal(outcome.ok ? 'ok' : outcome.code, 'ACCOUNT_DELETION_FAILED');
  await crashDb.$disconnect().catch(() => undefined);
  assertSameState(await othersState([k], []), crashBefore, 'others');
  assert.equal(
    await db.accountDeletion.count({
      where: { requestKeyHash: hashOf(crashKey) },
    }),
    0,
  );
  const crashScope = await scopeOf(k);
  await deleteInApp(k);
  await assertGone(crashScope);
  pass(
    'a connection lost mid-transaction leaves the account intact and retryable',
  );
}

// ------------------------------------------------------------------ cleanup
async function cleanup() {
  const placeholders = await db.user.findMany({
    where: {
      email: { endsWith: '@deleted-member.invalid' },
      seasonParticipants: { some: { seasonId: { in: [...created.seasons] } } },
    },
    select: { id: true },
  });
  const userIds = [...created.users, ...placeholders.map((row) => row.id)];
  for (const userId of userIds) {
    const exists = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!exists) continue;
    await db.$transaction(
      async (tx) => {
        await tx.operatorAuditLog.deleteMany({
          where: { actorUserId: userId },
        });
        await tx.inquiryAnswer.deleteMany({
          where: { answeredByUserId: userId },
        });
        await tx.rewardFulfillmentRequest.deleteMany({
          where: { requestedByUserId: userId },
        });
        const scope = await lockDeletionScope(tx, userId);
        await purgeDeletionScope(tx, { userId, email: exists.email, scope });
      },
      { timeout: 60_000 },
    );
  }
  await db.profileImageCleanup.deleteMany({
    where: {
      OR: userIds.map((id) => ({
        objectKey: { startsWith: `profile-images/${id}/` },
      })),
    },
  });
  await db.accountDeletion.deleteMany({
    where: { requestKeyHash: { in: requestKeys.map(hashOf) } },
  });
  await db.batchJobRun.deleteMany({
    where: { idempotencyKey: { in: [...created.batchKeys] } },
  });
  await db.opsJobRun.deleteMany({
    where: { jobName: 'account_deletion_cleanup' },
  });
  await db.opsJobLock.deleteMany({
    where: { jobName: 'account_deletion_cleanup' },
  });
  for (const seasonId of created.seasons) {
    await db.seasonRanking.deleteMany({ where: { seasonId } });
    await db.futuresSeasonPrice.deleteMany({ where: { seasonId } });
    await db.season.delete({ where: { id: seasonId } }).catch(() => undefined);
  }
  await db.badge.deleteMany({ where: { id: { in: [...created.badges] } } });
  const instrumentIds = [
    ...new Set(created.instruments.map((row) => row.instrument.id)),
  ];
  const assetIds = [...new Set(created.instruments.map((row) => row.asset.id))];
  await db.futuresMarkSnapshot.deleteMany({
    where: { instrumentId: { in: instrumentIds } },
  });
  await db.futuresLastPriceSnapshot.deleteMany({
    where: { instrumentId: { in: instrumentIds } },
  });
  await db.futuresInstrument.deleteMany({
    where: { id: { in: instrumentIds } },
  });
  await db.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.asset.deleteMany({ where: { id: { in: assetIds } } });
  for (const learning of created.learning)
    await releaseLearningAssets(db, learning);
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: fxEvidenceIds } } });
  await db.emailAuthChallenge.deleteMany({
    where: { email: { in: [...created.emails] } },
  });
  const bucketKeys = [...ips].flatMap((ip) =>
    ['send', 'verify', 'complete', 'status'].map((action) =>
      createHmac('sha256', mail.secret)
        .update(JSON.stringify(['ip', action, ip]))
        .digest('hex'),
    ),
  );
  await db.emailAuthRateBucket.deleteMany({
    where: { key: { in: bucketKeys } },
  });
  await mail.cleanup();
}

async function main() {
  await db.$connect();
  try {
    await fullMember();
    await memberKindsAndRefusals();
    await webFlow();
    await races();
    await settlementRaces();
    await storageRaces();
    await failures();
    const leaked = logs.filter((line) =>
      [...secrets].some((secret) => line.includes(secret)),
    );
    assert.deepEqual(
      leaked,
      [],
      'a password, token, proof or request key reached a log',
    );
    const userIdLogs = logs.filter(
      (line) =>
        line.includes('account_deletion') &&
        /[0-9a-f]{8}-[0-9a-f]{4}-4/.test(
          line.replace(/"deletionId":"[^"]+"/g, ''),
        ),
    );
    assert.deepEqual(userIdLogs, [], 'a deletion log carried a member id');
    pass('no password, token, proof, request key or member id was logged');
    console.log(
      `account deletion PostgreSQL integration ok (${checks} checks)`,
    );
  } finally {
    await cleanup();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
