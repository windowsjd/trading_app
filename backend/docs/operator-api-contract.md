# Operator API Contract

## Status

- Admin/operator authorization foundation MVP is implemented.
- `GET /api/v1/operator/me` is implemented as the minimal operator smoke endpoint.
- `OperatorAuditLog` foundation is implemented as an internal service/model for future operator mutations.
- Admin/operator Account Management Gate is implemented for admin-only user list/get, explicit role changes, status changes, and deleted user restore.
- Provider ingestion trigger API is implemented for operator/admin market-data ingestion dry-runs and explicit non-dry-runs.
- Season participant moderation APIs are implemented for operator/admin exclusion, ranking hide/unhide, and verified final result correction. Reward payout/revoke and reward fulfillment are outside this scope.
- Internal reward fulfillment operator/admin APIs are documented in `docs/rewards-api-contract.md`.
- No batch run trigger, scheduler HTTP API, external reward provider API, real trading/account/balance, deposit/withdrawal, or external order API exists. Scheduler/Ops foundation exists internally and is disabled by default.
- `provider_api` source eligibility is open only inside explicitly allowed services: read-only/quote services, `/fx execute`, orders execute, the separate operator-run daily snapshot valuation job, and explicit operator/admin provider ingestion triggers. No batch HTTP API, ranking/reward workflow source eligibility, hoga-based execution, or real trading/account API is opened by this contract.

## Migration / Runtime Requirement

- Admin/operator authorization MVP requires schema migration `20260601090000_add_user_role_operator_audit_logs`.
- Admin status/restore and internal reward fulfillment require schema migration `20260609120000_add_user_status_restore_internal_reward_fulfillment`.
- Season participant moderation requires schema migration `20260621120000_add_season_participant_moderation`.
- KIS hoga/orderbook ingestion requires schema migration `20260621143000_add_asset_orderbook_snapshots`.
- Runtime DBs must have the `UserRole` enum, `users.role` column, `OperatorAuditResult` enum, and `operator_audit_logs` table applied before protected APIs are expected to run normally.
- The access-token guard reads current DB `User.status` and `User.role` on every protected request. Role authorization does not trust a JWT role claim.
- Existing protected APIs continue to depend on `request.user.userId`; `request.user.role` is additional authorization context and must not replace user identity.

## Role Model

`UserRole` is an authorization role:

- `user`: default signup role.
- `operator`: can use operator-only service/API boundaries.
- `admin`: includes operator permissions and can use the account-management APIs below.

`UserStatus` remains lifecycle state:

- `active`: may authenticate.
- `suspended` / `deleted`: blocked by the access-token guard with `403 USER_NOT_ACTIVE`.

`UserRole` must not be used as an account lifecycle state, and `UserStatus` must not be used as an authorization role.

## Access Token Context

- Access token payload remains minimal and uses `sub` as the user id.
- The access-token guard verifies the bearer JWT, then reads the current DB user.
- Authorization decisions trust current DB `User.status` and `User.role`, not a role claim in the JWT.
- `request.user` contains:

```json
{
  "userId": "user-id",
  "role": "operator"
}
```

- Existing protected APIs continue to identify users with `request.user.userId`.
- `x-user-id` fallback is not supported.

## GET /api/v1/operator/me

### Auth

- Protected by the access-token guard and operator guard.
- `role=operator` and `role=admin` pass.
- `role=user` returns `403 OPERATOR_FORBIDDEN`.
- Missing, invalid, expired, or malformed bearer token returns `401 UNAUTHORIZED`.
- `x-user-id` without bearer token returns `401 UNAUTHORIZED`.
- `suspended` or `deleted` users return the existing `403 USER_NOT_ACTIVE`.

### Response

```json
{
  "success": true,
  "data": {
    "userId": "user-id",
    "role": "operator"
  }
}
```

This read-only smoke endpoint does not write an audit row.

## Provider Ingestion Trigger

All routes in this section require a valid Bearer access token and `role=operator` or `role=admin`.

### POST /api/v1/operator/provider-ingestions/:provider/run

Purpose: explicitly trigger or dry-run provider market-data ingestion.

Supported `:provider` values:

- `exchange-rate`
- `korea-exim`
- `binance`
- `kis`

