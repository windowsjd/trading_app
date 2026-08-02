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
- Orders/positions are NOT account-scoped yet; general-mode FX/wallets are
  NOT implemented (see gating below).

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

Execute additionally verifies that the source and target wallets belong to
the path account (a non-null wallet scope that disagrees fails closed with
500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`) and that the participant has
a trading-account link (else 500 `TRADING_ACCOUNT_LINK_INTEGRITY`; run
`pnpm trading-accounts:repair-links`).

## Idempotency
- Account-scoped execute looks the command up by the new
  `(tradingAccountId, idempotencyKey)` unique: replaying the same key on the
  same account returns the stored result without further mutation.
- Different USERS' accounts may reuse the same key. Transitional caveat: the
  legacy `(userId, idempotencyKey)` unique is intentionally kept until the
  participant-id removal work unit, so the SAME user reusing a key across two
  of their own accounts is still rejected (surfaces as the legacy
  idempotency conflict).

## Dual-Write Guarantee
Every row written by execute (FxExecuteRequest, ExchangeTransaction, source
and target WalletTransaction) records BOTH `seasonParticipantId` and the same
verified `tradingAccountId`, inside one DB transaction — a mid-transaction
failure rolls back the request row, wallet balance changes, exchange row,
ledger rows, and snapshot together.
