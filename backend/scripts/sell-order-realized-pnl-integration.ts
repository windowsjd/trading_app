/**
 * Per-order realized PnL of Spot SELL fills (orders.realized_pnl, 2026-11-06,
 * docs/orders-api-contract.md 「Per-order realized PnL」) on a real disposable
 * PostgreSQL. Every confirmed SELL fill must store EXACTLY the realized PnL its
 * own transaction added to positions.realized_pnl (no second calculation), in
 * the order's settlement currency, atomically with the fill and only once;
 * buys, unfilled and canceled orders keep NULL, and NULL stays apart from 0.
 *
 * Covered here: market SELL (KRW stock, USD crypto) after several buys, partial
 * sale, re-buy and re-sale, loss and exact zero, limit SELL path A (snapshot)
 * and path B (candle), canceled/submitted limits, committed replay, two SELLs
 * racing for one holding, rollback when a later write fails or the PnL write
 * itself fails (market and limit), retry after a failure, every order-history
 * read, a pre-column row, and the column's shape. Partial (ERS) market fills:
 * market-execution-integration.ts. Conditional SELL, TP/SL and LOC SELL:
 * conditional-sell-orders-integration.ts. A SELL after a general reset:
 * general-account-reset-integration.ts.
 */
import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, type Position } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import {
  OrdersService,
  type OrderRequestBody,
} from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { RecordsService } from '../src/records/records.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
import { resetMarketSessionOverrideStoreForTest } from '../src/orders/market-calendar/market-session-override.store';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
const disposableDatabase =
  target.pathname.endsWith('_test') ||
  (process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/trading_app');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SELL_REALIZED_PNL_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !disposableDatabase
) {
  // The rollback cases add (and drop) a probe trigger and constraint.
  throw new Error(
    'Explicit opt-in and a local disposable test database are required.',
  );
}
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';

const db = new PrismaService();
const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const general = new GeneralAccountsService(db, performance);
const reservation = new OrderReservationService();
const orders = new OrdersService(
  db,
  undefined,
  new LimitOrderCreateService(db, reservation),
  new LimitOrderCancelService(db, reservation),
  access,
  performance,
);
const candleEvidence = new LimitOrderCandleEvidenceService(db);
const fills = new LimitOrderExecutionService(
  db,
  candleEvidence,
  orders,
  performance,
);
const records = new RecordsService(db, valuation);

const PROBE_TRIGGER = 'realized_pnl_probe_snapshot_failure';
const PROBE_CONSTRAINT = 'orders_realized_pnl_probe';
const userIds: string[] = [];
const accountIds: string[] = [];
const assetIds: string[] = [];
const seasonIds: string[] = [];
const fxIds: string[] = [];
let checks = 0;

type Account = { userId: string; accountId: string; seasonId?: string };
type Asset = { id: string; market: 'KRX' | 'BINANCE' };

const D = (value: string | number | Prisma.Decimal) =>
  new Prisma.Decimal(value);
const money = (value: string | number | Prisma.Decimal) => D(value).toFixed(8);
const halfUp = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);

function pass(label: string) {
  checks++;
  console.log(`PASS realized PnL ${label}`);
}
function codeOf(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { code?: string } };
    return body.error?.code ?? `HTTP_${error.getStatus()}`;
  }
  return (error as { code?: string } | null)?.code ?? 'UNKNOWN';
}
/** The work fails with the injected probe's own error, not an earlier one. */
async function rejectsWithProbe(work: Promise<unknown>, probe: string) {
  try {
    await work;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert.ok(text.includes(probe), `expected the ${probe} failure: ${text}`);
    return;
  }
  assert.fail('expected the operation to fail');
}
async function dbNow(): Promise<Date> {
  const [row] = await db.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  return row.now;
}

