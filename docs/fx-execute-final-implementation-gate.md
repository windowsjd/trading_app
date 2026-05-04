# FX Execute Final Implementation Gate

## Status
- Documentation only.
- `/fx execute` is still not implemented.
- This document consolidates the remaining accepted implementation gates before drafting a future `/fx execute` implementation prompt.
- This document is not permission to implement controller, service, DTO, test, provider ingestion, scheduler, admin API, schema, migration, seed, package, or environment changes.

## Purpose
- Close the remaining provider/sourceType, execute-time snapshot selection, freshness, and final test-matrix decisions for near-term `/fx execute`.
- Keep provider final selection separate from near-term execute readiness.
- Provide a single checklist that a future implementation task must satisfy with code and tests.

## Accepted Provider And Source Coexistence Policy
- Provider final selection is not confirmed.
- OANDA remains the primary provider candidate and Twelve Data remains the secondary candidate.
- `provider_api`, `official_batch`, and scheduler ingestion are not implemented.
- `admin_manual` remains a bootstrap, fallback, and manual correction path.
- `official_batch` is not a real-time `/fx execute` primary source.
- `official_batch` remains a settlement, reference, or reconciliation candidate.
- Near-term `/fx execute` must be locally/integration smoke-testable with an approved fresh `admin_manual` snapshot, independent of provider final selection.
- An approved fresh `admin_manual` snapshot must not be fake/static/temporary/sample/test business FX rate data.
- Before `provider_api` exists, `/fx execute` must not depend on `provider_api`.
- If `provider_api` is implemented later, `admin_manual` must not silently override it without an accepted fallback/override policy.
- SourceType selection must follow documented policy, not implicit code preference.

## Accepted Execute Source Eligibility
- `/fx execute` uses an explicit sourceType eligibility rule, not an implicit priority list.
- Current near-term allowed execute sourceType:
  - `admin_manual` only
- Current not-allowed execute sourceTypes:
  - `provider_api`
  - `official_batch`
- `provider_api` can be added to allowed execute sourceTypes only after provider final selection, contract/API trial validation, ingestion implementation, and a separate document review.
- `official_batch` must not be added as a real-time execute source; keep it for settlement/reference/reconciliation policy.
- If multiple snapshots are eligible, apply snapshot ordering, not sourceType priority.
- Snapshots whose `sourceType` is not in the allowed list are excluded from execute selection.

## Accepted Fallback Policy
- Automatic fallback is forbidden for MVP.
- Do not automatically fallback from stale/unavailable `provider_api` to `admin_manual`.
- Any future fallback requires explicit operational/manual correction procedure and audit requirements.
- Near-term behavior is an allowed sourceType gate, not fallback.
- Current implementation gate allows only approved fresh `admin_manual` snapshots for execute source selection.

## Accepted Execute-Time Snapshot Selection
- `/fx execute` uses direct execute with execute-time snapshot selection because durable quotes do not exist yet.
- Selection happens before wallet mutation.
- Selection target:
  - pair: USD/KRW
  - allowed sourceType only
  - usable current schema rows only; there is no separate status column in the current schema
  - `effectiveAt <= executeNow`
  - positive `rate`
- Ordering:
  1. `effectiveAt desc`
  2. `capturedAt desc`
  3. `createdAt desc`
- If no eligible snapshot exists, return `FX_RATE_UNAVAILABLE`.
- If the selected snapshot is stale, return `FX_RATE_STALE`.
- Future `effectiveAt` snapshots are excluded.
- The selected snapshot `id` is stored in successful `exchange_transactions.fxRateSnapshotId`.
- The selected snapshot `rate` is the execute `appliedRate`.
- Execute response and stored `responsePayloadJson` should include values corresponding to `rateCapturedAt` and `rateEffectiveAt`.
- No rate/stale rate must not create wallet mutation, exchange row, wallet transaction row, or command succeeded finalization.
- Durable `quoteId` and `expiresAt` are not introduced by this policy; durable quote design requires a separate review.

## Accepted Execute-Time Freshness Rule
- `/fx execute` uses the same freshness rule as `/fx quote`.
- If `executeNow - selectedSnapshot.effectiveAt > 60_000ms`, return `FX_RATE_STALE`.
- Exactly `60_000ms` is accepted and can succeed if all other checks pass.
- Future snapshots with `effectiveAt > executeNow` are ignored.
- Freshness check happens before wallet mutation.
- Stale failure must not create wallet mutation, exchange row, wallet transaction row, or command succeeded finalization.

## Final Implementation Readiness Gate
A future `/fx execute` implementation prompt may be drafted after this document is reviewed, but implementation is not performed in this task. The implementation task must include:

