# current-status.md

## 1. 현재 상태
- 개발환경 세팅 완료.
- Nest + Prisma + PostgreSQL 연결 완료.
- 기존 migration/seed 적용 완료.
- health API 완료.
- Prisma 7 + `prisma.config.ts` + adapter 방식 유지 중.
- 기존 migration/seed 임의 변경 금지.
- fake 데이터 기반 계산 금지.
- fake/static/temporary/sample/test business FX rate 금지.

## 2. 구현 완료 API
- `GET /api/v1/seasons/current`
- `POST /api/v1/seasons/{seasonId}/join`
- `POST /api/v1/fx/quote`

## 3. 현재 구조
- Nest
- Prisma 7 adapter 방식
- PostgreSQL (Docker)
- Redis (Docker)

## 4. 현재 인증 가정
- 보호 API에서 사용자 식별자는 `request.user.userId` 기준.
- auth 본체는 아직 미구현 또는 미완성.
- 보호 API는 실제 auth 연결 전까지 런타임 검증 필요.
- `x-user-id` fallback 제거 완료.

## 5. 현재 DB 상태
실제 존재 확인 기준:
- `users`
- `seasons`
- `season_participants`
- `cash_wallets`
- `wallet_transactions`
- `exchange_transactions`
- `equity_snapshots`
- `fx_rate_snapshots`
- `fx_execute_requests`

near-term ledger/FX foundation:
- `wallet_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, season join initial_grant write path 구현 완료.
- `exchange_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, API/write path 미구현.
- `equity_snapshots`: Prisma schema 반영, migration 생성/DB 적용 완료, API/write path 미구현.
- `/fx` DB foundation 반영 완료: `fx_rate_snapshots`, `fx_execute_requests`, `exchange_transactions.fxRateSnapshotId`.
- `/fx` migration 생성 및 로컬 DB 적용 완료: `20260501212120_add_fx_rate_and_execute_safety_tables`.

## 6. 현재 미도입 DB 상태
- `assets`
- `asset_price_snapshots`
- `positions`
- `daily_portfolio_snapshots`
- `season_rankings`

## 7. 완료된 문서/설계 상태
- `/home` 상태별 응답 계약 초안: `docs/home-api-contract.md`.
- records API 계약: `docs/records-api-contract.md`에 orders `side`/`orderId`/`assetId`/`name`, exchanges `feeCurrency`/`exchangeId` 방향 반영.
- `/fx quote` STOP review: `docs/fx-quote-stop-review.md`.
- `/fx` API 계약 초안: `docs/fx-api-contract.md`.
- FX rate input path plan: `docs/fx-rate-input-path-plan.md`.
- FX rate ingestion plan: `docs/fx-rate-ingestion-plan.md`.
- FX ingestion STOP review: `docs/fx-ingestion-stop-review.md`.
- FX provider 후보 공식 문서 기반 조사: `docs/fx-provider-research.md`.
- FX provider final selection STOP review: `docs/fx-provider-final-selection-stop-review.md`.
- `/fx execute` safety plan: `docs/fx-execute-safety-plan.md`.
- wallet/FX write path plan: `docs/wallet-fx-write-path-plan.md`.
- `/fx execute` preimplementation readiness audit: `docs/fx-execute-preimplementation-readiness-audit.md`.
- `/fx execute` STOP decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- FX Decimal rounding/scale policy: `docs/fx-decimal-rounding-scale-policy.md`.
- FX execute error policy: `docs/fx-execute-error-policy.md`.
- FX idempotency lifecycle policy: `docs/fx-idempotency-lifecycle-policy.md`.

