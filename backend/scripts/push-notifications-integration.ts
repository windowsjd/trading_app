/** Push notifications on an isolated PostgreSQL: committed source rows →
 * outbox → (fake) Expo, with the real scanner, dispatcher, device, preference
 * and notice services. No provider or financial write path is exercised; the
 * financial rows are fixtures and must be unchanged afterwards. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import {
  ExpoPushClient,
  type ExpoTransport,
} from '../src/notifications/expo-push.client';
import { PushDispatcher } from '../src/notifications/push-dispatcher.service';
import {
  PushNotificationScanner,
  WINDOWED_SOURCES,
} from '../src/notifications/push-notification-scanner.service';
import { PushDevicesService } from '../src/notifications/push-devices.service';
import { NotificationPreferencesService } from '../src/notifications/notification-preferences.service';
import { ImportantNoticesService } from '../src/notifications/important-notices.service';
import { pushNotificationsConfig } from '../src/notifications/push-notifications.config';

const url = process.env.DATABASE_URL ?? '';
if (
  process.env.PUSH_NOTIFICATIONS_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
) {
  throw new Error(
    'Requires PUSH_NOTIFICATIONS_DB_INTEGRATION=1 NODE_ENV=test and a loopback DATABASE_URL.',
  );
}

const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const config = { ...pushNotificationsConfig({}), dryRun: false };
const HOUR = 3_600_000;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}

const created = {
  users: [] as string[],
  accounts: [] as string[],
  seasons: [] as string[],
  assets: [] as string[],
  notices: [] as string[],
};

type Sent = { to: string; data: Record<string, unknown> };
const sent: Sent[] = [];
let ticketError: Record<string, string> = {};
let receiptError: Record<string, string> = {};
let failTransport = false;
// A token whose device is released while the request is in flight.
let releaseDuringSend: string | null = null;
const transport: ExpoTransport = async (endpoint, init) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (failTransport) throw new Error('network down');
  const payload = JSON.parse(init.body) as unknown;
  if (endpoint.endsWith('/getReceipts')) {
    const ids = (payload as { ids: string[] }).ids;
    return {
      status: 200,
      body: {
        data: Object.fromEntries(
          ids.map((id) => [
            id,
            receiptError[id]
              ? { status: 'error', details: { error: receiptError[id] } }
              : { status: 'ok' },
          ]),
        ),
      },
    };
  }
  const messages = payload as Sent[];
  sent.push(...messages.map((m) => ({ to: m.to, data: m.data })));
  if (releaseDuringSend && messages.some((m) => m.to === releaseDuringSend))
    await db.pushDevice.deleteMany({ where: { token: releaseDuringSend } });
  return {
    status: 200,
    body: {
      data: messages.map((m) =>
        ticketError[m.to]
          ? { status: 'error', details: { error: ticketError[m.to] } }
          : { status: 'ok', id: `ticket-${randomUUID()}` },
      ),
    },
  };
};

const expo = new ExpoPushClient(transport);
const scanner = new PushNotificationScanner(db);
const dispatcher = new PushDispatcher(db, expo);
const devices = new PushDevicesService(db);
const preferences = new NotificationPreferencesService(db);
const notices = new ImportantNoticesService(db, new OperatorAuditService(db));

async function dbNow(): Promise<Date> {
  const rows = await db.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}

async function user(name: string, role: 'user' | 'operator' = 'user') {
  const row = await db.user.create({
    data: {
      email: `push-${tag}-${name}@example.invalid`,
      nickname: `push-${tag}-${name}`,
      passwordHash: 'test-only',
      role,
    },
  });
  created.users.push(row.id);
  return row;
}

async function account(
  userId: string,
  mode: 'general' | 'season',
  openedAt: Date,
) {
  const row = await db.tradingAccount.create({
    data: { userId, mode, initialCapitalKrw: '10000000', openedAt },
  });
  created.accounts.push(row.id);
  return row;
}

async function notificationsOf(userIds: string[]) {
  return db.pushNotification.findMany({
    where: { userId: { in: userIds } },
    orderBy: [{ createdAt: 'asc' }, { sourceKey: 'asc' }],
  });
}

async function financialState(accountIds: string[]) {
  return JSON.stringify(
    await Promise.all([
      db.order.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.limitOnCloseOrder.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { orderId: 'asc' },
      }),
      db.conditionalBuyOrder.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.futuresLiquidation.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.seasonParticipant.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
    ]),
  );
}

async function run() {
  const start = await dbNow();
  // Activation 10 s back, scans 10 s ahead: an application clock step can
  // never put a fixture outside the window (WSL steps back ~1.7 s).
  const activation = new Date(start.getTime() - 10_000);
  await db.pushScanCursor.deleteMany({});

  const alice = await user('alice');
  const bob = await user('bob');
  const carol = await user('carol');
  const operator = await user('operator', 'operator');
  const asset = await db.asset.create({
    data: {
      symbol: `P${tag}`.slice(0, 9),
      name: `푸시전자-${tag}`,
      market: 'KRX',
      currencyCode: 'KRW',
      assetType: 'domestic_stock',
    },
  });
  created.assets.push(asset.id);
  const snapshot = await db.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '1000',
      currencyCode: 'KRW',
      sourceType: 'provider_api',
      effectiveAt: start,
      capturedAt: start,
    },
  });

  const activeSeason = await db.season.create({
    data: {
      name: `push-active-${tag}`,
      status: 'active',
      startAt: new Date(start.getTime() - 24 * HOUR),
      endAt: new Date(start.getTime() + 12 * HOUR),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  created.seasons.push(activeSeason.id);
  const aliceGeneral = await account(alice.id, 'general', activeSeason.startAt);
  const aliceSeason = await account(alice.id, 'season', activeSeason.startAt);
  const bobGeneral = await account(bob.id, 'general', activeSeason.startAt);
  await db.seasonParticipant.create({
    data: {
      seasonId: activeSeason.id,
      userId: alice.id,
      tradingAccountId: aliceSeason.id,
      participantStatus: 'active',
      joinedAt: activeSeason.startAt,
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });

  // Activation: the first scan only records where each source starts.
  const baseline = await scanner.scan(activation, config);
  check(baseline.failedSources.length === 0, 'baseline scan succeeds');
  check(
    (await db.pushScanCursor.count({
      where: { source: { in: WINDOWED_SOURCES.map((item) => item.source) } },
    })) === WINDOWED_SOURCES.length,
    'every windowed source starts at activation',
  );

  // A fill committed BEFORE activation is never announced.
  await db.order.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'market',
      status: 'executed',
      quantity: '1',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      executedPrice: '1000',
      grossAmount: '1000',
      feeAmount: '1',
      netAmount: '1001',
      assetPriceSnapshotId: snapshot.id,
      submittedAt: new Date(activation.getTime() - 5_000),
      executedAt: new Date(activation.getTime() - 5_000),
    },
  });

  const at = (offsetMs: number) => new Date(activation.getTime() + offsetMs);
  // Positive: executed market buy (alice), executed market sell (bob).
  const aliceFill = await db.order.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'market',
      status: 'executed',
      quantity: '3',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      executedPrice: '1000',
      grossAmount: '3000',
      feeAmount: '3',
      netAmount: '3003',
      assetPriceSnapshotId: snapshot.id,
      submittedAt: at(1_000),
      executedAt: at(1_000),
    },
  });
  const bobFill = await db.order.create({
    data: {
      tradingAccountId: bobGeneral.id,
      assetId: asset.id,
      side: 'sell',
      orderType: 'market',
      status: 'executed',
      quantity: '2',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      executedPrice: '1000',
      grossAmount: '2000',
      feeAmount: '2',
      netAmount: '1998',
      assetPriceSnapshotId: snapshot.id,
      submittedAt: at(1_100),
      executedAt: at(1_100),
    },
  });
  // Negative: a submitted limit order and a user-canceled one.
  await db.order.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'submitted',
      quantity: '1',
      limitPrice: '900',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      submittedAt: at(1_200),
    },
  });
  await db.order.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'canceled',
      quantity: '1',
      limitPrice: '900',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      cancelReason: 'user_canceled',
      submittedAt: at(1_300),
      canceledAt: at(1_400),
    },
  });

  // Positive: an LOC decided unfilled against final close evidence.
  const sessionDate = new Date(Date.UTC(2026, 9, 16));
  const evidence = await db.sessionClosePriceEvidence.create({
    data: {
      assetId: asset.id,
      market: 'KRX',
      sessionDate,
      sessionCloseAt: new Date('2026-10-16T06:30:00.000Z'),
      provider: 'koscom',
      sourceName: 'test',
      providerSymbol: asset.symbol,
      providerTradingDate: '20261016',
      closePrice: '1100',
      currencyCode: 'KRW',
      status: 'final',
      firstObservedAt: new Date('2026-10-16T06:31:00.000Z'),
      lastObservedAt: new Date('2026-10-16T06:36:00.000Z'),
      observationCount: 2,
      finalizedAt: new Date('2026-10-16T06:36:00.000Z'),
      firstRawJson: {},
      confirmRawJson: {},
      policyVersion: 1,
    },
  });
  const locSession = {
    market: 'KRX' as const,
    sessionDate,
    sessionOpenAt: new Date('2026-10-16T00:00:00.000Z'),
    sessionCloseAt: new Date('2026-10-16T06:30:00.000Z'),
    evidenceDeadlineAt: new Date('2026-10-16T09:00:00.000Z'),
  };
  const locOrder = await db.order.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'canceled',
      quantity: '1',
      limitPrice: '1000',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      cancelReason: 'loc_close_not_reached',
      submittedAt: at(1_500),
      canceledAt: at(2_000),
    },
  });
  await db.limitOnCloseOrder.create({
    data: {
      orderId: locOrder.id,
      tradingAccountId: aliceGeneral.id,
      assetId: asset.id,
      ...locSession,
      status: 'unfilled',
      decisionReason: 'loc_close_not_reached',
      decidedAt: at(2_000),
      closeEvidenceId: evidence.id,
      closePrice: '1100',
    },
  });

  // Negative: an LOC that expired after its Season ended is Season cleanup.
  const endedSeason = await db.season.create({
    data: {
      name: `push-ended-${tag}`,
      status: 'ended',
      startAt: new Date(start.getTime() - 72 * HOUR),
      endAt: new Date(start.getTime() - 24 * HOUR),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  created.seasons.push(endedSeason.id);
  const bobEndedSeason = await account(bob.id, 'season', endedSeason.startAt);
  await db.seasonParticipant.create({
    data: {
      seasonId: endedSeason.id,
      userId: bob.id,
      tradingAccountId: bobEndedSeason.id,
      participantStatus: 'active',
      joinedAt: endedSeason.startAt,
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
      // Provisional values on an `ended` (not settled) Season: never final.
      finalRank: 1,
      finalTier: 'gold',
    },
  });
  const cleanupLoc = await db.order.create({
    data: {
      tradingAccountId: bobEndedSeason.id,
      assetId: asset.id,
      side: 'buy',
      orderType: 'limit',
      status: 'canceled',
      quantity: '1',
      limitPrice: '1000',
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      cancelReason: 'loc_fill_not_permitted',
      submittedAt: endedSeason.startAt,
      canceledAt: at(2_100),
    },
  });
  await db.limitOnCloseOrder.create({
    data: {
      orderId: cleanupLoc.id,
      tradingAccountId: bobEndedSeason.id,
      assetId: asset.id,
      ...locSession,
      status: 'expired',
      decisionReason: 'loc_fill_not_permitted',
      decidedAt: at(2_100),
    },
  });

  // Positive: a conditional BUY whose retries ended in `failed`;
  // negative: one still `triggered` (retrying).
  const conditional = (status: 'failed' | 'triggered', key: string) =>
    db.conditionalBuyOrder.create({
      data: {
        tradingAccountId: aliceGeneral.id,
        assetId: asset.id,
        triggerCondition: 'at_or_below',
        triggerPrice: '900',
        executionType: 'market',
        quantity: '1',
        currencyCode: 'KRW',
        status,
        triggerSnapshotId: snapshot.id,
        triggeredAt: at(2_200),
        attemptCount: status === 'failed' ? 3 : 1,
        failureCode: 'INSUFFICIENT_CASH',
        terminalReason: status === 'failed' ? 'execution_failed' : null,
        endedAt: status === 'failed' ? at(2_300) : null,
        idempotencyKey: `${key}-${tag}`,
        requestHash: 'hash',
      },
    });
  const failedConditional = await conditional('failed', 'failed');
  await conditional('triggered', 'retrying');

  // Positive: one liquidation event.
  const liquidation = await db.futuresLiquidation.create({
    data: {
      tradingAccountId: aliceGeneral.id,
      marginMode: 'cross',
      evaluationAt: at(2_400),
      collateralAvailable: '100',
      preEquity: '5',
      maintenanceMargin: '10',
      estimatedCloseFee: '1',
      liquidationRequirement: '11',
      realizedPnl: '-50',
      feeAmount: '1',
      settledPnl: '-50',
      settledFee: '1',
      settledCash: '-51',
      bankruptcyShortfall: '0',
      walletBalanceBefore: '100',
      walletBalanceAfter: '49',
      executedAt: at(2_400),
    },
  });

  // Friend requests: bob → alice (kept), alice → carol (rejected later).
  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);
  const [low1, high1] = pair(alice.id, bob.id);
  const kept = await db.friendship.create({
    data: { lowUserId: low1, highUserId: high1, requesterUserId: bob.id },
  });
  const [low2, high2] = pair(alice.id, carol.id);
  const rejected = await db.friendship.create({
    data: { lowUserId: low2, highUserId: high2, requesterUserId: alice.id },
  });

  // Season final results: alice ranked, carol not qualified.
  const settled = await db.season.create({
    data: {
      name: `push-settled-${tag}`,
      status: 'settled',
      startAt: new Date(start.getTime() - 9 * 24 * HOUR),
      endAt: new Date(start.getTime() - 2 * 24 * HOUR),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3',
    },
  });
  created.seasons.push(settled.id);
  const finalParticipant = async (userId: string, qualified: boolean) => {
    const tradingAccount = await account(userId, 'season', settled.startAt);
    await db.seasonParticipant.create({
      data: {
        seasonId: settled.id,
        userId,
        tradingAccountId: tradingAccount.id,
        participantStatus: 'finished',
        joinedAt: settled.startAt,
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
        finalQualified: qualified,
        finalTradedInstrumentCount: qualified ? 5 : 1,
        finalRecognizedTurnoverKrw: qualified ? '30000000' : '100',
        finalRank: qualified ? 1 : null,
        finalTier: qualified ? 'gold' : null,
      },
    });
  };
  await finalParticipant(alice.id, true);
  await finalParticipant(carol.id, false);

  const accountIds = [...created.accounts];
  const financialBefore = await financialState(accountIds);

  // Devices: alice (two installs, one dead), bob, and an install bob used
  // and alice later signed in on (ownership moves to alice).
  const token = (name: string) => `ExponentPushToken[${tag}${name}]`;
  await devices.register(alice.id, { token: token('A1'), platform: 'ios' });
  await devices.register(alice.id, {
    token: token('DEAD'),
    platform: 'android',
  });
  await devices.register(bob.id, { token: token('B1'), platform: 'android' });
  await devices.register(bob.id, {
    token: token('SHARED'),
    platform: 'android',
  });
  await devices.register(alice.id, {
    token: token('SHARED'),
    platform: 'android',
  });
  const shared = await db.pushDevice.findUnique({
    where: { token: token('SHARED') },
  });
  check(
    shared?.userId === alice.id,
    'a re-registered token belongs to the new user only',
  );
  check(
    (await db.pushDevice.count({ where: { userId: bob.id } })) === 1,
    'the previous user keeps only their own device',
  );
  // Bob turns trade fills off; liquidations etc. stay on.
  await preferences.update(bob.id, { tradeFill: false });

  // A published important notice is pushed; a draft is not.
  const draft = await notices.create(
    { userId: operator.id, role: 'operator' },
    {
      title: '초안',
      summary: '발행 전',
      sections: [{ heading: 'h', paragraphs: ['p'] }],
      idempotencyKey: `draft-${tag}`,
    },
    {},
  );
  created.notices.push(draft.data.notice.id);
  const important = await notices.create(
    { userId: operator.id, role: 'operator' },
    {
      title: '서버 점검',
      summary: '10월 20일 02:00 점검',
      sections: [{ heading: '점검', paragraphs: ['02:00–03:00'] }],
      idempotencyKey: `notice-${tag}`,
    },
    {},
  );
  created.notices.push(important.data.notice.id);
  await notices.publish(
    { userId: operator.id, role: 'operator' },
    important.data.notice.id,
    { confirm: true },
    {},
  );

  // Two workers scanning the same window at once create each event once.
  const scanAt = new Date(start.getTime() + 60_000);
  await Promise.all([
    scanner.scan(scanAt, config),
    scanner.scan(scanAt, config),
  ]);
  const again = await scanner.scan(new Date(scanAt.getTime() + 1_000), config);
  check(
    Object.entries(again.created)
      .filter(([source]) => source !== 'season_ending_soon')
      .every(([, count]) => count === 0),
    'a rescan of the same events creates nothing',
  );

  const mine = [alice.id, bob.id, carol.id];
  let rows = await notificationsOf(mine);
  const keys = (userId: string) =>
    rows
      .filter((row) => row.userId === userId)
      .map((row) => row.sourceKey)
      .sort();
  const expectedAlice = [
    `conditional_buy:${failedConditional.id}`,
    `friend:${bob.id}:${kept.id}`,
    `futures_liquidation:${liquidation.id}`,
    `loc:${locOrder.id}`,
    `notice:${important.data.notice.id}`,
    `order:${aliceFill.id}`,
    `season_ending:${activeSeason.id}:${activeSeason.endAt.getTime()}`,
    `season_final:${settled.id}`,
  ].sort();
  assert.deepEqual(keys(alice.id), expectedAlice);
  assertions++;
  assert.deepEqual(
    keys(bob.id),
    [`notice:${important.data.notice.id}`, `order:${bobFill.id}`].sort(),
  );
  assertions++;
  assert.deepEqual(keys(carol.id), [`friend:${alice.id}:${rejected.id}`]);
  assertions++;
  check(
    rows.every((row) => row.status === 'pending'),
    'every new notification starts pending',
  );
  check(
    rows.every(
      (row) =>
        (row.data as { uid?: string }).uid === row.userId &&
        ((row.data as { accountId?: string }).accountId === undefined ||
          (row.data as { accountId?: string }).accountId ===
            row.tradingAccountId),
    ),
    'payload recipient and account match the row',
  );

  // The request is rejected before dispatch: no stale request push.
  await db.friendship.delete({ where: { id: rejected.id } });

  // Dispatch: alice's dead install is reported by Expo.
  ticketError = { [token('DEAD')]: 'DeviceNotRegistered' };
  const dispatchAt = new Date(scanAt.getTime() + 2_000);
  const summary = await dispatcher.dispatch(dispatchAt, config);
  check(summary.devicesRemoved === 1, 'a DeviceNotRegistered token is removed');
  check(
    (await db.pushDevice.findUnique({ where: { token: token('DEAD') } })) ===
      null,
    'the dead device row is gone',
  );
  rows = await notificationsOf(mine);
  const statusOf = (sourceKey: string, userId: string) =>
    rows.find((row) => row.sourceKey === sourceKey && row.userId === userId);
  for (const key of expectedAlice)
    check(
      statusOf(key, alice.id)?.status === 'sent',
      `alice ${key.split(':')[0]} sent`,
    );
  check(
    statusOf(`order:${bobFill.id}`, bob.id)?.skipReason ===
      'preference_disabled',
    'a type turned off is not sent',
  );
  check(
    statusOf(`notice:${important.data.notice.id}`, bob.id)?.status === 'sent',
    'other types stay on',
  );
  check(
    statusOf(`friend:${alice.id}:${rejected.id}`, carol.id)?.skipReason ===
      'source_invalid',
    'a rejected request is not announced',
  );

  // Isolation: every message went to a device its recipient owned.
  const owners = new Map([
    [token('A1'), alice.id],
    [token('DEAD'), alice.id],
    [token('SHARED'), alice.id],
    [token('B1'), bob.id],
  ]);
  check(
    sent.length > 0 && sent.every((m) => owners.get(m.to) === m.data.uid),
    'no notification reached another user’s device',
  );
  check(
    !sent.some((m) => m.to === token('SHARED') && m.data.uid === bob.id),
    'the previous user’s pushes never reach a switched device',
  );
  check(
    !sent.some((m) => JSON.stringify(m.data).includes('price')),
    'payloads carry ids, never prices',
  );
  const deliveries = await db.pushDelivery.count({
    where: { notification: { userId: { in: mine } } },
  });
  check(deliveries === sent.length, 'one delivery row per message');

  // A transport outage retries later and records no delivery.
  const before = sent.length;
  await db.pushNotification.create({
    data: {
      userId: alice.id,
      type: 'trade_fill',
      sourceKey: `manual:${tag}:outage`,
      title: 't',
      body: 'b',
      data: { v: 1, type: 'trade_fill', uid: alice.id },
      eventAt: dispatchAt,
      expiresAt: new Date(dispatchAt.getTime() + HOUR),
      nextAttemptAt: dispatchAt,
    },
  });
  failTransport = true;
  await dispatcher.dispatch(new Date(dispatchAt.getTime() + 1), config);
  failTransport = false;
  const outage = await db.pushNotification.findFirstOrThrow({
    where: { sourceKey: `manual:${tag}:outage` },
  });
  check(
    outage.status === 'pending' &&
      outage.lastErrorCode === 'EXPO_TRANSPORT_ERROR' &&
      outage.nextAttemptAt > dispatchAt,
    'a push outage is retried with backoff',
  );
  check(sent.length === before, 'nothing was delivered during the outage');

  // Two dispatchers never claim the same row.
  await db.pushNotification.createMany({
    // A type bob keeps on and that has no source re-check.
    data: Array.from({ length: 40 }, (_, index) => ({
      userId: bob.id,
      type: 'futures_liquidation' as const,
      sourceKey: `manual:${tag}:claim:${index}`,
      title: 't',
      body: 'b',
      data: { v: 1, type: 'futures_liquidation', uid: bob.id, marker: index },
      eventAt: dispatchAt,
      expiresAt: new Date(dispatchAt.getTime() + HOUR),
      nextAttemptAt: dispatchAt,
    })),
  });
  const claimAt = new Date(dispatchAt.getTime() + 5);
  sent.length = 0;
  await Promise.all([
    dispatcher.dispatch(claimAt, { ...config, dispatchBatchSize: 25 }),
    dispatcher.dispatch(claimAt, { ...config, dispatchBatchSize: 25 }),
  ]);
  const markers = sent
    .map((m) => m.data.marker)
    .filter((marker) => typeof marker === 'number');
  check(markers.length === 40, 'every claimed row was sent');
  check(
    new Set(markers).size === 40,
    'no row was sent twice by concurrent workers',
  );

  // A device released (logout) while its push is in flight: the outcome is
  // still recorded, so nothing is resent after the lease.
  await devices.register(bob.id, {
    token: token('INFLIGHT'),
    platform: 'android',
  });
  const inflightAt = new Date(claimAt.getTime() + 5);
  await db.pushNotification.create({
    data: {
      userId: bob.id,
      type: 'futures_liquidation',
      sourceKey: `manual:${tag}:inflight`,
      title: 't',
      body: 'b',
      data: { v: 1, type: 'futures_liquidation', uid: bob.id },
      eventAt: inflightAt,
      expiresAt: new Date(inflightAt.getTime() + HOUR),
      nextAttemptAt: inflightAt,
    },
  });
  releaseDuringSend = token('INFLIGHT');
  await dispatcher.dispatch(inflightAt, config);
  releaseDuringSend = null;
  const inflight = await db.pushNotification.findFirstOrThrow({
    where: { sourceKey: `manual:${tag}:inflight` },
  });
  check(
    inflight.status === 'sent' && inflight.claimedUntil === null,
    'a device released mid-send never leaves its row to be resent',
  );
  const inflightDeliveries = await db.pushDelivery.findMany({
    where: { notificationId: inflight.id },
    include: { device: { select: { token: true } } },
  });
  check(
    inflightDeliveries.length === 2 &&
      inflightDeliveries.some((d) => d.deviceId === null) &&
      inflightDeliveries.some((d) => d.device?.token === token('B1')),
    'the released device loses only its own link; the other keeps it',
  );

  // Receipts: one ticket later reports DeviceNotRegistered.
  const aliceDelivery = await db.pushDelivery.findFirstOrThrow({
    where: { device: { token: token('A1') }, status: 'ticket_ok' },
  });
  await db.pushDevice.update({
    where: { token: token('A1') },
    data: { registeredAt: new Date(start.getTime() - HOUR) },
  });
  await db.pushDelivery.updateMany({
    where: { status: 'ticket_ok', notification: { userId: { in: mine } } },
    data: { createdAt: new Date(start.getTime() - 20 * 60_000) },
  });
  receiptError = { [aliceDelivery.ticketId!]: 'DeviceNotRegistered' };
  const receipts = await dispatcher.checkReceipts(dispatchAt, config);
  check(receipts.error >= 1 && receipts.ok >= 1, 'receipts are resolved');
  check(
    (await db.pushDevice.findUnique({ where: { token: token('A1') } })) ===
      null,
    'a receipt DeviceNotRegistered removes the device',
  );

  // Release proves possession of the token and never leaks whether it existed.
  const released = await devices.release({ token: token('B1') });
  const unknown = await devices.release({ token: token('NEVER') });
  check(
    JSON.stringify(released) === JSON.stringify(unknown),
    'release answers alike',
  );
  check(
    (await db.pushDevice.count({ where: { userId: bob.id } })) === 0,
    'release removes the registration',
  );

  // Withdrawn notices stop unsent pushes; the draft was never pushed.
  check(
    !rows.some((row) => row.sourceKey === `notice:${draft.data.notice.id}`),
    'a draft notice is never pushed',
  );

  // Retention removes old rows and their deliveries.
  const old = await db.pushNotification.create({
    data: {
      userId: alice.id,
      type: 'trade_fill',
      sourceKey: `manual:${tag}:old`,
      title: 't',
      body: 'b',
      data: { v: 1 },
      status: 'sent',
      sentAt: new Date(start.getTime() - 40 * 24 * HOUR),
      eventAt: new Date(start.getTime() - 40 * 24 * HOUR),
      expiresAt: new Date(start.getTime() - 39 * 24 * HOUR),
      nextAttemptAt: new Date(start.getTime() - 40 * 24 * HOUR),
      createdAt: new Date(start.getTime() - 40 * 24 * HOUR),
      deliveries: { create: { status: 'ticket_ok', ticketId: 'old-ticket' } },
    },
  });
  check(
    (await dispatcher.prune(start, config)) >= 1,
    'retention prunes old rows',
  );
  check(
    (await db.pushNotification.findUnique({ where: { id: old.id } })) ===
      null &&
      (await db.pushDelivery.count({ where: { notificationId: old.id } })) ===
        0,
    'deliveries go with their notification',
  );

  // Database CHECKs back the state machine.
  await assert.rejects(
    db.pushNotification.create({
      data: {
        userId: alice.id,
        type: 'trade_fill',
        sourceKey: `manual:${tag}:bad`,
        title: 't',
        body: 'b',
        data: { v: 1 },
        status: 'skipped',
        eventAt: start,
        expiresAt: new Date(start.getTime() + 1),
        nextAttemptAt: start,
      },
    }),
  );
  await assert.rejects(
    db.pushDevice.create({
      data: {
        userId: alice.id,
        token: 'not-a-token',
        platform: 'ios',
        registeredAt: start,
      },
    }),
  );
  assertions += 2;

  check(
    (await financialState(accountIds)) === financialBefore,
    'no order, LOC, conditional, liquidation, participant or friendship row changed',
  );
}

async function cleanup() {
  await db.pushScanCursor.deleteMany({});
  await db.pushNotification.deleteMany({
    where: { userId: { in: created.users } },
  });
  await db.pushDevice.deleteMany({ where: { userId: { in: created.users } } });
  await db.notificationPreference.deleteMany({
    where: { userId: { in: created.users } },
  });
  await db.importantNotice.deleteMany({
    where: { id: { in: created.notices } },
  });
  await db.operatorAuditLog.deleteMany({
    where: { actorUserId: { in: created.users } },
  });
  await db.friendship.deleteMany({
    where: {
      OR: [
        { lowUserId: { in: created.users } },
        { highUserId: { in: created.users } },
      ],
    },
  });
  await db.limitOnCloseOrder.deleteMany({
    where: { tradingAccountId: { in: created.accounts } },
  });
  await db.conditionalBuyOrder.deleteMany({
    where: { tradingAccountId: { in: created.accounts } },
  });
  await db.order.deleteMany({
    where: { tradingAccountId: { in: created.accounts } },
  });
  await db.futuresLiquidation.deleteMany({
    where: { tradingAccountId: { in: created.accounts } },
  });
  await db.seasonParticipant.deleteMany({
    where: { seasonId: { in: created.seasons } },
  });
  await db.tradingAccount.deleteMany({
    where: { id: { in: created.accounts } },
  });
  await db.season.deleteMany({ where: { id: { in: created.seasons } } });
  await db.sessionClosePriceEvidence.deleteMany({
    where: { assetId: { in: created.assets } },
  });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: created.assets } },
  });
  await db.asset.deleteMany({ where: { id: { in: created.assets } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
}

run()
  .then(() => {
    console.log(`push notifications PostgreSQL ok (${assertions} assertions)`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
    }
  });
