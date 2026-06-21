# 준실시간 체결 정책 v1

## 1. 목적

이 문서는 Durable Quote 기반 provider-backed execute/write 체결 기준 가격 정책의 현재 source of truth다.

2026-06-08 gate에서 `/fx execute`와 orders execute는 durable quote 기반 provider-backed execute로 열렸다. Orders create는 durable quote를 검증/바인딩해 submitted order를 만들지만 지갑/포지션/체결 상태 변경은 orders execute에서만 수행한다.

## 2. 핵심 원칙

- Quote는 고정 체결 가격이 아니라 실행 전 참고 견적이다.
- Execute 시점에는 fresh provider_api price/rate로 다시 가격을 산정한다.
- Quote 대비 execute 가격 또는 환율 변동이 허용범위를 넘으면 체결하지 않고 재견적을 요구한다.
- 허용범위 이내면 quote 가격이 아니라 execute 시점 provider price/rate로 체결한다.
- Execute에는 admin_manual fallback을 기본 허용하지 않는다.
- Emergency admin_manual override가 필요하면 별도 operator override gate로 분리한다.

## 3. Quote TTL

- 기본 TTL은 15초다.
- `expiresAt` 이후 execute 요청은 `QUOTE_EXPIRED`로 거부한다.
- `/fx quote`와 orders quote는 durable quote를 저장하고 `quoteId`, `expiresAt`, `maxChangeBps`를 응답한다.
- 성공한 execute는 quote를 같은 transaction 안에서 `consumed`로 전환한다. Execute 전 validation failure는 quote를 active로 남기며, 만료 감지는 `expired` 전환을 시도한 뒤 `QUOTE_EXPIRED`를 반환한다.

## 4. Execute Freshness

Execute 시점 source freshness 기준:

| 대상               | 기준                   |
| ------------------ | ---------------------- |
| KRX domestic stock | `capturedAt` 10초 이내 |
| US NAS/NYS stock   | `capturedAt` 10초 이내 |
| BINANCE crypto     | `capturedAt` 10초 이내 |
| USD/KRW FX         | `capturedAt` 60초 이내 |

Provider row가 missing, stale, unavailable, future-dated, non-positive, wrong sourceName/sourceType, or ineligible이면 execute는 실패해야 한다. 기본 admin_manual fallback으로 진행하지 않는다.

## 5. Price Change Threshold

Quote 대비 execute 시점 허용 변동폭:

| 대상               | Max change     |
| ------------------ | -------------- |
| KRX domestic stock | 30 bps = 0.30% |
| US NAS/NYS stock   | 30 bps = 0.30% |
| BINANCE crypto     | 30 bps = 0.30% |
| USD/KRW FX         | 30 bps = 0.30% |

Change bps 계산식:

```text
abs(executeValue - quotedValue) / quotedValue * 10000
```

`quotedValue <= 0`은 invalid policy input이다.

## 6. Market Order Policy

- Market order는 execute 시점 provider price로 체결한다.
- Quote 대비 max bps를 초과하면 API 응답은 `RATE_CHANGED_REQUOTE_REQUIRED`로 거부한다.
- 허용범위 이내면 quote price가 아니라 execute price를 저장한다.

## 7. Limit Order Policy

- Buy: `executePrice <= limitPrice`이면 체결 가능하다.
- Sell: `executePrice >= limitPrice`이면 체결 가능하다.
- Limit 조건을 통과해도 체결 가격은 execute 시점 provider price다.
- Limit 조건 불만족 시 `ORDER_LIMIT_NOT_MARKETABLE`로 거부한다.

## 8. FX Execute Policy

- FX execute는 execute 시점 fresh provider USD/KRW rate로 환전한다.
- Quote 대비 threshold를 초과하면 `RATE_CHANGED_REQUOTE_REQUIRED`로 거부한다.
- FX에는 가격이 아니라 환율 변동이므로 `RATE_CHANGED_REQUOTE_REQUIRED`를 사용한다.
- Provider USD/KRW가 missing/stale/unavailable이면 `PROVIDER_RATE_UNAVAILABLE` 또는 `PROVIDER_RATE_STALE` 계열 오류로 실패해야 한다.

