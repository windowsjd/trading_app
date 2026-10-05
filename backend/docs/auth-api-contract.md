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
  - `PATCH /api/v1/me`
  - `POST /api/v1/me/profile-image`
  - `DELETE /api/v1/me/profile-image`
- Access tokens remain stateless Bearer JWTs verified by the global access token guard.
- Protected API identity remains `request.user.userId`; the guard also attaches current DB `role` for operator/admin authorization.
- `x-user-id` fallback is not supported.
- Cookie/session auth is not part of this MVP.
- Access token blacklist/revocation is not part of this MVP.
- This contract is unrelated to provider/API key, trading, scheduler, settlement, or reward work.

## User Role And Status

- `UserStatus` is account lifecycle state: `active`, `suspended`, `deleted`.
- `UserRole` is authorization scope: `user`, `operator`, `admin`.
- New signup explicitly creates `role=user`.
- `operator` and `admin` can use regular protected user APIs with their token-derived user id.
- `operator` and `admin` can use operator-only APIs; `admin` includes operator permissions.
- `user` cannot use operator-only APIs.
- Admin-only account management APIs exist under `GET /api/v1/operator/users`, `GET /api/v1/operator/users/:userId`, `PATCH /api/v1/operator/users/:userId/role`, `PATCH /api/v1/operator/users/:userId/status`, and `POST /api/v1/operator/users/:userId/restore`. `operator` and `user` cannot use them.
- Role and status decisions use the current DB user read by the access-token guard. A role-like JWT claim is not trusted.
- Admin suspend/delete status changes revoke active refresh token sessions for the target user.
- Deleted user restore does not reactivate revoked refresh token sessions and always restores `role=user`.

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

Both responses include the existing user payload and token envelope. The signup default role is `user`, but role is not added to this auth response envelope in this MVP:

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

## Operator Boundary

`GET /api/v1/operator/me` is documented separately in `docs/operator-api-contract.md`.

## Friend portfolio privacy

`GET /api/v1/me` and `PATCH /api/v1/me` include `portfolioPublic: boolean`.
It defaults to true in PostgreSQL for both existing and new users. PATCH accepts
only a Boolean, including an explicit false; strings, numbers and null fail
with `VALIDATION_ERROR`. Nickname updates keep their existing contract.
This setting shares a current active-season portfolio with accepted friends
only. See [friend policy](friends-api-contract.md).

## Managed profile image

`User.profileImageUrl` in PostgreSQL remains the display source of truth. It is
read-only in `PATCH /me`: including it (even null) returns `400
PROFILE_IMAGE_READ_ONLY`, without applying other fields. Nickname and
portfolioPublic remain writable. Existing external URLs remain displayable.

Both image routes require the existing Bearer access-token guard and use only
`request.user.userId`. They return `200` with the same `success/data`
CurrentUserResponse as `GET /me`, including the persisted profileImageUrl.

- `POST /api/v1/me/profile-image`: multipart/form-data with exactly one `file`
  part, no text fields. Maximum 2 MiB (2,097,152 bytes). Only image/jpeg with
  JPEG signature, bounded segment/scan structure, and square dimensions of
  1–512 px is accepted. SVG, fake MIME, truncated JPEGs and trailing bytes are
  rejected. APP/COM JPEG metadata segments are stripped before storage;
  there is no full server-side pixel decode/re-encode.
- `DELETE /api/v1/me/profile-image`: no body. Sets the DB URL to null before
  best-effort object deletion; repeated deletion succeeds with null.

Files remain in memory during validation and proxy upload, then go to configured
S3-compatible object storage. No server disk, binary DB column, presigned upload,
image history, migration, or new table is used. Keys are
`profile-images/{authenticatedUserId}/{serverUUIDv4}.jpg`; original filenames
are ignored. URLs are generated from the configured public base, never a client
URL. Objects use `Content-Type: image/jpeg` and `Cache-Control: public,
max-age=31536000, immutable`.

Replacement: read active user → upload new object → lock user row in a short DB
transaction → update URL → commit → best-effort remove the previous managed
object. The lock captures the latest URL across concurrent uploads/deletes and
instances. No storage request runs inside a DB transaction. A failed DB write
removes the new object best-effort and preserves the previous URL. A failed or
ambiguous upload also attempts new-object cleanup. Cleanup failure never rolls
back a successful DB change and logs only a bounded event/operation/userId.

