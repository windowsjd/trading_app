import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for 작업 5 보완 1 + 보완 2.
 *
 * 보완 2 (committed replay first): a market create that already COMMITTED
 * must replay its stored first response even after the account was suspended
 * or closed, the season ended, or the participant was excluded — while an
 * unknown key still hits every gate. This needs real committed state, so it
 * cannot be established with mocks.
 *
 * 보완 1 (cancel scope classification): the account-scoped cancel must
 * distinguish another user's order and another account's order (both 404)
 * from the caller's OWN order whose trading-account scope is null or
 * corrupted (500), and must change neither order status nor reservedAmount
 * on any of the error paths.
 *
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev DB
 * (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Market replay + cancel scope DB integration', () => {
  itDbIntegration(
    'verifies committed market-order replay and account-scoped cancel classification against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(getPnpmCommand(), ['tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 240_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'Market replay / cancel scope DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain(
        'order replay and cancel scope db integration ok',
      );
    },
    260_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(
    getPnpmCommand(),
    ['run', '--silent', 'test:db:prepare'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        'Market replay / cancel scope DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderStatus,
  ParticipantStatus,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { OrderReservationService } from './src/orders/order-reservation.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';

process.env.LIMIT_ORDER_ENABLED = 'true';

const TEST_PREFIX = 'order-replay-scope-db';
const ZERO = '0.00000000';
const CAPITAL = '10000000.00000000';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const reservation = new OrderReservationService();
const limitCreate = new LimitOrderCreateService(prisma, reservation);
const limitCancel = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(prisma, undefined, limitCreate, limitCancel, access);

const createdUserIds = [];
const createdSeasonIds = [];
const createdAssetIds = [];
// FX rate snapshots are GLOBAL rows, not user-scoped: leaving a fresh one
// behind would make the FX suite's "stale rate" case find a fresh rate.
const createdFxSnapshotIds = [];

async function expectHttpError(promise, status, code, label) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse();
    assert.equal(error.getStatus(), status, label + ' status');
    assert.equal(body && body.error ? body.error.code : undefined, code, label + ' code');
    return;
  }
  assert.fail(label + ': expected HttpException ' + code);
}

async function createUser(label) {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: TEST_PREFIX + '-' + label + '-' + suffix,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function createSeason(label) {
  const now = new Date();
  const season = await prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + randomUUID().slice(0, 8),
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 60000),
      endAt: new Date(now.getTime() + 86400000),
      initialCapitalKrw: CAPITAL,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  createdSeasonIds.push(season.id);
  return season.id;
}

/** Season account with USD cash, mirroring the market-execute fixtures. */
async function createScenario(label, options) {
  const opts = options || {};
  const userId = opts.userId || (await createUser(label));
  const seasonId = opts.seasonId || (await createSeason(label));
  const now = new Date();
  const account = await prisma.tradingAccount.create({
    data: {
      userId,
      mode: TradingAccountMode.season,
      status: TradingAccountStatus.active,
      initialCapitalKrw: CAPITAL,
      openedAt: now,
    },
    select: { id: true },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId,
      userId,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: CAPITAL,
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: account.id,
    },
    select: { id: true },
  });
  const krwWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: account.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: CAPITAL,
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  const usdWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: account.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: '1000.00000000',
      reservedAmount: ZERO,
    },
    select: { id: true },
  });

  return {
    userId,
    seasonId,
    accountId: account.id,
    participantId: participant.id,
    krwWalletId: krwWallet.id,
    usdWalletId: usdWallet.id,
  };
}

async function createUsdCryptoAsset(label) {
  const asset = await prisma.asset.create({
    data: {
      symbol: 'R' + randomUUID().replace(/-/gu, '').slice(0, 19).toUpperCase(),
      name: TEST_PREFIX + '-' + label,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  createdAssetIds.push(asset.id);
  return asset.id;
}

async function refreshMarketPrices(assetId) {
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId,
      price: '100.00000000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_ticker',
      sourceTimestamp: new Date(Date.now() - 1000),
      effectiveAt: new Date(Date.now() - 1000),
      capturedAt: new Date(Date.now() - 1000),
      note: TEST_PREFIX,
    },
  });
  const fxSnapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1000.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      sourceTimestamp: new Date(Date.now() - 1000),
      effectiveAt: new Date(Date.now() - 1000),
      capturedAt: new Date(Date.now() - 1000),
      note: TEST_PREFIX,
    },
    select: { id: true },
  });
  createdFxSnapshotIds.push(fxSnapshot.id);
}

