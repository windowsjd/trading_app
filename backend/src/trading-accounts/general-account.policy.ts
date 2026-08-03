/**
 * General-mode (non-season) account policy constants — the ONE place the
 * initial virtual funding is defined.
 *
 * POLICY (docs/trading-modes-and-accounts.md §1.4–1.7):
 *  - Exactly ONE general TradingAccount per user, for life. It is created
 *    only by an explicit POST; a GET, a migration, a trading path, or an ad
 *    claim never creates one.
 *  - 10,000,000 KRW is granted EXACTLY ONCE, when the account is first
 *    opened, as a single `initial_grant` ledger row referencing the account.
 *  - There is NO monthly/periodic/anniversary/catch-up grant, no scheduler,
 *    no bankruptcy auto-reset, and no transfer between accounts. Any field
 *    named grantAnchorDay / nextGrantAt / lastMonthlyGrantAt /
 *    monthlyGrantCount / catchUpGrant / recurringGrant is forbidden here.
 *  - Further funding comes ONLY from verified rewarded-ad claims, which are
 *    EXTERNAL virtual funding (txType=ad_reward) and never change
 *    initialCapitalKrw.
 */

/** Canonical scale-8 decimal string; never a JS number. */
export const GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW = '10000000.00000000';

/** USD wallets open at zero; USD funding only ever comes from FX. */
export const GENERAL_ACCOUNT_INITIAL_USD_BALANCE = '0.00000000';

export const GENERAL_ACCOUNT_ZERO_AMOUNT = '0.00000000';
