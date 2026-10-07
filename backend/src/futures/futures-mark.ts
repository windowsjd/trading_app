import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  type FuturesMarkSnapshot,
  type FuturesMarkSource,
} from '../generated/prisma/client';
import type { InstrumentWithAsset } from './futures.presenter';
import { futuresError } from './futures-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

export const MARK_MAX_AGE_MS = 5000;
export const MARK_SOURCES: FuturesMarkSource[] = [
  'binance_usdm_mark_ws',
  'binance_usdm_mark_rest',
];
export function validMark(
  row: FuturesMarkSnapshot,
  instrument: InstrumentWithAsset,
  now: Date,
) {
  const asset = instrument.underlyingAsset;
  return (
    row.instrumentId === instrument.id &&
    row.symbol === asset.symbol &&
    /^[A-Z0-9]+USDT$/.test(row.symbol) &&
    row.currencyCode === 'USD' &&
    row.providerProduct === 'binance_usdm_perpetual' &&
    MARK_SOURCES.includes(row.source) &&
    instrument.productType === 'synthetic_perpetual' &&
    instrument.settlementCurrency === 'USD' &&
    asset.market === 'BINANCE' &&
    asset.assetType === 'crypto' &&
    asset.currencyCode === 'USD' &&
    asset.priceCurrency === 'USD' &&
    asset.settlementCurrency === 'USD' &&
    row.price.isFinite() &&
    row.price.gt(0) &&
    row.effectiveAt <= row.capturedAt &&
    [row.capturedAt, row.effectiveAt].every(
      (t) => t <= now && now.getTime() - t.getTime() <= MARK_MAX_AGE_MS,
    )
  );
}
export async function readFuturesMark(
  tx: Pick<Prisma.TransactionClient, 'futuresMarkSnapshot'>,
  instrument: InstrumentWithAsset,
  now: Date,
  required = true,
) {
  // One latest eligible row per typed source. Out-of-order transport never rewinds provider time.
  const rows = await Promise.all(
    MARK_SOURCES.map((source) =>
      tx.futuresMarkSnapshot.findFirst({
        where: {
          instrumentId: instrument.id,
          source,
          effectiveAt: { lte: now },
          capturedAt: { lte: now },
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { id: 'desc' },
        ],
      }),
    ),
  );
  const selected = rows.find(
    (row): row is FuturesMarkSnapshot =>
      !!row && validMark(row, instrument, now),
  );
  if (selected) return selected;
  if (!required) return null;
  const code = rows.some(Boolean)
    ? 'FUTURES_MARK_STALE'
    : 'FUTURES_MARK_UNAVAILABLE';
  setAdminDiagnosticContext({
    failureStage: 'futures_mark_selection',
    entities: { instrumentId: instrument.id },
    evidence: {
      code,
      evaluatedAt: now.toISOString(),
      maxAgeMs: MARK_MAX_AGE_MS,
      candidates: rows.filter(Boolean).map((r) => ({
        id: r!.id,
        source: r!.source,
        effectiveAt: r!.effectiveAt.toISOString(),
        capturedAt: r!.capturedAt.toISOString(),
      })),
    },
  });
  futuresError(
    code,
    'Fresh durable Binance USD-M Mark Price is required.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

export function parseBinanceMark(
  payload: unknown,
  source: FuturesMarkSource,
  expectedSymbol: string,
  capturedAt: Date,
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const p = payload as Record<string, unknown>;
  const ws = source === 'binance_usdm_mark_ws';
  const symbol = ws ? p.s : p.symbol;
  const value = ws ? p.p : p.markPrice;
  const stamp = ws ? p.E : p.time;
  if (ws && (p.e !== 'markPriceUpdate' || (p.st !== undefined && p.st !== 1)))
    return null;
  if (
    symbol !== expectedSymbol ||
    !/^[A-Z0-9]+USDT$/.test(expectedSymbol) ||
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(value) ||
    typeof stamp !== 'number' ||
    !Number.isSafeInteger(stamp)
  )
    return null;
  const price = new Prisma.Decimal(value);
  if (
    !price.isFinite() ||
    price.lte(0) ||
    stamp > capturedAt.getTime() ||
    capturedAt.getTime() - stamp > MARK_MAX_AGE_MS
  )
    return null;
  return {
    symbol: expectedSymbol,
    price,
    source,
    effectiveAt: new Date(stamp),
    capturedAt,
    currencyCode: 'USD' as const,
    providerProduct: 'binance_usdm_perpetual',
  };
}
