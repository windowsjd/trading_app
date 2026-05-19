# Auth API Contract

Auth is an access token + opaque refresh token MVP.

## Scope

- Implemented:
  - `POST /api/v1/auth/signup`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/refresh`
  - `POST /api/v1/auth/logout`
  - `POST /api/v1/auth/logout-all`
  - `GET /api/v1/me`
- Access tokens remain stateless Bearer JWTs verified by the global access token guard.
- Protected API identity remains `request.user.userId`.
- `x-user-id` fallback is not supported.
- Cookie/session auth is not part of this MVP.
- Access token blacklist/revocation is not part of this MVP.
- This contract is unrelated to provider/API key, trading, scheduler, settlement, or reward work.

## Environment

- `JWT_ACCESS_SECRET`: required access-token signing and verification secret. Missing value fails closed.
- `JWT_ACCESS_TTL`: access-token lifetime. Default remains `15m` when omitted.
- `REFRESH_TOKEN_TTL`: required refresh-token lifetime. Missing value fails closed.

TTL values must be a positive number plus one allowed unit with no spaces.

- Allowed units: `s`, `m`, `h`, `d`, `w`
- Common refresh examples: `7d`, `14d`, `30d`
- Rejected examples: `900`, `15 d`, `15 m`, `500ms`, `1y`, empty string

## Token Storage

- Refresh tokens are opaque random tokens generated from Node.js `crypto.randomBytes`.
- Raw refresh tokens are returned to the client only once and are never stored in the database.
- The database stores only a SHA-256 `tokenHash`.
- Refresh sessions are stored in `refresh_token_sessions`.
- Session statuses are `active` and `revoked`.

## Signup And Login

`POST /api/v1/auth/signup` remains `201 Created`.

`POST /api/v1/auth/login` remains `200 OK`.

Both responses include the existing user payload and token envelope:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "status": "active"
    },
    "tokens": {
      "accessToken": "<jwt>",
      "refreshToken": "<opaque-token>",
      "accessTokenExpiresIn": "15m",
      "refreshTokenExpiresAt": "2026-05-26T00:00:00.000Z"
    }
  }
}
```

Inactive users keep the existing policy:

- Unknown or invalid credentials: `401` + `INVALID_CREDENTIALS`
- `suspended` or `deleted`: `403` + `USER_NOT_ACTIVE`

## Refresh

`POST /api/v1/auth/refresh` is public and accepts:

```json
{
  "refreshToken": "<opaque-token>"
}
```

Failure cases return `401` + `INVALID_REFRESH_TOKEN` when the token is missing, malformed, unknown, revoked, expired, or loses the rotation race.

If the refresh session's user is `suspended` or `deleted`, the existing inactive-user policy applies: `403` + `USER_NOT_ACTIVE`.

Successful refresh uses rotation:

- The old active refresh session is revoked.
- A new active refresh session is created.
- A new access token and a new refresh token are returned.
- Old refresh token reuse must fail.
- The revoke/create rotation DB writes run in one Prisma transaction.

## Logout

`POST /api/v1/auth/logout` is public so the frontend can log out with an expired access token.

It accepts a refresh token body and revokes the matching active refresh session when present. Logout is idempotent: unknown, already revoked, or expired sessions still return success and do not reveal token existence.

```json
{
  "success": true,
  "data": {
    "revoked": true
  }
}
```

## Logout All

`POST /api/v1/auth/logout-all` is protected by the access token guard.

It revokes all active refresh sessions for `request.user.userId`.

- Missing access token: `401` + `UNAUTHORIZED`
- `x-user-id` only: `401` + `UNAUTHORIZED`
- Current access token remains valid until JWT expiry because access token blacklist is not implemented in this MVP.
