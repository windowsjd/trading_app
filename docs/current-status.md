# current-status.md

## 현재 상태

### 완료
- 개발환경 세팅 완료
- Nest + Prisma + Postgres 연결 완료
- migration 완료
- seed 완료
- health API 완료

### 구현 완료 API
- GET /api/v1/seasons/current
- POST /api/v1/seasons/{seasonId}/join
- POST /api/v1/fx/quote

### 현재 구조
- Nest
- Prisma 7 (adapter 방식)
- PostgreSQL (Docker)
- Redis (Docker)

### 현재 인증 가정
- 보호 API에서 사용자 식별자는 `request.user.userId` 기준
- auth 본체는 아직 미구현 또는 미완성
- 따라서 보호 API는 실제 auth 연결 전까지 런타임 검증 필요

### 현재 DB 상태(실제 존재 확인 기준)
- users
- seasons
- season_participants
- cash_wallets
- wallet_transactions
- exchange_transactions
- equity_snapshots
- fx_rate_snapshots
- fx_execute_requests

### 현재 DB 상태(아직 없음 / 미도입)
- assets
- asset_price_snapshots
- positions
- daily_portfolio_snapshots
- season_rankings

### near-term 1단계 상태
- `wallet_transactions`: Prisma schema 반영됨, migration 생성/DB 적용 완료, season join initial_grant write path 구현됨
- `exchange_transactions`: Prisma schema 반영됨, migration 생성/DB 적용 완료, API/write path 미구현
- `equity_snapshots`: Prisma schema 반영됨, migration 생성/DB 적용 완료, API/write path 미구현

---

## GET /api/v1/home 구현 판단

### 결론
- `GET /api/v1/home` full implementation은 현재 불가
- 현재 단계는 `/home` controller/service 구현이 아니라 STOP 보고 + 선행 migration 범위 확정까지만 수행
- 임시 API 계약 추가 금지
- fake 데이터 금지

### 현재 가능한 범위(문서 + 실제 스키마 기준)
- 현재 시즌 메타 조회
- 현재 사용자의 시즌 참여 여부 조회
- 참여한 경우 KRW/USD wallet 잔액 조회
- `season_participants`에 저장된 집계 필드 원시값 조회
- 단, 위 원시값만으로 `/home` full response를 truthfully 보장할 수는 없음

### hard blockers (full implementation 기준)
- assets
- asset_price_snapshots
- positions
- daily_portfolio_snapshots
- season_rankings
- rate input 운영 데이터 및 valuation freshness 정책

### near-term required (선행 migration 범위)
- wallet_transactions
- exchange_transactions
- equity_snapshots

### API/state gap
- `/home`의 `active + not joined` 응답은 rulepack상 `blocked/guide`여야 한다는 규칙만 있고 필드 shape는 아직 문서상 미고정
- `/home`의 `upcoming`, `ended`, `settled` 응답 shape도 아직 문서상 미고정
- 따라서 상태별 payload 계약 확정 전에는 `/home` 구현 진행 금지
- `/home` 상태별 응답 계약 초안은 `docs/home-api-contract.md`에 작성됨
- 아직 합의 전 초안이므로 구현 금지

---

## 아직 안 한 것
- home API
- wallets API
- fx execute API
- orders API
- ranking
- records
- settlement

---

## 다음 작업
- 1순위: `/home` controller/service 구현 아님
- 다음은 승인된 fresh snapshot으로 `/fx quote` 통합 smoke 검증
- FX provider/batch ingestion 구현 전 STOP review 수락과 provider 후보/API 계약 조사 필요
- `/fx execute` 전 wallet conditional update, Decimal rounding/scale, failed command lifecycle 정책 확정 필요
- `/home` full implementation 가능 판정은 남은 valuation/ranking source table 확보 후 재검토

### 다음 작업 STOP 가능성
- ranking 계산 근거 부족 가능
- allocation 계산 근거 부족 가능
- equityChart 생성 근거 부족 가능
- USD KRW 환산용 환율 소스 부족 가능

### DB / FX 상태 요약
- 원칙: Prisma 7 + `prisma.config.ts` + adapter 방식 유지, 기존 migration/seed 임의 변경 금지
- near-term ledger tables 반영 완료: `wallet_transactions`, `exchange_transactions`, `equity_snapshots`
- `/fx` DB foundation 반영 완료: `fx_rate_snapshots`, `fx_execute_requests`, `exchange_transactions.fxRateSnapshotId`
- `/fx` migration 생성 및 로컬 DB 적용 완료: `20260501212120_add_fx_rate_and_execute_safety_tables`
- Prisma Client generate 및 build/test/e2e 검증 완료
- `POST /api/v1/fx/quote` read-only 구현 완료
- `/fx quote`는 wallet mutation과 `exchange_transactions`/`wallet_transactions`/`fx_execute_requests`/`equity_snapshots` 생성을 하지 않음
- `/fx quote`는 snapshot 없음이면 `FX_RATE_UNAVAILABLE`, 60초 초과 stale이면 `FX_RATE_STALE`
- quote response는 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 포함
- `admin_manual` FX rate input CLI 구현 완료: `scripts/admin-insert-fx-rate.ts`
- `admin_manual`은 bootstrap/fallback/manual correction 경로이며, 실제 approved rate row insert는 아직 없음
- FX ingestion 설계 문서 작성됨: `docs/fx-rate-ingestion-plan.md`
- FX ingestion STOP review 문서 작성됨: `docs/fx-ingestion-stop-review.md`
- FX provider 후보 공식 문서 기반 조사 문서 작성됨: `docs/fx-provider-research.md`
- FX provider 최종 선정은 아직 안 됨
- 30초 polling은 후보이며 provider rate limit/terms 확인 후 확정
- provider/batch ingestion, admin API, retention 구현 없음
- `/fx execute`는 STOP: wallet conditional update, Decimal rounding/scale, failed command lifecycle, execute-time source policy 확정 필요
- `/home` full implementation은 여전히 불가: `assets`, `asset_price_snapshots`, `positions`, `daily_portfolio_snapshots`, `season_rankings` 필요
- 보류: `/home` controller/service 구현, 임시 응답 shape 추가, fake 데이터 기반 계산

---

## 최근 합의(외부 공유된 계약)
- Developer A에게 전달한 records orders/exchanges item response shape를 API 계약 문서에 고정함.
- records orders item에 `side` 포함
- records orders item에 `orderId`, `assetId`, `name` 포함 방향 유지
- records exchanges item에 `feeCurrency` 포함
- records exchanges item에 `exchangeId` 포함 방향 유지

---

## 마지막 검증 상태
- season current / season join 기준 build 통과
- x-user-id fallback 제거 완료
- join API는 request.user.userId 기준
- join 시 KRW/USD wallet 2개 생성
- schema 변경 없이 구현됨
- `/home` controller/service는 미구현 유지
- Prisma adapter 방식 유지 중
- near-term 1단계 migration DB 적용 완료
- Prisma Client generate 완료
- build 통과

---

## TODO
- 승인된 운영값으로 non-dry-run CLI 입력 후 `/fx quote` 통합 smoke 검증
- FX provider/batch ingestion STOP review 수락
- provider final selection STOP review 또는 provider config/scheduler 설계
- rate input 운영 절차 보강
- wallet conditional update 검증
- Decimal rounding/scale 규칙 확정
- failed command lifecycle 정책 확정
- assets 도입
- asset_price_snapshots 도입
- positions 도입
- daily_portfolio_snapshots 도입
- season_rankings 도입
