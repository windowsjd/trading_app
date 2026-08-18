import { getApiErrorInfo } from '../../services/api/errorMapper.ts';
import { isTradingAccountScopeMismatchError } from './accountScope.ts';

/**
 * Structural integrity errors are NOT empty data (작업 9 §B-9).
 *
 * Each code below means the server found its own stored data inconsistent and
 * refused to answer rather than answer wrongly. Rendering any of them as "아직
 * 데이터가 없습니다" would undo the entire point of the backend failing closed:
 * the user sees a calm empty portfolio, nobody reports anything, and a real
 * accounting fault stays invisible for as long as it takes someone to notice
 * their money is missing.
 *
 * So they get their own state — a plainly worded error the user can retry or
 * report — and they are kept distinct from the two situations that legitimately
 * look like absence:
 *
 *   - a temporary price/FX gap, which the backend already reports inside a
 *     SUCCESS envelope via `sectionErrors` and which stays a section-level
 *     notice, and
 *   - a genuinely empty account, which returns 200 with no rows.
 *
 * `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED` is deliberately NOT in this set. It is
 * an expected capability limit with a known answer ("준비 중"), and folding it
 * in with data corruption would tell a user to contact support about a feature
 * that simply does not exist yet.
 */

export const TRADING_ACCOUNT_INTEGRITY_CODES = [
  'TRADING_ACCOUNT_INTEGRITY',
  'TRADING_ACCOUNT_SCOPE_MISMATCH',
  'TRADING_SCOPE_REPAIR_REQUIRED',
  'FINANCIAL_SCOPE_REPAIR_REQUIRED',
  'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
  'TRADING_ACCOUNT_LINK_INTEGRITY',
  'GENERAL_ACCOUNT_INTEGRITY',
  'GENERAL_PERFORMANCE_NOT_INITIALIZED',
  'GENERAL_PERFORMANCE_INTEGRITY',
  'GENERAL_PERFORMANCE_DISCONTINUITY',
  'SEASON_RANKING_SCOPE_REPAIR_REQUIRED',
  'SEASON_RANKING_SCOPE_MISMATCH',
  'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
  'SEASON_RANKING_SOURCE_SCOPE_MISMATCH',
  // Snapshot-scope damage found during settlement. Today these are raised by
  // the settlement job rather than by a request handler, so a screen is
  // unlikely to see one — but they carry exactly the meaning this set is for,
  // and listing them means the day one does surface through an endpoint it
  // fails closed instead of arriving as an unrecognised 500 (작업 12 §3).
  'SETTLEMENT_ACCOUNT_LINK_INTEGRITY',
  'SETTLEMENT_SNAPSHOT_SCOPE_MISMATCH',
  'SETTLEMENT_SNAPSHOT_SCOPE_REPAIR_REQUIRED',
  'FINAL_RESULTS_INTEGRITY',
  // Settlement wrote a tier that disagrees with the final ranking: the two
  // published numbers contradict each other, which is damage, not absence.
  'FINAL_TIER_ASSIGNMENT_CONFLICT',
  'AD_REWARD_CLAIM_INTEGRITY',
] as const;

export type TradingAccountIntegrityCode =
  (typeof TRADING_ACCOUNT_INTEGRITY_CODES)[number];

const INTEGRITY_CODE_SET = new Set<string>(TRADING_ACCOUNT_INTEGRITY_CODES);

export const CAPABILITY_LIMIT_CODES = [
  'GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED',
] as const;

const CAPABILITY_LIMIT_CODE_SET = new Set<string>(CAPABILITY_LIMIT_CODES);

export type AccountErrorKind =
  | 'unauthorized'
  | 'account_not_found'
  | 'integrity'
  | 'capability_limit'
  | 'account_not_active'
  | 'other';

export function isTradingAccountIntegrityCode(
  code?: string | null,
): code is TradingAccountIntegrityCode {
  return typeof code === 'string' && INTEGRITY_CODE_SET.has(code);
}

export function isCapabilityLimitCode(code?: string | null) {
  return typeof code === 'string' && CAPABILITY_LIMIT_CODE_SET.has(code);
}

/**
 * Classifies a failed account-scoped request.
 *
 * `TRADING_ACCOUNT_NOT_FOUND` covers both "no such account" and "someone
 * else's account" by deliberate backend design — the API must not confirm that
 * another user's account exists. The frontend therefore treats it purely as
 * "the selected account is not (or no longer) mine", refreshes the owned list,
 * and falls back. It never probes to find out which of the two it was.
 */
export function classifyAccountError(error: unknown): AccountErrorKind {
  // A response that named a DIFFERENT account is detected client-side, so it
  // never carries a server error envelope. It is still exactly the same kind of
  // fault as the server-detected scope codes below and gets the same
  // fail-closed treatment — not a generic "잠시 후 다시 시도" (작업 10 §A-10).
  if (isTradingAccountScopeMismatchError(error)) return 'integrity';

  const info = getApiErrorInfo(error);

  if (info.status === 401) return 'unauthorized';
  if (isTradingAccountIntegrityCode(info.serverCode)) return 'integrity';
  if (isCapabilityLimitCode(info.serverCode)) return 'capability_limit';
  if (info.serverCode === 'TRADING_ACCOUNT_NOT_FOUND') {
    return 'account_not_found';
  }
  if (info.status === 404) return 'account_not_found';
  if (info.serverCode === 'TRADING_ACCOUNT_NOT_ACTIVE') {
    return 'account_not_active';
  }

  return 'other';
}

export function isMissingSelectedAccountError(error: unknown) {
  return classifyAccountError(error) === 'account_not_found';
}

const INTEGRITY_MESSAGE =
  '계정 데이터에 문제가 발견되어 안전하게 조회를 중단했습니다. 잠시 후 다시 시도하고, 계속되면 고객센터에 문의해주세요.';

/**
 * The message an integrity failure gets. Never "데이터가 없습니다" and never
 * "준비 중" — this is damage, and the copy says a person should look at it.
 */
export function getIntegrityErrorMessage(error: unknown): string | null {
  if (classifyAccountError(error) !== 'integrity') {
    return null;
  }

  return INTEGRITY_MESSAGE;
}
