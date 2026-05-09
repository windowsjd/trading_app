# Auth Preimplementation Readiness Audit

## 1. Purpose

This audit checks whether the current `main` workspace is ready to implement the auth body before changing any code.

Scope of this audit:

- Inspect the current controller/service auth assumption.
- Inspect Prisma schema readiness for user authentication.
- Inspect package readiness for token and password handling.
- Identify auth risks around existing financial write paths: `/api/v1/fx/execute` and `/api/v1/orders/:orderId/execute`.
- Propose the next implementation scope and tests.

Non-scope:

- No auth implementation.
- No code, schema, migration, seed, package, or test changes.
- No `x-user-id` fallback.
- No fake or mock user injection to bypass protected APIs.

## 2. Current Auth Assumption

Current protected API controllers assume an upstream auth layer will populate:

```ts
request.user?.userId
```

Controllers that read `request.user.userId`:

- `src/seasons/seasons.controller.ts`
- `src/fx/fx.controller.ts`
- `src/home/home.controller.ts`
- `src/ranking/ranking.controller.ts`
- `src/wallets/wallets.controller.ts`
- `src/records/records.controller.ts`
- `src/orders/orders.controller.ts`

Current auth implementation status:

- No `AuthModule` is wired in `src/app.module.ts`.
- No Nest auth guard, global `APP_GUARD`, middleware, interceptor, Passport strategy, or JWT verification layer was found in `src` excluding generated Prisma files.
- No signup/login controller or service was found.
- No `x-user-id` fallback exists in controllers.
- In a real HTTP request today, `request.user` is not populated by this repository. Protected service methods therefore receive `undefined` unless an external runtime layer injects the user object.

Current missing-user behavior:

- `POST /api/v1/seasons/:seasonId/join` rejects missing user with `UNAUTHORIZED`.
- `POST /api/v1/fx/quote` rejects missing user with `UNAUTHORIZED`.
- `POST /api/v1/fx/execute` rejects missing user with the FX execute `UNAUTHORIZED` policy.
- `GET /api/v1/home`, `GET /api/v1/ranking`, `GET /api/v1/wallets`, `GET /api/v1/records`, and orders read/write APIs reject missing user with `UNAUTHORIZED`.
- `GET /api/v1/seasons/current` currently accepts an optional user id so it can return `joined = false` when no authenticated user is present.

## 3. Files Reviewed

Required status and configuration files:

- `docs/current-status.md`
- `package.json`
- `prisma/schema.prisma`
- `src/app.module.ts`

Controllers and services:

- `src/seasons/seasons.controller.ts`
- `src/seasons/seasons.service.ts`
- `src/fx/fx.controller.ts`
- `src/fx/fx.service.ts`
- `src/home/home.controller.ts`
- `src/home/home.service.ts`
- `src/ranking/ranking.controller.ts`
- `src/ranking/ranking.service.ts`
- `src/wallets/wallets.controller.ts`
- `src/wallets/wallets.service.ts`
- `src/records/records.controller.ts`
- `src/records/records.service.ts`
- `src/orders/orders.controller.ts`
- `src/orders/orders.service.ts`

Auth-impacting tests and integration specs:

- `test/app.e2e-spec.ts`
- `src/app.controller.spec.ts`
- `src/fx/fx.service.spec.ts`
- `src/fx/fx.execute.integration.spec.ts`
- `src/home/home.service.spec.ts`
- `src/ranking/ranking.service.spec.ts`
- `src/wallets/wallets.service.spec.ts`
- `src/records/records.service.spec.ts`
- `src/orders/orders.service.spec.ts`
- `src/orders/orders.execute.integration.spec.ts`
- FX execute policy specs under `src/fx/*spec.ts`

## 4. Current User/Schema Readiness

`User` model readiness:

- `id` is available for token subject and `request.user.userId`.
- `email` is unique and can support login identity.
- `passwordHash` exists and can store password hashes.
- `nickname` is unique.
- `profileImageUrl` is optional.
- `status` uses `UserStatus` with `active`, `suspended`, and `deleted`.
- User ownership is connected to trading data through `SeasonParticipant.userId`.
- FX execute idempotency is scoped by `FxExecuteRequest.userId + idempotencyKey`.

Schema support without changes:

- Access-token-only auth is schema-feasible if tokens identify `User.id` and the guard checks that the user exists and is `active`.
- Existing protected services can continue to receive `request.user.userId`.
- Financial ownership checks can stay service-owned through `seasonId_userId`, owned order lookups, and participant-scoped wallet/position queries.

Schema gaps:

- No refresh token table exists.
- No refresh token hash field exists on `User`.
- No token version, session version, or logout watermark exists.
- No server-side access token revocation store exists.

Refresh-token implementation candidates if approved later:

