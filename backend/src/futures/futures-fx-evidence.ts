import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import type { Prisma } from '../generated/prisma/client';
import { findUsdKrwRatesAtOrBefore } from '../providers/fx-rate-snapshot-query';
import { futuresError } from './futures-error';

/**
 * The USD/KRW evidence a Season Futures execution pins
 * (docs/season-final-ranking-eligibility.md §3).
 *
 * Only a season WITH a final-ranking eligibility rule converts Futures
 * executions to KRW (recognized turnover = notional ÷ leverage). The rate is
 * selected here, inside the execution transaction, by the same settlement FX
 * rule the turnover has always used (provider priority, then approved manual;
 * effective and captured at or before the execution) and stored on the
 * execution row. Looking it up again at settlement is not reproducible: a rate
 * committed later — an ingestion row stamped before the execution, a backdated
 * insert — re-prices the execution, and an execution committed while no rate
 * existed blocks the whole season's final settlement.
 *
 * So in a rule season an execution without evidence is refused before any
 * write; the caller's transaction rolls back with nothing changed. General and
 * beginner accounts and seasons without a rule return null: no lookup and no
 * new way to fail.
 */
export async function pinFuturesExecutionFxEvidence(
  tx: Prisma.TransactionClient,
  input: {
    seasonId: string | null;
    tradingAccountId: string;
    executedAt: Date;
  },
): Promise<string | null> {
  if (!input.seasonId) {
    return null;
  }

  // The season row is already held FOR SHARE by the trading lock, and the
  // rule is frozen once the season has left `upcoming` (DB trigger).
  const season = await tx.season.findUniqueOrThrow({
    where: { id: input.seasonId },
    select: {
      finalRankingMinTradedInstruments: true,
      finalRankingMinTurnoverRatio: true,
    },
  });
  if (
    season.finalRankingMinTradedInstruments === null &&
    season.finalRankingMinTurnoverRatio === null
  ) {
    return null;
  }

  const instant = input.executedAt.toISOString();
  const evidence = (await findUsdKrwRatesAtOrBefore(tx, [instant])).get(
    instant,
  );
  if (evidence) {
    return evidence.snapshotId;
  }

  setAdminDiagnosticContext({
    failureStage: 'futures_fx_evidence_selection',
    entities: {
      seasonId: input.seasonId,
      tradingAccountId: input.tradingAccountId,
    },
    evidence: {
      evaluationAt: instant,
      rule: 'settlement_fx_rule_effective_and_captured_at_or_before_execution',
      checkState: 'no_usd_krw_evidence',
    },
    nextInvestigation: [
      'backend/docs/season-final-ranking-eligibility.md',
      'backend/src/providers/fx-rate-snapshot-query.ts',
    ],
  });
  futuresError(
    'FUTURES_FX_EVIDENCE_UNAVAILABLE',
    'USD/KRW evidence for this Season execution is unavailable. Please try again later.',
  );
}
