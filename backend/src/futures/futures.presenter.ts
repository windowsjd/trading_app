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
    priceEvidence: {
      assetPriceSnapshotId: row.assetPriceSnapshotId,
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
      freeCollateral: string;
    };
  };
};