Body:

```json
{
  "dryRun": true,
  "symbols": ["005930", "NAS:AAPL", "BTCUSDT"],
  "maxSnapshots": 20,
  "kisModes": ["rest_current_price", "rest_hoga"],
  "durationMs": 30000,
  "reason": "manual_smoke",
  "note": "optional operator note"
}
```

Policy:

- `dryRun` defaults to `true`; non-dry-run requires explicit `"dryRun": false`.
- `symbols` is optional and provider-specific. KIS accepts 6-digit domestic symbols and US symbols in `NAS:AAPL`/`NYS:IBM` form; Binance accepts public ticker symbols such as `BTCUSDT`.
- `maxSnapshots` caps accepted `created`/`would_create` rows for KIS REST/WebSocket modes.
- `kisModes` defaults to `["rest_current_price", "rest_hoga"]`; `websocket_trade` can be requested explicitly.
- Disabled or missing provider env returns a handled `state="skipped"` or `state="failed"` summary instead of creating fake rows.
- The trigger only writes provider market-data rows:
  - FX providers write `fx_rate_snapshots`.
  - Binance and KIS current-price/trade ingestion write `asset_price_snapshots`.
  - KIS hoga ingestion writes `asset_orderbook_snapshots`.
- It does not mutate orders, FX execute requests, wallets, positions, ledgers, rankings, settlement, rewards, or reward fulfillment rows.
- Responses and audit metadata contain aggregate safe summaries only. Raw provider payloads, access tokens, approval keys, app keys/secrets, `.env.local`, `DATABASE_URL`, and private ledgers are not exposed.
- Success and handled skipped/disabled outcomes write `OperatorAuditLog` with safe metadata.

Example success:

```json
{
  "success": true,
  "data": {
    "provider": "kis",
    "dryRun": true,
    "state": "completed",
    "received": 2,
    "created": 0,
    "wouldCreate": 2,
    "skipped": 0,
    "failed": 0,
    "snapshots": [
      {
        "symbol": "005930",
        "sourceName": "kis_krx_realtime_trade",
        "state": "would_create",
        "assetId": "asset-id",
        "price": "70123.00000000",
        "effectiveAt": "2026-06-21T00:30:15.000Z"
      }
    ]
  }
}
```

Example disabled/skipped:

```json
{
  "success": true,
  "data": {
    "provider": "binance",
    "dryRun": true,
    "state": "skipped",
    "received": 0,
    "created": 0,
    "wouldCreate": 0,
    "skipped": 0,
    "failed": 1,
    "snapshots": [],
    "errorCode": "PROVIDER_INGESTION_DISABLED"
  }
}
```

Errors include:

- `400 INVALID_PROVIDER`
- `400 INVALID_SYMBOL`
- `400 INVALID_MAX_SNAPSHOTS`
- `400 INVALID_KIS_MODE`
- `401 UNAUTHORIZED`
- `403 OPERATOR_FORBIDDEN`

## Season Participant Moderation

All routes in this section require a valid Bearer access token and `role=operator` or `role=admin`.

Common policy:

- Uses the existing operator guard and `OperatorAuditLog`.
- Success and handled failure outcomes write safe audit metadata.
- Responses and audit metadata do not expose private ledgers, raw provider payloads, tokens, secrets, password hashes, or refresh-token hashes.
- These APIs do not mutate order, FX, wallet, position, cash-wallet, reward, or reward-fulfillment rows.
- Reward payout, reward revoke, and reward fulfillment processing are intentionally not part of season participant moderation.

### POST /api/v1/operator/seasons/:seasonId/participants/:seasonParticipantId/exclude

Purpose: exclude a season participant from further season activity after abuse review.

Body:

```json
{
  "reason": "abuse_detected",
  "note": "optional operator note"
}
```

Success:

```json
{
  "success": true,
  "data": {
    "seasonId": "season-id",
    "seasonParticipantId": "season-participant-id",
    "status": "excluded",
    "excludedAt": "2026-06-21T00:00:00.000Z",
    "reason": "abuse_detected"
  }
}
```

Policy:

- Only `active` and `ended` seasons can use general exclusion. `settled` seasons must use final result correction instead.
- Exclusion sets `participantStatus=excluded`, stores the operator/reason/timestamp, and clears `currentRank`.
- Existing orders, FX transactions, wallets, positions, and ledger rows remain intact.
- Excluded participants are blocked from new order quote/create/execute and FX quote/execute.
- Ranking refresh, season ranking job, and settlement use participant-status allowlists that exclude `excluded`.
- Public ranking and public user summaries do not expose excluded participant ranking/summary data.

Errors include:

- `401 UNAUTHORIZED`
- `403 OPERATOR_FORBIDDEN`
- `404 SEASON_PARTICIPANT_NOT_FOUND`
- `409 PARTICIPANT_ALREADY_EXCLUDED`
- `409 PARTICIPANT_EXCLUDE_NOT_ALLOWED`

### POST /api/v1/operator/seasons/:seasonId/participants/:seasonParticipantId/hide-ranking

Purpose: hide or unhide a participant's ranking exposure without deleting the original ranking rows.

Body:

```json
{
  "hidden": true,
  "reason": "policy_violation",
  "note": "optional operator note"
}
```

Set `"hidden": false` to unhide.

Success:

```json
{
  "success": true,
  "data": {
    "seasonId": "season-id",
    "seasonParticipantId": "season-participant-id",
    "rankingHidden": true,
    "rankingHiddenAt": "2026-06-21T00:00:00.000Z",
    "reason": "policy_violation"
  }
}
```

Policy:

- Hiding stores `rankingHiddenAt`, reason, and operator id on `season_participants`.
- Unhiding clears the hidden fields.
- Original `season_rankings` rows are not deleted.
- Public `/api/v1/ranking`, public records summary, and `/api/v1/users/:userId/season-summary` exclude hidden participants or return a safe unavailable/hidden state.

### PATCH /api/v1/operator/seasons/:seasonId/participants/:seasonParticipantId/final-result

Purpose: correct verified final season result display fields after review.

Body:

```json
{
  "finalRank": 12,
  "finalTier": "gold",
  "reason": "manual_review_adjustment",
  "note": "optional operator note"
}
```

Success:

```json
{
  "success": true,
  "data": {
    "seasonId": "season-id",
    "seasonParticipantId": "season-participant-id",
    "finalRank": 12,
    "finalTier": "gold",
    "updatedAt": "2026-06-21T00:00:00.000Z"
  }
}
```

Policy:

- Only `ended` and `settled` seasons allow final result correction.
- Updates `season_participants.finalRank`, `season_participants.finalTier`, and `currentRank` when `finalRank` is supplied.
- Updates the latest matching `season_rankings.rankType=final` row rank when present, or creates a final ranking row from current participant totals if a final row is missing and `finalRank` is supplied.
- Rank conflicts return `FINAL_RANK_CONFLICT`; the existing unique rank policy is preserved.
- Correction audit metadata records old/new finalRank/finalTier/currentRank and final ranking row action.
- No reward payout/revoke or reward fulfillment mutation is performed.

## Admin User Management

All routes in this section require a valid Bearer access token. The access-token guard reads current DB `User.status` and `User.role` on every request, so role changes apply to existing access tokens on the next request.

Admin-only policy:

- `admin` can list users, get one user, change a target user's role, change a target user's status, and restore deleted users.
- `operator` cannot list users, change roles, change status, or restore users.
- `user` cannot list users, change roles, change status, or restore users.
- Missing, invalid, expired, or malformed bearer token returns `401 UNAUTHORIZED`.
- Suspended or deleted actors are blocked before management logic with the existing `403 USER_NOT_ACTIVE`.

### GET /api/v1/operator/users

Purpose: admin-only operational user list.

Query:

- `role` optional: `user`, `operator`, `admin`
- `status` optional: `active`, `suspended`, `deleted`
- `search` optional: email/nickname partial match
- `limit` optional: default `20`, max `100`
- `offset` optional: default `0`

