# Operator API Contract

## Status

- Admin/operator authorization foundation MVP is implemented.
- `GET /api/v1/operator/me` is implemented as the minimal operator smoke endpoint.
- `OperatorAuditLog` foundation is implemented as an internal service/model for future operator mutations.
- Admin/operator Account Management Gate is implemented for admin-only user list/get and explicit role changes.
- No provider ingestion trigger, batch run trigger, scheduler HTTP API, reward fulfillment trigger, real trading/account/balance, deposit/withdrawal, or external order API exists. Scheduler/Ops foundation exists internally and is disabled by default.
- `provider_api` source eligibility is open only inside explicitly allowed services: read-only/quote services, `/fx execute`, orders execute, and the separate operator-run daily snapshot valuation job. No operator provider trigger, batch HTTP API, ranking/settlement/reward final workflow source eligibility, or real trading/account API is opened by this contract.

## Migration / Runtime Requirement

- Admin/operator authorization MVP requires schema migration `20260601090000_add_user_role_operator_audit_logs`.
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

## Admin User Management

All routes in this section require a valid Bearer access token. The access-token guard reads current DB `User.status` and `User.role` on every request, so role changes apply to existing access tokens on the next request.

Admin-only policy:

- `admin` can list users, get one user, and change a target user's role.
- `operator` cannot list users and cannot change roles.
- `user` cannot list users and cannot change roles.
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

## Deleted User Restore Policy v1

- Deleted user role changes are forbidden in the role management API.
- Deleted user restore is a separate future Admin User Status / Restore Gate.
- Restore must not silently restore elevated privileges.
- On restore, role should default to `user`.
- If `operator` or `admin` role is needed after restore, admin must submit a separate explicit role-change request.
- Restore event and role promotion event must be audited separately.
- Deleted users are excluded from active-admin count.
- Last-admin protection counts only active admin users.

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

Role-change success metadata contains only safe fields such as `targetUserId`, `actorUserId`, `beforeRole`, `afterRole`, `reason`, and `requestId`. Role-change failure metadata contains only safe fields such as `targetUserId`, `actorUserId`, `requestedRole`, `reason`, `failureCode`, and `requestId`. Raw request body, `passwordHash`, refresh token, access token, raw provider payload, env, and secret values must not be stored.

## Not Implemented In This MVP

- Admin user restore/status management API.
- HTTP batch execution API.
- Provider ingestion trigger API.
- Reward fulfillment trigger API.
- Scheduler HTTP API or production cron business automation beyond the disabled-by-default internal foundation.
- Provider ingestion trigger API or operator API for provider source eligibility changes.
- Trading calculation, order, FX, portfolio, ranking, settlement, reward fulfillment, real account, real balance, real deposit/withdrawal, or external order API changes.

## Next Gate

Recommended next gate: Admin User Status / Restore Gate, Scheduler Production Ownership Gate, or Reward Fulfillment Backend Gate. This is separate from Provider API Source Eligibility Implementation Gate.
