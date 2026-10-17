import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cleanup,
  code,
  db,
  fixture,
  fxEvidence,
  fxEvidenceIds,
  now,
  type Scenario,
} from './futures-integration';
import { Prisma } from '../src/generated/prisma/client';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import {
  OrdersService,
  type OrderRequestBody,
} from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import {
  EXPANSION_2026_10_17,
  type KisFixedAssetUniverseEntry,
} from '../src/providers/kis/kis-fixed-asset-universe';
import { applyAssetUniverse } from './lib/asset-universe-apply';
import { buildKisDesiredUniverse } from './seed-kis-fixed-asset-universe';

/**
 * PostgreSQL regression of the existing order paths on representative stocks
 * of the 2026-10-17 expansion (report §10.4): the Asset rows exactly as the
 * fixed-universe seed registers them, priced only by their providers'
 * stored snapshots (US: `tiingo_us_reference_price` with
 * `US_STOCK_PRICE_PROVIDER=tiingo`; KRX: `koscom_krx_realtime_price`).
 *
 * Per stock: a market BUY fills at the stored provider price (a newer
 * KIS/operator price never stands in for a US stock), the wallet, position
 * and ledger move; a limit BUY waits, then the scheduled matcher (Path A)
 * fills it at a fresh provider snapshot that reaches the limit; a provider
 * price older than the execute freshness (10 s) refuses a market order; a
 * stock without any price refuses the quote. No order/fill/ledger rule is
 * changed by the expansion — this proves the new rows ride the same paths.
 *
 *   NODE_ENV=test STOCK_EXPANSION_ORDERS_DB_INTEGRATION=1 \
 *     DATABASE_URL=<disposable *_test> pnpm exec tsx scripts/stock-expansion-orders-integration.ts
 */
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.STOCK_EXPANSION_ORDERS_DB_INTEGRATION !== '1'
)
  throw new Error(
    'Explicit disposable stock-expansion orders PG opt-in required',
  );
process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';

const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
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
const candleEvidence = new LimitOrderCandleEvidenceService(db);
const matcher = new LimitOrderMatchingService(
  db,
  new LimitOrderCandidateRepository(db),
  candleEvidence,
  new LimitOrderExecutionService(db, candleEvidence, orders, performance),
);

type Pick = {
  entry: KisFixedAssetUniverseEntry;
  /** A tick-aligned price, the lower limit and the fill price below it. */
  price: string;
  limit: string;
  fill: string;
  currency: 'USD' | 'KRW';
  sourceName: string;
};

function representatives(): Pick[] {
  const us = EXPANSION_2026_10_17.filter((e) => e.assetType === 'us_stock');
  const krx = EXPANSION_2026_10_17.filter(
    (e) => e.assetType === 'domestic_stock',
  );
  const nas = us.find((e) => e.market === 'NAS');
  const nys = us.find((e) => e.market === 'NYS');
  assert.ok(nas && nys && krx.length > 0, 'expansion universe is not filled');
  const usPick = (entry: KisFixedAssetUniverseEntry): Pick => ({
    entry,
    price: '100.00',
    limit: '99.00',
    fill: '98.50',
    currency: 'USD',
    sourceName: 'tiingo_us_reference_price',
  });
  return [
    usPick(nas),
    usPick(nys),
    {
      entry: krx[0],
      // 50,000–200,000 KRW band: 100 KRW ticks.
      price: '100000',
      limit: '99000',
      fill: '98500',
      currency: 'KRW',
      sourceName: 'koscom_krx_realtime_price',
    },
  ];
}

let checks = 0;
function pass(label: string) {
  checks += 1;
  console.log(`ok - ${label}`);
}

async function rejects(work: Promise<unknown>, expected: string) {
  let observed = 'RESOLVED';
  try {
    await work;
  } catch (error) {
    observed = code(error);
  }
  assert.equal(observed, expected);
}

async function waitUntil(at: number) {
  const started = Date.now();
  while ((await now()).getTime() < at) {
    assert.ok(Date.now() - started < 120_000, 'DB clock did not advance');
    await delay(Math.min(1000, Math.max(25, at - Date.now())));
  }
}

