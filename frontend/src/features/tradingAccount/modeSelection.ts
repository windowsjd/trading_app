// Runtime imports carry the .ts extension so this module — like entry.ts — is
// loadable by `node --test` (Node 24 type stripping) as well as by Metro.
import type { CurrentSeasonDto } from '../../models/dto/season';
import { getEffectiveSeasonMode } from '../season/mapper.ts';
import {
  hasGeneralAccount,
  isParticipatingSeasonAccount,
  sortAccountsForDisplay,
  type SelectableAccount,
} from './accountSelection.ts';

/**
 * What the mode-selection screen OFFERS (작업 13 §3) — a pure view-model over
 * the two facts the screen has: the owned-account list and the current season.
 *
 * The screen asks one question — "which investment account is this session
 * about?" — and this model enumerates the honest answers:
 *
 *   - 일반 투자 is ALWAYS an option. With a general account it means "use it";
 *     without one it means "start it", which is an explicit POST the user
 *     makes — never a side effect of rendering this screen.
 *   - 시즌 투자 offers the season accounts the user is actually COMPETING in
 *     (`seasonContinue`), joining the current season when that is genuinely
 *     open to them (`seasonJoin`), and — separately, never as a default —
 *     their finished/settled season accounts (`seasonPast`), so a user whose
 *     seasons have all ended can still reach their own history without being
 *     forced to open an account they did not ask for.
 *
 * `seasonJoin` requires all three: the season is effectively active, the
 * server says this user has not joined it, and the owned list has no account
 * for it. The last check matters when the season answer is staler than the
 * list — offering "참가하기" for a season the user already holds an account in
 * would send them into a flow whose only outcome is SEASON_ALREADY_JOINED.
 *
 * NOTHING here decides for the user. The model deliberately has no notion of
 * a default or recommended option: on a new login the choice between 일반 and
 * 시즌 belongs to the person, which is the whole reason this screen exists.
 */

export type ModeSelectionGeneralOption<A extends SelectableAccount> =
  | { kind: 'existing'; account: A }
  | { kind: 'start' };

export type ModeSelectionSeasonJoin =
  | { kind: 'available'; seasonId: string; seasonName: string }
  | { kind: 'none' };

export type ModeSelectionModel<A extends SelectableAccount> = {
  general: ModeSelectionGeneralOption<A>;
  /** Season accounts in a running season the user is participating in. */
  seasonContinue: A[];
  /** Every other owned season account: ended, settled, excluded, closed. */
  seasonPast: A[];
  seasonJoin: ModeSelectionSeasonJoin;
};

export function buildModeSelectionModel<A extends SelectableAccount>(
  accounts: readonly A[],
  currentSeason: CurrentSeasonDto | null | undefined,
  now = new Date(),
): ModeSelectionModel<A> {
  const sorted = sortAccountsForDisplay(accounts);

  // "First in display order" so that if several general accounts ever existed
  // (the server allows one), the active one is offered rather than a closed one.
  const generalAccount = sorted.find((account) => account.mode === 'general');

  const seasonContinue = sorted.filter(isParticipatingSeasonAccount);
  const seasonPast = sorted.filter(
    (account) =>
      account.mode === 'season' && !isParticipatingSeasonAccount(account),
  );

  const joinable =
    !!currentSeason &&
    getEffectiveSeasonMode(currentSeason, now) === 'active' &&
    !currentSeason.joined &&
    !accounts.some(
      (account) => account.season?.seasonId === currentSeason.id,
    );

  return {
    general: generalAccount
      ? { kind: 'existing', account: generalAccount }
      : { kind: 'start' },
    seasonContinue,
    seasonPast,
    seasonJoin:
      joinable && currentSeason
        ? {
            kind: 'available',
            seasonId: currentSeason.id,
            seasonName: currentSeason.name,
          }
        : { kind: 'none' },
  };
}

/**
 * Guard re-exported next to the model so the switcher and the screen answer
 * "may I offer 일반 투자 시작하기?" with the same predicate.
 */
export { hasGeneralAccount };
