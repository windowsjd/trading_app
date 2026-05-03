# FX Provider Final Selection STOP Review

## Status
- Documentation only.
- This document records the provider final selection STOP review based on already completed official-document research.
- This document does not select a final provider.
- Current primary candidate: OANDA.
- Current secondary candidate: Twelve Data.
- Provider final selection remains pending until the remaining STOP decisions are accepted.
- Do not implement `provider_api`, `official_batch`, scheduler, admin API, `/fx execute`, wallet mutation, schema changes, migrations, seed changes, Prisma Client generate, package changes, `.env.example` changes, or `/fx quote` behavior changes from this document.

## Purpose
- Summarize the already researched OANDA and Twelve Data comparison for USD/KRW provider selection.
- Keep the current `/fx quote` freshness rule visible before provider ingestion work starts.
- Record why OANDA is the current primary candidate and Twelve Data is the secondary or budget-sensitive candidate.
- Make clear that this is a STOP review document, not an implementation instruction.

## Current project constraints
- `POST /api/v1/fx/quote` read-only implementation is complete.
- `/fx quote` reads USD/KRW snapshots from `fx_rate_snapshots`.
- Missing snapshot returns `FX_RATE_UNAVAILABLE`.
- A selected snapshot whose `effectiveAt` is older than 60 seconds at quote time returns `FX_RATE_STALE`.
- A snapshot exactly within 60 seconds is accepted.
- `quoteId` and `expiresAt` are `null`.
- Response includes `rateCapturedAt` and `rateEffectiveAt`.
- `/fx quote` does not write wallets, `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, or `equity_snapshots`.
- `admin_manual` FX rate input CLI is a bootstrap, fallback, and manual correction path.
- `provider_api` and `official_batch` ingestion are not implemented.
- `/fx execute` remains STOP.
- Provider final selection is not confirmed.
- United States stock flows use the USD wallet.
- Final evaluation is total assets in KRW.
- Trading and FX exchange must be blocked after season end.

## Official research basis
- Basis document: `docs/fx-provider-research.md`.
- This document uses only the already provided official-document research result.
- No new research is performed here.
- Currencylayer, exchangerate.host, and Alpha Vantage remain supporting candidates only; see `docs/fx-provider-research.md`.
- Korea Eximbank and BOK ECOS remain `official_batch`, reference, or settlement candidates and are not promoted to primary quote provider candidates.

## OANDA findings
- OANDA Exchange Rates API officially describes REST/HTTPS access, JSON/XML/CSV response formats, UTC timestamps, and fully redundant servers.
- OANDA officially describes daily average exchange rates, real-time rates, forward rates, tick-level data, and FX order book data.
- Real-time rates are officially described as streaming bid/ask/midpoint rates over REST or FIX API.
- Official pricing/API plan material indicates 5-second or 3-to-5-second spot updates.
- OANDA plans appear to start at Lite, around USD 450/month or USD 4,850/year.
- Lite includes 100,000 quotes/month; higher plans include unlimited quotes and 3-to-5-second spot or streaming rates.
- OANDA officially provides a 7-day free API key trial.
- Public converter output confirms USD/KRW can be viewed, but that is not the same as verifying Exchange Rates API endpoint response mapping.
- Trial-key validation is still required for USD/KRW pair support, response field names, timestamp field, and bid/ask/mid field mapping.
- OANDA is the best technical fit for the current 60-second stale threshold and a 30-second polling candidate.

OANDA remaining STOP items:
- Contract and cost approval.
- USD/KRW exact API support verification with trial key.
- Response timestamp field confirmation.
- Applied-rate basis decision among bid, ask, and midpoint.
- Confirmation that 30-second polling is allowed by contract and usage policy.
- API key and secret management.
- Retry, backoff, and alerting policy.
- `sourceType` priority.

## Twelve Data findings
- Twelve Data `/exchange_rate` officially provides real-time exchange rates for forex and crypto currency pairs.
- The symbol format uses slash-delimited pairs such as `EUR/USD`.
- The response includes `symbol`, `rate`, and `timestamp`.
- Official docs define `timestamp` as the Unix timestamp of the rate.
- API credit cost is 1 credit per symbol.
- Twelve Data's forex page officially lists 140 world currencies, 2,000+ forex pairs, and KRW support.
- Twelve Data's official market page confirms the USD/KRW forex pair.
- The forex page also states prices are updated at least once per minute depending on the currency pair.
- That once-per-minute wording leaves very little margin against the current 60-second stale threshold.
- Even with 30-second polling, provider timestamps near the 60-second boundary could cause frequent `FX_RATE_STALE` responses.
- Individual pricing is for personal, internal, non-commercial purposes.
- Business pricing is for commercial, external, and professional use.
- Venture and higher plans provide external display data access.
- API credits reset by minute.
- Basic has an 800/day limit; paid plans show no daily limit.
- Twelve Data has favorable cost/API structure, but lower freshness margin than OANDA.

Twelve Data remaining STOP items:
- USD/KRW live-key response verification.
- Source timestamp freshness measurement.
- Stale frequency verification under 30-second polling.
- Business plan requirement decision.
- Commercial and external display usage condition confirmation.
- API key and secret management.
- Retry, backoff, and alerting policy.
- `sourceType` priority.

## OANDA vs Twelve Data comparison
| Area | OANDA | Twelve Data |
| --- | --- | --- |
| Current role | Primary candidate | Secondary / budget-sensitive candidate |
| Freshness fit | Stronger fit because official material indicates 5-second or 3-to-5-second spot updates | Weaker margin because official forex page says updates are at least once per minute depending on pair |
| 60-second stale threshold | Technically well aligned if USD/KRW and timestamp mapping validate | Risk of frequent stale responses if source timestamp drifts near 60 seconds |
| 30-second polling candidate | Likely technically compatible, but contract/usage policy confirmation is still required | Operationally possible to test, but freshness and credit/terms behavior must be measured |
| Cost | High cost; Lite starts around USD 450/month or USD 4,850/year | More budget-sensitive option |
| USD/KRW validation | Public converter shows USD/KRW, but Exchange Rates API mapping still needs trial validation | Official pages indicate KRW and USD/KRW, but live-key response still needs validation |
| Timestamp mapping | UTC timestamp is officially described, but exact response field needs trial/docs confirmation | Response timestamp is officially documented as Unix timestamp of the rate |
| Rate basis | Bid/ask/mid policy decision required | Single `rate` field candidate, subject to response validation |
| Commercial usage | Contract review required | Business plan and external display condition review required |
| Implementation status | STOP | STOP |

## Recommendation
- Current primary candidate is OANDA.
- Current secondary candidate is Twelve Data.
- Final provider selection is deferred until OANDA trial key validation, cost/contract approval, and USD/KRW response field mapping confirmation are complete.
- OANDA should not be implemented before its USD/KRW API support, response timestamp field, bid/ask/mid mapping, and 30-second polling permission are verified.
- Twelve Data should not be promoted directly to primary because its official once-per-minute update statement leaves insufficient freshness margin for the current 60-second stale threshold.
- This document is a STOP review document, not an implementation instruction.

## Remaining STOP decisions
- Final provider selection.
- OANDA cost and contract approval.
- OANDA trial key validation for USD/KRW.
- OANDA response timestamp field confirmation.
- OANDA applied-rate basis decision: bid, ask, or midpoint.
- Twelve Data live-key USD/KRW response validation.
- Twelve Data measured timestamp freshness and stale frequency under 30-second polling.
- Twelve Data business/commercial/external-display plan requirement.
- API key and secret management.
- Polling interval confirmation.
- Retry/backoff policy.
- Failure alerting policy.
- `sourceType` priority when `provider_api`, `official_batch`, and `admin_manual` rows coexist.
- Whether official batch sources are excluded from quote selection and kept only for reference/settlement.
- Whether `/fx execute` uses the same freshness and source policy as `/fx quote`.

## Explicit non-goals
- No `provider_api` implementation.
- No `official_batch` implementation.
- No scheduler implementation.
- No admin API implementation.
- No `/fx execute` implementation.
- No wallet mutation implementation.
- No schema change.
- No migration creation or modification.
- No seed change.
- No Prisma Client generate.
- No package or lockfile change.
- No `.env.example` change.
- No existing `/fx quote` behavior change.
- No provider final selection confirmation.

## Next implementation gate
- Obtain and test an OANDA trial API key.
- Verify exact USD/KRW Exchange Rates API support.
- Record exact response field mapping for rate, timestamp, and bid/ask/mid.
- Decide applied-rate basis.
- Approve cost, contract, usage policy, and 30-second polling.
- Decide API key/secret management.
- Decide retry, backoff, alerting, and `sourceType` priority.
- Only after those STOP decisions are accepted, create a separate implementation task for provider ingestion.
