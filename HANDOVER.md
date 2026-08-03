# 프로젝트 인수인계서

이 문서는 두 영역으로 구성한다.

1. **작업 단위 기록** — 작업 단위별 목적/변경/검증/주의사항.
2. **최신 작업 시간순 기록** — 최신 작업이 위에 오는 시간순 로그.

세부 계약·정책의 기준 문서는 `backend/docs/*.md`와 `backend/README.md`이며,
이 문서는 "무엇을 왜 바꿨고 다음 사람이 무엇을 알아야 하는가"만 기록한다.

---

## 1. 작업 단위 기록

### 작업 단위: 일반모드 계정·최초 지급·광고 보상 기반 + 작업 5 결함 3종 보완 (2026-08-03, 작업 6)

**목적**

작업 6(일반모드 계정 생성, 최초 10,000,000 KRW 1회 지급, 보상형 광고 자금
지급 백엔드 기반)과 작업 5 검토에서 발견된 세 결함(① account-scoped 주문
취소가 자기 주문의 손상된 scope를 타인 주문과 같은 404로 은폐, ② 이미 커밋된
시장가 주문의 멱등 재시도가 현재 상태 gate에 막힘, ③ 원자 지갑 변경 0행 실패를
일반 CONFLICT/not-found로 뭉뚱그려 scope 손상을 은폐) 보완을 함께 수행.

**이번 작업에서 하지 않은 것**(계속 비활성): 일반계정 실제 주문·환전·Position,
일반모드 포트폴리오 평가·EquitySnapshot·DailyPortfolioSnapshot, 시간가중
수익률, 일반모드 투자손익 표시, 모드 선택·모드 전환 프런트엔드, 광고 SDK,
실제 광고 네트워크 provider adapter, 광고 시청 화면, 시즌 lifecycle 개편,
seasonParticipantId 제거, tradingAccountId NOT NULL 일괄 강화.

**핵심 변경**

- 보완 ①(취소 scope 분류, `src/orders/limit-order-cancel.service.ts`):
  account-scoped 취소의 행 잠금 SQL에서 `o.trading_account_id` 조건을 제거하고
  orderId + 사용자 소유권으로만 잠근 뒤 `assertRequestedAccountScope`가 분류한다.
  참가자 링크=요청 계정 & order scope null → 500
  `TRADING_SCOPE_REPAIR_REQUIRED`, 불일치 → 500
  `TRADING_ACCOUNT_SCOPE_MISMATCH`, 참가자 링크가 달라도 order scope가 요청
  계정을 가리키면 500 mismatch, 둘 다 다르면 404 `ORDER_NOT_FOUND`. 분류는
  시장가 410보다 먼저 실행되고 어떤 오류 경로에서도 주문 상태·예약금이
  변하지 않는다. legacy 취소는 계약(타인 404) 유지 + 자기 주문 scope 손상 시
  기존 fail-closed 유지.
- 보완 ②(시장가 committed replay first, `src/orders/orders.service.ts`):
  account-scoped 경로는 소유권 확인 → `(tradingAccountId, idempotencyKey)`
  조회(+participant·user 고정 legacy null fallback) → replay 순으로 진행하고,
  기존 주문이 없을 때만 general 차단·account active·시즌·참가자·시장·quote·
  지갑·잔액·freshness gate를 실행한다. legacy 경로는 고유 `Order.quoteId` +
  사용자 소유권 기준 replay-first(넓은 `userId+key` 조회 금지). 시장가
  `responsePayloadJson`은 생성·체결 트랜잭션 안에서 저장되며 저장 실패 시
  전체 rollback. 지정가의 quote-scoped replay·예약금·feature flag 정책은
  그대로.
- 보완 ③(지갑 실패 진단, `src/wallets/cash-wallet-failure-diagnosis.ts` 신규):
  0행 UPDATE를 wallet id 단독 재조회로 분류한다(행 없음 → 기존 오류,
  participant/account null/account 불일치/통화 불일치 → 구조화된 500,
  금액 조건 미달 → 기존 잔액·예약금 오류, 전부 정상 → CONFLICT). scope를 금액
  보다 먼저 검사하고 읽기 전용이다. 시장가 debit/credit, 지정가
  reserve/settle/release(취소·만료·운영자 제외 cleanup 공용), FX source
  debit/target credit 전 경로 적용.
- 작업 6 schema/migration 2건
  (`…180000_add_general_account_and_ad_reward_enums` = enum 전용,
  `…181000_add_general_account_and_ad_reward_foundation`): CashWallet·
  WalletTransaction `seasonParticipantId` DROP NOT NULL + 관계 optional,
  `WalletTransactionType.ad_reward`,
  `WalletTransactionReferenceType.general_account_open`·`ad_reward_claim`,
  `AdRewardClaimStatus`, `ad_reward_claims` 테이블(FK 3종 Restrict,
  `(provider, providerEventId)` unique, `walletTransactionId` unique, 인덱스
  3종), partial unique 2종(`general_account_open`/`ad_reward_claim` reference
  단일 행). enum을 별도 migration으로 분리한 이유는 PostgreSQL이 같은
  트랜잭션에서 새 enum 값을 사용하지 못하기 때문이다. Order·Position·
  ExchangeTransaction·FxExecuteRequest는 변경하지 않았다.
- 일반계정 생성(`src/trading-accounts/general-accounts.service.ts`,
  `POST /api/v1/trading-accounts/general`, 200 고정 + `created` boolean):
  계정 + KRW 지갑(1,000만) + USD 지갑(0) + initial grant 원장을 하나의
  트랜잭션으로 생성. 멱등 근거는 기존 partial unique
  `trading_accounts_general_owner_unique`이며 unique 충돌은 승자 재조회 후
  replay. 손상 계정은 `general-account-integrity.ts`의 구조 검사 실패 →
  500 `GENERAL_ACCOUNT_INTEGRITY`(현재 잔액으로 판정하지 않음, 자동 재지급
  없음). suspended/closed 계정은 재활성화·재생성·재지급 없이 그대로 반환.
- account-scoped `wallets`·`wallet-transactions`가 일반계정을 지원한다.
  general은 참가자가 없으므로 시즌 probe 대신 역방향 검사(계정의 지갑·원장에
  seasonParticipantId 존재 금지, 원장의 wallet이 타 계정 금지)를 수행하고
  위반 시 500 `GENERAL_ACCOUNT_INTEGRITY`.
- 광고 보상(`src/ad-rewards/`): provider-neutral `AdRewardVerifier` +
  registry + SHA-256 proof fingerprint, 운영 설정 파서
  `readAdRewardConfig`(기본 disabled, enabled 시 전 항목 필수·엄격 검증,
  일일 경계는 설정 IANA timezone), eligibility/claim/claims 3개 endpoint.
  claim은 외부 verifier 호출을 트랜잭션 밖에서 수행하고, 트랜잭션 안에서
  계정 행 `FOR UPDATE` → 구조 무결성 → 중복 이벤트 → 일일 횟수·금액·cooldown
  재검증 → KRW 지갑 증액(계정+participant null+통화 조건 포함) → `ad_reward`
  원장 → claim granted를 원자적으로 처리한다. 한도에 걸린 검증 완료 이벤트는
  rejected claim으로 commit 후 429(이후 영구 미지급). **운영 registry는
  비어 있어 실제 claim은 503 `AD_REWARD_PROVIDER_UNAVAILABLE`이며 fake
  verifier는 테스트에서만 DI로 주입한다.**
- 운영 점검 `pnpm trading-accounts:audit-general` 추가(read-only 전용,
  `--apply` 없음, findings 발생 시 exit 1).

**검증**(로컬 실행, hosted CI 없음)

- prisma format/validate/generate PASS, typecheck PASS, build PASS.
- unit `pnpm test` PASS — 173 suite / 2,315 test(신규 +72).
- migration 비파괴: dev DB에 시즌 데이터(계정 3·지갑 6·원장 15) 심고 전후
  fingerprint 비교 — 통화별 balance/reserved 합계, txType별 amount,
  referenceType별 건수, 전체 ID·seasonParticipantId 전부 동일. 유일한 차이는
  빈 `ad_reward_claims` 테이블. general 계정 0건 유지.
- opt-in DB 통합 16종 `--runInBand` 직렬 PASS(기존 14종 + 신규
  `general-account.integration.spec.ts`,
  `order-replay-and-cancel-scope.integration.spec.ts`).
- e2e 119/122 pass(신규 4건 포함). 실패 3건(readiness/wallets/orders-cancel)은
  기준 커밋 c08ddc70에서 git stash로 동일 명령·환경 재현 확인한
  **BASELINE_FAIL**.
- `pnpm trading-accounts:audit-general` findings 0, exit 0.
- 실제 광고 provider 연동은 **PROVIDER_NOT_CONFIGURED** — provider 미확정,
  운영 registry 비어 있음. backend 검증은 테스트 전용 fake verifier 기반이며
  실제 provider end-to-end 검증이 아니다.

**주의사항**

- 광고 기능을 켜기 전에 provider adapter 등록이 선행되어야 한다.
  `AD_REWARD_ENABLED=true`만으로는 지급되지 않고 503이 계속 반환된다(부팅 시
  경고 로그로도 알린다).
- 일반계정은 POST 호출로만 생성된다. migration·GET·거래·광고 claim 어디서도
  계정·지갑·자금을 만들지 않으며, 손상 계정에 POST를 다시 호출해도 복구되지
  않는다(500 유지). 복구는 `audit-general` 보고 후 수동 판단이다.
- CashWallet·WalletTransaction의 `seasonParticipantId`가 nullable이 되었으므로
  이 두 모델을 읽는 신규 코드는 null을 시즌 경로 불일치로 취급해야 한다
  (기존 시즌 경로는 `assertCashWalletTradingAccountScope`가 이미 그렇게
  동작한다).
- `limit-order-transaction-time.integration.spec.ts`의 market-close 케이스가
  전체 스위트 직후 1회 flaky 실패했으나, 기준 커밋과 이번 변경 모두에서
  단독 실행·재실행 시 PASS했다(회귀 아님, 타이밍 의존).
- eslint는 HEAD에서도 클린이 아니며(기존 `trading-accounts.service.spec.ts`
  3건) 이번 작업에서도 전체 lint를 통과 조건으로 삼지 않았다. 신규 파일은
  lint 클린이다.

### 작업 단위: 주문·포지션·Quote TradingAccount 전환 + 직전 작업 결함 3종 보완 (2026-08-03, 작업 5)

**목적**

작업 5(Order·Position·Quote의 TradingAccount 기준 전환 + account-scoped
주문·포지션 API 기반)와 직전 작업 4에서 발견된 세 결함(① 지갑 scope
null/불일치 상태에서도 거래 허용, ② account-scoped 금융 조회가 null scope
행을 정상 빈 결과로 은폐, ③ 같은 사용자의 다른 계정 간 FX idempotency key
재사용 차단) 보완을 함께 수행. 일반모드 계정/지갑/지급·광고·시간가중수익률·
프런트 연결·스냅샷 3모델 전환·NOT NULL 강화·seasonParticipantId 제거는
범위가 아니다.

**핵심 변경**

- 보완 ①: 공통 guard `assertCashWalletTradingAccountScope`
  (`src/wallets/cash-wallet-scope.ts`) — 지갑 변경·지갑 잔액 기반 quote 생성
  전에 participant+account scope를 검증(null → 500
  `FINANCIAL_SCOPE_REPAIR_REQUIRED`, 불일치 → 500
  `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`; 자동 backfill·덮어쓰기 금지,
  400류 금지). FX quote/execute·시장가 매수/매도·지정가
  quote/생성/체결/취소/cleanup·운영자 제외 등 balanceAmount/reservedAmount를
  만지는 전 경로 적용. `cash-wallet-atomic.ts`의 4개 원자 UPDATE WHERE에
  `trading_account_id` 추가(검증-업데이트 사이 race도 0행 fail-closed).
- 보완 ②: `trading-account-financial-integrity.ts` — account-scoped
  지갑/원장/환전(그리고 주문/포지션) 조회 전에 참가자 행의 null·불일치
  scope를 findFirst 존재 쿼리로 검사, 발견 시 부분/빈 결과 대신 repair-
  required/mismatch 500. general 계정(참가자 없음)은 스킵되어 정상 빈 결과.
- 보완 ③: FX 전역 `UNIQUE(user_id, idempotency_key)`를 partial unique
  (`… WHERE trading_account_id IS NULL`)로 교체(같은 사용자의 계정 간 키
  재사용 허용; partial 생성 → 전역 DROP 순서, null 중복 발견 시 RAISE로
  fail-closed). 서비스 조회는 legacy endpoint 포함 계정 우선 + legacy null
  행 fallback(user+participant 고정), unique 충돌 후 재조회도 동일 규칙.
- 작업 5 schema/migration
  (`20260803150000_add_trading_scope_and_fx_legacy_partial_unique`):
  Order·Position·Quote에 nullable tradingAccountId + Restrict FK, Order
  `(account, idempotencyKey)` unique + submittedAt/status 인덱스, Position
  `(account, assetId)` unique, Quote 계정 인덱스 2종, TradingAccount 역관계
  3종. additive backfill(IS NULL 가드, 멱등, participant 없는 quote는 null
  유지, 값·상태·hash 불변 — fingerprint로 검증). 스냅샷 3모델·
  LimitOrderCandleEvidence 비변경.
- 신규 writer dual-write + 계정 격리: 시장가/지정가 Order, 주문/FX Quote,
  Position 생성·증가·감소 전부 participant+account 기록(링크 null이면
  `TRADING_ACCOUNT_LINK_INTEGRITY` 중단). 기존 Position update는 scope
  검증(null → `TRADING_SCOPE_REPAIR_REQUIRED`, 불일치 →
  `TRADING_ACCOUNT_SCOPE_MISMATCH`) + updateMany WHERE에 계정 포함(타 계정
  포지션 감소 불가). Quote는 non-null 계정 불일치 시 `QUOTE_MISMATCH`,
  소비는 `id+status+participant+(계정 OR null)` 조건 updateMany(타 계정
  quote 소비 불가), requestHash 계산식 비변경. Order 멱등성은 계정 우선 +
  legacy null fallback(같은 계정 같은 키 replay/conflict, 다른 계정 키
  재사용 허용). 지정가 create는 잠근 참가자 행의 링크 재검증, 자동 체결은
  체결 트랜잭션 안에서 order/participant/quote/wallet/position 계정 일치
  재검증 + 계정 suspended/closed는 skip(주문 유지).
- account-scoped API: `/api/v1/trading-accounts/:accountId/orders`(목록/상세/
  quote/생성/취소 — execute는 legacy에도 없어 미노출)·`/positions`(목록).
  조회는 status 무관 소유자 허용, 타인/미존재 계정·타 계정 orderId 동일 404,
  general 신규 주문 409 `GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED`, suspended/
  closed 신규 quote/주문 409 `TRADING_ACCOUNT_NOT_ACTIVE`. 취소는 보호
  동작이라 status gate 없음(scope 손상 시 repair-required 중단 + rollback).
  legacy 주문/포지션 API 계약 불변, 같은 서비스 코어 공유(수수료·체결가·지갑/
  원장/포지션 변화·멱등성 동일 — DB 통합으로 실측). 계약 문서 신규
  `docs/trading-account-orders-api-contract.md`.
- 운영 스크립트 `trading-accounts:repair-trading-scope`(기본 dry-run) 추가:
  Order·Position·Quote null scope만 참가자 링크로 backfill, mismatch·
  order↔quote 불일치·participant 없는 quote는 보고만(각각
  `TRADING_ACCOUNT_SCOPE_MISMATCH`/`ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH`/
  `QUOTE_PARTICIPANT_SCOPE_MISSING`), apply 후 잔여 시 exit 1. 역할 3단:
  repair-links → repair-financial-scope → repair-trading-scope.

