/** Opt-in, isolated rows; real PostgreSQL transactions, no production adapter. */
import { tradingSessions } from '../test/support/trading-session-fixture';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { UsdKrwRefreshService } from '../src/providers/usd-krw-refresh.service';
import { ExchangeRateIngestionService } from '../src/providers/exchange-rate/exchange-rate.ingestion.service';
import {
  buildProviderConfig,
  ProviderConfigService,
} from '../src/providers/provider-config.service';
import {
  KoreaEximExchangeIngestionService,
  formatKstSearchDate,
  kstSearchDateToUtcMidnight,
} from '../src/providers/korea-exim/korea-exim-exchange.ingestion.service';
import { ProviderHttpError } from '../src/providers/provider.types';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  Prisma,
  type AssetType,
  type OrderSide,
  type TradingAccountMode,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { RecordsService } from '../src/records/records.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import {
  MarketExecutionEvidenceAdapter,
  type MarketExecutionContext,
  type ExecutionEvidenceCandidate,
} from '../src/orders/market-execution-evidence.adapter';
import { resetMarketSessionOverrideStoreForTest } from '../src/orders/market-calendar/market-session-override.store';
import type { RankingRefreshService } from '../src/ranking/ranking-refresh.service';

process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
const db = new PrismaService();
const access = new TradingAccountAccessService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  new PortfolioValuationService(db),
  new GeneralExternalFundingService(db),
);
const general = new GeneralAccountsService(db, performance);
const users: string[] = [],
  accounts: string[] = [],
  seasons: string[] = [],
  assets: string[] = [],
  rates: string[] = [];
let refreshes = 0;
const refreshChecks: Promise<void>[] = [];
const ranking = {
  refreshCurrentRankingAfterParticipantChange: async (
    _seasonId: string,
    participantId: string,
  ) => {
    refreshes++;
    // Separate connection can see the committed count when refresh is called.
    const check = db.seasonParticipant
      .findUniqueOrThrow({ where: { id: participantId } })
      .then((row) => {
        assert.ok(row.totalFillCount > 0, 'ranking only after commit');
      });
    refreshChecks.push(check);
    await check;
  },
} as unknown as RankingRefreshService;