async function user(label: string) {
  const id = randomUUID();
  await db.user.create({
    data: {
      id,
      email: `pnl-${label}-${id}@example.invalid`,
      nickname: `pnl${id.slice(0, 12)}`,
      passwordHash: 'test-only',
    },
  });
  userIds.push(id);
  return id;
}
async function generalAccount(label: string): Promise<Account> {
  const userId = await user(label);
  const accountId = (await general.openGeneralAccount(userId)).data.account.id;
  accountIds.push(accountId);
  // USD for crypto fills: a fixture balance on the Spot wallet.
  await db.cashWallet.update({
    where: {
      tradingAccountId_walletScope_currencyCode: {
        tradingAccountId: accountId,
        walletScope: 'crypto_spot',
        currencyCode: 'USD',
      },
    },
    data: { balanceAmount: '10000' },
  });
  return { userId, accountId };
}
async function seasonAccount(label: string): Promise<Account> {
  const userId = await user(label);
  const now = await dbNow();
  const season = await db.season.create({
    data: {
      name: `pnl-${randomUUID()}`,
      status: 'active',
      startAt: new Date(now.getTime() - 86_400_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.002',
      fxFeeRate: '0.001',
    },
  });
  seasonIds.push(season.id);
  const account = await db.tradingAccount.create({
    data: {
      userId,
      mode: 'season',
      initialCapitalKrw: '10000000',
      openedAt: now,
    },
  });
  accountIds.push(account.id);
  await db.seasonParticipant.create({
    data: {
      userId,
      seasonId: season.id,
      tradingAccountId: account.id,
      participantStatus: 'active',
      joinedAt: now,
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
  await db.cashWallet.createMany({
    data: [
      {
        tradingAccountId: account.id,
        walletScope: 'securities',
        currencyCode: 'KRW',
        balanceAmount: '10000000',
      },
      {
        tradingAccountId: account.id,
        walletScope: 'securities',
        currencyCode: 'USD',
        balanceAmount: '0',
      },
      ...zeroCryptoCashWalletData(account.id),
    ],
  });
  return { userId, accountId: account.id, seasonId: season.id };
}
async function asset(market: Asset['market']): Promise<Asset> {
  const krx = market === 'KRX';
  const row = await db.asset.create({
    data: {
      symbol: `PNL${randomUUID().replace(/-/gu, '').slice(0, 12).toUpperCase()}`,
      name: 'realized-pnl-integration',
      market,
      assetType: krx ? 'domestic_stock' : 'crypto',
      currencyCode: krx ? 'KRW' : 'USD',
      priceCurrency: krx ? 'KRW' : 'USD',
      settlementCurrency: krx ? 'KRW' : 'USD',
      isActive: true,
    },
  });
  assetIds.push(row.id);
  return { id: row.id, market };
}
/** Eligible provider evidence stamped on the DB clock. */
async function price(a: Asset, value: string) {
  const at = await dbNow();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: a.id,
      price: value,
      currencyCode: a.market === 'KRX' ? 'KRW' : 'USD',
      sourceType: 'provider_api',
      sourceName:
        a.market === 'KRX'
          ? 'koscom_krx_realtime_price'
          : 'binance_public_rest_24hr_ticker',
      effectiveAt: at,
      capturedAt: at,
    },
    select: { id: true },
  });
}
async function freshFx() {
  const at = await dbNow();
  const row = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'exchange_rate_api',
      effectiveAt: at,
      capturedAt: at,
    },
    select: { id: true },
  });
  fxIds.push(row.id);
}

/** The ordinary user quote → create core. */
async function create(
  s: Account,
  request: OrderRequestBody,
  key: string = randomUUID(),
) {
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  const body = { ...request, quoteId: quote.data.quoteId, idempotencyKey: key };
  const response = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  return { body, response, orderId: response.data.order.orderId };
}
const marketBuy = (s: Account, a: Asset, size: string) =>
  create(s, {
    assetId: a.id,
    side: 'buy',
    orderType: 'market',
    ...(a.market === 'BINANCE' ? { amount: size } : { quantity: size }),
  });
const marketSell = (s: Account, a: Asset, quantity: string) =>
  create(s, { assetId: a.id, side: 'sell', orderType: 'market', quantity });