**검증 (로컬 실행 — hosted CI 없음)**

- prisma format/validate/generate·`migrate diff`(DB↔schema 차이 없음)·
  typecheck·build·unit `pnpm test` 2,243 pass.
- dev DB에서 migration 전후 read-only fingerprint 불변(주문·포지션·quote·FX
  값 해시), opt-in PostgreSQL 14스위트 직렬(--runInBand) PASS — 기존 12종
  (join/FX/시장가/지정가 5종/matching/MVP flow/trading-account 3종) + 신규
  `trading-account-trading-scope.integration.spec.ts` 6블록(인덱스/partial
  unique·insert-level unique 의미·repair 스크립트·지정가 lifecycle scope
  fail-closed와 rollback·account 조회 동등성/404/probe·FX 동일 사용자 계정 간
  키 재사용+legacy replay 참가자 고정). 기존 통합 러너들의 fixture를
  dual-write로 갱신.
- e2e 115/118 pass. 실패 3건(readiness/wallets/orders-cancel)은 기준 커밋
  e91921aa에서 git stash로 동일 재현 확인한 env 기인 **BASELINE_FAIL**.
- 운영 CLI 시나리오(dev DB): old-writer null scope 3행(주문·포지션·quote)
  심기 → repair-trading-scope dry-run(보고만) → --apply(3행 backfill, 잔여
  0/0, exit 0) → 값 불변 확인 → 재실행 멱등 exit 0. §20 완료 기준 쿼리
  전부 0(null·mismatch·order-quote 불일치·계정별 중복·legacy partial 위반·
  orphan/general 자동 생성).

**주의사항**

- Order·Position·Quote tradingAccountId는 nullable 유지. NOT NULL 전제와
  통합 배포 순서(migration → 신버전 → 구버전 종료 → repair-links →
  repair-financial-scope → repair-trading-scope → 0건 확인)는
  `docs/trading-modes-and-accounts.md` §3.7.9.
- FX·주문 모두 같은 사용자의 계정 간 idempotency key 재사용이 이제
  허용된다(직전 문서의 "작업 10에서 해소" 주의는 이 작업으로 해소됨).
- 지갑/주문/포지션/quote의 scope 손상 상태에서는 거래·취소·체결·account
  조회가 구조화된 500으로 막힌다 — 복구 스크립트 실행이 선행 조건이다.
- eslint는 HEAD에서도 클린이 아니며 이번 작업에서 전체 lint를 통과 조건으로
  삼지 않았다(기존 관례 유지).

### 작업 단위: 금융(지갑·원장·환전) TradingAccount 전환 + 직전 작업 결함 3종 보완 (2026-08-03)

**목적**

작업 4(지갑·원장·환전의 TradingAccount 기준 전환)와 직전 작업에서 발견된 세
결함(① 과거 excluded 참가자의 active 계정 방치, ② ON CONFLICT 후 저장 계정
미검증, ③ 복구 CLI가 null 잔여에도 성공 종료) 보완을 함께 수행. 주문·포지션
전환, 일반모드 계정/지갑/지급, 광고, NOT NULL 강화, seasonParticipantId 제거는
범위가 아니다.

**핵심 변경**

- 보완 ②: `ensureSeasonTradingAccountLink`가 ON CONFLICT DO NOTHING 이후
  저장된 계정을 **반드시 재조회**해 id/userId/mode/초기자금/openedAt/타 참가자
  연결을 검증한 뒤에만 링크한다($executeRaw 반환값으로 created/linked 구분).
  불일치·미존재는 `TRADING_ACCOUNT_LINK_INTEGRITY` fail-closed. status는 자동
  하향/상향 없음. 실제 PostgreSQL race interleaving(첫 조회 null → 타 트랜잭션
  불일치 삽입 → conflict 무시 → 재조회가 거부) 테스트 포함.
- 보완 ①: `trading-accounts:repair-links`가 excluded 참가자 + active season
  계정 불일치를 함께 점검·보정한다(active→suspended guarded update만;
  suspended/closed/general/userId 불일치는 불변, userId 불일치는 fail-closed
  보고). 제외 API 재호출은 기존 409 계약 유지(자동 보정 없음).
- 보완 ③: CLI 종료 코드 계약 — `--apply`는 실패 ≥1, null link 잔여 ≥1,
  excluded-active 잔여 ≥1, 검증 미조회 중 하나라도 있으면 exit 1 + 원인/재실행
  안내(`resolveRepairLinksExitCode`). dry-run은 분석 완료 시 0(정합성 실패
  발견 시 1).
- 작업 4 schema/migration
  (`20260803120000_add_financial_trading_account_scope`): CashWallet·
  WalletTransaction·ExchangeTransaction·FxExecuteRequest에 nullable
  `tradingAccountId` + Restrict FK, `cash_wallets(trading_account_id,
  currency_code)` unique, `fx_execute_requests(trading_account_id,
  idempotency_key)` unique(legacy (userId,key) unique는 유지 — 같은 사용자의
  계정 간 키 재사용은 작업 10까지 차단됨), 조회 인덱스 3종, TradingAccount
  역관계 4종(캐시 컬럼 금지 유지). backfill은 참가자 링크 복사만(IS NULL 가드,
  멱등, 계정 생성 없음, null 링크 행은 null 유지). dev DB fingerprint 전후
  비교로 행 수·금액·ID 불변 확인.
- dual-write: 시즌 참가(지갑 2 + initial_grant), dev baseline, FX 실행
  (FxExecuteRequest·ExchangeTransaction·출금/입금 원장 — 단일 트랜잭션 유지),
  시장가 매수/매도 원장, 지정가 체결 원장이 모두 participant의
  tradingAccountId를 함께 기록. 참가자 링크 null이면 금융 쓰기를
  `TRADING_ACCOUNT_LINK_INTEGRITY`(500)로 중단(조용한 null 기록 금지).
  Order/Position/Quote/스냅샷 모델은 불변. settlement/adjustment 원장 writer는
  아직 존재하지 않음(enum만).
- 신규 `trading-accounts:repair-financial-scope`
  (`scripts/repair-financial-trading-account-scope.ts` + lib):
  금융 4모델 null scope backfill 전용, 기본 dry-run, 500행 배치, missing
  participant link 행은 보고만(repair-links 먼저 안내), 저장 scope 불일치는
  `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` 보고·덮어쓰기 금지(wallet↔ledger
  불일치 포함), apply 후 null·mismatch 0 재검증, 잔여 시 exit 1, 멱등.
- account-scoped 금융 API: `GET /api/v1/trading-accounts/:accountId/wallets`·
  `wallet-transactions`(조회 — active/suspended/closed 허용, GET은 아무것도
  생성 안 함), `POST .../fx/quote`·`execute`, `GET .../fx/transactions`.
  controller는 wallets/fx 모듈에 두고 TradingAccountsModule의 access service를
  재사용(소유권 404 통일). FX 변경 게이트: mode=season(general은 409
  GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED) + status=active(아니면 409
  TRADING_ACCOUNT_NOT_ACTIVE) + 기존 시즌/참가자/quote 정책 전부. FxService·
  WalletsService의 같은 계산 코드를 legacy와 공유(수수료·환율·원장·멱등·오류
  코드·원자성 동일 — DB 통합으로 실측). idempotency는 계정 unique로 조회
  (같은 계정 replay 동일 응답, 다른 사용자 계정은 같은 키 허용). source/target
  지갑의 account scope 불일치는 fail-closed. legacy wallets/fx 계약 불변.
- 계약 문서 신규 `docs/trading-account-finance-api-contract.md`.

**검증 (로컬 실행 — hosted CI 없음)**

- prisma format/validate/generate·typecheck·build·unit `pnpm test` 전체 pass
  (신규: link 재검증, repair-links 확장/exit, financial-scope lib, wallets/fx
  account-scoped gating, dual-write 단언, schema/migration 계약).
- opt-in PostgreSQL 12스위트 직렬(--runInBand) PASS: 기존 join/FX/시장가/
  지정가 5종/MVP flow/trading-account 2종 + 신규
  `trading-account-financial-scope.integration.spec.ts` 8케이스(backfill
  비파괴·멱등, financial-scope repair, join dual-write + legacy/scoped 지갑·
  원장 동등성, FX legacy/scoped dual-write·동등성·계정 멱등성·cross-user 키
  재사용, suspended/excluded/foreign/general 게이트, excluded-active 보정
  수렴, ON CONFLICT race fail-closed).
- e2e 115/118 pass(신규 6건 포함). 실패 3건(readiness/wallets/orders-cancel)은
  기준 커밋에서 동일 재현되는 BASELINE_FAIL(env 기인).
- 운영 CLI 시나리오(격리 dev DB): financial-scope dry-run이 missing link 차단
  안내 → repair-links --apply(link 1 복구 + excluded-active 1 suspended,
  잔여 0/0, exit 0) → financial-scope --apply(지갑·원장 backfill, 잔액 불변,
  잔여 0, exit 0) → 재실행 멱등.

**주의사항**

- 금융 4모델 tradingAccountId는 nullable 유지. NOT NULL 전제 9가지와 배포
  순서(migration → 신버전 → 구버전 종료 → repair-links → financial-scope →
  0건 확인)는 `docs/trading-modes-and-accounts.md` §3.6.5.
- 전환 기간 동안 같은 사용자의 계정 간 idempotency key 재사용은 legacy
  (userId,key) unique 때문에 계속 차단된다(작업 10에서 해소).
- DB 스위트는 공유 DB라 반드시 `pnpm test --runInBand --runTestsByPath ...`
  직렬 실행(`--` 삽입 금지). e2e는 `JWT_ACCESS_SECRET=test-secret` 필요.
- 통합 러너들이 repair를 DB 전역으로 apply하므로 dev DB에 의도적으로 남겨 둔
  legacy fixture는 러너 실행 후 복구된 상태일 수 있다.

### 작업 단위: TradingAccount null link 복구 + 제외 동기화 + 거래계정 조회 API (2026-08-03)

**목적**

직전 TradingAccount foundation의 배포 경계 보완과 작업 3(거래계정
조회·소유권 검증)을 함께 수행한다. ① 배포 전환 중 구버전 writer가 만들 수
있는 `tradingAccountId=null` 시즌 참가자를 안전하게 복구하고, ② 운영자 참가자
제외 시 연결 계정을 같은 트랜잭션에서 suspended로 동기화하며, ③ 로그인
사용자가 자신의 거래계정 목록/상세를 조회하는 API와 향후 금융 API가 재사용할
소유권 검증 계층을 만든다. 일반모드 계정 생성·최초 지급·광고·거래 API의
accountId 전환·NOT NULL 강화는 이번 범위가 아니다.

**핵심 변경**

- `src/seasons/season-trading-account-link.ts` (신규, 복구 규칙 단일 구현):
  `deriveSeasonTradingAccountId`(migration의 `md5(...)::uuid`와 바이트 동일,
  보안 용도 아님 명시), backfill과 같은 status 매핑, 트랜잭션 내
  `ensureSeasonTradingAccountLink`(raw `INSERT ... ON CONFLICT DO NOTHING` +
  null 가드 `updateMany`로 동시 복구에서도 계정 1개·orphan 0), 읽기 전용
  `preview...`, 불일치 fail-closed 오류 `TRADING_ACCOUNT_LINK_INTEGRITY`.
  Prisma upsert는 이 경로에서 native ON CONFLICT로 내려가지 않아 race에서
  P2002로 트랜잭션이 abort되므로 raw insert를 쓴다(통합 테스트로 실측).
- `joinSeason`: 기존 참가자 조회 select 확장, null link면 같은 트랜잭션에서
  링크만 복구(지갑·원장·스냅샷 불변) 후 **commit 뒤** 기존 409
  `SEASON_ALREADY_JOINED` 반환(트랜잭션 결과를 sentinel로 돌려 409를 밖에서
  던지는 구조로 변경). 복구 실패는 409로 감추지 않고 500 구조화 오류.
- 운영자 제외(`operator-season-moderation.service.ts`): 같은 트랜잭션에서
  링크 복구(필요 시) → 계정 active→suspended(이미 suspended면 idempotent,
  closed는 불변) → 참가자 제외 → 지정가 취소·예약금 반환 → 감사 로그
  (metadata에 tradingAccountId·before/after status·linkRepaired 추가).
- dev baseline(`scripts/lib/dev-baseline.ts`): 기존 참가자의 null link를
  apply에서 링크만 복구(공통 helper 사용), dry-run은 예정만 보고, notes와
  `accountLinkRepaired` 반환 필드에 기록.
- 운영 스크립트 `scripts/repair-missing-trading-account-links.ts` + package
  script `trading-accounts:repair-links`: 기본 dry-run/`--apply` 명시,
  참가자별 독립 트랜잭션·부분 실패 보고·apply 후 null 재검증·멱등.
- 신규 `src/trading-accounts/` 모듈: `GET /api/v1/trading-accounts`(목록,
  openedAt desc 결정적 정렬)·`GET .../:accountId`(상세). 미존재와 타인 소유는
  동일 404 `TRADING_ACCOUNT_NOT_FOUND`, suspended/closed도 소유자는 조회 가능,
  season↔participant 구조 위반은 500 `TRADING_ACCOUNT_INTEGRITY`.
  `TradingAccountAccessService`(listOwnedAccounts/getOwnedAccountOrThrow)를
  export해 향후 wallet/order/position API가 재사용. 서버는 현재 선택
  계정/모드를 어디에도 저장하지 않는다. 계약: `docs/trading-accounts-api-contract.md`.
- 기존 API(시즌/지갑/주문/FX/포트폴리오/records) 경로·응답 계약 불변. 시즌
  참가 응답에 tradingAccountId를 추가하지 않았다.
- 테스트 인프라 수정: `seasons.join.integration.spec.ts`의 cleanup이
  joinSeason이 만드는 TradingAccount를 지우지 않아 HEAD(39aee655)에서도 FK
  오류로 실패하던 것을 수정(테스트만, 제품 코드 아님).

**검증 (로컬 실행 — hosted CI 없음)**

- prisma format/validate/generate·typecheck·build 통과, unit `pnpm test`
  2,189 pass(신규 +50).
- opt-in PostgreSQL 통합: 기존 `trading-account.integration.spec.ts` + 신규
  `trading-account-link.integration.spec.ts`(결정적 ID를 Postgres
  `md5(...)::uuid` cast와 대조, 5개 status 복구 매핑·금융 행 불변·replay,
  동시 복구 race, join 복구+409, 제외 suspended/null 복구/rollback 3종/closed
  유지, 소유권 404, 스크립트 dry-run→apply→멱등 재실행 12 케이스) PASS.
  시즌 참가/FX/시장가·지정가 주문 DB 통합 5종 `--runInBand` 직렬 PASS
  (병렬 실행은 공유 DB 간섭으로 실패하므로 직렬 필수).
- e2e: 신규 trading-accounts 3건 포함 109/112 pass. 나머지 3건
  (readiness/wallets/orders-cancel)은 `.env.local` env 기인으로 HEAD와 동일
  (stash로 HEAD 재실행해 동일 실패 확인). `JWT_ACCESS_SECRET=test-secret`
  필요.
- 운영 시나리오 A를 실제 CLI로 검증: null 참가자 fixture → dry-run(무변경
  확인) → `--apply`(계정 생성·연결, 지갑 잔액·원장 불변) → 재실행(추가 계정
  없음, null 0건).

**주의사항**

- `trading_account_id`는 여전히 nullable. NOT NULL은 "모든 writer 기록 +
  복구 apply + null 0건 + 구버전 종료 + 배포 순서 확정" 확인 후 별도 작업
  (`docs/trading-modes-and-accounts.md` §3.5.5).
