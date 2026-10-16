import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  fixture,
  now,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  code,
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
  LimitOnCloseEvidenceService,
  SessionCloseEvidenceError,
  SessionCloseSources,
  TiingoSessionCloseSource,
  sessionCloseFailure,
  type KoscomSessionCloseSource,
  type SessionCloseTarget,
} from '../src/orders/limit-on-close-evidence.service';
import { LimitOnCloseSettlementService } from '../src/orders/limit-on-close-settlement.service';
import { LimitOnCloseWorker } from '../src/orders/limit-on-close-worker.service';
import type { LimitOnCloseConfig } from '../src/orders/limit-on-close.config';
import {
  sessionDateText,
  usSessionWallTime,
} from '../src/orders/limit-on-close.policy';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';
import {
  TiingoConfigService,
  readTiingoConfig,
  toTiingoTicker,
} from '../src/providers/tiingo/tiingo.config';
import type { TiingoRestClient } from '../src/providers/tiingo/tiingo-rest.client';
import type { UsdKrwRefreshService } from '../src/providers/usd-krw-refresh.service';
import { TiingoError } from '../src/providers/tiingo/tiingo.errors';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.LIMIT_ON_CLOSE_US_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable US Limit-on-Close PG opt-in required');
// US stocks on the Tiingo provider (official mode). The Tiingo REST client
// below is a deterministic double: no network, no real token.
process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
process.env.LOC_US_ORDERS_ENABLED = 'true';
process.env.LOC_US_SELL_ORDERS_ENABLED = 'true';
// KRX BUY on for the same-cycle KRX regression; KRX SELL off: the US flags
// never open a KRX side (and vice versa).
process.env.LOC_ORDERS_ENABLED = 'true';
process.env.LOC_SELL_ORDERS_ENABLED = 'false';
delete process.env.LOC_US_CLOSE_EVIDENCE_EARLIEST_ET;
delete process.env.LOC_US_CLOSE_EVIDENCE_DEADLINE_ET;
delete process.env.LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS;

const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
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
const candleEvidence = new LimitOrderCandleEvidenceService(db);
const fill = new LimitOrderExecutionService(
  db,
  candleEvidence,
  orders,
  performance,
);
const matcher = new LimitOrderMatchingService(
  db,
  new LimitOrderCandidateRepository(db),
  candleEvidence,
  fill,
);
const evidence = new LimitOnCloseEvidenceService(db);

// ── Tiingo end-of-day double behind the REAL TiingoSessionCloseSource ────────
// Responses follow Tiingo's `/tiingo/daily/<ticker>/prices` JSON (numbers,
// ISO midnight dates, raw and adjusted values); the real source validates
// identity, date, bar count, volume and the receipt time against the session.

type EodRow = Record<string, unknown>;
const eodResponses: Array<EodRow[] | Error> = [];
const eodRequests: Array<{
  symbol: string;
  startDate: string;
  endDate: string;
}> = [];
/** Tiingo metadata per Asset symbol: exchangeCode (default NASDAQ) and ticker. */
const metaOverrides = new Map<
  string,
  { exchangeCode?: string; ticker?: string }
>();
const tiingoRest = {
  async getMeta(symbol: string) {
    const meta = metaOverrides.get(symbol) ?? {};
    return {
      json: {
        ticker: meta.ticker ?? toTiingoTicker(symbol),
        name: 'US LOC fixture',
        exchangeCode: meta.exchangeCode ?? 'NASDAQ',
        startDate: '2000-01-03',
        endDate: '2026-12-31',
      },
      receivedAt: await now(),
      bytes: 0,
    };
  },
  async getDailyPrices(
    symbol: string,
    query: { startDate: string; endDate: string },
  ) {
    eodRequests.push({ symbol, ...query });
    const next = eodResponses.shift();
    if (next instanceof Error) throw next;
    return { json: next ?? [], receivedAt: await now(), bytes: 0 };
  },
} as unknown as TiingoRestClient;
const officialTiingo = () =>
  new TiingoConfigService(
    readTiingoConfig({
      NODE_ENV: 'test',
      TIINGO_ENABLED: 'true',
      TIINGO_TRIAL_MODE: 'false',
      TIINGO_API_TOKEN: 'synthetic-loc-us-token',
    }),
  );
const tiingoSource = new TiingoSessionCloseSource(officialTiingo(), tiingoRest);

/** One Tiingo daily bar; `adjusted` gives split/dividend-adjusted values that
 * differ from the raw ones (the raw close is the only evidence). */
function eod(
  date: string,
  close: string,
  options: { adjusted?: string; volume?: number } = {},
): EodRow {
  const raw = Number(close);
  const adj = Number(options.adjusted ?? close);
  return {
    date: `${date}T00:00:00.000Z`,
    open: raw,
    high: raw,
    low: raw,
    close: raw,
    volume: options.volume ?? 1_000_000,
    adjOpen: adj,
    adjHigh: adj,
    adjLow: adj,
    adjClose: adj,
    adjVolume: options.volume ?? 1_000_000,
    divCash: 0,
    splitFactor: 1,
  };
}

// ── KOSCOM double (KRX regression in the same router and cycle) ──────────────

const krxCloses: string[] = [];
let krxCalls = 0;
const krxSource = {
  async observe(target: SessionCloseTarget) {
    krxCalls++;
    const next = krxCloses.shift();
    if (next === undefined)
      throw new SessionCloseEvidenceError('KOSCOM_CLOSE_EVIDENCE_MISSING');
    return {
      provider: 'koscom',
      sourceName: 'koscom_history',
      providerSymbol: target.symbol,
      providerTradingDate: sessionDateText(target.sessionDate).replaceAll(
        '-',
        '',
      ),
      closePrice: new Prisma.Decimal(next),
      currencyCode: 'KRW' as const,
      observedAt: await now(),
      raw: { fixture: 'dated_close', close: next },
    };
  },
} as unknown as KoscomSessionCloseSource;

// ── USD/KRW refresh double: the settlement's own pre-fill FX preparation ─────

let fxRefreshCalls = 0;
let fxRefreshFails = false;
const usdKrw = {
  async prepare(workflow: string) {
    fxRefreshCalls++;
    assert.equal(workflow, 'orders_execute');
    if (fxRefreshFails) throw new Error('synthetic USD/KRW provider outage');
    await fxEvidence();
  },
} as unknown as UsdKrwRefreshService;

const newSettlement = () =>
  new LimitOnCloseSettlementService(
    db,
    evidence,
    new SessionCloseSources(krxSource, tiingoSource),
    fill,
    cancel,
    undefined,
    usdKrw,
  );
const settlement = newSettlement();

/** Scaled confirmation (production: ≥ 300 s, config-tested). The runner can
 * replay the production interval with LOC_US_INTEGRATION_CONFIRM_MS=300000. */
