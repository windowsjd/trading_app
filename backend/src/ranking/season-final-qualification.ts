import { HttpStatus } from '@nestjs/common';
import { CurrencyCode, OrderStatus, Prisma } from '../generated/prisma/client';
import { createApiError } from '../common/api-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { monetaryScale, roundDecimalHalfUp } from '../fx/fx-decimal-policy';
import { findUsdKrwRatesAtOrBefore } from '../providers/fx-rate-snapshot-query';
import {
  rankingSourceScopeErrorCodes,
  throwRankingSourceScope,
} from './ranking-source-scope';

/**
 * Season final-ranking eligibility (docs/season-final-ranking-eligibility.md).
 *
 * A season MAY carry a rule: at least N distinct traded instruments AND a
 * recognized turnover of at least `Season.initialCapitalKrw × ratio`. It only
 * decides who enters the FINAL ranking. Provisional (daily) ranking, returns,
 * tie-breaks and every financial process are untouched by it.
 *
 * Recognized turnover is measured from the authoritative fills of the season
 * account inside [startAt, endAt):
 *   - Spot: every executed order's actual executed `grossAmount` (buy and sell,
 *     any order kind; partial fills count what filled). Fees, quotes,
 *     reservations, canceled/unfilled orders and FX exchanges are not fills.
 *   - Futures: every user execution's `notional ÷ leverage` (open, increase,
 *     reduce, close; long and short; isolated and cross). Risk liquidations
 *     and the Season final exit are not `futures_executions` rows at all.
 *   - USD to KRW: Spot uses the order's own execution-time FX snapshot; a
 *     Futures execution, which pins no FX, uses the settlement FX rule at its
 *     execution instant (`findUsdKrwRatesAtOrBefore`). Missing or contradictory
 *     evidence is an integrity error, never "not qualified" and never a guess.
 *
 * Distinct instruments: one per Spot `assetId` and one per Futures
 * `instrumentId`, so BTC Spot and BTC Futures are two.
 */

export const finalQualificationErrorCodes = {
  FX_EVIDENCE_MISSING: 'RANKING_QUALIFICATION_FX_EVIDENCE_MISSING',
  FX_EVIDENCE_MISMATCH: 'RANKING_QUALIFICATION_FX_EVIDENCE_MISMATCH',
  EXECUTION_EVIDENCE_INVALID:
    'RANKING_QUALIFICATION_EXECUTION_EVIDENCE_INVALID',
  CRITERIA_INVALID: 'RANKING_QUALIFICATION_CRITERIA_INVALID',
} as const;

export type SeasonFinalQualificationCriteria = {
  minTradedInstrumentCount: number;
  minTurnoverRatio: Prisma.Decimal;
  /** Season.initialCapitalKrw × ratio, exact (not rounded). */
  minRecognizedTurnoverKrw: Prisma.Decimal;
};

export type SeasonFinalQualificationCriteriaSource = {
  initialCapitalKrw: Prisma.Decimal | string;
  finalRankingMinTradedInstruments?: number | null;
  finalRankingMinTurnoverRatio?: Prisma.Decimal | string | null;
};

export type SeasonTradingActivity = {
  tradedInstrumentCount: number;
  /** Raw Decimal sum rounded half-up to 8 places: the stored, shown value. */
  recognizedTurnoverKrw: Prisma.Decimal;
};

export type FinalQualificationEvaluation = SeasonTradingActivity & {
  tradedInstrumentRequirementMet: boolean;
  turnoverRequirementMet: boolean;
  qualified: boolean;
};

type ActivityReadClient = Pick<
  Prisma.TransactionClient,
  'order' | 'futuresExecution' | '$queryRaw'
>;

/** Accounts per read; bounds the rows held in memory during settlement. */
const ACCOUNT_BATCH_SIZE = 50;