const limitSell = (
  s: Account,
  a: Asset,
  quantity: string,
  limitPrice: string,
) =>
  create(s, {
    assetId: a.id,
    side: 'sell',
    orderType: 'limit',
    quantity,
    limitPrice,
  });

const position = (s: Account, a: Asset) =>
  db.position.findUnique({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.accountId,
        assetId: a.id,
      },
    },
  });
async function held(s: Account, a: Asset): Promise<Position> {
  const row = await position(s, a);
  assert.ok(row, 'position exists');
  return row;
}
/** Every money/ledger/order fact of the account, as one comparable string. */
async function moneyState(s: Account) {
  const [positions, wallets, ledger, rows, quotes] = await Promise.all([
    db.position.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    }),
    db.cashWallet.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    }),
    db.walletTransaction.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
      select: { id: true, amount: true },
    }),
    db.order.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    }),
    db.quote.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    }),
  ]);
  return JSON.stringify({ positions, wallets, ledger, rows, quotes });
}

/**
 * A confirmed SELL fill: its order stores exactly the realized PnL the same
 * transaction added to the position (KRW figure by the unchanged policy), the
 * stored figure is that path's own engine formula, the average cost is
 * untouched and exactly one ledger credit of the net amount exists.
 */
async function expectRecordedSell(
  orderId: string,
  before: Position,
  path: 'market' | 'limit',
) {
  const row = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const after = await db.position.findUniqueOrThrow({
    where: { id: before.id },
  });
  assert.equal(row.side, 'sell');
  assert.equal(row.status, 'executed');
  assert.ok(row.realizedPnl !== null, 'a confirmed SELL fill records its PnL');
  assert.equal(
    money(row.realizedPnl),
    money(after.realizedPnl.sub(before.realizedPnl)),
    'order PnL = the delta its own fill applied to the position',
  );
  const quantity = row.executedQuantity ?? row.quantity;
  const cost =
    path === 'market'
      ? halfUp(before.averageCost.mul(quantity))
      : before.averageCost.mul(quantity);
  assert.equal(
    money(row.realizedPnl),
    money(halfUp(row.netAmount!.sub(cost))),
    `${path} engine formula`,
  );
  const krwDelta = after.realizedPnlKrw.sub(before.realizedPnlKrw);
  if (row.currencyCode === 'KRW') {
    assert.equal(money(krwDelta), money(row.realizedPnl));
  } else {
    const fx = await db.fxRateSnapshot.findUniqueOrThrow({
      where: { id: row.fxRateSnapshotId! },
    });
    assert.equal(money(krwDelta), money(halfUp(row.realizedPnl.mul(fx.rate))));
  }
  assert.equal(money(after.averageCost), money(before.averageCost));
  const ledger = await db.walletTransaction.findMany({
    where: { referenceId: orderId },
  });
  assert.equal(ledger.length, 1, 'one ledger row per fill');
  assert.equal(ledger[0].txType, 'order_sell');
  assert.equal(money(ledger[0].amount), money(row.netAmount!));
  return row;
}
async function expectUnrecorded(orderId: string, status: string) {
  const row = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(row.status, status);
  assert.equal(row.realizedPnl === null, true, `${status} ${row.side}: NULL`);
}

async function installSnapshotFailure(accountId: string) {
  // Fails the fill AFTER its order already stored the realized PnL.
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${PROBE_TRIGGER}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."trading_account_id" = '${accountId}' THEN
        RAISE EXCEPTION 'realized pnl probe: snapshot failure';
      END IF;
      RETURN NEW;
    END;
    $$`);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${PROBE_TRIGGER} BEFORE INSERT ON "equity_snapshots" FOR EACH ROW EXECUTE FUNCTION ${PROBE_TRIGGER}()`,
  );
}
async function dropSnapshotFailure() {
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${PROBE_TRIGGER} ON "equity_snapshots"`,
  );
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${PROBE_TRIGGER}()`);
}
async function installPnlWriteFailure(accountId: string) {
  // The realized-PnL write itself is refused for this account only.
  await db.$executeRawUnsafe(
    `ALTER TABLE "orders" ADD CONSTRAINT ${PROBE_CONSTRAINT} CHECK ("realized_pnl" IS NULL OR "trading_account_id" <> '${accountId}') NOT VALID`,
  );
}
async function dropPnlWriteFailure() {
  await db.$executeRawUnsafe(
    `ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS ${PROBE_CONSTRAINT}`,
  );
}

