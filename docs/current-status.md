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
- `POST /api/v1/fx/execute` 1차 구현 완료
  - write path는 구현됨.
  - 실제 PostgreSQL/Prisma DB integration spec 통과.
  - 실제 PostgreSQL transaction 내부 DB-level failure injection 기반 rollback proof 일부 보강 완료.
  - `responsePayloadJson` storage 단독 DB-level failure injection 등 일부 hardening은 남아 있음.

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
- `assets`
- `asset_price_snapshots`
- `positions`

near-term ledger/FX foundation:
- `wallet_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, season join initial_grant write path 구현 완료.
- `exchange_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, `/fx execute` 1차 write path에서 생성.
- `equity_snapshots`: Prisma schema 반영, migration 생성/DB 적용 완료, API/write path 미구현.
- `/fx` DB foundation 반영 완료: `fx_rate_snapshots`, `fx_execute_requests`, `exchange_transactions.fxRateSnapshotId`.
- `/fx` migration 생성 및 로컬 DB 적용 완료: `20260501212120_add_fx_rate_and_execute_safety_tables`.
- asset/price/position foundation 반영 완료: `assets`, `asset_price_snapshots`, `positions`.
- asset/price/position migration 생성 및 로컬 DB 적용 완료: `20260507120158_add_asset_price_position_foundation`.

## 6. 현재 미도입 DB 상태
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
- `/fx execute` final implementation gate: `docs/fx-execute-final-implementation-gate.md`.

