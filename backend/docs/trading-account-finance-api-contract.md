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
  see `docs/general-account-and-ad-rewards-api-contract.md`. As of 2026-08-18,
  the same account-scoped FX routes also quote, execute, and list KRW↔USD
  exchanges for active general accounts. No general-only endpoint exists.

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

Active general accounts use the same `WalletFxScreen` and account-scoped
quote/execute routes as season accounts. Suspended/closed accounts remain
readable but cannot create a quote or execute; changing the selected account
clears the quote, idempotency key, input, and success state before another
request can be sent. The legacy `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED` client
mapping remains only for rolling-deployment compatibility and is no longer a
current server contract.

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

Common gating, in order:

1. Ownership (404 as above).
2. `TradingAccount.status = active` — `suspended`/`closed` get 409
   `TRADING_ACCOUNT_NOT_ACTIVE` for new quote/execute requests.
3. Mode-specific context:
   - season keeps every existing season status/window, participant
     status/excluded, `Season.fxFeeRate`, and financial-scope gate;
   - general requires the participant-free general foundation, KRW/USD
     wallets, ledger/snapshot continuity, and never looks up a current season.
4. Common durable-quote, provider freshness/repricing, available-balance,
   wallet mutation, and atomicity policies.

The source amount is checked against `balanceAmount - reservedAmount`; FX
cannot consume cash reserved by a submitted limit buy. No wallet or account is
created during quote or execute, and KRW→USD is never performed implicitly by
an order.

Quote and execute both verify the wallets used (quote: source; execute:
source and target) carry the verified account scope. Season keeps
`FINANCIAL_SCOPE_REPAIR_REQUIRED`,
`FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`, and
`TRADING_ACCOUNT_LINK_INTEGRITY` behavior. General requires non-null matching
`tradingAccountId` and null participant on its financial/FX rows; pollution or
cross-account relations fail closed as `GENERAL_ACCOUNT_INTEGRITY`. Every
balance UPDATE includes wallet id, account, currency, mode-appropriate
participant scope, and amount guard.

General durable quotes store `tradingAccountId=<general account>`,
`seasonParticipantId=null`, and the quote-time `GENERAL_FX_FEE_RATE` in
`quotedFeeRate`. The default is `0.001000`; configuration is validated at
startup and is independent of both `Season.fxFeeRate` and
`GENERAL_TRADE_FEE_RATE`. Execute uses only the pinned fee. A legacy/null or
invalid general pinned fee returns 409 `QUOTE_MISMATCH` for requote instead of
silently applying the current environment value. The provider rate is still
freshly resolved at execute and protected by the existing 30bps maximum
change.

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
- Season quote/execute request-hash v1 bytes are unchanged. General uses a v2
  hash that binds user + account + direction/source (and quote for execute),
  without inventing a participant.
- Committed replay is checked before current account status and mutable
  integrity gates. A completed request therefore keeps returning its stored
  response after suspension/closure and never mutates twice.
- Legacy NULL-scope rows stay replayable, but ONLY through a fallback pinned
  to the same user AND the same participant
  (`userId + seasonParticipantId + key + tradingAccountId IS NULL`) —
  another participant's or another season's legacy row is never replayed,
  and post-unique-violation requeries use the same scope rules (never a
  bare per-user lookup). General never uses this legacy fallback.

## Scope and atomic write guarantee

Season execute continues to record BOTH `seasonParticipantId` and the same
verified `tradingAccountId`. General execute records the verified
`tradingAccountId` with `seasonParticipantId=null` on FxExecuteRequest,
ExchangeTransaction, and the source/target WalletTransaction rows. General
also writes an `exchange_executed` ordinary TWR snapshot with null participant;
FX is not external funding and never updates SeasonParticipant, ranking, or
settlement state.

General execution locks the TradingAccount row `FOR UPDATE`, obtains DB wall
clock time after the lock, then performs both wallet changes, request,
exchange, two ledgers, stored replay response, and snapshot in one transaction.
A failure rolls everything back. This uses the same account-level performance
serialization fence as general orders and external-funding writers.

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

| Path                                        | Amount guard                          | Codes on failure                                                |
| ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| market buy debit                            | available ≥ net                       | `INSUFFICIENT_BALANCE` / `CONFLICT`                             |
| market sell credit                          | (none)                                | `INSUFFICIENT_BALANCE` / `CONFLICT`                             |
| limit-buy reserve                           | available ≥ reservation               | `INSUFFICIENT_AVAILABLE_BALANCE` / `ORDER_RESERVATION_CONFLICT` |
| limit-buy fill settle                       | reserved ≥ reservation, balance ≥ net | `ORDER_RESERVATION_INCONSISTENT` / `ORDER_RESERVATION_CONFLICT` |
| cancel release                              | reserved ≥ reservation                | `ORDER_RESERVATION_INCONSISTENT` / `ORDER_RESERVATION_CONFLICT` |
| expiry / operator-exclusion cleanup release | reserved ≥ reservation                | same as cancel (shared release path)                            |
| FX source debit                             | available ≥ source amount             | `INSUFFICIENT_BALANCE` / `CONCURRENT_WALLET_UPDATE`             |
| FX target credit                            | (none)                                | `TARGET_WALLET_NOT_FOUND` / `CONCURRENT_WALLET_UPDATE`          |

The `tradingAccountId` in each atomic UPDATE's WHERE is unchanged — the
diagnosis explains a 0-row result, it never relaxes the guard.