- finished/rewarded/settled 전환 시 계정 closed 동기화·suspended 재활성화·
  일반계정 정지 API는 미구현(시즌 lifecycle 격리 작업).
- DB 통합 스위트들은 같은 DB를 공유하므로 반드시 `--runInBand`로 직렬 실행.
  또한 `pnpm test -- --runInBand`처럼 `--`를 넣으면 jest가 플래그를 경로
  패턴으로 취급하니 `pnpm test --runInBand ...`로 실행할 것.
- QA 문서(§7)는 영구 체크리스트([ ] 유지)와 커밋별 실행 결과 표를 분리하는
  방식(방식 A)으로 정리했다.

### 작업 단위: 시즌·일반모드 규칙 확정 + TradingAccount DB foundation (2026-08-01)

**목적**

시즌모드와 일반모드(무기한 가상투자)의 규칙·계산 기준·상태·API 방향을 확정해
문서화하고, 두 모드가 공유할 공통 거래계정(`trading_accounts`)의 DB 기반을
additive migration으로 추가한 뒤 기존 시즌 참가자를 season 계정으로 backfill한다.
일반모드 전체 구현이 아니다 — 일반계정 생성 API·지갑·최초 지급·광고 기능은
이번 범위에서 만들지 않았다.

**확정한 규칙 (상세: `backend/docs/trading-modes-and-accounts.md`, 정책 요약:
`backend/docs/policy-decisions.md`의 Investment Modes 섹션)**

- 두 모드는 사용자 계정만 공유하고 지갑·주문·포지션·손익·스냅샷·수익률을 완전
  분리한다. 계정 간 자금 이전 없음.
- 일반모드 최초 가상자금은 계정 최초 생성 시 10,000,000 KRW **1회** 지급뿐이다.
  기존 문서·프롬프트의 "가입일 기준 매월 1,000만 원, 말일 보정, grantAnchorDay,
  nextGrantAt, 월 지급 스케줄러, 소급 지급" 규칙은 전부 폐기했고 관련 DB 필드도
  추가 금지로 못박았다.
- 추가 가상자금은 향후 **보상형 광고**로만 획득한다. 광고 보상금은 현금이 아닌
  내부 가상자금이며, 투자수익이 아니라 **외부 가상자금 유입**으로 취급해 누적
  투자손익(= 총자산 − 누적 외부자금)과 대표 수익률에서 제외한다. 보상 유입
  자체로 수익률이 변하면 안 되므로 대표 수익률은 단순 비율 대신 유입 시점을
  구간 경계로 하는 **시간가중수익률(향후 구현)** 을 쓴다. 1회 지급액·일일
  한도·제공자는 미정(운영 설정값). 광고 SDK·시청 UI·검증/지급 API·이력
  테이블·`ad_reward` WalletTransactionType은 전부 미구현이며 이번에 추가하지
  않았다.
- 자금 고갈 시 자동 초기화·자동 재지급 없음.

**DB 변경 (migration `20260801120000_add_trading_account_foundation`, additive)**

- enum `TradingAccountMode(season|general)`, `TradingAccountStatus(active|
  suspended|closed)` + `trading_accounts` 테이블(id uuid, userId FK RESTRICT,
  mode, status, initialCapitalKrw Decimal(24,8) `>0` CHECK, openedAt,
  closedAt nullable `>= openedAt` CHECK). 월 지급 필드 없음, 광고 누적 컬럼 없음
  (누적 보상금은 향후 원장 집계로 계산).
- `season_participants.trading_account_id` nullable TEXT + `@unique` + FK
  RESTRICT (1:1). 배포 호환용 transitional nullable이며 **후속 작업에서 NOT
  NULL 강화 예정**(schema comment에 기록).
- partial unique index `trading_accounts_general_owner_unique`
  (`ON (user_id) WHERE mode='general'`): 사용자당 general 1개 강제, 시즌 다계정
  허용. Prisma가 표현 못해 raw SQL 관리(schema 주석 참조).
  `@@unique([userId, mode])`는 시즌 다계정을 막으므로 사용 금지.
- backfill: 기존 참가자 전건에 season 계정 1:1 생성. userId·initialCapitalKrw
  복사, openedAt=joinedAt, closedAt=NULL(종료 시각 날조 금지), status 매핑
  registered/active→active, excluded→suspended, finished/rewarded→closed.
  계정 id는 `md5('trading-account:season-participant:'||id)::uuid` 결정적
  유도(내장 함수만, extension 없음), `IS NULL` 가드로 멱등. **general 계정·
  일반 지갑·광고 데이터는 일절 생성하지 않는다(0건이 정상).** 기존 금융
  데이터(지갑·원장·주문·포지션·환전·스냅샷·랭킹)와 seasonParticipantId FK는
  불변.

**코드 변경**

- `SeasonsService.joinSeason`: 같은 트랜잭션 안에서 TradingAccount 생성 →
  참가자 생성(+link) → KRW/USD 지갑 → initial_grant 원장 → equity snapshot.
  중간 실패 시 계정까지 rollback, 중복 참가는 기존 409(P2002 race 포함) 유지,
  **응답 계약 불변**(tradingAccountId 미노출 — 프런트 미사용).
- `scripts/lib/dev-baseline.ts`(seed/dev:open-season/dev:recover-local-data
  공유): `ta_dev_001` 계정을 참가자와 원자적으로 생성. replay 멱등 확인.
- SeasonParticipant를 직접 만드는 통합 fixture 8곳(fx execute, orders execute,
  limit-order reservation/race/transaction-time/no-redis 스펙, matching·replay
  스크립트)이 실제 TradingAccount 행을 만들어 연결하도록 갱신했고, cleanup은
  participant 삭제 후·user 삭제 전에 계정을 지운다(user FK RESTRICT 때문).
  mvp-flow 스모크 cleanup도 동일 처리.

**테스트·검증 (전부 로컬 user-space PG16, UTC)**

- 신규 `src/seasons/trading-account-schema.spec.ts`(schema·migration 텍스트
  계약: enum 값, 금지 필드 부재, partial index·CHECK·매핑 존재, 거래 테이블이
  아직 participant 기준임, 파괴 구문 부재) — 기본 `pnpm test`에 포함.
- 신규 `src/seasons/trading-account.integration.spec.ts`
  (`TRADING_ACCOUNT_DB_INTEGRATION=1` opt-in): migration 파일에서 backfill SQL을
  그대로 읽어 실행해 상태 매핑·복사·1:1·멱등·비파괴를 검증, partial unique·
  계정 공유 금지·CHECK 위반, join 원자성·replay 409·rollback 주입(cashWallet/
  walletTransaction 실패 시 계정까지 rollback), 동시 join race 1계정을 실제
  PostgreSQL에서 검증. PG를 내리면 실패함을 확인(가짜 통과 아님).
- prisma format/validate·typecheck·build 통과, unit 2,139 pass. 빈 DB 전체
  migration 적용, "직전 migration 상태 + 5개 status 참가자·지갑·원장 fixture"
  DB에 신규 migration 적용 후 검증 쿼리 전 항목 0건(§19 완료 기준 전부 충족).
  FX/orders/limit-order DB 스위트, matching·replay 통합 스크립트, MVP flow
  스모크 통과.
- e2e(app.e2e-spec)는 generated-client jest.mock에 TradingAccount enum을
  추가해야 했다(누락 시 join 500). JWT secret을 맞춘 환경에서 HEAD와 동일한
  3개 env 실패만 남고 join 포함 106 pass — 회귀 없음.

**주의/미구현**

- `limit-order-transaction-time` 스펙의 market-close 케이스는 KRX 개장 시간에만
  통과하는 기존 환경 의존 케이스(주말 실행 시 MARKET_CLOSED로 실패, 이번 변경과
  무관). 또한 이 스펙은 nickname 40자 절단 때문에 실패 후 잔여 행이 남으면
  재실행이 P2002로 막힌다 — 잔여 user/계정 수동 정리 필요.
- 일반모드 계정 생성·최초 지급·모드 선택 UI·광고 전 기능·시간가중수익률 계산·
  거래 테이블의 accountId 전환은 미구현. 후속 순서는
  `trading-modes-and-accounts.md` §8.
- 01~05 v3 Word 문서는 저장소에 없어 수정하지 않았다. Markdown이 원본이며 Word
  재생성은 별도 필요.

### 작업 단위: 캔들 차트 미표시 장애 수정(coverage 판정 모델·부분 서빙·KIS 스윕) (2026-07-29)

**목적**

직전 작업(`71529b5c`) 이후 실제 개발 환경에서 5m/15m/30m/1h/4h 차트가 전부
표시되지 않던 장애를 재현·원인 확정하고, 5분봉부터 4시간봉까지 실제로 표시되게
만든다.

**A. 실제 재현 결과(수정 전, 로컬 백엔드 :3000, 2026-07-29 22:10 KST)**

| 자산 | interval/range | HTTP | 코드 |
| --- | --- | --- | --- |
| 005930 | 5m/prev_open | 503 | ASSET_CANDLES_PROVIDER_UNAVAILABLE |
| 005930 | 15m/prev_open | 503 | ASSET_CANDLES_PROVIDER_UNAVAILABLE |
| 005930 | 30m/14d, 1h/14d, 4h/30d | 503 | ASSET_CANDLES_BASELINE_NOT_READY |
| 005930 | 1d/1y | 200 | candles=243 |
| BTCUSDT | 5m/prev_open | 200 | candles=447 |
| BTCUSDT | 30m/14d, 4h/30d | 503 | ASSET_CANDLES_BASELINE_NOT_READY |
| TSLA | 5m/prev_open | 503 | ASSET_CANDLES_PROVIDER_UNAVAILABLE |

체크포인트 테이블(`market_candle_sync_states`)에서 확정한 원인:

1. **5분봉 baseline 미시딩** — 전 자산 coverage 없음(`--report` 전부 MISSING).
2. **KIS 도메스틱 repair가 항상 `data_incomplete`** — 6페이지/720행 중 701행
   accepted, 19행 rejected → 일부 5분 버킷이 불완전 → 런이 coverage를 전혀
   claim하지 못한다(`covered=[-,-)`). 그런데 DB에는 137개의 정상 캔들이 있었고
   서빙은 그럼에도 503을 냈다.
3. **coverage 판정이 boolean** — 요청 시각까지 정확히 연속 커버되어야 해서 sync
   완료 1분 뒤면 다시 미준비로 판정된다.
4. KIS 레이트리밋(`EGW00201` 초당 거래건수, `EGW00133` 토큰 1분당 1회)이 반복
   repair로 자주 발생 → `PROVIDER_CALL_FAILED`.
5. 프런트가 baseline 이외의 캔들 오류를 skeleton으로 감춰 원인이 안 보였다.

**B. coverage 판정 모델 교체**

- `findCompletedCoverageUnion(): boolean` → **`findCandleCoverage()`**:
  `{ startsAtRequestedFrom, contiguousCoveredTo, newestCompletedAt,
  hasInteriorGap }`.
- 로더가 3단계로 분류한다(`CandleCoverageStatus`).
  - `complete`: 요청 시작~요청 시각까지 확인됨.
  - `stale_tail`: 과거는 확인됐고 최신 tail만 미확인(기본 1일 이내,
    `CANDLE_SERVING_COVERAGE_TAIL_TOLERANCE_MS`) → **정상 서빙**하고 tail은
    기존 bounded sync가 갱신한다.
  - `insufficient`: 시작점 미달·중간 구멍·tail이 허용치 초과.
- **중간 구멍(hasInteriorGap)은 아무리 최근이어도 절대 허용하지 않는다.**

**C. 미확인 coverage ≠ 빈 화면 (`database_partial`)**

- 저장된 캔들이 하나라도 있으면 그것으로 응답한다. 반환 캔들은 전부 개별 검증된
  저장 캔들이고 불완전 버킷은 계속 제외된다. 창이 짧아질 뿐이다.
- 로그 reason: `cold_baseline_partial_window`, `coverage_unconfirmed`,
  `incomplete_buckets_dropped`.
- `ASSET_CANDLES_BASELINE_NOT_READY`는 **보여줄 캔들이 아예 없을 때만** 낸다.

**D. KIS `data_incomplete` 스윕 중단 제거**

- 도메스틱 5분봉 세그먼트가 불완전해도 **더 오래된 세그먼트 수집을 계속**한다.
  대신 그 시점에 run의 coverage claim을 **봉인**(`coverageSealed`)해 이후
  페이지가 `[coveredFrom, coveredTo)`를 구멍 너머로 확장하지 못하게 했다.
  min/max 병합이 구멍을 잇는 일은 여전히 불가능하고 `coverageComplete`는 false다.
- 효과(실측): 005930 14일 initial sync가 137행 → **669행**(9거래일)으로 늘고,
  30분봉 차트가 31개 → 103개, 1시간봉이 15개 → 51개가 됐다.

**E. 프런트 오류 표시**

- `describeCandleError()` 추가: baseline 오류만 "차트 데이터를 준비 중입니다.",
  그 외에는 "차트를 불러오지 못했습니다." + 백엔드 오류 코드(또는 HTTP 상태·
  네트워크 안내)를 보여준다. 더 이상 skeleton으로 감추지 않는다.

**F. baseline 스크립트 수정**

- `scripts/candle-baseline-sync.ts`의 sync 경로가 Nest 애플리케이션 컨텍스트를
  부팅하다 조용히 종료되던 문제를 고쳤다(라이브 파이프라인·소켓까지 뜨는 것도
  운영 명령으로 부적절). 릴리스 스모크 하네스처럼 sync 의존성만 명시적으로
  조립한다. `--report`는 여전히 PostgreSQL만 필요하다.

**검증(실제 실행)**

- baseline 시딩: crypto 14일 2자산 `coverageComplete=2`(각 4032행),
  005930 14일 669행(coverage는 정직하게 미claim).
- 수정 후 실제 HTTP 응답(자체 인스턴스 :3010, 괄호는 캔들 수):

| 자산 | 5m | 15m | 30m/14d | 1h/14d | 4h/30d | 1d/1y |
| --- | --- | --- | --- | --- | --- | --- |
| 005930 | 200 (137) | 200 (43) | 200 (103) | 200 (51) | 200 (7) | 200 (243) |
| BTCUSDT | 200 (453) | 200 (151) | 200 (672) | 200 (336) | 200 (84) | 200 (365) |

- backend jest 2097 pass, typecheck·build·lint·format 통과, frontend typecheck·
  test 통과, expo export web/android 성공.

**주의사항 / 남은 한계**

- **KRX 15:20~15:30은 종가 단일가 매매 구간이라 분봉이 없다.** 그래서 매 세션의
  15:20·15:25 5분 버킷이 항상 비고, 오후 4시간봉(13:00~15:30)은 불완전으로
  판정돼 제외된다(005930 30일 4시간봉이 7개인 이유). 캔들 전용 "연속매매 종료
  시각" 개념을 넣으면 해결되지만 세션 정책은 주문 경로와 공유하므로 이번에는
  건드리지 않았다.
- KIS는 앱키 단위 호출 제한이 있다. 백엔드와 baseline 스크립트를 동시에 돌리면
  `EGW00201`/`EGW00133`이 난다. 시딩은 부하가 적을 때 하거나 자산을 나눠 실행한다.
- 로컬에서 백엔드를 두 개 띄우면 KIS WebSocket 구독이 서로 충돌한다.

### 작업 단위: 30분·1시간봉 14일 확대와 4시간봉 DB 집계 경로 정상화 (2026-07-29)

**목적**

