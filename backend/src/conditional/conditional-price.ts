import { type Asset, Prisma } from '../generated/prisma/client';
import { readFuturesPrice } from '../futures/futures-price';
import { findMarketAwareAssetPriceCandidates } from '../providers/asset-price-snapshot-query';
import {
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import { assertOrderSessionAllowed } from '../orders/market-hours.policy';

/** Only durable execution-policy evidence; no provider calls or Mark fallback. */
export async function conditionalPrice(
  tx: Pick<Prisma.TransactionClient, 'assetPriceSnapshot'>,
  asset: Asset,
  domain: 'spot' | 'futures',
  now: Date,
) {
  if (!asset.isActive) return null;
  if (domain === 'futures') return readFuturesPrice(tx, asset, now, false);
  try {
    assertOrderSessionAllowed(asset, now, 'market');
  } catch {
    return null;
  }
  const eligibility = resolveAssetProviderEligibility({
    workflow: 'orders_execute',
    asset,
  });
  if (!eligibility.eligible) return null;
  const candidates = await findMarketAwareAssetPriceCandidates(tx, {
    asset,
    workflow: 'orders_execute',
    now,
    sourceNames: eligibility.sourceNames,
  });
  const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
    asset,
    workflow: 'orders_execute',
    candidates,
    expectedSourceNames: eligibility.sourceNames,
    now,
    freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
    isPositiveValue: (row) =>
      row.assetId === asset.id &&
      row.currencyCode === asset.priceCurrency &&
      row.price.isFinite() &&
      row.price.gt(0),
  });
  return selection.state === 'selected' ? selection.snapshot : null;
}