const CONFIRM_MS = Number(process.env.LOC_US_INTEGRATION_CONFIRM_MS ?? '400');
assert.ok(Number.isSafeInteger(CONFIRM_MS) && CONFIRM_MS >= 100);
const KRX_CONFIRM_MS = 400;
const NEVER_BEFORE_DEADLINE = 23 * 60; // = the default 23:00 ET deadline
let config = locConfig(NEVER_BEFORE_DEADLINE);
function locConfig(usEarliestMinute: number): LimitOnCloseConfig {
  return {
    enabled: true,
    sellEnabled: false,
    evidenceMinDelayMs: 0,
    evidenceConfirmMs: KRX_CONFIRM_MS,
    evidenceDeadlineMs: 10_800_000,
    us: {
      enabled: true,
      sellEnabled: true,
      evidenceEarliestMinute: usEarliestMinute,
      evidenceConfirmMs: CONFIRM_MS,
      evidenceDeadlineMinute: 23 * 60,
    },
  };
}
const cycle = () => settlement.runCycle({ config });

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS US LOC ${label}`);
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
/** DB-clock wait (same host clock as every service), budgeted from the
 * requested wait (minute boundaries, a production confirmation interval). */
async function waitUntil(at: number) {
  const started = Date.now();
  const budget = Math.max(0, at - (await now()).getTime()) + 60_000;
  while ((await now()).getTime() < at) {
    assert.ok(Date.now() - started < budget, 'DB clock did not advance');
    await delay(Math.min(1000, Math.max(25, at - Date.now())));
  }
}
async function waitDb(ms: number) {
  await waitUntil((await now()).getTime() + ms);
}

// ── New York wall clock ──────────────────────────────────────────────────────

function newYork(at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
const wallTime = (localDate: string, hhmm: string) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  const at = usSessionWallTime(localDate, hour * 60 + minute);
  assert.ok(at);
  return at;
};

type Timing = {
  clock: Date;
  closeAt: Date;
  localDate: string;
  /** Configured New York evidence time (minutes of the session date). */
  earliestMinute: number;
  earliestAt: Date | null;
};

/**
 * Full evidence window: the session date and New York minute whose wall time
 * is the next whole minute M at least 20 s ahead (setup and both orders fit
 * before the close even on a slow CI runner). The session closes 4 s before
 * M; the settlement may not ask Tiingo before M. The registration deadline is
 * 23:59 New York of that date (set before registering).
 */
async function fullWindow(): Promise<Timing> {
  for (;;) {
    const clock = await now();
    const at = Math.ceil((clock.getTime() + 20_000) / 60_000) * 60_000;
    const { localDate, minute } = newYork(new Date(at));
    // Room before 23:59 for two confirmation intervals and the margins.
    if (minute <= 23 * 60 + 57 - Math.ceil((2 * CONFIRM_MS) / 60_000)) {
      assert.equal(
        usSessionWallTime(localDate, minute)?.getTime(),
        at,
        'ambiguous New York wall time (DST fall-back hour): rerun after it',
      );
      process.env.LOC_US_CLOSE_EVIDENCE_DEADLINE_ET = '23:59';
      return {
        clock,
        closeAt: new Date(at - 4000),
        localDate,
        earliestMinute: minute,
        earliestAt: new Date(at),
      };
    }
    await waitUntil(at + 1000); // past New York midnight
  }
}
/**
 * Pre-finalized evidence: a session date whose default 23:00 New York
 * deadline is at least an hour ahead; the settlement never asks Tiingo
 * itself (evidence time = deadline).
 */
async function shortWindow(closeInMs: number): Promise<Timing> {
  const clock = await now();
  return {
    clock,
    closeAt: new Date(clock.getTime() + closeInMs),
    localDate: newYork(new Date(clock.getTime() + 2 * 3_600_000)).localDate,
    earliestMinute: NEVER_BEFORE_DEADLINE,
    earliestAt: null,
  };
}

// ── Scenario fixture ─────────────────────────────────────────────────────────

type UsLoc = Scenario & {
  assetId: string;
  symbol: string;
  krxAssetId: string;
  closeAt: Date;
  localDate: string;
  sessionDate: Date;
  earliestAt: Date | null;
};

async function usScenario(
  mode: 'general' | 'season' | 'beginner',
  work: (s: UsLoc) => Promise<void>,
  options: {
    window?: 'full' | 'short';
    closeInMs?: number;
    holding?: string;
    freshLearning?: boolean;
  } = {},
) {
  const base = await fixture(mode, '10000', options.freshLearning ?? false);
  eodResponses.length = 0;
  eodRequests.length = 0;
  krxCloses.length = 0;
  metaOverrides.clear();
  fxRefreshFails = false;
  try {
    // Quote/create of a USD order needs fresh USD/KRW (orders_quote).
    await fxEvidence();
    const timing =
      options.window === 'full'
        ? await fullWindow()
        : await shortWindow(options.closeInMs ?? 2500);
    tradingSessions.set(timing.clock, timing.closeAt, ['KRX', 'US'], {
      localDate: timing.localDate,
    });
    config = locConfig(timing.earliestMinute);
    const asset = await db.asset.update({
      where: { id: base.instruments[0].asset.id },
      data: {
        market: 'NAS',
        assetType: 'us_stock',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    const krx = await db.asset.update({
      where: { id: base.instruments[1].asset.id },
      data: {
        market: 'KRX',
        assetType: 'domestic_stock',
        currencyCode: 'KRW',
        priceCurrency: 'KRW',
        settlementCurrency: 'KRW',
      },
    });
    for (const [currencyCode, balanceAmount] of [
      ['USD', '10000'],
      ['KRW', '100000'],
    ] as const)
      await db.cashWallet.updateMany({
        where: {
          tradingAccountId: base.accountId,
          walletScope: 'securities',
          currencyCode,
        },
        data: { balanceAmount },
      });
    if (options.holding)
      await db.position.create({
        data: {
          tradingAccountId: base.accountId,
          assetId: asset.id,
          quantity: options.holding,
          averageCost: '90',
          currencyCode: 'USD',
        },
      });
    const s: UsLoc = {
      ...base,
      assetId: asset.id,
      symbol: asset.symbol,
      krxAssetId: krx.id,
      closeAt: timing.closeAt,
      localDate: timing.localDate,
      sessionDate: new Date(`${timing.localDate}T00:00:00.000Z`),
      earliestAt: timing.earliestAt,
    };
    // In-session prices, as the Tiingo collector / KOSCOM provide them: the
    // post-fill equity snapshot values the new positions with them.
    await usPrice(s, '100');
    await krxPrice(s, '100');
    await work(s);
  } finally {
    tradingSessions.reset();
    delete process.env.LOC_US_CLOSE_EVIDENCE_DEADLINE_ET;
    process.env.LOC_US_ORDERS_ENABLED = 'true';
    process.env.LOC_US_SELL_ORDERS_ENABLED = 'true';
    process.env.LOC_ORDERS_ENABLED = 'true';
    process.env.LOC_SELL_ORDERS_ENABLED = 'false';
    config = locConfig(NEVER_BEFORE_DEADLINE);
    await release(base);
  }
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  const assetIds = s.instruments.map((row) => row.asset.id);
  await db.limitOnCloseOrder.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.sessionClosePriceEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.marketCandle.deleteMany({ where: { assetId: { in: assetIds } } });
  await cleanup(s);
}
/** A second user trading the first scenario's US asset. */
async function otherAccount() {
  const other = await fixture('general');
  await db.cashWallet.updateMany({
    where: {
      tradingAccountId: other.accountId,
      walletScope: 'securities',
      currencyCode: 'USD',
    },
    data: { balanceAmount: '10000' },
  });
  return other;
}

async function usPrice(
  s: UsLoc,
  value: string,
  options: {
    at?: Date;
    sourceName?: string;
    sourceType?: 'provider_api' | 'admin_manual';
  } = {},
) {
  const clock = options.at ?? (await now());
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.assetId,
      price: value,
      currencyCode: 'USD',
      sourceType: options.sourceType ?? 'provider_api',
      sourceName: options.sourceName ?? 'tiingo_us_reference_price',
      effectiveAt: clock,
      capturedAt: clock,
    },
  });
}
async function krxPrice(s: UsLoc, value: string) {
  const clock = await now();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.krxAssetId,
      price: value,
      currencyCode: 'KRW',
      sourceType: 'provider_api',
      sourceName: 'koscom_krx_realtime_price',
      effectiveAt: clock,
      capturedAt: clock,
    },
  });
}

function locBody(s: UsLoc, patch: OrderRequestBody = {}): OrderRequestBody {
  return {
    assetId: s.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: '10',
    limitPrice: '100',
    limitOnClose: true,
    ...patch,
  };
}
type LocQuote = {
  quoteId: string;
  quantity?: string;
  quantityAdjustment?: {
    requestedQuantity: string;
    acceptedQuantity: string;
    availableQuantity: string;
  } | null;
  limitOnClose?: { market: string; sessionDate: string };
};
async function placeAs(
  owner: { userId: string; accountId: string },
  body: OrderRequestBody,
  key: string = randomUUID(),
) {
  const quoted = await orders.quoteOrderForTradingAccount(
    owner.userId,
    owner.accountId,
    body,
  );
  const quote = quoted.data as typeof quoted.data & LocQuote;
  const created = await orders.createOrderForTradingAccount(
    owner.userId,
    owner.accountId,
    {
      ...body,
      // A LOC SELL may accept less than asked (the unreserved holding).
      ...(body.side === 'sell' && quote.quantity
        ? { quantity: quote.quantity }
        : {}),
      ...(quote.quantityAdjustment
        ? { requestedQuantity: quote.quantityAdjustment.requestedQuantity }
        : {}),
      quoteId: quote.quoteId,
      idempotencyKey: key,
    },
  );
  return { quote, created, orderId: created.data.order.orderId };
}
const place = (s: UsLoc, patch: OrderRequestBody = {}) =>
  placeAs(s, locBody(s, patch));

async function wallet(s: Scenario, currencyCode: 'USD' | 'KRW' = 'USD') {
  const row = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      walletScope: 'securities',
      currencyCode,
    },
  });
  return {
    balance: row.balanceAmount.toFixed(8),
    reserved: row.reservedAmount.toFixed(8),
  };
}
async function holding(s: { accountId: string }, assetId: string) {
  const row = await db.position.findUnique({
    where: {
      tradingAccountId_assetId: { tradingAccountId: s.accountId, assetId },
    },
  });
  return row
    ? {
        quantity: row.quantity.toFixed(8),
        reserved: row.reservedQuantity.toFixed(8),
      }
    : null;
}
const order = (id: string) =>
  db.order.findUniqueOrThrow({
    where: { id },
    include: { limitOnClose: { include: { closeEvidence: true } } },
  });
const ledger = (
  s: { accountId: string },
  txType: 'order_buy' | 'order_sell',
  currencyCode: 'USD' | 'KRW' = 'USD',
) =>
  db.walletTransaction.count({
    where: { tradingAccountId: s.accountId, txType, currencyCode },
  });
const usTarget = (s: UsLoc): SessionCloseTarget => ({
  assetId: s.assetId,
  symbol: s.symbol,
  assetMarket: 'NAS',
  market: 'US',
  sessionDate: s.sessionDate,
  sessionCloseAt: s.closeAt,
});
const usEvidence = (s: UsLoc) =>
  db.sessionClosePriceEvidence.findUnique({
    where: {
      assetId_market_sessionDate_provider: {
        assetId: s.assetId,
        market: 'US',
        sessionDate: s.sessionDate,
        provider: 'tiingo',
      },
    },
  });
/** Final Tiingo close through the real source, outside the settlement
 * (for deterministic races and boundary decisions). */
async function finalUsClose(s: UsLoc, close: string, adjusted?: string) {
  const target = usTarget(s);
  eodResponses.push(
    [eod(s.localDate, close, { adjusted })],
    [eod(s.localDate, close, { adjusted })],
  );
  await evidence.recordObservation(
    target,
    await tiingoSource.observe(target),
    CONFIRM_MS,
  );
  await waitDb(CONFIRM_MS + 50);
  const final = await evidence.recordObservation(
    target,
    await tiingoSource.observe(target),
    CONFIRM_MS,
  );
  assert.equal(final?.status, 'final');
  return final;
}
async function afterClose(s: UsLoc) {
  await waitUntil(s.closeAt.getTime() + 50);
}
const outcomeOf = (outcome: Awaited<ReturnType<typeof fill.fillLimitOrder>>) =>
  outcome.state === 'skipped' ? outcome.reason : outcome.state;
const jsonText = (value: unknown) => JSON.stringify(value ?? null);

// ── A. Full New York evidence window ─────────────────────────────────────────

/**
 * US BUY below the limit, next to a KRX LOC in the same account: the KRX
 * close is observed right after the close (KOSCOM), the US close not before
 * the New York evidence time; the US fill is the RAW Tiingo close (never
 * adjClose, the limit or a realtime print), with USD settlement and FX.
 */
async function fullWindowBuyWithKrx() {
  await usScenario(
    'general',
    async (s) => {
      const before = await wallet(s);
      const { quote, created, orderId } = await place(s);
      assert.equal(quote.limitOnClose?.market, 'US');
      assert.equal(quote.limitOnClose?.sessionDate, s.localDate);
      assert.equal(created.data.order.status, 'submitted');
      assert.equal(created.data.order.limitOnClose?.status, 'pending');
      const placed = await order(orderId);
      assert.equal(placed.currencyCode, 'USD');
      assert.equal(placed.limitOnClose?.market, 'US');
      assert.equal(
        placed.limitOnClose?.sessionCloseAt.getTime(),
        s.closeAt.getTime(),
      );
      // 23:59 New York of the session date (this window's configured deadline).
      assert.equal(
        placed.limitOnClose?.evidenceDeadlineAt.toISOString(),
        wallTime(s.localDate, '23:59').toISOString(),
      );
      const reserved = placed.reservedAmount!.toFixed(8);
      assert.equal((await wallet(s)).reserved, reserved);
      assert.equal((await wallet(s)).balance, before.balance);
      const krx = await place(s, { assetId: s.krxAssetId });
      assert.equal(krx.quote.limitOnClose?.market, 'KRX');
      const krwBefore = await wallet(s, 'KRW');
      // A realtime print below the limit never fills a US LOC (path A).
      await usPrice(s, '90');
      await matcher.matchDueLimitOrders({ now: await now() });
      assert.equal((await order(orderId)).status, 'submitted');
      await waitUntil(s.closeAt.getTime() + 300);
      assert.ok(
        (await now()) < s.earliestAt!,
        'runner too slow: the New York evidence time already passed',
      );
      // Closed, before the New York evidence time: KRX observes, US waits.
      krxCloses.push('95');
      await fxEvidence(); // the KRX fill's equity snapshot values USD wallets
      let summary = await cycle();
      assert.equal(eodRequests.length, 0, 'no Tiingo request before M');
      assert.equal(krxCalls > 0, true);
      assert.equal(summary.observations, 1, jsonText(summary));
      assert.equal(summary.waiting, 2, jsonText(summary));
      assert.equal((await usEvidence(s)) === null, true);
      // New York evidence time reached.
      await waitUntil(s.earliestAt!.getTime() + 2500);
      eodResponses.push([eod(s.localDate, '95', { adjusted: '94.5' })]);
      krxCloses.push('95');
      await fxEvidence();
      summary = await cycle();
      assert.equal(eodRequests.length, 1, jsonText(summary));
      assert.deepEqual(eodRequests[0], {
        symbol: s.symbol,
        startDate: s.localDate,
        endDate: s.localDate,
      });
      assert.equal(summary.filled, 1, jsonText(summary)); // the KRX order
      const krxFilled = await order(krx.orderId);
      assert.equal(krxFilled.status, 'executed');
      assert.equal(krxFilled.executedPrice?.toFixed(0), '95');
      assert.equal(krxFilled.limitOnClose?.closeEvidence?.provider, 'koscom');
      assert.equal((await wallet(s, 'KRW')).reserved, '0.00000000');
      assert.ok(
        new Prisma.Decimal(krwBefore.balance).gt(
          (await wallet(s, 'KRW')).balance,
        ),
      );
      let row = await usEvidence(s);
      assert.equal(row?.status, 'observing');
      assert.equal(row?.closePrice.toFixed(2), '95.00'); // raw, not adjClose 94.5
      assert.ok(row.firstObservedAt >= s.earliestAt!);
      assert.equal((await order(orderId)).status, 'submitted');
      // Inside the confirmation interval: no second request.
      await cycle();
      assert.equal(eodRequests.length, 1);
      await waitDb(CONFIRM_MS + 50);
      eodResponses.push([eod(s.localDate, '95', { adjusted: '94.5' })]);
      const fxCallsBefore = fxRefreshCalls;
      summary = await cycle();
      assert.equal(summary.filled, 1, jsonText(summary));
      assert.ok(fxRefreshCalls > fxCallsBefore, 'US fill prepares USD/KRW');
      const filled = await order(orderId);
      assert.equal(filled.status, 'executed');
      assert.equal(filled.executedPrice?.toFixed(8), '95.00000000');
      assert.ok(filled.fxRateSnapshotId, 'USD fill pins its FX evidence');
      const gross = new Prisma.Decimal('95').mul(10);
      assert.equal(filled.grossAmount?.toFixed(8), gross.toFixed(8));
      assert.equal(
        filled.feeAmount?.toFixed(8),
        gross
          .mul(placed.reservationFeeRate!)
          .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(8),
      );
      const after = await wallet(s);
      assert.equal(after.reserved, '0.00000000');
      assert.equal(
        new Prisma.Decimal(before.balance).sub(after.balance).toFixed(8),
        filled.netAmount!.toFixed(8),
      );
      // Price improvement: the reservation at the limit is released.
      assert.ok(filled.netAmount!.lt(placed.reservedAmount!));
      assert.equal(await ledger(s, 'order_buy'), 1);
      assert.equal(await ledger(s, 'order_buy', 'KRW'), 1);
      assert.equal((await holding(s, s.assetId))?.quantity, '10.00000000');
      const loc = filled.limitOnClose!;
      assert.equal(loc.status, 'filled');
      assert.equal(loc.decisionReason, 'loc_close_reached');
      assert.equal(loc.closePrice?.toFixed(8), '95.00000000');
      row = loc.closeEvidence;
      assert.equal(row?.status, 'final');
      assert.equal(row?.provider, 'tiingo');
      assert.equal(row?.sourceName, 'tiingo_eod');
      assert.equal(row?.currencyCode, 'USD');
      assert.equal(row?.providerTradingDate, s.localDate.replaceAll('-', ''));
      assert.equal(row?.observationCount, 2);
      assert.ok(row.finalizedAt! >= s.earliestAt!);
      const raw = jsonText(row?.confirmRawJson);
      assert.equal(raw.includes('"priceBasis":"raw_close"'), true);
      assert.equal(raw.includes('synthetic-loc-us-token'), false);
      const detail = await orders.getOrderForTradingAccount(
        s.userId,
        s.accountId,
        orderId,
      );
      assert.equal(detail.data.order.limitOnClose?.status, 'filled');
      assert.equal(
        detail.data.order.limitOnClose?.closeEvidence?.status,
        'final',
      );
      assert.ok(
        (await db.equitySnapshot.count({
          where: { tradingAccountId: s.accountId },
        })) > 0,
      );
      // Settled orders are never revisited; final evidence never changes.
      assert.equal((await cycle()).candidates, 0);
      assert.equal(eodRequests.length, 2);
      pass(
        'BUY close 95 < limit 100: no Tiingo request before the New York evidence time, raw close (not adjClose) after two identical reads, USD settle + FX; KRX LOC in the same cycle on KOSCOM',
      );
    },
    { window: 'full' },
  );
}

/**
 * SELL above the limit and another user's BUY on the same symbol and date:
 * one shared Tiingo read per cycle; a wrong-date bar is never evidence; a
 * changed value restarts the confirmation; the SELL fills at the close, the
 * BUY whose limit the close exceeds is released.
 */
async function fullWindowSellSharedRestart() {
  await usScenario(
    'season',
    async (s) => {
      const other = await otherAccount();
      try {
        const sellBefore = await wallet(s);
        const sell = await place(s, {
          side: 'sell',
          quantity: '4',
          limitPrice: '100',
        });
        assert.equal(sell.created.data.order.side, 'sell');
        assert.equal(sell.quote.quantityAdjustment ?? null, null);
        assert.deepEqual(await holding(s, s.assetId), {
          quantity: '10.00000000',
          reserved: '4.00000000',
        });
        const buyBefore = await wallet(other);
        const buy = await placeAs(
          other,
          locBody(s, { quantity: '5', limitPrice: '101.5' }),
        );
        await waitUntil(s.closeAt.getTime() + 300);
        assert.ok((await now()) < s.earliestAt!, 'runner too slow');
        let summary = await cycle();
        assert.equal(eodRequests.length, 0);
        assert.equal(summary.waiting, 2, jsonText(summary));
        await waitUntil(s.earliestAt!.getTime() + 2500);
        // 0) End-of-day data not published yet, then a provider outage: each
        // is recorded and waits (one shared request per interval), nothing
        // is invented.
        eodResponses.push([]);
        summary = await cycle();
        assert.equal(
          summary.observationFailures.TIINGO_CLOSE_EVIDENCE_MISSING,
          1,
          jsonText(summary),
        );
        assert.equal(summary.waiting, 2, jsonText(summary));
        await waitDb(CONFIRM_MS + 50);
        eodResponses.push(new TiingoError('TIINGO_SERVER_ERROR'));
        summary = await cycle();
        assert.equal(
          summary.observationFailures.TIINGO_SERVER_ERROR,
          1,
          jsonText(summary),
        );
        assert.equal((await usEvidence(s)) === null, true);
        await waitDb(CONFIRM_MS + 50);
        // 1) The previous session's bar: never evidence.
        const previous = new Date(s.sessionDate.getTime() - 86_400_000)
          .toISOString()
          .slice(0, 10);
        eodResponses.push([eod(previous, '150')]);
        summary = await cycle();
        assert.equal(
          summary.observationFailures.TIINGO_CLOSE_DATE_MISMATCH,
          1,
          jsonText(summary),
        );
        assert.equal((await usEvidence(s)) === null, true);
        for (const id of [sell.orderId, buy.orderId])
          assert.equal(
            (await order(id)).limitOnClose?.lastCheckCode,
            'TIINGO_CLOSE_DATE_MISMATCH',
          );
        // 2) Raw 101 (adjusted 100.4), 3) a changed 102: restart.
        await waitDb(CONFIRM_MS + 50);
        eodResponses.push([eod(s.localDate, '101', { adjusted: '100.4' })]);
        await cycle();
        await waitDb(CONFIRM_MS + 50);
        eodResponses.push([eod(s.localDate, '102', { adjusted: '101.4' })]);
        await cycle();
        let row = await usEvidence(s);
        assert.equal(row?.status, 'observing');
        assert.equal(row?.closePrice.toFixed(2), '102.00');
        assert.equal(row?.mismatchCount, 1);
        assert.equal((await order(sell.orderId)).status, 'submitted');
        assert.equal((await order(buy.orderId)).status, 'submitted');
        await cycle(); // inside the interval: no request
        assert.equal(eodRequests.length, 5);
        // 4) The same 102 again after the interval: final, both decided.
        await waitDb(CONFIRM_MS + 50);
        eodResponses.push([eod(s.localDate, '102', { adjusted: '101.4' })]);
        summary = await cycle();
        assert.equal(eodRequests.length, 6, 'one shared read per cycle');
        for (const request of eodRequests)
          assert.equal(request.symbol, s.symbol);
        assert.equal(summary.filled, 1, jsonText(summary));
        assert.equal(summary.unfilled, 1, jsonText(summary));
        row = await usEvidence(s);
        assert.equal(row?.status, 'final');
        // 101 (first), 102 (restart), 102 (confirmation); the wrong-date
        // bar never became an observation.
        assert.equal(row?.observationCount, 3);
        const sold = await order(sell.orderId);
        assert.equal(sold.status, 'executed');
        assert.equal(sold.executedPrice?.toFixed(8), '102.00000000');
        assert.equal(sold.sessionCloseEvidenceId, row?.id);
        assert.deepEqual(await holding(s, s.assetId), {
          quantity: '6.00000000',
          reserved: '0.00000000',
        });
        const proceeds = new Prisma.Decimal((await wallet(s)).balance).sub(
          sellBefore.balance,
        );
        assert.equal(proceeds.toFixed(8), sold.netAmount!.toFixed(8));
        assert.ok(sold.feeAmount!.gt(0));
        assert.equal(await ledger(s, 'order_sell'), 1);
        const missed = await order(buy.orderId);
        assert.equal(missed.status, 'canceled');
        assert.equal(missed.cancelReason, 'loc_close_not_reached');
        assert.equal(missed.limitOnClose?.status, 'unfilled');
        assert.equal(missed.limitOnClose?.closePrice?.toFixed(2), '102.00');
        assert.deepEqual(await wallet(other), buyBefore);
        assert.equal(await ledger(other, 'order_buy'), 0);
        pass(
          'SELL 102 ≥ 100 fills, another user’s BUY 101.5 released: one shared Tiingo read per cycle; not-yet-published, outage and wrong-date reads wait; changed value restarts confirmation',
        );
      } finally {
        await release(other);
      }
    },
    { window: 'full', holding: '10' },
  );
}

// ── B. Decisions at the boundary (pre-finalized evidence) ────────────────────

async function boundaryDecisions() {
  for (const [side, close, expected] of [
    ['buy', '100', 'fill'],
    ['buy', '100.01', 'unfilled'],
    ['sell', '100', 'fill'],
    ['sell', '99.99', 'unfilled'],
  ] as const)
    await usScenario(
      'general',
      async (s) => {
        const before = await wallet(s);
        const { orderId } = await place(s, {
          side,
          quantity: side === 'sell' ? '3' : '10',
        });
        const placed = await order(orderId);
        await afterClose(s);
        await finalUsClose(s, close);
        const summary = await cycle();
        const row = await order(orderId);
        if (expected === 'fill') {
          assert.equal(summary.filled, 1, jsonText(summary));
          assert.equal(row.status, 'executed');
          assert.equal(
            row.executedPrice?.toFixed(8),
            new Prisma.Decimal(close).toFixed(8),
          );
          assert.equal(row.limitOnClose?.status, 'filled');
          if (side === 'buy') {
            // Equal to the limit: exactly the reserved amount is spent.
            assert.equal(
              row.netAmount!.toFixed(8),
              placed.reservedAmount!.toFixed(8),
            );
            assert.equal(await ledger(s, 'order_buy'), 1);
          } else {
            assert.deepEqual(await holding(s, s.assetId), {
              quantity: '7.00000000',
              reserved: '0.00000000',
            });
            assert.equal(await ledger(s, 'order_sell'), 1);
          }
        } else {
          assert.equal(summary.unfilled, 1, jsonText(summary));
          assert.equal(row.status, 'canceled');
          assert.equal(row.cancelReason, 'loc_close_not_reached');
          assert.equal(row.limitOnClose?.status, 'unfilled');
          assert.equal(
            row.limitOnClose?.closePrice?.toFixed(8),
            new Prisma.Decimal(close).toFixed(8),
          );
          assert.deepEqual(await wallet(s), before);
          if (side === 'sell')
            assert.deepEqual(await holding(s, s.assetId), {
              quantity: '10.00000000',
              reserved: '0.00000000',
            });
          assert.equal(
            await ledger(s, side === 'buy' ? 'order_buy' : 'order_sell'),
            0,
          );
        }
        assert.equal((await cycle()).candidates, 0);
        pass(
          `${side.toUpperCase()} limit 100, final close ${close} → ${expected}`,
        );
      },
      { holding: side === 'sell' ? '10' : undefined },
    );
}

/** An ordinary limit SELL holds 6 of 10: a LOC SELL of 10 accepts the 4 left. */
async function sellQuantityAdjustment() {
  await usScenario(
    'season',
    async (s) => {
      const ordinary = await placeAs(s, {
        assetId: s.assetId,
        side: 'sell',
        orderType: 'limit',
        quantity: '6',
        limitPrice: '130',
      });
      const loc = await place(s, {
        side: 'sell',
        quantity: '10',
        limitPrice: '100',
      });
      assert.deepEqual(loc.quote.quantityAdjustment, {
        reason: 'available_quantity',
        requestedQuantity: '10.000000',
        acceptedQuantity: '4.000000',
        availableQuantity: '4.000000',
      });
      assert.equal(loc.created.data.order.quantity, '4.000000');
      assert.equal(
        loc.created.data.order.limitOnClose?.requestedQuantity,
        '10.00000000',
      );
      assert.deepEqual(await holding(s, s.assetId), {
        quantity: '10.00000000',
        reserved: '10.00000000',
      });
      await rejects(
        place(s, { side: 'sell', quantity: '1' }),
        'INSUFFICIENT_QUANTITY',
      );
      await afterClose(s);
      await finalUsClose(s, '120');
      const summary = await cycle();
      assert.equal(summary.filled, 1, jsonText(summary));
      const sold = await order(loc.orderId);
      assert.equal(sold.executedPrice?.toFixed(2), '120.00');
      assert.equal(sold.quantity.toFixed(6), '4.000000');
      assert.equal((await order(ordinary.orderId)).status, 'submitted');
      assert.deepEqual(await holding(s, s.assetId), {
        quantity: '6.00000000',
        reserved: '6.00000000',
      });
      pass(
        'SELL quantity: 6 reserved elsewhere → LOC SELL 10 accepts 4, fills 4 at the close; nothing reserved twice',
      );
    },
    { holding: '10', closeInMs: 4000 },
  );
}

// ── C. Never the continuous paths, never another provider ────────────────────

async function continuousPathsNeverFill() {
  await usScenario(
    'general',
    async (s) => {
      const { orderId } = await place(s);
      const ordinaryBody = { ...locBody(s), limitOnClose: undefined };
      const ordinary = await placeAs(s, ordinaryBody);
      // Path A: a Tiingo print below both limits; path B: a closed 5m candle
      // whose low touched them.
      const print = await usPrice(s, '95');
      const clock = await now();
      const openTime = new Date(
        Math.floor(clock.getTime() / 300_000) * 300_000 - 300_000,
      );
      const candle = await db.marketCandle.create({
        data: {
          assetId: s.assetId,
          interval: '5m',
          openTime,
          closeTime: new Date(openTime.getTime() + 300_000),
          open: '100',
          high: '100',
          low: '90',
          close: '95',
          volume: '100',
          isClosed: true,
          sourceProvider: 'tiingo_iex',
          sourceUpdatedAt: new Date(openTime.getTime() + 300_000),
        },
      });
      await fxEvidence();
      const summary = await matcher.matchDueLimitOrders({ now: await now() });
      assert.equal(summary.filledPathA, 1, jsonText(summary));
      assert.equal((await order(ordinary.orderId)).status, 'executed');
      assert.equal((await order(orderId)).status, 'submitted');
      for (const plan of [
        {
          path: 'snapshot' as const,
          assetPriceSnapshotId: print.id,
          executedPrice: new Prisma.Decimal('95'),
        },
        {
          path: 'candle' as const,
          executedPrice: new Prisma.Decimal('100'),
          candle: {
            marketCandleId: candle.id,
            openTime: candle.openTime,
            closeTime: candle.closeTime,
            low: candle.low,
            sourceProvider: candle.sourceProvider,
            sourceUpdatedAt: candle.sourceUpdatedAt,
            finalizedAt: candle.closeTime,
          },
        },
      ])
        assert.equal(
          outcomeOf(await fill.fillLimitOrder({ orderId, plan })),
          'limit_on_close_order',
        );
      const placed = await order(orderId);
      assert.equal(placed.status, 'submitted');
      assert.equal(placed.limitOnClose?.status, 'pending');
      assert.equal(
        (await wallet(s)).reserved,
        placed.reservedAmount!.toFixed(8),
      );
      pass(
        'paths A/B (Tiingo print, 5m touch) never fill a US LOC; an ordinary US limit beside it fills on path A',
      );
    },
    { closeInMs: 6000 },
  );
}

async function providerIsolation() {
  await usScenario(
    'general',
    async (s) => {
      const { orderId } = await place(s);
      const krx = await place(s, { assetId: s.krxAssetId });
      await afterClose(s);
      // A KOSCOM-shaped observation can never be US evidence …
      let identity = 'RESOLVED';
      try {
        await evidence.recordObservation(
          usTarget(s),
          {
            provider: 'koscom',
            sourceName: 'koscom_history',
            providerSymbol: s.symbol,
            providerTradingDate: s.localDate.replaceAll('-', ''),
            closePrice: new Prisma.Decimal('90'),
            currencyCode: 'USD',
            observedAt: await now(),
            raw: { fixture: 'cross-provider' },
          },
          CONFIRM_MS,
        );
      } catch (error) {
        identity = sessionCloseFailure(error);
      }
      assert.equal(identity, 'SESSION_CLOSE_IDENTITY_MISMATCH');
      // … and a final row of another provider (written directly) is neither
      // found by the settlement nor accepted by the fill.
      const finalRow = (provider: 'koscom' | 'tiingo', market: 'US' | 'KRX') =>
        db.sessionClosePriceEvidence.create({
          data: {
            assetId: market === 'US' ? s.assetId : s.krxAssetId,
            market,
            sessionDate: s.sessionDate,
            sessionCloseAt: s.closeAt,
            provider,
            sourceName: provider === 'koscom' ? 'koscom_history' : 'tiingo_eod',
            providerSymbol: s.symbol,
            providerTradingDate: s.localDate.replaceAll('-', ''),
            closePrice: '90',
            currencyCode: market === 'US' ? 'USD' : 'KRW',
            status: 'final',
            firstObservedAt: s.closeAt,
            lastObservedAt: s.closeAt,
            finalizedAt: s.closeAt,
            firstRawJson: { fixture: 'foreign provider' },
            confirmRawJson: { fixture: 'foreign provider' },
            policyVersion: 1,
          },
        });
      const foreignUs = await finalRow('koscom', 'US');
      const foreignKrx = await finalRow('tiingo', 'KRX');
      await fxEvidence();
      const summary = await cycle();
      assert.equal(summary.filled, 0, jsonText(summary));
      for (const [id, row] of [
        [orderId, foreignUs],
        [krx.orderId, foreignKrx],
      ] as const)
        assert.equal(
          outcomeOf(
            await fill.fillLimitOrder({
              orderId: id,
              plan: {
                path: 'session_close',
                executedPrice: row.closePrice,
                closeEvidenceId: row.id,
              },
            }),
          ),
          'session_close_evidence_invalid',
        );
      assert.equal((await order(orderId)).status, 'submitted');
      assert.equal((await order(krx.orderId)).status, 'submitted');
      // The bound session's own Tiingo close settles it.
      await finalUsClose(s, '96');
      assert.equal((await cycle()).filled, 1);
      const filled = await order(orderId);
      assert.equal(filled.executedPrice?.toFixed(2), '96.00');
      assert.equal(filled.limitOnClose?.closeEvidence?.provider, 'tiingo');
      pass(
        'provider isolation: KOSCOM evidence never settles US (nor Tiingo KRX), identity check, own Tiingo close settles',
      );
    },
    { closeInMs: 4000 },
  );
}

/** The real Tiingo source rejects every observation that cannot be evidence. */
async function tiingoObservationRules() {
  await usScenario(
    'general',
    async (s) => {
      await afterClose(s);
      const target = usTarget(s);
      let requestedDaily = false;
      const attempt = async (
        source: TiingoSessionCloseSource,
        response: EodRow[] | Error,
        at: SessionCloseTarget = target,
      ) => {
        eodResponses.push(response);
        const requestsBefore = eodRequests.length;
        try {
          await source.observe(at);
          return 'OBSERVED';
        } catch (error) {
          return sessionCloseFailure(error);
        } finally {
          requestedDaily = eodRequests.length > requestsBefore;
          eodResponses.length = 0;
        }
      };
      const fresh = () =>
        new TiingoSessionCloseSource(officialTiingo(), tiingoRest);
      const previous = new Date(s.sessionDate.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const next = new Date(s.sessionDate.getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const [response, expected] of [
        [[eod(previous, '95')], 'TIINGO_CLOSE_DATE_MISMATCH'],
        [[eod(next, '95')], 'TIINGO_CLOSE_DATE_MISMATCH'],
        [[], 'TIINGO_CLOSE_EVIDENCE_MISSING'],
        [
          [eod(previous, '95'), eod(s.localDate, '96')],
          'TIINGO_CLOSE_EVIDENCE_MISSING',
        ],
        [[eod(s.localDate, '95', { volume: 0 })], 'TIINGO_CLOSE_NO_TRADES'],
        [[{ ...eod(s.localDate, '95'), high: 1 }], 'TIINGO_CLOSE_INVALID_BAR'],
      ] as Array<[EodRow[], string]>) {
        assert.equal(await attempt(fresh(), response), expected);
        assert.equal(requestedDaily, true, expected);
      }
      // Received before the session's (current calendar) close.
      assert.equal(
        await attempt(fresh(), [eod(s.localDate, '95')], {
          ...target,
          sessionCloseAt: new Date((await now()).getTime() + 60_000),
        }),
        'TIINGO_CLOSE_BEFORE_SESSION_END',
      );
      // Tiingo's identity must be the Asset's: exchange and ticker.
      // An identity failure never reaches the daily-price request.
      metaOverrides.set(s.symbol, { exchangeCode: 'NYSE' });
      assert.equal(
        await attempt(fresh(), [eod(s.localDate, '95')]),
        'TIINGO_CLOSE_EXCHANGE_MISMATCH',
      );
      assert.equal(requestedDaily, false, 'exchange mismatch: no daily read');
      metaOverrides.set(s.symbol, { ticker: 'zzzz' });
      assert.equal(
        await attempt(fresh(), [eod(s.localDate, '95')]),
        'TIINGO_SYMBOL_MISMATCH',
      );
      assert.equal(requestedDaily, false, 'ticker mismatch: no daily read');
      metaOverrides.clear();
      // The trial (memory-only) mode is never close evidence.
      const trial = new TiingoSessionCloseSource(
        new TiingoConfigService(
          readTiingoConfig({
            NODE_ENV: 'test',
            TIINGO_ENABLED: 'true',
            TIINGO_API_TOKEN: 'synthetic-loc-us-token',
            TIINGO_ALLOWED_SYMBOLS: 'AAPL',
          }),
        ),
        tiingoRest,
      );
      assert.equal(
        await attempt(trial, [eod(s.localDate, '95')]),
        'TIINGO_CLOSE_SOURCE_DISABLED',
      );
      assert.equal(requestedDaily, false, 'trial mode: no daily read');
      eodResponses.length = 0;
      // The raw close is the observation; adjusted values are audit only.
      eodResponses.push([eod(s.localDate, '95', { adjusted: '47.5' })]);
      const observed = await fresh().observe(target);
      assert.equal(observed.closePrice.toFixed(2), '95.00');
      assert.equal(observed.currencyCode, 'USD');
      assert.equal(observed.sourceName, 'tiingo_eod');
      assert.equal(jsonText(observed.raw).includes('47.5'), true);
      assert.equal(
        jsonText(observed.raw).includes('synthetic-loc-us-token'),
        false,
      );
      assert.equal(
        await db.sessionClosePriceEvidence.count({
          where: { assetId: s.assetId },
        }),
        0,
      );
      pass(
        'Tiingo close rules: previous/next date, missing/extra bars, no volume, invalid OHLC, early receipt, exchange/ticker mismatch, trial mode never evidence; raw close only',
      );
    },
    { closeInMs: 1500 },
  );
}

// ── D. Deadline (23:00 New York), lifecycle, races ───────────────────────────

async function deadlineExpiry() {
  for (const side of ['buy', 'sell'] as const)
    await usScenario(
      'season',
      async (s) => {
        const before = await wallet(s);
        const { orderId } = await place(s, {
          side,
          quantity: side === 'sell' ? '3' : '10',
        });
        const placed = await order(orderId);
        // Default deadline: 23:00 New York of the session date.
        assert.equal(
          placed.limitOnClose?.evidenceDeadlineAt.toISOString(),
          wallTime(s.localDate, '23:00').toISOString(),
        );
        // Turning the US flags off stops new orders only; accepted orders
        // still settle or release.
        process.env.LOC_US_ORDERS_ENABLED = 'false';
        process.env.LOC_US_SELL_ORDERS_ENABLED = 'false';
        await rejects(
          place(s, { side, quantity: '1' }),
          side === 'buy'
            ? 'LOC_MARKET_NOT_SUPPORTED'
            : 'LOC_SELL_ORDERS_DISABLED',
        );
        await afterClose(s);
        let summary = await cycle();
        assert.equal(summary.waiting, 1, jsonText(summary));
        assert.equal(eodRequests.length, 0);
        await db.limitOnCloseOrder.update({
          where: { orderId },
          data: { evidenceDeadlineAt: new Date((await now()).getTime() - 1) },
        });
        summary = await cycle();
        assert.equal(
          summary.expired.loc_close_evidence_unavailable,
          1,
          jsonText(summary),
        );
        const row = await order(orderId);
        assert.equal(row.status, 'canceled');
        assert.equal(row.cancelReason, 'loc_close_evidence_unavailable');
        assert.equal(row.limitOnClose?.status, 'expired');
        assert.equal(row.executedPrice, null);
        assert.deepEqual(await wallet(s), before);
        if (side === 'sell')
          assert.deepEqual(await holding(s, s.assetId), {
            quantity: '10.00000000',
            reserved: '0.00000000',
          });
        pass(
          `${side.toUpperCase()}: deadline 23:00 New York stored; flags off keep settlement; no close by the deadline → expire, release once`,
        );
      },
      { holding: side === 'sell' ? '10' : undefined },
    );
}

/** The fill reuses the equity snapshot: in Tiingo mode a US position is
 * valued only on Tiingo prices — a fresher admin_manual or KIS price never
 * stands in, so the fill rolls back until a Tiingo price exists. */
async function valuationOnTiingoOnly() {
  await usScenario('general', async (s) => {
    const before = await wallet(s);
    const { orderId } = await place(s);
    await db.assetPriceSnapshot.deleteMany({ where: { assetId: s.assetId } });
    await usPrice(s, '95', {
      sourceType: 'admin_manual',
      sourceName: 'admin_manual',
    });
    await usPrice(s, '95', { sourceName: 'kis_us_delayed_trade' });
    await afterClose(s);
    await finalUsClose(s, '95');
    let summary = await cycle();
    assert.equal(summary.filled, 0, jsonText(summary));
    assert.equal(summary.errors.LOC_FILL_FAILED, 1, jsonText(summary));
    let row = await order(orderId);
    assert.equal(row.status, 'submitted');
    assert.equal(row.limitOnClose?.lastCheckCode, 'LOC_FILL_FAILED');
    assert.equal((await wallet(s)).balance, before.balance);
    assert.equal(await ledger(s, 'order_buy'), 0);
    await usPrice(s, '95', { at: new Date(s.closeAt.getTime() - 1000) });
    summary = await cycle();
    assert.equal(summary.filled, 1, jsonText(summary));
    row = await order(orderId);
    assert.equal(row.executedPrice?.toFixed(2), '95.00');
    pass(
      'valuation in Tiingo mode: admin_manual/KIS prices never value a US fill; a Tiingo price does',
    );
  });
}

/** Without fresh USD/KRW the fill defers (never stale FX); the settlement's
 * own refresh then supplies it. */
async function fxRefresh() {
  await usScenario('general', async (s) => {
    const before = await wallet(s);
    const { orderId } = await place(s);
    await afterClose(s);
    await finalUsClose(s, '97');
    await ageFx();
    fxRefreshFails = true;
    const calls = fxRefreshCalls;
    let summary = await cycle();
    assert.equal(fxRefreshCalls, calls + 1);
    assert.equal(summary.skipped.fx_evidence_unavailable, 1, jsonText(summary));
    let row = await order(orderId);
    assert.equal(row.status, 'submitted');
    assert.equal(
      row.limitOnClose?.lastCheckCode,
      'FILL_SKIPPED_FX_EVIDENCE_UNAVAILABLE',
    );
    assert.equal((await wallet(s)).reserved, row.reservedAmount!.toFixed(8));
    assert.equal((await wallet(s)).balance, before.balance);
    fxRefreshFails = false;
    summary = await cycle();
    assert.equal(summary.filled, 1, jsonText(summary));
    row = await order(orderId);
    const latest = await db.fxRateSnapshot.findFirstOrThrow({
      where: { id: { in: fxEvidenceIds } },
      orderBy: { capturedAt: 'desc' },
    });
    assert.equal(row.fxRateSnapshotId, latest.id);
    pass(
      'USD/KRW: stale FX defers the US fill (reservation kept); the settlement refresh then fills with that FX',
    );
  });
}
/** Every USD/KRW row of this runner older than the 60 s fill window; waits
 * for any other fresh row in the disposable DB to age out. */
async function ageFx() {
  const old = new Date((await now()).getTime() - 600_000);
  await db.fxRateSnapshot.updateMany({
    where: { id: { in: fxEvidenceIds } },
    data: { effectiveAt: old, capturedAt: old },
  });
  const started = Date.now();
  for (;;) {
    const clock = await now();
    const fresh = await db.fxRateSnapshot.count({
      where: {
        baseCurrency: 'USD',
        quoteCurrency: 'KRW',
        capturedAt: { gte: new Date(clock.getTime() - 62_000) },
      },
    });
    if (fresh === 0) return;
    assert.ok(Date.now() - started < 75_000, 'fresh USD/KRW did not age out');
    await delay(1000);
  }
}

async function duplicateWorkers() {
  await usScenario('season', async (s) => {
    const { orderId } = await place(s);
    await afterClose(s);
    await finalUsClose(s, '98');
    await Promise.all([cycle(), cycle(), cycle()]);
    assert.equal((await order(orderId)).status, 'executed');
    assert.equal(await ledger(s, 'order_buy'), 1);
    assert.equal(
      (
        await db.seasonParticipant.findUniqueOrThrow({
          where: { tradingAccountId: s.accountId },
        })
      ).totalFillCount,
      1,
    );
    pass(
      'concurrent settlement cycles → one fill, one ledger row, one fill count',
    );
  });
  await usScenario('general', async (s) => {
    const { orderId } = await place(s);
    await afterClose(s);
    await finalUsClose(s, '98');
    const workers = [0, 1].map(
      () =>
        new LimitOnCloseWorker(
          new OpsJobLockService(db),
          new OpsJobRunService(db),
          newSettlement(),
        ),
    );
    const results = await Promise.all(workers.map((worker) => worker.tick()));
    assert.equal(
      results.filter((result) => (result?.filled ?? 0) > 0).length,
      1,
    );
    assert.equal((await order(orderId)).status, 'executed');
    assert.equal(await ledger(s, 'order_buy'), 1);
    pass('two worker instances share one OpsJobLock lease (one US fill)');
  });
}

async function cancelVersusSettlement() {
  for (let round = 0; round < 3; round++)
    await usScenario('season', async (s) => {
      const before = await wallet(s);
      const { orderId } = await place(s);
      await afterClose(s);
      await finalUsClose(s, '99');
      const [, canceled] = await Promise.allSettled([
        cycle(),
        orders.cancelOrderForTradingAccount(s.userId, s.accountId, orderId),
      ]);
      const row = await order(orderId);
      const after = await wallet(s);
      assert.equal(after.reserved, '0.00000000');
      if (row.status === 'executed') {
        assert.equal(row.limitOnClose?.status, 'filled');
        assert.equal(canceled.status, 'rejected');
        assert.equal(await ledger(s, 'order_buy'), 1);
      } else {
        assert.equal(row.status, 'canceled');
        assert.equal(row.limitOnClose?.status, 'canceled');
        assert.deepEqual(after, before);
        assert.equal(await ledger(s, 'order_buy'), 0);
      }
    });
  pass('US settlement vs user cancel → exactly one winner (3 rounds)');
}

async function lifecycle() {
  // Season ends between the close and settlement: no fill, cleanup releases.
  await usScenario('season', async (s) => {
    const before = await wallet(s);
    const { orderId } = await place(s);
    await afterClose(s);
    await finalUsClose(s, '97');
    await db.season.update({
      where: { id: s.season!.id },
      data: { status: 'ended', endAt: new Date((await now()).getTime() - 1) },
    });
    const summary = await cycle();
    assert.equal(summary.skipped.season_not_active, 1, jsonText(summary));
    await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
    const row = await order(orderId);
    assert.equal(row.cancelReason, 'season_ended');
    assert.equal(row.limitOnClose?.status, 'canceled');
    assert.deepEqual(await wallet(s), before);
    pass(
      'Season end races US settlement → no fill, lifecycle cleanup releases',
    );
  });
  // Participant exclusion cancels the open US LOC and releases.
  await usScenario('season', async (s) => {
    const { orderId } = await place(s);
    await db.$transaction(async (tx) => {
      const participant = await tx.seasonParticipant.findUniqueOrThrow({
        where: { tradingAccountId: s.accountId },
      });
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: participant.id,
        participantWrite: true,
      });
      await cancel.cancelOpenLimitBuysForParticipantInTransaction(tx, {
        tradingAccountId: s.accountId,
        reason: 'participant_excluded',
        canceledAt: await now(),
      });
    });
    const row = await order(orderId);
    assert.equal(row.cancelReason, 'participant_excluded');
    assert.equal(row.limitOnClose?.status, 'canceled');
    assert.equal((await wallet(s)).reserved, '0.00000000');
    pass('participant exclusion cancels a US LOC and releases');
  });
  // Suspended account / inactive (halted) asset: no fill; the deadline releases.
  for (const blocked of ['account', 'asset'] as const)
    await usScenario('general', async (s) => {
      const before = await wallet(s);
      const { orderId } = await place(s);
      await afterClose(s);
      await finalUsClose(s, '95');
      if (blocked === 'account')
        await db.tradingAccount.update({
          where: { id: s.accountId },
          data: { status: 'suspended' },
        });
      else
        await db.asset.update({
          where: { id: s.assetId },
          data: { isActive: false },
        });
      let summary = await cycle();
      assert.equal(
        summary.skipped[
          blocked === 'account' ? 'account_not_active' : 'asset_inactive'
        ],
        1,
        jsonText(summary),
      );
      assert.equal((await order(orderId)).status, 'submitted');
      await db.limitOnCloseOrder.update({
        where: { orderId },
        data: { evidenceDeadlineAt: new Date((await now()).getTime() - 1) },
      });
      summary = await cycle();
      assert.equal(
        summary.expired.loc_fill_not_permitted,
        1,
        jsonText(summary),
      );
      const row = await order(orderId);
      assert.equal(row.cancelReason, 'loc_fill_not_permitted');
      assert.equal(row.limitOnClose?.status, 'expired');
      assert.ok(row.limitOnClose?.closeEvidenceId);
      assert.deepEqual(await wallet(s), before);
      if (blocked === 'account')
        await db.tradingAccount.update({
          where: { id: s.accountId },
          data: { status: 'active' },
        });
      pass(
        `${blocked === 'account' ? 'suspended account' : 'inactive asset'}: final close never fills; the deadline releases`,
      );
    });
}

// ── E. Post-final audit (diagnostics only) ───────────────────────────────────

async function postFinalAudit() {
  await usScenario('general', async (s) => {
    const { orderId } = await place(s);
    await afterClose(s);
    const final = await finalUsClose(s, '95');
    assert.equal((await cycle()).filled, 1);
    const filled = await order(orderId);
    const walletAfterFill = await wallet(s);
    // Finalized 7 h ago (inside the 6–72 h audit window) — and two rows that
    // are never audited: a KRX/KOSCOM final and a US final older than 72 h.
    const clock = await now();
    await db.sessionClosePriceEvidence.update({
      where: { id: final.id },
      data: { finalizedAt: new Date(clock.getTime() - 7 * 3_600_000) },
    });
    const ancientDate = new Date(s.sessionDate.getTime() - 5 * 86_400_000);
    const ancient = await db.sessionClosePriceEvidence.create({
      data: {
        assetId: s.assetId,
        market: 'US',
        sessionDate: ancientDate,
        sessionCloseAt: new Date(s.closeAt.getTime() - 5 * 86_400_000),
        provider: 'tiingo',
        sourceName: 'tiingo_eod',
        providerSymbol: s.symbol,
        providerTradingDate: sessionDateText(ancientDate).replaceAll('-', ''),
        closePrice: '90',
        currencyCode: 'USD',
        status: 'final',
        firstObservedAt: new Date(s.closeAt.getTime() - 5 * 86_400_000),
        lastObservedAt: new Date(s.closeAt.getTime() - 5 * 86_400_000),
        finalizedAt: new Date(clock.getTime() - 80 * 3_600_000),
        firstRawJson: { fixture: 'old' },
        confirmRawJson: { fixture: 'old' },
        policyVersion: 1,
      },
    });
    const krxFinal = await db.sessionClosePriceEvidence.create({
      data: {
        assetId: s.krxAssetId,
        market: 'KRX',
        sessionDate: s.sessionDate,
        sessionCloseAt: s.closeAt,
        provider: 'koscom',
        sourceName: 'koscom_history',
        providerSymbol: 'KRX1',
        providerTradingDate: s.localDate.replaceAll('-', ''),
        closePrice: '100',
        currencyCode: 'KRW',
        status: 'final',
        firstObservedAt: s.closeAt,
        lastObservedAt: s.closeAt,
        finalizedAt: new Date(clock.getTime() - 7 * 3_600_000),
        firstRawJson: { fixture: 'krx' },
        confirmRawJson: { fixture: 'krx' },
        policyVersion: 1,
      },
    });
    const finalBefore = await db.sessionClosePriceEvidence.findUniqueOrThrow({
      where: { id: final.id },
    });
    // A worker on a fresh settlement (a restarted server) audits it once:
    // Tiingo now reports 95.25 — recorded for operations, nothing rewritten.
    const requests = eodRequests.length;
    eodResponses.push([eod(s.localDate, '95.25')]);
    const worker = new LimitOnCloseWorker(
      new OpsJobLockService(db),
      new OpsJobRunService(db),
      newSettlement(),
    );
    const audited = await worker.tick();
    assert.ok(audited, 'the due audit is work for the idle probe');
    assert.deepEqual(audited.postFinalAudited, [final.id]);
    assert.equal(audited.postFinalCorrections.length, 1);
    assert.deepEqual(audited.postFinalCorrections[0], {
      evidenceId: final.id,
      assetId: s.assetId,
      sessionDate: s.localDate,
      finalClose: '95',
      observedClose: '95.25',
    });
    assert.equal(eodRequests.length, requests + 1);
    assert.deepEqual(eodRequests.at(-1), {
      symbol: s.symbol,
      startDate: s.localDate,
      endDate: s.localDate,
    });
    const finalAfter = await db.sessionClosePriceEvidence.findUniqueOrThrow({
      where: { id: final.id },
    });
    assert.equal(jsonText(finalAfter), jsonText(finalBefore));
    const order2 = await order(orderId);
    assert.equal(
      order2.executedPrice?.toFixed(8),
      filled.executedPrice?.toFixed(8),
    );
    assert.equal(order2.netAmount?.toFixed(8), filled.netAmount?.toFixed(8));
    assert.deepEqual(await wallet(s), walletAfterFill);
    assert.equal(await ledger(s, 'order_buy'), 1);
    // Never twice: not by the same settlement, nor after another restart
    // (the marks are the ids in the recorded run summaries).
    assert.equal(await worker.tick(), undefined);
    const restarted = newSettlement();
    assert.equal(await restarted.hasDueWork(), false);
    const again = await restarted.runCycle({ config });
    assert.deepEqual(again.postFinalAudited, []);
    assert.equal(eodRequests.length, requests + 1);
    await db.sessionClosePriceEvidence.deleteMany({
      where: { id: { in: [ancient.id, krxFinal.id] } },
    });
    pass(
      'post-final audit: one Tiingo re-read 6–72 h after finality; a correction is diagnosed only (evidence, fill, wallet unchanged); restart-safe; KRX and >72 h never audited',
    );
  });
}

// ── F. Registration rules ────────────────────────────────────────────────────

async function registrationRules() {
  await usScenario(
    'season',
    async (s) => {
      for (const [patch, expected] of [
        [
          {
            attachedProtection: [
              {
                kind: 'stop_loss',
                triggerPrice: '90',
                childOrderType: 'market',
              },
            ],
          },
          'LOC_ATTACHED_PROTECTION_NOT_SUPPORTED',
        ],
        [
          { orderType: 'market', limitPrice: undefined },
          'INVALID_LIMIT_ON_CLOSE',
        ],
        [{ quantity: '1.5' }, 'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED'],
        [{ quantity: '1000' }, 'INSUFFICIENT_AVAILABLE_BALANCE'],
        [{ side: 'sell', quantity: '1' }, 'INSUFFICIENT_QUANTITY'],
      ] as Array<[OrderRequestBody, string]>)
        await rejects(
          orders.quoteOrderForTradingAccount(
            s.userId,
            s.accountId,
            locBody(s, patch),
          ),
          expected,
        );
      // Per-market flags: US BUY off leaves KRX BUY; KRX SELL on never opens US SELL.
      process.env.LOC_US_ORDERS_ENABLED = 'false';
      await rejects(place(s), 'LOC_MARKET_NOT_SUPPORTED');
      const krx = await place(s, { assetId: s.krxAssetId });
      assert.equal(krx.quote.limitOnClose?.market, 'KRX');
      process.env.LOC_US_ORDERS_ENABLED = 'true';
      process.env.LOC_US_SELL_ORDERS_ENABLED = 'false';
      process.env.LOC_SELL_ORDERS_ENABLED = 'true';
      await db.position.create({
        data: {
          tradingAccountId: s.accountId,
          assetId: s.assetId,
          quantity: '5',
          averageCost: '90',
          currencyCode: 'USD',
        },
      });
      await rejects(
        place(s, { side: 'sell', quantity: '1' }),
        'LOC_MARKET_NOT_SUPPORTED',
      );
      process.env.LOC_SELL_ORDERS_ENABLED = 'false';
      await rejects(
        place(s, { side: 'sell', quantity: '1' }),
        'LOC_SELL_ORDERS_DISABLED',
      );
      process.env.LOC_US_SELL_ORDERS_ENABLED = 'true';
      // Idempotent create: one order, one reservation.
      const body = locBody(s, { quantity: '2' });
      const quoted = await orders.quoteOrderForTradingAccount(
        s.userId,
        s.accountId,
        body,
      );
      const request = {
        ...body,
        quoteId: quoted.data.quoteId,
        idempotencyKey: randomUUID(),
      };
      const first = await orders.createOrderForTradingAccount(
        s.userId,
        s.accountId,
        request,
      );
      const replay = await orders.createOrderForTradingAccount(
        s.userId,
        s.accountId,
        request,
      );
      assert.equal(replay.data.order.orderId, first.data.order.orderId);
      const reserved = await order(first.data.order.orderId);
      assert.equal(
        new Prisma.Decimal((await wallet(s)).reserved).toFixed(8),
        reserved.reservedAmount!.toFixed(8),
      );
      // An inactive (halted) asset and a suspended account are refused.
      await db.asset.update({
        where: { id: s.assetId },
        data: { isActive: false },
      });
      await rejects(place(s), 'ASSET_NOT_TRADABLE');
      await db.asset.update({
        where: { id: s.assetId },
        data: { isActive: true },
      });
      await db.tradingAccount.update({
        where: { id: s.accountId },
        data: { status: 'suspended' },
      });
      await rejects(place(s), 'TRADING_ACCOUNT_NOT_ACTIVE');
      await db.tradingAccount.update({
        where: { id: s.accountId },
        data: { status: 'active' },
      });
      // A session closing at Season end is refused.
      await db.season.update({
        where: { id: s.season!.id },
        data: { endAt: s.closeAt },
      });
      await rejects(place(s), 'LOC_SESSION_AFTER_SEASON_END');
      pass(
        'US registration: attachment/type/fraction/funds/holding rules, per-market BUY/SELL flags, idempotent create, inactive asset, suspended account, Season end',
      );
    },
    { closeInMs: 8000 },
  );
  // No pre-market or after-hours LOC: only inside the regular session.
  await usScenario(
    'general',
    async (s) => {
      const body = locBody(s);
      const quote = await orders.quoteOrderForTradingAccount(
        s.userId,
        s.accountId,
        body,
      );
      await afterClose(s);
      await rejects(
        orders.createOrderForTradingAccount(s.userId, s.accountId, {
          ...body,
          quoteId: quote.data.quoteId,
          idempotencyKey: randomUUID(),
        }),
        'LOC_SESSION_NOT_OPEN',
      );
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
        'LOC_SESSION_NOT_OPEN',
      );
      // Pre-market: the next session opens in a minute.
      const clock = await now();
      tradingSessions.set(
        new Date(clock.getTime() + 86_400_000 + 60_000),
        undefined,
        ['US'],
        { localDate: s.localDate },
      );
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
        'LOC_SESSION_NOT_OPEN',
      );
      assert.equal(
        await db.order.count({ where: { tradingAccountId: s.accountId } }),
        0,
      );
      assert.equal((await wallet(s)).reserved, '0.00000000');
      pass(
        'outside the regular session (after the close, pre-market) LOC is refused',
      );
    },
    { closeInMs: 2500 },
  );
  await usScenario(
    'beginner',
    async (s) => {
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, locBody(s)),
        'BEGINNER_FEATURE_LOCKED',
      );
      pass('beginner learning lock applies to US LOC');
    },
    { freshLearning: true },
  );
}

/** Ordinary market orders in Tiingo mode: quoted, filled and settled on the
 * stored Tiingo price only (a newer KIS or operator price never stands in),
 * from the USD wallet; a Tiingo price older than the execute freshness (10 s)
 * is refused even beside a fresh KIS price. */
async function marketOrdersOnTiingo() {
  await usScenario(
    'general',
    async (s) => {
      const execute = (body: OrderRequestBody) =>
        placeAs(s, { assetId: s.assetId, orderType: 'market', ...body });
      await db.assetPriceSnapshot.deleteMany({ where: { assetId: s.assetId } });
      await usPrice(s, '101');
      await usPrice(s, '150', { sourceName: 'kis_us_delayed_trade' });
      await usPrice(s, '160', {
        sourceType: 'admin_manual',
        sourceName: 'admin_manual',
      });
      const before = await wallet(s);
      const bought = await execute({ side: 'buy', quantity: '2' });
      let row = await order(bought.orderId);
      assert.equal(row.status, 'executed');
      assert.equal(row.executedPrice?.toFixed(2), '101.00');
      assert.equal(row.currencyCode, 'USD');
      const afterBuy = await wallet(s);
      assert.equal(
        new Prisma.Decimal(before.balance).minus(afterBuy.balance).toFixed(8),
        row.netAmount?.toFixed(8),
      );
      assert.deepEqual(await holding(s, s.assetId), {
        quantity: '2.00000000',
        reserved: '0.00000000',
      });
      assert.equal(await ledger(s, 'order_buy'), 1);
      await usPrice(s, '102');
      const sold = await execute({ side: 'sell', quantity: '1' });
      row = await order(sold.orderId);
      assert.equal(row.status, 'executed');
      assert.equal(row.executedPrice?.toFixed(2), '102.00');
      const afterSell = await wallet(s);
      assert.equal(
        new Prisma.Decimal(afterSell.balance)
          .minus(afterBuy.balance)
          .toFixed(8),
        row.netAmount?.toFixed(8),
      );
      assert.deepEqual(await holding(s, s.assetId), {
        quantity: '1.00000000',
        reserved: '0.00000000',
      });
      assert.equal(await ledger(s, 'order_sell'), 1);
      // Older than the execute freshness (10 s; still quotable for 60 s):
      // refused at execute, never priced by the fresh KIS row beside it.
      await waitUntil((await now()).getTime() + 11_000);
      await usPrice(s, '150', { sourceName: 'kis_us_delayed_trade' });
      await rejects(execute({ side: 'buy', quantity: '1' }), 'PRICE_STALE');
      assert.equal(await ledger(s, 'order_buy'), 1);
      pass(
        'market BUY/SELL in Tiingo mode: filled at the stored Tiingo price (newer KIS/admin_manual ignored), USD wallet/ledger/position move; an 11 s old Tiingo price is refused at execute',
      );
    },
    { closeInMs: 120_000 },
  );
}

const SCENARIOS = {
  fullWindowBuyWithKrx,
  fullWindowSellSharedRestart,
  boundaryDecisions,
  sellQuantityAdjustment,
  continuousPathsNeverFill,
  providerIsolation,
  tiingoObservationRules,
  deadlineExpiry,
  valuationOnTiingoOnly,
  fxRefresh,
  duplicateWorkers,
  cancelVersusSettlement,
  lifecycle,
  postFinalAudit,
  registrationRules,
  marketOrdersOnTiingo,
} as const;

async function main() {
  await db.$connect();
  const started = Date.now();
  // All by default; a manual replay may pick some (e.g. the full window with
  // LOC_US_INTEGRATION_CONFIRM_MS=300000).
  const picked = (process.env.LOC_US_INTEGRATION_SCENARIOS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of picked)
    assert.ok(name in SCENARIOS, `unknown scenario ${name}`);
  try {
    for (const [name, scenario] of Object.entries(SCENARIOS))
      if (!picked.length || picked.includes(name)) await scenario();
    console.log(
      `US Limit-on-Close PostgreSQL PASS (${checks} scenarios, confirm ${CONFIRM_MS} ms, ${Math.round((Date.now() - started) / 1000)} s)`,
    );
  } finally {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
