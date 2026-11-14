import type { TradingAccountDto } from './api';

/**
 * WHICH account is selected — the single source of truth's decision function
 * (작업 9 §B-2).
 *
 * Deliberately a pure function over the owned-account list. Selection is the
 * one piece of state that decides which account every financial query on the
 * screen is about, so it must be reproducible and testable without a React
 * tree, a navigator, or a network client.
 *
 * The ordering below is not arbitrary:
 *
 * Stored and fallback choices use only operational season accounts. Historical
 * season accounts stay owned and readable through the dedicated record route.
 * Standalone account selection and creation policy are unchanged.
 */

export type SelectableAccount = Pick<
  TradingAccountDto,
  'id' | 'mode' | 'status' | 'openedAt' | 'closedAt' | 'season'
>;

export type AccountSelectionReason =
  | 'stored'
  | 'active_season'
  | 'active_general'
  | 'most_recent'
  | 'none';

export type AccountSelectionResult = {
  accountId: string | null;
  reason: AccountSelectionReason;
};

const SEASON_PARTICIPATING_STATUSES = new Set([
  'registered',
  'active',
  'finished',
  'rewarded',
]);

function byMostRecentlyOpened(
  left: SelectableAccount,
  right: SelectableAccount,
) {
  const delta =
    new Date(right.openedAt).getTime() - new Date(left.openedAt).getTime();
  if (delta !== 0 && Number.isFinite(delta)) {
    return delta;
  }

  // Deterministic tie-break so two accounts opened in the same instant do not
  // reorder between renders and silently swap the user's screen.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isActive(account: SelectableAccount) {
  return account.status === 'active';
}

/**
 * The season the user is actually COMPETING IN right now (작업 10 §A-9).
 *
 * All five facts must hold together:
 *   - the account is a season account,
 *   - the account itself is active,
 *   - it has a season link at all,
 *   - THAT SEASON IS STILL RUNNING, and
 *   - the participant is genuinely participating (`excluded` is not).
 *
 * The season-status condition is the one that was missing. Season accounts are
 * closed by settlement, but an `ended` season sits between "trading stopped"
 * and "settled", and a settled season whose close-out failed leaves an active
 * account behind by definition of the failure. Preferring either over a live
 * general account lands the user on a frozen leaderboard position, with no
 * trading possible, while the account they can actually use sits one tap away.
 * Those accounts remain readable through the dedicated historical route.
 */
export function isParticipatingSeasonAccount(account: SelectableAccount) {
  return (
    account.mode === 'season' &&
    isActive(account) &&
    !!account.season &&
    account.season.seasonStatus === 'active' &&
    SEASON_PARTICIPATING_STATUSES.has(account.season.participantStatus)
  );
}

/** Operational choices only; historical accounts remain in the owned list for records. */
export function isSwitchableAccount(account: SelectableAccount) {
  return account.mode !== 'season' || isParticipatingSeasonAccount(account);
}

export function selectTradingAccountId(
  accounts: readonly SelectableAccount[],
  storedAccountId: string | null | undefined,
): AccountSelectionResult {
  accounts = accounts.filter(isSwitchableAccount);
  if (accounts.length === 0) {
    return { accountId: null, reason: 'none' };
  }

  if (storedAccountId && accounts.some((a) => a.id === storedAccountId)) {
    return { accountId: storedAccountId, reason: 'stored' };
  }

  const sorted = [...accounts].sort(byMostRecentlyOpened);

  const activeSeason = sorted.find(isParticipatingSeasonAccount);
  if (activeSeason) {
    return { accountId: activeSeason.id, reason: 'active_season' };
  }

  const activeGeneral = sorted.find(
    (account) => account.mode === 'general' && isActive(account),
  );
  if (activeGeneral) {
    return { accountId: activeGeneral.id, reason: 'active_general' };
  }

  return { accountId: sorted[0].id, reason: 'most_recent' };
}

/**
 * Whether this user has a general account AT ALL — any status. The server
 * keeps one general account per user for life, so "none in the list" is the
 * one and only state in which offering "일반 투자 시작하기" is honest; a
 * closed or suspended general account is still THE general account and must be
 * offered as itself, not as something to create again.
 */
export function hasGeneralAccount(
  accounts: readonly SelectableAccount[],
): boolean {
  return accounts.some((account) => account.mode === 'general');
}

/**
 * The owned account that belongs to ONE season — how a join flow finds the
 * account it just created without a fabricated id: the list is refetched and
 * the season named by the join answer is looked up in it.
 */
export function findAccountForSeason<A extends SelectableAccount>(
  accounts: readonly A[],
  seasonId: string,
): A | null {
  return (
    accounts.find((account) => account.season?.seasonId === seasonId) ?? null
  );
}

/** The order accounts are OFFERED in, which is not the selection order. */
export function sortAccountsForDisplay<A extends SelectableAccount>(
  accounts: readonly A[],
): A[] {
  const rank = (account: SelectableAccount) => {
    if (isParticipatingSeasonAccount(account)) return 0;
    if (account.mode === 'general' && isActive(account)) return 1;
    if (isActive(account)) return 2;
    if (account.status === 'suspended') return 3;
    return 4;
  };

  return [...accounts].sort(
    (left, right) => rank(left) - rank(right) || byMostRecentlyOpened(left, right),
  );
}