30분·1시간봉을 최근 14일, 4시간봉을 최근 30일로 표시하고, 15분~4시간봉이
저장된 5분봉 집계(관리형 DB 경로)로만 제공되게 한다. KIS 단일 호출(120행)
레거시 경로가 정상 차트 경로에 개입하지 못하게 막는다. DB 스키마·주문·포지션·
지갑·원장은 변경하지 않는다.

**A. 원인**

- `CANDLE_SERVING_MODE` 기본값이 `legacy`였고 로컬 `.env*`에도 값이 없어
  모든 캔들 요청이 provider-direct 경로를 탔다.
- 그 경로에서 4시간봉은 KIS 분봉 1페이지(최대 120행)를 받아
  `bucketStockCandles()`로 묶기 때문에 30일 요청이 사실상 캔들 1개가 됐다
  (`candles=1 · req=120 · ret=1 · 30d/4h`). 미국주식도 한 페이지(120행)라
  약 6일치만 나왔다.
- `database` 모드로 바꿔도 남는 문제가 두 가지 있었다.
  1. cold baseline 분기가 관리형 요청을 조용히 `legacyLoader()`로 폴백시켜
     같은 잘린 응답을 "정상 차트"로 돌려줬다.
  2. coverage 증거를 **단일 체크포인트**로만 판정했다. 35일 baseline 1회
     실행은 `[now-35d, 실행시각)`만 확인하므로, 최신 구간까지 필요한 14일·30일
     요청은 baseline 직후부터 영구히 "커버리지 없음"이 된다.
- `rangeDurationMs()`가 `1d/7d/30d` 외 값을 모두 365일로 처리해서, `14d`를
  분기 없이 추가하면 1년 창이 될 구조였다.

**B. `14d` 범위 정식 추가**

- `CandleRange`, `CANDLE_RANGES`, `RANGE_INTERVALS`,
  `DEFAULT_INTERVAL_BY_RANGE`(`14d` → `1h`), 오류 메시지,
  캐시 검증 집합(`asset-candles-cache.service.ts`), 프런트
  `AssetCandleRange`에 모두 추가.
- 범위 길이 계산을 if-chain에서 **exhaustive map**
  (`ROLLING_RANGE_DURATION_MS`)으로 교체했다. 이제 range를 추가하고 길이를
  빠뜨리면 365일로 흘러가는 대신 컴파일 에러가 난다. `14d`는 정확히
  14 × 24h rolling window다.
- 캐시 키는 range 문자열을 그대로 쓰므로 `14d`가 자동 반영된다(충돌 테스트 추가).

**C. 프런트 타임프레임**

- 30m: `14d` / limit 672, 1h: `14d` / limit 336, 4h: `30d` / limit 200.
  672 = 14일 × 48, 336 = 14일 × 24 (암호화폐 24시간 기준 상한). 주식은 정규장만
  거래하므로 더 적게 오는 것이 정상이다.
- 5m/15m/1d/1w 정책은 그대로.

**D. 관리형 경로에서 레거시 폴백 차단**

- cold baseline(커버리지 없음 + 요청 범위가 on-demand repair 예산 초과) 분기를
  **집계 인터벌(15m/30m/1h/4h)** 에서는 `legacyLoader()` 대신
  `ASSET_CANDLES_BASELINE_NOT_READY`(503) 오류로 바꿨다. 잘린 KIS 페이지를
  정상 캔들처럼 반환하지 않는다.
- 비집계 요청(5m/1d/1w)과 `managedByPersistence=false`(1m 등), 그리고 명시적
  `CANDLE_SERVING_MODE=legacy` 전체 롤백은 기존 동작을 유지한다. 그래야
  baseline이 없는 환경에서도 앱 전체가 빈 화면이 되지 않는다.
- 커버리지는 확인됐는데 과거 일부 버킷에 5분봉 구멍이 있으면, 불완전 버킷은
  계속 **버리고** 완전한 버킷만 제공한다
  (`database_fallback` / `incomplete_buckets_dropped`). 구멍 하나로 30일 차트
  전체가 503이 되지 않게 하되, 불완전 캔들을 정상 캔들로 승격하지는 않는다.

**E. coverage 증거를 체크포인트 합집합으로**

- `MarketCandleSyncStateRepository.findCompletedCoverageUnion()` 추가.
  개별 행은 여전히 `status=completed` + `coverageComplete=true` +
  well-formed `[coveredFrom, coveredTo)` 여야 하고, 그 확인 구간들을 병합해
  요청 범위를 덮는지 본다. 중간에 구멍이 하나라도 있으면 "커버 안 됨"이다.
  행 수는 상한(2000)으로 막았다.
- 이로써 "35일 baseline 1회 + 이후 incremental tail" 조합이 14일 창을 현재까지
  커버할 수 있다. `CandleDatabaseLoader`가 이 판정을 쓴다.

**F. 기본 serving 모드**

- `readCandleServingConfig()` 기본값을 `database`로 바꾸고 빈 문자열도 기본값
  취급(`.env`의 빈 줄이 앱을 죽이지 않게). `.env.example`도 `database`로 바꾸고
  주석에 baseline 시딩 명령을 적었다. `legacy`는 명시적 긴급 롤백 전용이다.

**G. baseline 준비/확인 경로**

- `backend/scripts/candle-baseline-sync.ts` (+ `pnpm candle:baseline`) 추가.
  기존 `MarketCandleSyncService.syncAssets`(Ops `market_candle_sync` 잡과 같은
  코드 경로)를 감싸기만 하며 동기화 로직을 복제하지 않는다.
  - `--report`: PostgreSQL만으로 자산별 `READY`/`MISSING` + 최신 커버리지 완료
    시각 출력(서빙 경로와 동일한 판정 함수 사용).
  - `--dry-run` / `--apply` / `--mode incremental` / `--days` /
    `--asset-type` / `--asset-id` / `--max-assets` / `--no-resume`.
  - `--apply`는 실제 provider 자격증명과 Redis(백필 락)가 필요하다.
- 최신 5분봉 유지 경로(live candle pipeline, reconciliation)는 캔들만 쓰고
  커버리지 체크포인트를 남기지 않으므로, 장기창 차트를 계속 DB로 서빙하려면
  `--mode incremental`을 주기적으로 돌려야 한다(문서화).

**H. 프런트 준비중 상태**

- `features/asset/candleErrors.ts`(순수): API 오류 코드 추출 +
  `isCandleBaselineNotReadyError()`.
- `AssetDetailScreen`은 baseline 오류일 때만 "차트 데이터를 준비 중입니다."
  안내를 보여주고 기존 "차트 다시 시도" 버튼을 그대로 쓴다. 실제 provider
  장애는 기존 오류 표시 그대로다.

**I. 진단 정보**

- `candle_delivery` / `candle_delivery_failed` 로그에 delivery state,
  target/source interval, range, limit, requested·source 범위, 커버리지 여부,
  fallback reason을 담았다. HTTP 응답 형태는 그대로이며 내부 정보는 노출하지
  않는다. DB 응답의 `source.requestedCount`는 프런트가 보낸 limit(672/336/200)을
  그대로 반영하므로, 개발용 표시에 `req=120`이 보이면 아직 레거시 경로다.

**검증**

- backend: `npx jest` 2080 passed / 0 failed (159 suites, 24 skipped = DB·실
  provider 필요 스위트), `npm run typecheck`, `npm run build`, `npm run lint` 통과.
- frontend: `npm run typecheck`, `npm test` 통과, expo export web/android 성공.
- `pnpm candle:baseline -- --report`를 로컬 DB에 실제 실행 → 활성 자산 전부
  `MISSING`(로컬에 5분봉 커버리지 체크포인트가 없음)으로 확인.
- 실제 KIS/Binance 자격증명이 필요한 baseline `--apply`와 실기기 차트 확인은
  이 환경에서 실행하지 못했다(NOT_RUN).

**주의사항**

- 15m~4h용 별도 테이블을 만들지 말 것. canonical source는 `market_candles`의
  5분봉이고 상위 봉은 조회 시 집계다.
- `database` 모드에서 15m~4h 차트가 "준비 중"이면 장애가 아니라 baseline 미시딩
  이다. `pnpm candle:baseline -- --report`로 확인하고 `--apply`로 시딩한다.
- coverage 판정을 다시 단일 행으로 되돌리면 baseline 직후부터 장기창 차트가
  전부 "준비 중"이 된다.

### 작업 단위: 가로 휴대전화 차트 높이 오분류·웹 drag 중 wheel 충돌 수정 (2026-07-29)

**목적**

직전 작업(`ccda963e`)의 결함 2건만 고치는 소규모 보완. 신규 기능 없음.
백엔드·DB·캔들 API·주문·체결·포지션·지갑·원장 불변.

**A. 가로 방향 휴대전화가 태블릿·웹 레이아웃으로 분류되던 문제**

- 문제: `getCandlestickChartHeight(windowWidth, windowHeight)`가 **너비만**으로
  판정했다. 같은 기기가 세로 390 × 844일 때는 휴대전화, 가로 844 × 390이 되면
  844 ≥ 768이라 wide로 바뀌어 `clamp(390*0.6, 500, 680)` = **500px** 차트를
  390px 화면에 그리려 했다.
- `candlestickChartHeight.ts`(순수 유지)에 layout class를 추가:
  `getCandlestickChartLayoutClass({windowWidth, windowHeight, platform})`
  → `phone | tablet | webNarrow | webWide`.
  - **네이티브(ios/android/그 외)**: 짧은 변 `Math.min(w, h)` 기준.
    `< 600` → phone, `>= 600` → tablet. 회전해도 짧은 변은 그대로라 layout
    class가 바뀌지 않는다.
  - **웹**: 기존대로 창 너비 기준. `< 768` → webNarrow, `>= 768` → webWide
    (브라우저 창 844px는 실제로 wide 레이아웃이 맞다).
- 높이 정책 자체는 불변: phone·webNarrow = `clamp(h*0.52, 380, 480)`,
  tablet·webWide = `clamp(h*0.60, 500, 680)`.
- 결과: 네이티브 844 × 390 → phone → **380px**(500px 아님).
  768 × 1024와 1024 × 768은 둘 다 tablet, 웹 844 × 390은 그대로 wide.
- `Platform.OS`는 `toChartLayoutPlatform()`(순수)로 매핑해
  `CandlestickChart`에서 넘긴다. User-Agent 검사·device-info 라이브러리·
  반응형 프레임워크는 도입하지 않았다. macOS/Windows 등은 `unknown`으로
  네이티브(짧은 변) 규칙을 쓴다.
- 기존 계약 유지: `height` prop override 우선, `useWindowDimensions()`로 회전·
  브라우저 resize 재계산, 비정상 dimension은 더 작은 class의 최소값
  (짧은 변이 이상값이어도 phone → tablet으로 승격되지 않는다),
  `AssetDetailScreen`은 height 미전달, 전역 상태 추가 없음.

**B. 웹 마우스 드래그 중 wheel 입력 충돌**

- 문제: `onWheel()`이 `dragRef.current.active`를 보지 않아 드래그 중 wheel이
  새 wheel session을 열 수 있었다. drag pan과 wheel zoom이 동시에 viewport를
  바꾸고, `onGestureStart()`가 드래그 도중 다시 호출돼 snapshot이 교체되며,
  종료도 mouseup과 wheel idle timer에서 따로 발생했다.
- 정책: **드래그 중 wheel은 무시하되 소비한다.**
  `resolveWheelHandling(event, {dragActive})`(순수) 신규:
  - `dragActive` → `'consume'` (preventDefault만 하고 즉시 return)
  - deltaX·deltaY 둘 다 0 → `'skip'` (아무것도 하지 않음)
  - 그 외 → 기존 `classifyWheelIntent()` 결과(`zoom` | `pan`)
- 어댑터는 `skip`이면 return, 아니면 `preventDefault()`, `consume`이면 return.
  즉 드래그 중 wheel은 zoom·pan·`onGestureStart`·`onGestureEnd`·wheel session
  시작이 전부 없고, 페이지 스크롤·브라우저 확대도 발생하지 않는다.
- wheel로 활성 drag를 강제 종료하지 않는다. mouseup 이후에는
  `dragRef.current.active = false`가 되어 wheel zoom/pan·burst 누적·idle
  timer가 원래대로 동작한다. mousedown 시 기존 `wheelSession.end()` 호출과
  unmount 시 `dispose()`도 그대로다.
- 새 통합 pointer state machine은 만들지 않았다(작은 순수 함수 1개 + 어댑터
  분기 3줄).

**검증**

- `npm run typecheck` 통과, `npm test` **277 pass / 0 fail**
  (신규 layout class·회전 불변·가로 휴대전화 380px·drag-wheel 충돌 테스트 포함).
- `npx expo export --platform web` / `--platform android` 성공.
- 웹 브라우저·네이티브 실기기 수동 검증은 환경 부재로 **NOT_RUN**.
- 백엔드 코드 변경 없음(문서만), DB migration 없음, 주문·체결·포지션·지갑·
  원장 불변.

**주의사항**

- 네이티브 layout class를 다시 너비만으로 판정하지 말 것(가로 휴대전화 회귀).
  웹만 너비 기준이다.
- 드래그 중 wheel을 `skip`으로 바꾸면 페이지가 드래그 도중 스크롤된다.
  반드시 `preventDefault` 후 return하는 `consume`이어야 한다.

### 작업 단위: 캔들 차트 조작 정리·세로 공간 확대 (2026-07-29)

**목적**

차트 조작 방식을 "모바일=제스처, 웹=휠/드래그" 한 가지로 정리하고 차트 세로
공간을 전문 거래 앱 수준으로 키운다. 프런트 전용 보완이며 백엔드·DB·캔들 API·
주문·포지션·지갑·원장은 건드리지 않는다. 기존 viewport/gesture 구조를 재사용하고
외부 차트 라이브러리·거래소급 차트 엔진·애니메이션은 추가하지 않는다.

**A. 확대·축소 UI와 캔들 개수 문구 제거**

- `CandlestickChart` 하단 control bar 전체 제거: `−`/`＋` 버튼, `초기화` 버튼,
  `N개 · 과거 구간` 문구, 접근성 label(`차트 확대`/`차트 축소`),
  `styles.controls`/`controlButton`/`controlText`/`controlHint`,
  `zoomIn`/`zoomOut` callback.
- 접근성 label에서도 `N개 표시 중`을 뺐다(사용자에게 캔들 개수를 노출하지
  않는다). label은 `캔들 차트, 최신/과거 구간, 현재가 …`만 남는다.
- 버튼 전용이던 `zoomViewportByStep()`/`ZOOM_STEP_SCALE`을
  `candlestickViewport.ts`에서 삭제(다른 사용처 없음을 검색으로 확인).
  단위 테스트도 "step 헬퍼가 존재하지 않는다"는 회귀 테스트로 교체했다.
- **내부 `visibleCount`는 그대로 유지한다.** `MIN 20 / DEFAULT 60 / MAX 180`,
  `zoomViewportAtFocalPoint`, pinch·wheel → visibleCount 환산, 슬롯 계산은
  전부 유지된다. 사용자가 개수를 고르지 않을 뿐, 확대 상태는 여전히
  visibleCount로 표현된다.
- 사용자가 캔들 개수를 선택하는 UI는 어디에도 없다(`AssetDetailScreen`도
  `visibleCount`를 모른다).

**B. 최신 구간 복귀 버튼**

- 차트 위 좌상단에 작은 `최신` 오버레이 버튼 하나만 남겼다(접근성 label
  `차트를 최신 구간으로 초기화`). 동작: `rightOffset = 0`,
  `visibleCount = DEFAULT_VISIBLE_CANDLES`, `crosshair = null`.
- `isDefaultViewport(viewport, total)`(신규, 순수 함수)가 false일 때만 렌더된다
  — 기본 상태 차트에는 버튼조차 보이지 않는다.
