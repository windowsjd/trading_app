# /api/v1/trading-accounts API Contract

## Status
- `GET /api/v1/trading-accounts` (owned account list) and
  `GET /api/v1/trading-accounts/:accountId` (owned account detail) are
  implemented, read-only.
- `POST /api/v1/trading-accounts/general` (general-mode entry: create the
  user's single general account + KRW/USD wallets + the one-time
  10,000,000 KRW grant, idempotently) is implemented as of 작업 6. Full
  contract: `docs/general-account-and-ad-rewards-api-contract.md`.
- The GET routes read existing `trading_accounts` rows only. They never
  create a general account, a wallet, or a grant — a GET must not mutate
  anything, and a general account exists only after the explicit POST.
- Wallet balances, positions, orders, FX, portfolio valuation, returns, and
  ad-reward data are NOT part of these responses (they are still
  seasonParticipant-based; they move here only after the accountId migration).
- Ad-reward sub-resources
  (`/api/v1/trading-accounts/:accountId/ad-rewards/eligibility|claim|claims`)
  are implemented for GENERAL accounts (작업 6); ad rewards are disabled by
  default and no real provider adapter exists yet.
- Account-scoped finance sub-resources
  (`/api/v1/trading-accounts/:accountId/wallets`, `wallet-transactions`,
  `fx/quote|execute|transactions`) are implemented — see
  `docs/trading-account-finance-api-contract.md`. Account-scoped order and
  position sub-resources (`orders`, `orders/:orderId`, `orders/quote`,
  `orders/:orderId/cancel`, `positions`) are implemented (작업 5) — see
  `docs/trading-account-orders-api-contract.md`. Portfolio sub-resources are
  still NOT implemented.

## Source Rules
- Source of truth is `trading_accounts` (+ `season_participants`/`seasons` for
  season link info).
- Amount values are strings; timestamps are UTC ISO strings.
- Responses keep the existing `success/data` / `success/error` structure.
- User identity is `request.user.userId` from the access-token guard; there is
  no `x-user-id` fallback. Both routes require authentication (401 without a
  valid token).
- The server stores NO "currently selected account/mode" anywhere (no JWT
  claim, no session, no User column, no singleton). Account selection is
  frontend UI state; every request names its accountId and ownership is
  re-verified per request via `TradingAccountAccessService`.

## Routes

`GET /api/v1/trading-accounts`

`GET /api/v1/trading-accounts/:accountId`

`POST /api/v1/trading-accounts/general` — no body, always HTTP 200, response
`{ created, account, wallets }`. See
`docs/general-account-and-ad-rewards-api-contract.md`.

## List Response

Only accounts actually owned by the logged-in user, sorted deterministically
by `openedAt desc, createdAt desc, id asc`. A user who never entered general
mode simply has no general row (no placeholder is fabricated).

```json
{
  "success": true,
  "data": {
    "accounts": [
      {
        "id": "<string>",
        "mode": "season | general",
        "status": "active | suspended | closed",
        "initialCapitalKrw": "<amount string>",
        "openedAt": "<UTC ISO string>",
        "closedAt": "<UTC ISO string> | null",
        "createdAt": "<UTC ISO string>",
        "updatedAt": "<UTC ISO string>",
        "season": {
          "seasonId": "<string>",
          "seasonName": "<string>",
          "seasonStatus": "upcoming | active | ended | settled",
          "startAt": "<UTC ISO string>",
          "endAt": "<UTC ISO string>",
          "seasonParticipantId": "<string>",
          "participantStatus": "registered | active | excluded | finished | rewarded",
          "joinedAt": "<UTC ISO string>"
        }
      }
    ]
  }
}
```

`season` is `null` for a general account.

## Detail Response

Same fields as one list item, directly under `data`.

## Errors

- 401 `UNAUTHORIZED` — missing/invalid token.
- 404 `TRADING_ACCOUNT_NOT_FOUND`, message `Trading account not found` — the
  accountId does not exist **or** belongs to another user. Both cases are
  deliberately identical (ownership is part of the lookup WHERE) so account
  existence is never disclosed; no 403 is used here.
- 500 `TRADING_ACCOUNT_INTEGRITY` — server-side data inconsistency (season
  account without participant, participant of another user, or a general
  account with a participant attached). Never masked as 404.

## Status vs Readability

`TradingAccount.status` gates asset mutation (future), not reads: the owner
can read `active`, `suspended`, and `closed` accounts alike. Season trading
permission is NOT decided by `TradingAccount.status` alone — the existing
season/participant/order/fx policies stay authoritative and were not changed
by this API.