/** KRW stock: buys at two prices, partial sale, re-buy, loss, limit A, cancel, flat. */
async function krwLifecycle() {
  const s = await generalAccount('krw');
  const a = await asset('KRX');
  await price(a, '70000');
  const buy1 = await marketBuy(s, a, '10');
  await price(a, '72000');
  const buy2 = await marketBuy(s, a, '5');
  await expectUnrecorded(buy1.orderId, 'executed');
  await expectUnrecorded(buy2.orderId, 'executed');

  await price(a, '75000');
  let before = await held(s, a);
  const gain = await marketSell(s, a, '4');
  const gainRow = await expectRecordedSell(gain.orderId, before, 'market');
  assert.ok(gainRow.realizedPnl!.gt(0));
  pass('KRW market SELL after two buys: stored = position delta, gain');

  await price(a, '71000');
  await marketBuy(s, a, '3');
  await price(a, '69000');
  before = await held(s, a);
  const loss = await marketSell(s, a, '6');
  const lossRow = await expectRecordedSell(loss.orderId, before, 'market');
  assert.ok(lossRow.realizedPnl!.lt(0));
  pass(
    're-buy after a partial sale moves the cost; the next SELL stores a loss',
  );

  // Committed replay: the stored first response, and no financial write.
  const state = await moneyState(s);
  const replay = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    loss.body,
  );
  assert.deepEqual(replay, loss.response);
  assert.equal('realizedPnl' in loss.response.data.order, false);
  await orders.executeOrder(s.userId, loss.orderId);
  assert.equal(await moneyState(s), state, 'replay changes nothing');
  pass(
    'replay and already-executed execute leave the order PnL and money untouched',
  );

  const pending = await limitSell(s, a, '2', '70000');
  assert.equal(pending.response.data.order.status, 'submitted');
  await expectUnrecorded(pending.orderId, 'submitted');
  const evidence = await price(a, '70500');
  before = await held(s, a);
  const filled = await fills.fillLimitOrder({
    orderId: pending.orderId,
    plan: {
      path: 'snapshot',
      executedPrice: D('70500'),
      assetPriceSnapshotId: evidence.id,
    },
  });
  assert.equal(filled.state, 'filled');
  await expectRecordedSell(pending.orderId, before, 'limit');
  pass(
    'limit SELL path A: NULL while submitted, the fill stores its own delta',
  );

  const canceled = await limitSell(s, a, '1', '90000');
  await orders.cancelOrderForTradingAccount(
    s.userId,
    s.accountId,
    canceled.orderId,
  );
  await expectUnrecorded(canceled.orderId, 'canceled');

  await price(a, '70000');
  before = await held(s, a);
  const flat = await marketSell(s, a, before.quantity.toFixed(6));
  await expectRecordedSell(flat.orderId, before, 'market');
  assert.equal((await held(s, a)).quantity.isZero(), true);
  pass(
    'a canceled limit SELL stays NULL; selling to flat records the last fill',
  );

  // Every order-history read of the account: the key on every row.
  const list = await orders.getOrdersForTradingAccount(s.userId, s.accountId, {
    limit: '100',
  });
  const rows = await db.order.findMany({
    where: { tradingAccountId: s.accountId },
  });
  assert.equal(list.data.orders.length, rows.length);
  for (const listed of list.data.orders) {
    const row = rows.find((candidate) => candidate.id === listed.orderId)!;
    assert.equal('realizedPnl' in listed, true);
    assert.equal(
      listed.realizedPnl,
      row.realizedPnl === null ? null : money(row.realizedPnl),
    );
  }
  const detail = await orders.getOrderForTradingAccount(
    s.userId,
    s.accountId,
    gain.orderId,
  );
  assert.equal(detail.data.order.realizedPnl, money(gainRow.realizedPnl!));
  const buyDetail = await orders.getOrderForTradingAccount(
    s.userId,
    s.accountId,
    buy1.orderId,
  );
  assert.equal(buyDetail.data.order.realizedPnl, null);
  pass('account order list/detail return the stored figure; buys/limits null');
  return { s, gain };
}

