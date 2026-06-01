# Operator API Contract

## Status

- Admin/operator authorization foundation MVP is implemented.
- `GET /api/v1/operator/me` is implemented as the minimal operator smoke endpoint.
- `OperatorAuditLog` foundation is implemented as an internal service/model for future operator mutations.
- No admin role-management API exists in this MVP.
- No provider ingestion trigger, batch run trigger, scheduler/cron, reward fulfillment trigger, real trading/account/balance, deposit/withdrawal, or external order API exists.
- `provider_api` source eligibility remains closed.

## Role Model

`UserRole` is an authorization role:

- `user`: default signup role.
- `operator`: can use operator-only service/API boundaries.
- `admin`: includes operator permissions and is reserved for future account/role management gates.

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

## Not Implemented In This MVP

- Admin/operator account management API.
- HTTP batch execution API.
- Provider ingestion trigger API.
- Reward fulfillment trigger API.
- Scheduler/cron.
- Provider_api source eligibility.
- Trading calculation, order, FX, portfolio, ranking, settlement, reward fulfillment, real account, real balance, real deposit/withdrawal, or external order API changes.

## Next Gate

Recommended next gate: Operator/Admin Account Management Gate or Scheduler/Ops Foundation Gate. This is separate from Provider API Source Eligibility Implementation Gate.
