/** Opt-in, disposable local PostgreSQL only. Never loads production env files. */
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { OrdersService } from '../src/orders/orders.service';
import { assertSeasonTradable } from '../src/seasons/season-lifecycle.policy';
import { SeasonsService } from '../src/seasons/seasons.service';
import { BatchService } from '../src/batch/batch.service';
import { SeasonLifecycleTransitionJobService } from '../src/batch/season-lifecycle-transition-job.service';
import {
  DEVELOPMENT_SEASON_ID,
  LAUNCH_DURATION_MS,
} from '../src/seasons/season-availability.policy';
import {
  activateLaunchSeason,
  armLaunchSeason,
  lockSeasonAdministration,
  prepareLaunchSeason,
  rescheduleLaunchSeason,
  restoreDevelopmentSeason,
  seasonDatabaseNow,
  stopLaunchTest,
} from '../src/seasons/launch-season.operations';
import {
  applyLaunchTestCleanup,
  lockLaunchTestCleanupAccounts,
  lockLaunchTestCleanupQuotes,
  planLaunchTestCleanup,
} from '../src/seasons/launch-test-cleanup';
import { inspectLaunchRequest, launchPlanFingerprint } from './launch-season';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { TradingAccountsService } from '../src/trading-accounts/trading-accounts.service';
import { RecordsService } from '../src/records/records.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SEASON0_DB_INTEGRATION !== '1' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !target.pathname.endsWith('_test')
)
  throw new Error(
    'Requires NODE_ENV=test, SEASON0_DB_INTEGRATION=1 and an explicit disposable loopback *_test DB.',
  );
const db = new PrismaService();
const seasons = new SeasonsService(db);
const access = new TradingAccountAccessService(db);
const accounts = new TradingAccountsService(access);
const records = new RecordsService(db, new PortfolioValuationService(db));
const run = randomUUID();
const testId = `launch-test-${run}`,
  releaseId = `launch-release-${run}`;
const now = () => seasonDatabaseNow(db as unknown as Prisma.TransactionClient);
const admin = <T>(fn: (tx: Prisma.TransactionClient, at: Date) => Promise<T>) =>
  db.$transaction(
    async (tx) => {
      await lockSeasonAdministration(tx, testId);
      return fn(tx, await seasonDatabaseNow(tx));
    },
    { timeout: 15000 },
  );
const readOnly = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return fn(tx);
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  );
let assertions = 0;
function ok(value: boolean, message: string) {
  assert.equal(value, true, message);
  assertions++;
}
async function rejected(p: Promise<unknown>, message: string) {
  await assert.rejects(p, message);
  assertions++;
}

