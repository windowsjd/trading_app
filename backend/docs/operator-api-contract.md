# Operator API Contract

## Status

- Admin/operator authorization foundation MVP is implemented.
- `GET /api/v1/operator/me` is implemented as the minimal operator smoke endpoint.
- `OperatorAuditLog` foundation is implemented as an internal service/model for future operator mutations.
- Admin/operator Account Management Gate is implemented for admin-only user list/get, explicit role changes, status changes, and deleted user restore.
- Season participant moderation APIs are implemented for operator/admin exclusion, ranking hide/unhide, and verified final result correction. Reward payout/revoke and reward fulfillment are outside this scope.
- Internal reward fulfillment operator/admin APIs are documented in `docs/rewards-api-contract.md`.
- No provider ingestion trigger, batch run trigger, scheduler HTTP API, external reward provider API, real trading/account/balance, deposit/withdrawal, or external order API exists. Scheduler/Ops foundation exists internally and is disabled by default.
- `provider_api` source eligibility is open only inside explicitly allowed services: read-only/quote services, `/fx execute`, orders execute, and the separate operator-run daily snapshot valuation job. No operator provider trigger, batch HTTP API, ranking/settlement/reward final workflow source eligibility, or real trading/account API is opened by this contract.

## Migration / Runtime Requirement

- Admin/operator authorization MVP requires schema migration `20260601090000_add_user_role_operator_audit_logs`.
- Admin status/restore and internal reward fulfillment require schema migration `20260609120000_add_user_status_restore_internal_reward_fulfillment`.
- Season participant moderation requires schema migration `20260621120000_add_season_participant_moderation`.
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

## Not Implemented In This MVP

- HTTP batch execution API.
- Provider ingestion trigger API.
- External reward fulfillment provider API.
- Scheduler HTTP API or production cron business automation beyond the disabled-by-default internal foundation.
- Provider ingestion trigger API or operator API for provider source eligibility changes.
- Trading calculation, order, FX, portfolio, ranking, settlement, external reward fulfillment, real account, real balance, real deposit/withdrawal, or external order API changes.

## Next Gate

Recommended next gate: Reward Policy / Reward Catalog Gate, Production Scheduler Ownership Gate, or Backend Release / Operations Runbook Gate. This is separate from Provider API Source Eligibility Implementation Gate.
