import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL proof for the complete general-account trading lifecycle.
 * It applies existing migrations only and creates/cleans uniquely tagged rows;
 * it never resets, drops, or seeds the database.
 */
const RUN_DB_INTEGRATION = process.env.GENERAL_TRADING_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('General account trading DB integration', () => {
  itDbIntegration(
    'executes market and limit orders through the shared account core',
    () => {
      const prepare = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['run', '--silent', 'test:db:prepare'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      if (prepare.status !== 0) {
        throw new Error(
          [
            'General trading DB prepare failed.',
            prepare.stdout,
            prepare.stderr,
          ].join('\n'),
        );
      }

      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', '-e', GENERAL_TRADING_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          [
            'General trading DB runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      expect(result.stdout).toContain('general trading db integration ok');
    },
    320_000,
  );
});

const GENERAL_TRADING_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  OrderStatus,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  SnapshotReason,
  TradingAccountMode,
  TradingAccountStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from './src/trading-accounts/general-accounts.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from './src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from './src/portfolio/general-account-performance.service';
import { OrdersService } from './src/orders/orders.service';
import { OrderReservationService } from './src/orders/order-reservation.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { LimitOrderCandleEvidenceService } from './src/orders/limit-order-candle-evidence.service';
import { LimitOrderExecutionService } from './src/orders/limit-order-execution.service';
import { PositionsService } from './src/positions/positions.service';
import { getAssetTradingStatus } from './src/orders/market-hours.policy';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from './src/orders/market-calendar/market-session-override.store';

process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const externalFunding = new GeneralExternalFundingService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  externalFunding,
);
const generalAccounts = new GeneralAccountsService(prisma, performance);
const reservation = new OrderReservationService();
const limitCreate = new LimitOrderCreateService(prisma, reservation);
const limitCancel = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(
  prisma,
  undefined,
  limitCreate,
  limitCancel,
  access,
  performance,
);
const candleEvidence = new LimitOrderCandleEvidenceService(prisma);
const limitExecution = new LimitOrderExecutionService(
  prisma,
  candleEvidence,
  orders,
  performance,
);
const positions = new PositionsService(prisma, access);

const userIds = [];
const accountIds = [];
const assetIds = [];
const fxSnapshotIds = [];
const seasonIds = [];

function text(value) {
  return value == null ? null : value.toFixed(8);
}

function codeOf(error) {
  assert.ok(error instanceof HttpException, 'expected HttpException');
  return error.getResponse().error.code;
}

async function expectCode(promise, expected) {
  try {
    await promise;
  } catch (error) {
    assert.equal(codeOf(error), expected);
    return;
  }
  assert.fail('expected ' + expected);
}

async function createUser(label) {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: 'general-trading-' + label + '-' + id + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: 'general-trading-' + label + '-' + id.slice(0, 8),
    },
  });
  userIds.push(id);
  return id;
}

async function openGeneral(userId) {
  const opened = await generalAccounts.openGeneralAccount(userId);
  accountIds.push(opened.data.account.id);
  return opened.data.account.id;
}

async function createPollutionParticipant(userId) {
  const now = new Date();
  const season = await prisma.season.create({
    data: {
      name: 'general-trading-pollution-' + randomUUID().slice(0, 8),
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '10000000.00000000',
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  seasonIds.push(season.id);
  const account = await prisma.tradingAccount.create({
    data: {
      userId,
      mode: TradingAccountMode.season,
      status: TradingAccountStatus.active,
      initialCapitalKrw: '10000000.00000000',
      openedAt: now,
    },
    select: { id: true },
  });
  accountIds.push(account.id);
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId,
      tradingAccountId: account.id,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '10000000.00000000',
      totalAssetKrw: '10000000.00000000',
      totalReturnRate: '0.00000000',
      maxDrawdown: '0.00000000',
    },
    select: { id: true },
  });
  return participant.id;
}

