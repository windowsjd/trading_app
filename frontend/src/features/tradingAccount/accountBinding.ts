import type { TradingAccountDto } from './api.ts';
import {
  getTradingAccountCapabilities,
  type TradingAccountCapabilities,
} from './capabilities.ts';

/**
 * Is this order flow still safe to continue? (작업 10 §A-2)
 *
 * A mutation flow — order, and FX by the same reasoning — is about ONE account,
 * fixed when the user entered it. Three facts can make continuing unsafe, and
 * they are genuinely different situations that deserve different screens:
 *
 *   - the owned-account list has not arrived yet, so nothing can be judged;
 *   - the bound id is not in the owned list (unknown id, another user's id, or
 *     an account that left the list — deliberately indistinguishable, and the
 *     client does not probe to tell them apart);
 *   - the user switched accounts while the screen was open, so the quote, its
 *     idempotency key, and the typed amounts all describe a different account
 *     than the one now selected.
 *
 * The last one is the case worth being careful about. It is tempting to just
 * follow the selection — but the quote on screen was priced for the old
 * account, the server pins quotes to the account that issued them, and the
 * amounts were chosen against the old account's balances. Following the
 * selection would mean the user presses 주문 on one account's numbers and moves
 * money in another's. So the flow stops and asks them to re-enter.
 *
 * A pure function so this decision can be tested without a navigator, a
 * network client, or a React tree.
 */

export type AccountBinding =
  | { state: 'loading' }
  | { state: 'unknown_account' }
  | {
      state: 'account_changed';
      boundAccountId: string;
      currentAccountId: string;
    }
  | {
      state: 'bound';
      account: TradingAccountDto;
      capabilities: TradingAccountCapabilities;
    };

export function resolveAccountBinding(params: {
  /** The id the flow was entered with — from the route, never re-read. */
  boundAccountId: string;
  accounts: readonly TradingAccountDto[];
  selectedAccountId: string | null;
  accountsLoading: boolean;
}): AccountBinding {
  const { boundAccountId, accounts, selectedAccountId, accountsLoading } =
    params;

  if (accountsLoading) {
    return { state: 'loading' };
  }

  // Checked BEFORE ownership: if the user has already moved on, telling them
  // the old account is "not found" would be both wrong and alarming.
  if (selectedAccountId && selectedAccountId !== boundAccountId) {
    return {
      state: 'account_changed',
      boundAccountId,
      currentAccountId: selectedAccountId,
    };
  }

  const account =
    accounts.find((candidate) => candidate.id === boundAccountId) ?? null;

  if (!account) {
    return { state: 'unknown_account' };
  }

  return {
    state: 'bound',
    account,
    // Non-null for a real account; the cast documents that.
    capabilities: getTradingAccountCapabilities(account)!,
  };
}

/**
 * True when the flow must drop its quote, idempotency key, inputs and success
 * state. Kept separate from the binding so the screen's reset effect depends on
 * one boolean rather than on an object identity that changes every render.
 */
export function shouldResetBoundFlow(binding: AccountBinding) {
  return binding.state === 'account_changed';
}