## 8. 주요 STOP 상태
### `/fx quote`
- `POST /api/v1/fx/quote` read-only 구현 완료.
- `/fx quote`는 USD/KRW `fx_rate_snapshots`를 읽음.
- `/fx quote`는 wallet mutation 없음.
- `/fx quote`는 `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, `equity_snapshots` 생성을 하지 않음.
- snapshot 없음이면 `FX_RATE_UNAVAILABLE`.
- selected snapshot `effectiveAt`이 quote 시점 기준 60초 초과 stale이면 `FX_RATE_STALE`.
- quote response는 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 포함.

### FX rate input/provider
- `admin_manual` FX rate input CLI 구현 완료: `scripts/admin-insert-fx-rate.ts`.
- `admin_manual`은 bootstrap/fallback/manual correction 경로.
- 실제 approved rate row insert는 아직 없음.
- provider_api/official_batch/scheduler 구현 없음.
- provider final selection은 아직 확정 아님.
- OANDA는 primary candidate, Twelve Data는 secondary candidate.
- OANDA trial/API 계약 검증 전 provider implementation STOP.
- 30초 polling은 후보이며 provider rate limit/terms 확인 후 확정.

### `/fx execute`
- `/fx execute`는 STOP.
- `/fx execute` 구현 전 readiness audit 문서화 완료.
- `/fx execute` 구현 전 남은 STOP:
  - provider coexistence/fallback policy
  - execute-time sourceType priority
  - execute-time snapshot selection/freshness/sourceType policy final gate
  - 실제 구현 전 test matrix 반영
  - wallet safety implementation proof 및 테스트 검증
- Decimal rounding mode와 scale/formatting 정책은 half-up 기준으로 문서상 확정됨.
- requestHash canonical rule은 SHA-256/canonical JSON 기준으로 문서상 확정됨.
- error code/status/retryability mapping은 문서상 확정됨.
- `idempotencyKey` required 정책은 문서상 확정됨.
- pending/succeeded/failed MVP lifecycle은 문서상 확정됨.
- stale pending automatic re-execution은 금지로 문서상 확정됨.
- wallet safety strategy는 guarded conditional source debit MVP 기본 전략으로 문서상 확정됨.
- affected row count 0 classification은 문서상 확정됨.
- source/target wallet update order는 문서상 확정됨.
- `wallet_transactions.balanceAfter` source of truth는 actual post-update wallet balance로 문서상 확정됨.
- rollback/partial-write test gate는 문서상 확정됨.
- succeeded duplicate replay는 stored `responsePayloadJson`를 사용.
- failed duplicate는 자동 재실행하지 않음.
- stale pending은 recovery-required behavior를 반환.
- idempotency는 `fx_execute_requests`가 소유.
- `exchange_transactions.idempotencyKey`는 없음.
- near-term execute는 `equity_snapshots`를 생성하지 않음.
- MVP execute는 별도 fee wallet transaction row를 만들지 않음.
- target wallet credit은 `netTargetAmount`.
- 코드/스키마/마이그레이션/seed/package/env 변경 없이 policy 문서만 보강됨.

### `/home`
- `/home` full implementation은 여전히 불가.
- blocker:
  - `assets`
  - `asset_price_snapshots`
  - `positions`
  - `daily_portfolio_snapshots`
  - `season_rankings`
  - valuation/ranking source 부족
- `/home`의 `active + not joined` 응답은 rulepack상 `blocked/guide`여야 하나, 최종 field shape는 아직 미고정.
- `/home`의 `upcoming`, `ended`, `settled` 응답 shape도 아직 미고정.
- `/home` controller/service 구현, 임시 응답 shape 추가, fake 데이터 기반 계산 금지.

## 9. 다음 gate
- 승인된 fresh `admin_manual` snapshot으로 `/fx quote` 통합 smoke 검증.
- OANDA trial/API 계약 검증 전 provider_api/official_batch/scheduler 구현 STOP 유지.
- `/fx execute`는 `docs/fx-execute-stop-decision-tracker.md`의 STOP decision 해소 또는 safe default 승인 후 별도 구현 task로 진행.
- `/fx execute`는 error/idempotency/wallet safety/rollback gate accepted 이후에도 provider/sourceType, execute-time snapshot policy final gate, implementation proof, test matrix 때문에 STOP 유지.
- `/home` full implementation 가능 판정은 valuation/ranking source table 확보 후 재검토.

## 10. 아직 안 한 것
- home API
- wallets API
- fx execute API
- orders API
- ranking
- records
- settlement
- provider_api ingestion
- official_batch ingestion
- scheduler
- admin API

## 11. 마지막 검증 상태
- season current / season join 기준 build 통과.
- join API는 `request.user.userId` 기준.
- join 시 KRW/USD wallet 2개 생성.
- schema 변경 없이 구현됨.
- `/home` controller/service는 미구현 유지.
- Prisma adapter 방식 유지 중.
- near-term 1단계 migration DB 적용 완료.
- Prisma Client generate 완료.
- build 통과.

## 12. TODO
- 승인된 운영값으로 non-dry-run CLI 입력 후 `/fx quote` 통합 smoke 검증.
- provider final selection STOP review 수락 및 OANDA trial/API 계약 검증.
- `/fx execute` STOP decision tracker 검토.
- provider coexistence/fallback policy 확정.
- execute-time sourceType priority 확정.
- guarded conditional source debit 구현 proof 및 concurrency/rollback 테스트 반영.
- half-up Decimal 및 requestHash canonical rule 구현 전 테스트 gate 반영.
- execute-time snapshot selection/freshness/sourceType policy 확정.
- error/idempotency lifecycle accepted 정책 구현 전 테스트 matrix 반영.
- assets 도입.
- asset_price_snapshots 도입.
- positions 도입.
- daily_portfolio_snapshots 도입.
- season_rankings 도입.
