import type { OpenGeneralAccountDto, TradingAccountDto } from './api';

/**
 * The steps AFTER `POST /trading-accounts/general` succeeded, in the one order
 * that cannot mix accounts (작업 13 §11):
 *
 *   1. refresh the owned-account list — and WAIT for it, so the provider is
 *      already rendering a list that contains the new account;
 *   2. select the id THE SERVER RETURNED — never a fabricated or assumed one;
 *   3. only then hand control back to the caller (close the sheet, navigate).
 *
 * Selecting before the refresh completes would point the selection at an id
 * the provider cannot find yet; the selection policy would fall back to some
 * other owned account, and for the season-only user that is exactly the
 * auto-season entry this work removes. The order is enforced here, once, so
 * the mode-selection screen, the account switcher, and the setup panel cannot
 * drift apart on it.
 *
 * Works identically for a replay (`created: false`): the account in the
 * answer IS the user's general account, so it is selected the same way — a
 * double tap or a retry lands on the one account instead of erroring.
 */
export async function completeGeneralAccountOpen(
  result: OpenGeneralAccountDto,
  deps: {
    refreshOwnedAccounts: () => Promise<unknown>;
    selectAccount: (accountId: string) => void;
    onOpened?: (account: TradingAccountDto) => void;
  },
): Promise<TradingAccountDto> {
  await deps.refreshOwnedAccounts();
  deps.selectAccount(result.account.id);
  deps.onOpened?.(result.account);
  return result.account;
}
