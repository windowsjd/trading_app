# 준실시간 체결 정책 v1

## 1. 목적

이 문서는 provider-backed execute/write를 열기 전 체결 기준 가격 정책을 확정하기 위한 설계/정책 foundation이다.

이번 gate에서는 실제 execute/write 구현을 열지 않는다. `/fx execute`, orders create, orders execute는 계속 provider_api closed 상태이며, 지갑/포지션/주문 상태를 provider_api 기준으로 변경하지 않는다.

## 2. 핵심 원칙

- Quote는 고정 체결 가격이 아니라 실행 전 참고 견적이다.
- Execute 시점에는 fresh provider_api price/rate로 다시 가격을 산정한다.
- Quote 대비 execute 가격 또는 환율 변동이 허용범위를 넘으면 체결하지 않고 재견적을 요구한다.
- 허용범위 이내면 quote 가격이 아니라 execute 시점 provider price/rate로 체결한다.
- Execute에는 admin_manual fallback을 기본 허용하지 않는다.
- Emergency admin_manual override가 필요하면 별도 operator override gate로 분리한다.

## 3. Quote TTL

- 기본 TTL은 10초다.
- `expiresAt` 이후 execute 요청은 `QUOTE_EXPIRED`로 거부한다.
- 현재 구현의 quote 응답은 아직 durable quote가 아니며 `quoteId = null`, `expiresAt = null`이다. 이 문서는 다음 gate의 정책 기준이다.

## 4. Execute Freshness

Execute 시점 source freshness 기준:

| 대상 | 기준 |
| --- | --- |
| KRX domestic stock | `capturedAt` 10초 이내 |
| US NAS/NYS stock | `capturedAt` 10초 이내 |
| BINANCE crypto | `capturedAt` 10초 이내 |
| USD/KRW FX | `capturedAt` 60초 이내 |

Provider row가 missing, stale, unavailable, future-dated, non-positive, wrong sourceName/sourceType, or ineligible이면 execute는 실패해야 한다. 기본 admin_manual fallback으로 진행하지 않는다.

## 5. Price Change Threshold

Quote 대비 execute 시점 허용 변동폭:

| 대상 | Max change |
| --- | --- |
| KRX domestic stock | 30 bps = 0.30% |
| US NAS/NYS stock | 50 bps = 0.50% |
| BINANCE crypto | 50 bps = 0.50% |
| USD/KRW FX | 30 bps = 0.30% |

Change bps 계산식:

```text
abs(executeValue - quotedValue) / quotedValue * 10000
```

`quotedValue <= 0`은 invalid policy input이다.

## 6. Market Order Policy

- Market order는 execute 시점 provider price로 체결한다.
- Quote 대비 max bps를 초과하면 `PRICE_CHANGED_REQUOTE_REQUIRED`로 거부한다.
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

## 9. Required Future Durable Quote Model

이번 작업에서는 schema/migration을 만들지 않는다. 다음 execute/write gate에서 durable quote가 필요하면 별도 schema gate로 다룬다.

후보 필드:

- `id`
- `userId`
- `seasonParticipantId`
- `assetId` nullable for FX quote
- `quoteType`: `order` / `fx`
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

## 10. Required Future Error Codes

- `QUOTE_EXPIRED`
- `QUOTE_MISMATCH`
- `PROVIDER_PRICE_UNAVAILABLE`
- `PROVIDER_PRICE_STALE`
- `PROVIDER_RATE_UNAVAILABLE`
- `PROVIDER_RATE_STALE`
- `PRICE_CHANGED_REQUOTE_REQUIRED`
- `RATE_CHANGED_REQUOTE_REQUIRED`
- `ORDER_LIMIT_NOT_MARKETABLE`
- `EXECUTION_SOURCE_INELIGIBLE`
- `EXECUTION_PROVIDER_REQUIRED`

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

## 11. Required Future Audit Fields

Future execute result 또는 execute audit에는 다음 public-safe source evidence가 남아야 한다.

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

- No `/fx execute` provider_api.
- No orders create provider_api.
- No orders execute provider_api.
- No durable quote table.
- No schema/migration.
- No package or lockfile change.
- No scheduler/cron.
- No provider trigger API.
- No batch HTTP API.
- No real trading/account/deposit/withdrawal API.
- No emergency operator override.

## 13. Policy Foundation Code

`src/providers/realtime-execution-policy.ts` contains pure functions for the next gate:

- `calculateChangeBps`
- `isWithinMaxChangeBps`
- `resolveDefaultMaxChangeBps`
- `resolveExecuteFreshnessThresholdSeconds`
- `validateMarketOrderExecutionPrice`
- `validateLimitOrderExecutionPrice`
- `validateQuoteExpiry`
- `validateExecutionProviderSource`

This file is intentionally not connected to current `/fx execute`, orders create, or orders execute service paths.