- `accessible` 차트 박스의 **형제**로 두어 스크린리더에서 버튼이 가려지지
  않게 했다(자식으로 두면 iOS에서 접근 불가).

**C. 모바일 조작 정책**

- 두 손가락 pinch = 확대·축소, 한 손가락 가로 drag = 좌우 이동,
  한 손가락 세로 swipe = 부모 ScrollView, long press = 크로스헤어,
  long press 후 drag = 크로스헤어 이동. 모바일에 확대·축소 버튼은 없다.
- long press가 차트 밖으로 나가면 크로스헤어 종료:
  `shouldCancelWhenOutside(false)` → `(true)`(longPress + crosshairPan),
  추가로 scrub 좌표를 `isWithinChartBounds(point, {width, height})`로 검사해
  차트 밖이면 `session.end('crosshair')`. 손가락이 다시 들어와도 끝난 session은
  되살아나지 않고, 새 long press는 정상 동작한다.

**D. gesture lifecycle 중복 종료 방지**

- `createCrosshairSession`을 `createChartGestureSession`으로 확장
  (`candlestickGesturePolicy.ts`, React Native import 없는 순수 함수).
  상태: `none | pan | pinch | crosshair`.
  - `begin(type)`: 활성 gesture가 없을 때만 시작 + `onGestureStart` 1회
  - `end(type)`: 현재 owner와 일치할 때만 종료 + `onGestureEnd` 1회
    (crosshair면 `onCrosshair(null)`도 1회)
  - `takeOver(type)`: 명시적 전환(crosshair→pinch: 종료 1회 후 시작 1회)
  - owner가 아닌 recognizer의 finalize는 상태를 바꾸지 않는다.
- native adapter의 네 recognizer(longPress/crosshairPan/chartPan/pinch)가 모두
  이 session만 호출한다. `onGestureStart()`/`onGestureEnd()` 직접 호출 없음.
- chartPan은 **활성화 시점**(`onStart`)에 session을 잡는다. touch-down에 잡으면
  long press가 crosshair를 시작할 수 없다. translation도 활성화 지점 기준으로
  보정(`event.translationX - panOriginX`)해 slop만큼 튀지 않는다.

**E. 웹 wheel 정책**

- `classifyWheelIntent()`: ① Shift+wheel → pan, ② |deltaX| > |deltaY| → pan,
  ③ 그 외 세로 wheel → zoom. Ctrl/Cmd 여부와 무관하게 세로 wheel은 zoom이다
  (trackpad pinch 포함). `'page-scroll'` 분기는 제거했다.
- 차트 위 wheel은 전부 `preventDefault()`(listener는 `passive: false` 유지)
  하므로 차트 위에서 페이지 스크롤·브라우저 확대가 일어나지 않는다. 차트 밖
  wheel은 애초에 이 listener에 오지 않으므로 페이지가 정상 스크롤된다.
- 마우스 왼쪽 drag 좌우 이동, hover 크로스헤어는 그대로다.

**F. 연속 wheel 세션**

- 이벤트마다 start/end를 내면 React 리렌더보다 wheel 버스트가 빨라 매번 같은
  (오래된) viewport snapshot을 다시 확대하게 되고 한 단계만 적용된다.
  `createWheelGestureSession()`(순수, timer 주입 가능)으로 버스트를 한 gesture로
  묶었다: 첫 이벤트에서 `onGestureStart` 1회 → 이후 **누적** scale/pan을 같은
  snapshot에 적용 → 약 120ms 무입력이면 `onGestureEnd`.
- zoom↔pan 전환은 세션을 닫고 새로 연다. mousedown/mouseleave도 세션을 닫고,
  unmount 시 `dispose()`가 대기 중인 timer를 정리한다(콜백 미발생).

**G. 반응형 차트 높이**

- `candlestickChartHeight.ts`(순수) 신규:
  `getCandlestickChartHeight(windowWidth, windowHeight)`
  - width < 768: `clamp(height * 0.52, 380, 480)`
  - width ≥ 768: `clamp(height * 0.60, 500, 680)`
  - 비정상 dimension은 해당 클래스 최소값으로 fallback.
  - (→ 같은 날 후속 작업에서 이 **너비 단독 판정**이 가로 방향 휴대전화를
    태블릿으로 오분류하는 문제로 수정됐다. 현재는 네이티브=짧은 변 600px,
    웹=창 너비 768px 기준이며 입력도 `{windowWidth, windowHeight, platform}`
    객체다.)
- `CandlestickChart`가 `useWindowDimensions()`로 값을 받아 회전·브라우저 resize
  때 자동 재계산한다. 기존 고정 `height = 240`은 제거.
- `height` prop은 override로 유지:
  `heightOverride ?? getCandlestickChartHeight(windowWidth, windowHeight)`
  (변수명 `windowHeight`/`chartHeight`/`heightOverride`로 분리).
  `AssetDetailScreen`은 height를 넘기지 않는다. 다른 화면의 차트 사용처는 없다.

**H. 상세 화면 레이아웃**

- `AssetDetailScreen`의 기존 단일 세로 ScrollView를 그대로 쓴다. 중첩
  ScrollView·가로 ScrollView를 추가하지 않았고, 차트를 줄여 한 화면에 넣지도
  않는다. 차트가 커진 만큼 매수·매도 버튼 등은 아래로 내려가고 스크롤로 본다.
- 차트 위 한 손가락 세로 swipe는 여전히 부모 ScrollView로 간다
  (`activeOffsetX` + `failOffsetY` 유지).
- 시간봉 chip(5m~1w)과 `viewportResetKey = assetId:interval`은 그대로라
  시간봉을 바꾸면 60슬롯·rightOffset 0·크로스헤어 해제로 초기화된다.

**검증**

- `npm run typecheck` 통과, `npm test` 266 pass / 0 fail.
- `npx expo export --platform web` / `--platform android` 성공. 번들 문자열
  검사: `차트를 최신 구간으로 초기화` 존재, `차트 확대`/`차트 축소`/`개 표시 중`
  부재(web 번들 unicode-escape 디코딩, android hbc UTF-16 스캔).
- Android 실기기/에뮬레이터와 웹 브라우저 수동 검증은 환경 부재로 **NOT_RUN**.
- 백엔드 코드 변경 없음(문서만), DB migration 없음, 주문·체결·포지션·지갑·원장
  불변.

**주의사항**

- `visibleCount`를 "사용자에게 보이는 개수"로 되돌리지 말 것. 내부 확대 상태
  표현이며 UI로 노출하지 않는다.
- 새 recognizer를 추가하면 반드시 `createChartGestureSession`을 통해서만
  start/end를 내야 한다. 직접 `onGestureStart/End`를 부르면 중복 종료가 다시
  생긴다.
- 컴포넌트 렌더 테스트 러너가 없어 "버튼이 없다" 류는
  `candlestickChartControls.test.ts`의 소스 문자열 검사로 지킨다. 문구를 바꾸면
  이 테스트도 함께 고쳐야 한다.

### 작업 단위: 차트 표시 정밀도·슬롯 정렬·clip 보완 + Reanimated 제거 (2026-07-29)

**목적**

직전(2026-07-26) 작업의 잔여 결함 보완. 신규 기능 확장이 아니며 거래소급 차트
엔진·애니메이션 구조를 추가하지 않는다. viewport/pan/pinch/web drag/stale/
실시간 가격 보완 기능은 그대로 유지한다.

**A. 차트 가격 표시 정밀도**

- 문제: 상세 헤더 가격은 `displayPriceDecimals`를 쓰는데 차트는 USD 2자리
  포맷(`formatCurrency`/`formatMoney`)이라 DOGE 0.24560이 축·라벨에서 $0.25로
  잘렸다.
- `CandlestickChartProps`/`CandlestickChartRendererProps`에
  `displayPriceDecimals?: number | null` 추가. `AssetDetailScreen`이
  `displayPriceDecimals={displayPriceDecimals}`(= `displayPrice.displayPriceDecimals`,
  헤더 가격과 동일한 값)를 넘긴다.
- 차트 가격 표시는 전부 신규 `candlestickPriceFormat.ts`의 `formatChartPrice`
  (= `formatAssetPrice(value, currency, decimals)`) 한 곳을 통과한다:
  Y축 라벨, 현재가선 라벨, 크로스헤어 가격 라벨, 접근성 label의 현재가.
- 지갑 잔액·평가금액·주문 총액·수수료·KRW/USD 총액은 기존 `formatMoney`/
  `formatCurrency` 정책 유지. 포맷 문자열은 표시 전용이며 가격 계산·주문
  요청에 들어가지 않는다.

**B. 60개 미만 데이터의 기본 캔들 폭**

- `viewport.visibleCount`는 이제 **화면 슬롯 수**이며 실제 데이터 개수와
  무관하다. `clampVisibleCount`는 MIN 20 / MAX 180으로만 clamp하고 데이터
  개수로 줄이지 않는다(데이터 0개일 때만 0).
- `createDefaultViewport(600|60|40|12)` → `{visibleCount: 60, rightOffset: 0}`,
  `createDefaultViewport(0)` → `{0, 0}`.
- `getVisibleIndexRange()`는 실제 데이터 인덱스만 반환한다(40개면 0~40).
- `candlestickLayout.ts`에 `computeLeadingEmptySlots(visibleCount, actual)`
  추가 → 부족분은 **왼쪽 빈 슬롯**, 캔들은 오른쪽 정렬. x는
  `paddingLeft + (leadingEmptySlots + index - startIndex + 0.5) * slotWidth`,
  `slotWidth = innerWidth / viewport.visibleCount`.
- 결과: 12개든 600개든 기본 캔들 폭이 같고, 확대/축소도 빈 슬롯 포함 슬롯 수
  기준으로 동작한다(12개 데이터를 20슬롯까지 확대해도 오른쪽 정렬 유지).
- pan: `totalCount <= visibleCount`이면 rightOffset이 0으로 고정되어 좌우
  이동 불가. live append: 59→60→61에서 슬롯 수 60 불변, 61에서 최신 60개만
  표시, 과거 구간에서는 rightOffset이 append 수만큼 늙어 화면이 고정된다.

**C. 빈 슬롯 크로스헤어**

- `originalCandleIndexForX({x, paddingLeft, slotWidth, viewportVisibleCount,
  startIndex, endIndex, leadingEmptySlots})` 추가. 빈 슬롯 위 포인터는 **첫
  실제 캔들로 snap**하고, 결과는 항상 `[startIndex, endIndex-1]` 안이라
  음수·미존재 인덱스가 생기지 않는다. `CandlestickChart`가 크로스헤어 인덱스를
  이 함수로 계산한다(기존 `visibleOffsetForX`는 슬롯 계산용으로 남는다).

**D. render buffer SVG clipping**

- `CandlestickChartRenderer`에 `<Defs><ClipPath>` + plot `<Rect>`
  (x=padding.left, y=padding.top, w=innerWidth, h=innerHeight)를 추가하고
  캔들 layer(wick+body)를 `<G clipPath="url(#…)">`로 감쌌다. 좌우 buffer
  캔들이 가격축·차트 바깥으로 새지 않는다.
- clip id는 `useId()`를 id-safe 문자로 정리해 인스턴스별로 만든다(고정 id 금지
  — 한 화면에 차트가 여럿이어도 충돌하지 않는다).
- 가격축 텍스트·현재가 라벨·크로스헤어 라벨·시간 라벨은 clip 바깥이라 그대로
  보인다.

**E. 상세 등락률 basis 통일**

- `AssetDetailScreen`의 `getDisplayChangeRate()`(ticker → REST fallback) 제거.
  다른 화면 사용처 없음을 검색으로 확인 후 삭제.
- `const displayChangeRate = displayPrice.changeRate;` — realtime ticker가
  있으면 ticker의 changeRate만 쓰고, 그것이 null이면 등락률도 표시하지 않는다
  (과거 REST 값으로 채우지 않음). ticker가 없을 때만 REST changeRate 사용.

**F. Reanimated·Worklets 제거**

- 저장소 전체 검색 결과 `react-native-reanimated`/`react-native-worklets`를
  실제로 import하는 코드 없음(문서·package.json·babel.config.js·proguard
  주석뿐). gesture callback은 전부 `runOnJS(true)`라 worklet이 없다.
- `frontend/package.json`에서 두 패키지 제거 + `npm install`로
  `package-lock.json` 갱신(11 packages removed). 남은 lock 언급은
  `expo-modules-core`의 **optional** peerDependency 한 줄뿐이다.
- `babel.config.js`는 `react-native-worklets/plugin`을 빼고 Expo 기본
  preset만 남겼다(파일 자체는 유지 — Expo 기본 설정 지점).
- `react-native-gesture-handler`와 `App.tsx`의 `GestureHandlerRootView`는
  **유지**. Reanimated 기반 차트 애니메이션은 새로 만들지 않았다.
- 남은 흔적 1건: `frontend/android/app/proguard-rules.pro`의
  `# react-native-reanimated` keep 규칙(존재하지 않는 클래스 keep이라 무해).
  네이티브 빌드 파일이라 이번 표시 보완 작업에서는 건드리지 않았다. 다음
  `expo prebuild`/release 정리 때 함께 제거하면 된다.

**G. long press 종료 보강**

- (→ 2026-07-29 "캔들 차트 조작 정리" 작업에서 이 session은
  `createChartGestureSession()`(none/pan/pinch/crosshair)으로 확장됐다.)
- 크로스헤어 상태를 `candlestickGesturePolicy.ts`의
  `createCrosshairSession()`(순수 상태 머신, 단위 테스트 가능)으로 옮기고
  `longPress.onFinalize(endCrosshair)`를 추가했다. 움직이지 않고 손을 뗀 경우
  `crosshairPan`은 activate된 적이 없어 종료 이벤트가 없었는데, 이제 long
  press finalize가 반드시 정리한다(취소/실패/차트 바깥 이동 포함).
- `end()`는 idempotent라 long press + crosshair pan이 함께 finalize돼도
  `onCrosshair(null)`/`onGestureEnd`는 각각 1회만 발생하고 viewport snapshot이
  어긋나지 않는다. pinch `onBegin`은 기존대로 크로스헤어를 먼저 정리한다.
  일반 가로 pan·세로 scroll은 `start()`를 부르지 않으므로 크로스헤어가 뜨지
  않는다(gesture composition 자체는 그대로).

**검증**

- frontend `npm run typecheck` 통과, `npm test` **224 pass / 0 fail**
  (viewport·layout·crosshair·gesture policy·차트 가격 포맷·displayPrice basis).
- `npx expo export --platform web` / `--platform android` 모두 성공
  (reanimated/worklets 없이, babel plugin 없이 번들됨). 웹 번들에 clipPath와
  `candle-plot-` id 생성 코드 포함 확인.
- **Android 실기기/에뮬레이터 수동 검증 NOT_RUN**, **웹 브라우저 수동 검증
  NOT_RUN** — 이 환경에 adb·emulator·JDK·브라우저가 없다(설치된 것 없음 확인).
  대체 검증은 순수 모듈 단위 테스트 + 두 플랫폼 번들 export + 번들 내 코드
  포함 확인뿐이다. 제스처·clip 렌더 결과는 다음 담당자가 실기기/브라우저에서
  확인해야 한다.
- 백엔드 코드 변경 없음(문서만 수정) → backend 테스트 미실행.
- DB migration 없음. 주문·체결·포지션·지갑·원장·캔들 API/스키마 불변.

### 작업 단위: 실시간 표시 일관성 마무리 + 캔들 차트 gesture/viewport 재구성 (2026-07-26)

**목적**

직전(2026-07-25 2차) 작업의 잔여 결함을 마무리하고, 캔들 차트를 요구된 구조
(순수 viewport 모듈 + 공통 renderer + 플랫폼별 얇은 gesture adapter)로 재구성한다.