async function marketBuy(scenario, assetId, idempotencyKey, quantity) {
  await refreshMarketPrices(assetId);
  const body = {
    assetId,
    side: 'buy',
    orderType: 'market',
    quantity: quantity || '1',
  };
  const quote = await orders.quoteOrderForTradingAccount(
    scenario.userId,
    scenario.accountId,
    body,
  );
  const created = await orders.createOrderForTradingAccount(
    scenario.userId,
    scenario.accountId,
    Object.assign({}, body, { quoteId: quote.data.quoteId, idempotencyKey }),
  );
  return { body, quoteId: quote.data.quoteId, created };
}

async function financialFingerprint(scenario) {
  const [wallets, ledger, positions, orderCount] = await Promise.all([
    prisma.cashWallet.findMany({
      where: { tradingAccountId: scenario.accountId },
      orderBy: { currencyCode: 'asc' },
      select: { currencyCode: true, balanceAmount: true, reservedAmount: true },
    }),
    prisma.walletTransaction.count({ where: { tradingAccountId: scenario.accountId } }),
    prisma.position.findMany({
      where: { tradingAccountId: scenario.accountId },
      orderBy: { assetId: 'asc' },
      select: { assetId: true, quantity: true, averageCost: true },
    }),
    prisma.order.count({ where: { tradingAccountId: scenario.accountId } }),
  ]);
  return JSON.stringify({
    wallets: wallets.map((w) => [w.currencyCode, w.balanceAmount.toFixed(8), w.reservedAmount.toFixed(8)]),
    ledger,
    positions: positions.map((p) => [p.assetId, p.quantity.toFixed(8), p.averageCost.toFixed(8)]),
    orderCount,
  });
}

// ------------------------------------------------- 보완 2: market replay

async function verifyCommittedMarketReplay() {
  const scenario = await createScenario('replay');
  const assetId = await createUsdCryptoAsset('replay');
  const key = 'market-key-' + randomUUID().slice(0, 8);

  const first = await marketBuy(scenario, assetId, key);
  const orderId = first.created.data.order.orderId;
  assert.equal(first.created.data.order.status, OrderStatus.executed);

  // The first response is persisted INSIDE the create+execute transaction.
  const stored = await prisma.order.findUnique({
    where: { id: orderId },
    select: { responsePayloadJson: true, requestHash: true, idempotencyKey: true },
  });
  assert.ok(stored.responsePayloadJson, 'responsePayloadJson must be stored atomically');
  assert.equal(stored.idempotencyKey, key);
  assert.equal(
    JSON.stringify(stored.responsePayloadJson.data.order.orderId),
    JSON.stringify(orderId),
  );

  const afterFirst = await financialFingerprint(scenario);
  const retryBody = Object.assign({}, first.body, {
    quoteId: first.quoteId,
    idempotencyKey: key,
  });

  // A retry under UNCHANGED state already replays the stored payload.
  const plainReplay = await orders.createOrderForTradingAccount(
    scenario.userId,
    scenario.accountId,
    retryBody,
  );
  assert.equal(plainReplay.data.order.orderId, orderId);
  assert.equal(await financialFingerprint(scenario), afterFirst, 'replay changed state');

  // Each of these would REFUSE a new order. A committed one still replays.
  const stateChanges = [
    {
      label: 'account suspended',
      apply: () =>
        prisma.tradingAccount.update({
          where: { id: scenario.accountId },
          data: { status: TradingAccountStatus.suspended },
        }),
      revert: () =>
        prisma.tradingAccount.update({
          where: { id: scenario.accountId },
          data: { status: TradingAccountStatus.active },
        }),
    },
    {
      label: 'account closed',
      apply: () =>
        prisma.tradingAccount.update({
          where: { id: scenario.accountId },
          data: { status: TradingAccountStatus.closed },
        }),
      revert: () =>
        prisma.tradingAccount.update({
          where: { id: scenario.accountId },
          data: { status: TradingAccountStatus.active },
        }),
    },
    {
      label: 'season ended',
      apply: () =>
        prisma.season.update({
          where: { id: scenario.seasonId },
          data: { status: SeasonStatus.ended },
        }),
      revert: () =>
        prisma.season.update({
          where: { id: scenario.seasonId },
          data: { status: SeasonStatus.active },
        }),
    },
    {
      label: 'participant excluded',
      apply: () =>
        prisma.seasonParticipant.update({
          where: { id: scenario.participantId },
          data: { participantStatus: ParticipantStatus.excluded },
        }),
      revert: () =>
        prisma.seasonParticipant.update({
          where: { id: scenario.participantId },
          data: { participantStatus: ParticipantStatus.active },
        }),
    },
    {
      label: 'asset delisted (market unavailable)',
      apply: () => prisma.asset.update({ where: { id: assetId }, data: { isActive: false } }),
      revert: () => prisma.asset.update({ where: { id: assetId }, data: { isActive: true } }),
    },
  ];

  for (const change of stateChanges) {
    await change.apply();
    const replay = await orders.createOrderForTradingAccount(
      scenario.userId,
      scenario.accountId,
      retryBody,
    );
    assert.equal(
      replay.data.order.orderId,
      orderId,
      'replay after ' + change.label + ' must return the first order',
    );
    assert.equal(
      await financialFingerprint(scenario),
      afterFirst,
      'replay after ' + change.label + ' must not move money, positions, or orders',
    );
    await change.revert();
  }

  // Same key + DIFFERENT request is still a conflict, not a silent new order.
  await expectHttpError(
    orders.createOrderForTradingAccount(
      scenario.userId,
      scenario.accountId,
      Object.assign({}, retryBody, { quantity: '2' }),
    ),
    409,
    'ORDER_IDEMPOTENCY_CONFLICT',
    'same key different payload',
  );
  assert.equal(await financialFingerprint(scenario), afterFirst);

  // Another user cannot reach this account at all.
  const strangerId = await createUser('stranger');
  await expectHttpError(
    orders.createOrderForTradingAccount(strangerId, scenario.accountId, retryBody),
    404,
    'TRADING_ACCOUNT_NOT_FOUND',
    'foreign account replay',
  );

  return { scenario, assetId, key, orderId, afterFirst };
}

