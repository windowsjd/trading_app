/** Real PostgreSQL quote → fee source change → execution/replay proof. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService, type FxExecuteSuccessResponse } from '../src/fx/fx.service';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../src/orders/market-calendar/market-session-override.store';
import { getZonedParts } from '../src/providers/kis/candles/kis-candle-time';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  new GeneralExternalFundingService(prisma),
);
const general = new GeneralAccountsService(prisma, performance);
const orders = new OrdersService(
  prisma,
  undefined,
  undefined,
  undefined,
  access,
  performance,
);
const fx = new FxService(
  prisma,
  undefined,
  undefined,
  access,
  performance,
  undefined,
  valuation,
);
const FEE = '0.001000';
async function dbNow() {
  const rows = await prisma.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}
function code(error: unknown) {
  assert.ok(error instanceof HttpException, String(error));
  return (error.getResponse() as { error: { code: string } }).error.code;
}
async function rejected(work: Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(code(error), expected);
    return true;
  });
}
function setSession(now: Date, closeAt?: Date) {
  const p = getZonedParts(closeAt ?? now, 'Asia/Seoul');
  const pad = (n: number) => String(n).padStart(2, '0');
  applyMarketSessionOverrideSnapshot(
    [
      {
        market: 'KRX',
        localDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
        overrideType: 'custom',
        openTime: '000000',
        closeTime: closeAt
          ? `${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`
          : '235959',
        reason: 'fee pinning integration boundary',
      },
    ],
    now,
  );
}

async function fixture(mode: TradingAccountMode, stock = true) {
  const now = await dbNow();
  setSession(now);
  const user = await prisma.user.create({
    data: {
      email: `fee-pin-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `tx-${randomUUID().slice(0, 8)}`,
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `fee-pin-${randomUUID()}`,
            status: 'active',
            startAt: new Date(now.getTime() - 3600_000),
            endAt: new Date(now.getTime() + 86400_000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: FEE,
            fxFeeRate: FEE,
          },
        })
      : null;
  const accountId = season
    ? (
        await prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode,
            initialCapitalKrw: '10000000',
            openedAt: now,
          },
        })
      ).id
    : (await general.openGeneralAccount(user.id)).data.account.id;
  const participant = season
    ? await prisma.seasonParticipant.create({
        data: {
          userId: user.id,
          seasonId: season.id,
          tradingAccountId: accountId,
          participantStatus: 'active',
          joinedAt: now,
          initialCapitalKrw: '10000000',
          totalAssetKrw: '10000000',
          totalReturnRate: '0',
          maxDrawdown: '0',
        },
      })
    : null;
  if (season)
    await prisma.cashWallet.createMany({
      data: [
        {
          tradingAccountId: accountId,
          currencyCode: 'KRW',
          balanceAmount: '10000000',
          reservedAmount: '0',
        },
        {
          tradingAccountId: accountId,
          currencyCode: 'USD',
          balanceAmount: '0',
          reservedAmount: '0',
        },
      ],
    });
  const asset = await prisma.asset.create({
    data: {
      symbol: `T${randomUUID().slice(0, 20)}`,
      name: 'fee pinning fixture',
      isActive: true,
      assetType: stock ? 'domestic_stock' : 'crypto',
      market: stock ? 'KRX' : 'BINANCE',
      currencyCode: stock ? 'KRW' : 'USD',
      priceCurrency: stock ? 'KRW' : 'USD',
      settlementCurrency: stock ? 'KRW' : 'USD',
    },
  });
  const price = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '100',
      currencyCode: asset.currencyCode,
      sourceType: 'provider_api',
      sourceName: stock ? 'kis_krx_realtime_trade' : 'binance_spot_ws_ticker',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  const rate = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  const s = {
    userId: user.id,
    accountId,
    season,
    participant,
    asset,
    price,
    rate,
  };
  // Fund USD through the same FX engine, preserving general TWR invariants.
  const body = await fxBody(s);
  await fx.executeForTradingAccount(user.id, accountId, body);
  return s;
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.fxExecuteRequest.deleteMany({ where });
  await prisma.exchangeTransaction.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.quote.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.equitySnapshot.deleteMany({ where });
  await prisma.cashWallet.deleteMany({ where });
  await prisma.seasonParticipant.deleteMany({ where });
  await prisma.tradingAccount.delete({ where: { id: s.accountId } });
  if (s.season) await prisma.season.delete({ where: { id: s.season.id } });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.asset.delete({ where: { id: s.asset.id } });
  await prisma.fxRateSnapshot.delete({ where: { id: s.rate.id } });
  await prisma.user.delete({ where: { id: s.userId } });
  resetMarketSessionOverrideStoreForTest();
}
async function fxBody(s: { userId: string; accountId: string }) {
  const quoted = await fx.quoteForTradingAccount(s.userId, s.accountId, {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '14000',
  });
  assert.ok(quoted.data.quoteId);
  return {
    quoteId: quoted.data.quoteId,
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '14000',
    idempotencyKey: randomUUID(),
  };
}
async function financialState(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return {
    wallets: await prisma.cashWallet.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    orders: await prisma.order.findMany({ where, orderBy: { id: 'asc' } }),
    ledger: await prisma.walletTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    snapshots: await prisma.equitySnapshot.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    positions: await prisma.position.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    exchanges: await prisma.exchangeTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    commands: await prisma.fxExecuteRequest.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
  };
}

type Route = 'account' | 'legacy' | 'submitted';
const B = '0.002000';
const C = '0.003000';

async function setFee(s: Scenario, fee: string) {
  if (s.season) {
    await prisma.season.update({
      where: { id: s.season.id },
      data: { tradeFeeRate: fee, fxFeeRate: fee },
    });
  } else {
    process.env.GENERAL_TRADE_FEE_RATE = fee;
    process.env.GENERAL_FX_FEE_RATE = fee;
  }
}

async function pinned(quoteId: string, expected: string) {
  const quote = await prisma.quote.findUniqueOrThrow({
    where: { id: quoteId },
  });
  assert.equal(quote.quotedFeeRate?.toFixed(6), expected);
}

async function changeEvidence(s: Scenario) {
  const now = await dbNow();
  // Preserve source policy and quote change limits; only price/rate changes.
  await prisma.assetPriceSnapshot.update({
    where: { id: s.price.id },
    data: { price: '100.1', capturedAt: now, effectiveAt: now },
  });
  await prisma.fxRateSnapshot.update({
    where: { id: s.rate.id },
    data: { rate: '1401', capturedAt: now, effectiveAt: now },
  });
}

async function assertLedgerTime(
  s: Scenario,
  id: string,
  executedAt: Date,
  kind: 'order' | 'fx',
) {
  const ledger = await prisma.walletTransaction.findMany({
    where: { referenceId: id },
  });
  assert.equal(ledger.length, kind === 'order' ? 1 : 2);
  for (const row of ledger) {
    assert.equal(row.tradingAccountId, s.accountId);
    assert.equal(row.occurredAt.getTime(), executedAt.getTime());
  }
  const snapshot = await prisma.equitySnapshot.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      snapshotReason: kind === 'order' ? 'order_executed' : 'exchange_executed',
      capturedAt: executedAt,
    },
  });
  if (!s.season) assert.notEqual(snapshot.timeWeightedReturnFactor, null);
  return ledger;
}

async function marketQuote(
  s: Scenario,
  route: Route,
  side: 'buy' | 'sell',
  quantity = '1',
) {
  const request = { assetId: s.asset.id, side, orderType: 'market', quantity };
  const quote =
    route === 'legacy'
      ? await orders.quoteOrder(s.userId, request)
      : await orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          request,
        );
  assert.ok(quote.data.quoteId);
  return {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
}

async function marketCommand(
  s: Scenario,
  route: Route,
  body: Awaited<ReturnType<typeof marketQuote>>,
) {
  if (route === 'submitted') {
    // Simulate an existing submitted market row; execution is the real public core.
    const order = await prisma.order.create({
      data: {
        tradingAccountId: s.accountId,
        assetId: s.asset.id,
        quoteId: body.quoteId,
        side: body.side,
        orderType: 'market',
        status: 'submitted',
        quantity: body.quantity,
        currencyCode: 'KRW',
        grossAmount: '100',
        feeAmount: '0.1',
        netAmount: '100.1',
        assetPriceSnapshotId: s.price.id,
        submittedAt: await dbNow(),
      },
    });
    return () => orders.executeOrder(s.userId, order.id);
  }
  return () =>
    route === 'legacy'
      ? orders.createOrder(s.userId, body)
      : orders.createOrderForTradingAccount(s.userId, s.accountId, body);
}

async function assertMarket(
  s: Scenario,
  quoteId: string,
  side: 'buy' | 'sell',
  expectedFee: string,
) {
  const order = await prisma.order.findUniqueOrThrow({ where: { quoteId } });
  assert.equal(order.status, 'executed');
  assert.equal(order.executedPrice?.toFixed(8), '100.10000000');
  assert.equal(order.grossAmount?.toFixed(8), '100.10000000');
  const fee = new Prisma.Decimal('100.1').mul(expectedFee);
  const net =
    side === 'buy'
      ? new Prisma.Decimal('100.1').add(fee)
      : new Prisma.Decimal('100.1').sub(fee);
  assert.equal(order.feeAmount?.toFixed(8), fee.toFixed(8));
  assert.equal(order.netAmount?.toFixed(8), net.toFixed(8));
  assert.ok(order.executedAt);
  const ledger = await assertLedgerTime(s, order.id, order.executedAt, 'order');
  assert.equal(ledger[0].amount.toFixed(8), net.toFixed(8));
  assert.equal(ledger[0].direction, side === 'buy' ? 'debit' : 'credit');
}

async function marketTest(s: Scenario, route: Route, side: 'buy' | 'sell') {
  if (side === 'sell') {
    const seed = await marketQuote(s, route, 'buy', '5');
    await orders.createOrderForTradingAccount(s.userId, s.accountId, seed);
  }
  const q1 = await marketQuote(s, route, side);
  await pinned(q1.quoteId, FEE);
  const first = await marketCommand(s, route, q1);
  await setFee(s, B);
  const q2 = await marketQuote(s, route, side);
  await pinned(q2.quoteId, B);
  const second = await marketCommand(s, route, q2);
  await setFee(s, C);
  await changeEvidence(s);
  // Create replays the stored result; legacy submitted execute preserves its
  // already_executed metadata contract and the same persisted order amounts.
  const [result, duplicate] = await Promise.all([first(), first()]);
  if (route === 'submitted')
    assert.deepEqual(duplicate.data.order, result.data.order);
  else assert.deepEqual(duplicate, result);
  await assertMarket(s, q1.quoteId, side, FEE);
  const replayBeforeFeeChange = await first();
  const committed = await financialState(s);
  await setFee(s, '0.004000');
  assert.deepEqual(await first(), replayBeforeFeeChange);
  assert.deepEqual(await financialState(s), committed);
  await second();
  await assertMarket(s, q2.quoteId, side, B);

  const legacy = await marketQuote(s, route, side);
  await prisma.quote.update({
    where: { id: legacy.quoteId },
    data: { quotedFeeRate: null },
  });
  await setFee(s, B);
  const legacyExecute = await marketCommand(s, route, legacy);
  if (s.season) {
    await legacyExecute();
    await assertMarket(s, legacy.quoteId, side, B);
    const legacyReplay = await legacyExecute();
    const legacyState = await financialState(s);
    await setFee(s, C);
    assert.deepEqual(await legacyExecute(), legacyReplay);
    assert.deepEqual(await financialState(s), legacyState);
  } else {
    const before = await financialState(s);
    await rejected(legacyExecute(), 'QUOTE_MISMATCH');
    assert.deepEqual(await financialState(s), before);
  }

  // An invalid non-null pin must never select the compatibility fallback.
  const invalid = await marketQuote(s, route, side);
  await prisma.quote.update({
    where: { id: invalid.quoteId },
    data: { quotedFeeRate: '1.1' },
  });
  const invalidExecute = await marketCommand(s, route, invalid);
  const before = await financialState(s);
  await rejected(invalidExecute(), 'QUOTE_MISMATCH');
  assert.deepEqual(await financialState(s), before);

  await setFee(s, '0.000000');
  const zero = await marketQuote(s, route, side);
  await pinned(zero.quoteId, '0.000000');
  await setFee(s, B);
  await (
    await marketCommand(s, route, zero)
  )();
  await assertMarket(s, zero.quoteId, side, '0.000000');
}

async function fxQuote(s: Scenario, route: Route, fromCurrency: 'KRW' | 'USD') {
  const request = {
    fromCurrency,
    toCurrency: fromCurrency === 'KRW' ? 'USD' : 'KRW',
    sourceAmount: fromCurrency === 'KRW' ? '14000' : '1',
  };
  const quote =
    route === 'legacy'
      ? await fx.quote(s.userId, request)
      : await fx.quoteForTradingAccount(s.userId, s.accountId, request);
  assert.ok(quote.data.quoteId);
  return {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
}

async function assertFx(
  s: Scenario,
  key: string,
  fromCurrency: 'KRW' | 'USD',
  feeRate: string,
) {
  const command = await prisma.fxExecuteRequest.findUniqueOrThrow({
    where: {
      tradingAccountId_idempotencyKey: {
        tradingAccountId: s.accountId,
        idempotencyKey: key,
      },
    },
  });
  assert.ok(command.exchangeTransactionId);
  const exchange = await prisma.exchangeTransaction.findUniqueOrThrow({
    where: { id: command.exchangeTransactionId },
  });
  const source = new Prisma.Decimal(fromCurrency === 'KRW' ? '14000' : '1');
  const gross =
    fromCurrency === 'KRW' ? source.div('1401') : source.mul('1401');
  const fee = gross.mul(feeRate);
  const net = gross.sub(fee);
  assert.equal(exchange.appliedRate.toFixed(8), '1401.00000000');
  assert.equal(exchange.feeRate.toFixed(6), feeRate);
  assert.equal(exchange.grossTargetAmount.toFixed(8), gross.toFixed(8));
  assert.equal(exchange.feeAmount.toFixed(8), fee.toFixed(8));
  assert.equal(exchange.netTargetAmount.toFixed(8), net.toFixed(8));
  const ledger = await assertLedgerTime(
    s,
    exchange.id,
    exchange.executedAt,
    'fx',
  );
  assert.equal(
    ledger.find((row) => row.txType === 'exchange_source')?.amount.toFixed(8),
    source.toFixed(8),
  );
  assert.equal(
    ledger.find((row) => row.txType === 'exchange_target')?.amount.toFixed(8),
    net.toFixed(8),
  );
}

async function fxTest(s: Scenario, route: Route, fromCurrency: 'KRW' | 'USD') {
  const execute = (body: Awaited<ReturnType<typeof fxQuote>>) =>
    route === 'legacy'
      ? fx.execute(s.userId, body)
      : fx.executeForTradingAccount(s.userId, s.accountId, body);
  const q1 = await fxQuote(s, route, fromCurrency);
  await pinned(q1.quoteId, FEE);
  await setFee(s, B);
  const q2 = await fxQuote(s, route, fromCurrency);
  await pinned(q2.quoteId, B);
  await setFee(s, C);
  await changeEvidence(s);
  const [result, duplicate] = await Promise.all([execute(q1), execute(q1)]);
  assert.deepEqual(duplicate, result);
  assert.equal((result as FxExecuteSuccessResponse).data.feeRate, FEE);
  await assertFx(s, q1.idempotencyKey, fromCurrency, FEE);
  const committed = await financialState(s);
  await setFee(s, '0.004000');
  assert.deepEqual(await execute(q1), result);
  assert.deepEqual(await financialState(s), committed);
  await execute(q2);
  await assertFx(s, q2.idempotencyKey, fromCurrency, B);

  const legacy = await fxQuote(s, route, fromCurrency);
  await prisma.quote.update({
    where: { id: legacy.quoteId },
    data: { quotedFeeRate: null },
  });
  await setFee(s, B);
  if (s.season) {
    const legacyResult = await execute(legacy);
    await assertFx(s, legacy.idempotencyKey, fromCurrency, B);
    const legacyState = await financialState(s);
    await setFee(s, C);
    assert.deepEqual(await execute(legacy), legacyResult);
    assert.deepEqual(await financialState(s), legacyState);
  } else {
    const before = await financialState(s);
    await rejected(execute(legacy), 'QUOTE_MISMATCH');
    assert.deepEqual(await financialState(s), before);
  }
  const invalid = await fxQuote(s, route, fromCurrency);
  await prisma.quote.update({
    where: { id: invalid.quoteId },
    data: { quotedFeeRate: '1.1' },
  });
  const before = await financialState(s);
  await rejected(execute(invalid), 'QUOTE_MISMATCH');
  assert.deepEqual(await financialState(s), before);

  await setFee(s, '0.000000');
  const zero = await fxQuote(s, route, fromCurrency);
  await pinned(zero.quoteId, '0.000000');
  await setFee(s, B);
  await execute(zero);
  await assertFx(s, zero.idempotencyKey, fromCurrency, '0.000000');
}

async function run() {
  await prisma.onModuleInit();
  let count = 0;
  try {
    for (const mode of [
      TradingAccountMode.season,
      TradingAccountMode.general,
    ]) {
      for (const route of [
        'account',
        ...(mode === 'season' ? ['legacy'] : []),
        'submitted',
      ] as Route[]) {
        for (const side of ['buy', 'sell'] as const) {
          process.env.GENERAL_TRADE_FEE_RATE = FEE;
          process.env.GENERAL_FX_FEE_RATE = FEE;
          const s = await fixture(mode);
          try {
            await marketTest(s, route, side);
          } finally {
            await cleanup(s);
          }
          console.log(`PASS market ${mode} ${route} ${side}`);
          count++;
        }
      }
      for (const route of [
        'account',
        ...(mode === 'season' ? ['legacy'] : []),
      ] as Route[]) {
        for (const from of ['KRW', 'USD'] as const) {
          process.env.GENERAL_TRADE_FEE_RATE = FEE;
          process.env.GENERAL_FX_FEE_RATE = FEE;
          const s = await fixture(mode);
          try {
            await fxTest(s, route, from);
          } finally {
            await cleanup(s);
          }
          console.log(`PASS FX ${mode} ${route} ${from}`);
          count++;
        }
      }
    }
    console.log(`trading fee-pinning integration ok: ${count} scenarios`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