- Preferred: add a `refresh_tokens` table with `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`, `rotatedAt`, `createdAt`, `updatedAt`, optional `userAgent`, optional `ipAddress`, and optional `replacedByTokenId`.
- Simpler but weaker: add `User.refreshTokenVersion` or `User.tokenValidAfter` for coarse invalidation.
- Do not store plaintext refresh tokens.

## 5. Current Package Readiness

Installed packages can support Nest module/controller/service/guard structure and Prisma-backed user lookup.

Missing packages for conventional auth:

- `@nestjs/jwt` is not installed.
- `@nestjs/passport`, `passport`, and `passport-jwt` are not installed.
- `bcrypt`, `bcryptjs`, and `argon2` are not installed.
- No cookie/session package is installed.

Current package-only implementation limits:

- A handwritten token format could technically be built with Node `crypto`, but that is not recommended for this financial write-path project.
- Password verification cannot be safely completed unless the existing `passwordHash` format and a password hashing library are chosen.
- Production-appropriate signup/login should add an approved password hashing dependency, preferably `argon2` or `bcrypt`.
- A Nest JWT integration should add `@nestjs/jwt`; Passport remains optional if a custom guard is preferred.

## 6. Protected API Inventory

`GET /api/v1/seasons/current`

- Current behavior allows optional auth and reports whether the current user joined.
- Auth implementation must decide whether this remains public with optional user hydration or becomes protected.
- If optional, invalid tokens should still fail closed rather than silently downgrade to anonymous.

`POST /api/v1/seasons/:seasonId/join`

- Must require a valid active user token.
- Must create the season participant and wallets only for the authenticated user id.
- Must reject suspended/deleted users.

`POST /api/v1/fx/quote`

- Must require a valid active user token.
- Must keep active season and joined participant checks.
- Must not allow wallet or participant checks against a caller-provided user id.

`POST /api/v1/fx/execute`

- Must require a valid active user token.
- Idempotency must remain scoped to authenticated `userId`.
- Wallet debit/credit and exchange transaction writes must continue to use participant ownership derived from token user id.
- Missing, expired, malformed, or forged tokens should return `UNAUTHORIZED` before write-path mutation.

`GET /api/v1/home`

- Must require a valid active user token under the current service contract.
- Must show not-joined guide from authenticated user state, not from a fallback id.

`GET /api/v1/ranking`

- Must require a valid active user token under the current service contract.
- Public ranking could be a future product decision, but current `myRanking` behavior depends on the authenticated user.

`GET /api/v1/wallets`

- Must require a valid active user token.
- Must only return wallets for the authenticated user's current/selected season participant.

`GET /api/v1/records`

- Must require a valid active user token.
- Must only return exchange, wallet transaction, and order records for the authenticated user's participant.

`GET /api/v1/orders`

- Must require a valid active user token.
- Must only return orders belonging to the authenticated user's participant.

`POST /api/v1/orders/quote`

- Must require a valid active user token.
- Must keep buy cash and sell position checks scoped to the authenticated participant.

`POST /api/v1/orders`

- Must require a valid active user token.
- Create idempotency must remain scoped to authenticated participant id.

`POST /api/v1/orders/:orderId/cancel`

- Must require a valid active user token.
- Must only cancel an order owned by the authenticated user's participant.

`POST /api/v1/orders/:orderId/execute`

- Must require a valid active user token.
- Must only execute an order owned by the authenticated user's participant.
- Guarded finalization, wallet debit/credit, position mutation, and ledger creation must continue to run from token-derived ownership only.

## 7. Security and Ownership Risks

Highest-risk areas:

- `/api/v1/fx/execute` can debit and credit cash wallets and create exchange ledger rows.
- `/api/v1/orders/:orderId/execute` can debit/credit wallets, mutate positions, create order ledger rows, and finalize orders.
- `/api/v1/orders/:orderId/cancel` can terminally mutate another user's order if ownership were bypassed.

Current risk before auth body:

- Services mostly fail closed when `userId` is missing, but there is no repository-local HTTP auth layer that can produce a trusted `request.user.userId`.
- Any future middleware that trusts headers or body fields for user identity would break the ownership model.
- Suspended or deleted users are representable in schema but are not yet blocked by a guard.
- Token secret, expiry, and issuer/audience rules are not defined.

Expected auth failures after implementation:

- Missing token: `UNAUTHORIZED`.
- Malformed token: `UNAUTHORIZED`.
- Expired token: `UNAUTHORIZED`.
- Forged signature: `UNAUTHORIZED`.
- Unknown user id: `UNAUTHORIZED` or equivalent fail-closed auth error.
- Suspended/deleted user: reject before controller/service write path; recommended error is `FORBIDDEN` with a stable inactive-user code unless the project chooses to hide user state behind `UNAUTHORIZED`.

Why `x-user-id` fallback must not return:

- It lets callers choose a user id without proving identity.
- It would allow cross-user season participant, wallet, order, record, and idempotency access.
- It is especially dangerous for guarded financial writes because the guard protects state transitions only after the correct owner has been identified.

## 8. Implementation Options