/** NULL/NULL is "no rule". A half-set or non-positive rule is damage. */
export function resolveSeasonFinalQualificationCriteria(
  season: SeasonFinalQualificationCriteriaSource,
): SeasonFinalQualificationCriteria | null {
  const minCount = season.finalRankingMinTradedInstruments ?? null;
  const ratio =
    season.finalRankingMinTurnoverRatio === null ||
    season.finalRankingMinTurnoverRatio === undefined
      ? null
      : new Prisma.Decimal(season.finalRankingMinTurnoverRatio);

  if (minCount === null && ratio === null) {
    return null;
  }

  if (
    minCount === null ||
    ratio === null ||
    !Number.isSafeInteger(minCount) ||
    minCount < 1 ||
    !ratio.gt(0)
  ) {
    throw createApiError(
      finalQualificationErrorCodes.CRITERIA_INVALID,
      'Season final ranking eligibility criteria are invalid.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  return {
    minTradedInstrumentCount: minCount,
    minTurnoverRatio: ratio,
    minRecognizedTurnoverKrw: new Prisma.Decimal(season.initialCapitalKrw).mul(
      ratio,
    ),
  };
}

/**
 * Both conditions, inclusive: exactly the threshold qualifies. The comparison
 * uses the 8-place turnover a user is shown, so the shown value and the
 * decision can never disagree.
 */
export function evaluateFinalQualification(
  criteria: SeasonFinalQualificationCriteria,
  activity: SeasonTradingActivity,
): FinalQualificationEvaluation {
  const tradedInstrumentRequirementMet =
    activity.tradedInstrumentCount >= criteria.minTradedInstrumentCount;
  const turnoverRequirementMet = activity.recognizedTurnoverKrw.gte(
    criteria.minRecognizedTurnoverKrw,
  );

  return {
    ...activity,
    tradedInstrumentRequirementMet,
    turnoverRequirementMet,
    qualified: tradedInstrumentRequirementMet && turnoverRequirementMet,
  };
}

/**
 * The threshold on the 8-place money grid, rounded UP: for an 8-place
 * turnover T, `T >= exact` and `T >= ceil8(exact)` are the same test.
 */
export function minRecognizedTurnoverKrwAtMoneyScale(
  criteria: SeasonFinalQualificationCriteria,
): Prisma.Decimal {
  return criteria.minRecognizedTurnoverKrw.toDecimalPlaces(
    monetaryScale,
    Prisma.Decimal.ROUND_UP,
  );
}

export function remainingRecognizedTurnoverKrw(
  criteria: SeasonFinalQualificationCriteria,
  activity: SeasonTradingActivity,
): Prisma.Decimal {
  const remaining = minRecognizedTurnoverKrwAtMoneyScale(criteria).sub(
    activity.recognizedTurnoverKrw,
  );
  return remaining.gt(0) ? remaining : new Prisma.Decimal(0);
}

/**
 * Trading activity of each given season account inside the season window.
 *
 * The caller passes accounts it has already verified as this season's
 * participant accounts; the reads also filter through the account's own
 * participant relation, so another season's or another account's fills can
 * never be counted. Every given account is present in the result.
 */
export async function readSeasonTradingActivity(
  client: ActivityReadClient,
  input: {
    season: { id: string; startAt: Date; endAt: Date };
    tradingAccountIds: readonly string[];
  },
): Promise<Map<string, SeasonTradingActivity>> {
  const result = new Map<string, SeasonTradingActivity>();
  const accountIds = [...new Set(input.tradingAccountIds)];

  for (
    let offset = 0;
    offset < accountIds.length;
    offset += ACCOUNT_BATCH_SIZE
  ) {
    const batch = accountIds.slice(offset, offset + ACCOUNT_BATCH_SIZE);
    const activity = await readBatchActivity(client, input.season, batch);
    for (const [accountId, value] of activity) {
      result.set(accountId, value);
    }
  }

  return result;
}

async function readBatchActivity(
  client: ActivityReadClient,
  season: { id: string; startAt: Date; endAt: Date },
  accountIds: readonly string[],
): Promise<Map<string, SeasonTradingActivity>> {
  const accountScope = {
    tradingAccountId: { in: [...accountIds] },
    tradingAccount: { seasonParticipant: { seasonId: season.id } },
  };
  const window = { gte: season.startAt, lt: season.endAt };
  const [orders, undatedFillCount, executions] = await Promise.all([
    client.order.findMany({
      where: {
        ...accountScope,
        status: OrderStatus.executed,
        executedAt: window,
      },
      orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        assetId: true,
        currencyCode: true,
        grossAmount: true,
        fxRateSnapshot: {
          select: {
            id: true,
            baseCurrency: true,
            quoteCurrency: true,
            rate: true,
          },
        },
      },
    }),
    // An executed fill without a time cannot be placed inside or outside the
    // window; skipping it would silently under-count.
    client.order.count({
      where: {
        ...accountScope,
        status: OrderStatus.executed,
        executedAt: null,
      },
    }),
    client.futuresExecution.findMany({
      where: { ...accountScope, executedAt: window },
      orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        instrumentId: true,
        notional: true,
        leverage: true,
        executedAt: true,
      },
    }),
  ]);

  if (undatedFillCount > 0) {
    failActivity(
      finalQualificationErrorCodes.EXECUTION_EVIDENCE_INVALID,
      'An executed season fill has no execution time.',
      { seasonId: season.id },
    );
  }

  const totals = new Map(
    accountIds.map((accountId) => [
      accountId,
      { instruments: new Set<string>(), turnover: new Prisma.Decimal(0) },
    ]),
  );
  const add = (accountId: string, instrument: string, krw: Prisma.Decimal) => {
    const total = totals.get(accountId);
    if (!total) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `A fill of account ${accountId} was read for another account set.`,
      );
    }
    total.instruments.add(instrument);
    total.turnover = total.turnover.add(krw);
  };

  for (const order of orders) {
    const entities = {
      seasonId: season.id,
      tradingAccountId: order.tradingAccountId,
      orderId: order.id,
    };
    if (order.grossAmount === null || !order.grossAmount.gt(0)) {
      failActivity(
        finalQualificationErrorCodes.EXECUTION_EVIDENCE_INVALID,
        'An executed season order has no positive executed amount.',
        entities,
      );
    }

    if (order.currencyCode === CurrencyCode.KRW) {
      add(order.tradingAccountId, `spot:${order.assetId}`, order.grossAmount);
      continue;
    }

    if (order.currencyCode !== CurrencyCode.USD) {
      failActivity(
        finalQualificationErrorCodes.EXECUTION_EVIDENCE_INVALID,
        'An executed season order has an unsupported currency.',
        entities,
      );
    }

    const fx = order.fxRateSnapshot;
    if (!fx) {
      failActivity(
        finalQualificationErrorCodes.FX_EVIDENCE_MISSING,
        'A USD season order has no execution-time USD/KRW evidence.',
        entities,
      );
    }
    if (
      fx.baseCurrency !== CurrencyCode.USD ||
      fx.quoteCurrency !== CurrencyCode.KRW ||
      !fx.rate.gt(0)
    ) {
      failActivity(
        finalQualificationErrorCodes.FX_EVIDENCE_MISMATCH,
        'A USD season order references FX evidence that is not a positive USD/KRW rate.',
        { ...entities, fxRateSnapshotId: fx.id },
      );
    }

    add(
      order.tradingAccountId,
      `spot:${order.assetId}`,
      order.grossAmount.mul(fx.rate),
    );
  }

  const rates =
    executions.length > 0
      ? await findUsdKrwRatesAtOrBefore(client, [
          ...new Set(
            executions.map((execution) => execution.executedAt.toISOString()),
          ),
        ])
      : new Map<string, { snapshotId: string; rate: Prisma.Decimal }>();

  for (const execution of executions) {
    const entities = {
      seasonId: season.id,
      tradingAccountId: execution.tradingAccountId,
      futuresExecutionId: execution.id,
    };
    if (
      !execution.notional.gt(0) ||
      !Number.isSafeInteger(execution.leverage) ||
      execution.leverage < 1
    ) {
      failActivity(
        finalQualificationErrorCodes.EXECUTION_EVIDENCE_INVALID,
        'A season Futures execution has no positive notional or leverage.',
        entities,
      );
    }

    const fx = rates.get(execution.executedAt.toISOString());
    if (!fx) {
      failActivity(
        finalQualificationErrorCodes.FX_EVIDENCE_MISSING,
        'A season Futures execution has no USD/KRW evidence at or before its execution time.',
        entities,
      );
    }

    add(
      execution.tradingAccountId,
      `futures:${execution.instrumentId}`,
      execution.notional.div(execution.leverage).mul(fx.rate),
    );
  }

  return new Map(
    [...totals].map(([accountId, total]) => [
      accountId,
      {
        tradedInstrumentCount: total.instruments.size,
        recognizedTurnoverKrw: roundDecimalHalfUp(
          total.turnover,
          monetaryScale,
        ),
      },
    ]),
  );
}

function failActivity(
  code: string,
  message: string,
  entities: Record<string, unknown>,
): never {
  setAdminDiagnosticContext({
    domain: 'RANKING',
    operation: 'SEASON_FINAL_QUALIFICATION',
    failureStage: 'trading_activity_evidence',
    entities,
    nextInvestigation: ['backend/docs/season-final-ranking-eligibility.md'],
  });
  throw createApiError(code, message, HttpStatus.INTERNAL_SERVER_ERROR);
}
