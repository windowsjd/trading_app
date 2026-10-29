# Auth API Contract

Auth is an access token + opaque refresh token MVP.

## Email verification and password recovery (2026-10-18)

Signup now requires email ownership evidence. Existing users can log in without
verification; their `emailVerifiedAt` remains null until they actually verify.
All paths remain under `/api/v1`, all public POSTs below return `200` except
final signup (`201`). Bodies and responses use the existing success/data envelope.

| Path after `/auth` | Request | Success data |
| --- | --- | --- |
| `/email/request` | `{ email, purpose: "signup", "password_reset" or "account_deletion" }` | `{ challengeId, expiresAt, resendAt, serverTime, message }` |
| `/email/verify` | `{ email, purpose, challengeId, code }` | `{ verificationToken, expiresAt, serverTime }` |
| `/signup` | `{ email, nickname, password, verificationToken, ageConfirmed: true, termsVersion }` | Existing user/tokens envelope |
| `/password/reset` | `{ email, password, verificationToken }` | `{ changed: true }` (no login tokens) |

One challenge table stores all supported purposes, delivery status, attempts and a
single-use proof hash. A separate small PostgreSQL rate bucket table stores IP
budgets. No pending User, financial account or Refresh Session is created.
Codes use crypto.randomInt, six zero-padded digits, HMAC-SHA256 with a dedicated
server secret and challenge/email/purpose context; raw codes never persist.
Proofs use 32 random bytes, SHA-256 at rest, purpose/email/target account binding,
and a ten-minute lifetime. Verification consumes the code; final completion
consumes the proof in the same transaction as user/session/password writes.

PostgreSQL transaction advisory locks serialize each email, including send,
verify and completion across server instances. Resend invalidates all previous
challenges/proofs for that email and purpose. The rolling email budget (shared
across purposes) is five reservations per hour, at least 60 seconds apart.
IP budgets: 30 sends/hour, 100 verifies/10 minutes, 30 completions/10 minutes.
Failed deliveries and unknown accounts also consume send budgets. Five wrong
codes exhaust a challenge. Expiry uses the database clock.

Request responses never disclose account existence/status. Only active existing
users receive reset mail; signup mail is sent only for unused emails.
`account_deletion` (2026-10-18, web account deletion — see
[account deletion contract](account-deletion-contract.md)) follows the reset
rules: active members only, proof bound to the member and its token version, a
dedicated subject and an irreversibility warning. A proof is accepted only by
the flow of its own purpose. Unknown,
inactive and delivery-failed reset requests have identical envelopes and a
minimum response duration exceeding the bounded provider timeout, with jitter.
There is no email/nickname conflict check before valid signup proof; the existing
409 conflict codes remain available to the verified email owner at completion.

Signup consent (2026-10-21). `ageConfirmed` must be exactly `true` (the app's only
checkbox, the required "[필수] 만 16세 이상입니다") and `termsVersion` must equal the
server's `CURRENT_TERMS_VERSION` (`src/auth/terms.constants.ts`, currently
`2026-10-20`); anything else — missing, `false`, the string `"true"`, another
version — is `400 AUTH_SIGNUP_CONSENT_REQUIRED` (one code for both). It is checked
with the other body fields, before the IP completion budget and before the email
proof is consumed: a refused request creates nothing and keeps its proof. There is
no birth date and no server-side age check. In the signup transaction the server
stores `users.terms_version`, `terms_accepted_at` and `age_confirmed_at`, both
timestamps from one server clock reading (never a client time). `terms_accepted_at`
means "signup completed on the screen that showed this terms version and the
notice 가입하면 이용약관과 개인정보처리방침에 동의한 것으로 봅니다" — there is no
terms checkbox. Members created earlier keep NULL (no backfill, no re-consent
gate). None of the three is returned by signup, login or `me`; account deletion
removes them with the user row. When the terms change, raise
`CURRENT_TERMS_VERSION` and the app's `TERMS_VERSION`
(`frontend/src/constants/legal.ts`) together: a server ahead of an app refuses that
app's signups (its error copy asks to update the app), an app ahead of the server
is refused until the server ships. Older apps that send neither field are refused
too, so the app ships before (or with) the server.

Password reset locks the target user, checks active status and issuance-time
token version, updates only passwordHash/emailVerifiedAt/tokenVersion, consumes
proof and revokes all Refresh Sessions atomically. Login and rotation also lock
that user so an overlapping reset cannot mint a surviving old-password session.
JWTs contain `tv`; legacy missing `tv` means zero, matching migration defaults.
The global guard compares current DB tokenVersion, rejecting old access tokens
immediately after reset. WebSocket handshake authentication applies the same
version check; ticker subscription/delivery behavior is unchanged. Existing
price-stream sockets are not forcibly terminated. Deployment alone does not
invalidate existing tokens.

