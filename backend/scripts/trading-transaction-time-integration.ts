/** Real PostgreSQL lock waits; no mocked execution clock or provider network. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HttpException } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import {
  LimitOrderExecutionService,
  LimitFillPlan,
} from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../src/orders/market-calendar/market-session-override.store';
import { getZonedParts } from '../src/providers/kis/candles/kis-candle-time';
import { getAssetTradingStatus } from '../src/orders/market-hours.policy';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  new GeneralExternalFundingService(prisma),
);
const general = new GeneralAccountsService(prisma, performance);
const reservation = new OrderReservationService();
const cancel = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(
  prisma,
  undefined,
  new LimitOrderCreateService(prisma, reservation),
  cancel,
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
const candles = new LimitOrderCandleEvidenceService(prisma);
const execution = new LimitOrderExecutionService(
  prisma,
  candles,
  orders,
  performance,
);
const matcher = new LimitOrderMatchingService(
  prisma,
  new LimitOrderCandidateRepository(prisma),
  candles,
  execution,
);
const FEE = '0.001000';
const modes = [TradingAccountMode.season, TradingAccountMode.general] as const;

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
        reason: 'transaction time integration boundary',
      },
    ],
    now,
  );
}

async function fixture(mode: TradingAccountMode, stock = false) {
  const now = await dbNow();
  setSession(now);
  const user = await prisma.user.create({
    data: {
      email: `tx-time-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `tx-${randomUUID().slice(0, 8)}`,
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `tx-time-${randomUUID()}`,
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
      name: 'transaction time fixture',
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
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.marketCandle.deleteMany({ where: { assetId: s.asset.id } });
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
async function orderBody(s: Scenario, limit = false) {
  const request = {
    assetId: s.asset.id,
    side: 'buy',
    orderType: limit ? 'limit' : 'market',
    quantity: '0.010000',
    ...(limit ? { limitPrice: '100.00000000' } : {}),
  };
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  assert.ok(quoted.data.quoteId);
  return {
    ...request,
    quoteId: quoted.data.quoteId,
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

/** The observer proves the product reached an actual row-lock wait. */
async function blocked<T>(
  s: Scenario,
  work: () => Promise<T>,
  options: {
    until?: Date;
    row?: 'participant' | 'account' | 'order' | 'season';
    orderId?: string;
    mutation?: (client: Client) => Promise<unknown>;
    afterBlocked?: (client: Client) => Promise<unknown>;
  } = {},
) {
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  const observer = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await observer.connect();
  let pending: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    await blocker.query('BEGIN');
    const row = options.row ?? (s.participant ? 'participant' : 'account');
    const table = {
      participant: 'season_participants',
      account: 'trading_accounts',
      order: 'orders',
      season: 'seasons',
    }[row];
    const id =
      row === 'participant'
        ? s.participant!.id
        : row === 'season'
          ? s.season!.id
          : row === 'order'
            ? options.orderId
            : s.accountId;
    await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [
      id,
    ]);
    if (options.mutation) await options.mutation(blocker);
    const pid = (
      await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    pending = work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + 4000;
    for (;;) {
      const waiting = await observer.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      );
      if (waiting.rowCount) break;
      assert.ok(
        Date.now() < deadline,
        'product never reached the row-lock barrier',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (options.afterBlocked) await options.afterBlocked(blocker);
    if (options.until)
      for (;;) {
        const time = (
          await observer.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0].now;
        if (time > options.until) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    const releasedAt = (
      await blocker.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0].now;
    await blocker.query('COMMIT');
    const result = await pending;
    if ('error' in result) throw result.error;
    return { value: result.value, releasedAt };
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await pending;
    await blocker.end();
    await observer.end();
  }
}
async function staleAfterWait(s: Scenario, kind: 'price' | 'rate') {
  const now = await dbNow();
  const age = kind === 'price' ? 9500 : 59500;
  const capturedAt = new Date(now.getTime() - age);
  if (kind === 'price')
    await prisma.assetPriceSnapshot.update({
      where: { id: s.price.id },
      data: { capturedAt, effectiveAt: capturedAt },
    });
  else
    await prisma.fxRateSnapshot.update({
      where: { id: s.rate.id },
      data: { capturedAt, effectiveAt: capturedAt },
    });
  return new Date(now.getTime() + 1700);
}
async function endAfterWait(s: Scenario) {
  assert.ok(s.season);
  const endAt = new Date((await dbNow()).getTime() + 1200);
  await prisma.season.update({ where: { id: s.season.id }, data: { endAt } });
  return endAt;
}
async function assertExecutionTimes(
  s: Scenario,
  releasedAt: Date,
  kind: 'order' | 'fx',
  market = false,
) {
  const record =
    kind === 'order'
      ? await prisma.order.findFirstOrThrow({
          where: { tradingAccountId: s.accountId, status: 'executed' },
          orderBy: { executedAt: 'desc' },
        })
      : await prisma.exchangeTransaction.findFirstOrThrow({
          where: { tradingAccountId: s.accountId },
          orderBy: { executedAt: 'desc' },
        });
  assert.ok(record.executedAt && record.executedAt >= releasedAt);
  if (market && 'submittedAt' in record)
    assert.equal(record.submittedAt.getTime(), record.executedAt.getTime());
  const ledger = await prisma.walletTransaction.findMany({
    where: { referenceId: record.id },
  });
  assert.equal(ledger.length, kind === 'order' ? 1 : 2);
  for (const row of ledger)
    assert.equal(row.occurredAt.getTime(), record.executedAt.getTime());
  const snapshot = await prisma.equitySnapshot.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      snapshotReason: kind === 'order' ? 'order_executed' : 'exchange_executed',
    },
    orderBy: { capturedAt: 'desc' },
  });
  assert.equal(snapshot.capturedAt.getTime(), record.executedAt.getTime());
  if (kind === 'fx') {
    const command = await prisma.fxExecuteRequest.findFirstOrThrow({
      where: { exchangeTransactionId: record.id },
    });
    assert.equal(command.requestedAt.getTime(), record.executedAt.getTime());
    assert.equal(command.completedAt!.getTime(), record.executedAt.getTime());
  }
}
async function withScenario(
  mode: TradingAccountMode,
  name: string,
  test: (s: Scenario) => Promise<void>,
  stock = false,
) {
  const s = await fixture(mode, stock);
  try {
    await test(s);
    console.log(`ok ${mode} ${name}`);
  } finally {
    await cleanup(s);
  }
}

