import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  type FuturesLastPriceSnapshot,
  type FuturesLastPriceSource,
} from '../generated/prisma/client';
import type { InstrumentWithAsset } from './futures.presenter';
import { futuresError } from './futures-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

/** Receipt freshness, unchanged from the Crypto execution policy (10 seconds). */
export const FUTURES_LAST_MAX_CAPTURE_AGE_MS = 10_000;
/** The reported trade itself must be recent: a frozen contract fails closed. */
export const FUTURES_LAST_MAX_TRADE_AGE_MS = 60_000;
/** Season end evidence was received within 10 seconds before endAt, never after. */
export const FUTURES_FINAL_LAST_WINDOW_MS = 10_000;
/** WS priority mirrors Mark; both sources report the same last trade. */
export const FUTURES_LAST_SOURCES: FuturesLastPriceSource[] = [
  'binance_usdm_agg_trade_ws',
  'binance_usdm_ticker_price_rest',
];
const SYMBOL = /^[A-Z0-9]+USDT$/;
const PRICE = /^\d{1,16}(\.\d{1,8})?$/;

export type ParsedFuturesLastPrice = {
  symbol: string;
  price: Prisma.Decimal;
  source: FuturesLastPriceSource;
  effectiveAt: Date;
  capturedAt: Date;
  currencyCode: 'USD';
  providerProduct: 'binance_usdm_perpetual';
};

function observation(
  symbol: string,
  expectedSymbol: string,
  value: unknown,
  tradeTime: unknown,
  source: FuturesLastPriceSource,
  capturedAt: Date,
  maxAgeMs: number,
): ParsedFuturesLastPrice | null {
  if (
    symbol !== expectedSymbol ||
    !SYMBOL.test(expectedSymbol) ||
    typeof value !== 'string' ||
    !PRICE.test(value) ||
    typeof tradeTime !== 'number' ||
    !Number.isSafeInteger(tradeTime) ||
    tradeTime <= 0
  )
    return null;
  const price = new Prisma.Decimal(value);
  if (
    !price.isFinite() ||
    price.lte(0) ||
    tradeTime > capturedAt.getTime() ||
    capturedAt.getTime() - tradeTime > maxAgeMs
  )
    return null;
  return {
    symbol: expectedSymbol,
    price,
    source,
    effectiveAt: new Date(tradeTime),
    capturedAt,
    currencyCode: 'USD',
    providerProduct: 'binance_usdm_perpetual',
  };
}

/** `<symbol>@aggTrade`: market trade price `p` at trade time `T`. Insurance
 * fund/ADL fills are excluded by Binance. `a` orders events per symbol. */
export function parseBinanceAggTrade(
  payload: unknown,
  expectedSymbol: string,
  capturedAt: Date,
): (ParsedFuturesLastPrice & { aggregateId: number }) | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const p = payload as Record<string, unknown>;
  if (
    p.e !== 'aggTrade' ||
    (p.st !== undefined && p.st !== 1) ||
    typeof p.a !== 'number' ||
    !Number.isSafeInteger(p.a) ||
    p.a < 0
  )
    return null;
  const parsed = observation(
    typeof p.s === 'string' ? p.s : '',
    expectedSymbol,
    p.p,
    p.T,
    'binance_usdm_agg_trade_ws',
    capturedAt,
    FUTURES_LAST_MAX_CAPTURE_AGE_MS,
  );
  return parsed && { ...parsed, aggregateId: p.a };
}

/** GET /fapi/v2/ticker/price row: the current last price and its trade time.
 * A quiet contract keeps its older trade time; the receipt proves currency. */
export function parseBinanceTickerPrice(
  payload: unknown,
  expectedSymbol: string,
  capturedAt: Date,
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const p = payload as Record<string, unknown>;
  return observation(
    typeof p.symbol === 'string' ? p.symbol : '',
    expectedSymbol,
    p.price,
    p.time,
    'binance_usdm_ticker_price_rest',
    capturedAt,
    FUTURES_LAST_MAX_TRADE_AGE_MS,
  );
}

function validIdentity(
  row: FuturesLastPriceSnapshot,
  instrument: InstrumentWithAsset,
) {
  const asset = instrument.underlyingAsset;
  return (
    row.instrumentId === instrument.id &&
    row.symbol === asset.symbol &&
    SYMBOL.test(row.symbol) &&
    row.currencyCode === 'USD' &&
    row.providerProduct === 'binance_usdm_perpetual' &&
    FUTURES_LAST_SOURCES.includes(row.source) &&
    instrument.productType === 'synthetic_perpetual' &&
    instrument.settlementCurrency === 'USD' &&
    asset.market === 'BINANCE' &&
    asset.assetType === 'crypto' &&
    asset.currencyCode === 'USD' &&
    asset.priceCurrency === 'USD' &&
    asset.settlementCurrency === 'USD' &&
    row.price.isFinite() &&
    row.price.gt(0) &&
    row.effectiveAt <= row.capturedAt
  );
}