## 8. 주요 STOP 상태
### `/fx quote`
- `POST /api/v1/fx/quote` read-only 구현 완료.
- `/fx quote`는 USD/KRW `fx_rate_snapshots`를 읽음.
- `/fx quote`는 wallet mutation 없음.
- `/fx quote`는 `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, `equity_snapshots` 생성을 하지 않음.
- snapshot 없음이면 `FX_RATE_UNAVAILABLE`.
- selected snapshot `effectiveAt`이 quote 시점 기준 60초 초과 stale이면 `FX_RATE_STALE`.
- quote response는 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 포함.
- 승인된 `admin_manual` USD/KRW snapshot 기준 `/fx quote` 통합 smoke 검증 통과.
  - CLI dry-run 후 non-dry-run snapshot 입력 성공.
  - 입력 snapshot: rate `1450.00000000`, sourceType/sourceName `admin_manual`, approvedByUserId `usr_dev_001`, effectiveAt/capturedAt `2026-05-07T10:01:53.000Z`.
  - smoke 당시 fresh 조건 통과: `ageMsAtCheck = 41822`로 60초 이내.
  - auth 본체 미완성으로 HTTP 대신 실제 Prisma/PostgreSQL을 사용하는 `FxService.quote(userId, body)` 직접 호출 검증.
  - KRW -> USD, USD -> KRW 양방향 quote 성공.
  - quote 응답의 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 확인.
  - quote 전후 mutation 없음 확인: `exchange_transactions 0 -> 0`, `wallet_transactions 1 -> 1`, `fx_execute_requests 0 -> 0`, `equity_snapshots 0 -> 0`.

### FX rate input/provider
- `admin_manual` FX rate input CLI 구현 완료: `scripts/admin-insert-fx-rate.ts`.
- `admin_manual`은 bootstrap/fallback/manual correction 경로.
- `/fx quote` smoke용 승인된 `admin_manual` snapshot 1건 입력 및 소비 검증 완료.
- 입력한 manual snapshot은 smoke 당시 fresh였지만 60초 이후에는 정책상 stale이 되므로, 지속적인 quote 성공에는 별도 승인 snapshot 입력 또는 향후 ingestion 경로가 필요함.
- provider_api/official_batch/scheduler 구현 없음.
- provider final selection은 아직 확정 아님.
- OANDA는 primary candidate, Twelve Data는 secondary candidate.
- OANDA trial/API 계약 검증 전 provider implementation STOP.
- 30초 polling은 후보이며 provider rate limit/terms 확인 후 확정.

### `/fx execute`
- `/fx execute`는 write path 1차 구현 완료 상태.
- 실제 PostgreSQL/Prisma DB integration spec 통과 상태.
- 구현된 범위:
  - request validation/preflight.
  - active season/participant read.
  - idempotency existing command short-circuit.
  - approved fresh `admin_manual` FX snapshot selection.
  - source/target wallet candidate read.
  - pending `fxExecuteRequest` 생성.
  - guarded conditional source debit.
  - target wallet credit.
  - `exchangeTransaction` 생성.
  - source/target `walletTransaction` 생성.
  - `fxExecuteRequest` succeeded finalization.
  - exact `responsePayloadJson` 저장.
  - succeeded duplicate replay.
- 실제 DB integration 통과 범위:
  - KRW -> USD success write path.
  - succeeded duplicate stored `responsePayloadJson` replay.
  - same idempotencyKey + different payload conflict.
  - insufficient balance no-mutation behavior.
  - no eligible snapshot `FX_RATE_UNAVAILABLE`.
  - stale snapshot `FX_RATE_STALE`.
  - concurrent overspend prevention: one success only, source balance non-negative.
  - concurrent same user + same idempotencyKey + same requestHash race: duplicate request replays stored `responsePayloadJson`; wallet/exchange/ledger mutation은 1회만 발생.
  - exchange row, source/target ledger rows, ledger `balanceAfter`, no fee row, no `equitySnapshot` checks.
- rollback/partial-write proof 상태:
  - unit/mock 기반 transaction rollback proof는 보강됨:
    - source debit failure.
    - target credit failure.
    - exchange row create failure.
    - source ledger create failure.
    - target ledger create failure.
    - `fxExecuteRequest` succeeded finalization / `responsePayloadJson` storage failure.
    - 각 실패에서 staged transaction writes가 commit되지 않음을 검증.
  - 실제 PostgreSQL DB-level transaction rollback proof는 일부 보강됨:
    - pending command 생성 후 source wallet이 transaction 내부에서 사라지는 source debit failure.
    - target wallet credit numeric overflow failure.
    - selected `fx_rate_snapshots` row가 transaction 내부에서 사라지는 `exchange_transactions` FK failure.
    - source wallet이 transaction 내부에서 사라지는 source `wallet_transactions` FK failure.
    - target wallet이 transaction 내부에서 사라지는 target `wallet_transactions` FK failure.
    - `exchange_transactions` row가 transaction 내부에서 사라지는 `fx_execute_requests` finalization FK failure.
    - 각 실패 후 source/target wallet balance, `exchange_transactions`, `wallet_transactions`, succeeded finalization, `responsePayloadJson`, `equity_snapshots`, injected snapshot deletion의 partial commit 없음 검증.
  - 남은 DB-level hardening/리스크:
    - `responsePayloadJson` storage 단독 실패는 현 schema/service 변경 없이 실제 DB 제약으로 안정적으로 유도하기 어려워 보류.
    - ledger insert 실패는 현재 schema상 `referenceId` FK가 없어서 wallet FK deletion 기반으로만 검증됨.
    - 더 많은 운영형 interleaving/장애 시나리오는 별도 recovery 설계 전까지 보류.
- Decimal rounding mode와 scale/formatting 정책은 half-up 기준으로 구현 반영됨.
- requestHash canonical rule은 SHA-256/canonical JSON 기준으로 구현 반영됨.
- error code/status/retryability mapping은 구현 반영됨.
- `idempotencyKey` required 정책은 구현 반영됨.
- pending/succeeded/failed MVP lifecycle은 구현 반영됨.
- stale pending automatic re-execution 금지는 구현 반영됨.
- wallet safety strategy는 guarded conditional source debit MVP 기본 전략으로 구현 반영됨.
- affected row count 0 classification은 구현 반영됨.
- source/target wallet update order는 구현 반영됨.
- `wallet_transactions.balanceAfter` source of truth는 actual post-update wallet balance로 구현 반영됨.
- rollback/partial-write test gate는 unit scaffold와 DB integration 검증 대상으로 남아 있음.
- provider/sourceType coexistence policy는 구현 반영됨.
- near-term allowed execute sourceType은 approved fresh `admin_manual` only.
- `provider_api`는 provider final selection + ingestion implementation approval 전까지 execute source로 허용하지 않음.
- `official_batch`는 settlement/reference/reconciliation 후보이며 real-time execute source가 아님.
- execute-time snapshot selection은 구현 반영됨: allowed sourceType only, USD/KRW, `effectiveAt <= executeNow`, positive rate, order by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- execute-time freshness rule은 구현 반영됨: `> 60_000ms` stale, exactly 60s accepted.
- final implementation test matrix는 `docs/fx-execute-final-implementation-gate.md`에 문서화됨.
- succeeded duplicate replay는 stored `responsePayloadJson`를 사용.
- failed duplicate는 자동 재실행하지 않음.
- stale pending은 recovery-required behavior를 반환.
- idempotency는 `fx_execute_requests`가 소유.
- `exchange_transactions.idempotencyKey`는 없음.
- near-term execute는 `equity_snapshots`를 생성하지 않음.
- MVP execute는 별도 fee wallet transaction row를 만들지 않음.
- target wallet credit은 `netTargetAmount`.
- provider_api ingestion, official_batch ingestion, scheduler, provider final selection, stale pending recovery tool/job, durable quote, records/ranking/settlement는 여전히 미구현.
- DB integration 검증은 Docker compose의 기존 Postgres/Redis 컨테이너로 수행됨.
- DB 연결 확인과 migration status 확인 성공.
- `pnpm test`, `pnpm build`, `FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts` 통과.
- schema/migration/seed/package/env/controller/service/test 변경 없이 검증됨.
- integration spec 삭제/skip/완화 또는 assertion 완화 없음.
- 최초 sandbox 내부 실행은 `/tmp/tsx-1000/*.pipe` IPC `EPERM`으로 실패했으나, sandbox 제한 문제로 판단했고 sandbox 밖 동일 명령 재실행으로 실제 PostgreSQL integration 통과.

### `/home`
- `/home` full implementation은 여전히 불가.
- 이번 asset/price/position foundation 도입으로 `/home` 구현 준비는 일부 진전됨.
- 다만 가격 ingestion/freshness 정책, position mutation, daily portfolio snapshot, ranking source가 아직 없어 valuation/ranking source가 완전히 갖춰진 것은 아님.
- blocker:
  - provider price ingestion
  - asset price freshness policy
  - orders 체결/position mutation
  - `daily_portfolio_snapshots`
  - `season_rankings`
  - valuation/ranking source 부족
- `/home`의 `active + not joined` 응답은 rulepack상 `blocked/guide`여야 하나, 최종 field shape는 아직 미고정.
- `/home`의 `upcoming`, `ended`, `settled` 응답 shape도 아직 미고정.
- `/home` controller/service 구현, 임시 응답 shape 추가, fake 데이터 기반 계산 금지.

## 9. 다음 gate
- OANDA trial/API 계약 검증 전 provider_api/official_batch/scheduler 구현 STOP 유지.
- `/fx execute` 남은 DB-level rollback/partial-write hardening 및 stale pending/unknown outcome recovery 설계.
- `/home` full implementation 가능 판정은 valuation/ranking source table 확보 후 재검토.

## 10. 아직 안 한 것
- home API
- wallets API
- orders API
- ranking
- records
- settlement
- orders 체결
- position mutation
- provider price ingestion
- provider_api ingestion
- official_batch ingestion
- scheduler
- admin API
- fx execute remaining DB-level rollback/recovery hardening
- stale pending recovery tool/job
- durable quote/quoteId/expiresAt

## 11. 마지막 검증 상태
- season current / season join / fx quote / fx execute unit 기준 test/build 통과.
- 승인된 `admin_manual` USD/KRW snapshot 기준 `/fx quote` 통합 smoke 통과.
  - snapshot 입력: `1450.00000000`, sourceType/sourceName `admin_manual`, approvedByUserId `usr_dev_001`, effectiveAt/capturedAt `2026-05-07T10:01:53.000Z`.
  - `FxService.quote(userId, body)` 직접 호출로 실제 PostgreSQL snapshot 소비 확인.
  - KRW -> USD, USD -> KRW 양방향 성공.
  - quote 전후 `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, `equity_snapshots` row count 증가 없음.
- join API는 `request.user.userId` 기준.
- join 시 KRW/USD wallet 2개 생성.
- 이번 asset/price/position foundation 작업은 schema/migration/Prisma generated client 변경 포함.
- `/home` controller/service는 미구현 유지.
- Prisma adapter 방식 유지 중.
- near-term 1단계 migration DB 적용 완료.
- Prisma Client generate 완료.
- DB 연결 확인 성공.
- migration status 확인 성공.
- `assets`, `asset_price_snapshots`, `positions` foundation migration 생성 및 로컬 DB 적용 완료.
- `pnpm test` 통과.
- `pnpm build` 통과.
- `pnpm test -- fx.service.spec.ts` 통과.
- `FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts` 통과.
- `/fx execute` DB integration spec은 실제 PostgreSQL 환경에서 통과.
- `/fx execute` DB integration spec에 concurrent same idempotencyKey race 검증 추가 통과.
- `/fx execute` DB integration spec에 실제 PostgreSQL transaction 내부 DB-level failure injection rollback proof 일부 보강 통과.
- DB integration의 no eligible snapshot helper는 기존 eligible `admin_manual` snapshot 변경을 커밋하지 않도록 transaction rollback isolation 방식으로 개선됨.
- 코드/schema/migration/package/seed/test 변경 없이 `/fx quote` smoke 검증됨.
- integration/test assertion 완화 없음.
- sandbox 내부 `pnpm tsx`는 `/tmp/tsx-1000/*.pipe` IPC `EPERM`으로 실패했으나, sandbox 밖 재실행으로 dry-run, snapshot 입력, smoke 검증 통과.

## 12. TODO
- provider final selection STOP review 수락 및 OANDA trial/API 계약 검증.
- `/fx execute` 실제 DB transaction 내부 강제 실패 기반 rollback 검증 보강.
- ledger insert/exchange row/finalization 실패 유도 integration hardening 검토.
- 지속적인 `/fx quote` 성공을 위한 승인 snapshot 공급 운영 절차 또는 provider/batch ingestion 경로 검토.
- asset price ingestion/source/freshness 정책 설계.
- order execute/position mutation 설계 및 구현.
- daily_portfolio_snapshots 도입.
- season_rankings 도입.