async function price(
  assetId: string,
  value: string,
  currencyCode: 'USD' | 'KRW',
  sourceName: string,
  sourceType: 'provider_api' | 'admin_manual' = 'provider_api',
) {
  const clock = await now();
  await db.assetPriceSnapshot.create({
    data: {
      assetId,
      price: value,
      ...(currencyCode === 'KRW' ? { priceKrw: value } : {}),
      currencyCode,
      sourceType,
      sourceName,
      effectiveAt: clock,
      capturedAt: clock,
    },
  });
}

async function placeAs(s: Scenario, body: OrderRequestBody) {
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  const created = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    {
      ...body,
      quoteId: (quoted.data as { quoteId: string }).quoteId,
      idempotencyKey: randomUUID(),
    },
  );
  return created.data.order.orderId;
}

async function walletBalance(s: Scenario, currencyCode: 'USD' | 'KRW') {
  const row = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      walletScope: 'securities',
      currencyCode,
    },
  });
  return row.balanceAmount;
}

/** Registers the picked rows with the fixed-universe seed's own upsert. */
async function registerPicks(picks: readonly Pick[]) {
  const symbols = new Set(
    picks.map((p) => `${p.entry.market}:${p.entry.symbol}`),
  );
  const desired = buildKisDesiredUniverse().filter((row) =>
    symbols.has(`${row.market}:${row.symbol}`),
  );
  const existing = await db.asset.findMany({
    where: {
      OR: desired.map((row) => ({ market: row.market, symbol: row.symbol })),
    },
    select: { id: true },
  });
  const first = await applyAssetUniverse({ prisma: db, desired, apply: true });
  // Re-running the seed creates and updates nothing (no duplicate rows).
  const again = await applyAssetUniverse({ prisma: db, desired, apply: true });
  assert.equal(again.plan.creates.length, 0);
  assert.equal(again.plan.updates.length, 0);
  const rows = await db.asset.findMany({
    where: {
      OR: desired.map((row) => ({ market: row.market, symbol: row.symbol })),
    },
  });
  assert.equal(rows.length, desired.length);
  for (const row of rows) {
    const want = desired.find(
      (d) => d.market === row.market && d.symbol === row.symbol,
    );
    assert.ok(want);
    assert.equal(row.assetType, want.assetType);
    assert.equal(row.currencyCode, want.currencyCode);
    assert.equal(row.isActive, true);
  }
  pass(
    `seed registers ${desired.length} representative rows (${first.plan.creates.length} created), a rerun changes nothing`,
  );
  return {
    byKey: new Map(rows.map((row) => [`${row.market}:${row.symbol}`, row])),
    createdIds: rows
      .filter((row) => !existing.some((e) => e.id === row.id))
      .map((row) => row.id),
  };
}

