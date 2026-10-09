import { Prisma, type FuturesPosition } from '../generated/prisma/client';
import {
  assertFuturesMoney,
  futuresDecimal,
  futuresMoney,
  futuresPnl,
  marginCeil,
} from './futures-math';
import { readFuturesMark } from './futures-mark';
import { futuresInstrumentInclude } from './futures.presenter';

/** Display only. Never substitute this entry basis for current risk requirements. */
export function presentFuturesPerformance(
  position: Pick<
    FuturesPosition,
    'entryNotional' | 'leverage' | 'marginMode' | 'isolatedMargin'
  >,
  valuation: {
    markNotional: Prisma.Decimal;
    unrealizedPnl: Prisma.Decimal;
  } | null,
) {
  const initialMargin =
    position.marginMode === 'isolated'
      ? futuresDecimal(position.isolatedMargin)
      : marginCeil(
          futuresDecimal(position.entryNotional).div(position.leverage),
        );
  return {
    initialMargin: initialMargin.toFixed(8),
    markNotional: valuation?.markNotional.toFixed(8) ?? null,
    roi:
      valuation && initialMargin.gt(0)
        ? futuresDecimal(valuation.unrealizedPnl)
            .div(initialMargin)
            .mul(100)
            .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
            .toFixed(8)
        : null,
  };
}

/** Internal projection; only the guarded current-season friend detail calls it. */
export async function readFuturesHoldingSummaries(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  evaluatedAt: Date,
) {
  const rows = await tx.futuresPosition.findMany({
    where: { tradingAccountId, status: 'open' },
    include: { instrument: { include: futuresInstrumentInclude } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    positions: await Promise.all(
      rows.map(async (row) => {
        const mark = await readFuturesMark(
          tx,
          row.instrument,
          evaluatedAt,
          false,
        );
        const valuation = mark
          ? {
              markNotional: assertFuturesMoney(
                futuresMoney(futuresDecimal(row.quantity).mul(mark.price)),
              ),
              unrealizedPnl: futuresPnl(
                row.direction,
                row.averageEntryPrice,
                mark.price,
                row.quantity,
              ),
            }
          : null;
        const performance = presentFuturesPerformance(row, valuation);
        return {
          assetId: row.instrument.underlyingAssetId,
          name: row.instrument.underlyingAsset.name,
          symbol: row.instrument.underlyingAsset.symbol,
          direction: row.direction,
          marginMode: row.marginMode,
          leverage: row.leverage,
          markNotional: performance.markNotional,
          roi: performance.roi,
          markUnrealizedPnl: valuation?.unrealizedPnl.toFixed(8) ?? null,
          markState: mark ? 'fresh' : 'unavailable_or_stale',
          markEvidence: mark
            ? {
                effectiveAt: mark.effectiveAt.toISOString(),
                capturedAt: mark.capturedAt.toISOString(),
              }
            : null,
        };
      }),
    ),
  };
}