async function createAsset() {
  const asset = await prisma.asset.create({
    data: {
      symbol: 'GT' + randomUUID().replace(/-/gu, '').slice(0, 16).toUpperCase(),
      name: 'general-trading-integration',
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  assetIds.push(asset.id);
  return asset.id;
}

async function createDomesticAsset() {
  const asset = await prisma.asset.create({
    data: {
      symbol: 'KRW' + randomUUID().replace(/-/gu, '').slice(0, 16).toUpperCase(),
      name: 'general-trading-domestic-integration',
      market: 'KRX',
      assetType: AssetType.domestic_stock,
      currencyCode: CurrencyCode.KRW,
      priceCurrency: CurrencyCode.KRW,
      settlementCurrency: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });
  assetIds.push(asset.id);
  return asset.id;
}

async function price(
  assetId,
  amount,
  currencyCode = CurrencyCode.USD,
  sourceName = 'binance_public_rest_24hr_ticker',
) {
  const observedAt = new Date(Date.now() - 1_000);
  return prisma.assetPriceSnapshot.create({
    data: {
      assetId,
      price: amount,
      currencyCode,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName,
      effectiveAt: observedAt,
      capturedAt: observedAt,
    },
    select: { id: true },
  });
}

async function freshUsdKrwRate() {
  const observedAt = new Date(Date.now() - 1_000);
  const row = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1400.00000000',
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      effectiveAt: observedAt,
      capturedAt: observedAt,
    },
    select: { id: true },
  });
  fxSnapshotIds.push(row.id);
}

async function market(userId, accountId, assetId, side, quantity, key) {
  const request = { assetId, side, orderType: 'market', quantity };
  const quote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    request,
  );
  const body = {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: key,
  };
  return {
    body,
    response: await orders.createOrderForTradingAccount(
      userId,
      accountId,
      body,
    ),
  };
}

async function limit(userId, accountId, assetId, side, quantity, limitPrice, key) {
  const request = {
    assetId,
    side,
    orderType: 'limit',
    quantity,
    limitPrice,
  };
  const quote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    request,
  );
  const response = await orders.createOrderForTradingAccount(
    userId,
    accountId,
    {
      ...request,
      quoteId: quote.data.quoteId,
      idempotencyKey: key,
    },
  );
  return { quote, response };
}

