# FX Quote STOP Review

## Status
- This document records the accepted STOP review and implemented read-only `/fx quote` constraints.
- `/fx quote` read-only implementation is completed according to this review.
- This is documentation only.
- Do not implement `/fx execute`, `/wallets`, `/orders`, `/records`, `/home`, admin APIs, provider/batch ingestion, or additional CLI scripts from this document.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Record why `/fx quote` read-only implementation is allowed and what it must not do.
- Record the stale threshold policy for MVP quote.
- Keep the implemented `fx_rate_snapshots` selection rule visible.
- Reconfirm implementation non-goals and forbidden write behavior.
- List the remaining blockers after quote implementation.

## Current Premises
- `fx_rate_snapshots` schema and migration are created and applied locally.
- Prisma Client generate, build, test, and e2e verification passed.
- `docs/fx-rate-input-path-plan.md` defines `admin_manual` as the MVP rate input path.
- The internal `admin_manual` CLI exists at `scripts/admin-insert-fx-rate.ts`.
- `/fx quote` read-only implementation exists.
- There is still no `/fx execute` implementation.
- Fake, static, and temporary FX rates are forbidden.

## Quote Implementation Scope

`/fx quote` is implemented only as a read-only API.

Implemented read-only behavior:
- Validate active season joined state.
- Validate `fromCurrency`, `toCurrency`, and `sourceAmount`.
- Read `fx_rate_snapshots`.
- Read the current season `fxFeeRate`.
- Calculate `grossTargetAmount`, `feeAmount`, and `netTargetAmount`.
- Return the quote response.

Forbidden:
- Wallet mutation.
- `exchange_transactions` creation.
- `wallet_transactions` creation.
- `fx_execute_requests` creation.
- `equity_snapshots` creation.
- Fake, static, or temporary fallback rate usage.
- `/fx execute` implementation.

DB write policy:
- MVP `/fx quote` must not write to the database.
- Quote request logging is deferred even if it becomes useful later.
- There is no durable quote table yet.
- `quoteId` and `expiresAt` should be `null` for MVP quote.

## Snapshot Selection Rule

Implementation-level rule:
- Query `fx_rate_snapshots` where:
  - `baseCurrency = USD`
  - `quoteCurrency = KRW`
  - `effectiveAt <= now`
- Order by:
  - `effectiveAt desc`
  - `capturedAt desc`
  - `createdAt desc`
- Take 1 row.
- If no row exists, return `FX_RATE_UNAVAILABLE`.

Both supported quote directions use the same USD/KRW snapshot:
- `rate` means KRW per 1 USD.
- KRW -> USD: `grossTargetAmount = sourceAmount / rate`.
- USD -> KRW: `grossTargetAmount = sourceAmount * rate`.

## Stale Threshold Decision

Candidates:
- 60 seconds: selected by the game rule for quote freshness.
- 5 minutes: rejected because it is looser than the game rule.
- 1 hour: rejected because it is looser than the game rule.
- Current day: rejected because it is looser than the game rule.
- Deprecated MVP no-threshold: rejected because quote must block stale rates.

Final MVP decision:
- `/fx quote` uses a 60-second stale threshold.
- Select the latest eligible USD/KRW snapshot with the existing selection rule.
- If no eligible snapshot exists, return `FX_RATE_UNAVAILABLE`.
- If the selected snapshot `effectiveAt` is older than `now - 60 seconds`, return `FX_RATE_STALE`.
- If `now.getTime() - effectiveAt.getTime() > 60_000`, the snapshot is stale.

Required constraints:
- A 60-second threshold does not allow fake/static/temporary fallback.
- No eligible snapshot still returns `FX_RATE_UNAVAILABLE`.
- Stale selected snapshot returns `FX_RATE_STALE`.
- Revisit freshness operations when `provider_api` or `official_batch` is introduced.
- Order execution, settlement, ranking, and valuation freshness need separate policies.

## Request Shape

Implementation standard:

```json
{
  "fromCurrency": "KRW | USD",
  "toCurrency": "USD | KRW",
  "sourceAmount": "<amount string>"
}
```

Use `sourceAmount`.
Do not introduce a request field named `amount`.

## Response Shape

Recommended success response:

```json
{
  "success": true,
  "data": {
    "quoteId": null,
    "fromCurrency": "KRW",
    "toCurrency": "USD",
    "sourceAmount": "<amount string>",
    "appliedRate": "<decimal string>",
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "netTargetAmount": "<amount string>",
    "expiresAt": null,
    "rateCapturedAt": "<UTC ISO string>",
    "rateEffectiveAt": "<UTC ISO string>"
  }
}
```

Response decisions:
- `quoteId` should be `null` because there is no durable quote table.
- `expiresAt` should be `null` because durable quote expiry is not active in MVP quote.
- `quoteId`/`expiresAt` are separate from rate freshness; freshness is enforced through the selected snapshot `effectiveAt`.
- Include `rateCapturedAt`.
- Include `rateEffectiveAt`.
- Reason: quote needs transparent rate timing for users and debugging.

## Error Codes

Required implementation codes:
- `UNAUTHORIZED`
- `SEASON_NOT_FOUND`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `FX_RATE_UNAVAILABLE`
- `FX_RATE_STALE`
- `INTERNAL_ERROR`

Common error envelope:

```json
{
  "success": false,
  "error": {
    "code": "<string>",
    "message": "<string>"
  }
}
```

## Remaining Follow-Up Checks
- Confirm whether frontend needs display formatting beyond API decimal strings.
- Keep `rateCapturedAt` and `rateEffectiveAt` in the response contract.
- Keep `fxFeeRate` sourced from the active season.
- Keep quote request persistence out of MVP unless a durable quote table is explicitly designed.
- Review provider/batch ingestion before relying on long-running quote freshness.

## Final Decision
- `/fx quote` read-only implementation exists according to this STOP review.
- `/fx quote` must not include execute, wallet mutation, ledger writes, or fake fallback.
- `/fx execute` remains STOP.
- Rate input CLI exists, but successful quote responses still require an approved fresh snapshot row.
- Without snapshot data, `/fx quote` returns `FX_RATE_UNAVAILABLE`.
- With a stale selected snapshot, `/fx quote` returns `FX_RATE_STALE`.
