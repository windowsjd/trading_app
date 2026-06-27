# v2 Backend Contract Alignment Report

## 수정한 파일 목록

- `src/fx/fx.service.ts`
- `src/fx/fx.service.spec.ts`
- `src/fx/fx.execute.integration.spec.ts`
- `docs/current-status.md`
- `docs/fx-api-contract.md`
- `docs/orders-api-contract.md`
- `docs/rewards-api-contract.md`
- `docs/asset-price-freshness-policy.md`

## 해결한 불일치

- `GET /api/v1/fx/rates/current`의 `refresh` query 기본값을 query 없음 -> `false`로 수정했다.
  - `refresh=true`, `true`, `1`만 provider refresh를 시도한다.
  - query 없음, `refresh=false`, `false`, `0`은 DB snapshot만 읽는다.
  - invalid 값은 `INVALID_REFRESH`를 유지한다.
- `OrdersController` 실제 노출 route와 문서를 맞췄다.
  - 공개 앱 flow는 `POST /api/v1/orders/quote` -> `POST /api/v1/orders`다.
  - `POST /api/v1/orders/:orderId/cancel`은 현재 controller에 노출되지 않는다.
  - `POST /api/v1/orders/:orderId/execute`도 현재 controller에 노출되지 않고, service-level internal compatibility/deprecation path로만 남는다.
- provider source eligibility 문서를 현재 `source-eligibility.policy.ts` allowlist와 맞췄다.
  - quote/read: fresh provider first, approved admin fallback.
  - FX/order execute: fresh eligible `provider_api` only, no default `admin_manual` fallback.
  - settlement valuation: `Season.endAt` 이하 latest valid stored row 사용, execute freshness window 미적용.
- `asset_orderbook_snapshots`는 실제 schema/migration에 존재하므로 provider ingestion foundation 확장 테이블로 문서화했다.
  - MVP 핵심 거래/평가/랭킹/정산 테이블이 아니다.
  - order quote/create/execute pricing, valuation, ranking, settlement에 사용하지 않는다.

## 해결한 미구현/부분구현

- FX execute hardening test를 보강했다.
  - opt-in PostgreSQL runner가 durable `quoteId`와 provider-only execute 계약에 맞는 quote/provider snapshot fixture를 만들도록 갱신했다.
  - `response_payload_json` finalization failure를 transaction-local DB check constraint로 유도하는 rollback case를 추가했다.
  - rollback proof state에 quote active/consumed count를 포함해 quote consume rollback도 비교하도록 했다.
- FX current-rate unit test를 추가했다.
  - query 없음, `false`, `"false"`, `"0"`은 refresh 미호출.
  - `true`, `"true"`, `"1"`은 refresh 호출.
  - invalid 값은 `INVALID_REFRESH`.

## 남긴 항목과 이유

- 외부 reward provider/coupon/point/cash/shipping 자동 지급은 구현하지 않았다. 이번 범위에서 제외다.
- order `/:orderId/execute` exact replay, partial fill, matching engine은 별도 schema/product gate가 필요하므로 구현하지 않았다.
- hoga/orderbook 기반 best bid/ask execution, slippage model은 구현하지 않았다.
- `FX_EXECUTE_DB_INTEGRATION=1 npm run test -- fx.execute.integration.spec.ts` 전체 실행은 로컬 PostgreSQL schema가 현재 Prisma schema보다 뒤처져 실패했다.
  - 진단 결과: DB에 `assets.price_currency` column이 없어 Prisma `P2022`가 발생했다.
  - DB reset, migration 적용, seed 변경은 하지 않았다.
  - default test suite에서는 해당 spec이 opt-in skip 상태로 통과한다.

## 보상 지급 시스템 제외 범위

- 유지:
  - `GET /api/v1/rewards/me`
  - `GET /api/v1/badges/me`
  - internal DB reward fulfillment foundation의 현재 상태 문서화
- 제외:
  - 외부 현금/포인트/쿠폰/기프티콘/배송/provider 지급 자동화
  - scheduler reward 자동 지급
  - Reward Policy / Catalog 기반 reward-grant write path
- `settled`는 final rank/final tier 확정을 의미한다.
- reward 지급 완료 여부는 `settled` 전환 조건이 아니다.

## 실행한 검증 명령과 결과

- `pnpm exec prettier --write src/fx/fx.service.ts src/fx/fx.service.spec.ts src/fx/fx.execute.integration.spec.ts`: 통과.
- `npm run test -- fx.service.spec.ts`: 통과, 87 passed.
- `npm run test -- fx.execute.integration.spec.ts`: 통과, opt-in spec skip.
- `npm run build`: 통과.
- `npm run test`: 통과, 80 passed / 4 skipped suites, 1000 passed / 4 skipped tests.
- `npm run test:e2e`: sandbox에서는 local listener bind가 `listen EPERM 0.0.0.0`로 실패했으나, escalated rerun 통과, 107 passed.
- `FX_EXECUTE_DB_INTEGRATION=1 npm run test -- fx.execute.integration.spec.ts`: 실패. 로컬 PostgreSQL schema mismatch(`assets.price_currency` missing)로 차단.