- Accepted Decimal half-up and scale/formatting policy.
- Accepted `requestHash` canonical rule.
- Accepted error code/status/retryability policy.
- Accepted idempotency pending/succeeded/failed MVP lifecycle.
- Accepted guarded conditional source debit wallet safety strategy.
- Accepted affected row count 0 classification.
- Accepted source/target wallet update order.
- Accepted `wallet_transactions.balanceAfter` source of truth.
- Accepted provider/sourceType eligibility and no-automatic-fallback policy.
- Accepted execute-time snapshot selection and freshness rules.
- Full unit/e2e/smoke test matrix below.
- Wallet safety implementation proof through tests.
- Rollback/partial-write proof through tests.
- Local/integration smoke path using approved fresh `admin_manual` snapshot only.

## Final Implementation Test Matrix
Do not add tests in this documentation task.

### A. Auth / Validation / Season
- unauthenticated -> `UNAUTHORIZED`
- invalid pair -> `INVALID_CURRENCY_PAIR`
- same currency -> `INVALID_CURRENCY_PAIR`
- invalid amount string -> `INVALID_AMOUNT`
- non-positive amount -> `INVALID_AMOUNT`
- missing `idempotencyKey` -> `IDEMPOTENCY_REQUIRED`
- no current season -> `SEASON_NOT_FOUND`
- inactive/upcoming/ended/settled season -> `SEASON_NOT_ACTIVE`
- active season but not joined -> `SEASON_NOT_JOINED`

### B. FX Snapshot Selection / Freshness
- no eligible snapshot -> `FX_RATE_UNAVAILABLE`
- selected snapshot stale `> 60_000ms` -> `FX_RATE_STALE`
- exactly `60_000ms` -> success candidate
- future `effectiveAt` ignored
- disallowed `sourceType` ignored
- latest eligible snapshot selected by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`
- selected snapshot id stored as `exchange_transactions.fxRateSnapshotId`
- `rateCapturedAt` and `rateEffectiveAt` included in `responsePayloadJson`

### C. Decimal / Calculation
- KRW -> USD exact division
- KRW -> USD repeating decimal
- USD -> KRW multiplication
- `feeAmount` half-up boundary
- `netTargetAmount = grossTargetAmount - feeAmount`
- target wallet credit = `netTargetAmount`
- source wallet debit = `sourceAmount`
- response scale formatting
- DB stored values equal `responsePayloadJson` values
- no JS number precision drift

### D. Idempotency
- same key same hash pending fresh -> `IDEMPOTENCY_PENDING`
- same key same hash pending stale -> `IDEMPOTENCY_PENDING_STALE`
- same key different hash -> `IDEMPOTENCY_CONFLICT`
- same key same hash succeeded -> exact stored `responsePayloadJson` replay
- same key same hash failed -> `IDEMPOTENCY_FAILED` or stored failure payload, no mutation
- duplicate retry after response loss -> no second wallet mutation
- `requestHash` canonical decimal equivalence
- `requestHash` excludes timestamp/rate/wallet balance
- conflict creates no wallet mutation

### E. Wallet Safety / Concurrency
- insufficient balance -> `INSUFFICIENT_BALANCE`, no partial rows
- source wallet missing -> `SOURCE_WALLET_NOT_FOUND`, no partial rows
- target wallet missing -> `TARGET_WALLET_NOT_FOUND`, no partial rows
- guarded source debit affected row count 0 classification
- concurrent debit conflict -> `CONCURRENT_WALLET_UPDATE`, no partial rows
- target credit happens only after source debit success
- source/target post-update balances captured accurately

### F. Ledger / Exchange Rows
- successful execute creates one `exchange_transactions` row
- successful execute creates one source debit `wallet_transactions` row
- successful execute creates one target credit `wallet_transactions` row
- source debit row shape
- target credit row shape
- `balanceAfter` equals actual post-update wallet balance
- no fee wallet transaction row
- no `equity_snapshots` row
- exchange row contains `sourceAmount`, `grossTargetAmount`, `feeRate`, `feeAmount`, `feeCurrency`, `appliedRate`, `netTargetAmount`, `fxRateSnapshotId`, `executedAt`

### G. Rollback / Partial Write
- source debit failure -> no target credit/exchange/ledger/command succeeded
- target credit failure -> full rollback
- exchange row failure -> wallet rollback
- source ledger row failure -> wallet/exchange rollback
- target ledger row failure -> wallet/exchange rollback
- command finalization failure -> rollback or recovery-required behavior explicitly tested
- `responsePayloadJson` storage failure -> no committed success unless recovery path proven
- internal transaction failure -> no partial writes
- stale/no rate -> no wallet mutation
- idempotency conflict -> no wallet mutation

### H. Response / Records Readiness
- success response matches stored `responsePayloadJson`
- `exchangeId` can map to records exchange response later
- `feeCurrency` included
- `appliedRate`/`rate` mapping clear
- no `/home` dependency introduced
- no ranking/settlement side effect introduced

## Explicit Non-Goals
- No `/fx execute` implementation.
- No controller/service/DTO/test code.
- No provider final selection.
- No `provider_api`, `official_batch`, scheduler, or admin API implementation.
- No schema/migration/seed/package/env changes.
- No fake/static/temporary/sample/test business FX rate.
- No `/home`, `/wallets`, `/orders`, `/records`, `/ranking`, or `/settlement` implementation.
