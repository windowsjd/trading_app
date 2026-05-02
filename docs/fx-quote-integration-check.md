# FX Quote Integration Check

## Purpose
- Verify `POST /api/v1/fx/quote` with an approved `admin_manual` USD/KRW snapshot.
- Keep rate input separate from seed data and hardcoded fallback behavior.
- Confirm `/fx quote` remains read-only.

## Preconditions
- DB migrations are applied, including `20260501212120_add_fx_rate_and_execute_safety_tables`.
- Prisma Client generation has completed.
- The server can connect through `DATABASE_URL`.
- The request context provides `request.user.userId`.
- No `/fx execute` implementation is required or allowed for this check.

## Insert Approved USD/KRW Snapshot

CLI timestamps must use strict UTC ISO format:
- Required shape: `YYYY-MM-DDTHH:mm:ss.sssZ`
- Format example only: `2026-05-01T00:00:00.000Z`
- Date-only values such as `2026-05-01` are rejected.
- Values without milliseconds are rejected.
- Timezone offsets such as `2026-05-01T00:00:00+09:00` are rejected.
- For a successful quote smoke test, `effectiveAt` must be within 60 seconds of the current UTC time.
- Do not reuse old fixed timestamps as success-smoke data.

Dry-run first:

```bash
pnpm tsx scripts/admin-insert-fx-rate.ts --dry-run --rate 1350.12345678 --source-name "manual-approved-usd-krw" --effective-at <current UTC timestamp within 60 seconds> --note "approved operating input"
```

Create the row after review:

```bash
pnpm tsx scripts/admin-insert-fx-rate.ts --rate 1350.12345678 --source-name "manual-approved-usd-krw" --effective-at <current UTC timestamp within 60 seconds> --note "approved operating input"
```

Notes:
- The rate must be an approved operating value.
- Do not run the non-dry-run command without an actual approved rate value.
- This document only describes dry-run and approved manual execution procedures.
- A non-dry-run smoke should use a current UTC `effectiveAt`; otherwise quote returns `FX_RATE_STALE`.
- The CLI is create-only; it does not upsert.
- Operators must avoid duplicate input for the same `effectiveAt`, `sourceName`, and `rate` until correction/re-approval workflow exists.
- The CLI rejects wording that would make the row look like non-operating data.

## Quote Check

1. Start the server.
2. Call `POST /api/v1/fx/quote` from an authenticated request context.
3. Use request body:

```json
{
  "fromCurrency": "KRW",
  "toCurrency": "USD",
  "sourceAmount": "135000"
}
```

4. If no eligible snapshot exists, confirm `FX_RATE_UNAVAILABLE`.
5. If the selected snapshot exists but `effectiveAt` is older than 60 seconds, confirm `FX_RATE_STALE`.
6. If the selected snapshot is fresh, confirm:
   - `quoteId` is `null`.
   - `expiresAt` is `null`.
   - `rateCapturedAt` is present.
   - `rateEffectiveAt` is present.
   - `appliedRate` matches the selected snapshot rate.

## Read-Only Confirmation
- `/fx quote` must not create `exchange_transactions`.
- `/fx quote` must not create `wallet_transactions`.
- `/fx quote` must not create `fx_execute_requests`.
- `/fx quote` must not create `equity_snapshots`.
- `/fx quote` must not mutate wallet balances.