Option A: access token MVP

- Add auth module/service/controller as needed.
- Add a guard that verifies an access token, loads the user, checks `User.status = active`, and assigns `request.user = { userId }`.
- Keep `request.user.userId` as the only controller source of identity.
- Use short-lived access tokens.
- Keep refresh/logout/revocation out of scope.
- Schema change is not required.

Pros:

- Fits the current schema.
- Smallest change before protecting financial write paths.
- Keeps ownership checks in existing services.

Cons:

- Requires package/env decisions for JWT and password hashing.
- No server-side token revocation without additional state.
- Users must re-login when access tokens expire.

Option B: access + refresh token auth

- Implement access tokens plus rotating refresh tokens.
- Store refresh token hashes server-side.
- Add logout/revoke and rotation handling.
- Requires schema/migration design unless using a deliberately weaker coarse invalidation field.

Pros:

- Better user session experience.
- Supports revocation and rotation.
- More appropriate for long-lived mobile or web sessions.

Cons:

- Requires schema changes and migration.
- Adds more concurrency, replay, and token-theft test cases.
- Larger blast radius before the financial write path is fully auth-covered.

## 9. Recommended Near-term Scope

Recommendation: implement Option A first as an explicitly limited access-token MVP.

Recommended constraints:

- Add no refresh token support in the first auth implementation.
- Do not change Prisma schema for the first auth implementation.
- Add approved packages for JWT verification and password hashing before implementing login/signup.
- Require env configuration for access-token secret and expiry.
- Fail closed on missing/invalid env configuration.
- Check `User.status = active` in the guard.
- Preserve `request.user.userId` as the only identity source.
- Do not add `x-user-id`, body user id, query user id, fake user, or test-only bypass paths.

Expected file areas for the implementation task:

- `src/auth/*` new module/service/controller/guard/types.
- `src/app.module.ts` to import auth module and optionally apply a global guard.
- Controller-level public route metadata if `/health`, login, signup, or `seasons/current` remain public.
- Auth-related tests and e2e tests.
- `package.json` and lockfile only after package choices are approved.
- Schema/migration only if refresh-token auth is approved.

## 10. Required Tests Before/After Auth Implementation

Before implementation:

- Confirm existing service unit tests still cover missing `userId` rejection.
- Preserve FX execute and orders execute DB integration tests as financial write-path regression tests.

Auth unit tests:

- Valid token populates `request.user.userId`.
- Missing token rejects.
- Malformed token rejects.
- Expired token rejects.
- Forged token rejects.
- Unknown user rejects.
- Suspended user rejects.
- Deleted user rejects.
- `x-user-id` is ignored and cannot authenticate a request.

Auth API tests:

- Login success returns token without exposing `passwordHash`.
- Login wrong password rejects.
- Login inactive user rejects.
- Signup, if implemented, hashes passwords and enforces unique email/nickname.

Protected API e2e tests:

- Each protected endpoint rejects missing token.
- Each protected endpoint accepts a valid active-user token.
- User A cannot read or mutate User B's wallets, records, orders, season participant, FX execute request, or order execute path.
- `/api/v1/fx/execute` still preserves idempotency, rollback, and concurrency behavior with token-derived user id.
- `/api/v1/orders/:orderId/execute` still preserves overspend, oversell, double execute, cancel race, and rollback behavior with token-derived user id.

Public or optional-auth route tests:

- `/health` remains public.
- `/api/v1/seasons/current` behavior is explicitly tested for anonymous, valid token, and invalid token according to the selected policy.

## 11. STOP / GO Decision

Decision: CONDITIONAL GO for an access-token-only MVP.

Reason:

- The schema already has `User.id`, `email`, `passwordHash`, `nickname`, and `UserStatus`.
- Existing protected controllers already read `request.user.userId`.
- Existing services already enforce ownership through token-derived `userId` once it is trusted.
- The first auth implementation can avoid schema changes if refresh tokens and server-side revocation are out of scope.

Conditions before implementation:

- Decide JWT package strategy, preferably `@nestjs/jwt`.
- Decide password hashing package and stored hash format, preferably `argon2` or `bcrypt`.
- Decide access-token env names and TTL.
- Decide whether `GET /api/v1/seasons/current` stays public optional-auth or becomes protected.
- Decide inactive-user error shape.

STOP for refresh-token implementation until schema/migration design is explicitly approved.

## 12. Remaining Questions

- Should signup be implemented now, or should auth start with login for existing users only?
- Should `GET /api/v1/seasons/current` remain public with optional auth?
- What access-token TTL should be used for the MVP?
- What env names should be the source of truth for token secret, issuer, audience, and expiry?
- Should inactive users return `401 UNAUTHORIZED` or `403 USER_NOT_ACTIVE`?
- Which password hashing package is approved: `argon2`, `bcrypt`, or another project standard?
- Is refresh-token support required before frontend integration, or can it be a second auth milestone?
