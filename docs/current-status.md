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
- 먼저 rate input CLI 설계/구현 또는 `/fx quote` 통합 검증
- `/home` full implementation 가능 판정은 남은 valuation/ranking source table 확보 후 재검토

### 다음 작업 STOP 가능성
- ranking 계산 근거 부족 가능
- allocation 계산 근거 부족 가능
- equityChart 생성 근거 부족 가능
- USD KRW 환산용 환율 소스 부족 가능

### Prisma migration 계획 초안
- 원칙: Prisma 7 + `prisma.config.ts` + adapter 방식 유지
- 원칙: 기존 migration/seed 임의 변경 금지
1단계(near-term):
- `wallet_transactions`: cash wallet 증감 원장 확보
- `exchange_transactions`: KRW/USD 환전 이력 및 수수료 근거 확보
- `equity_snapshots`: 참가자 단위 평가 스냅샷 근거 확보
- near-term migration 설계 확정안 후보 작성됨
- near-term 1단계 Prisma schema 반영됨
- `add_near_term_ledger_tables` migration 생성 및 로컬 DB 적용 완료
- Prisma Client generate 완료
- build 통과
- 오래된 Hello World 테스트는 현재 health API 기준으로 정리됨
- package dependency 이상 항목(`config`) 정리됨
- current-status 중복 문장 정리됨
- season join 시 KRW initial_grant ledger 구현됨
- seed dev participant에도 initial_grant ledger 정합성 반영됨
- USD 0 amount ledger row는 여전히 생성하지 않음
- `/fx` quote/execute API 계약 문서 작성됨: `docs/fx-api-contract.md`
- `/fx` execute safety plan 문서 작성됨: `docs/fx-execute-safety-plan.md`
- `fx_rate_snapshots` 설계 문서 작성됨: `docs/fx-rate-snapshots-plan.md`
- `/fx quote` STOP review 문서 작성됨: `docs/fx-quote-stop-review.md`
- wallet/fx write path 설계 문서 작성됨: `docs/wallet-fx-write-path-plan.md`
- rate input path 설계 문서 작성됨: `docs/fx-rate-input-path-plan.md`
- `/fx quote` read-only 구현됨
- `/fx execute`, `/wallets`, `/home` 구현 없음
- 권장 idempotency 전략은 `fx_execute_requests` command table
- 권장 wallet safety 전략은 conditional update 우선 검토
- idempotency용 `fx_execute_requests` schema/migration 반영됨
- `fx_rate_snapshots` schema/migration 반영됨
- `/fx` migration scope plan 문서 작성됨: `docs/fx-migration-scope-plan.md`
- 권장 migration 범위는 `fx_rate_snapshots` + `fx_execute_requests` + `exchange_transactions.fxRateSnapshotId`
- `/fx` schema는 Prisma schema에 반영됨
- `/fx` migration 생성 및 로컬 DB 적용 완료: `20260501212120_add_fx_rate_and_execute_safety_tables`
- Prisma Client generate 완료
- build/test/e2e 통과
- fake/static/temporary FX rate 금지 유지
- `fx_rate_snapshots` seed 없음
- MVP rate input 우선안은 `admin_manual`
- `admin_manual` FX rate input CLI 구현됨: `scripts/admin-insert-fx-rate.ts`
- CLI는 create only이며 upsert하지 않음
- CLI dry-run 지원
- CLI는 fake/static/temporary/sample/placeholder/test 성격 rate 입력 거부
- `/fx quote` 통합 검증 절차 문서 작성됨: `docs/fx-quote-integration-check.md`
- 아직 admin API 없음
- 아직 provider/batch rate input 없음
- snapshot 없으면 `FX_RATE_UNAVAILABLE`
- no-threshold MVP 정책 적용
- `rateCapturedAt`/`rateEffectiveAt` 응답 포함
- `/fx quote`는 wallet mutation 없음
- `exchange_transactions`/`wallet_transactions`/`fx_execute_requests`/`equity_snapshots` 생성 없음
- quoteId/expiresAt은 null
- `/fx execute` 구현 STOP 유지
- `/fx quote` 문서설계 및 read-only 구현 완료
- `/fx execute` 기준으로는 일부 정책 보류
- `equity_snapshots` 생성 여부는 구현 전 최종 결정 필요
- `/home` full implementation은 여전히 불가
2단계(full `/home` blockers 해소):
- `assets`: 종목 마스터 확보
- `asset_price_snapshots`: 자산 평가 가격 소스 확보
- `fx_rate_snapshots`: USD -> KRW 환산 소스 확보
- `positions`: 보유 수량/평단/실현손익 근거 확보
- `daily_portfolio_snapshots`: 일별 총자산/수익률/드로다운 추이 근거 확보
- `season_rankings`: 시즌 랭킹/티어 근거 확보
보류:
- `/home` controller/service 구현
- 임시 응답 shape 추가
- fake 데이터 기반 계산

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
- `/fx quote` 통합 검증
- rate input 운영 절차 보강
- wallet conditional update 검증
- Decimal rounding/scale 규칙 확정
- failed command lifecycle 정책 확정
- assets 도입
- asset_price_snapshots 도입
- positions 도입
- daily_portfolio_snapshots 도입
- season_rankings 도입