Response:

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "user-id",
        "email": "user@example.com",
        "nickname": "traderKim",
        "status": "active",
        "role": "operator",
        "createdAt": "2026-06-09T00:00:00.000Z",
        "updatedAt": "2026-06-09T00:00:00.000Z"
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1,
      "returned": 1,
      "nextOffset": null
    }
  }
}
```

Password hashes, refresh tokens, access tokens, secret env values, and raw provider payloads are not selected or returned.

### GET /api/v1/operator/users/:userId

Purpose: admin-only single user operational lookup.

Response:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "status": "active",
      "role": "user",
      "createdAt": "2026-06-09T00:00:00.000Z",
      "updatedAt": "2026-06-09T00:00:00.000Z"
    }
  }
}
```

Missing target returns `TARGET_USER_NOT_FOUND`.

### PATCH /api/v1/operator/users/:userId/role

Purpose: admin-only explicit user role change.

Body:

```json
{
  "role": "user | operator | admin",
  "reason": "optional string"
}
```

Success:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "status": "active",
      "role": "operator",
      "createdAt": "2026-06-09T00:00:00.000Z",
      "updatedAt": "2026-06-09T00:00:01.000Z"
    },
    "roleChange": {
      "beforeRole": "user",
      "afterRole": "operator",
      "reason": "optional string or null"
    }
  }
}
```

Validation:

- Only `admin` can change roles; non-admin active actors receive `ADMIN_REQUIRED`.
- Invalid role returns `INVALID_USER_ROLE`.
- Target not found returns `TARGET_USER_NOT_FOUND`.
- Admin cannot change their own role: `CANNOT_CHANGE_OWN_ROLE`.
- Last active admin cannot be demoted to `user` or `operator`: `LAST_ADMIN_ROLE_CHANGE_FORBIDDEN`.
- Last-admin protection counts only active admin users.
- Deleted target direct role change is forbidden: `TARGET_USER_DELETED`.
- Suspended `user` cannot be promoted to `operator` or `admin`: `TARGET_USER_SUSPENDED_PROMOTION_FORBIDDEN`.
- Suspended `operator` or `admin` can be demoted to `user`.
- Same-role request returns `ROLE_ALREADY_ASSIGNED`.

Role update and success audit are written in the same transaction. If the success audit insert fails, the role update rolls back and the API returns `OPERATOR_ROLE_CHANGE_FAILED`. Failure audits are best-effort and must not mask the original error.

### PATCH /api/v1/operator/users/:userId/status

Purpose: admin-only explicit user status change.

Body:

```json
{
  "status": "active | suspended | deleted",
  "reason": "optional string"
}
```

Success:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "status": "suspended",
      "role": "user",
      "createdAt": "2026-06-09T00:00:00.000Z",
      "updatedAt": "2026-06-09T00:00:01.000Z"
    },
    "statusChange": {
      "beforeStatus": "active",
      "afterStatus": "suspended",
      "beforeRole": "user",
      "afterRole": "user",
      "reason": "optional string or null",
      "revokedRefreshSessionCount": 1
    }
  }
}
```

Validation:

- Only `admin` can change status; non-admin active actors receive `ADMIN_REQUIRED`.
- Invalid status returns `INVALID_USER_STATUS`.
- Target not found returns `TARGET_USER_NOT_FOUND`.
- Admin cannot change their own status: `CANNOT_CHANGE_OWN_STATUS`.
- Last active admin cannot be suspended or deleted: `LAST_ADMIN_STATUS_CHANGE_FORBIDDEN`.
- Last-admin protection counts only `status=active AND role=admin`.
- Same-status request returns `USER_STATUS_ALREADY_ASSIGNED`.
- Deleted users cannot be restored through status patch: `USE_RESTORE_ENDPOINT`.
- `active -> suspended`, `suspended -> active`, and `active/suspended -> deleted` are allowed.
- Delete forces target `role=user`.
- Suspend preserves role.
- Suspend/delete revoke active refresh token sessions.
- Restore does not happen in this endpoint.

Status update and success audit are written in the same transaction. If success audit insert fails, the status update rolls back and the API returns `USER_STATUS_CHANGE_FAILED`. Failure audits are best-effort and must not mask the original error.

### POST /api/v1/operator/users/:userId/restore

Purpose: admin-only deleted user restore.

Body:

```json
{
  "reason": "optional string"
}
```