## 9. Durable Quote Model

현재 schema는 `Quote` 모델과 `QuoteType`, `QuoteStatus` enum을 가진다. `Order.quoteId`는 nullable relation으로 submitted order를 quote에 바인딩한다.

주요 필드:

- `id`
- `userId`
- `seasonParticipantId`
- `assetId` nullable for FX quote
- `quoteType`: `order` / `fx`
- `status`: `active` / `consumed` / `expired` / `canceled`
- `side`
- `orderType`
- `quantity`
- `limitPrice`
- `fromCurrency` / `toCurrency`
- `sourceAmount`
- `quotedPrice`
- `quotedRate`
- `assetPriceSnapshotId`
- `fxRateSnapshotId`
- `sourceType` / `sourceName`
- public-safe source metadata
- `maxChangeBps`
- `expiresAt`
- `requestHash`
- `createdAt`
- `consumedAt`
- `updatedAt`

Quote requestHash는 SHA-256 canonical JSON이다. Order quote hash fields는 `userId`, `seasonParticipantId`, `assetId`, `side`, `orderType`, `quantity`, `limitPrice`, `currencyCode`이고, FX quote hash fields는 `userId`, `seasonParticipantId`, `fromCurrency`, `toCurrency`, `sourceAmount`다. FX execute idempotency hash는 trimmed `quoteId`를 포함하며, orders create idempotency hash도 `quoteId`를 포함한다. Decimal strings are normalized before hashing. Raw provider payloads and secrets are excluded.

## 10. Error Codes

- `QUOTE_REQUIRED`
- `QUOTE_NOT_FOUND`
- `QUOTE_NOT_ACTIVE`
- `QUOTE_EXPIRED`
- `QUOTE_MISMATCH`
- `ASSET_PRICE_UNAVAILABLE`
- `PRICE_STALE`
- `PROVIDER_RATE_UNAVAILABLE`
- `PROVIDER_RATE_STALE`
- `RATE_CHANGED_REQUOTE_REQUIRED`
- `ORDER_LIMIT_NOT_MARKETABLE`
- `CONFLICT`

Quote/request mismatch 대상:

- quote의 `assetId`
- `side`
- `orderType`
- `quantity`
- `limitPrice`
- `currencyCode`
- FX `fromCurrency`
- FX `toCurrency`
- FX `sourceAmount`

## 11. Execute Audit/Response Fields

Execute result 또는 execute audit에는 다음 public-safe source evidence가 남아야 한다.

- `quoteId`
- `quotedPrice` / `quotedRate`
- `executePrice` / `executeRate`
- `priceChangeBps` / `rateChangeBps`
- `assetPriceSnapshotId`
- `fxRateSnapshotId`
- `sourceType` / `sourceName`
- `effectiveAt` / `capturedAt`
- `executeAt`
- `idempotencyKey`
- `fallbackUsed = false`

Raw provider payload, `metadataJson`, provider credentials, approval_key, access_token, KIS app key/secret, `DATABASE_URL`, and `.env.local` contents must not be exposed.

## 12. Explicitly Not Implemented In This Gate

- No orders create provider source selection; create binds a durable quote and submits only.
- No package or lockfile change.
- Scheduler/Ops foundation exists separately and is disabled by default; no production cron business automation is opened by this policy.
- No provider trigger API.
- No batch HTTP API.
- No real trading/account/deposit/withdrawal API.
- No emergency operator override.
- No ranking/settlement/reward direct provider_api reads.
- No real external trading/account/deposit/withdrawal API.

## 13. Policy Code

`src/providers/realtime-execution-policy.ts` contains pure policy helpers used by the provider execute gate:

- `calculateChangeBps`
- `isWithinMaxChangeBps`
- `resolveDefaultMaxChangeBps`
- `resolveExecuteFreshnessThresholdSeconds`
- `validateMarketOrderExecutionPrice`
- `validateLimitOrderExecutionPrice`
- `validateQuoteExpiry`
- `validateExecutionProviderSource`

The service paths implement the same policy values. Source eligibility and freshness selection live in `src/providers/source-eligibility.policy.ts`; durable quote hashing lives in `src/providers/durable-quote.policy.ts`.
