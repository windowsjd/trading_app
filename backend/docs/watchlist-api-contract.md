# User Spot Watchlist

Authenticated `/api/v1/watchlist` routes use the global access-token guard.
Ownership comes only from `request.user.userId`; body/query user or account IDs
never select an owner. Trading Account, wallets, orders and seasons are unrelated.

- `GET /api/v1/watchlist`: `{ success: true, data: { items } }`, complete list
  (at most 50), newest `createdAt` first, then `assetId` ascending.
- `PUT /api/v1/watchlist/:assetId`: HTTP 200,
  `{ success: true, data: { item } }`. Explicitly adds; an existing item is
  returned unchanged, including its timestamp, even if now inactive.
- `DELETE /api/v1/watchlist/:assetId`: HTTP 200,
  `{ success: true, data: { assetId, registered: false } }`. Explicitly removes;
  a missing entry is successful, including an unknown but syntactically valid ID.

An item is `{ assetId, name, symbol, market, assetType, isActive, createdAt }`.
Asset metadata is joined from Asset; timestamps are UTC ISO strings. No prices
are supplied: existing price sources/freshness remain in the market/detail APIs.
Asset IDs are 1–128 ASCII letters/digits, hyphens or underscores (UUIDs included).

Errors use `{ success: false, error: { code, message } }`:
400 `INVALID_ASSET_ID`, 404 `ASSET_NOT_FOUND`, 400 `WATCHLIST_SPOT_ONLY`,
409 `ASSET_INACTIVE`, 409 `WATCHLIST_LIMIT_REACHED`, existing auth/500 envelopes.
The limit counts inactive records too. No pagination or account ID is required.

Both mutations lock the owning User row with `FOR NO KEY UPDATE` inside a
READ COMMITTED Prisma transaction, then read/check/write. Thus concurrent
requests from different server instances/devices for the same user serialize;
49 + two different inserts ends at 50. The composite primary key is a second
duplicate barrier. New inserts also share-lock the Asset before validating it.
Deletes need no active/Spot check so historical entries always remain removable.

The additive migration creates only watchlist storage and references existing
User/Asset. User deletion cascades this nonfinancial preference; Asset deletion
is restricted to preserve records (deactivation remains supported). Never apply
this task's migration to production.
