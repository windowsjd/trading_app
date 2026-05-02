# FX Ingestion STOP Review

## Status
- This document records the STOP review before FX ingestion implementation.
- This is documentation only.
- Do not implement `provider_api`, `official_batch`, schedulers, admin APIs, `/fx execute`, wallet writes, schema changes, migrations, seed changes, Prisma Client generate, or package changes from this document.
- Provider candidate research is documented in `docs/fx-provider-research.md`.
- Provider final selection pending.

## Purpose
- Define what must be checked before selecting a USD/KRW provider or official source.
- Keep `/fx quote` 60-second stale policy visible before ingestion implementation.
- Keep `admin_manual` as bootstrap, fallback, and manual correction rather than primary ingestion.
- Keep provider candidate research based on official documentation only.

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
- Current official-document research keeps `provider_api` primary candidates and `official_batch` reference candidates separate.

## Polling And Freshness
- `/fx quote` stale threshold is 60 seconds.
- Provider polling interval must be shorter than 60 seconds.
- Current preferred polling candidate is 30 seconds.
- The interval must be revisited after provider rate limit, terms, latency, pricing, and reliability are known.
- 30-second polling is not final until the selected provider's official rate limit and commercial terms allow it.

## Official Research Summary
- Research document: `docs/fx-provider-research.md`.
- Research principle: provider/source official docs, official pricing/terms pages, and official API responses only.
- Korea Eximbank and Bank of Korea ECOS support official USD/KRW or USD/KRW-equivalent reference data, but their official docs/data shape fit `official_batch` reference/settlement better than `/fx quote` primary.
- Open Exchange Rates ordinary plans are too slow for 60-second quote freshness; VIP-level updates require contract review.
- Currencylayer and exchangerate.host list 60-second update tiers, but exact 60-second cadence leaves no margin against `FX_RATE_STALE`.
- Twelve Data and OANDA remain stronger `provider_api` primary candidates to review, but USD/KRW availability, timestamp reliability, commercial usage, and 30-second polling must still be confirmed.
- Alpha Vantage remains a candidate only after real-key USD/KRW validation and commercial/polling review.
- Provider final selection pending.

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
- Select the final provider or official source.
- Decide API key/secret management.
- Confirm polling interval.
- Confirm provider timestamp reliability.
- Decide `sourceType` priority when `provider_api`, `official_batch`, and `admin_manual` rows coexist.
- Decide whether `effectiveAt` uses provider timestamp or server `capturedAt` when provider timestamp is missing.
- Decide retry/backoff and operational alerting.
- Decide retention/archive policy for polling-created snapshots.
- Confirm commercial usage and terms.
- Decide whether `.env.example` and config must be updated in the implementation task.
- Decide scheduler execution model.
- Decide whether a latest-value cache table is needed.
- Decide whether `/fx execute` uses the same 60-second freshness rule as quote.

## Next Step
- Review `docs/fx-provider-research.md`.
- Select provider/source only after official rate limit, terms, timestamp, and polling checks are accepted.
- Keep `provider_api` primary and `official_batch` reference/settlement candidates until final selection.
- Do not use web search results or non-official summaries as source of truth.