Success:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "status": "active",
      "role": "user",
      "createdAt": "2026-06-09T00:00:00.000Z",
      "updatedAt": "2026-06-09T00:00:01.000Z"
    },
    "restore": {
      "beforeStatus": "deleted",
      "afterStatus": "active",
      "beforeRole": "admin",
      "afterRole": "user",
      "reason": "optional string or null"
    }
  }
}
```

Validation:

- Only `admin` can restore users; non-admin active actors receive `ADMIN_REQUIRED`.
- Target not found returns `TARGET_USER_NOT_FOUND`.
- Admin cannot restore their own user id: `CANNOT_CHANGE_OWN_STATUS`.
- Target must be deleted, otherwise `USER_RESTORE_NOT_ALLOWED`.
- Restore always sets `status=active` and `role=user`.
- Restore never performs role promotion. If `operator` or `admin` role is needed after restore, admin must submit a separate role-change request, producing a separate audit event.
- Restore does not reactivate revoked refresh token sessions.

Restore update and success audit are written in the same transaction. If success audit insert fails, the restore update rolls back and the API returns `USER_RESTORE_FAILED`. Failure audits are best-effort and must not mask the original error.

## Operator Audit Log Foundation

Prisma model/table:

- `OperatorAuditLog` / `operator_audit_logs`

Fields:

- `actorUserId`
- `actorRole`
- `action`
- `targetType`
- `targetId`
- `requestId`
- `ipAddress`
- `userAgent`
- `metadataJson`
- `result`: `success` or `failure`
- `errorCode`
- `createdAt`

Audit metadata must not store secrets. The service redacts secret-like keys and sensitive strings such as API keys, app secrets, approval keys, access tokens, refresh tokens, `DATABASE_URL`, authorization headers, and raw provider payload fields.

Admin account-management actions:

- `operator.users.list`
- `operator.users.get`
- `operator.user_role.update`
- `operator.user_role.update.failed`
- `operator.user_status.update`
- `operator.user_status.update.failed`
- `operator.user_restore`
- `operator.user_restore.failed`

Role-change success metadata contains only safe fields such as `targetUserId`, `actorUserId`, `beforeRole`, `afterRole`, `reason`, and `requestId`. Role-change failure metadata contains only safe fields such as `targetUserId`, `actorUserId`, `requestedRole`, `reason`, `failureCode`, and `requestId`. Raw request body, `passwordHash`, refresh token, access token, raw provider payload, env, and secret values must not be stored.

Status/restore success metadata contains only safe fields such as `targetUserId`, `actorUserId`, `beforeStatus`, `afterStatus`, `beforeRole`, `afterRole`, `reason`, `requestId`, and `revokedRefreshSessionCount`. Status/restore failure metadata contains only safe fields such as `targetUserId`, `actorUserId`, `requestedStatus`, `reason`, `failureCode`, and `requestId`. Raw request body, `passwordHash`, refresh token, access token, raw provider payload, env, and secret values must not be stored.

## Market Session Override Management

Operator-managed exception layer over the static per-year market calendar
datasets (`backend/src/orders/market-calendar/data`). Lets operators register
emergency closures, forced regular sessions, delayed opens, and early/extended
closes without a redeploy. No external calendar API (KIS holiday, Alpaca
Calendar, EODHD, …) is used and no related env vars exist — the static
datasets stay the base data and the DB layer only holds exceptions.

Effective schedule precedence for one exchange-local date:

1. Active DB override (`market_session_overrides`, `is_active = true`)
2. Static per-year dataset entry
3. No dataset for that year → `calendar_unavailable` (fail-closed)

A DB override never grants calendar coverage for its year: a 2028 override
does not make 2028 servable while the 2028 static dataset is missing (the
response's `calendarYearCovered: false` surfaces this). Coverage years follow
the existing Asia/Seoul-based readiness rule (previous year → next year).

`overrideType` semantics:

- `regular`: cancels the static closure/session change for that date and
  forces the default session (KRX 09:00–15:30 KST, US 09:30–16:00 ET).
  Internally distinct from "no override".
- `closed`: full-day closure. No provider candle calls, no candles/gaps, no
  daily bar; the day counts as zero sessions.
- `custom`: explicit exchange-local `openTime`/`closeTime` (both required,
  `openTime < closeTime`). Covers delayed opens and early/extended closes.

Field rules:

- `market`: `KRX` or `US`. Crypto is 24h and never uses this calendar.
- `localDate`: exchange-local trading date `YYYY-MM-DD` (KRX: Asia/Seoul,
  US: America/New_York), stored as text so the local meaning never shifts.
- `openTime`/`closeTime`: accepted as `HH:mm` or `HH:mm:ss`; normalized to a
  canonical compact `HHmmss` in storage (same format as the static datasets)
  and returned as `HH:mm:ss`.
- `reason` (required, ≤200 chars), `source` (optional, ≤500 chars).
- `regular`/`custom` on a Saturday/Sunday are rejected
  (`MARKET_SESSION_OVERRIDE_WEEKEND_UNSUPPORTED`) because sessions never open
  on weekends; a weekend `closed` is accepted as a harmless annotation.
- One override per `market` + `localDate` (DB unique constraint; a concurrent
  duplicate maps to `MARKET_SESSION_OVERRIDE_CONFLICT`, HTTP 409).
- Overrides are deactivated, never deleted, to preserve operational history.

### Auth

- `OperatorGuard`: `operator` and `admin` roles only.

### GET /api/v1/operator/market-session-overrides

Query: `market` (optional), `from`/`to` (optional `YYYY-MM-DD` range on
`localDate`; must be real calendar dates — `2026-02-30`/`2026-99-99` are
rejected with `INVALID_OVERRIDE_QUERY`), `includeInactive` (default
`false`). Returns up to 1,000 rows ordered by `localDate`.

### GET /api/v1/operator/market-session-overrides/:overrideId

Single override or `MARKET_SESSION_OVERRIDE_NOT_FOUND` (404).

### POST /api/v1/operator/market-session-overrides

Upsert by `market` + `localDate`: creates the override, or replaces the
existing row's schedule fields and reactivates it if it was inactive.

Request example (KRX emergency closure):

```json
{
  "market": "KRX",
  "localDate": "2026-07-21",
  "overrideType": "closed",
  "reason": "긴급 휴장: 시스템 장애",
  "source": "KRX notice 2026-123"
}
```

Request example (US delayed open):

```json
{
  "market": "US",
  "localDate": "2026-07-22",
  "overrideType": "custom",
  "openTime": "10:30",
  "closeTime": "16:00",
  "reason": "exchange delayed open",
  "source": "NYSE notice"
}
```

Response example:

```json
{
  "success": true,
  "data": {
    "created": true,
    "runtimeApplied": true,
    "override": {
      "id": "…",
      "market": "KRX",
      "localDate": "2026-07-21",
      "overrideType": "closed",
      "openTime": null,
      "closeTime": null,
      "reason": "긴급 휴장: 시스템 장애",
      "source": "KRX notice 2026-123",
      "isActive": true,
      "calendarYearCovered": true,
      "createdByUserId": "…",
      "updatedByUserId": "…",
      "createdAt": "…",
      "updatedAt": "…"
    }
  }
}
```

`runtimeApplied: true` is returned only when a DB re-read that STARTED after
the mutation committed succeeded and was applied to this instance's in-memory
snapshot — a mutation never merely joins a refresh that was already in flight
(whose query may predate the commit). On `false` the mutation is committed
but not yet applied on this instance; the bounded polling applies it within
the propagation window below, and a `.runtime_refresh_failed` audit entry
records the miss.

### PATCH /api/v1/operator/market-session-overrides/:overrideId

Partial update of `overrideType`, `openTime`, `closeTime`, `reason`,
`source`. The merged result is re-validated (switching to `regular`/`closed`
clears stored times; switching to `custom` requires both times).

### POST /api/v1/operator/market-session-overrides/:overrideId/deactivate

Marks the override inactive (`MARKET_SESSION_OVERRIDE_ALREADY_INACTIVE`, 409,
if it already is). Optional `note` for the audit trail.

### POST /api/v1/operator/market-session-overrides/:overrideId/reactivate

Re-enables an inactive override (`MARKET_SESSION_OVERRIDE_ALREADY_ACTIVE`,
409, if it already is active).

### Runtime propagation

- Each backend instance loads active overrides at startup and re-polls every
  60 seconds (`MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS`); the mutating
  instance refreshes immediately after commit. Maximum cross-instance
  staleness is therefore ~60s + one query round-trip. Register emergency
  closures at least a minute ahead when multiple instances are running.
- Refreshes are serialized within an instance: a mutation-triggered refresh
  that arrives while a polling refresh is in flight queues exactly ONE
  follow-up DB read that starts after the in-flight one finishes, and all
  mutations arriving in that window share it. Every `refreshNow` caller is
  therefore guaranteed a read that started at or after its call (so a commit
  made before the call is always observed), without a per-caller query storm.
  Change listeners/candle-cache invalidation still fire only on real content
  changes (schedule fingerprint diff), so back-to-back refreshes with
  identical data never invalidate twice.
- If the cold-start load fails, the process logs
  `market_session_override_cold_start_load_failed` and the stock calendar
  fails closed (`calendar_unavailable` → not tradable, `marketStatus`
  `unknown`) until the first successful load (retried every 5s). The app
  never silently serves static-only schedules while DB overrides may exist.
  Readiness reports this as `MARKET_SESSION_OVERRIDE_NOT_LOADED` (before the
  first attempt completes) or `MARKET_SESSION_OVERRIDE_UNAVAILABLE`
  (cold-start failure), both `degraded`.
- If a later refresh fails, the last-known-good snapshot stays active and a
  structured `market_session_override_refresh_failed` warning is logged.
  "Last-known-good" means: stock-session decisions keep using the most
  recent successfully loaded snapshot (possibly stale within the polling
  window) instead of failing closed; readiness reports
  `MARKET_SESSION_OVERRIDE_LAST_KNOWN_GOOD` (`degraded`) until a refresh
  succeeds again. Crypto is unaffected in every one of these states.
- On snapshot changes the per-asset candle cache generation for the affected
  market's assets is bumped (`market_session_override_candle_cache_invalidated`).

### Audit actions

- `operator.market_session_override.upsert` (+ `.failed`, `.runtime_refresh_failed`)
- `operator.market_session_override.update` (+ `.failed`, `.runtime_refresh_failed`)
- `operator.market_session_override.deactivate` (+ `.failed`, `.runtime_refresh_failed`)
- `operator.market_session_override.reactivate` (+ `.failed`, `.runtime_refresh_failed`)

Every mutation attempt by an authenticated operator is audited, including
requests that fail input validation (invalid market, malformed or
nonexistent dates, invalid or mis-ordered times, invalid ids/notes) — input
parsing runs inside the audited path, and the `.failed` entry carries the
action, actor, target identification, and the sanitized `failureCode`.
Validation-failure metadata echoes only short identifying scalars
(market/localDate/overrideType or the override id), never raw request
bodies, free-form text from unparsed input, secrets, or tokens. If writing
the failure audit itself fails, the original API error is still returned
unchanged.

Success metadata contains `market`, `localDate`, `before`/`after` schedule
values, `reason`, `note`, and `requestId`; mutation and success audit share
one transaction. `.runtime_refresh_failed` is a best-effort post-commit
entry (errorCode `MARKET_SESSION_OVERRIDE_RUNTIME_REFRESH_FAILED`) written
when the committed mutation could not be applied to this instance's runtime
snapshot (`runtimeApplied: false`); bounded polling recovers it. No secrets
or unnecessary personal data are stored.

Announcements/notices to end users are a separate operational procedure —
this API only changes the trading calendar, it does not publish notices.

## Not Implemented In This MVP

- HTTP batch execution API.
- Provider ingestion trigger API.
- External reward fulfillment provider API.
- Scheduler HTTP API or production cron business automation beyond the disabled-by-default internal foundation.
- Provider ingestion trigger API or operator API for provider source eligibility changes.
- Trading calculation, order, FX, portfolio, ranking, settlement, external reward fulfillment, real account, real balance, real deposit/withdrawal, or external order API changes.

## Next Gate

Recommended next gate: Reward Policy / Reward Catalog Gate, Production Scheduler Ownership Gate, or Backend Release / Operations Runbook Gate. This is separate from Provider API Source Eligibility Implementation Gate.