`RESEND_API_KEY`, `EMAIL_FROM="Trading Class <admin@nanghwa.com>"` and
`EMAIL_VERIFICATION_SECRET` (at least 32 random characters, shared by replicas)
enable email. All absent disables email endpoints (503), never permits unverified
signup; partial/invalid config fails startup. No secret belongs in Expo env.
Resend uses HTTPS POST /emails, text and HTML, four-second timeout, no automatic
retry and a challenge-specific idempotency key. Provider bodies/errors are never
logged. See [Resend send API](https://resend.com/docs/api-reference/emails/send-email).

`AUTH_TRUST_PROXY_HOPS` defaults to 0. Configure a positive hop count only after
verifying the ingress topology and that clients cannot inject the trusted
forwarding suffix. The default uses the socket IP and fails conservatively
behind a proxy. Never blindly trust all X-Forwarded-For values.

Retention (2026-10-19): the existing Auth maintenance timer invokes
`EmailAuthCleanupService.runIfDue()` independently of profile storage config.
Each instance attempts one batch per hour (first attempt at the existing 23-second
startup phase). A PostgreSQL transaction advisory try-lock avoids concurrent
passes; row locks use SKIP LOCKED. One transaction deletes at most 500 challenges
and 500 IP buckets, with 100ms lock timeout, 2s statement timeout and 5s transaction
limit. Both code expiry and any proof expiry must be more than 24 hours old;
rate buckets must have expired more than 24 hours ago. Predicates are rechecked
when deleting, so a renewed budget is preserved. Only these two tables are
changed. Failure is caught and retried on the next minute tick, without stopping
profile cleanup or authentication. Fixed events and counts use the existing Nest
logger; no new table, enum, migration, worker service, queue or external cron.
No cleanup was executed against production during implementation.

Delivery diagnostics (2026-10-19): fixed `auth_email_delivery` events distinguish
`accepted`, `rejected`, `timeout`, and `network_error`. Acceptance means Resend
HTTP acceptance, never inbox receipt. Ineligible accounts skip send entirely and
produce no acceptance event. Configuration emits `auth_email_configuration`
with `disabled` or `invalid`; public configuration errors stay sanitized 503s
and startup validation still rejects invalid configuration. No provider response
body, exception message, email, code, proof, key, header, or IP enters these events.
Logging exceptions are swallowed without changing delivery/verification outcomes.

The provider timeout stays 4s, response padding stays 5–5.2s minimum (DB/network
work can exceed this), and the common frontend timeout stays 10s. Requests are
single-flight, without automatic retries. The UI keeps the initial-send action
only until a successful generic request response, then uses verify/resend actions.
A resend attempt immediately discards proof and blocks reuse of its previous code,
including on response loss; a conservative local 60s cooldown complements the
server's authoritative limits. Failed initial requests can be retried. Expired
or server-rejected proofs return to resend, never permit final completion.

Errors: `EMAIL_CODE_INVALID`, `EMAIL_CODE_EXPIRED`, `EMAIL_CODE_EXHAUSTED`,
`EMAIL_VERIFICATION_REQUIRED` (missing/invalid/used/expired proof),
`EMAIL_RATE_LIMITED` (429), `EMAIL_UNAVAILABLE` (503). Unknown and inactive
accounts share the same invalid-code/proof behavior. Network or ambiguous send
failure invalidates that challenge; user must resend after the cooldown.

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
- Access tokens are signed Bearer JWTs; the global guard checks current DB status, role and tokenVersion.
- Protected API identity remains `request.user.userId`; the guard also attaches current DB `role` for operator/admin authorization.
- Routes reachable without a token are pinned by `src/auth/route-access.spec.ts`: the public auth/health routes, optional-auth `GET /api/v1/seasons` and `/seasons/current`, and (guest browsing, 2026-10-30) optional-auth `GET /api/v1/assets`, `/assets/:assetId` and `/assets/:assetId/candles`, which serve only `GUEST_MARKET_DATA_ASSET_TYPES` (default none) to anonymous callers ([assets contract](assets-api-contract.md)).
- `x-user-id` fallback is not supported.
- Cookie/session auth is not part of this MVP.
- Password reset revokes access through per-user tokenVersion; no JWT blacklist is used.
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
- Self-service account deletion (2026-10-18, [account deletion contract](account-deletion-contract.md)) is NOT `status=deleted`: it removes the user row and every personal/virtual-trading row in one transaction, so restore answers `404 TARGET_USER_NOT_FOUND`. Anonymous settled-result placeholders (`@deleted-member.invalid`) answer `409 USER_RESTORE_NOT_ALLOWED`.

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

Both responses include the existing user payload (including role) and token envelope. The signup default role is `user`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "traderKim",
      "role": "user",
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

Replacement: read active user → reserve the new key in `profile_image_cleanups`
under the user row lock (10-minute lease) → upload new object → lock user row in
a short DB transaction → consume the reservation, update URL and enqueue the
previous managed object (due now) → commit → immediately try to remove the
previous object; a failure stays queued and `ProfileImageCleanupWorker` retries
it (2026-10-18, [account deletion contract](account-deletion-contract.md) §6). The lock captures the latest URL across concurrent uploads/deletes and
instances. No storage request runs inside a DB transaction. A failed DB write
removes the new object best-effort and preserves the previous URL. A failed or
ambiguous upload also attempts new-object cleanup. Cleanup failure never rolls
back a successful DB change; it stays queued for retry (logs carry no key).

Deletion: lock user row → set null and enqueue the old managed object → commit
→ remove it (retried by the worker on failure). DB failure leaves the object
untouched. Storage deletion failure leaves the public profile cleared and the
object queued until it is removed. Only an
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
