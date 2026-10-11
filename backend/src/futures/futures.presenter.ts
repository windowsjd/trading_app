import { FUTURES_DISPLAY_DECIMALS } from '../providers/binance/binance-product-catalog';
import { parseTickSizeDisplayDecimals } from '../providers/binance/binance-tick-size';
import type {
  FuturesExecution,
  FuturesInstrument,
  FuturesPosition,
  Asset,
} from '../generated/prisma/client';

export const futuresInstrumentInclude = { underlyingAsset: true } as const;
export type InstrumentWithAsset = FuturesInstrument & {
  underlyingAsset: Asset;
};
export function presentFuturesInstrument(row: InstrumentWithAsset) {
  const contract = row.markContractJson;
  const tickDecimals =
    contract && typeof contract === 'object' && !Array.isArray(contract)
      ? parseTickSizeDisplayDecimals(contract.priceTickSize)
      : null;
  return {
    id: row.id,
    productType: row.productType,
    settlementCurrency: row.settlementCurrency,
    isActive: row.isActive,
    underlying: {
      assetId: row.underlyingAssetId,
      symbol: row.underlyingAsset.symbol,
      name: row.underlyingAsset.name,
      market: row.underlyingAsset.market,
      // Display only; execution arithmetic and eight-decimal evidence stay intact.
      displayPriceDecimals:
        tickDecimals !== null && tickDecimals <= 8
          ? tickDecimals
          : (FUTURES_DISPLAY_DECIMALS[row.underlyingAsset.symbol] ?? 8),
    },
  };
}
export function presentFuturesPosition(row: FuturesPosition) {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    instrumentId: row.instrumentId,
    direction: row.direction,
    marginMode: row.marginMode,
    status: row.status,
    quantity: row.quantity.toFixed(8),
    averageEntryPrice: row.averageEntryPrice.toFixed(8),
    leverage: row.leverage,
    isolatedMargin: row.isolatedMargin.toFixed(8),
    realizedPnl: row.realizedPnl.toFixed(8),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
export function presentFuturesExecution(row: FuturesExecution) {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    instrumentId: row.instrumentId,
    positionId: row.positionId,
    operation: row.operation,
    direction: row.direction,
    marginMode: row.marginMode,
    quantity: row.quantity.toFixed(8),
    leverage: row.leverage,
    executionPrice: row.executionPrice.toFixed(8),
    notional: row.notional.toFixed(8),
    feeRate: row.feeRate.toFixed(6),
    feeAmount: row.feeAmount.toFixed(8),
    realizedPnl: row.realizedPnl.toFixed(8),
    // Executions committed before Futures Last pricing keep their Spot evidence.
    priceEvidence: {
      assetPriceSnapshotId: row.assetPriceSnapshotId,
      lastPriceSnapshotId: row.lastPriceSnapshotId,
      priceBasis: row.lastPriceSnapshotId
        ? ('futures_last' as const)
        : ('spot_last' as const),
      sourceType: row.priceSourceType,
      sourceName: row.priceSourceName,
      effectiveAt: row.priceEffectiveAt.toISOString(),
      capturedAt: row.priceCapturedAt.toISOString(),
    },
    positionAfter: {
      quantity: row.positionQuantityAfter.toFixed(8),
      averageEntryPrice: row.averageEntryPriceAfter.toFixed(8),
      isolatedMargin: row.isolatedMarginAfter.toFixed(8),
    },
    executedAt: row.executedAt.toISOString(),
  };
}
export type FuturesExecuteResult = {
  success: true;
  data: {
    tradingAccountId: string;
    commandId: string;
    instrument: ReturnType<typeof presentFuturesInstrument>;
    execution: ReturnType<typeof presentFuturesExecution>;
    position: ReturnType<typeof presentFuturesPosition>;
    collateral: {
      walletId: string;
      currencyCode: 'USD';
      balanceAmount: string;
      totalMarginUsed: string;
      freeCollateral: string | null;
    };
  };
};
