import { HttpStatus } from '@nestjs/common';
import { Prisma, type Asset } from '../generated/prisma/client';
import { findMarketAwareAssetPriceCandidates } from '../providers/asset-price-snapshot-query';
import {
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import { buildSelectionFailureEvidence } from '../providers/source-selection-diagnostics';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { futuresError } from './futures-error';

/** Historical normal exit: query the boundary first, so post-end ingestion
 * cannot hide an eligible earlier trade. No REST call or historical fabrication. */
export async function readFuturesFinalPrice(
  client: Pick<Prisma.TransactionClient, 'assetPriceSnapshot'>,
  asset: Asset,
  endAt: Date,
) {
  setAdminDiagnosticContext({
    failureStage: 'futures_final_spot_price_selection',
    entities: { assetId: asset.id },
    evidence: { evaluationState: 'end_boundary_selection', endAt },
  });
  const eligibility = resolveAssetProviderEligibility({
    workflow: 'orders_execute',
    asset,
  });
  if (!eligibility.eligible)
    futuresError(
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'Final Futures settlement price is unavailable.',
    );
  const candidates = await Promise.all(
    eligibility.sourceNames.map((sourceName) =>
      client.assetPriceSnapshot.findFirst({
        where: {
          assetId: asset.id,
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName,
          effectiveAt: { gte: new Date(+endAt - 10000), lte: endAt },
          capturedAt: { gte: new Date(+endAt - 10000), lte: endAt },
          price: { gt: 0 },
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { id: 'desc' },
        ],
      }),
    ),
  );
  const selected = candidates.find(
    (row) => row && validFuturesFinalPrice(row, asset, endAt),
  );
  if (!selected)
    futuresError(
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'A fresh final execution price at Season end is required.',
    );
  return selected;
}

export function validFuturesFinalPrice(
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

/** DB-only canonical Spot evidence; synthetic execution/reference price, never Mark Price. */
export async function readFuturesPrice(
  client: Pick<Prisma.TransactionClient, 'assetPriceSnapshot'>,
  asset: Asset,
  now: Date,
  required = true,
) {
  // Reuse Crypto market execution policy unchanged. F1 adds no provider workflow/ingestion.
  const workflow = 'orders_execute' as const;
  const eligibility = resolveAssetProviderEligibility({ workflow, asset });
  if (!eligibility.eligible) {
    if (!required) return null;
    futuresError(
      'FUTURES_EXECUTION_SOURCE_INELIGIBLE',
      'The current execution price is unavailable. Please try again.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  const candidates = await findMarketAwareAssetPriceCandidates(client, {
    asset,
    workflow,
    now,
    sourceNames: eligibility.sourceNames,
  });
  const validIdentity = (row: (typeof candidates)[number]) =>
    row.assetId === asset.id &&
    row.currencyCode === 'USD' &&
    row.price.isFinite() &&
    row.price.gt(0);
  const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
    asset,
    workflow,
    candidates,
    expectedSourceNames: eligibility.sourceNames,
    now,
    freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
    isPositiveValue: validIdentity,
  });
  if (selection.state === 'selected') return selection.snapshot;
  if (!required) return null;
  setAdminDiagnosticContext({
    failureStage: 'futures_execution_price_selection',
    entities: { assetId: asset.id },
    evidence: buildSelectionFailureEvidence({
      workflow,
      evaluationAt: now,
      eligibility,
      candidates,
      selection,
      asset,
      isPositiveValue: validIdentity,
      manualFallback: {
        lookupPerformed: false,
        result: 'not_allowed',
        reason: 'provider_only_workflow',
      },
    }),
    nextInvestigation: [
      'backend/src/futures/futures-price.ts',
      'backend/src/providers/source-eligibility.policy.ts',
    ],
  });
  futuresError(
    selection.decision.rejectedProviderReason === 'captured_at_stale'
      ? 'FUTURES_PRICE_STALE'
      : 'FUTURES_PRICE_UNAVAILABLE',
    'The current execution price is unavailable. Please try again.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