async function marketTests(mode: TradingAccountMode) {
  for (const boundary of [
    'quote',
    'price',
    'rate',
    'close',
    ...(mode === 'season' ? ['season'] : []),
  ]) {
    await withScenario(
      mode,
      `market lock wait ${boundary}`,
      async (s) => {
        const body = await orderBody(s);
        let until: Date;
        let expected: string;
        if (boundary === 'quote') {
          until = new Date((await dbNow()).getTime() + 1200);
          await prisma.quote.update({
            where: { id: body.quoteId },
            data: { expiresAt: until },
          });
          expected = 'QUOTE_EXPIRED';
        } else if (boundary === 'price' || boundary === 'rate') {
          until = await staleAfterWait(s, boundary);
          expected =
            boundary === 'price' ? 'PRICE_STALE' : 'PROVIDER_RATE_STALE';
        } else if (boundary === 'season') {
          until = await endAfterWait(s);
          expected = 'SEASON_ENDED';
        } else {
          until = new Date((await dbNow()).getTime() + 2000);
          setSession(await dbNow(), until);
          assert.equal(
            getAssetTradingStatus(s.asset, await dbNow()).tradable,
            true,
          );
          expected = 'MARKET_CLOSED';
        }
        const before = await financialState(s);
        await rejected(
          blocked(
            s,
            () =>
              orders.createOrderForTradingAccount(s.userId, s.accountId, body),
            { until },
          ),
          expected,
        );
        assert.deepEqual(await financialState(s), before);
        assert.equal(
          (
            await prisma.quote.findUniqueOrThrow({
              where: { id: body.quoteId },
            })
          ).consumedAt,
          null,
        );
      },
      boundary === 'close',
    );
  }
  await withScenario(
    mode,
    'market crypto timestamps and committed replay',
    async (s) => {
      const body = await orderBody(s);
      const result = await blocked(s, () =>
        orders.createOrderForTradingAccount(s.userId, s.accountId, body),
      );
      await assertExecutionTimes(s, result.releasedAt, 'order', true);
      const before = await financialState(s);
      await prisma.tradingAccount.update({
        where: { id: s.accountId },
        data: { status: 'closed' },
      });
      if (s.season)
        await prisma.season.update({
          where: { id: s.season.id },
          data: { status: 'ended' },
        });
      assert.deepEqual(
        await orders.createOrderForTradingAccount(s.userId, s.accountId, body),
        result.value,
      );
      const storedOrder = before.orders[0];
      const legacyReplay = await orders.executeOrder(s.userId, storedOrder.id);
      assert.equal(legacyReplay.data.execution.state, 'already_executed');
      assert.equal(
        legacyReplay.data.execution.executedAt,
        storedOrder.executedAt!.toISOString(),
      );
      assert.deepEqual(await financialState(s), before);
    },
  );
}
async function fxTests(mode: TradingAccountMode) {
  for (const boundary of [
    'quote',
    'rate',
    'account',
    ...(mode === 'season' ? ['season', 'participant'] : []),
  ]) {
    await withScenario(mode, `FX lock wait ${boundary}`, async (s) => {
      const body = await fxBody(s);
      let until: Date | undefined;
      let expected = 'TRADING_ACCOUNT_NOT_ACTIVE';
      const row = boundary === 'account' ? 'account' : undefined;
      let mutation: ((client: Client) => Promise<unknown>) | undefined;
      if (boundary === 'quote') {
        until = new Date((await dbNow()).getTime() + 1200);
        await prisma.quote.update({
          where: { id: body.quoteId },
          data: { expiresAt: until },
        });
        expected = 'QUOTE_EXPIRED';
      } else if (boundary === 'rate') {
        until = await staleAfterWait(s, 'rate');
        expected = 'PROVIDER_RATE_STALE';
      } else if (boundary === 'season') {
        until = await endAfterWait(s);
        expected = 'SEASON_ENDED';
      } else if (boundary === 'participant') {
        mutation = (c) =>
          c.query(
            "UPDATE season_participants SET participant_status = 'excluded' WHERE id = $1",
            [s.participant!.id],
          );
        expected = 'PARTICIPANT_EXCLUDED';
      } else
        mutation = (c) =>
          c.query(
            "UPDATE trading_accounts SET status = 'suspended' WHERE id = $1",
            [s.accountId],
          );
      const before = await financialState(s);
      await rejected(
        blocked(
          s,
          () => fx.executeForTradingAccount(s.userId, s.accountId, body),
          { until, row, mutation },
        ),
        expected,
      );
      assert.deepEqual(await financialState(s), before);
    });
  }
  await withScenario(mode, 'FX timestamps and committed replay', async (s) => {
    const body = await fxBody(s);
    const result = await blocked(s, () =>
      fx.executeForTradingAccount(s.userId, s.accountId, body),
    );
    await assertExecutionTimes(s, result.releasedAt, 'fx');
    const before = await financialState(s);
    await prisma.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'closed' },
    });
    if (s.participant)
      await prisma.seasonParticipant.update({
        where: { id: s.participant.id },
        data: { participantStatus: 'excluded' },
      });
    if (s.season)
      await prisma.season.update({
        where: { id: s.season.id },
        data: { status: 'ended' },
      });
    assert.deepEqual(
      await fx.executeForTradingAccount(s.userId, s.accountId, body),
      result.value,
    );
    assert.deepEqual(await financialState(s), before);
  });
}
async function limitOrder(s: Scenario) {
  const body = await orderBody(s, true);
  await orders.createOrderForTradingAccount(s.userId, s.accountId, body);
  return prisma.order.findFirstOrThrow({
    where: { tradingAccountId: s.accountId },
  });
}
async function historicalPlan(
  s: Scenario,
  orderId: string,
): Promise<LimitFillPlan> {
  const now = await dbNow();
  const openTime = new Date(
    Math.floor(now.getTime() / 300000) * 300000 - 600000,
  );
  const closeTime = new Date(openTime.getTime() + 300000);
  await prisma.order.update({
    where: { id: orderId },
    data: { submittedAt: new Date(openTime.getTime() - 300000) },
  });
  const candle = await prisma.marketCandle.create({
    data: {
      assetId: s.asset.id,
      interval: '5m',
      openTime,
      closeTime,
      open: '101',
      high: '102',
      low: '99',
      close: '101',
      volume: '1',
      isClosed: true,
      sourceProvider: 'binance_spot_klines',
      sourceUpdatedAt: closeTime,
    },
  });
  const eligible = await candles.findEligibleClosedCandlesForAsset(
    s.asset,
    now,
    3600_000,
  );
  const evidence = eligible.find((e) => e.marketCandleId === candle.id);
  assert.ok(evidence);
  return {
    path: 'candle',
    executedPrice: new Prisma.Decimal('100'),
    candle: evidence,
  };
}
async function limitTests(mode: TradingAccountMode) {
  for (const boundary of [
    'price',
    'close',
    'rate',
    ...(mode === 'season' ? ['season'] : []),
  ]) {
    await withScenario(
      mode,
      `Path A lock wait ${boundary}`,
      async (s) => {
        const order = await limitOrder(s);
        const cycleNow = await dbNow();
        let until: Date;
        if (boundary === 'price' || boundary === 'rate')
          until = await staleAfterWait(s, boundary);
        else if (boundary === 'season') until = await endAfterWait(s);
        else {
          until = new Date((await dbNow()).getTime() + 2000);
          setSession(await dbNow(), until);
        }
        const before = await financialState(s);
        // Actual matcher selects evidence at cycleNow and waits on the Order.
        const result = await blocked(
          s,
          () => matcher.matchDueLimitOrders({ now: cycleNow }),
          { until, row: 'order', orderId: order.id },
        );
        assert.equal(result.value.ordersConsidered, 1);
        assert.equal(result.value.skipped, 1);
        assert.equal(result.value.errors, 0);
        assert.equal(result.value.filledPathA, 0);
        assert.deepEqual(await financialState(s), before);
      },
      boundary === 'close',
    );
  }
  await withScenario(mode, 'Path A timestamps', async (s) => {
    const order = await limitOrder(s);
    const cycleNow = await dbNow();
    const result = await blocked(
      s,
      () => matcher.matchDueLimitOrders({ now: cycleNow }),
      { row: 'order', orderId: order.id },
    );
    assert.equal(result.value.filledPathA, 1);
    assert.equal(result.value.errors, 0);
    await assertExecutionTimes(s, result.releasedAt, 'order');
  });
  for (const gate of [
    'allowed',
    'account',
    ...(mode === 'season' ? ['participant', 'season'] : []),
  ]) {
    await withScenario(
      mode,
      `Path B historical evidence ${gate}`,
      async (s) => {
        const order = await limitOrder(s);
        const plan = await historicalPlan(s, order.id);
        const before = await financialState(s);
        const until = gate === 'season' ? await endAfterWait(s) : undefined;
        const mutation =
          gate === 'account'
            ? (c: Client) =>
                c.query(
                  "UPDATE trading_accounts SET status = 'suspended' WHERE id = $1",
                  [s.accountId],
                )
            : gate === 'participant'
              ? (c: Client) =>
                  c.query(
                    "UPDATE season_participants SET participant_status = 'excluded' WHERE id = $1",
                    [s.participant!.id],
                  )
              : undefined;
        const result = await blocked(
          s,
          () =>
            execution.fillLimitOrder({
              orderId: order.id,
              now: s.price.capturedAt,
              plan,
            }),
          { until, row: gate === 'account' ? 'account' : undefined, mutation },
        );
        assert.equal(
          result.value.state,
          gate === 'allowed' ? 'filled' : 'skipped',
        );
        if (gate === 'allowed') {
          await assertExecutionTimes(s, result.releasedAt, 'order');
          const filled = await prisma.order.findUniqueOrThrow({
            where: { id: order.id },
          });
          assert.ok(filled.limitOrderCandleEvidenceId);
          assert.equal(filled.assetPriceSnapshotId, null);
        } else assert.deepEqual(await financialState(s), before);
      },
    );
  }
  await withScenario(
    mode,
    'Path B stock candle survives current market close',
    async (s) => {
      const order = await limitOrder(s);
      const plan = await historicalPlan(s, order.id);
      const until = new Date((await dbNow()).getTime() + 2000);
      setSession(await dbNow(), until);
      const result = await blocked(
        s,
        () => execution.fillLimitOrder({ orderId: order.id, plan }),
        { row: 'order', orderId: order.id, until },
      );
      assert.equal(
        getAssetTradingStatus(s.asset, await dbNow()).tradable,
        false,
      );
      assert.equal(result.value.state, 'filled');
      await assertExecutionTimes(s, result.releasedAt, 'order');
    },
    true,
  );
  await withScenario(mode, 'Path A rejects future evidence', async (s) => {
    const order = await limitOrder(s);
    const future = new Date((await dbNow()).getTime() + 60000);
    await prisma.assetPriceSnapshot.update({
      where: { id: s.price.id },
      data: { capturedAt: future },
    });
    const before = await financialState(s);
    const result = await execution.fillLimitOrder({
      orderId: order.id,
      plan: {
        path: 'snapshot',
        executedPrice: s.price.price,
        assetPriceSnapshotId: s.price.id,
      },
    });
    assert.equal(result.state, 'skipped');
    assert.deepEqual(await financialState(s), before);
  });
  await withScenario(
    mode,
    'cancel races fill without double reservation release',
    async (s) => {
      const order = await limitOrder(s);
      const results = await Promise.allSettled([
        execution.fillLimitOrder({
          orderId: order.id,
          plan: {
            path: 'snapshot',
            executedPrice: s.price.price,
            assetPriceSnapshotId: s.price.id,
          },
        }),
        cancel.cancelOwnedLimitBuyOrder({
          userId: s.userId,
          orderId: order.id,
          expectedTradingAccountId: s.accountId,
          canceledAt: await dbNow(),
        }),
      ]);
      assert.ok(results.some((r) => r.status === 'fulfilled'));
      const final = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      assert.ok(final.status === 'executed' || final.status === 'canceled');
      const wallet = await prisma.cashWallet.findUniqueOrThrow({
        where: {
          tradingAccountId_currencyCode: {
            tradingAccountId: s.accountId,
            currencyCode: s.asset.currencyCode,
          },
        },
      });
      assert.equal(wallet.reservedAmount.toFixed(8), '0.00000000');
      assert.equal(
        await prisma.walletTransaction.count({
          where: { referenceId: order.id },
        }),
        final.status === 'executed' ? 1 : 0,
      );
    },
  );
}
// Deterministic lock-order proof against the current Season-first writers.
// The writer holds Season, waits for the trade to block, then updates the
// participant/account in the same transaction. A Participant-first trade
// would deadlock here rather than observe the newly committed lifecycle.
async function lifecycleOrderingTests() {
  for (const path of ['market', 'fx', 'limit-create', 'limit-fill'] as const) {
    await withScenario(
      'season',
      `lifecycle writer ordering ${path}`,
      async (s) => {
        const body =
          path === 'fx'
            ? await fxBody(s)
            : await orderBody(s, path !== 'market');
        const order = path === 'limit-fill' ? await limitOrder(s) : null;
        const before = await financialState(s);
        const work = () =>
          path === 'fx'
            ? fx.executeForTradingAccount(s.userId, s.accountId, body)
            : path === 'limit-fill'
              ? execution.fillLimitOrder({
                  orderId: order!.id,
                  plan: {
                    path: 'snapshot',
                    assetPriceSnapshotId: s.price.id,
                    executedPrice: s.price.price,
                  },
                })
              : orders.createOrderForTradingAccount(
                  s.userId,
                  s.accountId,
                  body,
                );
        const attempt = blocked(s, work, {
          row: 'season',
          afterBlocked: async (client) => {
            await client.query(
              "UPDATE season_participants SET participant_status = 'finished' WHERE id = $1",
              [s.participant!.id],
            );
            await client.query(
              "UPDATE trading_accounts SET status = 'closed' WHERE id = $1",
              [s.accountId],
            );
            await client.query(
              "UPDATE seasons SET status = 'ended' WHERE id = $1",
              [s.season!.id],
            );
          },
        });
        if (path === 'limit-fill') {
          const value = (await attempt).value;
          assert.ok(value && typeof value === 'object' && 'state' in value);
          assert.equal(value.state, 'skipped');
        } else
          await assert.rejects(attempt, (error: unknown) =>
            [
              'PARTICIPANT_NOT_ACTIVE',
              'TRADING_ACCOUNT_NOT_ACTIVE',
              'SEASON_NOT_ACTIVE',
            ].includes(code(error)),
          );
        assert.deepEqual(await financialState(s), before);
      },
    );
  }
}

async function main() {
  await prisma.$connect();
  try {
    for (const mode of modes) {
      await marketTests(mode);
      await fxTests(mode);
      await limitTests(mode);
    }
    await lifecycleOrderingTests();
    console.log('trading transaction-time integration ok');
  } finally {
    resetMarketSessionOverrideStoreForTest();
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