class FixtureAdapter extends MarketExecutionEvidenceAdapter {
  reads = 0;
  validations = 0;
  missing = false;
  gates = { sourceEligible: true, sessionEligible: true, fresh: true };
  make: (
    ctx: MarketExecutionContext,
  ) => ExecutionEvidenceCandidate['evidence'] = (ctx) => ({
    ...ctx,
    kind: 'l2',
    effectiveAt: ctx.executedAt,
    capturedAt: ctx.executedAt,
    asks: [
      { price: '100', quantity: '300' },
      { price: '100.1', quantity: '300' },
      { price: '100.2', quantity: '200' },
    ],
    bids: [
      { price: '100', quantity: '300' },
      { price: '99.9', quantity: '300' },
      { price: '99.8', quantity: '200' },
    ],
  });
  read(ctx: MarketExecutionContext) {
    this.reads++;
    return this.missing
      ? null
      : { source: 'generic_test_l2', evidence: this.make(ctx) };
  }
  validate() {
    this.validations++;
    return this.gates;
  }
}
function service(adapter?: FixtureAdapter, client = db) {
  return new OrdersService(
    client,
    ranking,
    undefined,
    undefined,
    access,
    performance,
    adapter,
  );
}
async function fixture(
  mode: TradingAccountMode,
  type: AssetType = 'domestic_stock',
  side: OrderSide = 'buy',
) {
  const user = await db.user.create({
    data: {
      email: `ers-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `ERS ${randomUUID().slice(0, 8)}`,
    },
  });
  users.push(user.id);
  let accountId: string;
  let seasonId: string | null = null;
  if (mode === 'general')
    accountId = (await general.openGeneralAccount(user.id)).data.account.id;
  else {
    const now = new Date();
    const season = await db.season.create({
      data: {
        name: `ERS ${randomUUID()}`,
        status: 'active',
        startAt: new Date(now.getTime() - 60_000),
        endAt: new Date(now.getTime() + 86_400_000),
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
    });
    seasonId = season.id;
    seasons.push(season.id);
    const account = await db.tradingAccount.create({
      data: {
        userId: user.id,
        mode,
        status: 'active',
        initialCapitalKrw: '10000000',
        openedAt: now,
      },
    });
    accountId = account.id;
    await db.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: accountId,
        joinedAt: now,
        participantStatus: 'active',
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: accountId,
          currencyCode: 'KRW',
          balanceAmount: '10000000',
        },
        {
          tradingAccountId: accountId,
          currencyCode: 'USD',
          balanceAmount: '0',
        },
      ],
    });
  }
  accounts.push(accountId);
  const currency =
    type === 'domestic_stock' ? ('KRW' as const) : ('USD' as const);
  const asset = await db.asset.create({
    data: {
      symbol: `ERS${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      name: 'ERS fixture',
      market:
        type === 'crypto' ? 'BINANCE' : type === 'us_stock' ? 'NASDAQ' : 'KRX',
      assetType: type,
      currencyCode: currency,
      priceCurrency: currency,
      settlementCurrency: currency,
      isActive: true,
    },
  });
  assets.push(asset.id);
  await db.cashWallet.update({
    where: {
      tradingAccountId_currencyCode: {
        tradingAccountId: accountId,
        currencyCode: currency,
      },
    },
    data: { balanceAmount: currency === 'USD' ? '200000' : '10000000' },
  });
  if (side === 'sell')
    await db.position.create({
      data: {
        tradingAccountId: accountId,
        assetId: asset.id,
        quantity: '1000',
        averageCost: '90',
        currencyCode: currency,
        realizedPnl: '0',
        realizedPnlKrw: '0',
      },
    });
  await refreshPrice(asset.id, type, currency);
  return {
    userId: user.id,
    accountId,
    assetId: asset.id,
    seasonId,
    type,
    currency,
    side,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function refreshPrice(
  assetId: string,
  type: AssetType,
  currency: 'USD' | 'KRW',
) {
  const now = new Date();
  tradingSessions.set(now, undefined, ['KRX', 'US']);
  await db.assetPriceSnapshot.create({
    data: {
      assetId,
      price: '100',
      currencyCode: currency,
      sourceType: 'provider_api',
      sourceName:
        type === 'crypto'
          ? 'binance_public_rest_24hr_ticker'
          : type === 'us_stock'
            ? 'kis_us_delayed_trade'
            : 'kis_krx_realtime_trade',
      capturedAt: now,
      effectiveAt: now,
    },
  });
  const fx = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'exchange_rate_api',
      capturedAt: now,
      effectiveAt: now,
    },
  });
  rates.push(fx.id);
}
async function quote(f: Fixture, svc: OrdersService, value = '1000') {
  await refreshPrice(f.assetId, f.type, f.currency);
  const request = {
    assetId: f.assetId,
    side: f.side,
    orderType: 'market',
    ...(f.type === 'crypto' && f.side === 'buy'
      ? { amount: value }
      : { quantity: value }),
  };
  const q = await svc.quoteOrderForTradingAccount(
    f.userId,
    f.accountId,
    request,
  );
  assert.ok(q.data.quoteId);
  return { ...request, quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
}
async function state(f: Fixture) {
  return {
    wallets: await db.cashWallet.findMany({
      where: { tradingAccountId: f.accountId },
      orderBy: { id: 'asc' },
    }),
    positions: await db.position.findMany({
      where: { tradingAccountId: f.accountId },
      orderBy: { id: 'asc' },
    }),
    ledger: await db.walletTransaction.findMany({
      where: { tradingAccountId: f.accountId },
      orderBy: { id: 'asc' },
    }),
    orders: await db.order.findMany({
      where: { tradingAccountId: f.accountId },
      orderBy: { id: 'asc' },
    }),
    snapshots: await db.equitySnapshot.findMany({
      where: { tradingAccountId: f.accountId },
      orderBy: { id: 'asc' },
    }),
    participant: await db.seasonParticipant.findUnique({
      where: { tradingAccountId: f.accountId },
    }),
  };
}
async function expectCode(run: Promise<unknown>, code: string) {
  await assert.rejects(
    run,
    (e) =>
      e instanceof HttpException &&
      (e.getResponse() as { error: { code: string } }).error.code === code,
  );
}
async function fill(
  mode: TradingAccountMode,
  side: OrderSide,
  quantity: string,
  expected: string,
  type: AssetType = 'domestic_stock',
) {
  const f = await fixture(mode, type, side),
    adapter = new FixtureAdapter(),
    svc = service(adapter);
  const body = await quote(f, svc, quantity),
    before = await state(f),
    count = refreshes;
  if (f.seasonId)
    await db.season.update({
      where: { id: f.seasonId },
      data: { tradeFeeRate: '0.02' },
    });
  const response = await svc.createOrderForTradingAccount(
    f.userId,
    f.accountId,
    body,
  );
  const order = response.data.order;
  assert.equal(order.status, 'executed');
  assert.equal(order.quantity, `${quantity}.000000`);
  assert.equal(order.marketExecution?.executedQuantity, `${expected}.000000`);
  const partial = quantity !== expected;
  assert.equal(order.marketExecution?.status, partial ? 'partial' : 'full');
  assert.equal(
    order.marketExecution?.canceledQuantity,
    new Prisma.Decimal(quantity).sub(expected).toFixed(6),
  );
  const after = await state(f),
    row = after.orders[0];
  assert.equal(row.quantity.toFixed(), quantity);
  assert.equal(row.executedQuantity?.toFixed(), expected);
  const gross = side === 'buy' ? '80070' : '79930',
    fee = new Prisma.Decimal(gross).mul('0.001');
  const net =
    side === 'buy'
      ? new Prisma.Decimal(gross).add(fee)
      : new Prisma.Decimal(gross).sub(fee);
  assert.equal(row.grossAmount?.toFixed(), gross);
  assert.equal(row.feeAmount?.toFixed(), fee.toFixed());
  assert.equal(row.netAmount?.toFixed(), net.toFixed());
  assert.equal(
    row.executedPrice?.toFixed(),
    side === 'buy' ? '100.0875' : '99.9125',
  );
  assert.equal(
    after.positions[0].quantity.toFixed(),
    side === 'buy'
      ? expected
      : new Prisma.Decimal('1000').sub(expected).toFixed(),
  );
  assert.equal(
    after.positions[0].realizedPnl.toFixed(),
    side === 'buy'
      ? '0'
      : net.sub(new Prisma.Decimal(expected).mul('90')).toFixed(),
  );
  if (side === 'buy')
    assert.equal(
      after.positions[0].averageCost.toFixed(8),
      net.div(expected).toFixed(8),
    );
  const wallet = after.wallets.find((w) => w.currencyCode === f.currency)!;
  assert.equal(
    wallet.balanceAmount.toFixed(),
    side === 'buy'
      ? new Prisma.Decimal(f.currency === 'USD' ? '200000' : '10000000')
          .sub(net)
          .toFixed()
      : new Prisma.Decimal(f.currency === 'USD' ? '200000' : '10000000')
          .add(net)
          .toFixed(),
  );
  assert.equal(after.ledger.length, before.ledger.length + 1);
  assert.equal(after.snapshots.length, before.snapshots.length + 1);
  if (mode === 'season') {
    assert.equal(after.participant?.totalFillCount, 1);
    assert.equal(refreshes, count + 1);
  } else assert.equal(refreshes, count);
  if (partial) {
    assert.equal(row.cancelReason, 'insufficient_market_liquidity');
    assert.equal(row.canceledAt?.toISOString(), row.executedAt?.toISOString());
  }
  const listed = await svc.getOrdersForTradingAccount(
    f.userId,
    f.accountId,
    {},
  );
  assert.deepEqual(
    listed.data.orders[0].marketExecution,
    order.marketExecution,
  );
  if (f.seasonId) {
    const records = new RecordsService(db);
    const history = await records.getMySeasonOrders(f.userId, f.seasonId, {});
    assert.deepEqual(
      history.data.orders[0].marketExecution,
      order.marketExecution,
    );
    const aggregate = await records.getRecords(f.userId, {
      seasonId: f.seasonId,
      type: 'orders',
    });
    assert.deepEqual(
      aggregate.data.orders!.records[0].marketExecution,
      order.marketExecution,
    );
  }
  adapter.missing = true;
  await db.tradingAccount.update({
    where: { id: f.accountId },
    data: { status: 'suspended' },
  });
  const replayBefore = await state(f);
  const [replay1, replay2] = await Promise.all([
    svc.createOrderForTradingAccount(f.userId, f.accountId, body),
    svc.createOrderForTradingAccount(f.userId, f.accountId, body),
  ]);
  assert.deepEqual(replay1, response);
  assert.deepEqual(replay2, response);
  assert.deepEqual(await state(f), replayBefore);
  assert.equal(adapter.reads, 1);
  assert.equal(adapter.validations, 1);
  assert.deepEqual(row.responsePayloadJson, response);
  assert.deepEqual(await svc.executeOrder(f.userId, row.id), response);
  console.log(
    `ok ${mode} ${type} ${side} ${partial ? 'partial' : 'exact full'} + replay`,
  );
}
async function failure(
  label: string,
  setup: (adapter: FixtureAdapter) => void,
  expected: string,
) {
  const f = await fixture('general'),
    a = new FixtureAdapter(),
    svc = service(a);
  setup(a);
  const body = await quote(f, svc),
    before = await state(f),
    count = refreshes;
  await expectCode(
    svc.createOrderForTradingAccount(f.userId, f.accountId, body),
    expected,
  );
  assert.deepEqual(await state(f), before);
  assert.equal(refreshes, count);
  assert.equal(
    (await db.quote.findUniqueOrThrow({ where: { id: body.quoteId } })).status,
    'active',
  );
  console.log(`ok ${label}: no financial mutation`);
}
async function rollback(stage: string) {
  const f = await fixture('season'),
    a = new FixtureAdapter();
  const fault = db.$extends({
    query: {
      position: {
        async create({ args, query }) {
          const value = await query(args);
          if (stage === 'position') throw new Error('injected after position');
          return value;
        },
      },
      walletTransaction: {
        async create({ args, query }) {
          const value = await query(args);
          if (stage === 'ledger') throw new Error('injected after ledger');
          return value;
        },
      },
      order: {
        async updateMany({ args, query }) {
          const value = await query(args);
          if (stage === 'finalization')
            throw new Error('injected finalization');
          return value;
        },
        async update({ args, query }) {
          const value = await query(args);
          if (stage === 'response' && args.data.responsePayloadJson)
            throw new Error('injected response');
          return value;
        },
      },
    },
  });
  const svc = service(a, fault as unknown as PrismaService),
    body = await quote(f, svc),
    before = await state(f),
    count = refreshes;
  await assert.rejects(
    svc.createOrderForTradingAccount(f.userId, f.accountId, body),
  );
  assert.deepEqual(await state(f), before);
  assert.equal(refreshes, count);
  assert.equal(
    (await db.quote.findUniqueOrThrow({ where: { id: body.quoteId } })).status,
    'active',
  );
  console.log(`ok rollback after ${stage}`);
}
async function amount(partial: boolean) {
  const f = await fixture('general', 'crypto'),
    a = new FixtureAdapter();
  a.make = (ctx) => ({
    ...ctx,
    kind: 'l2',
    effectiveAt: ctx.executedAt,
    capturedAt: ctx.executedAt,
    asks: [
      { price: '100', quantity: partial ? '0.4' : '0.3' },
      { price: '100.1', quantity: partial ? '0.2' : '1' },
    ],
    bids: [],
  });
  const svc = service(a),
    body = await quote(f, svc, '100'),
    response = await svc.createOrderForTradingAccount(
      f.userId,
      f.accountId,
      body,
    );
  const row = (await state(f)).orders[0];
  assert.equal(row.requestedAmount?.toFixed(), '100');
  assert.ok(row.grossAmount!.lte('100'));
  assert.equal(row.grossAmount!.add(row.unspentAmount!).toFixed(), '100');
  assert.equal(
    row.feeAmount?.toFixed(8),
    row.grossAmount!.mul('0.001').toFixed(8),
  );
  assert.equal(
    response.data.order.marketExecution?.status,
    partial ? 'partial' : 'full',
  );
  assert.equal(response.data.order.marketExecution?.requestedQuantity, null);
  assert.equal(row.canceledQuantity, null);
  assert.equal(row.executedQuantity?.toFixed(), partial ? '0.6' : '0.9993');
  assert.equal(row.grossAmount?.toFixed(), partial ? '60.02' : '99.99993');
  assert.deepEqual(
    await svc.createOrderForTradingAccount(f.userId, f.accountId, body),
    response,
  );
  console.log(`ok crypto amount ${partial ? 'partial' : 'full with dust'}`);
}
async function top() {
  const f = await fixture('general'),
    a = new FixtureAdapter();
  a.make = (ctx) => ({
    ...ctx,
    kind: 'top_of_book',
    effectiveAt: ctx.executedAt,
    capturedAt: ctx.executedAt,
    ask: { price: '100', quantity: '500' },
    bid: null,
  });
  const svc = service(a),
    body = await quote(f, svc, '800');
  const result = await svc.createOrderForTradingAccount(
    f.userId,
    f.accountId,
    body,
  );
  assert.equal(
    result.data.order.marketExecution?.executedQuantity,
    '500.000000',
  );
  assert.equal(
    result.data.order.marketExecution?.canceledQuantity,
    '300.000000',
  );
  console.log('ok top of book size partial');
}
async function fxGuard() {
  const f = await fixture('general', 'crypto'),
    a = new FixtureAdapter(),
    svc = service(a),
    body = await quote(f, svc, '100');
  // Change only the durable quote rate, preserving a fresh actual snapshot.
  await db.quote.update({
    where: { id: body.quoteId },
    data: { quotedRate: '1000' },
  });
  const before = await state(f);
  await expectCode(
    svc.createOrderForTradingAccount(f.userId, f.accountId, body),
    'RATE_CHANGED_REQUOTE_REQUIRED',
  );
  assert.deepEqual(await state(f), before);
  console.log('ok existing FX quote guard');
}
async function concurrentAndLegacy() {
  for (const legacy of [false, true]) {
    const f = await fixture('season'),
      adapter = new FixtureAdapter(),
      svc = service(adapter);
    const body = await quote(f, svc);
    const before = await state(f),
      count = refreshes;
    let run: () =>
      | ReturnType<OrdersService['executeOrder']>
      | ReturnType<OrdersService['createOrderForTradingAccount']>;
    if (legacy) {
      const row = await db.order.create({
        data: {
          tradingAccountId: f.accountId,
          assetId: f.assetId,
          quoteId: body.quoteId,
          side: 'buy',
          orderType: 'market',
          status: 'submitted',
          quantity: '1000',
          currencyCode: 'KRW',
          submittedAt: new Date(),
        },
      });
      run = () => svc.executeOrder(f.userId, row.id);
    } else
      run = () => svc.createOrderForTradingAccount(f.userId, f.accountId, body);
    const [one, two] = await Promise.all([run(), run()]);
    assert.deepEqual(one, two);
    assert.equal(adapter.reads, 1);
    const after = await state(f);
    assert.equal(after.ledger.length, before.ledger.length + 1);
    assert.equal(after.positions[0].quantity.toFixed(), '800');
    assert.equal(after.participant?.totalFillCount, 1);
    assert.equal(refreshes, count + 1);
    assert.deepEqual(after.orders[0].responsePayloadJson, one);
    // Real database invariant, independent of application presenter or types.
    await assert.rejects(
      db.order.update({
        where: { id: after.orders[0].id },
        data: { canceledQuantity: '201' },
      }),
    );
    assert.deepEqual(await state(f), after);
    console.log(
      `ok concurrent ${legacy ? 'legacy execute' : 'create'} and DB quantity conservation`,
    );
  }
}

async function cleanup() {
  await Promise.all(refreshChecks);
  const scope = { tradingAccountId: { in: accounts } };
  await db.walletTransaction.deleteMany({ where: scope });
  await db.equitySnapshot.deleteMany({ where: scope });
  await db.order.deleteMany({ where: scope });
  await db.quote.deleteMany({ where: scope });
  await db.position.deleteMany({ where: scope });
  await db.cashWallet.deleteMany({ where: scope });
  await db.seasonParticipant.deleteMany({ where: scope });
  await db.tradingAccount.deleteMany({ where: { id: { in: accounts } } });
  await db.season.deleteMany({ where: { id: { in: seasons } } });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: assets } },
  });
  await db.asset.deleteMany({ where: { id: { in: assets } } });
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: rates } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  tradingSessions.reset();
  resetMarketSessionOverrideStoreForTest();
  await db.$disconnect();
}
// Real ingestion persists snapshots; only the remote clients are replaced.
// Orders uses the shared coordinator with real DB execution.
async function providerFxPreparation() {
  for (const mode of ['season', 'general'] as const) {
    for (const scenario of [
      'fresh',
      'stale68',
      'fallback',
      'failure',
      'requote',
      'krw',
      'legacy',
      'concurrent',
    ] as const) {
      const f = await fixture(
        mode,
        scenario === 'krw' ? 'domestic_stock' : 'crypto',
      );
      const transactionScope = new AsyncLocalStorage<boolean>();
      let transactions = 0;
      const client = new Proxy(db, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            ) => {
              transactions++;
              return target.$transaction((tx) =>
                transactionScope.run(true, () => callback(tx)),
              );
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function'
            ? (value.bind(target) as unknown)
            : value;
        },
      });
      const config = {
        getConfig: () =>
          buildProviderConfig({
            PROVIDER_INGESTION_ENABLED: 'true',
            KOREA_EXIM_EXCHANGE_ENABLED: 'true',
            KOREA_EXIM_EXCHANGE_AUTH_KEY: 'fixture-only',
            EXCHANGE_RATE_API_ENABLED: 'true',
            EXCHANGE_RATE_API_KEY: 'fixture-only',
          }),
      } as ProviderConfigService;
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const primary = new KoreaEximExchangeIngestionService(client, config, {
        fetchDailyExchangeRates: async () => {
          assert.equal(
            transactionScope.getStore(),
            undefined,
            'EXIM network outside transaction',
          );
          await Promise.resolve();
          primaryCalls++;
          if (scenario === 'fallback' || scenario === 'failure')
            throw new ProviderHttpError(
              'korea_exim_exchange_rate',
              'PROVIDER_TIMEOUT',
              'fixture failure',
            );
          return {
            receivedAt: new Date(),
            rows: [
              {
                RESULT: 1,
                CUR_UNIT: 'USD',
                DEAL_BAS_R: scenario === 'requote' ? '1500' : '1400',
              },
            ],
          };
        },
      } as never);
      const secondary = new ExchangeRateIngestionService(client, config, {
        fetchLatestUsd: async () => {
          assert.equal(
            transactionScope.getStore(),
            undefined,
            'ExchangeRate network outside transaction',
          );
          await Promise.resolve();
          fallbackCalls++;
          if (scenario === 'failure')
            throw new ProviderHttpError(
              'exchange_rate_api',
              'PROVIDER_TIMEOUT',
              'fixture failure',
            );
          return {
            receivedAt: new Date(),
            response: {
              result: 'success',
              base_code: 'USD',
              conversion_rates: { KRW: 1400 },
              time_last_update_unix: Math.floor(Date.now() / 1000),
            },
          };
        },
      } as never);
      const coordinator = new UsdKrwRefreshService(client, primary, secondary);
      const svc = new OrdersService(
        client,
        ranking,
        undefined,
        undefined,
        access,
        performance,
        undefined,
        coordinator,
      );
      const body = await quote(f, svc, '100');
      const secondBody =
        scenario === 'concurrent' ? await quote(f, svc, '100') : null;
      // Only this harness's observations are aged. The EXIM 68-second row is
      // quote-fresh but execution-stale; no fresh fallback is left.
      const capturedAt = new Date(Date.now() - 68000);
      await db.fxRateSnapshot.updateMany({
        where: { id: { in: rates } },
        data: {
          capturedAt,
          effectiveAt: kstSearchDateToUtcMidnight(
            formatKstSearchDate(new Date()),
          ),
        },
      });
      const old = await db.fxRateSnapshot.create({
        data: {
          baseCurrency: 'USD',
          quoteCurrency: 'KRW',
          rate: '1400',
          sourceType: 'provider_api',
          sourceName: 'korea_exim_exchange_rate',
          effectiveAt: kstSearchDateToUtcMidnight(
            formatKstSearchDate(new Date()),
          ),
          capturedAt:
            scenario === 'fresh' ? new Date(Date.now() - 30000) : capturedAt,
        },
      });
      rates.push(old.id);
      let orderId: string | undefined;
      if (scenario === 'legacy') {
        const order = await db.order.create({
          data: {
            tradingAccountId: f.accountId,
            assetId: f.assetId,
            quoteId: body.quoteId,
            side: 'buy',
            orderType: 'market',
            status: 'submitted',
            quantity: '1',
            currencyCode: 'USD',
            submittedAt: new Date(),
          },
        });
        orderId = order.id;
      }
      const before = await state(f);
      const quoteBefore = await db.quote.findUniqueOrThrow({
        where: { id: body.quoteId },
      });
      const initialRates = new Set(
        (await db.fxRateSnapshot.findMany({ select: { id: true } })).map(
          (r) => r.id,
        ),
      );
      let observations: Array<{ id: string }> = [];
      try {
        const run = () =>
          orderId
            ? svc.executeOrder(f.userId, orderId)
            : svc.createOrderForTradingAccount(f.userId, f.accountId, body);
        if (scenario === 'failure' || scenario === 'requote') {
          await expectCode(
            run(),
            scenario === 'failure'
              ? 'PROVIDER_RATE_STALE'
              : 'RATE_CHANGED_REQUOTE_REQUIRED',
          );
          assert.deepEqual(
            await state(f),
            before,
            'full financial state rolled back',
          );
          assert.deepEqual(
            await db.quote.findUniqueOrThrow({ where: { id: body.quoteId } }),
            quoteBefore,
          );
        } else {
          const responses = await Promise.all([
            run(),
            ...(secondBody
              ? [
                  svc.createOrderForTradingAccount(
                    f.userId,
                    f.accountId,
                    secondBody,
                  ),
                ]
              : []),
          ]);
          assert.equal(
            transactions,
            secondBody ? 2 : 1,
            'independent financial transactions',
          );
          for (const response of responses) {
            assert.equal(response.data.order.status, 'executed');
            if (scenario !== 'krw') {
              const selected = await db.fxRateSnapshot.findUniqueOrThrow({
                where: { id: response.data.order.fxRateSnapshotId! },
              });
              assert.equal(
                selected.sourceName,
                scenario === 'fallback'
                  ? 'exchange_rate_api'
                  : 'korea_exim_exchange_rate',
              );
              assert.ok(selected.rate.eq(1400));
              const executionAt = new Date(response.data.order.executedAt!);
              assert.ok(
                executionAt.getTime() - selected.capturedAt.getTime() <= 60000,
              );
              assert.ok(selected.capturedAt <= executionAt);
              assert.equal(selected.id === old.id, scenario === 'fresh');
            }
          }
          const calls = primaryCalls + fallbackCalls;
          const after = await state(f);
          await run(); // committed create or executed-order replay
          assert.equal(
            primaryCalls + fallbackCalls,
            calls,
            'replay does not refresh',
          );
          assert.deepEqual(await state(f), after);
        }
        assert.equal(
          primaryCalls,
          scenario === 'fresh' || scenario === 'krw' ? 0 : 1,
        );
        assert.equal(
          fallbackCalls,
          scenario === 'fallback' || scenario === 'failure' ? 1 : 0,
        );
      } finally {
        observations = (
          await db.fxRateSnapshot.findMany({ select: { id: true } })
        ).filter((r) => !initialRates.has(r.id));
        rates.push(...observations.map((r) => r.id));
      }
      assert.equal(
        observations.length,
        ['fresh', 'krw', 'failure'].includes(scenario) ? 0 : 1,
      );
      console.log(`ok provider FX preparation ${mode} ${scenario}`);
    }
  }
}

