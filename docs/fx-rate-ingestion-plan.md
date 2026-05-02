# FX Rate Ingestion Plan

## Status
- This document designs future USD/KRW rate ingestion for `fx_rate_snapshots`.
- Provider/source investigation STOP review is documented in `docs/fx-ingestion-stop-review.md`.
- Official-document provider research is documented in `docs/fx-provider-research.md`.
- This is documentation only.
- Do not implement `provider_api`, `official_batch`, schedulers, admin APIs, `/fx execute`, wallet writes, schema changes, migrations, seed changes, Prisma Client generate, or package changes from this document.
- Provider final selection is pending.

## Purpose
- Define how USD/KRW rates should be updated periodically like stock or crypto prices.
- Define an operating structure that satisfies the `/fx quote` 60-second stale threshold.
- Reclassify `admin_manual` as bootstrap, fallback, and manual correction, not primary long-term ingestion.
- Compare `provider_api` and `official_batch` as post-MVP ingestion options.
- Record implementation, schema, and operation decisions still needed before coding.

## Current Premises
- `/fx quote` read-only implementation exists.
- `/fx quote` selects the latest eligible USD/KRW snapshot by `effectiveAt`.
- No eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- A selected snapshot older than 60 seconds by `effectiveAt` returns `FX_RATE_STALE`.
- `fx_rate_snapshots` supports `sourceType`, `sourceTimestamp`, `effectiveAt`, `capturedAt`, `createdAt`, `rawPayloadJson`, `approvedByUserId`, and `note`.
- `admin_manual` CLI exists, but it is not enough to maintain 60-second freshness in normal service.

## Ingestion Candidates

### Candidate A: `provider_api` Polling
- Poll an external FX provider for USD/KRW at a fixed interval.
- Store rows with `sourceType = provider_api`.

Pros:
- Automatable.
- Best fit for maintaining quote/execute freshness.
- Matches the operating model expected for stock and crypto price feeds.

Cons:
- Requires provider selection.
- Requires API key, pricing, rate limit, and outage handling.
- Must define how provider timestamps relate to server `capturedAt`.

### Candidate B: `official_batch`
- Insert an official or operating reference rate through a batch path.
- Store rows with `sourceType = official_batch`.

Pros:
- Easier to explain for audit and settlement reference.
- Gives a clearer operating standard than arbitrary manual input.

Cons:
- May not satisfy 60-second quote freshness.
- Too slow for real-time exchange if the batch interval is long.
- Long intervals can make `FX_RATE_STALE` frequent.

### Candidate C: `admin_manual`
- Use the existing CLI to insert approved manual snapshots.
- Store rows with `sourceType = admin_manual`.

Pros:
- Useful for bootstrap, incident response, and manual correction.
- Already implemented as a create-only internal CLI.

Cons:
- Humans cannot reliably maintain 60-second freshness.
- Not suitable as the primary service ingestion path.

Conclusion:
- Keep `admin_manual` for bootstrap, fallback, and manual correction.
- Do not use `admin_manual` as primary long-running ingestion.

### Candidate D: Hardcoded, Seeded, Or Static Rate
- Forbidden.
- Fake, static, temporary, seed, or hardcoded rates must not power quote, execute, valuation, settlement, or tests that can be mistaken as business data.

## Recommended Direction
- Primary service ingestion should prefer `provider_api` polling.
- Official-document research is summarized in `docs/fx-provider-research.md`.
- `official_batch` should be reviewed as a settlement/reference source or secondary operating benchmark, not assumed to be quote primary.
- `admin_manual` should remain bootstrap/fallback/manual correction.
- Do not implement ingestion before selecting an actual provider or official source.

## Provider Research Summary
- Korea Eximbank Open API and Bank of Korea ECOS are official/reference candidates, but official docs/data shape indicate daily/date-level or publication-time behavior that may not satisfy `/fx quote` 60-second freshness.
- Open Exchange Rates normal plans are slower than 60 seconds; VIP-level updates require separate contract review.
- Currencylayer and exchangerate.host include 60-second update tiers, but this is tight against a 60-second stale threshold and needs provider timestamp/polling/terms review.
- Twelve Data and OANDA remain provider_api candidates with stronger freshness potential, but USD/KRW exact support, commercial usage, timestamp reliability, and polling permission must be confirmed.
- Alpha Vantage remains a provider_api candidate only after real-key USD/KRW validation and commercial/polling review.
- No provider is selected yet.