async function verifyGatesStillBlockNewOrders(assetId) {
  // Suspended account, no committed order for this key.
  const suspended = await createScenario('suspended');
  await prisma.tradingAccount.update({
    where: { id: suspended.accountId },
    data: { status: TradingAccountStatus.suspended },
  });
  await refreshMarketPrices(assetId);
  await expectHttpError(
    orders.createOrderForTradingAccount(suspended.userId, suspended.accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1',
      quoteId: randomUUID(),
      idempotencyKey: 'blocked-' + randomUUID().slice(0, 8),
    }),
    409,
    'TRADING_ACCOUNT_NOT_ACTIVE',
    'new order on a suspended account',
  );
  assert.equal(
    await prisma.order.count({ where: { tradingAccountId: suspended.accountId } }),
    0,
  );

  // Ended season, no committed order for this key.
  const ended = await createScenario('ended');
  await prisma.season.update({
    where: { id: ended.seasonId },
    data: { status: SeasonStatus.ended },
  });
  await expectHttpError(
    orders.createOrderForTradingAccount(ended.userId, ended.accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1',
      quoteId: randomUUID(),
      idempotencyKey: 'blocked-' + randomUUID().slice(0, 8),
    }),
    409,
    'SEASON_NOT_ACTIVE',
    'new order in an ended season',
  );
  assert.equal(
    await prisma.order.count({ where: { tradingAccountId: ended.accountId } }),
    0,
  );
}

async function verifyCrossAccountKeyReuse(assetId, key) {
  const other = await createScenario('other-account');
  const created = await marketBuy(other, assetId, key);
  assert.equal(created.created.data.order.status, OrderStatus.executed);
  assert.equal(
    await prisma.order.count({ where: { tradingAccountId: other.accountId } }),
    1,
    'the same key on a DIFFERENT account creates its own order',
  );
}

// -------------------------------------------- 보완 1: cancel classification

