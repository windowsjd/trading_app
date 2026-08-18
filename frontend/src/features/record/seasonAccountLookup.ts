import type { TradingAccountDto } from '../tradingAccount/api';

/**
 * Which account a season's record screen is about, and what to do when there
 * isn't one (작업 12 §5).
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * The screen searched the owned-account list for the season's account and, when
 * it found none, showed "이 시즌의 계정을 찾을 수 없습니다" with a retry wired to
 * `ordersQuery.refetch()`. Two things were wrong with that:
 *
 *   - the orders query is `enabled: hasAccount`, so with no account it is
 *     DISABLED and refetching it does nothing at all. The retry button was
 *     decorative;
 *   - it could not tell "the account list failed to load" from "the account
 *     list loaded fine and this season simply has no account of yours". The
 *     first needs the ACCOUNT list retried; the second is a scope/link
 *     integrity question that no amount of retrying the orders query answers.
 *
 * FOUR STATES, NOT TWO
 * --------------------
 * `loading` · `account_list_error` · `account_missing` · `ready`.
 *
 * `account_missing` is deliberately NOT rendered as an empty order list: an
 * empty list asserts the user made no trades that season, which this screen has
 * no evidence for. What it actually knows is that the link between the season
 * and an owned account is absent — which is the same class of fault the
 * backend's account-link repair tooling exists for.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It never probes for the account. A season account that belongs to someone
 * else and a season account that does not exist are indistinguishable by
 * backend design, and the client must not try to tell them apart.
 */

export type SeasonAccountLookup =
  | { state: 'loading'; account: null }
  | { state: 'account_list_error'; account: null }
  | { state: 'account_missing'; account: null }
  | { state: 'ready'; account: TradingAccountDto };

export type SeasonAccountLookupInput = {
  seasonId: string;
  accounts: readonly TradingAccountDto[];
  isLoading: boolean;
  isError: boolean;
};

export type RecordOrderAccountScope =
  | { seasonId: string; accountId?: never }
  | { accountId: string; seasonId?: never };

export const ACCOUNT_LIST_ERROR_TITLE = '계정 정보를 불러오지 못했습니다.';
export const ACCOUNT_LIST_ERROR_MESSAGE =
  '계정 목록을 불러오지 못해 어떤 계정의 거래 내역인지 확인할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.';

export const ACCOUNT_MISSING_TITLE = '이 시즌의 계정을 찾을 수 없습니다.';
export const ACCOUNT_MISSING_MESSAGE =
  '계정 목록은 정상적으로 불러왔지만 이 시즌에 연결된 내 계정이 없습니다. 거래 내역이 없다는 뜻이 아니라 계정 연결 정보에 문제가 있을 수 있습니다. 계정 정보를 다시 불러온 뒤에도 같으면 고객센터에 문의해주세요.';

export function findSeasonAccount(
  accounts: readonly TradingAccountDto[],
  seasonId: string,
): TradingAccountDto | null {
  return (
    accounts.find(
      (account) =>
        account.mode === 'season' && account.season?.seasonId === seasonId,
    ) ?? null
  );
}

export function resolveSeasonAccount({
  seasonId,
  accounts,
  isLoading,
  isError,
}: SeasonAccountLookupInput): SeasonAccountLookup {
  // Loading wins: a half-loaded list has not yet failed to contain the account.
  if (isLoading) return { state: 'loading', account: null };

  const account = findSeasonAccount(accounts, seasonId);
  if (account) return { state: 'ready', account };

  // Error is only meaningful once the account is genuinely absent — react-query
  // can report `isError` from a failed background refetch while still holding a
  // perfectly good cached list, and that list is the answer.
  if (isError) return { state: 'account_list_error', account: null };

  return { state: 'account_missing', account: null };
}

/**
 * Resolves the immutable subject carried by the order-history route.
 *
 * Historical season entry points name a season and retain the strict
 * participant/account-link lookup above. General Home has no season to name,
 * so it carries the already-owned general account id directly. In both cases
 * the id must still be present in the authenticated account list; this helper
 * never probes an arbitrary id and never falls back to the currently selected
 * account after the route has been opened.
 */
export function resolveRecordOrderAccount(input: {
  scope: RecordOrderAccountScope;
  accounts: readonly TradingAccountDto[];
  isLoading: boolean;
  isError: boolean;
}): SeasonAccountLookup {
  if ('seasonId' in input.scope && input.scope.seasonId) {
    return resolveSeasonAccount({
      seasonId: input.scope.seasonId,
      accounts: input.accounts,
      isLoading: input.isLoading,
      isError: input.isError,
    });
  }

  if (input.isLoading) return { state: 'loading', account: null };

  const account = input.accounts.find(
    (candidate) =>
      candidate.id === input.scope.accountId && candidate.mode === 'general',
  );
  if (account) return { state: 'ready', account };
  if (input.isError) return { state: 'account_list_error', account: null };
  return { state: 'account_missing', account: null };
}

/**
 * The orders query may only run for a real account id. An empty id would send
 * `/trading-accounts//orders` — a request that can only 404, and that would
 * make an infrastructure error look like a missing season.
 */
export function canQuerySeasonOrders(lookup: SeasonAccountLookup): boolean {
  return lookup.state === 'ready' && !!lookup.account.id;
}

export const canQueryRecordOrders = canQuerySeasonOrders;