**A. 실시간 표시 일관성**

- 상세 화면이 표시하는 가격 블록 전체가 **하나의 기준**을 쓴다
  (`features/asset/displayPricePolicy.ts`의 `selectDisplayPrice`). realtime
  ticker가 있으면 local price·`priceKrwState`·`priceKrwReason`·`priceKrwMessage`·
  `priceSource`·`fxRateSource`·capturedAt/effectiveAt·freshness·decimals를 모두
  그 ticker에서 가져오고, ticker가 없을 때만 REST 세트를 쓴다. REST/realtime
  metadata 혼합 불가. 화면에 `환율 소스` 행과 KRW 사용 불가 사유 표시를 추가.
- MarketScreen 행 리렌더: 병합 캐시를 걷어내고 요구된 구조로 변경 —
  `item`(REST baseline)과 `ticker`를 **별도 prop**으로 넘기고
  `MarketAssetRow` 내부에서 `mergeMarketAssetTicker`로 병합, `React.memo`
  comparator가 item/ticker/isStale/onPress identity를 비교한다.
- stale: `getTickerAgeMs(ticker, nowMs)` / `isTickerStaleAt(ticker, nowMs)`
  (임계값은 기존 60초 상수 재사용, 중복 상수 없음) + `useStaleRecheck` 훅이
  5초 주기로 재판정. ticker를 보유한 화면에서만 timer가 돌고, unmount·
  백그라운드 전환 시 정지하며 foreground 복귀 시 즉시 1회 재판정한다.
- ticker backpressure 보강: 클라이언트별 pending 큐를 자산 키 기준 + 64개
  상한(가장 오래된 자산부터 제거)으로 제한하고, unsubscribe/disconnect 시
  정리, 카운터를 `GET /readiness`의 `data.assetTicker`로 노출
  (`TICKER_FANOUT_METRICS` 토큰 주입 — readiness가 gateway 클래스를 직접
  import하지 않는다).

**B. 캔들 차트 재구성**

- viewport 모델을 요구 사양대로 `{visibleCount, rightOffset}`으로 변경하고
  `candlestickViewport.ts`(+test)로 이전: `createDefaultViewport`,
  `clampVisibleCount`, `clampRightOffset`, `getVisibleIndexRange`,
  `panViewportByPixels`, `zoomViewportAtFocalPoint`, `resetViewport`,
  `isViewingLatest` 등. 상수는 MIN 20 / DEFAULT 60 / MAX 180, buffer 2.
- `candlestickLayout.ts`(+test) 복원: slot/body 픽셀 폭과 x ↔ visible offset
  매핑만 담당(zoom은 visibleCount 변경이지 scaleX가 아님).
- `candlestickGesturePolicy.ts`(+test): 수평 pan 의도 판정, 웹 wheel 의도
  분류(zoom / pan / page-scroll), wheel·pinch scale 범위 — 양 플랫폼 공유.
  (→ 2026-07-29 "캔들 차트 조작 정리" 작업에서 `page-scroll` 분기 제거,
  gesture lifecycle·wheel session 상태 머신 추가.)
- `CandlestickChartRenderer.tsx`: 공통 SVG renderer(모바일·웹 공용, 복제 없음).
- `CandlestickGestures.native.tsx`(RNGH pinch/pan/long-press) /
  `.web.tsx`(mouse drag/hover/ctrl+wheel). `CandlestickGestures.tsx`는 props
  계약 + gesture 없는 fallback이며 Metro가 플랫폼별로 해석한다.
- `CandlestickChart.tsx`는 viewport 상태·geometry·visible slice·컨트롤
  (`+`/`−`/`초기화`, 접근성 label)만 담당한다. (→ 2026-07-29 "캔들 차트 조작
  정리" 작업에서 확대·축소 버튼과 개수 문구를 제거하고 `최신` 버튼 하나만
  남겼다. 반응형 높이도 이때 추가.)
- 패키지: `npx expo install react-native-gesture-handler react-native-reanimated
  react-native-worklets`, `babel.config.js`에 `react-native-worklets/plugin`,
  `App.tsx`에 `GestureHandlerRootView` 1회 wrapping.
  → **2026-07-29 정정**: reanimated/worklets는 실제로 쓰이지 않아 제거했다.
  현재는 gesture-handler + `GestureHandlerRootView`만 남았고 babel plugin도 없다.

**주의사항**

- **네이티브 재빌드 필요**: gesture-handler는 네이티브 모듈이라 기존 dev
  client로는 실행되지 않는다(`npx expo run:android` 또는 새 EAS dev build).
  Expo web은 추가 설정 없이 동작한다.
  (2026-07-29에 reanimated/worklets를 제거했으므로 네이티브 모듈은
  gesture-handler뿐이다.)
- 차트는 로드된 캔들 범위 안에서만 이동한다(무한 과거 로딩·cursor pagination·
  candle API 변경 없음). 확장 지점은 `CandlestickChart`가 받는 candle 배열이며
  viewport 계산과 slice는 이미 분리되어 있다.
- 실시간 payload는 여전히 `assetPriceSnapshotId: null`(timestamp로 정렬).
- DB migration 없음. 주문·체결·지정가·지갑·원장 불변.

**검증**

- backend typecheck/build/test 2048 pass, frontend typecheck/test 218 pass,
  `expo export` web·android 성공(웹 번들에만 DOM adapter 포함 확인).
- 모바일 실기기/에뮬레이터 제스처 수동 검증과 웹 브라우저 수동 검증은
  환경 부재로 NOT_RUN(순수 모듈 테스트 + 번들 검증으로 대체).

### 작업 단위: 실시간 fanout 경량화·표시 결함 보완 + 캔들 차트 viewport 인터랙션 (2026-07-25)

**목적**

직전 "암호화폐 시세 실시간성·표시 정밀도 개선" 작업에서 남은 결함 8건을 보완하고,
캔들 차트를 모바일 중심의 확대·축소·좌우 이동(viewport) 차트로 개선한다.
가상 트레이딩 앱 수준 유지: 거래소급 차트 엔진·무한 과거 로딩·지표 시스템 없음.

**A. 실시간 보완 변경 요약**

- (백엔드) 실시간 ticker 한 건마다 돌던 DB 조회 제거.
  `AssetTickerGateway`가 `buildSnapshotTickerMessage()`(구독 ack + 3초 poll 전용,
  기존 `buildTickerMessage` 개명)와 분리된 `buildRealtimeTickerMessageFromEvent()`로
  event + 캐시만으로 payload를 만든다.
  - `RealtimeAssetMetadataCacheService`(신규, realtime/): assetId→자산 identity,
    5분 TTL, unknown/inactive 30초 negative cache, DB 실패 시 마지막 값 유지.
    `displayPriceDecimals`는 읽기 시점마다 Binance tickSize 메모리 캐시에서 해석.
  - `AssetsService.convertRealtimePriceToKrw` 내부 2초 TTL USD/KRW selection
    캐시(가용/불가 결과 모두 캐시, 동시 miss 1회 조회 병합). REST 경로는 불변.
  - 실시간 event는 `assetPriceSnapshotId: null`로 나간다(저장 스냅샷을 주장하지
    않음). 정렬/dedup은 `priceCapturedAt`/`priceEffectiveAt` 기준. 3초 poller가
    같은 가격의 스냅샷 메시지를 한 번 더 보낼 수 있으나 프런트 수락 정책이 걸러낸다.
- (백엔드) ticker backpressure + 최신값 coalescing: 클라이언트 소켓 buffered
  bytes가 임계값(캔들과 동일 knob, 기본 1MB) 초과 시 자산별 최신 1건만 보관,
  100ms flush 타이머가 소켓이 비면 전송. 해제된 구독의 잔여 큐는 폐기.
- (프런트) 상세 화면 KRW fallback 결함 수정: `displayPricePolicy.ts`의
  `selectDisplayPriceKrw/State/Source` — 최신 ticker가 있으면 local price·KRW
  상태·priceSource를 한 세트로 사용, ticker KRW unavailable이면 과거 REST KRW를
  절대 조합하지 않음. 가격 소스 표기도 실제 표시 가격의 소스를 따라간다.
- (프런트) 목록 리렌더 격리: `mergeMarketAssetTickersCached`(자산별 identity
  캐시)로 틱이 온 행만 새 객체가 되어 `React.memo` 행이 그 행만 리렌더.
- (프런트) 시간 경과 stale: `isTickerStaleAt(state, nowMs)` + 10초 재판정
  (`useAssetTicker` interval, `MarketTickerStore` 타이머·`recomputeStaleness`).
  ticker가 끊겨도 60초 지나면 stale로 전환된다.
- (프런트) ticker의 `displayPriceDecimals`가 목록 행 병합에 반영된다.

**B. 캔들 차트 viewport 변경 요약**

- `frontend/src/components/charts/chartViewport.ts`(신규, 순수 모듈): offset/size
  viewport, 기본 최신 60개(모든 타임프레임 동일 밀도, 데이터가 적으면 오른쪽
  정렬 + 왼쪽 여백), pan/zoom 클램프(12~240개, 로드된 범위 내), 보이는 구간 +
  버퍼 4개만 렌더, y축은 보이는 캔들 기준, 우측 끝 고정 시 신규 캔들 follow,
  wheel/pinch/수평 의도 판정 등 gesture 수학 포함. `node --test` 25케이스.
- `CandlestickChart.tsx` 재작성: PanResponder 기반 —
  두 손가락 pinch 확대·축소(손가락 중점 anchor), 한 손가락 수평 드래그 pan,
  세로 드래그는 클레임하지 않아 부모 ScrollView가 스크롤, ~300ms 길게 누르면
  크로스헤어(이동 추적, 뗄 때 해제). 웹(react-native-web): 마우스 드래그 pan
  (동일 responder), non-passive DOM wheel 리스너로 커서 anchor 줌, hover
  크로스헤어. 현재가 라인은 최신 캔들이 보일 때만. 타임프레임 전환 시
  `viewportResetKey`(assetId:interval)로 최신 60개로 초기화.
- 기존 `candlestickLayout.ts`(+test)는 viewport 모듈이 대체하여 삭제
  (오른쪽 정렬·밀도 정책은 chartViewport 테스트가 커버).

**주의사항**

- 실시간 payload 계약 변화: `assetPriceSnapshotId`가 실시간 event에서 항상 null.
  스냅샷 기반 메시지(구독 ack·poll)는 기존 그대로. 클라이언트는 timestamp로 정렬.
- gateway 생성자에 `RealtimeAssetMetadataCacheService`가 필수 param으로 추가됨
  (spec/스크립트에서 직접 생성 시 mock 필요 — candle-release-fixture-smoke 포함 수정).
- 차트는 로드된 캔들 범위 안에서만 이동한다. 과거 무한 로딩은 의도적으로 제외.
- DB migration 없음. 주문·체결·지정가·지갑·원장 불변.

**검증**

- backend: typecheck/build/test 2045 pass (신규: metadata cache 8, FX 캐시 3,
  gateway 이벤트 빌더·backpressure 15, 기타).
- frontend: typecheck/test 168 pass (신규: displayPricePolicy 5, 정책 stale 2,
  store stale 1, merge decimals·identity 4, chartViewport 25), expo export
  android/web 성공.
- 실기기 pinch/long-press 제스처는 에뮬레이터 부재로 미실행(NOT_RUN) — gesture
  수학은 순수 모듈 테스트로 검증, 컴포넌트는 typecheck + 번들로 확인.

### 작업 단위: 암호화폐 시세 실시간성·표시 정밀도 개선 (2026-07-25)

**목적**

거래소(Binance) 화면과 앱 화면의 가격 차이를 줄인다. 세 가지 원인을 해결한다.

1. 시장 목록 화면(MarketScreen)이 REST 조회 시점 가격만 표시하고 실시간 ticker를 구독하지 않음.
2. live candle 모드에서 Binance `@ticker`가 DB 저장(종목별 5초 throttle)을 거쳐
   gateway의 3초 DB polling으로만 앱에 도달 → 최대 수초 지연.
3. 프런트엔드가 모든 USD 가격을 소수점 2자리로 반올림 → XRP/TRX/DOGE 등 저가 코인의
   표시값이 거래소와 달라짐.

**가격 기준(고정)**

- `Binance Spot USDT 마켓 최근 체결가` = `24hrTicker` 이벤트의 `c`.
- `b`(최우선 매수호가)/`a`(최우선 매도호가)는 이벤트에 포함되지만 화면에 쓰지 않는다.
- Futures / Mark Price / Index Price / bid·ask 중간값 / 타 거래소·평균가는 사용하지 않는다.
- 신규 stream(`@trade`, `@aggTrade`, `@bookTicker`) 없음. `@ticker`만 사용.
- USDT는 MVP 정책상 USD 등가로 취급한다(`CurrencyCode.USDT` 없음).

**변경 요약**

- 백엔드
  - `LiveCandleStreamSupervisorService.handleBinanceTickerFrame`이 ticker 수신 즉시
    공용 `ProviderPricePubSubService`로 fanout하고, DB snapshot 저장은 **별개의**
    background 작업으로 수행. DB 저장 실패는 fanout을 막지 않고 provider health의
    `lastErrorCode`에 기록된다. 기존 종목별 snapshot throttle
    (`BINANCE_WS_SNAPSHOT_THROTTLE_MS`, 기본 5000)과 dedup은 그대로다.
  - `AssetTickerGateway`가 실시간 이벤트의 KRW 환산을 스냅샷 값 재사용 대신
    `AssetsService.convertRealtimePriceToKrw`로 재계산한다. FX가 없거나 stale이면
    local price는 유지하고 `priceKrwState=unavailable`로 보낸다.
  - `BinanceSymbolMetadataService`(신규)가 공개 `GET /api/v3/exchangeInfo`의
    `PRICE_FILTER.tickSize`에서 종목별 표시 자릿수를 뽑아 메모리 캐시(6h TTL,
    백그라운드 갱신, 실패 시 마지막 성공값 유지)로 제공한다. 캐시가 없으면
    `binance-fixed-asset-universe.ts`의 검토된 상수를 fallback으로 쓴다.
  - 자산 목록/상세/`:assetId/price` 응답과 `asset_ticker` WebSocket payload에
    `displayPriceDecimals`(additive, nullable) 추가. `/api/v1` 유지.
- 프런트엔드
  - `useMarketTickers` + `MarketTickerStore`가 현재 로드된 assetId를 **기존 공용
    소켓**(`getRealtimeSocketManager`, `/api/v1/ws`, `asset_ticker` 채널)에 구독한다.
    종목별 새 연결 없음, 신규 채널 없음.
  - `mergeMarketAssetTicker`가 REST baseline 위에 실시간 가격만 overlay한다.
  - `MarketAssetRow`(React.memo)로 행 분리 → 틱이 온 종목만 리렌더.
  - `assetTickerPolicy`가 목록/상세 공통 수락 규칙(스냅샷 중복, timestamp 역행,
    timestamp 없는 이벤트, unavailable, stale)을 담당한다.
  - `formatAssetPrice(value, currencyCode, displayPriceDecimals)`가 자산 **단가** 표시를
    담당한다. 지갑 잔액·주문 총액·수수료는 기존 `formatMoney`/`formatCurrency`
    (USD 2자리) 정책 그대로다.

**주의사항 / 다음 사람이 알아야 할 것**

- DB migration 없음. 스키마 변경 없음. 주문·체결·지정가 matcher·지갑·포지션·원장
  계산은 건드리지 않았다. 화면 표시 최신성 개선일 뿐이며, 주문 체결 가격은 여전히
  서버 quote/execute가 최종 결정한다.
