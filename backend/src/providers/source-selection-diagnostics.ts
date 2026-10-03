import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import {
  CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  selectProviderSnapshotAtOrBeforeBySourcePriority,
  type ProviderAssetCandidate,
  type ProviderSnapshotCandidate,
  type ProviderSnapshotSelection,
  type ProviderWorkflow,
} from './source-eligibility.policy';

type Eligibility =
  | {
      eligible: true;
      sourceNames: readonly string[];
      freshnessThresholdSeconds: number;
    }
  | { eligible: false; reason: string };

type SnapshotMetadata = Pick<
  ProviderSnapshotCandidate,
  'id' | 'sourceName' | 'effectiveAt' | 'capturedAt'
>;

/** Only facts from the existing fallback read/guard; a filtered miss cannot
 * distinguish unapproved, future, non-positive, or absent rows. */
export function describeManualFallback(input: {
  snapshot: SnapshotMetadata | null;
  evaluationAt: Date;
  queryChecks: readonly string[];
  reason?: string;
  freshnessThresholdSeconds?: number;
  positiveValue?: boolean;
}) {
  return {
    lookupPerformed: true,
    eligibleQueryCandidateFound: Boolean(input.snapshot),
    queryChecks: input.queryChecks,
    unqueriedCandidates: 'not_observed',
    result: input.snapshot ? 'rejected' : 'missing',
    reason: input.reason ?? 'no_eligible_manual_candidate',
    ...(input.snapshot
      ? {
          snapshotId: input.snapshot.id,
          sourceName: input.snapshot.sourceName,
          effectiveAt: input.snapshot.effectiveAt,
          capturedAt: input.snapshot.capturedAt,
          positiveValue: input.positiveValue,
          freshnessBasis:
            input.freshnessThresholdSeconds === undefined
              ? null
              : 'effectiveAt',
          ageSeconds: Math.floor(
            (input.evaluationAt.getTime() -
              input.snapshot.effectiveAt.getTime()) /
              1000,
          ),
        }
      : {}),
    freshnessThresholdSeconds: input.freshnessThresholdSeconds ?? null,
  };
}

/** Pure, bounded metadata projection. Reuses the exact policy on each observed
 * source subset; never queries to explain a missing candidate or changes the
 * original selection. Keep this request-neutral until the caller's admin gate. */
export function buildSelectionFailureEvidence<
  T extends ProviderSnapshotCandidate,
>(input: {
  workflow: ProviderWorkflow | 'fx_current';
  evaluationAt: Date;
  eligibility: Eligibility;
  candidates: readonly T[];
  selection: ProviderSnapshotSelection<T> | null;
  isPositiveValue: (candidate: T) => boolean;
  asset?: Pick<ProviderAssetCandidate, 'assetType' | 'market'>;
  atOrBefore?: boolean;
  manualFallback?:
    | ReturnType<typeof describeManualFallback>
    | {
        lookupPerformed: false;
        result: 'not_evaluated' | 'not_allowed';
        reason?: string;
      };
}) {
  const { eligibility } = input;
  const sourceNames = eligibility.eligible ? eligibility.sourceNames : [];
  const marketState =
    input.asset && input.asset.assetType !== 'crypto' && !input.atOrBefore
      ? resolveStockMarketSessionState(input.asset, input.evaluationAt)
      : null;
  const select = (candidates: readonly T[]) => {
    const args = {
      candidates,
      expectedSourceNames: sourceNames,
      now: input.evaluationAt,
      freshnessThresholdSeconds: eligibility.eligible
        ? eligibility.freshnessThresholdSeconds
        : 0,
      isPositiveValue: input.isPositiveValue,
    };
    if (input.atOrBefore)
      return selectProviderSnapshotAtOrBeforeBySourcePriority({
        ...args,
        valuationAt: input.evaluationAt,
      });
    if (input.asset && input.workflow !== 'fx_current')
      return selectMarketAwareAssetPriceSnapshotBySourcePriority({
        ...args,
        asset: input.asset,
        workflow: input.workflow,
      });
    return selectFreshProviderSnapshotBySourcePriority(args);
  };
  // Expected sources stay first/in priority order. Unexpected observed sources
  // remain visible (including a null source); no source is inferred from a miss.
  const observedSources = [
    ...new Set(input.candidates.map((candidate) => candidate.sourceName)),
  ];
  const sources = [
    ...sourceNames,
    ...observedSources.filter((name) => !sourceNames.includes(name ?? '')),
  ];
  const providerCandidates = sources.slice(0, 12).map((sourceName) => {
    const candidates = input.candidates.filter(
      (candidate) => candidate.sourceName === sourceName,
    );
    const candidate = candidates[0];
    if (!candidate)
      return {
        sourceName,
        candidateFound: false,
        observedCandidateCount: 0,
        result: 'missing',
        reason: 'provider_missing',
      };
    const selection = select(candidates);
    const first = select([candidate]);
    return {
      sourceName,
      candidateFound: true,
      observedCandidateCount: candidates.length,
      result: selection.state,
      reason: selection.decision.rejectedProviderReason,
      snapshotId: candidate.id,
      sourceType: candidate.sourceType,
      effectiveAt: candidate.effectiveAt,
      capturedAt: candidate.capturedAt,
      ageSeconds: Math.floor(
        (input.evaluationAt.getTime() - candidate.capturedAt.getTime()) / 1000,
      ),
      positiveValue: input.isPositiveValue(candidate),
      representativeReason: first.decision.rejectedProviderReason,
      rejectedReasons: [
        ...new Set(
          candidates
            .map((row) => select([row]).decision.rejectedProviderReason)
            .filter(Boolean),
        ),
      ].slice(0, 12),
    };
  });
  return {
    workflow: input.workflow,
    evaluationAt: input.evaluationAt,
    freshnessThresholdSeconds:
      eligibility.eligible && !input.atOrBefore
        ? eligibility.freshnessThresholdSeconds
        : null,
    freshnessBasis:
      !eligibility.eligible || marketState?.state === 'calendar_unavailable'
        ? null
        : input.atOrBefore
          ? 'effectiveAt_cutoff'
          : marketState?.state === 'closed'
            ? input.workflow !== 'fx_current' &&
              CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS.has(input.workflow)
              ? 'last_completed_session'
              : null
            : 'capturedAt',
    expectedSourceNames: sourceNames,
    eligibilityReason: eligibility.eligible ? null : eligibility.reason,
    observationScope: 'already_read_candidates',
    observedCandidateCount: input.candidates.length,
    omittedSourceCount: Math.max(0, sources.length - providerCandidates.length),
    providerDecision: input.selection?.decision ?? null,
    providerCandidates,
    marketSession: marketState,
    manualFallback: input.manualFallback,
    finalSelectionResult: 'NO_ELIGIBLE_SNAPSHOT',
  };
}
