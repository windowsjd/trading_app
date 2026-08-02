# GET /api/v1/trading-accounts API Contract

## Status
- `GET /api/v1/trading-accounts` (owned account list) and
  `GET /api/v1/trading-accounts/:accountId` (owned account detail) are
  implemented, read-only.
- The API reads existing `trading_accounts` rows only. It never creates a
  general account, a wallet, or a grant — a GET must not mutate anything.
- Wallet balances, positions, orders, FX, portfolio valuation, returns, and
  ad-reward data are NOT part of these responses (they are still
  seasonParticipant-based; they move here only after the accountId migration).
- Sub-resource trading endpoints
  (`/api/v1/trading-accounts/:accountId/wallets|orders|portfolio`) are NOT
  implemented yet; they are the planned shape for the accountId migration.

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