async function cleanup() {
  resetMarketSessionOverrideStoreForTest();
  if (accountIds.length) {
    await prisma.limitOrderCandleEvidence.deleteMany({
      where: {
        orders: { some: { tradingAccountId: { in: accountIds } } },
      },
    });
    await prisma.walletTransaction.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.equitySnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.order.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.quote.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.seasonParticipant.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.tradingAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
  }
  if (seasonIds.length) {
    await prisma.season.deleteMany({ where: { id: { in: seasonIds } } });
  }
  if (assetIds.length) {
    await prisma.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  }
  if (fxSnapshotIds.length) {
    await prisma.fxRateSnapshot.deleteMany({
      where: { id: { in: fxSnapshotIds } },
    });
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function main() {
 try {
  await prisma.onModuleInit();
  const userId = await createUser('owner');
  const strangerId = await createUser('stranger');
  const accountId = await openGeneral(userId);
  // KRX and NAS regular sessions do not overlap, so at every real instant at
  // least one stock market supplies a deterministic closed-market assertion.
  const naturallyClosedMarket = [
    {
      assetType: AssetType.domestic_stock,
      market: 'KRX',
      currency: CurrencyCode.KRW,
    },
    {
      assetType: AssetType.us_stock,
      market: 'NAS',
      currency: CurrencyCode.USD,
    },
  ].find(
    (candidate) =>
      getAssetTradingStatus(candidate, new Date()).tradable === false,
  );
  assert.ok(naturallyClosedMarket, 'at least one stock market must be closed');
  const localDateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const localPart = (type) =>
    localDateParts.find((part) => part.type === type)?.value;
  const localDate =
    localPart('year') + '-' + localPart('month') + '-' + localPart('day');
  applyMarketSessionOverrideSnapshot(
    [
      {
        market: 'KRX',
        localDate,
        overrideType: 'custom',
        openTime: '000000',
        closeTime: '235959',
        reason: 'deterministic general trading integration session',
      },
    ],
    new Date(),
  );
  assert.deepEqual(
    getAssetTradingStatus(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      new Date(),
    ),
    { tradable: true },
  );

  // Explicit required scenario: a general account buys a domestic stock from
  // its existing KRW wallet and writes account-only order/ledger/position/TWR.
  const domesticAssetId = await createDomesticAsset();
  const domesticProviderSnapshot = await price(
    domesticAssetId,
    '70000.00000000',
    CurrencyCode.KRW,
    'kis_krx_realtime_trade',
  );
  // The runner is compiled from an eval module, so its test-only in-memory
  // market-session override is not shared with every tsx dependency module.
  // Keep valuation deterministic outside real KRX hours with the same-price
  // admin fallback; order quote/execute still prove provider_api selection.
  const domesticFallbackAt = new Date(Date.now() - 1_000);
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: domesticAssetId,
      price: '70000.00000000',
      currencyCode: CurrencyCode.KRW,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: 'general-trading-integration-fallback',
      effectiveAt: domesticFallbackAt,
      capturedAt: domesticFallbackAt,
    },
  });
  const domesticRequest = {
    assetId: domesticAssetId,
    side: 'buy',
    orderType: 'market',
    quantity: '10.000000',
  };
  const domesticQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    domesticRequest,
  );
  assert.equal(domesticQuote.data.feeRate, '0.001000');
  const storedDomesticQuote = await prisma.quote.findUniqueOrThrow({
    where: { id: domesticQuote.data.quoteId },
  });
  assert.equal(
    storedDomesticQuote.assetPriceSnapshotId,
    domesticProviderSnapshot.id,
  );
  assert.equal(storedDomesticQuote.quotedFeeRate?.toFixed(6), '0.001000');

  // A rolling deployment/config change after quote must not change the fill:
  // fee is pinned, while provider price keeps its execute-time repricing.
  process.env.GENERAL_TRADE_FEE_RATE = '0.002000';
  const domesticIdempotencyKey = 'domestic-fee-pinned-' + randomUUID();
  let domesticBuy;
  try {
    domesticBuy = {
      body: {
        ...domesticRequest,
        quoteId: domesticQuote.data.quoteId,
        idempotencyKey: domesticIdempotencyKey,
      },
      response: await orders.createOrderForTradingAccount(
        userId,
        accountId,
        {
          ...domesticRequest,
          quoteId: domesticQuote.data.quoteId,
          idempotencyKey: domesticIdempotencyKey,
        },
      ),
    };
  } finally {
    process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
  }
  const domesticOrderId = domesticBuy.response.data.order.orderId;
  assert.equal(domesticBuy.response.data.order.feeAmount, '700.00000000');
  assert.equal(domesticBuy.response.data.order.netAmount, '700700.00000000');
  const domesticOrder = await prisma.order.findUniqueOrThrow({
    where: { id: domesticOrderId },
  });
  assert.equal(domesticOrder.status, OrderStatus.executed);
  assert.equal(domesticOrder.tradingAccountId, accountId);
  assert.equal(domesticOrder.seasonParticipantId, null);
  assert.equal(text(domesticOrder.feeAmount), '700.00000000');
  const domesticWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: CurrencyCode.KRW,
      },
    },
  });
  assert.equal(text(domesticWallet.balanceAmount), '9299300.00000000');
  const domesticPosition = await prisma.position.findUniqueOrThrow({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: accountId,
        assetId: domesticAssetId,
      },
    },
  });
  assert.equal(domesticPosition.seasonParticipantId, null);
  assert.equal(text(domesticPosition.quantity), '10.00000000');
  const domesticLedger = await prisma.walletTransaction.findFirstOrThrow({
    where: { tradingAccountId: accountId, referenceId: domesticOrderId },
  });
  assert.equal(domesticLedger.seasonParticipantId, null);
  assert.equal(text(domesticLedger.amount), '700700.00000000');

  // A quote minted by the previous version has no general market fee pin.
  // The new server must require a requote instead of silently reading env.
  const legacyMarketQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    { ...domesticRequest, quantity: '1.000000' },
  );
  await prisma.quote.update({
    where: { id: legacyMarketQuote.data.quoteId },
    data: { quotedFeeRate: null },
  });
  await expectCode(
    orders.createOrderForTradingAccount(userId, accountId, {
      ...domesticRequest,
      quantity: '1.000000',
      quoteId: legacyMarketQuote.data.quoteId,
      idempotencyKey: 'legacy-null-fee-' + randomUUID(),
    }),
    'QUOTE_MISMATCH',
  );
  resetMarketSessionOverrideStoreForTest();

  const closedMarket = naturallyClosedMarket;
  const closedAsset = await prisma.asset.create({
    data: {
      symbol: 'GTCLOSED' + randomUUID().replace(/-/gu, '').slice(0, 10).toUpperCase(),
      name: 'general-trading-closed-market',
      market: closedMarket.market,
      assetType: closedMarket.assetType,
      currencyCode: closedMarket.currency,
      priceCurrency: closedMarket.currency,
      settlementCurrency: closedMarket.currency,
      isActive: true,
    },
    select: { id: true },
  });
  assetIds.push(closedAsset.id);
  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId: closedAsset.id,
      side: 'buy',
      orderType: 'market',
      quantity: '1.000000',
    }),
    'MARKET_CLOSED',
  );
  const assetId = await createAsset();
  await prisma.cashWallet.update({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: CurrencyCode.USD,
      },
    },
    data: { balanceAmount: '10000.00000000' },
  });
  await freshUsdKrwRate();

  await price(assetId, '100.00000000');
  const staleAt = new Date(Date.now() - 120_000);
  await prisma.assetPriceSnapshot.updateMany({
    where: { assetId },
    data: { effectiveAt: staleAt, capturedAt: staleAt },
  });
  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1.000000',
    }),
    'ASSET_PRICE_UNAVAILABLE',
  );
  await price(assetId, '100.00000000');

  const repriceRequest = {
    assetId,
    side: 'buy',
    orderType: 'market',
    quantity: '1.000000',
  };
  const repriceQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    repriceRequest,
  );
  await price(assetId, '110.00000000');
  await expectCode(
    orders.createOrderForTradingAccount(userId, accountId, {
      ...repriceRequest,
      quoteId: repriceQuote.data.quoteId,
      idempotencyKey: 'reprice-' + randomUUID(),
    }),
    'RATE_CHANGED_REQUOTE_REQUIRED',
  );
  await price(assetId, '100.00000000');

  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '1000000.000000',
      limitPrice: '100.00000000',
    }),
    'INSUFFICIENT_AVAILABLE_BALANCE',
  );
  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'sell',
      orderType: 'market',
      quantity: '1.000000',
    }),
    'INSUFFICIENT_QUANTITY',
  );

  const mismatchRequest = {
    assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: '1.000000',
    limitPrice: '90.00000000',
  };
  const mismatchQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    mismatchRequest,
  );
  await expectCode(
    orders.createOrderForTradingAccount(userId, accountId, {
      ...mismatchRequest,
      quantity: '2.000000',
      quoteId: mismatchQuote.data.quoteId,
      idempotencyKey: 'mismatch-' + randomUUID(),
    }),
    'QUOTE_MISMATCH',
  );
  const expiredQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    mismatchRequest,
  );
  await prisma.quote.update({
    where: { id: expiredQuote.data.quoteId },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  await expectCode(
    orders.createOrderForTradingAccount(userId, accountId, {
      ...mismatchRequest,
      quoteId: expiredQuote.data.quoteId,
      idempotencyKey: 'expired-' + randomUUID(),
    }),
    'QUOTE_EXPIRED',
  );

  const marketKey = 'market-' + randomUUID();
  const buy = await market(
    userId,
    accountId,
    assetId,
    'buy',
    '10.000000',
    marketKey,
  );
  assert.equal(buy.response.data.execution.state, 'executed');
  const buyOrderId = buy.response.data.order.orderId;
  const buyOrder = await prisma.order.findUnique({ where: { id: buyOrderId } });
  assert.equal(buyOrder.tradingAccountId, accountId);
  assert.equal(buyOrder.seasonParticipantId, null);
  assert.equal(text(buyOrder.grossAmount), '1000.00000000');
  assert.equal(text(buyOrder.feeAmount), '1.00000000');
  assert.equal(text(buyOrder.netAmount), '1001.00000000');

  const positionAfterBuy = await prisma.position.findUnique({
    where: { tradingAccountId_assetId: { tradingAccountId: accountId, assetId } },
  });
  assert.equal(positionAfterBuy.seasonParticipantId, null);
  assert.equal(text(positionAfterBuy.quantity), '10.00000000');
  const buyLedger = await prisma.walletTransaction.findFirst({
    where: { referenceId: buyOrderId },
  });
  assert.equal(buyLedger.tradingAccountId, accountId);
  assert.equal(buyLedger.seasonParticipantId, null);

  const beforeReplayWallet = await prisma.cashWallet.findUnique({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: CurrencyCode.USD,
      },
    },
  });
  const replay = await orders.createOrderForTradingAccount(
    userId,
    accountId,
    buy.body,
  );
  assert.equal(replay.data.order.orderId, buyOrderId);
  const afterReplayWallet = await prisma.cashWallet.findUnique({
    where: { id: beforeReplayWallet.id },
  });
  assert.equal(text(afterReplayWallet.balanceAmount), text(beforeReplayWallet.balanceAmount));

  const conflictQuote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    { assetId, side: 'buy', orderType: 'market', quantity: '1.000000' },
  );
  await expectCode(
    orders.createOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1.000000',
      quoteId: conflictQuote.data.quoteId,
      idempotencyKey: marketKey,
    }),
    'ORDER_IDEMPOTENCY_CONFLICT',
  );

  // Idempotency is account-scoped: the same key is valid on another owned
  // account and creates a distinct order/position.
  const strangerAccountId = await openGeneral(strangerId);
  await prisma.cashWallet.update({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: strangerAccountId,
        currencyCode: CurrencyCode.USD,
      },
    },
    data: { balanceAmount: '1000.00000000' },
  });
  const otherAccountBuy = await market(
    strangerId,
    strangerAccountId,
    assetId,
    'buy',
    '1.000000',
    marketKey,
  );
  assert.notEqual(otherAccountBuy.response.data.order.orderId, buyOrderId);
  const otherPosition = await prisma.position.findUnique({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: strangerAccountId,
        assetId,
      },
    },
  });
  assert.equal(text(otherPosition.quantity), '1.00000000');
  assert.equal(text(positionAfterBuy.quantity), '10.00000000');

  await price(assetId, '120.00000000');
  const sell = await market(
    userId,
    accountId,
    assetId,
    'sell',
    '2.000000',
    'sell-' + randomUUID(),
  );
  assert.equal(sell.response.data.execution.state, 'executed');
  const sellOrderId = sell.response.data.order.orderId;
  const positionAfterSell = await prisma.position.findUnique({
    where: { tradingAccountId_assetId: { tradingAccountId: accountId, assetId } },
  });
  assert.equal(text(positionAfterSell.quantity), '8.00000000');

  const limitBuyCancel = await limit(
    userId,
    accountId,
    assetId,
    'buy',
    '1.000000',
    '90.00000000',
    'limit-buy-cancel-' + randomUUID(),
  );
  const krwReserved = await prisma.cashWallet.findUnique({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: CurrencyCode.USD,
      },
    },
  });
  assert.equal(text(krwReserved.reservedAmount), '90.09000000');
  await orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    limitBuyCancel.response.data.order.orderId,
  );
  const krwReleased = await prisma.cashWallet.findUnique({ where: { id: krwReserved.id } });
  assert.equal(text(krwReleased.reservedAmount), '0.00000000');

  const limitSellCancel = await limit(
    userId,
    accountId,
    assetId,
    'sell',
    '1.000000',
    '130.00000000',
    'limit-sell-cancel-' + randomUUID(),
  );
  const sellReserved = await prisma.position.findUnique({ where: { id: positionAfterSell.id } });
  assert.equal(text(sellReserved.reservedQuantity), '1.00000000');
  await orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    limitSellCancel.response.data.order.orderId,
  );
  const sellReleased = await prisma.position.findUnique({ where: { id: positionAfterSell.id } });
  assert.equal(text(sellReleased.reservedQuantity), '0.00000000');

  const outsideLimit = await limit(
    userId,
    accountId,
    assetId,
    'buy',
    '1.000000',
    '90.00000000',
    'limit-outside-' + randomUUID(),
  );
  const outsideSnapshot = await price(assetId, '91.00000000');
  const outsideOutcome = await limitExecution.fillLimitOrder({
    orderId: outsideLimit.response.data.order.orderId,
    now: new Date(),
    plan: {
      path: 'snapshot',
      executedPrice: new Prisma.Decimal('91.00000000'),
      assetPriceSnapshotId: outsideSnapshot.id,
    },
  });
  assert.equal(outsideOutcome.state, 'skipped');
  assert.equal(outsideOutcome.reason, 'price_outside_limit');
  await orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    outsideLimit.response.data.order.orderId,
  );

  const limitBuyFill = await limit(
    userId,
    accountId,
    assetId,
    'buy',
    '1.000000',
    '90.00000000',
    'limit-buy-fill-' + randomUUID(),
  );
  const buyFillSnapshot = await price(assetId, '80.00000000');
  const buyFill = await limitExecution.fillLimitOrder({
    orderId: limitBuyFill.response.data.order.orderId,
    now: new Date(),
    plan: {
      path: 'snapshot',
      executedPrice: new Prisma.Decimal('80.00000000'),
      assetPriceSnapshotId: buyFillSnapshot.id,
    },
  });
  assert.equal(buyFill.state, 'filled');

  const limitSellFill = await limit(
    userId,
    accountId,
    assetId,
    'sell',
    '1.000000',
    '110.00000000',
    'limit-sell-fill-' + randomUUID(),
  );
  const sellFillSnapshot = await price(assetId, '120.00000000');
  const sellFill = await limitExecution.fillLimitOrder({
    orderId: limitSellFill.response.data.order.orderId,
    now: new Date(),
    plan: {
      path: 'snapshot',
      executedPrice: new Prisma.Decimal('120.00000000'),
      assetPriceSnapshotId: sellFillSnapshot.id,
    },
  });
  assert.equal(sellFill.state, 'filled');

  const inactive = await limit(
    userId,
    accountId,
    assetId,
    'buy',
    '1.000000',
    '70.00000000',
    'limit-inactive-' + randomUUID(),
  );
  await prisma.tradingAccount.update({
    where: { id: accountId },
    data: { status: TradingAccountStatus.suspended },
  });
  const inactiveFill = await limitExecution.fillLimitOrder({
    orderId: inactive.response.data.order.orderId,
    now: new Date(),
    plan: {
      path: 'snapshot',
      executedPrice: new Prisma.Decimal('60.00000000'),
      assetPriceSnapshotId: sellFillSnapshot.id,
    },
  });
  assert.equal(inactiveFill.state, 'skipped');
  assert.equal(inactiveFill.reason, 'account_not_active');
  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1.000000',
    }),
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  const inactiveCancel = await orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    inactive.response.data.order.orderId,
  );
  assert.equal(inactiveCancel.data.order.status, OrderStatus.canceled);

  await prisma.tradingAccount.update({
    where: { id: accountId },
    data: { status: TradingAccountStatus.active },
  });
  const closeProtected = await limit(
    userId,
    accountId,
    assetId,
    'buy',
    '1.000000',
    '70.00000000',
    'limit-closed-' + randomUUID(),
  );
  await prisma.tradingAccount.update({
    where: { id: accountId },
    data: { status: TradingAccountStatus.closed, closedAt: new Date() },
  });
  await expectCode(
    orders.quoteOrderForTradingAccount(userId, accountId, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '1.000000',
    }),
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  const closedCancel = await orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    closeProtected.response.data.order.orderId,
  );
  assert.equal(closedCancel.data.order.status, OrderStatus.canceled);

  const list = await orders.getOrdersForTradingAccount(userId, accountId);
  assert.ok(list.data.orders.length >= 9);
  const detail = await orders.getOrderForTradingAccount(userId, accountId, buyOrderId);
  assert.equal(detail.data.order.orderId, buyOrderId);
  const accountPositions = await positions.getPositionsForTradingAccount(userId, accountId);
  assert.equal(accountPositions.data.positions.length, 2);
  await expectCode(
    orders.getOrdersForTradingAccount(strangerId, accountId),
    'TRADING_ACCOUNT_NOT_FOUND',
  );

  const snapshots = await prisma.equitySnapshot.findMany({
    where: { tradingAccountId: accountId },
    orderBy: { capturedAt: 'asc' },
  });
  const orderSnapshots = snapshots.filter(
    (row) => row.snapshotReason === SnapshotReason.order_executed,
  );
  assert.equal(orderSnapshots.length, 5);
  for (const row of orderSnapshots) {
    assert.equal(row.seasonParticipantId, null);
    assert.notEqual(row.cumulativeExternalFundingKrw, null);
    assert.notEqual(row.investmentPnlKrw, null);
    assert.notEqual(row.timeWeightedReturnFactor, null);
  }
  assert.equal(
    await prisma.seasonParticipant.count({ where: { tradingAccountId: accountId } }),
    0,
  );
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonParticipant: { tradingAccountId: accountId } },
    }),
    0,
  );

  // General financial rows must remain account-only. The migration permits a
  // nullable participant for compatibility, so directly injected participant
  // pollution must fail closed on reads instead of being hidden or adopted.
  const pollutionParticipantId = await createPollutionParticipant(userId);
  await prisma.order.update({
    where: { id: sellOrderId },
    data: { tradingAccountId: strangerAccountId },
  });
  await expectCode(
    orders.getOrdersForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await expectCode(
    orders.getOrdersForTradingAccount(strangerId, strangerAccountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.order.update({
    where: { id: sellOrderId },
    data: { tradingAccountId: accountId },
  });

  await prisma.order.update({
    where: { id: buyOrderId },
    data: { seasonParticipantId: pollutionParticipantId },
  });
  await expectCode(
    orders.getOrdersForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.order.update({
    where: { id: buyOrderId },
    data: { seasonParticipantId: null },
  });

  const generalPosition = await prisma.position.findFirstOrThrow({
    where: { tradingAccountId: accountId, assetId },
    select: { id: true },
  });
  await prisma.position.update({
    where: { id: generalPosition.id },
    data: { seasonParticipantId: pollutionParticipantId },
  });
  await expectCode(
    positions.getPositionsForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.position.update({
    where: { id: generalPosition.id },
    data: { seasonParticipantId: null },
  });

  const generalQuote = await prisma.quote.findFirstOrThrow({
    where: { tradingAccountId: accountId },
    select: { id: true },
  });
  await prisma.quote.update({
    where: { id: generalQuote.id },
    data: { seasonParticipantId: pollutionParticipantId },
  });
  await expectCode(
    orders.getOrderForTradingAccount(userId, accountId, buyOrderId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.quote.update({
    where: { id: generalQuote.id },
    data: { seasonParticipantId: null },
  });

  const generalUsdWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: CurrencyCode.USD,
      },
    },
    select: { id: true },
  });
  await prisma.cashWallet.update({
    where: { id: generalUsdWallet.id },
    data: { seasonParticipantId: pollutionParticipantId },
  });
  await expectCode(
    orders.getOrdersForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.cashWallet.update({
    where: { id: generalUsdWallet.id },
    data: { seasonParticipantId: null },
  });

  console.log('general trading db integration ok');
 } finally {
  await cleanup();
  await prisma.onModuleDestroy();
 }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
