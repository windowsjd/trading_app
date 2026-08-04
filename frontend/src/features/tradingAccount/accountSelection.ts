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
 *   1. a stored choice that is STILL OWNED wins — switching accounts is an
 *      explicit user act, and an app restart is not one;
 *   2. otherwise the season the user is actually competing in, because that is
 *      the only account with a live leaderboard position;
 *   3. otherwise their general account;
 *   4. otherwise the most recently opened readable account, so a user whose
 *      seasons have all settled still lands on their own history instead of an
 *      empty screen;
 *   5. otherwise nothing — an explicit empty state, never a fabricated account.
 *
 * A stored id that is no longer owned is DROPPED rather than kept and retried:
 * it means the account was closed out of the list, the token now belongs to a
 * different user, or the id was never valid. Any of those must fall back, and
 * none of them should produce repeated 404s against another user's account.
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
 * "Most recently opened" (rule 4) still reaches those accounts — they are
 * readable history, just not the natural landing place.
 */
function isParticipatingSeasonAccount(account: SelectableAccount) {
  return (
    account.mode === 'season' &&
    isActive(account) &&
    !!account.season &&
    account.season.seasonStatus === 'active' &&
    SEASON_PARTICIPATING_STATUSES.has(account.season.participantStatus)
  );
}

export function selectTradingAccountId(
  accounts: readonly SelectableAccount[],
  storedAccountId: string | null | undefined,
): AccountSelectionResult {
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

/** The order accounts are OFFERED in, which is not the selection order. */
export function sortAccountsForDisplay(
  accounts: readonly SelectableAccount[],
): SelectableAccount[] {
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