/** An exactly zero result is recorded as 0, not as missing. */
async function zero() {
  const s = await generalAccount('zero');
  const a = await asset('KRX');
  await price(a, '999');
  await marketBuy(s, a, '1');
  // net 1001 − 1.001 = 999.999 = the cost basis (999 + 0.999 fee).
  await price(a, '1001');
  const before = await held(s, a);
  assert.equal(money(before.averageCost), '999.99900000');
  const sell = await marketSell(s, a, '1');
  const row = await expectRecordedSell(sell.orderId, before, 'market');
  assert.equal(money(row.realizedPnl!), '0.00000000');
  const listed = await orders.getOrdersForTradingAccount(
    s.userId,
    s.accountId,
    { side: 'sell' },
  );
  assert.equal(listed.data.orders[0].realizedPnl, '0.00000000');
  pass('a zero-PnL SELL stores and serves 0.00000000, never null');
}

/** USD crypto: amounts in USD, KRW by the fill's own FX evidence; path B. */
async function usd() {
  const s = await generalAccount('usd');
  const a = await asset('BINANCE');
  await freshFx();
  await price(a, '100');
  await marketBuy(s, a, '1000');
  await freshFx();
  await price(a, '120');
  let before = await held(s, a);
  const sell = await marketSell(s, a, '2.5');
  const row = await expectRecordedSell(sell.orderId, before, 'market');
  assert.equal(row.currencyCode, 'USD');
  assert.ok(row.realizedPnl!.gt(0));
  pass(
    'USD market SELL stores USD (settlement currency), KRW policy unchanged',
  );

  const pending = await limitSell(s, a, '1.5', '110');
  const now = await dbNow();
  const openTime = new Date(
    Math.floor(now.getTime() / 300_000) * 300_000 - 300_000,
  );
  const closeTime = new Date(openTime.getTime() + 300_000);
  // Submitted before the touching candle (fixture time only).
  await db.order.update({
    where: { id: pending.orderId },
    data: { submittedAt: new Date(openTime.getTime() - 3_600_000) },
  });
  await db.marketCandle.create({
    data: {
      assetId: a.id,
      interval: '5m',
      openTime,
      closeTime,
      open: '108',
      high: '125',
      low: '104',
      close: '112',
      volume: '1',
      isClosed: true,
      sourceProvider: 'binance',
      sourceUpdatedAt: closeTime,
      updatedAt: closeTime,
    },
  });
  const candle = (
    await candleEvidence.findEligibleClosedCandlesForAsset(
      { id: a.id, assetType: 'crypto', market: 'BINANCE' },
      await dbNow(),
      3_600_000,
    )
  ).find((row) => row.openTime.getTime() === openTime.getTime());
  assert.ok(candle, 'the closed candle is eligible evidence');
  await freshFx();
  before = await held(s, a);
  const filled = await fills.fillLimitOrder({
    orderId: pending.orderId,
    plan: { path: 'candle', executedPrice: D('110'), candle },
  });
  assert.equal(filled.state, 'filled');
  await expectRecordedSell(pending.orderId, before, 'limit');
  pass('limit SELL path B (closed candle, USD) stores its own delta');

  await freshFx();
  await price(a, '90');
  before = await held(s, a);
  const lossSell = await marketSell(s, a, '3');
  const lossRow = await expectRecordedSell(lossSell.orderId, before, 'market');
  assert.ok(lossRow.realizedPnl!.lt(0));
  pass('USD loss SELL');
}