async function scenario(pick: Pick, assetId: string) {
  const s = await fixture('general');
  const label = `${pick.entry.market}:${pick.entry.symbol}`;
  try {
    await db.cashWallet.updateMany({
      where: {
        tradingAccountId: s.accountId,
        walletScope: 'securities',
        currencyCode: pick.currency,
      },
      data: { balanceAmount: pick.currency === 'USD' ? '10000' : '10000000' },
    });
    const clock = await now();
    tradingSessions.set(clock, new Date(clock.getTime() + 300_000), [
      'KRX',
      'US',
    ]);
    if (pick.currency === 'USD') await fxEvidence();
    await db.assetPriceSnapshot.deleteMany({ where: { assetId } });

    // No price at all: the quote is refused, nothing is reserved.
    await rejects(
      placeAs(s, {
        assetId,
        side: 'buy',
        orderType: 'market',
        quantity: '1',
      }),
      'ASSET_PRICE_UNAVAILABLE',
    );

    await price(assetId, pick.price, pick.currency, pick.sourceName);
    if (pick.currency === 'USD') {
      // Never a stand-in for a US stock on Tiingo.
      await price(assetId, '150.00', 'USD', 'kis_us_delayed_trade');
      await price(assetId, '160.00', 'USD', 'admin_manual', 'admin_manual');
    }
    const before = await walletBalance(s, pick.currency);
    const boughtId = await placeAs(s, {
      assetId,
      side: 'buy',
      orderType: 'market',
      quantity: '2',
    });
    const bought = await db.order.findUniqueOrThrow({
      where: { id: boughtId },
    });
    assert.equal(bought.status, 'executed');
    assert.equal(
      bought.executedPrice?.toFixed(2),
      new Prisma.Decimal(pick.price).toFixed(2),
    );
    assert.equal(bought.currencyCode, pick.currency);
    const afterBuy = await walletBalance(s, pick.currency);
    assert.equal(
      before.minus(afterBuy).toFixed(8),
      bought.netAmount?.toFixed(8),
    );
    const position = await db.position.findUniqueOrThrow({
      where: {
        tradingAccountId_assetId: { tradingAccountId: s.accountId, assetId },
      },
    });
    assert.equal(position.quantity.toFixed(8), '2.00000000');
    assert.equal(
      await db.walletTransaction.count({
        where: { tradingAccountId: s.accountId, txType: 'order_buy' },
      }),
      1,
    );
    pass(`${label} market BUY fills at the stored ${pick.sourceName} price`);

    // Limit BUY below the price waits, then Path A fills it at a fresh
    // provider snapshot that reaches the limit.
    const limitId = await placeAs(s, {
      assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '1',
      limitPrice: pick.limit,
    });
    let limit = await db.order.findUniqueOrThrow({ where: { id: limitId } });
    assert.equal(limit.status, 'submitted');
    await matcher.matchDueLimitOrders({ now: await now() });
    limit = await db.order.findUniqueOrThrow({ where: { id: limitId } });
    assert.equal(limit.status, 'submitted');
    if (pick.currency === 'USD') await fxEvidence();
    await price(assetId, pick.fill, pick.currency, pick.sourceName);
    await matcher.matchDueLimitOrders({ now: await now() });
    limit = await db.order.findUniqueOrThrow({ where: { id: limitId } });
    assert.equal(limit.status, 'executed');
    assert.equal(
      limit.executedPrice?.toFixed(2),
      new Prisma.Decimal(pick.fill).toFixed(2),
    );
    pass(
      `${label} limit BUY waits, then the matcher fills it at the provider snapshot`,
    );

    // Older than the execute freshness (10 s): refused, never re-priced by
    // another source.
    await waitUntil((await now()).getTime() + 11_000);
    if (pick.currency === 'USD') {
      await fxEvidence();
      await price(assetId, '150.00', 'USD', 'kis_us_delayed_trade');
    }
    await rejects(
      placeAs(s, {
        assetId,
        side: 'buy',
        orderType: 'market',
        quantity: '1',
      }),
      'PRICE_STALE',
    );
    pass(`${label} a provider price older than 10 s refuses a market order`);
  } finally {
    tradingSessions.reset();
    const where = { tradingAccountId: s.accountId };
    await db.limitOrderCandleEvidence.deleteMany({ where: { assetId } });
    await db.order.deleteMany({ where });
    await db.position.deleteMany({ where });
    await db.dailyPortfolioSnapshot.deleteMany({ where });
    // Quotes reference the price snapshots: the fixture cleanup goes first.
    await cleanup(s);
    await db.assetPriceSnapshot.deleteMany({ where: { assetId } });
  }
}

async function main() {
  await db.$connect();
  const started = Date.now();
  const picks = representatives();
  const { byKey, createdIds } = await registerPicks(picks);
  try {
    for (const pick of picks) {
      const row = byKey.get(`${pick.entry.market}:${pick.entry.symbol}`);
      assert.ok(row);
      await scenario(pick, row.id);
    }
    console.log(
      `Stock expansion orders PostgreSQL PASS (${checks} checks, ${Math.round((Date.now() - started) / 1000)} s)`,
    );
  } finally {
    // Never mask a scenario failure with a cleanup failure.
    try {
      await db.asset.deleteMany({ where: { id: { in: createdIds } } });
      await db.fxRateSnapshot.deleteMany({
        where: { id: { in: fxEvidenceIds } },
      });
    } catch (error) {
      console.error('cleanup failed', error);
    }
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
