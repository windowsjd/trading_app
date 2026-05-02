# FX Ingestion STOP Review

## Status
- This document prepares the STOP review before provider/source investigation for FX ingestion.
- This is documentation only.
- Do not implement `provider_api`, `official_batch`, schedulers, admin APIs, `/fx execute`, wallet writes, schema changes, migrations, seed changes, Prisma Client generate, or package changes from this document.

## Purpose
- Define what must be checked before selecting a USD/KRW provider or official source.
- Keep `/fx quote` 60-second stale policy visible before ingestion implementation.
- Keep `admin_manual` as bootstrap, fallback, and manual correction rather than primary ingestion.
- Prepare the next work item: provider candidate research using official documentation only.

## Current Premises
- `/fx quote` read-only implementation exists.
- `/fx quote` selects USD/KRW snapshots from `fx_rate_snapshots`.
- No eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- Selected snapshot older than 60 seconds by `effectiveAt` returns `FX_RATE_STALE`.
- `admin_manual` CLI exists and can insert approved manual snapshots.
- `provider_api` and `official_batch` ingestion are not implemented.
- `/fx execute` remains STOP.

## Role Decision
- `provider_api` polling is the primary service ingestion candidate.
- `official_batch` is a settlement/reference or secondary benchmark candidate.
- `admin_manual` remains bootstrap, fallback, and manual correction.
- Hardcoded, seeded, fake, static, or temporary business rates remain forbidden.

## Polling And Freshness
- `/fx quote` stale threshold is 60 seconds.
- Provider polling interval must be shorter than 60 seconds.
- Current preferred polling candidate is 30 seconds.
- The interval must be revisited after provider rate limit, latency, pricing, and reliability are known.

## Provider Research Checklist
Before implementation, compare candidates using official provider or official-source documentation only:
- API endpoint for USD/KRW.
- Authentication and API key requirements.
- Rate limit.
- Free or paid usage policy.
- USD/KRW pair support.
- Response timestamp availability and semantics.
- Timeout, outage, and retry guidance.
- Commercial use permission.
- Data license or attribution requirements.
- Sandbox/test environment availability.

## Batch Research Checklist
Before implementation, compare official batch sources using official documentation only:
- Published USD/KRW reference rate definition.
- Publication frequency and expected delay.
- Timestamp semantics.
- Data usage permission.
- Correction or revision policy.
- Fit for settlement/reference use versus real-time quote freshness.

## STOP Decisions Before Coding
- Select the provider or official source.
- Decide `sourceType` priority when `provider_api`, `official_batch`, and `admin_manual` rows coexist.
- Decide whether `effectiveAt` uses provider timestamp or server `capturedAt` when provider timestamp is missing.
- Decide retry/backoff and operational alerting.
- Decide retention/archive policy for polling-created snapshots.
- Decide whether a latest-value cache table is needed.
- Decide whether `/fx execute` uses the same 60-second freshness rule as quote.

## Next Step
- Research provider candidates and official batch sources.
- Use official API/source documentation only for the comparison.
- Do not use web search results, blogs, examples, or unofficial summaries as source of truth.
- This document intentionally leaves provider candidates as TODO until that research is performed.