/** Executable at `now`: received within 10 seconds, trade within 60 seconds. */
export function validFuturesLastPrice(
  row: FuturesLastPriceSnapshot,
  instrument: InstrumentWithAsset,
  now: Date,
) {
  return (
    validIdentity(row, instrument) &&
    row.capturedAt <= now &&
    +now - +row.capturedAt <= FUTURES_LAST_MAX_CAPTURE_AGE_MS &&
    +now - +row.effectiveAt <= FUTURES_LAST_MAX_TRADE_AGE_MS
  );
}

/** Season end: received in [endAt-10s, endAt]; the trade within 60s of endAt. */
export function validFuturesFinalLastPrice(
  row: FuturesLastPriceSnapshot,
  instrument: InstrumentWithAsset,
  endAt: Date,
) {
  return (
    validIdentity(row, instrument) &&
    row.capturedAt <= endAt &&
    +endAt - +row.capturedAt <= FUTURES_FINAL_LAST_WINDOW_MS &&
    +endAt - +row.effectiveAt <= FUTURES_LAST_MAX_TRADE_AGE_MS
  );
}

/** The latest known trade wins and a later receipt of that same trade breaks
 * the tie. A fresher receipt of an OLDER trade (a lagging REST reply) can never
 * replace a newer known trade: if the newest trade is stale, reads fail closed. */
async function latestKnownTrade(
  client: Pick<Prisma.TransactionClient, 'futuresLastPriceSnapshot'>,
  instrumentId: string,
  at: Date,
) {
  return client.futuresLastPriceSnapshot.findFirst({
    where: { instrumentId, capturedAt: { lte: at }, effectiveAt: { lte: at } },
    orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }, { id: 'desc' }],
  });
}

/** DB-only Futures Last execution/reference price. Never Spot, Mark or Index. */
export async function readFuturesLastPrice(
  client: Pick<Prisma.TransactionClient, 'futuresLastPriceSnapshot'>,
  instrument: InstrumentWithAsset,
  now: Date,
  required = true,
) {
  const row = await latestKnownTrade(client, instrument.id, now);
  if (row && validFuturesLastPrice(row, instrument, now)) return row;
  if (!required) return null;
  const code = row ? 'FUTURES_PRICE_STALE' : 'FUTURES_PRICE_UNAVAILABLE';
  setAdminDiagnosticContext({
    failureStage: 'futures_last_price_selection',
    entities: { instrumentId: instrument.id },
    evidence: {
      code,
      evaluatedAt: now.toISOString(),
      selectionState: row ? 'latest_trade_rejected' : 'no_observation',
      maxCaptureAgeMs: FUTURES_LAST_MAX_CAPTURE_AGE_MS,
      maxTradeAgeMs: FUTURES_LAST_MAX_TRADE_AGE_MS,
      candidate: row
        ? {
            id: row.id,
            source: row.source,
            effectiveAt: row.effectiveAt.toISOString(),
            capturedAt: row.capturedAt.toISOString(),
          }
        : null,
    },
    nextInvestigation: [
      'backend/src/futures/futures-last-price.ts',
      'backend/src/futures/futures-last-price-ingestion.service.ts',
    ],
  });
  futuresError(
    code,
    'The current execution price is unavailable. Please try again.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/** Season end boundary: the newest trade received at or before endAt. Post-end
 * receipts cannot hide or replace it, and no live/REST/Spot/Mark substitute exists. */
export async function readFuturesFinalLastPrice(
  client: Pick<Prisma.TransactionClient, 'futuresLastPriceSnapshot'>,
  instrument: InstrumentWithAsset,
  endAt: Date,
) {
  const row = await latestKnownTrade(client, instrument.id, endAt);
  if (row && validFuturesFinalLastPrice(row, instrument, endAt)) return row;
  setAdminDiagnosticContext({
    failureStage: 'futures_final_last_price_selection',
    entities: { instrumentId: instrument.id },
    evidence: {
      evaluationState: row
        ? 'end_boundary_trade_rejected'
        : 'end_boundary_no_observation',
      endAt,
      windowMs: FUTURES_FINAL_LAST_WINDOW_MS,
      maxTradeAgeMs: FUTURES_LAST_MAX_TRADE_AGE_MS,
      candidate: row
        ? {
            id: row.id,
            source: row.source,
            effectiveAt: row.effectiveAt.toISOString(),
            capturedAt: row.capturedAt.toISOString(),
          }
        : null,
    },
    nextInvestigation: ['backend/src/futures/futures-last-price.ts'],
  });
  futuresError(
    'FUTURES_FINAL_PRICE_UNAVAILABLE',
    'A fresh final execution price at Season end is required.',
  );
}

/** Live reference evidence; keys are a superset of the legacy Spot shape. */
export function presentFuturesLastEvidence(row: FuturesLastPriceSnapshot) {
  return {
    assetPriceSnapshotId: null,
    lastPriceSnapshotId: row.id,
    priceBasis: 'futures_last' as const,
    sourceType: 'provider_api' as const,
    sourceName: row.source,
    effectiveAt: row.effectiveAt.toISOString(),
    capturedAt: row.capturedAt.toISOString(),
  };
}