## Polling Interval And Stale Threshold
- `/fx quote` stale threshold is 60 seconds.
- Provider polling interval must be shorter than 60 seconds.

Polling candidates:
- 10 seconds: freshest, but higher provider load and rate-limit risk.
- 30 seconds: recommended initial candidate, not final.
- 60 seconds: too close to the stale threshold and leaves no failure margin.

Recommendation:
- Use 30 seconds as the first provider polling candidate.
- Adjust after provider rate limits, terms, pricing, latency, and reliability are known.
- Do not finalize 30-second polling until the selected provider's official docs or contract allow the interval.

## Storage Policy
Candidates:
- Create a new `fx_rate_snapshots` row on every poll.
- Create a row only when the rate changes.
- Split latest value and history into a `latest_fx_rates` cache table plus snapshot history.

Recommendation:
- With the current schema, start with creating one `fx_rate_snapshots` row per poll.
- This preserves audit history and keeps quote selection simple.
- Row volume will grow quickly after polling starts, so retention/archive design is required as a follow-up.
- Review whether a future `latest_fx_rates` cache table is needed for operational simplicity.

## Timestamp Policy
Field meanings:
- `sourceTimestamp`: timestamp supplied by the provider or official source.
- `effectiveAt`: quote selection and stale judgment timestamp.
- `capturedAt`: server collection/storage acceptance time.
- `createdAt`: database row creation time.

Recommendation:
- If provider timestamp is trustworthy, set `effectiveAt = sourceTimestamp`.
- If provider timestamp is missing, set `effectiveAt = capturedAt`.
- Always set `capturedAt` to the server collection time.
- Keep `/fx quote` stale judgment based on `effectiveAt`.

## Failure Handling
- Provider request failure: do not insert a row; keep existing snapshots.
- Provider rate limit: do not bypass with hardcoded rates; surface ingestion degradation to operations.
- Provider response parse failure: do not insert a row; record/log the failure in the future ingestion job.
- Provider timestamp missing: use `capturedAt` as `effectiveAt` only if the source policy allows it.
- DB insert failure: do not retry in a way that creates ambiguous duplicate rows without an agreed retry policy.
- If only stale snapshots remain, `/fx quote` returns `FX_RATE_STALE`.
- If no eligible snapshots exist, `/fx quote` returns `FX_RATE_UNAVAILABLE`.
- Do not automatically fabricate an `admin_manual` fallback.
- An explicitly inserted `admin_manual` row can be selected by quote if it is the latest eligible snapshot and fresh.

## Source Type Priority
Current `/fx quote` selection:
- Ignores `sourceType`.
- Selects the latest eligible USD/KRW snapshot by `effectiveAt`, then `capturedAt`, then `createdAt`.

Options:
- Treat all source types equally and use latest `effectiveAt`.
- Prefer `provider_api`, then allow `admin_manual` fallback.
- Separate `official_batch` from `provider_api` by use case.

Recommendation:
- Keep current `/fx quote` sourceType-agnostic latest `effectiveAt` rule for now.
- Add a STOP review before introducing `provider_api` or `official_batch` to decide sourceType priority.
- Note that a fresh `admin_manual` correction row newer than provider rows can currently be used by quote.

## Retention And Cleanup
Candidates:
- No retention.
- Keep 7 days.
- Keep through season duration.
- Keep until settlement completion.
- Archive long-term history.

Recommendation:
- No retention implementation for MVP ingestion design.
- Once provider polling starts, row growth becomes significant.
- Add retention/archive design as a follow-up before long-running production use.

## Environment Variable Candidates
- `FX_PROVIDER_NAME`
- `FX_PROVIDER_BASE_URL`
- `FX_PROVIDER_API_KEY`
- `FX_POLL_INTERVAL_SECONDS`
- `FX_STALE_THRESHOLD_SECONDS`
- `FX_PAIR=USDKRW`

Do not add config, `.env.example`, package scripts, or scheduler code in this document task.

## Implementation STOP Checklist
- Select provider or official source.
- Confirm provider API contract, authentication, rate limits, pricing, and timestamp semantics.
- Decide sourceType priority before provider/batch rows mix with manual correction rows.
- Decide retry/backoff and operational alerting behavior.
- Decide retention/archive policy.
- Decide whether a latest-value cache table is needed.
- Keep `/fx execute` STOP until wallet safety, rounding/scale, and failed command lifecycle policies are finalized.
