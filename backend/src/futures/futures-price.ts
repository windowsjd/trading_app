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
      'Synthetic reference asset has no eligible execution source.',
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
    'Fresh canonical synthetic execution price evidence is required.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
