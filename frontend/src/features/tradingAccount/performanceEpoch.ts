import { formatKstDateTime } from '../../utils/format.ts';
import type { TradingAccountPortfolioSummaryDto } from './api';

/**
 * Wording of the CURRENT performance epoch of a general account (2026-10-20).
 *
 * After a general-account reset the principal restarts at the reset target:
 * the opening funding of the epoch is that target, not the account's one-time
 * opening grant (which stays in the ledger, untouched). Labels follow the
 * server's `performanceEpoch`; an older server without it reads as epoch 0.
 */
export function isResetEpoch(
  summary: Pick<TradingAccountPortfolioSummaryDto, 'performanceEpoch'>,
): boolean {
  return (summary.performanceEpoch?.sequence ?? 0) > 0;
}

/** "최초 지급금" for the opening epoch, "초기화 기준 자금" after a reset. */
export function openingFundingLabel(
  summary: Pick<TradingAccountPortfolioSummaryDto, 'performanceEpoch'>,
): string {
  return isResetEpoch(summary) ? '초기화 기준 자금' : '최초 지급금';
}

/** Where the shown performance starts, after a reset; null otherwise. */
export function resetEpochNote(
  summary: Pick<TradingAccountPortfolioSummaryDto, 'performanceEpoch'>,
): string | null {
  if (!isResetEpoch(summary)) return null;
  const at = formatKstDateTime(summary.performanceEpoch?.startedAt);
  return at === '-'
    ? '일반계정을 초기화한 뒤의 성과입니다.'
    : `${at} 일반계정 초기화 이후의 성과입니다.`;
}
