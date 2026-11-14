// Runtime imports carry the .ts extension so `node --test` can load this module.
import type { SeasonFinalResultDto } from '../record/api';
import type { TradingAccountDto } from '../tradingAccount/api';
import { isShownFinalResult } from '../record/seasonFinalResult.ts';

/**
 * 시즌최종결과 자동 표시 (2026-11-14): the rules SeasonResultAutoOpen follows,
 * pure so `node --test` covers them.
 *
 * Owned pending results remain watched after the operating selection moves away:
 * the server settles it (`settled`), and its final result has not been seen
 * (`finalResultViewedAt === null`, explicitly — an older server's absent field
 * is unknown, never "unseen"). The result read (`/records/me/seasons/:id/
 * final-result`) must then confirm the same season, settled, unseen, with a
 * result the screen shows and records. Nothing is assumed from the clock and
 * no result is ever guessed.
 */
export const SETTLEMENT_POLL_MS = 30_000;
/** A failed result read retries this often while the app is in front, a few times. */
export const RESULT_RETRY_MS = 60_000;
export const RESULT_RETRY_LIMIT = 5;
/** A short pause once the place and the overlay slot are free (as the 공지 팝업). */
export const AUTO_OPEN_DELAY_MS = 350;
/** If navigation never shows the screen, the overlay slot is given back after this. */
export const OPEN_GIVE_UP_MS = 2_000;

type Account = Pick<TradingAccountDto, 'id' | 'mode' | 'season'> | null | undefined;

/** Ended, waiting for settlement: the owned list is re-read until it settles. */
export function awaitsSettlement(account: Account): boolean {
  return account?.mode === 'season' && account.season?.seasonStatus === 'ended';
}

/** Worth a fresh read when the app comes back to the front: still running, or ended. */
export function seasonMayChange(account: Account): boolean {
  const status = account?.mode === 'season' ? account.season?.seasonStatus : undefined;
  return status === 'active' || status === 'ended';
}

/** The selected account's settled season whose result the server says is unseen. */
export function unseenSettledSeason(account: Account): { accountId: string; seasonId: string } | null {
  const season = account?.mode === 'season' ? account.season : null;
  if (!account || !season || season.seasonStatus !== 'settled' || season.finalResultViewedAt !== null) return null;
  return { accountId: account.id, seasonId: season.seasonId };
}

/** The server's result allows opening it now: that season, settled, unseen, and shown (then recorded) by the screen. */
export function canAutoOpen(result: SeasonFinalResultDto | null | undefined, seasonId: string): boolean {
  return (
    !!result &&
    result.season?.id === seasonId &&
    result.season.status === 'settled' &&
    result.viewedAt === null &&
    isShownFinalResult(result.result)
  );
}

type NavState = { index?: number; routes: ReadonlyArray<{ name: string; state?: NavState }> } | undefined;

/**
 * The safe entry place: Home's first screen in front (the tabs on top, the
 * Home tab open, nothing pushed in it). An order, a detail, a chart, the
 * wallet or any root screen is not — the result waits for the way back.
 */
export function isAtHomeRoot(root: NavState): boolean {
  const top = root?.routes[root.index ?? root.routes.length - 1];
  if (!top || top.name !== 'MainTabs') return false;
  const tabs = top.state;
  // Tabs not laid out yet: they open on Home.
  if (!tabs) return true;
  const tab = tabs.routes[tabs.index ?? 0];
  if (!tab || tab.name !== 'HomeTab') return false;
  const stack = tab.state;
  return !stack || (stack.index ?? 0) === 0;
}

/** A 시즌최종결과 screen is already on the root stack (opened by the member or by this). */
export function hasFinalResultOnStack(root: NavState): boolean {
  return !!root?.routes.some((route) => route.name === 'SeasonFinalResult');
}

/** Preserve final-result guidance independently of the operating selection. */
export function pendingResultAccount(accounts: readonly NonNullable<Account>[], selected: Account): Account {
  return [...accounts].filter(account => unseenSettledSeason(account) || awaitsSettlement(account))
    .sort((left, right) => Number(!!unseenSettledSeason(right)) - Number(!!unseenSettledSeason(left)) || (right.season?.endAt ?? '').localeCompare(left.season?.endAt ?? '') || left.id.localeCompare(right.id))[0] ?? selected;
}
