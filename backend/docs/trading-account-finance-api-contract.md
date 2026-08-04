# Account-Scoped Finance API Contract (wallets / ledger / FX)

## Status
- Implemented (2026-08-03, 작업 4):
  - `GET /api/v1/trading-accounts/:accountId/wallets`
  - `GET /api/v1/trading-accounts/:accountId/wallet-transactions`
  - `POST /api/v1/trading-accounts/:accountId/fx/quote`
  - `POST /api/v1/trading-accounts/:accountId/fx/execute`
  - `GET /api/v1/trading-accounts/:accountId/fx/transactions`
- The legacy `/api/v1/wallets`, `/api/v1/wallets/transactions`, and
  `/api/v1/fx/*` endpoints are UNCHANGED (routes, request/response contracts,
  error codes). Both paths run the same service calculation code — fees,
  rates, balance math, ledger writes, idempotency, and transaction atomicity
  are identical by construction.
- Market-rate reads stay on the public `GET /api/v1/fx/rates/current`
  (not duplicated per account).
- Orders/positions ARE account-scoped as of 작업 5 — see
  `docs/trading-account-orders-api-contract.md`.
- As of 작업 6 the two READ routes also serve GENERAL accounts (KRW/USD
  wallets + the one-time `initial_grant` and any `ad_reward` ledger rows) —
  see `docs/general-account-and-ad-rewards-api-contract.md`. General-mode FX
  is still NOT implemented (409 `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`).

## Client status (작업 10)

The frontend uses these routes for all current wallet, ledger and FX screens;
the legacy `/api/v1/wallets`, `/api/v1/wallets/transactions` and `/api/v1/fx/*`
surfaces are no longer called by any screen (they remain implemented). The
public `GET /api/v1/fx/rates/current` is still used directly and keeps an
account-free cache key — it is market data, not account data.

An account change in the client clears the FX quote, its idempotency key, the
entered amount and the success result before anything can be replayed, so the
`QUOTE_MISMATCH` guard below should not be reachable from the app's own UI; it
remains the server-side backstop.

General accounts are shown a 준비 중 state and the client does not send the
request at all, so `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED` is a server gate the UI
mirrors rather than one users collect by pressing a button.

## Common Rules
- Authentication required on every route (401 `UNAUTHORIZED` without a valid
  token). User identity is `request.user.userId`.
- The accountId is explicit in the path. The server stores no
  "current account" anywhere; ownership is re-verified per request via
  `TradingAccountAccessService`.
- A nonexistent accountId and another user's accountId are the SAME
  404 `TRADING_ACCOUNT_NOT_FOUND` (ownership is part of the lookup WHERE; no
  existence oracle, no 403).
- Clients can never supply `userId`, `seasonParticipantId`,
  `tradingAccountId` (outside the path), rates, fees, or `balanceAfter` —
  the server resolves and computes everything.
- Amounts are strings; timestamps are UTC ISO strings; `success/data` /
  `success/error` envelope.

## Reads (wallets / wallet-transactions / fx transactions)
- Allowed for `active`, `suspended`, and `closed` accounts alike — account
  status gates asset mutation, never reads.
- A GET never creates accounts or wallets. An account whose wallets do not
  exist yet returns an empty `wallets` array (`summary.totalWallets = 0`).
- Rows are scoped by the financial rows' own `tradingAccountId` (never by a
  client-provided participant id); no other account's rows can appear.
- Season-account read integrity (작업 5 보완): before returning, the service
  probes the linked participant's CashWallet / WalletTransaction (including
  the linked wallet's scope) / ExchangeTransaction / FxExecuteRequest rows
  for NULL or mismatched `tradingAccountId` with indexed existence queries.
  Any anomaly fails closed with 500 `FINANCIAL_SCOPE_REPAIR_REQUIRED`
  (null — run `pnpm trading-accounts:repair-financial-scope`) or 500
  `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` (non-null mismatch) instead of
  presenting a partial/empty result as a normally-empty account.
- General-account read integrity (작업 6): a general account has no
  participant, so the season probe does not apply. The read asserts the
  INVERSE instead — no wallet and no ledger row of this account may carry a
  `seasonParticipantId`, and no ledger row may point at another account's
  wallet. A violation is 500 `GENERAL_ACCOUNT_INTEGRITY`. A genuinely empty
  general account (none exists after the one-time grant, but a future state
  could) still returns a normal empty response, and a GET never creates a
  wallet, account, or grant.

`GET .../wallets` response data:
```json
{
  "tradingAccountId": "<string>",
  "wallets": [
    {
      "currencyCode": "KRW | USD",
      "balanceAmount": "<amount string>",
      "reservedAmount": "<amount string>",
      "availableAmount": "<amount string>",
      "updatedAt": "<UTC ISO string>"
    }
  ],
  "summary": { "totalWallets": 0, "hasKrwWallet": false, "hasUsdWallet": false }
}
```
`availableAmount = balanceAmount - reservedAmount`, same as the legacy API.

`GET .../wallet-transactions` keeps the legacy filters
(`currency`, `direction`, `txType`), pagination, deterministic ordering
(`occurredAt desc, createdAt desc, id asc`), and row shape; data carries
`tradingAccountId` instead of the legacy season/participant context.

`GET .../fx/transactions` returns the legacy exchange item shape under
`data.exchanges` with `data.tradingAccountId`.

## FX Mutations (quote / execute)
Gating, in order:
1. Ownership (404 as above).
2. `mode = season` — general accounts get 409
   `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED` (general-mode FX/wallets/funding do
   not exist yet; nothing is auto-created).
