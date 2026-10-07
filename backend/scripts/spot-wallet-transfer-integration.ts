import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { WalletsService } from '../src/wallets/wallets.service';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { HttpException } from '@nestjs/common';
import {
  PrismaClient,
  Prisma,
  type TradingAccountMode,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { computeOrderQuoteRequestHash } from '../src/providers/durable-quote.policy';
import { debitAvailableCash } from '../src/wallets/cash-wallet-atomic';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION !== '1'
)
  throw new Error('Requires explicit test DB opt-in.');
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
process.env.GENERAL_FX_FEE_RATE = '0.001000';
const CUTOVER = '20261006160000_pin_order_wallet_and_add_transfers';
const d = (value: string) => new Prisma.Decimal(value);
const zero = '0.00000000';
const prisma = new PrismaService();
function services(db: PrismaService) {
  const access = new TradingAccountAccessService(db);
  const valuation = new PortfolioValuationService(db);
  const funding = new GeneralExternalFundingService(db);
  const performance = new GeneralAccountPerformanceService(
    db,
    valuation,
    funding,
  );
  const reservation = new OrderReservationService();
  const cancel = new LimitOrderCancelService(db, reservation);
  const orders = new OrdersService(
    db,
    undefined,
    new LimitOrderCreateService(db, reservation),
    cancel,
    access,
    performance,
  );
  const candles = new LimitOrderCandleEvidenceService(db);
  const execution = new LimitOrderExecutionService(
    db,
    candles,
    orders,
    performance,
  );
  return {
    access,
    valuation,
    funding,
    performance,
    orders,
    cancel,
    execution,
    wallets: new WalletsService(db, access),
    ranking: new RankingRefreshService(db, valuation),
    general: new GeneralAccountsService(db, performance),
    fx: new FxService(db, undefined, undefined, access, performance, valuation),
    transfers: new TradingAccountWalletTransferService(db, access, performance),
    matcher: new LimitOrderMatchingService(
      db,
      new LimitOrderCandidateRepository(db),
      candles,
      execution,
    ),
  };
}
const app = services(prisma);
async function reject(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error) => {
    if (!(error instanceof HttpException)) return false;
    const response = error.getResponse() as { error: { code: string } };
    assert.equal(response.error.code, expected, JSON.stringify(response));
    return true;
  });
}
async function dbNow(db: PrismaService = prisma) {
  return (
    await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  )[0].now;
}
async function fixture(mode: TradingAccountMode) {
  const now = await dbNow();
  const user = await prisma.user.create({
    data: {
      email: `spot-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `spot-${randomUUID().slice(0, 12)}`,
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `spot-${randomUUID()}`,
            status: 'active',
            startAt: new Date(now.getTime() - 86400_000),
            endAt: new Date(now.getTime() + 86400_000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: '0.001',
            fxFeeRate: '0.001',
          },
        })
      : null;
  const accountId = season
    ? (
        await prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode,
            openedAt: now,
            initialCapitalKrw: '10000000',
          },
        })
      ).id
    : (await app.general.openGeneralAccount(user.id)).data.account.id;
  const participant = season
    ? await prisma.seasonParticipant.create({
        data: {
          userId: user.id,
          tradingAccountId: accountId,
          seasonId: season.id,
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
          walletScope: 'securities',
          currencyCode: 'KRW',
          balanceAmount: '10000000',
        },
        ...(['securities', 'crypto_spot', 'crypto_futures'] as const).map(
          (walletScope) => ({
            tradingAccountId: accountId,
            walletScope,
            currencyCode: 'USD' as const,
            balanceAmount: '0',
          }),
        ),
      ],
    });
  const asset = await prisma.asset.create({
    data: {
      symbol: `T${randomUUID().slice(0, 8)}`,
      name: 'Spot test',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
      isActive: true,
    },
  });
  const price = await prisma.assetPriceSnapshot.create({
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
  const rate = await prisma.fxRateSnapshot.create({
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
  const s = {
    mode,
    userId: user.id,
    accountId,
    season,
    participant,
    asset,
    price,
    rate,
  };
  // Exercise the actual user funding route: Securities KRW → FX → Securities USD.
  const fxRequest = {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '5000000',
  };
  const quote = await app.fx.quoteForTradingAccount(
    user.id,
    accountId,
    fxRequest,
  );
  await app.fx.executeForTradingAccount(user.id, accountId, {
    ...fxRequest,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
  return s;
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
const cash = (
  s: Scenario,
  scope: 'securities' | 'crypto_spot' | 'crypto_futures',
) =>
  prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_walletScope_currencyCode: {
        tradingAccountId: s.accountId,
        walletScope: scope,
        currencyCode: 'USD',
      },
    },
  });
async function refresh(s: Scenario, price = '100') {
  const now = await dbNow();
  await prisma.assetPriceSnapshot.update({
    where: { id: s.price.id },
    data: { price, capturedAt: now, effectiveAt: now },
  });
  await prisma.fxRateSnapshot.update({
    where: { id: s.rate.id },
    data: { capturedAt: now, effectiveAt: now },
  });
}
async function transfer(
  s: Scenario,
  from: 'securities' | 'crypto_spot' | 'crypto_futures',
  to: 'securities' | 'crypto_spot' | 'crypto_futures',
  amount: string,
  key = randomUUID(),
) {
  const [source, destination] = await Promise.all([cash(s, from), cash(s, to)]);
  return app.transfers.transfer(s.userId, s.accountId, {
    sourceWalletId: source.id,
    destinationWalletId: destination.id,
    amount,
    idempotencyKey: key,
  });
}
async function orderCommand(
  s: Scenario,
  side: 'buy' | 'sell',
  orderType: 'market' | 'limit',
  amount = '100',
) {
  await refresh(s);
  const body = {
    assetId: s.asset.id,
    side,
    orderType,
    ...(side === 'buy' ? { amount } : { quantity: '1' }),
    ...(orderType === 'limit' ? { limitPrice: '100' } : {}),
  };
  const quote = await app.orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  const durable = await prisma.quote.findUniqueOrThrow({
    where: { id: quote.data.quoteId! },
  });
  assert.equal(durable.cashWalletScope, 'crypto_spot');
  return {
    ...body,
    quoteId: quote.data.quoteId!,
    idempotencyKey: randomUUID(),
  };
}
const create = (s: Scenario, body: Record<string, unknown>) =>
  app.orders.createOrderForTradingAccount(s.userId, s.accountId, body);
async function balances(s: Scenario) {
  return (
    await prisma.cashWallet.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    })
  ).map((w) => ({
    id: w.id,
    scope: w.walletScope,
    balance: w.balanceAmount.toFixed(8),
    reserved: w.reservedAmount.toFixed(8),
  }));
}
async function assertOrderLedger(
  s: Scenario,
  orderId: string,
  scope: 'securities' | 'crypto_spot',
) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
  });
  const wallet = await cash(s, scope);
  const rows = await prisma.walletTransaction.findMany({
    where: { referenceType: 'order', referenceId: orderId },
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.walletId, wallet.id);
  assert.equal(row.tradingAccountId, s.accountId);
  assert.equal(row.currencyCode, 'USD');
  assert.equal(row.direction, order.side === 'buy' ? 'debit' : 'credit');
  assert.ok(row.amount.eq(order.netAmount!));
  assert.ok(row.balanceAfter.eq(wallet.balanceAmount));
  assert.ok(order.feeAmount!.eq('0.1'));
  assert.equal(order.cashWalletScope, scope);
}
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  if (s.season)
    await prisma.seasonRanking.deleteMany({ where: { seasonId: s.season.id } });
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.walletTransfer.deleteMany({ where });
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
}

async function seasonReplayAcrossDeadline(s: Scenario) {
  assert.ok(s.season);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const barrier = Math.floor(Math.random() * 1_000_000_000) + 1;
  const pending: Array<ReturnType<typeof app.transfers.transfer>> = [];
  const waitUntil = async (ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await ready())) {
      assert.ok(Date.now() < deadline, 'Season replay test barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    // Test-only advisory barrier holds the first command after its cash/command
    // writes, with both wallet locks retained. The second command must wait.
    await db.query('SELECT pg_advisory_lock($1)', [barrier]);
    await db.query(
      `CREATE FUNCTION spot_transfer_test_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tx_type = 'wallet_transfer' AND NEW.direction = 'credit' THEN PERFORM pg_advisory_xact_lock(${barrier}); END IF; RETURN NEW; END $$`,
    );
    await db.query(
      'CREATE TRIGGER spot_transfer_test_commit_barrier BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION spot_transfer_test_commit_barrier()',
    );
    const [source, destination] = await Promise.all([
      cash(s, 'securities'),
      cash(s, 'crypto_spot'),
    ]);
    const body = {
      sourceWalletId: source.id,
      destinationWalletId: destination.id,
      amount: '1',
      idempotencyKey: randomUUID(),
    };
    const endAt = new Date((await dbNow()).getTime() + 3_000);
    await prisma.season.update({
      where: { id: s.season.id },
      data: { endAt },
    });
    const start = () => {
      const command = app.transfers.transfer(s.userId, s.accountId, body);
      void command.catch(() => {});
      pending.push(command);
      return command;
    };
    const first = start();
    await waitUntil(async () => {
      const result = await db.query(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted",
        [barrier],
      );
      return result.rowCount === 1;
    });
    const second = start();
    await waitUntil(async () => {
      const result = await db.query(
        `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
         AND query LIKE '%FROM "cash_wallets"%'
         AND pg_blocking_pids(pid) && ARRAY(
           SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted
         )`,
        [barrier],
      );
      return (result.rowCount ?? 0) > 0;
    });
    await waitUntil(async () => (await dbNow()) >= endAt);
    await db.query('SELECT pg_advisory_unlock($1)', [barrier]);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(b, a);
    assert.ok(
      (await cash(s, 'securities')).balanceAmount.eq(
        source.balanceAmount.sub('1'),
      ),
    );
    assert.ok(
      (await cash(s, 'crypto_spot')).balanceAmount.eq(
        destination.balanceAmount.add('1'),
      ),
    );
    assert.equal(
      await prisma.walletTransfer.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    assert.equal(
      await prisma.walletTransaction.count({
        where: { referenceId: a.data.transferId },
      }),
      2,
    );
    await reject(
      app.transfers.transfer(s.userId, s.accountId, {
        ...body,
        idempotencyKey: randomUUID(),
      }),
      'SEASON_ENDED',
    );
    console.log(
      'PASS Season deadline: concurrent committed replay survives wallet wait; new command stays blocked',
    );
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [barrier]);
    await Promise.allSettled(pending);
    await db.query(
      'DROP TRIGGER IF EXISTS spot_transfer_test_commit_barrier ON wallet_transactions',
    );
    await db.query(
      'DROP FUNCTION IF EXISTS spot_transfer_test_commit_barrier()',
    );
    await db.end();
  }
}

async function modern(s: Scenario) {
  const securitiesBefore = (await cash(s, 'securities')).balanceAmount;
  // Securities has cash but cannot fund a Spot quote.
  await reject(orderCommand(s, 'buy', 'market'), 'INSUFFICIENT_BALANCE');
  const account = await app.access.getOwnedAccountOrThrow(
    s.userId,
    s.accountId,
  );
  const valuationAt = await dbNow();
  const before = await app.valuation.calculateTradingAccountValuation(
    account.id,
    valuationAt,
  );
  if (s.season)
    await app.ranking.refreshCurrentRankingForSeason(s.season.id, {
      capturedAt: valuationAt,
    });
  const rankBefore = s.season
    ? await prisma.seasonRanking.findMany({
        where: { seasonId: s.season.id },
        select: { rank: true, returnRate: true, totalAssetKrw: true },
      })
    : null;
  if (rankBefore) assert.equal(rankBefore.length, 1);
  const snapshots = await prisma.equitySnapshot.count({
    where: { tradingAccountId: s.accountId },
  });
  const twrBefore =
    s.mode === 'general'
      ? await app.performance.resolveLivePerformance({ account, valuationAt })
      : null;
  const first = await transfer(s, 'securities', 'crypto_spot', '2000');
  const after = await app.valuation.calculateTradingAccountValuation(
    account.id,
    valuationAt,
  );
  assert.deepEqual(after, before);
  if (s.season) {
    await app.ranking.refreshCurrentRankingForSeason(s.season.id, {
      capturedAt: new Date(valuationAt.getTime() + 1),
    });
    assert.deepEqual(
      await prisma.seasonRanking.findMany({
        where: { seasonId: s.season.id },
        select: { rank: true, returnRate: true, totalAssetKrw: true },
      }),
      rankBefore,
    );
  }
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: s.accountId },
    }),
    snapshots,
  );
  if (twrBefore)
    assert.deepEqual(
      (await app.performance.resolveLivePerformance({ account, valuationAt }))
        .advance,
      twrBefore.advance,
    );
  assert.ok(
    (await cash(s, 'securities')).balanceAmount.eq(
      securitiesBefore.sub('2000'),
    ),
  );
  const legs = await prisma.walletTransaction.findMany({
    where: {
      referenceType: 'wallet_transfer',
      referenceId: first.data.transferId,
    },
  });
  const ledger = await app.wallets.getWalletTransactionsForTradingAccount(
    s.userId,
    s.accountId,
    { currency: 'USD', txType: 'wallet_transfer' },
  );
  assert.equal(ledger.data.transactions.length, 2);
  assert.ok(
    ledger.data.transactions.every(
      (row) =>
        row.transfer?.sourceWalletId === first.data.source.walletId &&
        row.transfer.destinationWalletId === first.data.destination.walletId,
    ),
  );
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((l) => l.direction).sort(), ['credit', 'debit']);
  assert.ok(
    legs.every(
      (l) =>
        l.amount.eq('2000') &&
        l.tradingAccountId === s.accountId &&
        l.currencyCode === 'USD' &&
        l.txType === 'wallet_transfer',
    ),
  );
  assert.equal(
    await prisma.walletTransaction.count({
      where: {
        tradingAccountId: s.accountId,
        txType: { in: ['initial_grant', 'ad_reward'] },
      },
    }),
    s.mode === 'general' ? 1 : 0,
  );
  // Round trips include Futures cash, without margin/Position semantics.
  await transfer(s, 'crypto_spot', 'crypto_futures', '20');
  await transfer(s, 'crypto_futures', 'crypto_spot', '20');
  await transfer(s, 'crypto_spot', 'securities', '10');
  await transfer(s, 'securities', 'crypto_spot', '10');
  const securities = await cash(s, 'securities');
  const futures = await cash(s, 'crypto_futures');
  for (const side of ['buy', 'sell'] as const) {
    const command = await orderCommand(s, side, 'market');
    const executed = await create(s, command);
    const beforeReplay = await balances(s);
    const replay = await create(s, command);
    assert.deepEqual(replay, executed);
    assert.deepEqual(await balances(s), beforeReplay);
    await assertOrderLedger(s, executed.data.order.orderId, 'crypto_spot');
    if (side === 'buy') {
      const again = await app.orders.executeOrder(
        s.userId,
        executed.data.order.orderId,
      );
      assert.equal(again.data.order.orderId, executed.data.order.orderId);
      assert.deepEqual(await balances(s), beforeReplay);
    }
  }
  assert.ok(
    (await cash(s, 'securities')).balanceAmount.eq(securities.balanceAmount),
  );
  assert.ok(
    (await cash(s, 'crypto_futures')).balanceAmount.eq(futures.balanceAmount),
  );

  // Quote is not funding: draining Spot after quote makes create fail and roll back.
  const unfunded = await orderCommand(s, 'buy', 'market');
  const spotCash = (await cash(s, 'crypto_spot')).balanceAmount.toFixed(8);
  await transfer(s, 'crypto_spot', 'crypto_futures', spotCash);
  const drained = await balances(s);
  await reject(create(s, unfunded), 'INSUFFICIENT_BALANCE');
  assert.deepEqual(await balances(s), drained);
  assert.equal(
    (await prisma.quote.findUniqueOrThrow({ where: { id: unfunded.quoteId } }))
      .status,
    'active',
  );
  await transfer(s, 'crypto_futures', 'crypto_spot', spotCash);

  // Limit reservation, replay, cancel replay, Path A and Path B in the real matcher.
  let command = await orderCommand(s, 'buy', 'limit');
  let created = await create(s, command);
  assert.equal(
    (await cash(s, 'crypto_spot')).reservedAmount.toFixed(8),
    '100.10000000',
  );
  assert.equal((await cash(s, 'securities')).reservedAmount.toFixed(8), zero);
  const reservedState = await balances(s);
  await create(s, command);
  assert.deepEqual(await balances(s), reservedState);
  await app.orders.cancelOrderForTradingAccount(
    s.userId,
    s.accountId,
    created.data.order.orderId,
  );
  const canceled = await balances(s);
  await app.orders.cancelOrderForTradingAccount(
    s.userId,
    s.accountId,
    created.data.order.orderId,
  );
  assert.deepEqual(await balances(s), canceled);
  command = await orderCommand(s, 'buy', 'limit');
  created = await create(s, command);
  await refresh(s);
  const summaryA = await app.matcher.matchDueLimitOrders({
    now: await dbNow(),
  });
  assert.ok(summaryA.filledPathA >= 1);
  await assertOrderLedger(s, created.data.order.orderId, 'crypto_spot');
  const filledState = await balances(s);
  await app.matcher.matchDueLimitOrders({ now: await dbNow() });
  assert.deepEqual(await balances(s), filledState);
  command = await orderCommand(s, 'buy', 'limit');
  created = await create(s, command);
  const opened = new Date(
    Math.floor((await dbNow()).getTime() / 300_000) * 300_000 - 600_000,
  );
  await prisma.order.update({
    where: { id: created.data.order.orderId },
    data: { submittedAt: opened },
  });
  await refresh(s, '101');
  await prisma.marketCandle.create({
    data: {
      assetId: s.asset.id,
      interval: '5m',
      openTime: opened,
      closeTime: new Date(opened.getTime() + 300_000),
      open: '101',
      high: '105',
      low: '90',
      close: '101',
      volume: '10',
      isClosed: true,
      sourceProvider: 'binance',
      sourceUpdatedAt: new Date(opened.getTime() + 300_000),
    },
  });
  const summaryB = await app.matcher.matchDueLimitOrders({
    now: await dbNow(),
  });
  assert.ok(summaryB.filledPathB >= 1);
  await assertOrderLedger(s, created.data.order.orderId, 'crypto_spot');
  command = await orderCommand(s, 'sell', 'limit');
  created = await create(s, command);
  assert.equal(
    (
      await prisma.position.findUniqueOrThrow({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: s.accountId,
            assetId: s.asset.id,
          },
        },
      })
    ).reservedQuantity.toFixed(8),
    '1.00000000',
  );
  await refresh(s);
  await app.matcher.matchDueLimitOrders({ now: await dbNow() });
  await assertOrderLedger(s, created.data.order.orderId, 'crypto_spot');

  // Amounts in this command replay exactly even after later cash movements.
  const source = await cash(s, 'securities'),
    destination = await cash(s, 'crypto_spot');
  const body = {
    sourceWalletId: source.id,
    destinationWalletId: destination.id,
    amount: '3',
    idempotencyKey: randomUUID(),
  };
  const copies = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.transfers.transfer(s.userId, s.accountId, body),
    ),
  );
  for (const copy of copies) assert.deepEqual(copy, copies[0]);
  assert.equal(
    await prisma.walletTransfer.count({
      where: {
        tradingAccountId: s.accountId,
        idempotencyKey: body.idempotencyKey,
      },
    }),
    1,
  );
  await transfer(s, 'crypto_spot', 'crypto_futures', '1');
  // Opposite directions lock the same two wallets in the same ID order.
  const opposingBefore = await balances(s);
  await Promise.all([
    transfer(s, 'crypto_spot', 'crypto_futures', '1'),
    transfer(s, 'crypto_futures', 'crypto_spot', '1'),
  ]);
  assert.deepEqual(await balances(s), opposingBefore);
  assert.deepEqual(
    await app.transfers.transfer(s.userId, s.accountId, {
      ...body,
      amount: '3.00000000',
    }),
    copies[0],
  );
  await reject(
    app.transfers.transfer(s.userId, s.accountId, { ...body, amount: '4' }),
    'WALLET_TRANSFER_IDEMPOTENCY_CONFLICT',
  );
  await reject(
    app.transfers.transfer(s.userId, s.accountId, {
      ...body,
      destinationWalletId: source.id,
      idempotencyKey: randomUUID(),
    }),
    'INVALID_WALLET_TRANSFER',
  );
  const krw = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_walletScope_currencyCode: {
        tradingAccountId: s.accountId,
        walletScope: 'securities',
        currencyCode: 'KRW',
      },
    },
  });
  await reject(
    app.transfers.transfer(s.userId, s.accountId, {
      ...body,
      sourceWalletId: krw.id,
      idempotencyKey: randomUUID(),
    }),
    'WALLET_TRANSFER_USD_ONLY',
  );
  await reject(
    app.transfers.transfer(s.userId, s.accountId, {
      ...body,
      amount: '999999',
      idempotencyKey: randomUUID(),
    }),
    'INSUFFICIENT_AVAILABLE_BALANCE',
  );
  // Foreign General/Season and user isolation: no row in either account moves.
  const other = await fixture(s.mode === 'general' ? 'season' : 'general');
  try {
    const otherWallet = await cash(other, 'crypto_spot');
    const thisBefore = await balances(s),
      otherBefore = await balances(other);
    await reject(
      app.transfers.transfer(s.userId, s.accountId, {
        ...body,
        destinationWalletId: otherWallet.id,
        idempotencyKey: randomUUID(),
      }),
      'WALLET_TRANSFER_WALLET_NOT_FOUND',
    );
    await reject(
      app.transfers.transfer(other.userId, s.accountId, body),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    // A damaged persisted transfer must not expose foreign wallet metadata.
    await prisma.walletTransfer.update({
      where: { id: copies[0].data.transferId },
      data: { destinationWalletId: otherWallet.id },
    });
    try {
      await reject(
        app.wallets.getWalletTransactionsForTradingAccount(
          s.userId,
          s.accountId,
          {
            currency: 'USD',
            direction: 'debit',
            txType: 'wallet_transfer',
          },
        ),
        'TRADING_ACCOUNT_INTEGRITY',
      );
    } finally {
      await prisma.walletTransfer.update({
        where: { id: copies[0].data.transferId },
        data: { destinationWalletId: destination.id },
      });
    }
    if (s.mode === 'general' && other.participant) {
      // Even two accounts owned by the same user cannot send across General/Season.
      await prisma.$transaction([
        prisma.tradingAccount.update({
          where: { id: other.accountId },
          data: { userId: s.userId },
        }),
        prisma.seasonParticipant.update({
          where: { id: other.participant.id },
          data: { userId: s.userId },
        }),
      ]);
      try {
        await reject(
          app.transfers.transfer(s.userId, s.accountId, {
            ...body,
            destinationWalletId: otherWallet.id,
            idempotencyKey: randomUUID(),
          }),
          'WALLET_TRANSFER_WALLET_NOT_FOUND',
        );
      } finally {
        await prisma.$transaction([
          prisma.tradingAccount.update({
            where: { id: other.accountId },
            data: { userId: other.userId },
          }),
          prisma.seasonParticipant.update({
            where: { id: other.participant.id },
            data: { userId: other.userId },
          }),
        ]);
      }
    }
    assert.deepEqual(await balances(s), thisBefore);
    assert.deepEqual(await balances(other), otherBefore);
  } finally {
    await cleanup(other);
  }

  // With $150 Spot available, $100.10 reservation and $100 transfer cannot both win.
  const spot = await cash(s, 'crypto_spot');
  await transfer(
    s,
    'crypto_spot',
    'crypto_futures',
    spot.balanceAmount.sub('150').toFixed(8),
  );
  command = await orderCommand(s, 'buy', 'limit');
  const races = await Promise.allSettled([
    create(s, command),
    transfer(s, 'crypto_spot', 'crypto_futures', '100'),
  ]);
  assert.equal(races.filter((r) => r.status === 'fulfilled').length, 1);
  const remaining = await cash(s, 'crypto_spot');
  assert.ok(remaining.balanceAmount.gte(remaining.reservedAmount));
  if (races[0].status === 'fulfilled') {
    await reject(
      transfer(s, 'crypto_spot', 'crypto_futures', '50'),
      'INSUFFICIENT_AVAILABLE_BALANCE',
    );
    await app.orders.cancelOrderForTradingAccount(
      s.userId,
      s.accountId,
      races[0].value.data.order.orderId,
    );
  }
  const concurrent = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      transfer(s, 'crypto_spot', 'crypto_futures', '20'),
    ),
  );
  const won = concurrent.filter((r) => r.status === 'fulfilled').length;
  assert.ok(won > 0);
  assert.ok((await cash(s, 'crypto_spot')).balanceAmount.gte(0));

  // PostgreSQL trigger failure after source debit: neither cash leg, command nor ledger survives.
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `CREATE FUNCTION spot_transfer_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tx_type = 'wallet_transfer' AND NEW.direction = 'credit' THEN RAISE EXCEPTION 'test ledger failure'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      `CREATE TRIGGER spot_transfer_test_failure BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION spot_transfer_test_failure()`,
    );
    const state = await balances(s),
      commands = await prisma.walletTransfer.count({
        where: { tradingAccountId: s.accountId },
      });
    await assert.rejects(transfer(s, 'securities', 'crypto_spot', '1'));
    assert.deepEqual(await balances(s), state);
    assert.equal(
      await prisma.walletTransfer.count({
        where: { tradingAccountId: s.accountId },
      }),
      commands,
    );
  } finally {
    await db.query(
      'DROP TRIGGER IF EXISTS spot_transfer_test_failure ON wallet_transactions',
    );
    await db.query('DROP FUNCTION IF EXISTS spot_transfer_test_failure()');
    await db.end();
  }

  // Lifecycle gates plus committed replay on an inactive account.
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: 'suspended' },
  });
  await reject(
    transfer(s, 'securities', 'crypto_spot', '1'),
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  assert.deepEqual(
    await app.transfers.transfer(s.userId, s.accountId, body),
    copies[0],
  );
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: 'closed' },
  });
  await reject(
    transfer(s, 'securities', 'crypto_spot', '1'),
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: 'active' },
  });
  if (s.season && s.participant) {
    await transfer(s, 'crypto_futures', 'crypto_spot', '200');
    command = await orderCommand(s, 'buy', 'limit');
    created = await create(s, command);
    await prisma.$transaction(async (tx) => {
      await tx.seasonParticipant.update({
        where: { id: s.participant!.id },
        data: { participantStatus: 'excluded' },
      });
      await app.cancel.cancelOpenLimitBuysForParticipantInTransaction(tx, {
        tradingAccountId: s.accountId,
        reason: 'participant_excluded',
        canceledAt: await dbNow(),
      });
    });
    assert.equal(
      (await cash(s, 'crypto_spot')).reservedAmount.toFixed(8),
      zero,
    );
    assert.equal(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: created.data.order.orderId },
        })
      ).status,
      'canceled',
    );
    await reject(
      transfer(s, 'securities', 'crypto_spot', '1'),
      'PARTICIPANT_EXCLUDED',
    );
    await prisma.seasonParticipant.update({
      where: { id: s.participant.id },
      data: { participantStatus: 'active' },
    });
    command = await orderCommand(s, 'buy', 'limit');
    created = await create(s, command);
    await prisma.season.update({
      where: { id: s.season.id },
      data: { status: 'ended' },
    });
    await reject(
      transfer(s, 'securities', 'crypto_spot', '1'),
      'SEASON_NOT_ACTIVE',
    );
    await app.cancel.cleanupEndedSeasonLimitReservations({
      now: await dbNow(),
    });
    assert.equal(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: created.data.order.orderId },
        })
      ).status,
      'canceled',
    );
    assert.equal(
      (await cash(s, 'crypto_spot')).reservedAmount.toFixed(8),
      zero,
    );
    await prisma.season.update({
      where: { id: s.season.id },
      data: { status: 'settled' },
    });
    await reject(
      transfer(s, 'securities', 'crypto_spot', '1'),
      'SEASON_NOT_ACTIVE',
    );
  }
  console.log(
    `PASS ${s.mode}: Spot market/limit, matcher A/B, transfer/TWR, replay, concurrency, rollback, lifecycle`,
  );
}

