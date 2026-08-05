import { classifyAccountError } from './integrityErrors.ts';

/**
 * One gate for the SECONDARY account-scoped queries (작업 12 §3).
 *
 * `getIntegrityErrorMessage` was already applied to each screen's primary query
 * — the portfolio overview — so a structural fault there produced a plain
 * fail-closed screen. Every other account-scoped query on the same screens
 * (wallets, positions, equity, ranking, orders) fell through to a generic
 * section notice instead:
 *
 *     walletsQuery.isError   → "지갑 요약을 불러오지 못했습니다."
 *     positionsQuery.isError → "보유 종목을 불러오지 못했습니다."
 *     rankingQuery.isError   → 순위 "-"
 *
 * Those read as a transient hiccup. But `TRADING_ACCOUNT_SCOPE_MISMATCH` on the
 * wallet query does not mean the wallet is briefly unreachable — it means the
 * server found the stored wallet attached to the wrong account and refused to
 * answer. Rendering that as a grey box next to a confident 총 자산 figure tells
 * the user the rest of the screen is fine when the server has just said it
 * cannot vouch for it.
 *
 * So: if ANY of a screen's account-scoped queries failed structurally, the
 * whole screen fails closed. A transient network error on the same query keeps
 * its existing section-level notice — that distinction is the entire point, and
 * it is `classifyAccountError` (already the single source of truth for which
 * codes are damage) that draws it.
 *
 * This is a helper, not a framework: a pure function over the query states a
 * screen already has, no new global state, no error boundary, no store.
 */

/** One account-scoped query, as the screen already knows it. */
export type AccountScopedQuerySignal = {
  /** Korean section name, used only in the fail-closed copy. */
  section: string;
  isError: boolean;
  error?: unknown;
  /** Refetches THIS query. Only the failed ones are retried. */
  retry?: () => void;
};

export type AccountIntegrityFailure = {
  /** Every section that failed structurally, in the order given. */
  sections: string[];
  message: string;
  /** Refetches exactly the queries that failed — not the whole screen. */
  retry: () => void;
};

export const ACCOUNT_INTEGRITY_TITLE =
  '데이터를 안전하게 표시할 수 없습니다.';

/**
 * The fail-closed copy. Names the sections so the user can say what they saw,
 * and says plainly that this is not an empty account.
 */
export function getAccountIntegrityMessage(sections: readonly string[]): string {
  const label = sections.length > 0 ? sections.join(', ') : '계정';

  return (
    `${label} 데이터에 문제가 발견되어 안전하게 조회를 중단했습니다. ` +
    '잔액이나 보유 내역이 0이라는 뜻이 아닙니다. ' +
    '잠시 후 다시 시도하고, 계속되면 고객센터에 문의해주세요.'
  );
}

/**
 * Returns the fail-closed state when any signal failed structurally, else null.
 *
 * Null means "nothing structural here" — the screen keeps whatever partial or
 * empty UI it already had, which is correct for a timeout, an offline device,
 * or a section the backend reported as temporarily unavailable.
 */
export function findAccountIntegrityFailure(
  signals: readonly AccountScopedQuerySignal[],
): AccountIntegrityFailure | null {
  const failed = signals.filter(
    (signal) => signal.isError && classifyAccountError(signal.error) === 'integrity',
  );

  if (failed.length === 0) return null;

  const sections: string[] = [];
  for (const signal of failed) {
    if (!sections.includes(signal.section)) sections.push(signal.section);
  }

  return {
    sections,
    message: getAccountIntegrityMessage(sections),
    retry: () => {
      for (const signal of failed) {
        signal.retry?.();
      }
    },
  };
}