3. `TradingAccount.status = active` — `suspended`/`closed` get 409
   `TRADING_ACCOUNT_NOT_ACTIVE`. Account status alone NEVER authorizes
   trading:
4. All existing season policies still apply unchanged (season status/window,
   participant status incl. excluded, quote freshness/repricing, balance
   checks, fee policy).

Quote and execute both verify the wallets used (quote: the source-balance
wallet; execute: source and target) carry the verified account scope: a
NULL wallet scope now fails closed with 500
`FINANCIAL_SCOPE_REPAIR_REQUIRED` (작업 5 보완 — previously tolerated), a
non-null mismatch with 500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`, and a
missing participant link with 500 `TRADING_ACCOUNT_LINK_INTEGRITY` (run
`pnpm trading-accounts:repair-links`). The verified account id also rides in
every balance-mutating UPDATE's WHERE (id + participant + account +
currency + atomic balance guards), so a concurrent scope change matches 0
rows. FX quotes dual-write `tradingAccountId` on the durable quote row;
execute refuses a quote whose non-null account differs from the path
account (`QUOTE_MISMATCH`) and consumes quotes with an account-conditioned
updateMany (NULL legacy quotes stay executable for their own participant
only).

## Idempotency (작업 5 보완: account-scoped for every new request)
- Every new execute request — legacy endpoint included (it resolves the
  participant's account first) — is idempotent per
  `(tradingAccountId, idempotencyKey)`: replaying the same key on the same
  account returns the stored result without further mutation; a different
  request under the same key is the idempotency conflict.
- The SAME user may now reuse one key across two of their own accounts (and
  different users always could): the former global
  `UNIQUE(user_id, idempotency_key)` was REPLACED by a PostgreSQL partial
  unique index that protects ONLY legacy rows —
  `UNIQUE (user_id, idempotency_key) WHERE trading_account_id IS NULL`
  (`fx_execute_requests_user_id_idempotency_key_legacy_null_key`). Prisma
  cannot express partial uniques, so it lives in the
  `add_trading_scope_and_fx_legacy_partial_unique` migration and is asserted
  by the schema contract tests.
- Legacy NULL-scope rows stay replayable, but ONLY through a fallback pinned
  to the same user AND the same participant
  (`userId + seasonParticipantId + key + tradingAccountId IS NULL`) —
  another participant's or another season's legacy row is never replayed,
  and post-unique-violation requeries use the same scope rules (never a
  bare per-user lookup).

## Dual-Write Guarantee
Every row written by execute (FxExecuteRequest, ExchangeTransaction, source
and target WalletTransaction) records BOTH `seasonParticipantId` and the same
verified `tradingAccountId`, inside one DB transaction — a mid-transaction
failure rolls back the request row, wallet balance changes, exchange row,
ledger rows, and snapshot together.

## Atomic wallet-mutation failure diagnosis (작업 5 보완 3)

Every guarded cash mutation carries the wallet id, participant, VERIFIED
trading account, currency, AND an amount guard in one WHERE. When it matches
0 rows, any of those could be the reason — but the old per-caller
diagnostics re-read the wallet with the scope columns STILL in the WHERE, so
a wallet whose scope had become null or mismatched simply "disappeared" and
was reported as a missing wallet or a generic concurrency CONFLICT.

`diagnoseCashWalletMutationFailure` (`src/wallets/cash-wallet-failure-diagnosis.ts`)
now re-reads the wallet BY ID ALONE inside the same transaction and
classifies in a fixed order:

1. wallet row gone → the caller's existing "not found"/balance error
2. `seasonParticipantId` ≠ expected → 500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`
3. `tradingAccountId IS NULL` → 500 `FINANCIAL_SCOPE_REPAIR_REQUIRED`
4. `tradingAccountId` ≠ expected → 500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`
5. `currencyCode` ≠ expected → 500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`
6. amount guard cannot hold → the caller's existing `INSUFFICIENT_BALANCE` /
   `INSUFFICIENT_AVAILABLE_BALANCE` / `ORDER_RESERVATION_INCONSISTENT`
7. scope AND amounts both fine → a real concurrency `CONFLICT`

Scope is always checked BEFORE amounts, so corruption is never reported as a
shortfall. The diagnosis is read-only: it never writes, repairs, or
backfills, and the caller's transaction still rolls back.

Applied to every 0-row path, not a subset:

| Path | Amount guard | Codes on failure |
| --- | --- | --- |
| market buy debit | available ≥ net | `INSUFFICIENT_BALANCE` / `CONFLICT` |
| market sell credit | (none) | `INSUFFICIENT_BALANCE` / `CONFLICT` |
| limit-buy reserve | available ≥ reservation | `INSUFFICIENT_AVAILABLE_BALANCE` / `ORDER_RESERVATION_CONFLICT` |
| limit-buy fill settle | reserved ≥ reservation, balance ≥ net | `ORDER_RESERVATION_INCONSISTENT` / `ORDER_RESERVATION_CONFLICT` |
| cancel release | reserved ≥ reservation | `ORDER_RESERVATION_INCONSISTENT` / `ORDER_RESERVATION_CONFLICT` |
| expiry / operator-exclusion cleanup release | reserved ≥ reservation | same as cancel (shared release path) |
| FX source debit | available ≥ source amount | `INSUFFICIENT_BALANCE` / `CONCURRENT_WALLET_UPDATE` |
| FX target credit | (none) | `TARGET_WALLET_NOT_FOUND` / `CONCURRENT_WALLET_UPDATE` |

The `tradingAccountId` in each atomic UPDATE's WHERE is unchanged — the
diagnosis explains a 0-row result, it never relaxes the guard.
