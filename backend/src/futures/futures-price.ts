import { Prisma, type Asset } from '../generated/prisma/client';
import {
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';

/** Season pins committed with canonical Spot evidence BEFORE Futures Last
 * pricing stay authoritative: a retry re-verifies and reuses them unchanged.
 * New Futures execution, trigger and final evidence is never Spot; see
 * futures-last-price.ts. */
export function validLegacySpotFinalPrice(
  row: Prisma.AssetPriceSnapshotGetPayload<object>,
  asset: Asset,
  endAt: Date,
) {
  const eligibility = resolveAssetProviderEligibility({
    workflow: 'orders_execute',
    asset,
  });
  if (
    !eligibility.eligible ||
    row.assetId !== asset.id ||
    row.currencyCode !== 'USD' ||
    row.sourceType !== 'provider_api' ||
    !row.price.isFinite() ||
    row.price.lte(0) ||
    row.effectiveAt > row.capturedAt ||
    [row.effectiveAt, row.capturedAt].some(
      (t) => t > endAt || +endAt - +t > 10000,
    )
  )
    return false;
  return (
    selectMarketAwareAssetPriceSnapshotBySourcePriority({
      asset,
      workflow: 'orders_execute',
      candidates: [row],
      expectedSourceNames: eligibility.sourceNames,
      now: endAt,
      freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
      isPositiveValue: (p) => p.price.gt(0),
    }).state === 'selected'
  );
}