- 일반 ticker 모드와 live candle 모드는 상호 배타적이다.
  `BinanceWebSocketStreamingService.start()`가 live candle Binance 모드에서 스스로
  `state=disabled`가 되므로 같은 ticker가 두 번 fanout되지 않는다. 모드 전환 후에는
  backend를 재시작해야 한다.
- 고정 universe의 `priceTickSize`/`displayPriceDecimals` 상수는 fallback이다. 실제
  값은 런타임에 exchangeInfo에서 갱신되고, `pnpm smoke:binance-fixed-universe`가
  상수와 실제 tickSize 일치를 검증한다(현재 10/10 일치).
- 자릿수를 프런트엔드에 하드코딩하지 말 것. 백엔드 `displayPriceDecimals`만 쓴다.

**운영 환경변수 / 실행 명령**

```env
# 일반 ticker 모드
BINANCE_WEBSOCKET_STREAMING_ENABLED=true
CANDLE_LIVE_STREAMING_ENABLED=false
CANDLE_LIVE_BINANCE_ENABLED=false
BINANCE_WS_SNAPSHOT_THROTTLE_MS=5000

# live candle 모드(ticker 즉시 fanout + kline)
CANDLE_LIVE_STREAMING_ENABLED=true
CANDLE_LIVE_BINANCE_ENABLED=true
BINANCE_WS_SNAPSHOT_THROTTLE_MS=5000
```

```bash
cd backend && pnpm install && pnpm exec prisma generate
pnpm exec prisma migrate status      # 새 migration 없음
pnpm run typecheck && pnpm run build && pnpm test
BINANCE_MARKET_DATA_SMOKE=1 pnpm smoke:binance-fixed-universe   # 실제 provider, opt-in

cd frontend && npm run typecheck && npm test
```

---

## 2. 최신 작업 시간순 기록

### 2026-08-03 — 일반모드 계정·최초 지급·광고 보상 기반 + 작업 5 결함 3종 보완 (작업 6)

- 작업 5 결함 보완: ① account-scoped 주문 취소의 잠금 SQL에서 계정 조건을
  제거하고 자기 주문의 null/불일치 scope를 404가 아닌 500
  `TRADING_SCOPE_REPAIR_REQUIRED`/`TRADING_ACCOUNT_SCOPE_MISMATCH`로 노출
  (다른 계정의 정상 주문은 404 유지, 오류 시 상태·예약금 불변),
  ② 시장가 주문 committed replay first — 소유권 확인 후 계정 기준 멱등 조회를
  먼저 수행하고 기존 주문이 없을 때만 신규 거래 gate 실행(계정 suspended·
  closed, 시즌 종료, 참가자 제외, 자산 비활성 이후에도 저장된 최초 응답 재생),
  ③ 원자 지갑 UPDATE 0행을 wallet id 단독 재조회로 분류해 scope 손상·잔액
  부족·실제 동시성 충돌을 구분(시장가 debit/credit, 지정가 reserve/settle/
  release, 운영자 제외 cleanup, FX source/target 전 경로).
- 작업 6: additive migration 2건(enum 전용 + foundation)으로 CashWallet·
  WalletTransaction `seasonParticipantId` nullable 전환, `ad_reward`·
  `general_account_open`·`ad_reward_claim` enum, `AdRewardClaimStatus`,
  `ad_reward_claims` 테이블, 단일 행 reference용 partial unique 2종 추가.
  기존 지갑·원장 행 수와 금액은 불변(fingerprint 실측).
- `POST /api/v1/trading-accounts/general`: 계정 + KRW/USD 지갑 + 최초
  10,000,000 KRW initial grant를 하나의 트랜잭션으로 생성. partial unique
  기반 멱등으로 재호출·동시 호출에서도 계정 1개·통화별 지갑 1개·지급 1건.
  월별/정기 지급·스케줄러·자동 초기화 없음. 손상 계정은 500
  `GENERAL_ACCOUNT_INTEGRITY`로 fail-closed(자동 재지급 금지),
  suspended/closed는 재활성화하지 않는다.
- 광고 보상 기반: provider-neutral 검증 인터페이스·registry, 운영 설정
  전용 config(기본 disabled, enabled 시 필수값 엄격 검증, 일일 경계는 설정
  timezone), eligibility/claim/claims endpoint, 계정 행 FOR UPDATE 직렬화,
  동일 provider 이벤트 중복 차단, 일일 횟수·금액·cooldown 재검증, KRW 지갑
  지급 + `ad_reward` 원장 + claim granted 원자 처리, rejected 이벤트 영구
  미지급. 시즌계정 지급 차단, USD 미지급, initialCapitalKrw 불변.
  **실제 광고 provider 미확정 — 운영 registry 비어 있어 503
  `AD_REWARD_PROVIDER_UNAVAILABLE`, fake verifier는 테스트 전용.**
- 일반모드 주문·환전은 계속 차단(`GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED`/
  `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`), TWR·투자손익·프런트엔드 미구현.
  read-only 운영 점검 `pnpm trading-accounts:audit-general` 추가.
- 검증: unit 2,315 pass, opt-in DB 통합 16종 직렬 PASS(신규 general-account·
  order-replay-and-cancel-scope 포함), e2e 119/122(실패 3건은 기준 커밋
  c08ddc70에서 동일 재현 확인한 BASELINE_FAIL), migration 전후 fingerprint
  불변, audit-general findings 0. 실제 광고 provider 연동은
  PROVIDER_NOT_CONFIGURED.

### 2026-08-03 — 주문·포지션·Quote TradingAccount 전환 + 복구 결함 3종 보완 (작업 5)

- 직전 작업 4 결함 보완: ① 지갑 변경·지갑 잔액 기반 quote 생성 전 공통
  scope guard(null → `FINANCIAL_SCOPE_REPAIR_REQUIRED` 500, 불일치 →
  `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` 500)를 시장가/지정가/FX 전
  경로에 적용하고 원자 UPDATE WHERE에 `trading_account_id` 추가,
  ② account-scoped 금융 조회가 참가자의 null/불일치 scope 행 존재 시 빈
  결과 대신 repair-required 500으로 fail-closed(general 계정은 정상 빈 결과),
  ③ FX 전역 per-user unique를 legacy null 행 전용 partial unique로 교체해
  같은 사용자의 계정 간 idempotency key 재사용 허용(신규 요청 멱등성은
  legacy endpoint 포함 전부 계정 기준, legacy replay는 user+participant
  고정 fallback).
- additive migration으로 Order·Position·Quote에 nullable tradingAccountId +
  Restrict FK + 계정 unique(주문 idempotency, 포지션 asset)·조회 인덱스를
  추가하고 참가자 링크에서 backfill(멱등, participant 없는 quote는 null
  유지, 값·상태·hash 불변). 신규 writer 전부 dual-write(링크 null이면
  fail-closed), 기존 Position/Quote는 계정 검증 후에만 update/소비(타 계정
  포지션 감소·quote 소비 불가), 지정가 자동 체결은 트랜잭션 내 계정 일치
  재검증 + suspended/closed 계정 skip.
- account-scoped 주문·포지션 API 추가(`…/:accountId/orders` 목록/상세/quote/
  생성/취소, `…/positions` 목록; 타인·미존재·타 계정 orderId 동일 404,
  general 409, suspended/closed 신규 주문 409·조회 허용·취소 허용). legacy
  주문·포지션 API 계약 불변, 같은 서비스 코어 공유. 운영 스크립트
  `trading-accounts:repair-trading-scope`(기본 dry-run, mismatch 보고만,
  apply 후 잔여 시 exit 1) 추가. 계약 문서
  `docs/trading-account-orders-api-contract.md` 신규.
- 검증: unit 2,243 pass, opt-in DB 통합 14종 직렬 PASS(신규 trading-scope
  6블록 포함, 기존 러너 fixture dual-write 갱신), e2e 115/118(실패 3건은
  기준 커밋 e91921aa에서 동일 재현 확인한 BASELINE_FAIL), dev DB migration
  전후 fingerprint 불변 + repair-trading-scope dry→apply→멱등 재실행 실측 +
  §20 완료 기준 쿼리 전부 0.

### 2026-08-03 — 금융(지갑·원장·환전) TradingAccount 전환 + 복구 결함 3종 보완

- 직전 작업 결함 보완: ① 링크 복구가 ON CONFLICT 이후 저장 계정을 재조회·
  검증한 뒤에만 참가자를 연결(불일치 fail-closed, 실제 PG race로 검증),
  ② repair-links가 과거 excluded 참가자의 active 계정을 탐지해
  suspended로 보정(closed/general/타인 계정 불변), ③ 복구 CLI가 null·
  mismatch 잔여 시 exit 1로 종료(NOT NULL 전제는 exit 0 + 잔여 0).
- additive migration으로 금융 4모델(지갑·원장·환전거래·환전요청)에 nullable
  tradingAccountId + Restrict FK + 계정 unique(지갑 통화, FX idempotency)·
  인덱스를 추가하고 참가자 링크에서 backfill(IS NULL 가드, 멱등, 금액·ID
  불변, null 링크는 null 유지). 신규 writer 전부(시즌 참가, dev baseline,
  환전, 시장가/지정가 원장)가 seasonParticipantId + tradingAccountId를
  dual-write하고, 링크 null이면 금융 쓰기를 중단한다.
- 운영 스크립트 `trading-accounts:repair-financial-scope`(기본 dry-run) 추가:
  null scope만 참가자 링크로 backfill, 불일치는 보고만·덮어쓰기 금지, apply
  후 null·mismatch 0 재검증(잔여 시 exit 1).
- account-scoped 금융 API 추가: `/api/v1/trading-accounts/:accountId/`
  아래 wallets·wallet-transactions(조회, suspended/closed 허용)·fx quote/
  execute/transactions(시즌 정책 + account active 요구, general 미구현 409,
  타인/미존재 동일 404). legacy wallets/fx 계약 불변, 같은 서비스 계산 공유,
  계정 기준 idempotency. 계약 문서 `trading-account-finance-api-contract.md`.
- 검증: unit 전체 pass, DB 통합 12종 직렬 PASS(신규 financial-scope 8케이스
  포함), e2e 115/118(3건은 기준 커밋 동일 BASELINE_FAIL), dev DB에서
  migration 전후 fingerprint 불변 + 운영 CLI 시나리오(dry→apply→멱등 재실행,
  exit 0) 실측.

### 2026-08-03 — TradingAccount null link 복구 + 제외 suspended 동기화 + 거래계정 조회 API

- 배포 경계에서 구버전 writer가 만드는 `tradingAccountId=null` 참가자를
  복구하는 공통 계층을 추가했다: migration과 바이트 동일한 결정적 계정
  ID(md5→uuid), backfill과 같은 status 매핑, raw ON CONFLICT insert + null
  가드 updateMany로 동시 복구에서도 계정 1개·orphan 0, 불일치는 덮어쓰지 않고
  `TRADING_ACCOUNT_LINK_INTEGRITY` fail-closed. 지갑·원장·주문·포지션·스냅샷은
  절대 수정하지 않는다.
- joinSeason 기존 참가자 경로가 null link를 같은 트랜잭션에서 복구한 뒤 기존
  409 계약을 유지한다(복구 commit 후 409). dev baseline도 링크만 복구한다.
  운영용 `pnpm trading-accounts:repair-links`(기본 dry-run, `--apply` 명시)를
  추가했다.
- 운영자 참가자 제외가 같은 트랜잭션에서 연결 계정을 suspended로 동기화한다
  (null link면 먼저 복구, closed는 되돌리지 않음, 감사 로그에 계정 상태
  전후 기록). settled/rewarded/finished 시점의 closed 동기화는 후속 작업.
- `GET /api/v1/trading-accounts`·`/:accountId` 조회 API와
  `TradingAccountAccessService` 소유권 계층을 추가했다. 타인/미존재 계정은
  동일 404, suspended/closed 조회 허용, 서버측 현재 선택 계정 저장 없음.
  계약 문서 `docs/trading-accounts-api-contract.md` 신규.
- 검증: typecheck·build·unit 2,189 pass, 신규 링크 DB 통합 12케이스(결정적 ID
  Postgres 대조·race·rollback 포함)와 기존 DB 스위트 직렬 PASS, e2e 109/112
  (실패 3건은 HEAD와 동일한 env 기인, stash로 대조 확인), 운영 시나리오 A를
  실제 CLI dry-run→apply→재실행으로 검증. HEAD에서 깨져 있던 join DB 스위트
  cleanup(FK)을 수정했다.

### 2026-08-01 — 시즌·일반모드 규칙 확정 + TradingAccount DB foundation

- 시즌/일반 두 투자 모드의 자산 완전 분리, 일반모드 최초 1,000만 원 1회 지급
  (월 자동 지급 전면 폐기), 보상형 광고 기반 추가 자금, 광고 보상금의 투자손익·
  수익률 제외와 시간가중수익률 방향을 확정하고
  `backend/docs/trading-modes-and-accounts.md`(신규)와 `policy-decisions.md`에
  문서화했다. 광고 기능·일반모드 API는 전부 미구현임을 명시했다.
- additive migration `20260801120000_add_trading_account_foundation`으로
  `TradingAccountMode/Status` enum과 `trading_accounts` 테이블(양수 자본·종료
  시각 CHECK, user FK RESTRICT), general 계정 사용자당 1개 partial unique
  index를 추가하고, 기존 SeasonParticipant 전건에 season 계정을 결정적 id로
  backfill해 nullable unique `trading_account_id`로 연결했다(후속 NOT NULL
  예정). general 계정·일반 지갑·광고 데이터는 생성하지 않았고 기존 금융
  데이터는 불변이다.
- 시즌 참가 트랜잭션이 계정→참가자→지갑→원장→스냅샷을 한 트랜잭션으로 만들고
  중간 실패 시 계정까지 rollback된다(응답 계약 불변). dev-baseline과 통합
  fixture 8곳, mvp-flow cleanup도 계정 생성/정리를 반영했다.
- 검증: prisma format/validate·typecheck·build·unit 2,139 pass, 신규 schema
  계약 스펙 + opt-in PostgreSQL 통합 스펙(backfill SQL 실측·partial unique·
  CHECK·rollback·race), 빈 DB/직전 상태 DB migration 적용, 검증 쿼리 전 항목
  0건, FX/orders/limit-order/MVP flow DB 스위트 통과. e2e는 mock enum 추가로
  join 500을 수정, JWT env를 맞추면 HEAD와 동일한 3개 env 실패만 남는다.

### 2026-07-29 — 캔들 차트 미표시 장애 수정(coverage 판정·부분 서빙·KIS 스윕)

- 실제 백엔드에 요청을 보내 장애를 재현했다: 5m/15m는 503
  `ASSET_CANDLES_PROVIDER_UNAVAILABLE`, 30m/1h/4h는 503
  `ASSET_CANDLES_BASELINE_NOT_READY`, 1d만 200. 체크포인트 테이블에서 원인을
  확정했다(baseline 미시딩, KIS repair의 `data_incomplete`, boolean coverage
  판정, KIS 레이트리밋, 프런트의 skeleton 은폐).
- coverage 판정을 boolean에서 `{startsAtRequestedFrom, contiguousCoveredTo,
  hasInteriorGap, newestCompletedAt}`로 바꾸고 `complete / stale_tail /
  insufficient` 3단계로 분류했다. sync 직후 tail 몇 분이 미확인이어도(기본 1일
  허용) 차트는 정상 서빙되고, 중간 구멍은 여전히 절대 허용하지 않는다.
- coverage가 미확인이어도 저장된 캔들이 있으면 그것으로 응답한다
  (`database_partial`). 반환 캔들은 전부 검증된 저장 캔들이며 불완전 버킷은
  계속 제외된다. `BASELINE_NOT_READY`는 보여줄 캔들이 전혀 없을 때만 낸다.