async function main() {
  await db.$connect();
  resetMarketSessionOverrideStoreForTest();
  try {
    for (const mode of ['general', 'season'] as const)
      for (const side of ['buy', 'sell'] as const)
        await fill(mode, side, '1000', '800');
    await fill('general', 'buy', '800', '800');
    await fill('season', 'buy', '800', '800');
    await fill('general', 'sell', '1000', '800', 'crypto');
    await fill('general', 'buy', '1000', '800', 'us_stock');
    await amount(false);
    await amount(true);
    await top();
    await providerFxPreparation();
    await fxGuard();
    await concurrentAndLegacy();
    await failure(
      'zero depth',
      (a) => {
        a.make = (ctx) => ({
          ...ctx,
          kind: 'l2',
          effectiveAt: ctx.executedAt,
          capturedAt: ctx.executedAt,
          asks: [],
          bids: [],
        });
      },
      'ORDER_LIQUIDITY_UNAVAILABLE',
    );
    await failure(
      'stale',
      (a) => {
        a.gates.fresh = false;
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'source ineligible',
      (a) => {
        a.gates.sourceEligible = false;
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'session ineligible',
      (a) => {
        a.gates.sessionEligible = false;
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'missing',
      (a) => {
        a.missing = true;
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'invalid identity',
      (a) => {
        const make = a.make;
        a.make = (ctx) => ({ ...make(ctx), assetId: 'other' });
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'invalid depth',
      (a) => {
        a.make = (ctx) => ({
          ...ctx,
          kind: 'l2',
          effectiveAt: ctx.executedAt,
          capturedAt: ctx.executedAt,
          asks: [{ price: '100', quantity: '-1' }],
          bids: [],
        });
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'top size missing',
      (a) => {
        a.make = (ctx) => ({
          ...ctx,
          kind: 'top_of_book',
          effectiveAt: ctx.executedAt,
          capturedAt: ctx.executedAt,
          ask: { price: '100' },
          bid: null,
        });
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'price only',
      (a) => {
        a.make = (ctx) => ({
          ...ctx,
          kind: 'price_only',
          effectiveAt: ctx.executedAt,
          capturedAt: ctx.executedAt,
          referencePrice: '100',
        });
      },
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
    await failure(
      'VWAP quote change',
      (a) => {
        a.make = (ctx) => ({
          ...ctx,
          kind: 'l2',
          effectiveAt: ctx.executedAt,
          capturedAt: ctx.executedAt,
          asks: [
            { price: '100', quantity: '1' },
            { price: '101', quantity: '799' },
          ],
          bids: [],
        });
      },
      'RATE_CHANGED_REQUOTE_REQUIRED',
    );
    for (const stage of ['position', 'ledger', 'finalization', 'response'])
      await rollback(stage);
    console.log('market execution integration ok');
  } finally {
    await cleanup();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