async function createSubmittedLimitBuy(scenario, assetId, label) {
  const body = {
    assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: '2',
    limitPrice: '100',
  };
  const quote = await orders.quoteOrderForTradingAccount(
    scenario.userId,
    scenario.accountId,
    body,
  );
  const created = await orders.createOrderForTradingAccount(
    scenario.userId,
    scenario.accountId,
    Object.assign({}, body, {
      quoteId: quote.data.quoteId,
      idempotencyKey: label + '-' + randomUUID().slice(0, 8),
    }),
  );
  return created.data.order.orderId;
}

async function orderAndWalletState(orderId, walletId) {
  const [order, wallet] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, canceledAt: true, reservationReleasedAt: true },
    }),
    prisma.cashWallet.findUnique({
      where: { id: walletId },
      select: { balanceAmount: true, reservedAmount: true },
    }),
  ]);
  return JSON.stringify({
    status: order.status,
    canceledAt: order.canceledAt,
    reservationReleasedAt: order.reservationReleasedAt,
    balance: wallet.balanceAmount.toFixed(8),
    reserved: wallet.reservedAmount.toFixed(8),
  });
}

async function verifyCancelScopeClassification() {
  const owner = await createScenario('cancel-owner');
  const second = await createScenario('cancel-second', {
    userId: owner.userId,
    seasonId: await createSeason('cancel-second-season'),
  });
  const stranger = await createScenario('cancel-stranger');
  const assetId = await createUsdCryptoAsset('cancel');
  // A bare owned account with NO wallets, used as the "third account" for
  // the mismatch cases (moving a wallet onto an account that already has one
  // of that currency would trip the (account, currency) unique instead).
  const foilAccount = await prisma.tradingAccount.create({
    data: {
      userId: owner.userId,
      mode: TradingAccountMode.season,
      status: TradingAccountStatus.active,
      initialCapitalKrw: CAPITAL,
      openedAt: new Date(),
    },
    select: { id: true },
  });

  // 1) A normal own-account cancel still works end to end.
  const happyOrderId = await createSubmittedLimitBuy(owner, assetId, 'happy');
  const happy = await orders.cancelOrderForTradingAccount(
    owner.userId,
    owner.accountId,
    happyOrderId,
  );
  assert.equal(happy.data.execution.alreadyCanceled, false);
  assert.equal(
    (await prisma.order.findUnique({ where: { id: happyOrderId }, select: { status: true } })).status,
    OrderStatus.canceled,
  );
  assert.equal(
    (await prisma.cashWallet.findUnique({ where: { id: owner.usdWalletId }, select: { reservedAmount: true } })).reservedAmount.toFixed(8),
    ZERO,
  );

  // 2) Unknown orderId → 404.
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, randomUUID()),
    404,
    'ORDER_NOT_FOUND',
    'unknown orderId',
  );

  // 3) Another USER's order → 404 (no existence oracle).
  const strangerOrderId = await createSubmittedLimitBuy(stranger, assetId, 'stranger');
  const strangerStateBefore = await orderAndWalletState(strangerOrderId, stranger.usdWalletId);
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, strangerOrderId),
    404,
    'ORDER_NOT_FOUND',
    "another user's order",
  );
  assert.equal(
    await orderAndWalletState(strangerOrderId, stranger.usdWalletId),
    strangerStateBefore,
  );
  // The legacy cancel keeps the same 404 contract for another user's order.
  await expectHttpError(
    orders.cancelOrder(owner.userId, strangerOrderId),
    404,
    'ORDER_NOT_FOUND',
    'legacy cancel of another user order',
  );
  assert.equal(
    await orderAndWalletState(strangerOrderId, stranger.usdWalletId),
    strangerStateBefore,
  );

  // 4) The caller's own NORMAL order on a DIFFERENT account → 404.
  const secondOrderId = await createSubmittedLimitBuy(second, assetId, 'second');
  const secondStateBefore = await orderAndWalletState(secondOrderId, second.usdWalletId);
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, secondOrderId),
    404,
    'ORDER_NOT_FOUND',
    "own order on another account",
  );
  assert.equal(
    await orderAndWalletState(secondOrderId, second.usdWalletId),
    secondStateBefore,
  );

  // 5) The caller's OWN order with a NULL scope must NOT hide behind a 404.
  const nullScopeOrderId = await createSubmittedLimitBuy(owner, assetId, 'null-scope');
  await prisma.order.update({
    where: { id: nullScopeOrderId },
    data: { tradingAccountId: null },
  });
  const nullStateBefore = await orderAndWalletState(nullScopeOrderId, owner.usdWalletId);
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, nullScopeOrderId),
    500,
    'TRADING_SCOPE_REPAIR_REQUIRED',
    'own null-scope order',
  );
  assert.equal(
    await orderAndWalletState(nullScopeOrderId, owner.usdWalletId),
    nullStateBefore,
    'null-scope error must leave status and reservedAmount untouched',
  );
  // The legacy cancel is fail-closed on the same row.
  await expectHttpError(
    orders.cancelOrder(owner.userId, nullScopeOrderId),
    500,
    'TRADING_SCOPE_REPAIR_REQUIRED',
    'legacy cancel of a null-scope order',
  );
  assert.equal(
    await orderAndWalletState(nullScopeOrderId, owner.usdWalletId),
    nullStateBefore,
  );

  // 6) The caller's OWN order scoped to a THIRD account → mismatch, not 404.
  await prisma.order.update({
    where: { id: nullScopeOrderId },
    data: { tradingAccountId: foilAccount.id },
  });
  const mismatchStateBefore = await orderAndWalletState(nullScopeOrderId, owner.usdWalletId);
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, nullScopeOrderId),
    500,
    'TRADING_ACCOUNT_SCOPE_MISMATCH',
    'own mis-scoped order',
  );
  assert.equal(
    await orderAndWalletState(nullScopeOrderId, owner.usdWalletId),
    mismatchStateBefore,
    'mismatch error must leave status and reservedAmount untouched',
  );
  await prisma.order.update({
    where: { id: nullScopeOrderId },
    data: { tradingAccountId: owner.accountId },
  });

  // 7) Wallet scope null / mismatch fail closed and release nothing.
  const walletStateBefore = await orderAndWalletState(nullScopeOrderId, owner.usdWalletId);
  await prisma.cashWallet.update({
    where: { id: owner.usdWalletId },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, nullScopeOrderId),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'null wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: owner.usdWalletId },
    data: { tradingAccountId: foilAccount.id },
  });
  await expectHttpError(
    orders.cancelOrderForTradingAccount(owner.userId, owner.accountId, nullScopeOrderId),
    500,
    'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    'mismatched wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: owner.usdWalletId },
    data: { tradingAccountId: owner.accountId },
  });
  assert.equal(
    await orderAndWalletState(nullScopeOrderId, owner.usdWalletId),
    walletStateBefore,
    'wallet scope errors must roll the whole cancel back',
  );

  // 8) With everything repaired, the same order cancels normally.
  const repaired = await orders.cancelOrderForTradingAccount(
    owner.userId,
    owner.accountId,
    nullScopeOrderId,
  );
  assert.equal(repaired.data.execution.alreadyCanceled, false);
  assert.equal(
    (await prisma.order.findUnique({ where: { id: nullScopeOrderId }, select: { status: true } })).status,
    OrderStatus.canceled,
  );
}

