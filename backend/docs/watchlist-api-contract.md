# User watchlist (관심종목)

All routes are authenticated by the global access-token guard and live under
`/api/v1`. The owner is always the token's user; a `userId` in the path, query
or body is never read. Responses use the existing `success/data` and
`success/error` envelopes.

## Policy

- A watchlist belongs to the **user**, not a trading account: the general,
  season and beginner accounts of one user see the same list. Watching never
  reads or writes accounts, wallets, orders, positions, seasons or rankings.
- Only Spot assets can be added: Korean stocks, US stocks and Binance Spot
  crypto. Futures-only Binance assets (`isFuturesOnlyAsset`, the same catalog
  as Spot discovery) and inactive assets are rejected for a **new** add.
- An item whose asset is deactivated later is kept, listed with
  `isActive: false`, still counts toward the cap and can be removed.
- At most **50** items per user, inactive items included. Adds of one user
  serialize on the user's row (`SELECT ... FOR NO KEY UPDATE`, READ COMMITTED),
  so concurrent adds from several devices never exceed 50.
- Order: newest `addedAt` first, then asset id descending for items stored in
  the same millisecond. Re-adding an existing item keeps its `addedAt`.

## Item

```json
{ "assetId": "uuid", "symbol": "005930", "name": "삼성전자", "market": "KRX",
  "assetType": "domestic_stock", "isActive": true,
  "addedAt": "2026-10-13T01:02:03.456Z" }
```

Identity fields come from the `assets` row on every read.

## Routes

- `GET /watchlist` → `{ items: Item[], limit: 50 }`. Every stored item, no
  pagination (the cap bounds it). An empty list is `items: []`.
- `PUT /watchlist/:assetId` → `{ item: Item, created: boolean }`, HTTP 200.
  Idempotent target state "watched": an existing item returns `created: false`
  with its original `addedAt`, even if the asset is now inactive or the list is
  at the cap.
- `DELETE /watchlist/:assetId` → `{ assetId, removed: boolean }`, HTTP 200.
  Idempotent target state "not watched": an absent item, or an unknown asset
  id, returns `removed: false`.
- `GET /watchlist/assets?assetType=domestic_stock|us_stock|crypto` →
  `{ state: 'available', assets, priceErrors }`. The watched Spot assets of one
  market (all markets when `assetType` is omitted) in watchlist order, as the
  same list items and `priceErrors` that `GET /assets?withPrice=true` returns
  (see [assets contract](assets-api-contract.md)): identical snapshot source,
  freshness, FX and tradability policy, with no price when no eligible snapshot
  exists. Inactive items are included (`tradable: false`,
  `tradeBlockedReason: 'ASSET_INACTIVE'`); a Futures-only asset is not.

## Errors

| HTTP | code | when |
| --- | --- | --- |
| 400 | `INVALID_ASSET_ID` | path id is not 1–64 of `[A-Za-z0-9_-]` |
| 400 | `INVALID_ASSET_TYPE` | unknown or repeated `assetType` |
| 400 | `ASSET_NOT_TRADABLE` | new add of a Futures-only asset (`Asset is not a Spot product.`) |
| 404 | `ASSET_NOT_FOUND` | new add of an unknown asset id |
| 409 | `ASSET_NOT_TRADABLE` | new add of an inactive asset (`Asset is not active.`) |
| 409 | `WATCHLIST_LIMIT_EXCEEDED` | new add when 50 items are stored |
| 401 / 403 | `UNAUTHORIZED` / `USER_NOT_ACTIVE` | guard |

Database errors are never returned; the global filter maps them to
`INTERNAL_SERVER_ERROR`.

## Storage

`watchlist_items(user_id, asset_id, created_at)`, primary key
`(user_id, asset_id)` (duplicate-proof and the per-user read path), foreign
keys to `users` and `assets` with `ON DELETE RESTRICT`. Migration
`20261013120000_add_user_watchlist` is additive.

Verification: `WATCHLIST_DB_INTEGRATION=1` runs
`scripts/watchlist-integration.ts` (real HTTP + guard + PostgreSQL), including a
lock-barrier race of two different adds at 49 items.