async function main() {
  ok(
    (await db.season.count()) === 0,
    'dedicated fixture DB must contain no seasons',
  );
  const actor = await db.user.create({
    data: {
      email: `admin-${run}@example.invalid`,
      nickname: `admin-${run}`,
      passwordHash: 'fixture',
      role: 'admin',
    },
  });
  const tester = await db.user.create({
    data: {
      email: `tester-${run}@example.invalid`,
      nickname: `tester-${run}`,
      passwordHash: 'fixture',
    },
  });
  const other = await db.user.create({
    data: {
      email: `other-${run}@example.invalid`,
      nickname: `other-${run}`,
      passwordHash: 'fixture',
    },
  });
  await db.season.create({
    data: {
      id: DEVELOPMENT_SEASON_ID,
      name: 'Season 1',
      status: 'active',
      startAt: new Date('2000-01-01T00:00:00Z'),
      endAt: new Date('2099-12-31T23:59:59Z'),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  await seasons.joinSeason(DEVELOPMENT_SEASON_ID, tester.id);
  const sourceParticipant = await db.seasonParticipant.findUniqueOrThrow({
    where: {
      seasonId_userId: { seasonId: DEVELOPMENT_SEASON_ID, userId: tester.id },
    },
  });
  const developmentAsset = await db.asset.create({
    data: {
      symbol: `D${run}`,
      name: 'Shared development fixture',
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      isActive: true,
    },
  });
  const developmentOrder = await db.order.create({
    data: {
      tradingAccountId: sourceParticipant.tradingAccountId,
      assetId: developmentAsset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'submitted',
      quantity: '1',
      limitPrice: '100',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      reservedAmount: '100',
      submittedAt: await now(),
    },
  });
  await db.cashWallet.updateMany({
    where: {
      tradingAccountId: sourceParticipant.tradingAccountId,
      currencyCode: 'KRW',
      walletScope: 'securities',
    },
    data: { reservedAmount: '100' },
  });
  await db.position.create({
    data: {
      tradingAccountId: sourceParticipant.tradingAccountId,
      assetId: developmentAsset.id,
      quantity: '1',
      averageCost: '100',
      currencyCode: 'KRW',
    },
  });
  await db.seasonRanking.create({
    data: {
      seasonId: DEVELOPMENT_SEASON_ID,
      seasonParticipantId: sourceParticipant.id,
      tradingAccountId: sourceParticipant.tradingAccountId,
      rank: 1,
      totalAssetKrw: '10000100',
      returnRate: '0',
      rankingDate: await now(),
      capturedAt: await now(),
    },
  });
  for (const mode of ['general', 'beginner'] as const) {
    const account = await db.tradingAccount.create({
      data: {
        userId: tester.id,
        mode,
        status: 'active',
        openedAt: await now(),
        initialCapitalKrw: '10000000',
      },
    });
    await db.cashWallet.create({
      data: {
        tradingAccountId: account.id,
        currencyCode: 'KRW',
        balanceAmount: '123456',
      },
    });
  }
  const stableFinancialRows = async () =>
    JSON.stringify(
      await db.tradingAccount.findMany({
        where: {
          userId: tester.id,
          id: {
            notIn: (
              await db.seasonParticipant.findMany({
                where: { seasonId: testId },
                select: { tradingAccountId: true },
              })
            ).map((p) => p.tradingAccountId),
          },
        },
        orderBy: { id: 'asc' },
        include: {
          cashWallets: { orderBy: { id: 'asc' } },
          walletTransactions: { orderBy: { id: 'asc' } },
          equitySnapshots: { orderBy: { id: 'asc' } },
          orders: { orderBy: { id: 'asc' } },
          positions: { orderBy: { id: 'asc' } },
          seasonRankings: { orderBy: { id: 'asc' } },
          seasonParticipant: true,
        },
      }),
    );
  const originalMoney = await stableFinancialRows();
  const start = new Date(+(await now()) + 2500);
  const request = {
    action: 'prepare',
    seasonId: testId,
    actorUserId: actor.id,
    startAt: start.toISOString(),
    kind: 'test' as const,
    testUserIds: [tester.id],
  };
  const beforeDryRun = await db.season.count();
  const inspection = await readOnly((tx) => inspectLaunchRequest(tx, request));
  ok(
    (await db.season.count()) === beforeDryRun,
    'strict read-only planning writes no season',
  );
  ok(
    launchPlanFingerprint('local', request, inspection).length === 64,
    'plan is fingerprinted',
  );
  await rejected(
    readOnly((tx) =>
      inspectLaunchRequest(tx, { ...request, actorUserId: tester.id }),
    ),
    'ordinary user cannot administer a launch',
  );
  await admin((tx, at) =>
    prepareLaunchSeason(
      tx,
      { id: testId, kind: 'test', startAt: start, testUserIds: [tester.id] },
      at,
    ),
  );
  for (const offset of [4000, 7000])
    await admin((tx, at) =>
      rescheduleLaunchSeason(tx, testId, new Date(+at + offset), at),
    );
  let prepared = await db.season.findUniqueOrThrow({ where: { id: testId } });
  ok(
    +prepared.endAt - +prepared.startAt === LAUNCH_DURATION_MS,
    'repeated rescheduling always keeps exactly 21 days',
  );
  ok(
    prepared.finalRankingMinTradedInstruments === 5 &&
      prepared.finalRankingMinTurnoverRatio?.equals(3) === true,
    'launch criteria are 5 instruments AND 300%',
  );
  ok(
    (await seasons.getCurrentSeason(tester.id)).data.id ===
      DEVELOPMENT_SEASON_ID,
    'upcoming launch preserves active development selection',
  );
  ok(
    (
      await db.season.findUniqueOrThrow({
        where: { id: DEVELOPMENT_SEASON_ID },
      })
    ).finalRankingMinTradedInstruments === null,
    'no retroactive qualification change',
  );
  await admin((tx, at) => armLaunchSeason(tx, testId, at, true));
  const due = new Date(+(await now()) + 2000);
  await admin((tx, at) => rescheduleLaunchSeason(tx, testId, due, at));
  ok(
    (
      await db.season.findUniqueOrThrow({
        where: { id: DEVELOPMENT_SEASON_ID },
      })
    ).tradingCutoffAt?.getTime() === +due,
    'armed reschedule moves the server cutoff',
  );
  await delay(Math.max(0, +due - +(await now()) + 50));
  await rejected(
    admin((tx, at) =>
      rescheduleLaunchSeason(tx, testId, new Date(+at + 5000), at),
    ),
    'reached start cannot be changed even before activation',
  );
  await rejected(
    seasons.joinSeason(DEVELOPMENT_SEASON_ID, other.id),
    'scheduler delay never reopens development joins',
  );
  await rejected(
    db.$transaction((tx) =>
      lockSeasonTradingContext(tx, {
        seasonParticipantId: sourceParticipant.id,
      }),
    ),
    'stale trading context is fenced by the DB cutoff',
  );
  // A crash between the two season updates rolls both back.
  await rejected(
    admin(async (tx, at) => {
      const wrapped = new Proxy(tx, {
        get(t, key) {
          if (key === 'season')
            return {
              ...t.season,
              update: (arg: Prisma.SeasonUpdateArgs) => {
                if (arg.where.id === testId)
                  throw new Error('injected cutover failure');
                return t.season.update(arg);
              },
            };
          return Reflect.get(t, key) as unknown;
        },
      });
      return activateLaunchSeason(wrapped, testId, at);
    }),
    'partial cutover must roll back',
  );
  ok(
    (
      await db.season.findUniqueOrThrow({
        where: { id: DEVELOPMENT_SEASON_ID },
      })
    ).suspendedAt === null,
    'failed cutover did not half-suspend development',
  );
  const lifecycle = new SeasonLifecycleTransitionJobService(
    new BatchService(db),
    db,
  );
  await lifecycle.run({
    idempotencyKey: `launch-${run}`,
    now: (await now()).toISOString(),
  });
  prepared = await db.season.findUniqueOrThrow({ where: { id: testId } });
  ok(
    prepared.status === 'active',
    'existing lifecycle activates the armed launch',
  );
  await admin((tx, at) => activateLaunchSeason(tx, testId, at));
  const source = await db.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  ok(
    source.status === 'active' &&
      !!source.suspendedAt &&
      source.endAt.toISOString() === '2099-12-31T23:59:59.000Z',
    'development is private/frozen without fake end/settlement',
  );
  ok(
    (await seasons.getSeasons()).data.seasons.every(
      (s) => s.id !== DEVELOPMENT_SEASON_ID,
    ),
    'public list hides development',
  );
  ok(
    (await seasons.getCurrentSeason(tester.id)).data.displayBadge === 'beta',
    'current launch supplies explicit beta metadata',
  );
  await rejected(
    access.getOwnedAccountOrThrow(
      tester.id,
      sourceParticipant.tradingAccountId,
    ),
    'old selected account is not publicly readable',
  );
  await assert.rejects(
    new OrdersService(db).executeOrder(tester.id, developmentOrder.id),
    (error: unknown) =>
      error instanceof HttpException &&
      (error.getResponse() as { error?: { code?: string } }).error?.code ===
        'ORDER_NOT_FOUND',
  );
  assertions++;
  await rejected(
    seasons.joinSeason(testId, other.id),
    'unapproved account cannot join',
  );
  const joining = await Promise.allSettled([
    seasons.joinSeason(testId, tester.id),
    seasons.joinSeason(testId, tester.id),
  ]);
  ok(
    joining.filter((result) => result.status === 'fulfilled').length === 1,
    'two concurrent joins have exactly one winner',
  );
  const joined = (
    joining.find(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof seasons.joinSeason>>>
  ).value;
  await rejected(
    seasons.joinSeason(testId, tester.id),
    'duplicate join does not pay twice',
  );
  const p = await db.seasonParticipant.findUniqueOrThrow({
    where: { id: joined.data.seasonParticipantId },
  });
  ok(
    (await db.walletTransaction.count({
      where: { tradingAccountId: p.tradingAccountId, txType: 'initial_grant' },
    })) === 1,
    'one initial grant only',
  );
  ok(
    (await db.cashWallet.count({
      where: { tradingAccountId: p.tradingAccountId },
    })) === 4,
    'canonical four new wallets',
  );
  ok(
    (await accounts.listTradingAccounts(tester.id)).data.accounts.some(
      (a) => a.id === p.tradingAccountId && a.season?.displayBadge === 'beta',
    ),
    'account picker receives the launch badge',
  );
  const history = await records.getMySeasonRecords(tester.id);
  ok(
    history.data.seasons.every((s) => s.seasonId !== DEVELOPMENT_SEASON_ID),
    'season records hide development',
  );
  ok(
    (
      history.data.seasons.find((s) => s.seasonId === testId) as {
        displayBadge?: string;
      }
    )?.displayBadge === 'beta',
    'record list retains beta metadata',
  );
  const asset = await db.asset.create({
    data: {
      symbol: `L${run}`,
      name: 'Launch fixture',
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      isActive: true,
    },
  });
  await db.order.create({
    data: {
      tradingAccountId: p.tradingAccountId,
      assetId: asset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'submitted',
      quantity: '1',
      limitPrice: '100',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      reservedAmount: '100',
      submittedAt: await now(),
    },
  });
  await db.cashWallet.updateMany({
    where: {
      tradingAccountId: p.tradingAccountId,
      currencyCode: 'KRW',
      walletScope: 'securities',
    },
    data: { reservedAmount: '100' },
  });
  await rejected(
    admin((tx, at) =>
      rescheduleLaunchSeason(tx, testId, new Date(+at + 5000), at),
    ),
    'active launch dates remain frozen',
  );
  await rejected(
    db.season.update({
      where: { id: testId },
      data: { endAt: new Date(+prepared.endAt + 1) },
    }),
    'DB refuses duration/date changes after activation',
  );
  let releaseWriter!: () => void;
  let reportLocked!: () => void;
  const writerHeld = new Promise<void>((resolve) => {
    reportLocked = resolve;
  });
  const writerRelease = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const writer = db.$transaction(
    async (tx) => {
      await lockSeasonTradingContext(tx, { seasonParticipantId: p.id });
      reportLocked();
      await writerRelease;
    },
    { timeout: 15000 },
  );
  await writerHeld;
  let stopped = false;
  const stopping = admin((tx, at) => stopLaunchTest(tx, testId, at)).then(
    () => {
      stopped = true;
    },
  );
  await delay(100);
  ok(!stopped, 'test stop waits for a writer holding the Season fence');
  releaseWriter();
  await writer;
  await stopping;
  await rejected(
    db.$transaction((tx) =>
      lockSeasonTradingContext(tx, { seasonParticipantId: p.id }),
    ),
    'no writer enters the stopped test',
  );
  await rejected(
    seasons.joinSeason(testId, other.id),
    'stopped test refuses joins',
  );
  // Local metadata-only fixtures cover the schema's two nullable reward links.
  const rewardFixture = await db.seasonReward.create({
    data: {
      seasonId: testId,
      seasonParticipantId: p.id,
      userId: tester.id,
      rewardType: 'internal',
      rewardCode: 'cleanup-fixture',
      rewardName: 'Local metadata fixture',
      grantedAt: await now(),
    },
  });
  const requestFixture = await db.rewardFulfillmentRequest.create({
    data: {
      seasonId: testId,
      seasonParticipantId: p.id,
      userId: tester.id,
      rewardType: 'internal',
      rewardCode: 'cleanup-fixture',
      rewardName: 'Local metadata fixture',
      status: 'canceled',
      seasonRewardId: rewardFixture.id,
      requestedByUserId: actor.id,
      idempotencyKey: `fixture-${run}`,
      requestHash: run,
    },
  });
  await db.seasonReward.update({
    where: { id: rewardFixture.id },
    data: { fulfillmentRequestId: requestFixture.id },
  });
  const plan = await readOnly(async (tx) =>
    planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
  );
  ok(
    plan.tables.orders.count === 1 &&
      plan.tables.wallet_transactions.count === 1,
    'dry-run traces financial children by account',
  );
  ok(
    plan.tables.trading_accounts.count === 1 &&
      plan.tables.season_participants.count === 1,
    'only target season account is selected',
  );
  ok(
    plan.detachedRewardLinks.rewards === 1 &&
      plan.detachedRewardLinks.requests === 1,
    'dry-run reports both target-only reward cycle pointers',
  );
  await db.rewardFulfillmentRequest.update({
    where: { id: requestFixture.id },
    data: { status: 'processing' },
  });
  await rejected(
    readOnly(async (tx) =>
      planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
    ),
    'a processing external fulfillment blocks cleanup',
  );
  await db.rewardFulfillmentRequest.update({
    where: { id: requestFixture.id },
    data: { status: 'canceled', processingStartedAt: await now() },
  });
  await rejected(
    readOnly(async (tx) =>
      planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
    ),
    'past processing evidence blocks cleanup even after cancellation',
  );

  await db.rewardFulfillmentRequest.update({
    where: { id: requestFixture.id },
    data: { status: 'canceled', processingStartedAt: null },
  });

  const externalFixture = await db.pushNotification.create({
    data: {
      userId: tester.id,
      tradingAccountId: p.tradingAccountId,
      type: 'trade_fill',
      sourceKey: `sent-${run}`,
      title: 'fixture',
      body: 'fixture',
      data: { accountId: p.tradingAccountId },
      status: 'sent',
      nextAttemptAt: await now(),
      sentAt: await now(),
      eventAt: await now(),
      expiresAt: new Date(+(await now()) + 60000),
    },
  });
  await rejected(
    readOnly(async (tx) =>
      planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
    ),
    'external delivery blocks cleanup',
  );
  await db.pushNotification.update({
    where: { id: externalFixture.id },
    data: { status: 'failed', sentAt: null },
  });
  const changed = await readOnly(async (tx) =>
    planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
  );
  ok(
    changed.fingerprint !== plan.fingerprint,
    'new or changed rows invalidate the reviewed cleanup plan',
  );
  await db.pushNotification.update({
    where: { id: externalFixture.id },
    data: { tradingAccountId: null, data: { accountId: p.tradingAccountId } },
  });
  const jsonOnly = await readOnly(async (tx) =>
    planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
  );
  ok(
    jsonOnly.tables.push_notifications.count === 1,
    'JSON-only legacy account references are included',
  );
  await db.pushNotification.update({
    where: { id: externalFixture.id },
    data: { tradingAccountId: sourceParticipant.tradingAccountId },
  });
  await rejected(
    readOnly(async (tx) =>
      planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
    ),
    'contradictory notification scope blocks cleanup',
  );
  await db.pushNotification.deleteMany({ where: { sourceKey: `sent-${run}` } }); // local fixture only, never an operating command
  await rejected(
    admin(async (tx, at) => {
      const current = await planLaunchTestCleanup(tx, testId, at);
      const wrapped = new Proxy(tx, {
        get(t, key) {
          if (key === '$executeRaw')
            return async (sql: Prisma.Sql) => {
              const count = await t.$executeRaw(sql);
              if (sql.sql.includes('DELETE FROM "orders"'))
                throw new Error('injected delete failure');
              return count;
            };
          return Reflect.get(t, key) as unknown;
        },
      });
      return applyLaunchTestCleanup(wrapped, current, at);
    }),
    'delete failure rolls back all deletes AND development restore',
  );
  ok(
    (await db.order.count({
      where: { tradingAccountId: p.tradingAccountId },
    })) === 1 &&
      !!(
        await db.season.findUniqueOrThrow({
          where: { id: DEVELOPMENT_SEASON_ID },
        })
      ).suspendedAt,
    'no partial deletion or restoration',
  );
  // A new FK not known to the explicit purge list fails the dry-run closed.
  await db.$executeRawUnsafe(
    'CREATE TABLE launch_cleanup_unknown_test (id TEXT PRIMARY KEY, account_id TEXT REFERENCES trading_accounts(id))',
  );
  await db.$executeRaw`INSERT INTO launch_cleanup_unknown_test VALUES ('blocker', ${p.tradingAccountId})`;
  await rejected(
    readOnly(async (tx) =>
      planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
    ),
    'out-of-scope FK blocks cleanup',
  );
  await db.$executeRawUnsafe('DROP TABLE launch_cleanup_unknown_test'); // owns this local fixture table only
  const reviewed = await readOnly(async (tx) =>
    planLaunchTestCleanup(tx, testId, await seasonDatabaseNow(tx)),
  );
  await db.$transaction(
    async (tx) => {
      await lockLaunchTestCleanupQuotes(tx, testId);
      await lockSeasonAdministration(tx, testId);
      await lockLaunchTestCleanupAccounts(tx, testId);
      const current = await planLaunchTestCleanup(
        tx,
        testId,
        await seasonDatabaseNow(tx),
      );
      ok(
        current.fingerprint === reviewed.fingerprint,
        'locked apply rechecks the exact reviewed rows/counts/FKs',
      );
      await applyLaunchTestCleanup(tx, current, await seasonDatabaseNow(tx));
    },
    { timeout: 15000 },
  );
  ok(
    (await db.season.count({ where: { id: testId } })) === 0 &&
      (await db.tradingAccount.count({ where: { id: p.tradingAccountId } })) ===
        0,
    'test and its account have no residual data',
  );
  ok(
    (await db.user.count({ where: { id: tester.id } })) === 1,
    'the user is preserved',
  );
  ok(
    (await stableFinancialRows()) === originalMoney,
    'development, general and beginner financial rows are unchanged',
  );
  const restored = await db.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  ok(
    !restored.suspendedAt &&
      !restored.tradingCutoffAt &&
      restored.status === 'active',
    'original development availability is restored',
  );
  await rejected(
    admin((tx, at) => restoreDevelopmentSeason(tx, testId, at)),
    'repeating a cleaned ID refuses without touching other data',
  );
  await admin((tx, at) =>
    prepareLaunchSeason(
      tx,
      {
        id: releaseId,
        kind: 'release',
        startAt: new Date(+at + 86400000),
        testUserIds: [],
      },
      at,
    ),
  );
  ok(
    (await db.seasonParticipant.count({ where: { seasonId: releaseId } })) ===
      0,
    'fresh release ID has zero test activity',
  );
  ok(
    (await seasons.getCurrentSeason(tester.id)).data.id ===
      DEVELOPMENT_SEASON_ID,
    'unarmed future release keeps development usable',
  );
  await rejected(
    db.season.update({
      where: { id: DEVELOPMENT_SEASON_ID },
      data: { launchArmed: true },
    }),
    'DB check cannot be bypassed with NULL launch kind',
  );
  const conflict = await db.season.create({
    data: {
      id: `conflict-${run}`,
      name: 'fixture',
      status: 'upcoming',
      startAt: new Date(+(await now()) + 3 * 86400000),
      endAt: new Date(+(await now()) + 4 * 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  await rejected(
    admin((tx, at) =>
      rescheduleLaunchSeason(tx, releaseId, new Date(+at + 2 * 86400000), at),
    ),
    'rescheduling into another season window is refused',
  );
  await db.season.delete({ where: { id: conflict.id } });
  const release = await db.season.findUniqueOrThrow({
    where: { id: releaseId },
  });
  assertSeasonTradable(
    { ...release, status: 'active' },
    new Date(+release.endAt - 1),
  );
  assertions++;
  await rejected(
    Promise.resolve().then(() =>
      assertSeasonTradable({ ...release, status: 'active' }, release.endAt),
    ),
    'the exact 21-day end rejects trading',
  );
  console.log(
    JSON.stringify({
      result: 'season0 PostgreSQL integration PASS',
      assertions,
      testId,
      releaseId,
      productionWrites: 0,
    }),
  );
}

main()
  .finally(() => db.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : 'integration failed');
    process.exitCode = 1;
  });