/** Season account: legacy and records order reads carry the stored figure. */
async function season() {
  const s = await seasonAccount('season');
  const a = await asset('KRX');
  await price(a, '50000');
  const buy = await marketBuy(s, a, '3');
  await price(a, '52000');
  const before = await held(s, a);
  const sell = await marketSell(s, a, '2');
  const row = await expectRecordedSell(sell.orderId, before, 'market');
  const stored = money(row.realizedPnl!);
  const seasonId = s.seasonId!;
  const legacy = await orders.getOrders(s.userId, { seasonId });
  const legacyById = new Map(
    legacy.data.orders.map((order) => [order.orderId, order.realizedPnl]),
  );
  assert.equal(legacyById.get(sell.orderId), stored);
  assert.equal(legacyById.get(buy.orderId), null);
  assert.equal(
    (await orders.getOrder(s.userId, sell.orderId)).data.order.realizedPnl,
    stored,
  );
  const history = await records.getMySeasonOrders(s.userId, seasonId, {});
  const historyById = new Map(
    history.data.orders.map((order) => [order.orderId, order.realizedPnl]),
  );
  assert.equal(historyById.get(sell.orderId), stored);
  assert.equal(historyById.get(buy.orderId), null);
  const unified = await records.getRecords(s.userId, {
    seasonId,
    type: 'orders',
  });
  const unifiedById = new Map(
    (unified.data.orders?.records ?? []).map((order) => [
      order.orderId,
      order.realizedPnl,
    ]),
  );
  assert.equal(unifiedById.get(sell.orderId), stored);
  assert.equal(unifiedById.get(buy.orderId), null);
  pass('season SELL (season fee): legacy list/detail and both records reads');
}