Deletion: lock user row → set null → commit → best-effort remove old managed
object. DB failure leaves the object untouched. Storage deletion failure leaves
the public profile cleared, with an orphan recorded in the server log. Only an
exact configured public URL and the same user's strict generated-key pattern
qualify for deletion. External/legacy URLs, other users' keys, URL aliases,
query strings, fragments and encoded/traversal paths are never requested.

Errors follow the existing `{ success: false, error: { code, message } }` shape:

| HTTP | Code | Condition |
| --- | --- | --- |
| 401 | UNAUTHORIZED | Missing/invalid auth or missing user |
| 403 | USER_NOT_ACTIVE | Suspended/deleted user |
| 400 | PROFILE_IMAGE_REQUIRED | Missing file |
| 413 | PROFILE_IMAGE_TOO_LARGE | File exceeds 2 MiB |
| 400 | INVALID_PROFILE_IMAGE | MIME/bytes/dimensions/multipart invalid |
| 400 | PROFILE_IMAGE_READ_ONLY | profileImageUrl supplied to PATCH /me |
| 503 | PROFILE_IMAGE_STORAGE_UNAVAILABLE | Storage entirely unconfigured |
| 503 | PROFILE_IMAGE_UPLOAD_FAILED | Storage upload failed |
| 500 | INTERNAL_SERVER_ERROR | DB write failed |

All six environment variables below are required together. All absent/blank
disables image upload/delete only (503); partial or malformed configuration
fails startup through the central environment validator. Existing reads and
other profile/auth APIs work with storage disabled. Error messages never contain
credentials, binary data, raw provider errors, or internal URLs.

- PROFILE_IMAGE_STORAGE_ENDPOINT: explicit HTTP(S) S3-compatible API endpoint.
- PROFILE_IMAGE_STORAGE_REGION: provider region (`auto` for R2).
- PROFILE_IMAGE_STORAGE_BUCKET: dedicated bucket name.
- PROFILE_IMAGE_STORAGE_ACCESS_KEY_ID: backend-only access credential.
- PROFILE_IMAGE_STORAGE_SECRET_ACCESS_KEY: backend-only secret.
- PROFILE_IMAGE_PUBLIC_BASE_URL: public HTTP(S) host/base path mapping to bucket
  root; HTTPS in production, no credentials/query/fragment.

The frontend selects one library image, uses native square editing when
available, then corrects any nonsquare output and re-encodes JPEG at quality
0.85, maximum 512 px, without upscaling. Web uses Expo's file chooser and center
crop. Android uses the system image picker without broad library permissions;
sources over 32 MiB or 40 million pixels are refused before manipulation.
iOS requests photo access for native editing, including limited access.
Cancel/denial/failure preserve the prior photo. Settings is the only edit
surface. Successful changes update `/me` cache immediately and invalidate
ranking lists/self-summary. Friends DTOs exclude the viewer, and record
list/detail DTOs contain no avatar, so those caches are unchanged. Other devices
see new URLs on next fetch.

Deployment: provision a bucket and a public CDN/custom host with GET access only
to `profile-images/*` (R2 public custom domain or a dedicated public-assets
bucket, S3 CDN/or scoped read policy). Grant the backend only PutObject and
DeleteObject for this prefix. No client storage credential or write access is
needed. Browser uploads go to the backend, so storage upload CORS is unnecessary;
retain backend's configured allowed frontend origins. Verify public GET MIME
and cache headers after deployment. Immutable URLs can remain in browser/CDN
caches until expiry even after origin deletion; deleting a photo removes it
from app identity responses immediately. Orphan cleanup/CDN purge after
persistent cleanup failures is an operational follow-up, not a new worker.

Native deployment: the new Expo picker/manipulator modules require rebuilding
existing development clients and release binaries. Apply the image-picker Expo
config plugin during native generation; its Korean Photos permission description
is required on iOS. Camera/microphone permissions are disabled, including explicit
Android manifest merge removals. Actual iOS/Android permission, editing, orientation,
cancel and upload behavior still requires device validation; passing Web export
does not verify native behavior.

SDK references: [Expo image picker](https://docs.expo.dev/versions/v55.0.0/sdk/imagepicker/),
[Expo image manipulator](https://docs.expo.dev/versions/v55.0.0/sdk/imagemanipulator/),
[Nest multipart upload](https://docs.nestjs.com/techniques/file-upload),
[S3 PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).
