/**
 * Pure presentation of Binance market-data readiness for the recovery command.
 *
 * It joins the read-only MarketSnapshotHealthService per-asset result with the
 * resolved provider target list so the operator sees, per Binance symbol,
 * whether it is a provider target, whether a fresh snapshot exists, and why it
 * is unavailable. No DB or network here so it is unit testable.
 */

export type MarketHealthAssetLike = {
  assetId: string;
  symbol: string;
  assetType: string;
  market: string;
  state: 'available' | 'unavailable';
  reason: string | null;
  sourceName: string | null;
  snapshotId: string | null;
  capturedAt: string | null;
  freshnessAgeSeconds: number | null;
};

export type BinanceReadinessRow = {
  symbol: string;
  assetId: string;
  targetIncluded: boolean;
  snapshotPresent: boolean;
  sourceName: string | null;
  capturedAt: string | null;
  freshnessAgeSeconds: number | null;
  state: 'available' | 'unavailable';
  reason: string | null;
};

export type BinanceReadiness = {
  rows: BinanceReadinessRow[];
  total: number;
  available: number;
  ready: boolean;
};

export function buildBinanceReadiness(input: {
  assets: readonly MarketHealthAssetLike[];
  binanceTargetSymbols: readonly string[];
  toProviderSymbol: (symbol: string) => string | null;
}): BinanceReadiness {
  const targetSet = new Set(
    input.binanceTargetSymbols.map((symbol) => symbol.trim().toUpperCase()),
  );

  const rows: BinanceReadinessRow[] = input.assets
    .filter(
      (asset) =>
        asset.assetType === 'crypto' &&
        asset.market.trim().toUpperCase() === 'BINANCE',
    )
    .map((asset) => {
      const providerSymbol =
        input.toProviderSymbol(asset.symbol.trim().toUpperCase()) ??
        asset.symbol.trim().toUpperCase();
      return {
        symbol: asset.symbol,
        assetId: asset.assetId,
        targetIncluded: targetSet.has(providerSymbol),
        snapshotPresent: asset.snapshotId !== null,
        sourceName: asset.sourceName,
        capturedAt: asset.capturedAt,
        freshnessAgeSeconds: asset.freshnessAgeSeconds,
        state: asset.state,
        reason: asset.reason,
      };
    });

  const available = rows.filter((row) => row.state === 'available').length;
  return {
    rows,
    total: rows.length,
    available,
    ready: rows.length > 0 && available === rows.length,
  };
}

export function formatBinanceReadinessLines(
  readiness: BinanceReadiness,
): string[] {
  const lines = [
    `  Binance snapshots available: ${readiness.available}/${readiness.total}`,
  ];
  for (const row of readiness.rows) {
    const detail =
      row.state === 'available'
        ? `${row.sourceName ?? 'unknown'} age=${row.freshnessAgeSeconds ?? '?'}s`
        : (row.reason ?? 'ASSET_PRICE_UNAVAILABLE');
    lines.push(
      `    ${row.state === 'available' ? 'OK ' : 'x  '}${row.symbol} ` +
        `target=${row.targetIncluded ? 'yes' : 'no'} snapshot=${
          row.snapshotPresent ? 'yes' : 'no'
        } ${detail}`,
    );
  }
  return lines;
}