/** Two SELLs race for the whole holding: one fills, one records. */
async function race() {
  const s = await generalAccount('race');
  const a = await asset('KRX');
  await price(a, '60000');
  await marketBuy(s, a, '10');
  await price(a, '61000');
  const before = await held(s, a);
  const request: OrderRequestBody = {
    assetId: a.id,
    side: 'sell',
    orderType: 'market',
    quantity: '10',
  };
  const quotes = await Promise.all([
    orders.quoteOrderForTradingAccount(s.userId, s.accountId, request),
    orders.quoteOrderForTradingAccount(s.userId, s.accountId, request),
  ]);
  const results = await Promise.allSettled(
    quotes.map((quote) =>
      orders.createOrderForTradingAccount(s.userId, s.accountId, {
        ...request,
        quoteId: quote.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  const won = results.filter((result) => result.status === 'fulfilled');
  const lost = results.filter((result) => result.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(
    ['INSUFFICIENT_QUANTITY', 'CONFLICT'].includes(codeOf(lost[0].reason)),
    codeOf(lost[0].reason),
  );
  const sells = await db.order.findMany({
    where: { tradingAccountId: s.accountId, side: 'sell' },
  });
  assert.equal(sells.length, 1, 'the losing create left no order');
  await expectRecordedSell(sells[0].id, before, 'market');
  pass('concurrent SELLs: the position guard lets one fill and one PnL');
}

/** Rollback: a later write fails, or the PnL write itself fails; then retry. */
async function rollbacks() {
  const s = await generalAccount('rollback');
  const a = await asset('KRX');
  await price(a, '60000');
  await marketBuy(s, a, '10');
  try {
    // 1) Market SELL, failure after the order stored its PnL.
    await price(a, '61000');
    const request: OrderRequestBody = {
      assetId: a.id,
      side: 'sell',
      orderType: 'market',
      quantity: '3',
    };
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      request,
    );
    const body = {
      ...request,
      quoteId: quote.data.quoteId,
      idempotencyKey: randomUUID(),
    };
    let state = await moneyState(s);
    await installSnapshotFailure(s.accountId);
    await rejectsWithProbe(
      orders.createOrderForTradingAccount(s.userId, s.accountId, body),
      'realized pnl probe',
    );
    assert.equal(await moneyState(s), state, 'market fill rolled back whole');
    await dropSnapshotFailure();
    let before = await held(s, a);
    const retried = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      body,
    );
    await expectRecordedSell(retried.data.order.orderId, before, 'market');
    assert.equal(
      await db.order.count({
        where: {
          tradingAccountId: s.accountId,
          idempotencyKey: body.idempotencyKey,
        },
      }),
      1,
    );
    pass(
      'market SELL failing after its PnL write rolls back whole; the retry records once',
    );

    // 2) Limit SELL fill, failure after the order stored its PnL.
    const pending = await limitSell(s, a, '2', '61000');
    const evidence = await price(a, '61500');
    const plan = {
      path: 'snapshot' as const,
      executedPrice: D('61500'),
      assetPriceSnapshotId: evidence.id,
    };
    state = await moneyState(s);
    await installSnapshotFailure(s.accountId);
    await rejectsWithProbe(
      fills.fillLimitOrder({ orderId: pending.orderId, plan }),
      'realized pnl probe',
    );
    assert.equal(await moneyState(s), state, 'limit fill rolled back whole');
    await expectUnrecorded(pending.orderId, 'submitted');
    await dropSnapshotFailure();
    before = await held(s, a);
    assert.equal(
      (await fills.fillLimitOrder({ orderId: pending.orderId, plan })).state,
      'filled',
    );
    await expectRecordedSell(pending.orderId, before, 'limit');
    pass(
      'limit fill failing after its PnL write rolls back whole; the retry records once',
    );

    // 3) The PnL write itself is refused: no fill commits without it.
    await price(a, '62000');
    const refusedQuote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      { ...request, quantity: '1' },
    );
    const second = await limitSell(s, a, '1', '61000');
    const secondEvidence = await price(a, '62000');
    state = await moneyState(s);
    await installPnlWriteFailure(s.accountId);
    await rejectsWithProbe(
      orders.createOrderForTradingAccount(s.userId, s.accountId, {
        ...request,
        quantity: '1',
        quoteId: refusedQuote.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      PROBE_CONSTRAINT,
    );
    await rejectsWithProbe(
      fills.fillLimitOrder({
        orderId: second.orderId,
        plan: {
          path: 'snapshot',
          executedPrice: D('62000'),
          assetPriceSnapshotId: secondEvidence.id,
        },
      }),
      PROBE_CONSTRAINT,
    );
    assert.equal(await moneyState(s), state, 'nothing commits without the PnL');
    await expectUnrecorded(second.orderId, 'submitted');
    pass('a refused PnL write rolls back the market fill and the limit fill');
  } finally {
    await dropSnapshotFailure();
    await dropPnlWriteFailure();
  }
}

/** Σ per-order PnL = each position's cumulative PnL; NULL ⇔ not a SELL fill. */
async function invariants() {
  const rows = await db.order.findMany({
    where: { tradingAccountId: { in: accountIds } },
  });
  for (const row of rows) {
    assert.equal(
      row.realizedPnl !== null,
      row.side === 'sell' && row.status === 'executed',
      `${row.side} ${row.status} ${row.id}`,
    );
  }
  const positions = await db.position.findMany({
    where: { tradingAccountId: { in: accountIds } },
  });
  for (const p of positions) {
    const sells = rows.filter(
      (row) =>
        row.tradingAccountId === p.tradingAccountId &&
        row.assetId === p.assetId &&
        row.realizedPnl !== null,
    );
    let local = D(0);
    let krw = D(0);
    for (const row of sells) {
      local = local.add(row.realizedPnl!);
      krw = krw.add(
        row.currencyCode === 'KRW'
          ? row.realizedPnl!
          : halfUp(
              row.realizedPnl!.mul(
                (
                  await db.fxRateSnapshot.findUniqueOrThrow({
                    where: { id: row.fxRateSnapshotId! },
                  })
                ).rate,
              ),
            ),
      );
    }
    assert.equal(money(local), money(p.realizedPnl), 'Σ order PnL = position');
    assert.equal(money(krw), money(p.realizedPnlKrw), 'Σ KRW = position KRW');
  }
  pass(
    `Σ per-order PnL = every position's cumulative PnL (${positions.length} positions, ${rows.length} orders)`,
  );
}

/** A SELL committed before the column existed reads as unknown, not 0. */
async function preColumnRow(s: Account, orderId: string) {
  await db.$executeRaw`UPDATE "orders" SET "realized_pnl" = NULL WHERE "id" = ${orderId}`;
  const list = await orders.getOrdersForTradingAccount(s.userId, s.accountId, {
    side: 'sell',
  });
  const listed = list.data.orders.find((order) => order.orderId === orderId);
  assert.ok(listed);
  assert.equal(listed.realizedPnl, null);
  assert.equal(
    (await orders.getOrderForTradingAccount(s.userId, s.accountId, orderId))
      .data.order.realizedPnl,
    null,
  );
  pass('a pre-column SELL row (NULL) is served as null, not 0');
}

/** The migration added exactly one nullable column: no default/index/CHECK. */
async function schema() {
  const columns = await db.$queryRaw<
    Array<{
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
      is_nullable: string;
      column_default: string | null;
    }>
  >`SELECT data_type, numeric_precision, numeric_scale, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'realized_pnl'`;
  assert.equal(columns.length, 1);
  assert.equal(columns[0].data_type, 'numeric');
  assert.equal(Number(columns[0].numeric_precision), 24);
  assert.equal(Number(columns[0].numeric_scale), 8);
  assert.equal(columns[0].is_nullable, 'YES');
  assert.equal(columns[0].column_default, null);
  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'orders' AND indexdef LIKE '%realized_pnl%'`;
  assert.equal(indexes.length, 0);
  const constraints = await db.$queryRaw<Array<{ conname: string }>>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"orders"'::regclass AND pg_get_constraintdef(oid) LIKE '%realized_pnl%'`;
  assert.equal(constraints.length, 0);
  const migration = await db.$queryRaw<Array<{ finished: boolean }>>`
    SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS finished
    FROM _prisma_migrations WHERE migration_name = '20261106180000_add_order_realized_pnl'`;
  assert.equal(migration.length, 1);
  assert.equal(migration[0].finished, true);
  pass(
    'orders.realized_pnl is one nullable DECIMAL(24,8), no default/index/CHECK',
  );
}

async function cleanup() {
  tradingSessions.reset();
  resetMarketSessionOverrideStoreForTest();
  await dropSnapshotFailure();
  await dropPnlWriteFailure();
  const scope = { tradingAccountId: { in: accountIds } };
  await db.walletTransaction.deleteMany({ where: scope });
  await db.equitySnapshot.deleteMany({ where: scope });
  await db.order.deleteMany({ where: scope });
  await db.quote.deleteMany({ where: scope });
  await db.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.marketCandle.deleteMany({ where: { assetId: { in: assetIds } } });
  await db.position.deleteMany({ where: scope });
  await db.cashWallet.deleteMany({ where: scope });
  await db.seasonParticipant.deleteMany({ where: scope });
  await db.tradingAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.season.deleteMany({ where: { id: { in: seasonIds } } });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.asset.deleteMany({ where: { id: { in: assetIds } } });
  // Leftover provider FX would reprice later suites sharing this database.
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: fxIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  await db.$connect();
  try {
    tradingSessions.set(await dbNow());
    // General-account snapshots value the USD wallets, so FX is needed for
    // KRW trades as well (a 2-hour valuation window).
    await freshFx();
    await schema();
    const { s, gain } = await krwLifecycle();
    await zero();
    await usd();
    await season();
    await race();
    await rollbacks();
    await invariants();
    await preColumnRow(s, gain.orderId);
    console.log(`Sell realized PnL PostgreSQL PASS (${checks} checks)`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