// Run the real migration over pre-cutover rows, then process their lifecycle
// using a client bound to this private schema (public rows are never rewritten).
async function legacy() {
  const schema = 'spot_legacy_' + randomUUID().replaceAll('-', '');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let client: PrismaClient | undefined;
  const insert = async (table: string, data: Record<string, unknown>) => {
    const names = Object.keys(data);
    await db.query(
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`,
      Object.values(data).map((value) =>
        value instanceof Date ? value.toISOString() : value,
      ),
    );
  };
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    for (const migration of readdirSync('prisma/migrations')
      .filter((n) => /^\d/.test(n) && n < CUTOVER)
      .sort()) {
      await db.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8')
          .replaceAll("'public.'", `'${schema}.'`)
          .replaceAll(
            'FROM pg_type WHERE',
            'FROM pg_type WHERE typnamespace = current_schema()::regnamespace AND',
          ),
      );
    }
    const now = new Date();
    await insert('users', {
      id: 'owner',
      email: 'legacy@example.com',
      nickname: 'legacy',
      password_hash: 'test',
      updated_at: now,
    });
    await insert('seasons', {
      id: 'season',
      name: 'legacy',
      status: 'active',
      start_at: new Date(now.getTime() - 86400_000),
      end_at: new Date(now.getTime() + 86400_000),
      initial_capital_krw: '10000000',
      trade_fee_rate: '0.001',
      fx_fee_rate: '0.001',
      updated_at: now,
    });
    await insert('trading_accounts', {
      id: 'account',
      user_id: 'owner',
      mode: 'season',
      initial_capital_krw: '10000000',
      opened_at: now,
      updated_at: now,
    });
    await insert('season_participants', {
      id: 'participant',
      user_id: 'owner',
      season_id: 'season',
      trading_account_id: 'account',
      participant_status: 'active',
      joined_at: now,
      initial_capital_krw: '10000000',
      total_asset_krw: '10000000',
      total_return_rate: '0',
      max_drawdown: '0',
      updated_at: now,
    });
    for (const [id, scope, currency] of [
      ['krw', 'securities', 'KRW'],
      ['usd', 'securities', 'USD'],
      ['spot', 'crypto_spot', 'USD'],
      ['future', 'crypto_futures', 'USD'],
    ])
      await insert('cash_wallets', {
        id,
        trading_account_id: 'account',
        wallet_scope: scope,
        currency_code: currency,
        balance_amount: id === 'usd' ? '1000' : '0',
        reserved_amount: id === 'usd' ? '200.2' : '0',
        updated_at: now,
      });
    await insert('assets', {
      id: 'asset',
      symbol: 'LEGACY',
      name: 'legacy',
      market: 'BINANCE',
      asset_type: 'crypto',
      currency_code: 'USD',
      price_currency: 'USD',
      settlement_currency: 'USD',
      updated_at: now,
    });
    await insert('positions', {
      id: 'position',
      trading_account_id: 'account',
      asset_id: 'asset',
      quantity: '3',
      reserved_quantity: '2',
      average_cost: '100',
      currency_code: 'USD',
      updated_at: now,
    });
    for (const side of ['buy', 'sell'])
      for (const action of ['cancel', 'fill'])
        await insert('orders', {
          id: side + action,
          trading_account_id: 'account',
          asset_id: 'asset',
          side,
          order_type: 'limit',
          quantity: '1',
          limit_price: '100',
          currency_code: 'USD',
          reserved_amount: side === 'buy' ? '100.1' : null,
          reserved_quantity: side === 'sell' ? '1' : null,
          reservation_fee_rate: '0.001',
          submitted_at: now,
          updated_at: now,
        });
    await insert('asset_price_snapshots', {
      id: 'price',
      asset_id: 'asset',
      currency_code: 'USD',
      price: '100',
      source_type: 'provider_api',
      source_name: 'binance_spot_ws_ticker',
      effective_at: now,
      captured_at: now,
    });
    await insert('fx_rate_snapshots', {
      id: 'fx',
      base_currency: 'USD',
      quote_currency: 'KRW',
      rate: '1400',
      source_type: 'provider_api',
      source_name: 'korea_exim_exchange_rate',
      effective_at: now,
      captured_at: now,
    });
    await insert('quotes', {
      id: 'quote',
      user_id: 'owner',
      trading_account_id: 'account',
      quote_type: 'order',
      asset_id: 'asset',
      side: 'buy',
      order_type: 'market',
      quantity: '1',
      source_amount: '100',
      currency_code: 'USD',
      quoted_price: '100',
      quoted_rate: '1400',
      quoted_fee_rate: '0.001',
      asset_price_snapshot_id: 'price',
      fx_rate_snapshot_id: 'fx',
      max_change_bps: '30',
      expires_at: new Date(now.getTime() + 600_000),
      request_hash: computeOrderQuoteRequestHash({
        userId: 'owner',
        tradingAccountId: 'account',
        seasonParticipantId: 'participant',
        assetId: 'asset',
        side: 'buy',
        orderType: 'market',
        quantity: null,
        amount: d('100'),
        limitPrice: null,
        currencyCode: 'USD',
      }),
      updated_at: now,
    });
    const fingerprint = async () =>
      (
        await db.query(
          `SELECT jsonb_build_object('wallets', (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM cash_wallets w), 'positions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM positions p), 'orders', (SELECT jsonb_agg(to_jsonb(o) - 'cash_wallet_scope' ORDER BY id) FROM orders o), 'quotes', (SELECT jsonb_agg(to_jsonb(q) - 'cash_wallet_scope' ORDER BY id) FROM quotes q))::text AS value`,
        )
      ).rows[0].value;
    const before = await fingerprint();
    await db.query(
      readFileSync(`prisma/migrations/${CUTOVER}/migration.sql`, 'utf8'),
    );
    assert.equal(await fingerprint(), before);
    assert.ok(
      (await db.query('SELECT cash_wallet_scope FROM orders')).rows.every(
        (r) => r.cash_wallet_scope === 'securities',
      ),
    );
    assert.equal(
      (await db.query('SELECT cash_wallet_scope FROM quotes')).rows[0]
        .cash_wallet_scope,
      'securities',
    );
    await assert.rejects(
      db.query(
        `UPDATE orders SET cash_wallet_scope = 'crypto_spot' WHERE id = 'buyfill'`,
      ),
    );
    // Backfill assertions above use the original cutover. Exercise the current
    // order implementation only after applying the remaining additive schema.
    for (const migration of readdirSync('prisma/migrations')
      .filter((n) => /^\d/.test(n) && n > CUTOVER)
      .sort()) {
      await db.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8')
          .replaceAll("'public.'", `'${schema}.'`)
          .replaceAll(
            'FROM pg_type WHERE',
            'FROM pg_type WHERE typnamespace = current_schema()::regnamespace AND',
          ),
      );
    }
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: process.env.DATABASE_URL,
          options: `-c search_path=${schema} -c timezone=UTC`,
        },
        { schema },
      ),
    });
    const legacyDb = client as unknown as PrismaService,
      old = services(legacyDb);
    const usd = () =>
      client!.cashWallet.findUniqueOrThrow({ where: { id: 'usd' } });
    await old.orders.cancelOrderForTradingAccount(
      'owner',
      'account',
      'buycancel',
    );
    assert.equal((await usd()).reservedAmount.toFixed(8), '100.10000000');
    const tick = await dbNow(legacyDb);
    await client.assetPriceSnapshot.update({
      where: { id: 'price' },
      data: { effectiveAt: tick, capturedAt: tick },
    });
    await client.fxRateSnapshot.update({
      where: { id: 'fx' },
      data: { effectiveAt: tick, capturedAt: tick },
    });
    const fill = await old.execution.fillLimitOrder({
      orderId: 'buyfill',
      plan: {
        path: 'snapshot',
        executedPrice: d('100'),
        assetPriceSnapshotId: 'price',
      },
    });
    assert.equal(fill.state, 'filled', JSON.stringify(fill));
    assert.equal((await usd()).reservedAmount.toFixed(8), zero);
    assert.equal((await usd()).balanceAmount.toFixed(8), '899.90000000');
    await old.orders.cancelOrderForTradingAccount(
      'owner',
      'account',
      'sellcancel',
    );
    assert.equal(
      (
        await client.position.findUniqueOrThrow({ where: { id: 'position' } })
      ).reservedQuantity.toFixed(8),
      '1.00000000',
    );
    assert.equal(
      (
        await old.execution.fillLimitOrder({
          orderId: 'sellfill',
          plan: {
            path: 'snapshot',
            executedPrice: d('100'),
            assetPriceSnapshotId: 'price',
          },
        })
      ).state,
      'filled',
    );
    assert.equal((await usd()).balanceAmount.toFixed(8), '999.80000000');
    assert.equal(
      (
        await client.position.findUniqueOrThrow({ where: { id: 'position' } })
      ).quantity.toFixed(8),
      '3.00000000',
    );
    assert.equal(
      (
        await client.position.findUniqueOrThrow({ where: { id: 'position' } })
      ).reservedQuantity.toFixed(8),
      zero,
    );
    // Active pre-cutover quote also settles on Securities; new crypto quote cannot use it.
    await old.orders.createOrderForTradingAccount('owner', 'account', {
      assetId: 'asset',
      side: 'buy',
      orderType: 'market',
      amount: '100',
      quoteId: 'quote',
      idempotencyKey: 'legacy-quote',
    });
    await reject(
      old.orders.quoteOrderForTradingAccount('owner', 'account', {
        assetId: 'asset',
        side: 'buy',
        orderType: 'market',
        amount: '100',
      }),
      'INSUFFICIENT_BALANCE',
    );
    const spot = await client.cashWallet.findUniqueOrThrow({
      where: { id: 'spot' },
    });
    assert.equal(spot.balanceAmount.toFixed(8), zero);
    assert.equal(spot.reservedAmount.toFixed(8), zero);
    const ledgers = await client.walletTransaction.findMany({
      where: { referenceType: 'order' },
    });
    assert.equal(ledgers.length, 3);
    assert.ok(
      ledgers.every(
        (l) =>
          l.walletId === 'usd' &&
          l.tradingAccountId === 'account' &&
          l.currencyCode === 'USD',
      ),
    );
    // Wrong expected scope remains fail-closed even when amount guards pass.
    assert.equal(
      await debitAvailableCash(legacyDb, {
        walletId: 'usd',
        tradingAccountId: 'account',
        walletScope: 'crypto_spot',
        currencyCode: 'USD',
        amount: '1',
      }),
      0,
    );
    console.log(
      'PASS legacy: real backfill preserves cash/Positions; BUY/SELL fill/cancel and active Quote use Securities',
    );
  } finally {
    await client?.$disconnect();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
}

async function main() {
  await prisma.$connect();
  try {
    await legacy();
    const deadlineScenario = await fixture('season');
    try {
      await seasonReplayAcrossDeadline(deadlineScenario);
    } finally {
      await cleanup(deadlineScenario);
    }
    for (const mode of ['general', 'season'] as const) {
      const s = await fixture(mode);
      try {
        await modern(s);
      } finally {
        await cleanup(s);
      }
    }
    console.log('spot wallet transfer db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