async function cleanup() {
  const participants = await prisma.seasonParticipant.findMany({
    where: { userId: { in: createdUserIds } },
    select: { id: true },
  });
  const participantIds = participants.map((p) => p.id);
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId: { in: createdUserIds } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  await prisma.walletTransaction.deleteMany({
    where: { OR: [{ seasonParticipantId: { in: participantIds } }, { tradingAccountId: { in: accountIds } }] },
  });
  await prisma.order.deleteMany({ where: { seasonParticipantId: { in: participantIds } } });
  await prisma.position.deleteMany({ where: { seasonParticipantId: { in: participantIds } } });
  await prisma.quote.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.equitySnapshot.deleteMany({ where: { seasonParticipantId: { in: participantIds } } });
  await prisma.cashWallet.deleteMany({
    where: { OR: [{ seasonParticipantId: { in: participantIds } }, { tradingAccountId: { in: accountIds } }] },
  });
  await prisma.seasonParticipant.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.tradingAccount.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.assetPriceSnapshot.deleteMany({ where: { assetId: { in: createdAssetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
  await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: createdFxSnapshotIds } } });
  await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

async function main() {
  try {
    const replay = await verifyCommittedMarketReplay();
    await verifyGatesStillBlockNewOrders(replay.assetId);
    await verifyCrossAccountKeyReuse(replay.assetId, replay.key);
    await verifyCancelScopeClassification();
    console.log('order replay and cancel scope db integration ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