- KIS 도메스틱 스윕이 `data_incomplete` 세그먼트에서 run 전체를 멈추던 동작을
  제거했다. 더 오래된 세그먼트까지 계속 수집하되 coverage claim은 구멍에서
  봉인해 min/max 병합이 구멍을 잇지 못하게 했다. 005930 14일 sync가 137행 →
  669행(9거래일)으로 늘었다.
- 프런트가 baseline 이외의 캔들 오류를 skeleton으로 감추던 것을 고쳤다
  (`describeCandleError`: 제목 + 백엔드 오류 코드/HTTP 상태/네트워크 안내).
- baseline 스크립트의 sync 경로가 앱 컨텍스트 부팅에서 조용히 죽던 문제를 고쳐
  실제 시딩을 수행했다: crypto 2자산 coverage 완료, 005930 669행.
- 실측 결과 5m·15m·30m·1h·4h·1d가 KRX/암호화폐 모두 200으로 표시된다. KRX 오후
  4시간봉이 빠지는 건 15:20~15:30 종가 단일가 구간에 분봉이 없기 때문이며
  한계로 문서화했다.
- 검증: backend jest 2097 pass, typecheck·build·lint 통과, frontend typecheck·
  test 통과, expo export web/android 성공. DB migration 없음, 주문·체결·포지션·
  지갑·원장 불변.

### 2026-07-29 — 30분·1시간봉 14일 확대와 4시간봉 DB 집계 경로 정상화

- 백엔드에 `14d` 캔들 범위를 정식 추가했다(타입·허용 집합·기본 interval·오류
  메시지·캐시 검증·프런트 타입). 범위 길이 계산은 if-chain에서 exhaustive map
  으로 바꿔, 새 범위를 빠뜨리면 365일로 새지 않고 컴파일 에러가 나게 했다.
- 프런트 타임프레임: 30분봉 `14d`/672, 1시간봉 `14d`/336, 4시간봉 `30d`/200.
  5m·15m·1d·1w는 기존 정책 유지.
- `CANDLE_SERVING_MODE` 기본값을 `legacy` → **`database`** 로 바꿨다(.env.example
  포함). `legacy`는 명시적 긴급 롤백 전용으로 남는다.
- 15m/30m/1h/4h는 저장된 5분봉 집계로만 제공한다. baseline이 없을 때 잘린 KIS
  120행 응답으로 폴백하던 분기를 `ASSET_CANDLES_BASELINE_NOT_READY`(503)로
  바꿨고, 프런트는 이를 "차트 데이터를 준비 중입니다." 상태 + 재시도로 표시한다
  (5m/1d/1w와 1m 등 비집계 요청의 기존 호환 경로는 유지).
- serving coverage 판정을 단일 체크포인트에서 **coverage-audited 체크포인트
  합집합**으로 확장했다(`findCompletedCoverageUnion`). 35일 baseline 1회 +
  이후 incremental tail이 14일·30일 창을 현재 시점까지 커버할 수 있다. 개별
  행의 완전성 요건은 그대로이며 중간 구멍은 여전히 "커버 안 됨"이다.
- 커버리지는 있는데 과거 버킷에 5분봉 구멍이 있으면 불완전 버킷은 버리고 완전한
  버킷만 제공한다(`incomplete_buckets_dropped`). 불완전 캔들을 정상 캔들로
  올리지는 않는다.
- baseline 시딩/확인용 `pnpm candle:baseline`(`scripts/candle-baseline-sync.ts`)
  추가 — 기존 `MarketCandleSyncService.syncAssets`를 감싼 얇은 래퍼이고 동기화
  로직 복제는 없다. `--report`는 DB만으로 자산별 준비 상태를 출력한다.
- `candle_delivery` 로그에 delivery state·source interval·range·요청 범위·
  커버리지·fallback reason을 추가했다(응답 형태 불변). DB 응답의
  `requestedCount`는 672/336/200을 그대로 반영한다.
- 검증: backend jest 2080 pass, typecheck·build·lint 통과, frontend typecheck·
  test 통과, expo export web/android 성공, 로컬 DB에 `--report` 실제 실행.
  실제 provider 자격증명이 필요한 baseline `--apply`와 실기기 차트 확인은
  NOT_RUN. DB migration 없음, 주문·체결·포지션·지갑·원장 불변.

### 2026-07-29 — 가로 휴대전화 차트 높이 오분류·웹 drag 중 wheel 충돌 수정

- 차트 높이 layout 판정이 **너비만** 보던 문제 수정. 가로 방향 휴대전화
  (예: 390 × 844 기기가 회전한 844 × 390)가 844 ≥ 768이라 wide로 오분류되어
  390px 화면에 500px 차트를 요구했다.
- 새 판정: 네이티브는 **짧은 변**(`min(width, height)`) 기준으로
  `< 600` phone / `>= 600` tablet — 회전해도 class가 바뀌지 않는다. 웹은 기존
  창 너비 기준 `< 768` narrow / `>= 768` wide를 유지한다
  (`getCandlestickChartLayoutClass` → `phone | tablet | webNarrow | webWide`).
- 결과: 네이티브 844 × 390 → phone → 380px(500px 아님), 768 × 1024·1024 × 768
  → tablet, 웹 844 × 390 → wide 유지. 높이 범위(휴대전화 52%/380~480,
  태블릿·wide web 60%/500~680)와 height prop override, 회전·resize 재계산,
  비정상 dimension fallback은 그대로다.
- `Platform.OS`를 `toChartLayoutPlatform()`으로 순수 함수에 넘긴다.
  User-Agent 판정·device-info 라이브러리·responsive 프레임워크 추가 없음.
- 웹에서 **마우스 드래그 중 들어온 wheel은 무시하되 소비**한다
  (`resolveWheelHandling(event, {dragActive})` → `consume`):
  `preventDefault()`는 유지해 페이지 스크롤·브라우저 확대가 없고, zoom·pan·
  `onGestureStart`/`onGestureEnd`·wheel session 시작은 전부 하지 않는다.
  wheel로 drag를 강제 종료하지 않으며, mouseup 이후 wheel zoom/pan과 burst
  누적·idle timer는 원래대로 동작한다.
- 검증: typecheck 통과, 277 pass, expo export web/android 성공. 웹 브라우저·
  네이티브 실기기 수동 검증은 환경 부재로 NOT_RUN. 백엔드 코드 변경 없음
  (문서만), DB migration 없음, 주문·체결·포지션·지갑·원장 불변.

### 2026-07-29 — 캔들 차트 조작 정리·세로 공간 확대

- 차트 하단 `−`/`＋` 확대·축소 버튼과 `N개` 표시 캔들 개수 문구, `초기화`
  버튼, 관련 접근성 label·스타일·callback을 제거했다. 접근성 label에서도 캔들
  개수 문구를 뺐다. 버튼 전용 `zoomViewportByStep()`/`ZOOM_STEP_SCALE`도 삭제.
- **내부 `visibleCount` viewport 상태는 유지한다**(MIN 20 / DEFAULT 60 /
  MAX 180, `zoomViewportAtFocalPoint`, 슬롯 계산). 사용자가 캔들 개수를 고르는
  UI만 사라졌고 확대 상태는 계속 visibleCount로 계산한다.
- 모바일: 두 손가락 pinch만으로 확대·축소, 한 손가락 가로 drag 이동, 세로
  swipe는 부모 ScrollView, long press 크로스헤어 — 확대·축소 버튼 없음.
- 웹: 차트 위 **일반 세로 마우스 휠로 확대·축소**(Ctrl/Cmd+wheel·트랙패드
  pinch 포함), Shift+wheel과 가로 트랙패드 입력은 좌우 이동, 마우스 drag 좌우
  이동·hover 크로스헤어 유지. 차트가 처리한 wheel은 모두 `preventDefault()`
  (`passive: false`)라 차트 위에서 페이지 스크롤·브라우저 확대가 없고, 차트
  밖 wheel은 그대로 페이지 스크롤이다.
- 연속 wheel은 `createWheelGestureSession()`으로 한 gesture로 묶어 누적 확대가
  정확하다(첫 이벤트 start 1회 → 누적 scale 적용 → 약 120ms 무입력 시 end,
  unmount 시 timer 정리).
- 최신 구간 복귀는 차트 위 작은 `최신` 버튼 하나만 남겼다(기본 viewport일
  때는 숨김, `rightOffset 0` + 60슬롯 + 크로스헤어 해제).
- long press 중 손가락이 차트 밖으로 나가면 크로스헤어를 종료한다
  (`shouldCancelWhenOutside(true)` + `isWithinChartBounds` 검사).
- `createChartGestureSession()`(none/pan/pinch/crosshair 순수 상태 머신)으로
  long press·crosshairPan·chartPan·pinch의 중복 finalize를 흡수해
  `onGestureStart`/`onGestureEnd`가 실제 gesture당 정확히 1회씩 호출된다.
- 차트 기본 높이를 반응형으로 확대: 모바일 `clamp(화면높이*0.52, 380, 480)`,
  넓은 웹·태블릿 `clamp(화면높이*0.60, 500, 680)`. `useWindowDimensions()`로
  회전·브라우저 resize에 재계산되고, `height` prop을 넘기면 그 값이 우선한다.
- 상세 화면은 기존 단일 세로 ScrollView를 그대로 쓴다(중첩 스크롤 추가 없음).
  차트가 커진 만큼 아래 콘텐츠는 스크롤로 확인한다. 시간봉 변경 시 60슬롯·
  rightOffset 0으로 초기화되는 동작도 그대로다.
- 검증: frontend typecheck 통과, 266 pass, expo export web/android 성공(번들
  문자열로 최신 버튼 존재·확대/축소 label 부재 확인). Android 실기기와 웹
  브라우저 수동 검증은 환경 부재로 NOT_RUN. 백엔드 코드 변경 없음(문서만),
  DB migration 없음, 주문·포지션·지갑·원장 불변.

### 2026-07-29 — 차트 표시 정밀도·슬롯 정렬·clip 보완 + Reanimated 제거

- 차트 가격축·현재가 라벨·크로스헤어·접근성 문구가 종목별
  `displayPriceDecimals`를 쓴다(`AssetDetailScreen` → `CandlestickChart` →
  renderer, 공통 `formatChartPrice`). DOGE 등 저가 코인이 더 이상 2자리로
  잘리지 않는다. 지갑·평가금액·주문 총액·수수료 포맷 정책은 불변.
- viewport의 `visibleCount`를 **화면 슬롯 수**로 재정의: 데이터가 60개보다
  적어도 기본 60슬롯을 유지하고 부족분은 왼쪽 빈 슬롯, 캔들은 오른쪽 정렬.
  40개·12개 차트의 캔들 폭이 600개와 같아졌다. 데이터 0개일 때만 빈 viewport.
- `originalCandleIndexForX()`로 빈 슬롯 위 크로스헤어를 첫 실제 캔들에 snap
  (미존재/음수 인덱스 불가).
- render buffer 캔들에 plot 영역 SVG clipPath 적용(`useId` 기반 인스턴스별
  id). 가격축·현재가/크로스헤어 라벨은 clip 바깥이라 그대로 표시된다.
- 상세 등락률을 `displayPrice.changeRate` 단일 basis로 통일하고
  `getDisplayChangeRate()` 제거 — realtime 가격 + 과거 REST 등락률 혼합 불가.
- 실사용처가 없던 `react-native-reanimated`/`react-native-worklets` 제거
  (package.json + lock 갱신, babel worklets plugin 제거). gesture-handler와
  `GestureHandlerRootView`는 유지.
- 모바일 long press 종료 보강: 크로스헤어를 `createCrosshairSession()`
  상태 머신으로 옮기고 `longPress.onFinalize`를 추가(움직이지 않고 손을 떼도
  종료, 중복 호출 안전).
- 검증: frontend typecheck 통과, 224 pass, expo export web/android 성공.
  Android 실기기·에뮬레이터와 웹 브라우저 수동 검증은 환경 부재로 NOT_RUN.
  백엔드 코드 변경 없음(문서만), DB migration 없음, 금융 데이터 불변.

### 2026-07-26 — 실시간 표시 일관성 마무리 + 캔들 차트 gesture/viewport 재구성

- 상세 화면 가격 블록을 단일 기준(selectDisplayPrice)으로 통일: KRW 상태·사유·
  메시지·가격 source·FX source·시각·정밀도가 모두 같은 데이터에서 나온다.
- MarketScreen을 item/ticker 별도 prop + 행 내부 병합 구조로 변경(리렌더 격리).
- stale 판정을 `getTickerAgeMs`/`isTickerStaleAt(ticker, now)` + 5초 재판정
  훅으로 정리(백그라운드에서는 timer 정지).
- ticker backpressure에 큐 상한·정리·readiness 메트릭(`data.assetTicker`) 추가.
- 캔들 차트를 `{visibleCount, rightOffset}` viewport + 공통 renderer + 플랫폼별
  gesture adapter 구조로 재구성(기본 60개, MIN 20/MAX 180, focal point zoom,
  visible 기준 Y축, 과거 구간 현재가선 숨김, visible+buffer만 렌더,
  timeframe reset, +/−/초기화 버튼).
- gesture-handler/reanimated/worklets 도입 → **네이티브 dev client 재빌드 필요**.
  (2026-07-29에 reanimated/worklets 제거 — 현재 네이티브 모듈은 gesture-handler뿐.)
- 검증: backend 2048 pass, frontend 218 pass, expo export web/android 성공.
  실기기·브라우저 수동 검증은 NOT_RUN.

### 2026-07-25 (2차) — 실시간 fanout 경량화·표시 결함 보완 + 캔들 차트 viewport

- 실시간 ticker fanout에서 이벤트당 DB 조회 제거(자산 metadata 5분 캐시 + FX 2초
  캐시), snapshot 기반 빌더와 분리, `assetPriceSnapshotId: null` 계약.
- WebSocket ticker backpressure(자산별 최신값 coalescing) 추가.
- 상세 화면 최신 ticker local price ↔ 과거 REST KRW 혼합 차단, 가격 소스 일치.
- 목록 행 identity 캐시로 틱이 온 행만 리렌더, ticker displayPriceDecimals 반영.
- 시간 경과 기반 stale 재판정(10초 주기, 상세+목록).
- 캔들 차트: viewport 기반 pinch 줌 / 수평 드래그 pan / 길게 눌러 크로스헤어 /
  웹 wheel·드래그, 기본 최신 60개 동일 밀도, 보이는 캔들 기준 y축, 보이는
  구간+버퍼만 SVG 렌더, 타임프레임 전환 시 초기화, 로드된 범위 내 이동만.
- 검증: backend 2045 pass, frontend 168 pass, expo export android/web 성공.
- DB migration 없음, 기존 금융 데이터 변경 없음.

### 2026-07-25 — 암호화폐 시세 실시간성·표시 정밀도 개선

- MarketScreen 실시간 구독(기존 공용 WebSocket 재사용, REST baseline + live overlay).
- live candle `@ticker` 즉시 fanout / DB snapshot 저장 분리(throttle 유지).
- 실시간 KRW 환산 일관성(과거 snapshot KRW 재사용 금지).
- exchangeInfo `PRICE_FILTER.tickSize` 기반 `displayPriceDecimals` 도입 및 목록·상세·
  주문 화면 자산 단가 포맷 통일.
- 검증: backend typecheck/build/test(2027 pass), frontend typecheck/test(142 pass 이후 추가),
  `BINANCE_MARKET_DATA_SMOKE=1 pnpm smoke:binance-fixed-universe` PASS(10/10, tickSize 10/10).
- DB migration 없음, 기존 금융 데이터 변경 없음.

### 그 이전 작업

이 문서 도입(2026-07-25) 이전 이력은 `git log`와 `backend/docs/*.md`를 참고한다.
