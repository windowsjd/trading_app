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
  `docs/trading-account-orders-api-contract.md`. General-mode FX/wallets are
  still NOT implemented (see gating below).

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
  presenting a partial/empty result as a normally-empty account. General
  accounts have no participant, so the probe is skipped and a genuinely
  empty account stays a normal empty response.

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
