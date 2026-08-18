# 투자 모드(시즌·일반)와 TradingAccount 계약

이 문서는 시즌모드·일반모드의 확정 규칙(게임규칙서), 계산 규칙과 ERD 방향(계산규칙서), 상태 정의(상태정의서), API 방향(API 명세서), QA 체크리스트(QA 체크리스트)에 대응하는 저장소 기준 문서다. 외부 Word 문서(01~05 v3)를 재생성할 때는 이 문서를 원본으로 삼는다.

## 0. 구현 상태 구분 (반드시 먼저 읽을 것)

**설계 확정(정책으로 고정, 코드 여부와 무관):**

- 시즌모드와 일반모드 규칙, 모드별 자산 완전 분리 원칙
- 일반모드 최초 가상자금 10,000,000 KRW 1회 지급 정책
- 매월/정기 자동 지급을 하지 않는 정책 (grantAnchorDay·nextGrantAt류 개념 전면 폐기)
- 보상형 광고를 통한 추가 가상자금 정책
- 광고 보상금을 투자손익·대표 수익률에서 제외하는 원칙
- 향후 시간가중수익률(TWR) 적용 원칙
- TradingAccount 공통 거래계정 구조

**구현됨:**

- `TradingAccount` DB foundation (enum, 테이블, 제약, 인덱스)
- 기존 `SeasonParticipant` 전건에 대한 season TradingAccount backfill
- 신규 시즌 참가 시 같은 트랜잭션 안에서 TradingAccount 생성·연결
- 배포 경계 `tradingAccountId=null` 참가자의 링크 복구 계층 (§3.5):
  joinSeason 기존 참가자 경로, dev baseline, 운영자 제외, 운영용
  dry-run/apply 복구 스크립트가 공유하는 결정적 계정 ID 복구
- 운영자 참가자 제외 시 같은 트랜잭션에서 TradingAccount `suspended` 동기화 (§4.4)
- `GET /api/v1/trading-accounts` 목록·`GET /api/v1/trading-accounts/:accountId`
  상세 조회 API와 공용 소유권 검증 계층 `TradingAccountAccessService` (§5.2)
- 금융 4개 모델(CashWallet·WalletTransaction·ExchangeTransaction·
  FxExecuteRequest)의 transitional `tradingAccountId` 추가 + migration
  backfill + 신규 writer dual-write (§3.6)
- 금융 scope 운영 복구 `pnpm trading-accounts:repair-financial-scope` (§3.6.3)
- 기존 excluded 참가자의 active 계정 상태 보정(repair-links 확장)과 복구 CLI
  실패 종료 코드 계약 (§3.5)
- account-scoped 금융 조회/환전 API:
  `GET /api/v1/trading-accounts/:accountId/wallets`·`wallet-transactions`,
  `POST .../fx/quote`·`fx/execute`, `GET .../fx/transactions`
  (계약: `docs/trading-account-finance-api-contract.md`)
- Order·Position·Quote의 transitional `tradingAccountId` 전환 + dual-write +
  account-scoped 주문·포지션 API + 거래 scope 복구 스크립트
  `pnpm trading-accounts:repair-trading-scope` (작업 5, 계약:
  `docs/trading-account-orders-api-contract.md`)
- **작업 5 보완 (2026-08-03):**
  - account-scoped 주문 취소의 scope 오류 분류 — 잠금 SQL에서
    `trading_account_id` 조건을 제거하고, 자기 주문의 null/불일치 scope를
    404가 아닌 500 `TRADING_SCOPE_REPAIR_REQUIRED`/
    `TRADING_ACCOUNT_SCOPE_MISMATCH`로 노출 (다른 계정의 정상 주문은 404 유지,
    오류 시 주문 상태·예약금 불변)
  - 시장가 주문 committed replay first — 이미 커밋된 주문은 계정 suspended·
    closed, 시즌 종료, 참가자 제외, 시장 종료 이후에도 저장된 최초
    `responsePayloadJson`을 재생 (신규 주문 gate는 기존 주문이 없을 때만 실행)
  - 원자 지갑 변경 실패 진단 정밀화 — 0행 UPDATE를 wallet id 단독 재조회로
    분류(scope 손상 / 잔액 부족 / 실제 동시성 충돌), debit·credit·reserve·
    settle·release·cleanup·FX source·FX target 전 경로 적용
- **작업 6 (2026-08-03):** 일반모드 계정 생성 API
  `POST /api/v1/trading-accounts/general` + KRW/USD 지갑 + 최초 1,000만 원
  1회 지급(하나의 트랜잭션, partial unique 기반 멱등), account-scoped 금융
  조회의 일반계정 지원, `AdRewardClaim` + provider-neutral 광고 검증
  인터페이스 + 광고 보상 지급/한도/멱등 계층, 읽기 전용 운영 점검
  `pnpm trading-accounts:audit-general`
  (계약: `docs/general-account-and-ad-rewards-api-contract.md`)

- **작업 6 보완 + 작업 7 (2026-08-03):**
  - 광고 claim 명령 멱등성 — `provider`·`proof`·`idempotencyKey` 필수,
    `(tradingAccountId, idempotencyKey)` unique(기존 provider event unique와
    분리 유지), 커밋된 지급은 계정 상태·기능 설정·provider 등록 상태와
    무관하게 최초 결과 replay, 같은 키 다른 요청은 409
    `AD_REWARD_IDEMPOTENCY_CONFLICT`
  - 일반계정 전체 금융 integrity(계정·지갑 2개·최초 지급 원장 전 필드 +
    row scope)를 계정 재호출·지갑/원장 조회·eligibility·claim·성과 경로 전부에
    적용
  - granted/rejected claim replay 전 원장·지갑 1:1 정합성 검증
    (500 `AD_REWARD_CLAIM_INTEGRITY`)
  - EquitySnapshot·DailyPortfolioSnapshot의 TradingAccount 전환(시즌 행
    backfill + 신규 writer dual-write + 일반 행은 participant 없이 계정만)
  - 일반모드 시간가중수익률(TWR), 외부자금 allow-list 집계, 투자손익,
    외부자금 before/after 경계 snapshot(광고 지급 트랜잭션 내 원자 처리)
  - 일반계정 생성 트랜잭션에 최초 성과 기준점 포함(5행 원자)
  - account-scoped `GET .../portfolio`·`GET .../portfolio/equity`
    (`returnRateMethod`로 TWR/초기자본 수익률 구분)
  - 운영 스크립트 `trading-accounts:repair-snapshot-scope`,
    `trading-accounts:backfill-general-performance`, `audit-general` 성과 검사
    확장
  (계약: `docs/general-account-and-ad-rewards-api-contract.md`)

- **작업 6·7 보완 (2026-08-04):**
  - 외부자금 before/after 정렬을 UUID·createdAt에서 분리 — snapshot reason에
    phase rank(before 0 / 일반 1 / after 2)를 부여해 이력 오름차순은 항상
    before → after, 최신 상태 판정은 항상 after 우선. 최신 상태는 최대
    capturedAt 후보만 조회해 결정하며 전체 이력을 메모리에 올리지 않는다.
    스키마 컬럼 추가 없음
  - 외부자금 원장 합계와 최신 성과 snapshot 누적자금의 연속성 불변식 —
    불일치 시 ordinary TWR advance를 중단하고 기존
    `GENERAL_PERFORMANCE_INTEGRITY` 구조화 500 반환(신규 오류코드 없음).
    portfolio/equity 조회, ordinary snapshot 생성, 광고 지급 직전 before
    snapshot, 일반계정 daily job에 적용. 지급 트랜잭션 안에서는 커밋 직전
    after 경계 == 커밋된 원장까지 확인
  - 광고 claim replay 5경로(사전 명령키·경쟁 명령키·provider event·명령키
    P2002·provider event P2002)를 공통 async validator로 통합 — 소유권,
    terminal 상태, keyed 명령 상태, 원장 전 필드, keyed granted claim의
    경계 pair, `responsePayloadJson` 대조를 모든 경로에서 동일하게 수행
  - eligibility가 config·provider·status보다 먼저 일반계정 전체 금융
    integrity를 검사
  - 일반계정 일별 snapshot job(`general-account-daily-snapshot`) — 기존
    BatchService·dry-run·idempotency 구조 재사용, 계정당 1 트랜잭션으로
    scheduled EquitySnapshot + DailyPortfolioSnapshot 원자 생성
  - `audit-general`에 경계 순서·자금 연속성·경계 세부 불변식·일반 daily 행
    오염·closed 계정 daily 행 검사 추가(여전히 read-only, `--apply` 없음)
  (계약: `docs/general-account-and-ad-rewards-api-contract.md`,
   `docs/batch-job-foundation.md`)
- **일반계정 거래 활성화 (2026-08-18):** 기존 account-scoped 주문 API와
  시즌 주문 코어를 `TradingContext`로 일반화했다. 일반계정은 별도 엔진이나
  endpoint 없이 시장가·지정가 매수/매도, durable quote, 예약·취소, 공용
  matcher, 지갑·원장·포지션 반영, 계정 단위 멱등성을 사용한다. `Order`와
  `Position`의 `seasonParticipantId`만 optional로 전환했으며 일반 행은
  `tradingAccountId != null` + `seasonParticipantId = null`이다. 체결 후 일반
  성과는 `order_executed` ordinary TWR snapshot으로 전진하고 시즌 ranking은
  변경하지 않는다. 상세 계약은
  `docs/trading-account-orders-api-contract.md`를 따른다.

**아직 구현되지 않음 (문서만 보고 사용 가능하다고 오해하지 말 것):**

- 일반계정 실제 환전(409 `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED` 유지)
- 광고 SDK, 광고 시청 UI, **실제 광고 네트워크의 provider 전용 서버 검증
  어댑터** (인터페이스와 registry만 존재하며 운영 registry는 비어 있음),
  광고 1회당 지급액·일일 한도·대기시간의 확정값
- ExchangeTransaction·FxExecuteRequest의 `seasonParticipantId` optional 전환
- `tradingAccountId` NOT NULL 강화 (참가자: §3.5.5, 금융 4모델: §3.6.5)
- 시즌 finished/rewarded/settled 전환 시 account `closed` 일괄 동기화,
  suspended 계정 재활성화, 운영자 일반계정 정지 API (§4.4의 잔여 범위)
- 기존 `seasonParticipantId` 컬럼 제거

## 1. 게임규칙 (01 게임규칙서 대응)

### 1.1 공통 모드 구조

로그인한 사용자에게 장기적으로 두 투자 모드를 제공한다.

- **시즌모드** — 기간제 대회형 가상투자 (현재 구현되어 있는 기능)
- **일반모드** — 시즌 없는 무기한 가상투자 (계정·TWR·시장가/지정가 거래 구현,
  FX는 별도 미구현)

두 모드는 하나의 사용자 계정을 공유하지만 **거래계정과 가상자산은 완전히 분리**한다. KRW/USD 지갑, 주문, 미체결 주문, 포지션, 평균단가, 실현/미실현손익, 환전 기록, 지갑 원장, 포트폴리오 스냅샷, 투자손익, 수익률은 모드 간에 공유하지 않는다. 예: 일반모드 KRW 800만 원과 시즌모드 KRW 950만 원은 서로 영향을 주지 않고, 일반모드에서 매수한 종목은 시즌모드 포지션에 나타나지 않는다. 거래계정 간 가상자금·자산 이전은 지원하지 않는다.

### 1.2 게임 흐름 (목표 구조)

1. 회원가입과 로그인
2. 시즌모드 또는 일반모드 선택 *(모드 선택 화면 구현)*
3. 선택한 모드의 독립 거래계정으로 진입
4. 해당 거래계정의 지갑·포지션·주문 사용
5. 시즌모드는 시즌 종료·랭킹·보상 적용
6. 일반모드는 최초 1,000만 원으로 시작
7. 일반모드에는 월별 자동 충전이 없음
8. 추가 가상자금은 향후 보상형 광고를 통해 획득 *(광고 기능 미구현)*
9. 광고 보상금은 투자수익으로 계산하지 않음
10. 두 모드 사이의 자금과 자산은 공유하지 않음

### 1.3 시즌모드 규칙 (기존 기능 유지)

- 시즌별 시작일·종료일이 존재하고, 사용자는 같은 시즌에 한 번만 참가할 수 있다.
- 시즌 참가 시 해당 시즌 전용 거래계정(season TradingAccount)이 생성되고 시즌별 초기자금이 지급된다.
- 시즌별 지갑·주문·포지션·손익이 별도로 존재한다.
- 활성 시즌·유효한 참가 상태일 때만 거래할 수 있고, 시즌 종료 후 새로운 주문·환전은 차단된다.
- 시즌 랭킹, 등급, 정산, 보상은 기존과 동일하게 유지된다.
- 새 시즌에 참가하면 이전 시즌과 다른 거래계정이 생성된다.
- 일반모드 자산은 시즌 시작·종료의 영향을 받지 않는다.

역할 분담: `SeasonParticipant`는 시즌 전용 정보(참가 상태, 참가 시각, 시즌별 초기자금, 순위/최종 순위/최종 등급, 보상·제외·랭킹 숨김·결과 정정·정산 상태)를 담당하고, `TradingAccount`는 두 모드가 공유하는 거래계정 기반이다. 이번 단계에서는 기존 거래 테이블을 TradingAccount 기준으로 전환하지 않았다.

### 1.4 일반모드 기본 규칙

- 시즌 시작일·종료일·참가 절차·랭킹·등급·정산·보상이 없다.
- 사용자당 일반모드 거래계정은 **하나만** 존재한다 (DB partial unique index로 강제).
- 일반모드 거래계정의 자산은 기한 없이 유지되고, 계정이 정지·종료되지 않는 한 계속 투자할 수 있다.
- 새로운 시즌이 시작·종료되어도 일반모드 자산은 유지된다.
- 일반모드 계정은 사용자가 일반모드에 **최초 진입할 때** 생성한다. 구현됨(작업 6): `POST /api/v1/trading-accounts/general`만이 general 계정을 만든다. migration·GET·거래 경로·광고 claim은 절대 계정을 만들지 않는다.

### 1.5 일반모드 최초 가상자금

- 일반모드 최초 거래계정 생성 시 가상자금 **10,000,000 KRW를 한 번** 지급한다.
- 사용자당 일반모드 최초 지급은 한 번만 가능하다. 재접속·앱 재설치 시 재지급하지 않는다.
- 탈퇴 후 재가입 정책은 별도 회원 정책을 따른다.
- **정기 월 지급 없음, 가입일 기준 지급 없음, 매월 자동 지급 없음, 서버 스케줄러에 의한 정기 입금 없음.**
  가입일 기준 매월 지급, 말일 보정, grantAnchorDay, nextGrantAt, 월 지급 예정일, 누락 월 지급 복구, 월 지급 스케줄러, 기존 사용자 소급 지급, 월별 지급 회차 개념은 모두 폐기되었다.
- 기존 사용자도 일반모드 계정을 최초 생성할 때 1,000만 원만 지급받는다. 가입한 지 오래됐더라도 과거 기간에 해당하는 추가 가상자금은 지급하지 않는다.

### 1.6 광고를 통한 추가 가상자금

일반모드에서 최초 1,000만 원 이외의 추가 가상자금을 얻는 기본 수단은 **보상형 광고**다. 사용자가 보상형 광고를 정상적으로 완료하면 정해진 가상자금을 일반모드 거래계정에 지급할 수 있다.

핵심 규칙:

- 광고 보상은 **일반모드에만** 지급한다. 시즌모드에는 지급하지 않는다.
- 광고 보상은 현금이 아닌 앱 내부 가상자금이며, 일반모드 KRW 지갑으로 지급한다.
- 광고 시청은 선택 사항이다. 시청하지 않아도 기존 자산으로 일반모드를 계속 이용할 수 있다.
- 광고 보상금은 **투자수익이 아니라 외부 가상자금 유입**으로 취급하며, 누적 투자손익과 대표 투자수익률에서 제외한다.
- 광고 완료가 확인되지 않으면 보상하지 않는다. 같은 광고 완료 이벤트에 대해 두 번 지급하지 않는다.
- 클라이언트가 직접 지갑 잔액을 증가시킬 수 없다. 광고 보상 지급은 서버가 최종 결정한다.
- 광고 보상 지급과 지갑 원장 기록은 하나의 DB 트랜잭션으로 처리해야 한다.

**구현 상태(작업 6):** 광고 보상 백엔드 기반은 구현되어 있다 — `AdRewardClaim` 모델, provider-neutral 검증 인터페이스/registry, 소유권·general 한정·활성 계정 확인, 동일 provider 이벤트 중복 차단(`UNIQUE(provider, providerEventId)`), 계정 행 `FOR UPDATE` 직렬화, 일일 횟수·금액·cooldown 재검증, KRW 지갑 지급 + `ad_reward` 원장 + claim granted의 단일 트랜잭션, 재시도 멱등성. **실제 광고 제공자는 여전히 미정이며 운영 registry는 비어 있다**(모든 claim이 503 `AD_REWARD_PROVIDER_UNAVAILABLE`). 기능 기본값은 `AD_REWARD_ENABLED=false`이고, 운영 환경에는 fake verifier를 등록하지 않는다. 상세 계약: `docs/general-account-and-ad-rewards-api-contract.md`.

**광고 1회당 지급액은 아직 확정하지 않았다.** 다음 값은 향후 운영 설정값으로 관리한다: 광고 1회당 지급액, 하루 최대 광고 보상 횟수, 광고 보상 간 최소 대기시간, 사용자당 하루 최대 보상금, 광고 제공자, 광고 보상 활성화 여부. 초기 구현에서 거래소급 부정행위 탐지 시스템은 만들지 않되, 향후 광고 구현 시 최소한 서버 검증, 광고 완료 이벤트 고유 ID, 동일 이벤트 중복 지급 차단, 사용자·거래계정 소유권 확인, 일반모드 계정 한정 지급, 일일 한도 확인, 지급·원장 기록의 원자성, 재시도 멱등성을 보장한다. 광고 SDK와 제공자별 서버 검증 방식은 광고 기능 작업에서 결정한다.

### 1.7 일반모드 자금 고갈

- 최초 1,000만 원을 모두 손실해도 계정을 자동 초기화하지 않고, 자동으로 다시 지급하지도 않는다.
- 추가 가상자금은 향후 제공되는 보상형 광고 기능으로만 얻는다. 광고 보상 한도·지급액은 운영 정책으로 제한할 수 있다.
- 파산 계정 자동 초기화, 무료 무제한 재충전, 매월 정기 충전, 원클릭 초기화, 시즌↔일반 자금 이동은 지원하지 않는다.

## 2. 계산규칙·ERD (02 계산규칙서·DB ERD 대응)

### 2.1 일반모드 자금·손익 정의

일반모드에서는 다음 값을 구분한다.

| 항목 | 정의 |
| --- | --- |
| 현재 총자산 | KRW 현금 + USD 현금의 KRW 환산액 + 모든 포지션의 KRW 평가액 |
| 최초 지급금 | 일반모드 계정 생성 시 지급한 10,000,000 KRW |
| 누적 광고 보상금 | 정상 완료된 광고 보상 지급액의 총합 (원장의 완료된 광고 보상 거래 집계로 계산; 컬럼 누적 아님) |
| 누적 외부 가상자금 | 최초 지급금 + 누적 광고 보상금 + 운영자가 명시적으로 외부자금으로 분류한 조정금 |
| 누적 투자손익 | 현재 총자산 − 누적 외부 가상자금 |

광고 보상금은 투자손익으로 취급하지 않는다. `TradingAccount.initialCapitalKrw`는 광고 보상으로 절대 변경하지 않는다.

### 2.2 대표 수익률 원칙 (시간가중수익률 예정)

다음 단순 수익률은 **일반모드 대표 수익률로 사용하지 않는다**:

```
(현재 총자산 − 누적 외부 가상자금) / 누적 외부 가상자금
```

광고 보상금이 들어온 직후, 실제 투자 손실이 없는데도 분모 증가로 수익률이 하락할 수 있기 때문이다. 향후 **광고 보상 지급 직전과 직후를 구간 경계로 분리하는 시간가중수익률(TWR)** 을 구현한다. 필요한 스냅샷 경계: 외부 가상자금 유입(최초 지급, 광고 보상, 운영자 외부자금 조정)이 발생하는 시점마다 유입 직전 평가액과 유입 직후 평가액을 스냅샷으로 남겨 구간을 분할한다.

예시: 외부자금 1,000만 원·총자산 1,100만 원(수익률 +10%)에서 광고 보상 100만 원이 지급되면 외부자금 1,100만 원·총자산 1,200만 원이 되고, 가격 변동이 없으므로 대표 수익률은 계속 +10%다. 광고 보상금 유입 자체로 수익률이 오르거나 내리면 안 된다.

이번 작업에서는 계산 코드를 구현하지 않았고 규칙과 스냅샷 경계만 확정했다.

### 2.3 ERD 방향

**현재(기존):**

```
User → SeasonParticipant → CashWallet / WalletTransaction / Position / Order /
                            ExchangeTransaction / EquitySnapshot /
                            DailyPortfolioSnapshot / SeasonRanking
```

**이번 단계의 transitional 구현:**

```
User → TradingAccount ↔ SeasonParticipant → (기존과 동일하게)
                                           CashWallet / Position / Order / …
Season → SeasonParticipant
```

Wallet·Order·Position 등 모든 거래 테이블은 **여전히 SeasonParticipant를 참조**한다. TradingAccount는 계정 식별 계층으로만 추가되었다.

**전환 목표(향후):**

```
User → TradingAccount → Wallet / Position / Order / Snapshot
Season → SeasonParticipant → TradingAccount
```

### 2.4 일반모드 자금 규칙 요약

- 최초 외부 가상자금: 10,000,000 KRW (1회)
- 정기 자동 지급: 없음
- 추가 외부 가상자금: 향후 보상형 광고
- 광고 보상금: 투자손익·수익률에서 제외, future WalletTransaction으로 원장화
- `TradingAccount.initialCapitalKrw`: 광고 보상으로 변경하지 않음

## 3. TradingAccount DB foundation (이번 작업 구현 내용)

### 3.1 모델

`backend/prisma/schema.prisma`의 `TradingAccount`:

| 필드 | 의미 |
| --- | --- |
| `id` | UUID PK (기존 모델과 동일한 `@default(uuid())` 관례) |
| `userId` | 소유 사용자 FK (`onDelete: Restrict` — 금융 계정 식별 행은 사용자 삭제를 막는다) |
| `mode` | `season` \| `general` |
| `status` | `active` \| `suspended` \| `closed` (기본 `active`) |
| `initialCapitalKrw` | 계정 최초 기준자산, `Decimal(24,8)`, `> 0` CHECK |
| `openedAt` | 계정 시작 시각 (시즌 backfill은 `joinedAt` 복사) |
| `closedAt` | 계정 종료 시각, 확실한 종료 시각이 없으면 `NULL` (`closedAt >= openedAt` CHECK) |
| `createdAt`/`updatedAt` | 프로젝트 공통 관례 |

관계: `User.tradingAccounts TradingAccount[]`, `SeasonParticipant.tradingAccountId String? @unique` (1:1, `onDelete: Restrict`).

월 지급 관련 필드(`grantAnchorDay`, `nextGrantAt`, `monthlyGrantAmount`, `nextMonthlyGrantAt`, `grantCycleNumber`)는 **존재하지 않으며 추가 금지**다. 누적 광고 보상금 컬럼도 두지 않는다(원장 집계로 계산).

### 3.2 제약·인덱스

- `trading_accounts_general_owner_unique`: `CREATE UNIQUE INDEX … ON trading_accounts(user_id) WHERE mode = 'general'` — 사용자당 general 계정 1개 강제, season 계정 다수는 허용. Prisma가 표현하지 못해 raw migration으로 관리한다 (`@@unique([userId, mode])`는 시즌 다계정을 막으므로 사용 금지).
- `trading_accounts_initial_capital_krw_check`: `initial_capital_krw > 0`
- `trading_accounts_closed_after_opened_check`: `closed_at IS NULL OR closed_at >= opened_at`
- 인덱스: `(user_id, mode)`, `(mode, status)`, `season_participants(trading_account_id)` unique

### 3.3 Backfill (migration `20260801120000_add_trading_account_foundation`)

모든 기존 SeasonParticipant마다 정확히 하나의 season TradingAccount를 생성하고 `tradingAccountId`를 연결했다.

- `userId`·`initialCapitalKrw` 복사, `openedAt = joinedAt`, `closedAt = NULL`, `mode = season`
- status 매핑: `registered`→`active`, `active`→`active`, `excluded`→`suspended`, `finished`→`closed`, `rewarded`→`closed`
- 계정 id는 참가자 id에서 결정적으로 유도(`md5('trading-account:season-participant:' || id)::uuid`, PostgreSQL 내장 함수만 사용, extension 추가 없음)하고 `trading_account_id IS NULL` 가드로 멱등하게 실행된다.
- 기존 SeasonParticipant의 id/seasonId/userId, 초기자금, 총자산, 수익률, 순위, 등급, 제외 상태, 지갑 잔액·원장, 주문, 포지션, 환전, 스냅샷, 보상, 거래 테이블의 `seasonParticipantId`는 **일절 변경하지 않는다**. 이 backfill은 데이터 이동이 아니라 공통 거래계정 식별자 추가다.
- **이 migration은 general TradingAccount, 일반모드 지갑, 일반모드 initial grant, 광고 관련 데이터를 일절 생성하지 않는다.** 적용 후 general 계정 0개가 정상이다.

`tradingAccountId`는 배포 호환성을 위해 이번 단계에서 nullable로 유지한다. backfill 후 null 행 0개를 검증했고, 모든 신규 참가 경로는 반드시 값을 채운다. **후속 작업에서 NOT NULL로 강화할 예정**이다(schema comment에도 기록).

### 3.4 신규 시즌 참가 트랜잭션

`SeasonsService.joinSeason`은 하나의 DB 트랜잭션에서 다음 순서로 처리한다.

1. 시즌 존재·참가 가능(assertSeasonJoinable)·사용자 활성 검증
2. 기존 참가자 조회 — 존재하면 `409 SEASON_ALREADY_JOINED` (중복 지갑·원장·계정이 생기지 않는 멱등 차단; 기존 응답 계약 유지)
3. **season TradingAccount 생성** (mode=season, status=active, openedAt=joinedAt)
4. SeasonParticipant 생성 + `tradingAccountId` 연결
5. KRW/USD CashWallet 생성 (기존과 동일)
6. `initial_grant` WalletTransaction 생성 (기존과 동일)
7. season_join EquitySnapshot 생성 (기존과 동일)
8. 전체 commit — 중간 실패 시 TradingAccount·SeasonParticipant·CashWallet·WalletTransaction 모두 rollback

동시 참가 race는 `@@unique([seasonId, userId])`의 P2002를 409로 매핑해 처리하며, 패배한 트랜잭션의 TradingAccount도 함께 rollback된다. 참가 응답 계약(`seasonParticipantId`, `seasonId`, `joinedAt`, `wallets`)은 변경하지 않았다(프런트가 tradingAccountId를 사용하지 않으므로 추가하지 않음).

개발 baseline(`prisma/seed.ts`·`dev:open-season`·`dev:recover-local-data`가 공유하는 `scripts/lib/dev-baseline.ts`)도 동일하게 계정(`ta_dev_001`)을 참가자와 원자적으로 생성한다. 통합 테스트 fixture들도 실제 TradingAccount 행을 생성해 연결한다.

### 3.5 배포 경계 null link 복구 (deploy-boundary repair)

**문제.** `trading_account_id`는 배포 호환성을 위해 아직 nullable이다. migration은 적용 시점에 존재한 참가자만 backfill하므로, migration 적용 후 아직 구버전 서버가 돌고 있는 배포 경계에서 구버전 writer가 `tradingAccountId=null` 참가자를 만들 수 있다. 이 참가자는 재참가 요청이 기존 409로 즉시 차단되기 때문에 방치하면 영구히 계정 없이 남는다.

**복구 규칙 (단일 구현: `src/seasons/season-trading-account-link.ts`).**

- 계정 ID는 migration backfill과 **동일한 결정적 유도**를 쓴다:
  `md5('trading-account:season-participant:' || participantId)::uuid` 와
  바이트 단위로 같은 값을 Node `crypto` md5로 생성한다
  (`deriveSeasonTradingAccountId`). md5는 보안 용도가 아니라 결정적 식별자
  유도 전용이며, 토큰·인증에 절대 사용하지 않는다. 같은 participantId는 항상
  같은 accountId가 되므로 동시 복구가 orphan 계정을 만들 수 없다.
- 복구 데이터 매핑은 backfill과 동일: `userId`·`initialCapitalKrw` 복사
  (totalAssetKrw는 사용하지 않음), `openedAt=joinedAt`, `closedAt=null`,
  status는 §4.3 표의 ParticipantStatus 매핑.
- 전체 복구는 호출자의 DB 트랜잭션 안에서 수행하고, 계정 insert는 raw
  `INSERT ... ON CONFLICT ("id") DO NOTHING`, 링크는
  `updateMany(where: { id, tradingAccountId: null })` 가드로 처리해 동시 복구
  race에서도 계정 하나·링크 하나만 남는다.
- **ON CONFLICT 후 재조회 검증(2026-08-03 보완):** 최초 조회와 INSERT 사이에
  다른 트랜잭션이 같은 결정적 ID로 *다른 내용*의 계정을 삽입할 수 있으므로,
  INSERT 후 반드시 저장된 계정을 다시 조회해
  id/userId/mode/initialCapitalKrw/openedAt/타 참가자 연결 여부를 검증한 뒤에만
  참가자를 연결한다. 재조회 실패·불일치는 `TRADING_ACCOUNT_LINK_INTEGRITY`로
  중단하며, 검증되지 않은 계정이 링크되는 일은 없다(실제 PostgreSQL race
  interleaving 테스트로 검증). status는 재조회 검증 대상이 아니다 — 동시 상태
  변화가 정상 존재할 수 있고, participant 상태 대비 더 강한 종료 상태(closed
  등)를 임의로 되돌리거나 하향/상향 변경하지 않는다.
- 지갑·원장·주문·포지션·환전·스냅샷은 **절대 수정하지 않는다**. initial grant
  재지급·스냅샷 재생성 없음.
- 다음 불일치는 조용히 덮어쓰지 않고
  `SeasonTradingAccountLinkIntegrityError`(코드
  `TRADING_ACCOUNT_LINK_INTEGRITY`)로 fail-closed 한다: 계정 userId ≠ 참가자
  userId, mode ≠ season, 결정적 계정의 initialCapitalKrw/openedAt 불일치, 계정이
  이미 다른 참가자에 연결됨, 참가자가 이미 다른 계정에 연결됨.

**복구 경로 4곳 (모두 같은 구현 공유).**

1. `joinSeason` 기존 참가자 경로 — 기존 참가자의 `tradingAccountId`가 null이면
   같은 트랜잭션에서 링크만 복구한 뒤, **기존 API 계약 그대로 409
   `SEASON_ALREADY_JOINED`를 반환**한다(복구는 commit되고 409는 commit 후
   던진다). 복구 실패는 409로 감추지 않고 500 `TRADING_ACCOUNT_LINK_INTEGRITY`
   구조화 오류로 전달한다.
2. 운영자 참가자 제외 — 제외 트랜잭션 안에서 먼저 링크를 복구한 뒤 suspended
   동기화를 계속한다 (§4.4).
3. dev baseline (`ensureDevBaselineParticipant`) — 기존 dev 참가자의 링크가
   null이면 apply에서 링크만 복구하고 notes에 기록한다. dry-run은 복구 예정만
   보고한다. 지갑·잔액·원장은 불변, replay 시 추가 계정 없음.
4. 운영용 스크립트 `pnpm trading-accounts:repair-links`
   (`scripts/repair-missing-trading-account-links.ts`) — **기본 dry-run**,
   실제 수정은 `--apply` 명시 필수. 참가자별 독립 트랜잭션이라 일부 실패가
   나머지 복구를 막지 않으며, 여러 번 실행해도 결과가 같다.
   DROP/TRUNCATE/DELETE/reset 없음, general 계정 생성 없음.
   2026-08-03 확장으로 이 스크립트는 두 종류의 정합성을 함께 점검한다:
   ① null link 복구, ② **excluded 참가자 + active season 계정 상태 보정**
   (제외→suspended 동기화 배포 전에 이미 제외된 참가자는 재호출이 409라 계정이
   active로 남는다; 대상 = excluded + mode=season + status=active + userId
   일치. active→suspended만 guarded update로 수행하고 suspended/closed/general/
   userId 불일치(fail-closed 보고)는 절대 변경하지 않으며, 지갑·예약금·원장·
   주문·포지션·환전·스냅샷·제외 사유/시각·순위·보상도 불변). 이미 excluded인
   참가자에 대한 제외 API 재호출은 기존 계약대로 409를 유지하고 자동 보정하지
   않는다 — 기존 데이터 보정은 이 스크립트가 담당한다.
   **종료 코드 계약:** `--apply`는 ⓐ 참가자별 실패 ≥1, ⓑ apply 후 null link
   잔여 ≥1, ⓒ excluded-active 불일치 잔여 ≥1, ⓓ 최종 검증 쿼리 실패/미조회 중
   하나라도 해당하면 exit 1로 종료하고 원인(구버전 writer 실행 중, 복구 중 신규
   null 생성, 데이터 불일치 등)과 재실행 안내를 출력한다. dry-run은 분석이
   정상 완료되면 0으로 종료하되 수정 필요 사실을 명시한다(정합성 실패가
   발견되면 dry-run도 1). **NOT NULL migration은 이 명령이 exit 0 + 잔여 0건으로
   끝난 후에만 가능하다.**

**NOT NULL 강화 전제조건 (별도 작업).** ① 모든 production writer가 값을 기록,
② 복구 스크립트 apply 완료, ③ `trading_account_id IS NULL` 0건 확인, ④ 구버전
인스턴스 완전 종료, ⑤ 배포 순서 확정 — 이 다섯 가지가 모두 확인된 후에만
NOT NULL migration을 진행한다.

### 3.6 금융 4개 모델의 TradingAccount 전환 (작업 4, 2026-08-03 구현)

**대상 모델:** `CashWallet`, `WalletTransaction`, `ExchangeTransaction`,
`FxExecuteRequest`. Order·Position·Quote는 작업 5(§3.7)에서 전환되었고,
EquitySnapshot·DailyPortfolioSnapshot·SeasonRanking은 여전히 미전환이다.

#### 3.6.1 transitional dual identity

네 모델 모두 기존 `seasonParticipantId`(필수)를 유지한 채 nullable
`tradingAccountId` + `TradingAccount?` 관계(onDelete: **Restrict** — 금융
기록이 계정 삭제를 막는다; Cascade 금지)를 추가했다. 추가 제약:

- `CashWallet` `@@unique([tradingAccountId, currencyCode])` — 계정당 통화별
  지갑 1개 (PostgreSQL unique의 NULL-distinct 의미로 legacy null 행 다수 허용)
- `FxExecuteRequest` `@@unique([tradingAccountId, idempotencyKey])` — 계정
  기준 멱등성. 기존 `@@unique([userId, idempotencyKey])`는 작업 10(참가자 id
  제거) 전까지 유지되므로, **같은 사용자**가 다른 계정에서 같은 키를 재사용하는
  것은 전환 기간 동안 여전히 legacy unique에 막힌다(서로 다른 사용자는 가능).
- 조회 인덱스: `wallet_transactions(trading_account_id, occurred_at)`,
  `exchange_transactions(trading_account_id, executed_at)`,
  `fx_execute_requests(trading_account_id, requested_at)`,
  `cash_wallets(trading_account_id)`
- `WalletTransaction`은 wallet 관계를 따라가지 않고 **자체적으로**
  tradingAccountId를 보유한다(계정별 원장 감사·집계·향후 수익률 계산용).
- TradingAccount에 역관계 4개(cashWallets/walletTransactions/
  exchangeTransactions/fxExecuteRequests)만 추가했고, 누적 잔액·수익률류 캐시
  컬럼은 추가 금지 그대로다(원천은 항상 지갑·원장·거래 데이터).

#### 3.6.2 migration backfill (`20260803120000_add_financial_trading_account_scope`)

additive migration이 각 금융 행의 tradingAccountId를 연결된
`SeasonParticipant.tradingAccountId`에서 복사한다(4개 UPDATE, 양쪽 IS NULL
가드로 멱등). 참가자 링크가 null이면 금융 행도 null로 남기며 **migration이
계정을 만들거나 애플리케이션 복구를 재구현하지 않는다**. 기존 행 수·금액·
잔액·예약금·수수료·상태·idempotency key·ID는 일절 변경되지 않는다(전후
fingerprint와 opt-in PostgreSQL 테스트로 검증).

#### 3.6.3 금융 scope 운영 복구 스크립트

`pnpm trading-accounts:repair-financial-scope`
(`scripts/repair-financial-trading-account-scope.ts`) — migration 이후 구버전
writer가 만든 null scope 금융 행의 backfill 전용. 기본 dry-run, `--apply`
명시 필수, unknown 옵션·`--apply --dry-run` 동시 사용 거부, 500행 배치·
IS NULL 가드 update만 수행(금액 필드 불변), 멱등.

- 참가자 링크가 null인 행은 수정하지 않고
  `MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK`로 보고한다 — 먼저
  `trading-accounts:repair-links --apply`가 필요하다고 안내.
- 이미 값이 있는 행이 참가자 링크와 다르면 **절대 덮어쓰지 않고**
  `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`로 보고한다. wallet과
  wallet_transaction의 scope 불일치도 검사한다.
- `--apply` 종료 코드: 금융 4모델 null 잔여, scope mismatch 잔여, 행별 실패,
  검증 쿼리 실패 중 하나라도 있으면 exit 1.

#### 3.6.4 신규 writer dual-write

신규 애플리케이션이 생성하는 모든 금융 행은 seasonParticipantId와
tradingAccountId를 **함께** 기록한다(두 값은 같은 참가자·계정을 가리켜야 함).

- 시즌 참가: KRW/USD 지갑 + initial_grant 원장 (join 트랜잭션에서 생성한 계정 id)
- dev baseline: 동일 (`ta_dev_001`)
- 환전 실행: FxExecuteRequest·ExchangeTransaction·출금/입금 WalletTransaction
  전부 같은 계정 id, 기존과 동일한 하나의 트랜잭션(중간 실패 시 전체 rollback)
- 시장가 매수/매도 원장, 지정가 체결 원장: 주문의 참가자 링크에서 계정 id를
  읽어 기록 (Order/Position 모델 자체는 미변경)
- **fail-closed:** 참가자 링크가 null이면 금융 쓰기를 중단하고
  `TRADING_ACCOUNT_LINK_INTEGRITY`(500)를 반환한다 — 복구가 필요한 상태를 새
  금융 행으로 확산시키지 않는다. 조용한 null 기록 금지.
- 정산(settlement)·운영자 조정(adjustment) 원장 writer는 아직 존재하지
  않는다(enum만 존재). 구현되는 시점에 dual-write 규칙을 따라야 한다.

일관성 계약(신규 쓰기 전부): `row.seasonParticipantId → participant.tradingAccountId
== row.tradingAccountId`, `walletTransaction.tradingAccountId ==
wallet.tradingAccountId`. DB trigger는 사용하지 않으며 additive
FK/unique + dual-write + resolver + backfill + 복구 스크립트 + PostgreSQL
정합성 테스트 + read-only 검증 쿼리의 조합으로 보장한다.

#### 3.6.5 NOT NULL 보류와 배포 순서

새 금융 tradingAccountId 컬럼은 nullable을 유지한다(구버전 writer/rolling
deployment 호환, backfill·dual-write 검증·주문/포지션 전환 잔여). NOT NULL
검토 전제조건: ① 모든 production writer가 기록, ② repair-links 성공(exit 0),
③ repair-financial-scope 성공(exit 0), ④ 참가자 null link 0, ⑤ 금융 4모델
null 0, ⑥ scope mismatch 0, ⑦ 구버전 완전 종료, ⑧ 배포 순서 확정, ⑨ 운영 DB
read-only 검증 완료. `seasonParticipantId` 제거는 작업 10 이전에 하지 않는다.

**권장 배포 순서:** ① 백업·migration 검토 → ② additive migration 적용 →
③ 신버전 배포 → ④ 구버전 완전 종료 → ⑤ repair-links dry-run → ⑥ repair-links
--apply → ⑦ 참가자 null 0·excluded-active 0 확인 → ⑧ repair-financial-scope
dry-run → ⑨ repair-financial-scope --apply → ⑩ 금융 null 0·mismatch 0 확인 →
⑪ 신규 account-scoped API smoke → ⑫ 기존 wallet/fx API smoke → ⑬ NOT NULL은
후속 작업으로 보류. **구버전 writer가 실행 중인 상태에서 복구 성공을 선언하지
않는다.** (작업 5 이후의 통합 배포 순서는 §3.7.9가 대체한다.)

### 3.7 Order·Position·Quote의 TradingAccount 전환 (작업 5, 2026-08-03 구현)

**대상 모델:** `Order`, `Position`, `Quote`(주문 quote와 FX quote 공용).
EquitySnapshot·DailyPortfolioSnapshot·SeasonRanking·SeasonReward·
RewardFulfillmentRequest·LimitOrderCandleEvidence(Order 관계로 사용,
중복 계정 FK 금지)·AssetPriceSnapshot·FxRateSnapshot은 변경하지 않았다.
제거 작업이 아니라 transitional dual identity 전환이다: SeasonParticipant는
계속 시즌 상태·랭킹·보상·정산을 담당하고, TradingAccount가 거래 데이터의
자산 격리 기준이 된다.

#### 3.7.1 transitional dual identity (schema)

세 모델 모두 기존 `seasonParticipantId`를 유지한 채 nullable
`tradingAccountId` + `TradingAccount?` 관계(onDelete: **Restrict** — 거래
기록이 계정 삭제를 막는다)를 추가했다. 추가 제약/인덱스:

- `Order` `@@unique([tradingAccountId, idempotencyKey])`(계정 기준 생성
  멱등성; 같은 사용자라도 계정이 다르면 같은 키 재사용 가능. NULL 계정·NULL
  키 행은 unique의 NULL-distinct 의미로 허용, idempotencyKey nullable 의미
  불변) + `(tradingAccountId, submittedAt)`·`(tradingAccountId, status)`
  인덱스. 기존 `@@unique([seasonParticipantId, idempotencyKey])` 유지.
- `Position` `@@unique([tradingAccountId, assetId])` — 한 거래계정은 같은
  자산에 집계 포지션 1개. 기존 `@@unique([seasonParticipantId, assetId])`
  유지. `(tradingAccountId)` 인덱스.
- `Quote` `(tradingAccountId, createdAt)`·`(tradingAccountId, status,
  expiresAt)` 인덱스. 신규 unique 없음(quote는 status/consume로 단일 사용을
  보장한다).
- TradingAccount 역관계 3개(orders/positions/quotes) 추가. 캐시 컬럼
  (totalAssetKrw·positionValue·orderCount·currentBalance·realizedPnl 등)은
  금지 그대로다.

#### 3.7.2 FX 멱등성 unique 재구성 (보완 3)

기존 전역 `UNIQUE(user_id, idempotency_key)`(인덱스
`fx_execute_requests_user_id_idempotency_key_key`)는 같은 사용자가 서로 다른
계정에서 같은 키를 쓰는 것을 막았다. 이번 migration이 이를 **legacy null 행만
보호하는 partial unique**로 교체했다:

```
UNIQUE (user_id, idempotency_key) WHERE trading_account_id IS NULL
-- fx_execute_requests_user_id_idempotency_key_legacy_null_key
```

Prisma DSL은 partial unique를 표현하지 못하므로 schema.prisma에는 나타나지
않고(모델 주석 + migration SQL + schema 계약 테스트가 근거), 계정 unique
`(tradingAccountId, idempotencyKey)`는 유지된다. 교체 순서는 partial 생성 →
전역 unique DROP이라 어느 시점에도 무보호 행이 없고, null-scope 중복이
존재하면 migration이 임의 삭제·병합 없이 RAISE EXCEPTION으로 fail-closed
한다. 서비스 조회는 계정 우선(`tradingAccountId+key`) → 없으면 legacy 행
fallback(`userId+seasonParticipantId+key+tradingAccountId IS NULL` — 다른
참가자·다른 시즌의 null 행은 절대 replay하지 않음)이며, legacy endpoint의
신규 쓰기도 참가자의 계정을 해석해 계정 기준으로 생성한다. unique 충돌 후
재조회도 같은 규칙을 쓴다(전역 per-user 재조회 금지).

#### 3.7.3 migration backfill (`20260803150000_add_trading_scope_and_fx_legacy_partial_unique`)

additive migration이 orders/positions/quotes의 tradingAccountId를 연결된
`SeasonParticipant.tradingAccountId`에서 복사한다(양쪽 IS NULL 가드, 멱등).
참가자 링크가 null인 행과 participant가 없는 quote 행은 null로 남기며
migration이 계정을 만들지 않는다. 주문 상태·수량·가격·수수료·예약금, 포지션
수량·평균단가·실현손익, quote 상태·hash·금액·만료·소비 시각, ID는 일절
변경되지 않는다(전후 fingerprint + opt-in PostgreSQL 테스트로 검증). 파괴적
구문은 FX 전역 unique 인덱스 DROP 1건뿐이다.

#### 3.7.4 지갑 scope fail-closed (보완 1)

지갑을 변경하거나 지갑 잔액을 근거로 주문·환전 quote를 만들기 전에 항상
`wallet.seasonParticipantId == 참가자` + `wallet.tradingAccountId == 검증된
계정`을 확인한다(`assertCashWalletTradingAccountScope`,
`src/wallets/cash-wallet-scope.ts`).

- `wallet.tradingAccountId IS NULL` → **500
  `FINANCIAL_SCOPE_REPAIR_REQUIRED`** (메시지에
  trading-accounts:repair-financial-scope 실행 필요 명시). 거래 도중 자동
  backfill 금지.
- 참가자·계정 불일치 → **500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`**.
  덮어쓰기·자동 수정 금지. 400류 클라이언트 오류로 다루지 않는다(서버 정합성
  문제).
- 적용 경로(전부): FX quote 잔액 확인·FX execute source/target, 시장가 매수
  quote·debit, 시장가 매도 credit, 지정가 quote available 확인·생성 예약·자동
  체결 settle·취소/만료/운영자 제외 cleanup의 예약 반환.
- 동시성: 사전 검증에 더해 `cash-wallet-atomic.ts`의 모든 원자적 UPDATE
  WHERE에 `trading_account_id = 검증된 계정`이 포함된다(id·participant·
  currency·잔액/예약 조건과 함께). 검증과 update 사이에 scope가 바뀌면 0행
  매칭으로 fail-closed 된다.

#### 3.7.5 account-scoped 조회의 조용한 누락 방지 (보완 2)

account-scoped 지갑·원장·환전 조회는 반환 전에 시즌 참가자의 금융 4모델에서
`tradingAccountId IS NULL` 또는 계정 불일치 행(원장은 연결 wallet의 scope
불일치 포함)을 존재 여부 쿼리(findFirst, 인덱스 사용)로 검사하고, 하나라도
있으면 빈/부분 결과 대신 500(`FINANCIAL_SCOPE_REPAIR_REQUIRED` /
`FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`)으로 fail-closed 한다
(`src/trading-accounts/trading-account-financial-integrity.ts`). 같은
원칙으로 account-scoped 주문 조회는 참가자의 Order 이상 행을, 포지션 조회는
Position 이상 행을 검사한다(null → `FINANCIAL_SCOPE_REPAIR_REQUIRED`,
mismatch → `TRADING_ACCOUNT_SCOPE_MISMATCH`). general 계정은 참가자가 없어
검사가 스킵되고 정상적으로 빈 결과를 반환하며, GET이 계정·지갑·포지션을
생성하거나 1,000만 원을 지급하는 일은 없다.

#### 3.7.6 신규 writer dual-write와 Quote 계정 격리

모든 신규 Order·Position·Quote writer는 seasonParticipantId와
tradingAccountId를 함께 기록한다. 참가자 링크가 null이면 신규 쓰기를
`TRADING_ACCOUNT_LINK_INTEGRITY`(500)로 중단한다(quote 포함 — quote는 자산을
직접 바꾸지 않지만 실행 권한을 제공하므로 같은 격리가 필요).

- 시장가/지정가 Order 생성, idempotent replay, 지정가 체결의 Position
  생성/증가, 시장가 매수/매도 Position 생성/증가/감소, 주문·FX quote 생성,
  테스트 fixture·통합 러너·dev baseline 전부 dual-write.
- 기존 Position update 시 `position.tradingAccountId == 현재 계정`을
  검증한다(null → 500 `TRADING_SCOPE_REPAIR_REQUIRED`, mismatch → 500
  `TRADING_ACCOUNT_SCOPE_MISMATCH`; 자동 복구하며 진행 금지). 시장가 매도의
  Position 감소·지정가 체결의 updateMany WHERE에도 tradingAccountId가
  포함되어 다른 계정 포지션 수량을 감소시킬 수 없다.
- Quote 검증(주문 create/execute, FX execute): persisted
  `quote.tradingAccountId`가 non-null이면 실행 계정과 일치해야 하며(불일치 →
  `QUOTE_MISMATCH`), null legacy quote만 기존 참가자+requestHash 검증 경로로
  통과한다. quote 소비 updateMany WHERE는 `id + status=active +
  seasonParticipantId + (계정 일치 OR null)`이라 다른 계정 quote의 상태를
  바꿀 수 없다. requestHash 계산식은 교체하지 않았다(전면 재작성 금지;
  계정 격리는 저장된 tradingAccountId 검증으로 완성).
- Order 멱등성: 계정 우선 조회(`tradingAccountId+key`) → legacy null 행
  fallback(`seasonParticipantId+key+계정 null+user 소유권`). 같은 계정 같은
  키는 requestHash가 같으면 저장된 최초 응답 replay, 다르면
  `ORDER_IDEMPOTENCY_CONFLICT`. 같은 사용자의 다른 계정 간 키 재사용 허용.

#### 3.7.7 trading scope 운영 복구 스크립트

`pnpm trading-accounts:repair-trading-scope`(`scripts/repair-trading-scope.ts`,
로직 `scripts/lib/repair-trading-scope.ts`) — migration 이후 구버전 writer가
만든 null scope Order·Position·Quote의 backfill 전용. 역할 구분:
repair-links(참가자↔계정 link·excluded-active) → repair-financial-scope(금융
4모델) → **repair-trading-scope(Order·Position·Quote)**.

- 기본 dry-run, `--apply` 명시 필수, unknown 옵션·플래그 동시 사용 거부,
  500행 배치 cursor 순회, IS NULL 가드 update만(금액·수량·상태 불변), 멱등.
- 참가자 링크 null 행은 `MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK`로 보고만
  (repair-links 먼저). non-null mismatch는 `TRADING_ACCOUNT_SCOPE_MISMATCH`로
  보고만(덮어쓰기 금지). Order↔연결 Quote의 계정/참가자 불일치는
  `ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH`. participant 없는 quote는 계정을
  추측하지 않고 `QUOTE_PARTICIPANT_SCOPE_MISSING`으로 보고한다(주문·환전용
  데이터이므로 정합성 실패로 취급). backfill 실패는
  `TRADING_SCOPE_BACKFILL_FAILED`.
- `--apply` 종료 코드: Order/Position/participant-linked Quote의 null 잔여,
  scope mismatch 잔여, order-quote 불일치, 행별 실패, 검증 실패 중 하나라도
  있으면 exit 1.

#### 3.7.8 account-scoped 주문·포지션 API와 지정가 자동 체결 gate

`docs/trading-account-orders-api-contract.md`가 계약 원문이다. 요약:

- `GET/POST /api/v1/trading-accounts/:accountId/orders[...]`,
  `GET /api/v1/trading-accounts/:accountId/positions`. 조회는
  active/suspended/closed 모두 허용(소유자), 미존재·타인 계정은 동일 404,
  다른 계정 orderId도 동일 404. 신규 quote/주문은 계정 소유권 +
  TradingAccount.status=active(아니면 409 `TRADING_ACCOUNT_NOT_ACTIVE`) +
  공통 시장/가격/지갑/잔액 정책을 요구한다. season은 기존 시즌·참가자 조건을
  추가로 모두 요구하고, general은 season/participant를 조회하거나 요구하지
  않으며 일반 금융 foundation을 검증한다. account-scoped execute endpoint는
  만들지 않았다(legacy에도 없음 — 시장가는 create 내부 실행, 지정가는 공용
  스케줄러 체결).
- 취소는 보호 동작이므로 legacy와 동일하게 계정/참가자 status로 gate하지
  않는다(소유자는 suspended/closed 계정의 submitted 지정가도 취소 가능).
  단 order/wallet scope가 null·불일치면 자동 추정 없이 repair-required로
  중단하고 주문 상태·예약금 변경이 함께 rollback 된다.
- 지정가 자동 체결(스케줄러)은 체결 트랜잭션 안에서 locked row 기준으로
  `order.tradingAccountId` 존재·mode별 participant 규칙·연결 quote scope·
  wallet/position scope 일치를 재검증한다. season은 기존 season/participant
  거래 가능 조건을 유지하고 general은 active 계정과 일반 금융 foundation만
  요구한다. 계정이
  suspended/closed면 **체결하지 않고 skip**(`account_not_active`; 주문은
  submitted 유지, 기존 정책대로 자동 취소하지 않음). scope 손상은 구조화된
  500으로 fail-closed(다음 사이클 재시도가 운영 신호).
- legacy 주문·포지션 API는 계약 그대로 유지되며 account-scoped와 같은
  서비스 코어를 공유한다(수수료·체결가·환율·지갑/원장/포지션 변화·멱등성·
  rollback 동일 — DB 통합 테스트로 실측).

#### 3.7.9 NOT NULL 보류와 통합 배포 순서

Order·Position·Quote의 tradingAccountId도 nullable을 유지한다(§3.6.5와 같은
전제 + 스냅샷 3모델 미전환). 통합 배포 순서:

① 최신 main·DB 백업 확인 → ② additive migration 검토 → ③ migration 적용 →
④ 신버전 배포 → ⑤ 구버전 완전 종료 → ⑥ repair-links dry-run → ⑦
repair-links --apply → ⑧ 참가자 null link·excluded-active 0 확인 → ⑨
repair-financial-scope dry-run → ⑩ --apply → ⑪ 금융 null·mismatch 0 확인 →
⑫ repair-trading-scope dry-run → ⑬ --apply → ⑭ Order·Position·Quote
null·mismatch 0 확인 → ⑮ account-scoped wallet·FX smoke → ⑯ account-scoped
order·position smoke → ⑰ 기존 wallet·FX·order·position API smoke → ⑱ NOT
NULL은 후속 작업으로 보류. **구버전 writer가 실행 중인 상태에서 복구 성공을
선언하지 않는다.**

## 4. 상태정의 (04 상태정의서 대응)

### 4.1 TradingAccountMode

- `season` — 특정 시즌 참가자에 1:1로 연결되는 시즌 전용 거래계정. 시즌마다 별도 계정. 시즌 랭킹·정산·보상 대상.
- `general` — 시즌에 연결되지 않는 일반모드 거래계정. 사용자당 최대 하나. 종료 기한 없음. 시즌 랭킹·정산·보상 대상 아님.

### 4.2 TradingAccountStatus

- `active` — 공통 거래계정이 활성 상태. **시즌계정은 이것만으로 거래가 허용되지 않으며** `Season.status`·시즌 기간·`ParticipantStatus`·제외 상태·기존 주문/환전 정책을 함께 확인한다(기존 거래 가능 판정 로직은 그대로 유지되고 TradingAccount.status 중심으로 재작성하지 않았다).
- `suspended` — 운영 또는 시즌 제외 사유 등으로 사용 정지. 자동으로 자산을 삭제하거나 청산하지 않는다.
- `closed` — 거래계정 종료. 기록 조회는 유지하고, 새로운 자산 변경은 차단될 예정.

### 4.3 ParticipantStatus → TradingAccountStatus backfill 매핑

| ParticipantStatus | TradingAccountStatus |
| --- | --- |
| registered | active |
| active | active |
| excluded | suspended |
| finished | closed |
| rewarded | closed |

기존 `SeasonStatus`·`ParticipantStatus`는 삭제·대체하지 않는다. `WalletTransactionType.ad_reward`와 `WalletTransactionReferenceType.general_account_open`·`ad_reward_claim`, 그리고 `AdRewardClaimStatus`는 작업 6에서 추가했다(§6).

### 4.4 참가자 제외 ↔ TradingAccount 상태 동기화 (구현됨)

운영자가 시즌 참가자를 제외하면 **같은 DB 트랜잭션** 안에서 두 상태를 함께 바꾼다.

- `SeasonParticipant.participantStatus = excluded` (기존 excludedAt/Reason/By,
  `currentRank=null`, 제출 상태 지정가 매수 취소·예약금 반환, 감사 로그 유지)
- 연결된 season `TradingAccount.status = suspended`

규칙:

- `tradingAccountId`가 null인 legacy 참가자는 같은 트랜잭션에서 먼저 §3.5
  규칙으로 링크를 복구한 뒤 suspended로 바꾼다.
- 이미 `suspended`면 idempotent하게 유지한다.
- `closed` 계정은 **절대 suspended로 되돌리지 않는다** (finished/rewarded
  참가자 제외 시 계정은 closed 그대로).
- 계정 userId ≠ 참가자 userId 또는 mode ≠ season이면 임의 수정 없이 500
  `TRADING_ACCOUNT_LINK_INTEGRITY`로 fail-closed 한다.
- 어느 한쪽 update나 지정가 취소가 실패하면 참가자 제외·계정 상태 변경이 함께
  rollback된다.
- 감사 로그 metadata에 `tradingAccountId`, `beforeTradingAccountStatus`,
  `afterTradingAccountStatus`, `tradingAccountLinkRepaired`를 추가했다
  (전체 account 객체·민감정보는 기록하지 않음).

**기존 데이터 보정(2026-08-03):** 이 동기화 배포 이전에 제외된 참가자의
excluded+active 불일치는 `pnpm trading-accounts:repair-links`가 점검·보정한다
(§3.5). 제외 API 재호출 시 자동 보정은 넣지 않았다(409 계약 유지).

**이번 범위에서 구현하지 않은 상태 동기화 (시즌 lifecycle 격리 작업에서 별도
처리):** 시즌 settled 시 account 일괄 closed, rewarded/finished 전환 시 closed
동기화, suspended 계정 재활성화, 운영자 일반계정 정지 API.

## 5. API 방향 (03 API 명세서 대응)

### 5.1 기존 API (변경 없음)

- `GET /api/v1/seasons`, `GET /api/v1/seasons/current`
- `POST /api/v1/seasons/:seasonId/join` — 응답 계약 불변. 내부적으로 season TradingAccount가 함께 생성되지만 응답에 `tradingAccountId`는 노출하지 않는다. 기존 참가자 재요청은 (필요 시 §3.5 링크 복구 후) 여전히 409다.
- 기존 wallets / orders / positions / portfolio / fx / records API — 전부 seasonParticipant 기준 그대로.

### 5.2 거래계정 조회 API (구현됨)

상세 계약: `docs/trading-accounts-api-contract.md`. 요약:

- `GET /api/v1/trading-accounts` — 로그인 사용자가 소유한 **실존** 계정 목록.
  general 계정이 아직 없으면 season 계정만 반환하며, 가상의 placeholder를
  만들지 않는다. 정렬은 `openedAt desc → createdAt desc → id asc`로 결정적.
- `GET /api/v1/trading-accounts/:accountId` — 소유 계정 상세.
- 존재하지 않는 accountId와 **다른 사용자 소유 accountId는 동일한 404**
  `TRADING_ACCOUNT_NOT_FOUND`로 응답한다(소유권을 조회 WHERE에 포함; 타인
  계정의 존재 여부를 403으로 노출하지 않음).
- `TradingAccount.status`는 조회 허용 여부가 아니라 자산 변경 가능 여부다.
  소유자는 active/suspended/closed 계정을 모두 조회할 수 있다.
- 응답에 지갑 잔액·포지션·주문·환전·평가·수익률·순위·광고 정보는 넣지 않는다
  (아직 seasonParticipant 기준이며 accountId 전환 후 후속 작업에서 제공).
- 소유권 검증은 `TradingAccountAccessService`(`listOwnedAccounts`,
  `getOwnedAccountOrThrow`)가 담당하며, 향후 wallet/order/position/portfolio
  API가 이 계층을 재사용한다. season 계정에 participant가 없거나 userId가
  다르거나 general 계정에 participant가 붙어 있으면 404로 감추지 않고 500
  `TRADING_ACCOUNT_INTEGRITY`로 fail-closed 한다.

**account-scoped 금융 API (작업 4에서 추가):** 소유 계정 하위의
`GET .../wallets`·`GET .../wallet-transactions`(조회, active/suspended/closed
모두 허용), `POST .../fx/quote`·`POST .../fx/execute`(시즌계정 + account
active + 기존 시즌/참가자 정책을 모두 통과해야 하며 suspended/closed는 409
`TRADING_ACCOUNT_NOT_ACTIVE`, general 계정은 409
`GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`), `GET .../fx/transactions`(조회).
legacy `/api/v1/wallets`·`/api/v1/fx/*`는 계약 그대로 유지되고 두 경로는 같은
서비스 계산 규칙을 공유한다. 상세:
`docs/trading-account-finance-api-contract.md`.

**account-scoped 주문·포지션 API (작업 5에서 추가):** 소유 계정 하위의
`GET .../orders`·`GET .../orders/:orderId`(조회, active/suspended/closed 모두
허용, 다른 계정 orderId는 동일 404), `POST .../orders/quote`·
`POST .../orders`(active season/general 계정 + 공통 시장/가격/지갑 정책;
season은 기존 시즌/참가자 gate, general은 일반 금융 foundation gate),
`POST .../orders/:orderId/cancel`(보호 동작 — 계정 status로 gate하지 않음),
`GET .../positions`(조회). account-scoped execute endpoint는 legacy에도
없으므로 만들지 않았다. legacy `/api/v1/orders`·`/api/v1/positions`는 계약
그대로 유지되고 같은 서비스 코어를 공유한다. 상세:
`docs/trading-account-orders-api-contract.md`.

**서버는 "현재 선택 계정"을 저장하지 않는다.** JWT·세션·User 테이블·전역
singleton 어디에도 currentTradingAccountId/currentMode를 두지 않는다. 계정
선택은 프런트 UI 상태이고, 거래 API는 요청 경로
(`/api/v1/trading-accounts/:accountId/...`)로 accountId를 전달하며 서버는
요청마다 소유권을 다시 검증한다.

### 5.3 일반계정·광고 API (작업 6에서 추가, 구현됨)

- `POST /api/v1/trading-accounts/general` — 일반계정 최초 생성 + KRW/USD
  지갑 + 최초 1,000만 원 1회 지급. body 없음, 항상 200, `data.created`로
  최초 생성/재요청 구분. 재요청·동시 요청·네트워크 재시도에서 계정 1개,
  통화별 지갑 1개, initial grant 1건만 존재한다.
- `GET /api/v1/trading-accounts/:accountId/ad-rewards/eligibility` — 안내용
  조회(지급하지 않음).
- `POST /api/v1/trading-accounts/:accountId/ad-rewards/claim` — 검증된 광고
  완료 이벤트에 대한 KRW 지급.
- `GET /api/v1/trading-accounts/:accountId/ad-rewards/claims` — 소유 계정의
  claim 이력. 시즌계정은 세 경로 모두 409
  `AD_REWARD_GENERAL_ACCOUNT_ONLY`(시즌계정에는 광고 이력이 존재하지 않는다).

상세 계약: `docs/general-account-and-ad-rewards-api-contract.md`.

### 5.4 향후 예정 (미구현)

- accountId 기반 portfolio API (EquitySnapshot·DailyPortfolioSnapshot·
  SeasonRanking의 accountId 전환 포함)
- 프런트엔드 accountId 연결·로그인 후 모드 선택 화면·광고 시청 화면
- 실제 광고 네트워크 provider adapter (provider 확정 후 `AdRewardVerifier`
  구현체를 `AdRewardsModule`에 등록하는 additive 변경)

## 6. 일반계정·광고 보상 데이터 구조 (작업 6에서 구현됨)

migration: `20260803180000_add_general_account_and_ad_reward_enums`(enum 전용,
PostgreSQL이 같은 트랜잭션에서 새 enum 값을 사용할 수 없어 분리) +
`20260803181000_add_general_account_and_ad_reward_foundation`.

**CashWallet·WalletTransaction:** `seasonParticipantId`를 `String?`로 완화
(`DROP NOT NULL`)하고 관계도 optional. 일반계정에는 SeasonParticipant가
없으므로 일반 지갑·원장은 `seasonParticipantId = null`,
`tradingAccountId = general account id`다. **기존 시즌 행의
`seasonParticipantId`는 변경하지 않는다.** Order·Position·
ExchangeTransaction·FxExecuteRequest는 일반 주문·환전이 아직 비활성이므로
이번 작업에서 변경하지 않았다.

**enum 추가:** `WalletTransactionType.ad_reward`,
`WalletTransactionReferenceType.general_account_open`·`ad_reward_claim`,
`AdRewardClaimStatus(pending|verified|granted|rejected|failed)`.
기존 `initial_grant`·`season_join` 의미는 변경하지 않았다.

- 일반계정 최초 지급 원장: `txType=initial_grant`,
  `referenceType=general_account_open`, `referenceId=general account id`
- 광고 보상 원장: `txType=ad_reward`,
  `referenceType=ad_reward_claim`, `referenceId=AdRewardClaim.id`

**partial unique (Prisma DSL로 표현 불가 → migration SQL + schema 주석 +
schema contract 테스트로 관리):** `wallet_transactions` 전체에
`unique(referenceType, referenceId)`는 **추가할 수 없다** — 하나의 order·
exchange reference에 여러 원장 행이 정상적으로 존재하기 때문이다. 대신
1행짜리 reference 두 종류만 부분 인덱스로 강제한다.

- `wallet_transactions_general_account_open_reference_unique`:
  `UNIQUE (reference_id) WHERE reference_type = 'general_account_open'`
- `wallet_transactions_ad_reward_claim_reference_unique`:
  `UNIQUE (reference_id) WHERE reference_type = 'ad_reward_claim'`

**AdRewardClaim:** `id`, `userId`, `tradingAccountId`, `provider`,
`providerEventId`, `status`, `rewardAmountKrw(24,8)`,
`verificationFingerprint?`, `verificationMetadataJson?`, `requestedAt`,
`verifiedAt?`, `grantedAt?`, `rejectedAt?`, `failedAt?`, `failureCode?`,
`failureReason?`, `walletTransactionId? @unique`, `createdAt`, `updatedAt`.
관계 3종 모두 `onDelete: Restrict`(감사 기록이 사용자·계정·원장 삭제를
막는다). 제약: `@@unique([provider, providerEventId])`,
`@@index([tradingAccountId, grantedAt])`, `@@index([userId, grantedAt])`,
`@@index([status, createdAt])`.

핵심 규칙:

- `(provider, providerEventId)` unique — 동일 광고 이벤트 중복 지급 금지
- 일반모드(`mode=general`) TradingAccount에만 지급, KRW 지갑만 증액
- `providerEventId`는 클라이언트 문자열이 아니라 **등록된 서버 verifier가
  반환한 값**만 저장한다
- `verificationFingerprint`는 proof 원문이 아닌 SHA-256 단방향 fingerprint다.
  광고 토큰·서명 비밀·raw callback·민감 식별자는 저장하지 않으며,
  `verificationMetadataJson`에는 어댑터가 허용한 비민감 최소 정보만 담는다
- 지갑 증액 + `ad_reward` 원장 + claim granted는 하나의 트랜잭션
- 클라이언트가 rewardAmount·providerEventId·userId·tradingAccountId·
  grantedAt·balanceAfter·일일 카운트·cooldown을 결정하지 않는다
- 누적 광고 보상금은 granted claim 또는 `ad_reward` 원장의 집계로 계산한다
  (TradingAccount에 `cumulativeAdReward`류 누적 컬럼 금지)
- **migration은 general 계정·지갑·지급·claim을 일절 생성하지 않는다.**
  적용 후에도 general 계정 수는 적용 전과 동일해야 한다(현재 모든 환경에서 0).

migration 전후 fingerprint(§8 배포 절차와 동일): TradingAccount 총수·mode별
수, CashWallet 총수·participant null 수·통화별 balance/reserved 합계,
WalletTransaction 총수·participant null 수·txType별 amount 합계·
referenceType별 건수, 기존 ID와 seasonParticipantId, general 계정 수,
AdRewardClaim 수.

## 7. QA 체크리스트 (05 QA 체크리스트 대응)

이 섹션은 세 가지를 구분한다: ① 재사용 가능한 **영구 체크리스트**(체크박스는
항상 `[ ]`로 유지하고, 실행할 때마다 아래 실행 결과 표에 기록한다),
② **커밋별 실행 결과 표**(그 커밋에서 실제 실행한 것만 PASS/FAIL, 실행하지
않았으면 NOT_RUN), ③ 향후 기능의 **NOT_IMPLEMENTED 초안**(7.4). 실행하지 않은
항목을 PASS나 `[x]`로 표시하지 않는다.

### 7.1 TradingAccount foundation 영구 체크리스트

- [ ] 기존 SeasonParticipant 수 = backfill된 season TradingAccount 수
- [ ] 모든 기존 SeasonParticipant.tradingAccountId가 유효한 FK (null 0건, dangling 0건)
- [ ] 하나의 SeasonParticipant에 하나의 TradingAccount만 연결 (공유 0건)
- [ ] TradingAccount.initialCapitalKrw = 기존 SeasonParticipant.initialCapitalKrw
- [ ] TradingAccount.openedAt = SeasonParticipant.joinedAt
- [ ] ParticipantStatus별 status 매핑 정확 (4.3 표)
- [ ] 기존 지갑 잔액·원장 행 수와 금액·주문·포지션·환전 행 수와 값 변화 없음
- [ ] 사용자당 general 계정 partial unique 동작 (두 번째 general 거부)
- [ ] 같은 사용자의 여러 season 계정 허용
- [ ] 시즌 참가 신규 생성 시 TradingAccount 동시 생성, replay 시 중복 없음
- [ ] 지갑/원장 생성 실패 시 TradingAccount까지 rollback
- [ ] 일반계정이 migration에서 자동 생성되지 않음 (general 0건)
- [ ] 광고 보상 데이터가 이번 migration에서 생성되지 않음
- [ ] 월 지급 필드가 TradingAccount에 존재하지 않음
- [ ] 기존 시즌 참가 응답·프런트 흐름 회귀 없음

자동화: `src/seasons/trading-account-schema.spec.ts`(schema·migration 계약, 기본 `pnpm test`에 포함), `src/seasons/trading-account.integration.spec.ts`(`TRADING_ACCOUNT_DB_INTEGRATION=1`로 opt-in, 실제 PostgreSQL에서 backfill SQL·partial unique·CHECK·트랜잭션 rollback·race 검증).

### 7.2 null link 복구·제외 동기화·계정 API 영구 체크리스트

- [ ] 같은 participantId는 항상 같은 결정적 accountId (Postgres `md5(...)::uuid` cast와 바이트 일치)
- [ ] null link 복구가 계정만 생성·연결하고 지갑·원장·주문·포지션·스냅샷 불변
- [ ] 복구 status 매핑이 §4.3 표와 일치 (registered/active→active, excluded→suspended, finished/rewarded→closed)
- [ ] 복구 replay·동시 복구에서 계정 하나, orphan 없음
- [ ] userId/mode/initialCapitalKrw/openedAt 불일치·타 참가자 연결 시 fail-closed (덮어쓰기 없음)
- [ ] joinSeason 기존 참가자: 링크 복구 후에도 409 계약 유지, 복구 실패는 409로 은폐하지 않음
- [ ] dev baseline: null link만 복구, dry-run은 무변경, replay 시 추가 계정 없음
- [ ] 복구 스크립트: 기본 dry-run, --apply 명시 필요, apply 후 null 0건 재검증, 재실행 멱등
- [ ] 참가자 제외 시 account active→suspended, 이미 suspended면 idempotent, closed는 되돌리지 않음
- [ ] 제외·계정 상태 변경·지정가 취소가 한 트랜잭션 (어느 하나 실패 시 전체 rollback)
- [ ] 감사 로그에 tradingAccountId·before/after account status 기록
- [ ] 계정 목록: 인증 필수, 소유 계정만, season 정보 포함, general은 season=null, placeholder 미생성
- [ ] 계정 상세: 타인·미존재 accountId 동일 404, suspended/closed 조회 허용
- [ ] season↔participant relation 구조 위반 시 500 TRADING_ACCOUNT_INTEGRITY
- [ ] 기존 seasons/wallets/fx/orders/portfolio/records API 응답 계약 불변

금융 scope·account-scoped 금융 API (2026-08-03 추가):

- [ ] ON CONFLICT 후 저장 계정 재조회·검증 후에만 링크 (불일치·미존재 fail-closed, race에서도 미검증 계정 연결 없음)
- [ ] excluded+active 불일치를 dry-run이 탐지하고 apply가 active→suspended만 보정 (suspended/closed/general/userId 불일치 불변)
- [ ] repair-links --apply: 실패·null 잔여·excluded-active 잔여·검증 실패 시 exit 1, 수렴 시 exit 0
- [ ] 금융 4모델에 nullable tradingAccountId + Restrict FK + 계정 unique/인덱스 존재, Order/Position schema 불변
- [ ] migration backfill: 참가자 링크 복사, null 링크는 null 유지, 행 수·금액·ID·idempotency key 불변, 재실행 멱등, general 계정 0
- [ ] repair-financial-scope: 기본 dry-run, null만 backfill, missing-link 보고 후 불변, mismatch 덮어쓰기 금지, apply 후 null·mismatch 0 검증, 잔여 시 exit 1, 멱등
- [ ] 신규 writer dual-write: join 지갑/grant·환전 요청/거래/원장·시장가/지정가 원장 전부 participant accountId 기록, 링크 null이면 fail-closed
- [ ] account-scoped wallets/ledger 조회: 소유권 404 통일, suspended/closed 조회 허용, GET이 지갑·계정 미생성, legacy와 값 일치
- [ ] account-scoped FX: 시즌 정책 + account active 요구, suspended/closed 409, general 409, 소유권 404, source/target wallet 동일 계정 검증
- [ ] 계정 기준 idempotency: 같은 계정 replay 동일 응답, 다른 사용자 계정은 같은 키 사용 가능, 환전 트랜잭션 원자성 유지
- [ ] legacy wallet/fx API 계약 불변, legacy와 account-scoped 계산 결과 동일

자동화: `src/seasons/season-trading-account-link.spec.ts`,
`src/seasons/seasons.service.spec.ts`,
`src/operator/operator-season-moderation.service.spec.ts`,
`src/trading-accounts/trading-accounts.service.spec.ts`,
`scripts/lib/dev-baseline.spec.ts`,
`scripts/lib/repair-trading-account-links.spec.ts`(이상 기본 `pnpm test`),
`scripts/lib/repair-financial-trading-account-scope.spec.ts`,
`src/wallets/trading-account-wallets.spec.ts`,
`src/fx/fx-trading-account-scope.spec.ts`,
`src/fx/fx.service.spec.ts`·`src/orders/orders.service.spec.ts`(dual-write
단언 포함, 이상 기본 `pnpm test`),
`src/seasons/trading-account-link.integration.spec.ts`·
`src/seasons/trading-account-financial-scope.integration.spec.ts`
(`TRADING_ACCOUNT_DB_INTEGRATION=1` opt-in, 실제 PostgreSQL), e2e
`test/app.e2e-spec.ts`의 trading-accounts 9건.

### 7.3 커밋별 실행 결과

**2026-08-01 (커밋 39aee655, TradingAccount DB foundation):** HANDOVER 기록 기준
7.1 전 항목 실행 완료(unit 2,139 pass + opt-in DB 통합 + 검증 쿼리 0건). 단,
2026-08-03 검증에서 `seasons.join.integration.spec.ts`(opt-in
`SEASON_JOIN_DB_INTEGRATION=1`)의 cleanup이 joinSeason이 생성하는
TradingAccount를 지우지 않아 해당 커밋 상태에서는 FK 오류로 실패함을
확인했다(이번 작업에서 cleanup 수정).

**2026-08-03 (이번 작업, 로컬 실행 — hosted CI 없음):**

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| prisma format / validate / generate | PASS | schema 변경 없음, client 재생성 |
| typecheck / build | PASS | `pnpm typecheck`, `pnpm build` |
| unit + script spec (`pnpm test`) | PASS | 2,189 pass (신규 +50) |
| 7.1 opt-in DB 통합 (`TRADING_ACCOUNT_DB_INTEGRATION=1`) | PASS | 로컬 PostgreSQL 16 |
| 7.2 opt-in DB 통합 (`trading-account-link.integration.spec.ts`) | PASS | 결정적 ID Postgres 대조·복구·race·rollback·404 등 12 케이스 |
| 시즌 참가 / FX / 시장가·지정가 주문 DB 통합 (opt-in 5종) | PASS | `--runInBand` 직렬 실행 |
| e2e (`pnpm test:e2e`) | 109/112 PASS | 실패 3건(readiness/wallets/orders-cancel)은 **BASELINE_FAIL** — `.env.local` env 기인으로 기준 커밋에서 동일 재현 |
| 운영 복구 시나리오 A (스크립트 dry-run→apply→재실행) | PASS | 격리 dev DB, 금융 데이터 불변 확인 |
| 운영 복구 시나리오 B (join 재요청 409+복구) / C (제외 시 복구+suspended) | PASS | 7.2 DB 통합 케이스로 실행 |

**2026-08-03 2차 (작업 4 + 보완 3종, 로컬 실행 — hosted CI 없음):**

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| prisma format / validate / generate | PASS | 신규 migration 포함 |
| typecheck / build | PASS | `pnpm typecheck`, `pnpm build` |
| unit + script spec (`pnpm test`) | PASS | 2,231 pass (신규 +42) |
| migration backfill·비파괴 (dev DB fingerprint 전후) | PASS | 행 수·금액 합계·ID 불변, legacy null 유지 |
| opt-in DB 통합 12종 직렬 (`--runInBand`) | PASS | link/financial-scope/join/FX/시장가/지정가 5종/MVP flow 포함 |
| 신규 financial-scope DB 통합 8케이스 | PASS | backfill·dual-write·repair·equivalence·idempotency·gating·excluded-active·ON CONFLICT race |
| e2e (`pnpm test:e2e`, `JWT_ACCESS_SECRET=test-secret`) | 115/118 PASS | 신규 6건 포함. 실패 3건(readiness/wallets/orders-cancel)은 **BASELINE_FAIL** — 기준 커밋 a0bedb77에서 동일 재현되는 env 기인 실패 |
| 운영 CLI 시나리오 (repair-links dry→apply→재실행, financial-scope 순서 포함) | PASS | 격리 dev DB, exit 0, null·mismatch 0, 지갑 잔액 불변 |

**2026-08-03 3차 (작업 5 + 보완 3종, 로컬 실행 — hosted CI 없음):**

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| prisma format / validate / generate | PASS | 신규 migration(`…150000_add_trading_scope_and_fx_legacy_partial_unique`) 포함; `migrate diff`(DB↔schema) 차이 없음 |
| typecheck / build | PASS | `pnpm typecheck`, `pnpm build` |
| unit + script spec (`pnpm test`) | PASS | 2,243 pass (Order/Position/Quote scope·FX partial unique·probe 계약 반영) |
| migration 적용·비파괴 (dev DB fingerprint 전후) | PASS | `migrate deploy` 1건 적용, 주문·포지션·quote·FX 값 해시 불변 |
| opt-in DB 통합 14종 직렬 (`--runInBand`) | PASS | 기존 12종 + 신규 `trading-account-trading-scope` + 기존 러너 fixture dual-write 갱신 |
| 신규 trading-scope DB 통합 6블록 | PASS | 인덱스/partial unique·insert-level unique 의미·repair 스크립트·지정가 생성/취소/체결 scope fail-closed·account 조회 동등성/404/probe·FX 동일 사용자 계정 간 키 재사용+legacy replay 고정 |
| e2e (`pnpm test:e2e`, `JWT_ACCESS_SECRET=test-secret`) | 115/118 PASS | 실패 3건(readiness/wallets/orders-cancel)은 **BASELINE_FAIL** — 기준 커밋 e91921aa에서 git stash로 동일 재현 확인(env 기인) |
| 운영 CLI 시나리오 (repair-trading-scope dry→apply→verify→재실행) | PASS | dev DB에 old-writer null scope 3행 심기 → dry-run 보고(변경 없음) → apply(3행 backfill, 잔여 0/0, exit 0) → 값 불변 확인 → 재실행 멱등 exit 0 |
| §20 완료 기준 검증 쿼리 | PASS | null·mismatch·order-quote 불일치·계정별 idempotency/position 중복·legacy partial 위반·orphan/general 계정 전부 0 |

**2026-08-03 (작업 5 보완 3종 + 작업 6, 로컬 실행 — hosted CI 없음):**

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| prisma format / validate / generate | PASS | 신규 migration 2건 포함 |
| typecheck / build | PASS | `pnpm typecheck`, `pnpm build` |
| unit + script spec (`pnpm test`) | PASS | 2,315 pass (신규 +72: 광고 config, 지갑 실패 진단, 취소 scope 분류, general/ad schema contract) |
| migration 적용·비파괴 (dev DB fingerprint 전후) | PASS | 시즌 데이터(계정 3, 지갑 6, 원장 15) 심은 뒤 `migrate deploy`; 통화별 balance/reserved 합계·txType별 amount·referenceType별 건수·전체 ID·seasonParticipantId 모두 동일. 유일한 차이는 빈 `ad_reward_claims` 테이블 |
| opt-in DB 통합 16종 직렬 (`--runInBand`) | PASS | 기존 14종 + 신규 `general-account`·`order-replay-and-cancel-scope` |
| 신규 general-account DB 통합 | PASS | 최초 생성 원자성·재호출 멱등·동시 생성 1건 수렴·지갑/원장 생성 실패 rollback·손상 계정 fail-closed·suspended/closed 미복구·partial unique·account-scoped 조회·season link 오염 fail-closed |
| 신규 ad-reward DB 통합 | PASS | disabled/provider 미등록 차단·검증 실패 무기록·지급 원자성·중복 이벤트 replay·타 계정 재사용 409·동시 동일 이벤트 1회 지급·일일 count/amount race·cooldown·rejected 영구성·시즌계정/타인 차단·응답 비밀 미노출 |
| 신규 market replay + cancel scope DB 통합 | PASS | responsePayloadJson 원자 저장, suspended/closed/ended/excluded/자산 비활성 이후 replay 및 금융 상태 불변, 다른 hash 409, 신규 주문 gate 유지, 취소 scope 6분기 + 지갑 scope 2종 fail-closed(상태·예약금 불변) |
| e2e (`pnpm test:e2e`, `JWT_ACCESS_SECRET=test-secret`) | 119/122 PASS | 신규 4건 추가 통과. 실패 3건(readiness/wallets/orders-cancel)은 **BASELINE_FAIL** — 기준 커밋 c08ddc70에서 git stash로 동일 명령·환경 재현 확인 |
| `pnpm trading-accounts:audit-general` | PASS | dev DB findings 0, exit 0 |
| 실제 광고 provider 연동 | **PROVIDER_NOT_CONFIGURED** | provider 미확정, 운영 registry 비어 있음. backend 검증은 테스트 전용 fake verifier 기반이며 실제 provider end-to-end 검증이 아니다 |

**2026-08-04 (작업 6·7 보완, 로컬 실행 — hosted CI는 이번 커밋 미실행):**

기준 커밋 `d2713a9d` / 완료 커밋은 이 문서와 같은 커밋.

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| prisma format / validate / generate | PASS | schema 변경 없음(`git diff prisma/` 빈 결과), client 재생성 |
| typecheck (`tsc --noEmit -p tsconfig.build.json`) | PASS | 오류 0 |
| build (`nest build`) | PASS | exit 0 |
| lint (`eslint --no-fix "{src,apps,libs,test}/**/*.ts"`) | BASELINE_FAIL | 944 error. 기준 커밋 936 error 대비 +8이며 전부 신규 spec 3종의 `jest.mock` 헤더에 대한 `no-unsafe-assignment`(기존 모든 spec과 동일 패턴). 저장소는 HEAD에서도 lint clean이 아니다 |
| unit + script spec (`pnpm test`) | PASS | 178 suite / 2,413 pass, 35 skipped(opt-in DB). 신규 +30 (경계 정렬 12, claim 정합성 16 중 신규 16, daily job 9, 성과 서비스 10 — 합산 후 총계 기준 +30) |
| opt-in DB 통합 15종 직렬 (`--runInBand`) | PASS | 최종 실행 15/15 PASS(기존 14종 + 신규 `general-performance-hardening`). 도중 1회 `limit-order-transaction-time`이 Prisma interactive transaction 5,000ms 초과로 실패했으나, 변경을 stash한 기준 커밋에서 1회차 PASS / 2회차 동일 실패, 변경 적용 상태에서 1·2회차 PASS / 3회차 동일 실패로 재현되는 **환경 기인 flaky**이며 본 작업과 무관하다. 별도로 `trading-account-financial-scope` 1회 실패는 운영 CLI 검증용으로 심어둔 일반계정 3건이 남아 있어 해당 suite의 전역 "general 계정 0" 단언을 건드린 것으로, 시드 정리 후 재실행에서 해소됐다(코드 회귀 아님) |
| 신규 `general-performance-hardening` DB 통합 | PASS | 경계 UUID 양방향 정렬·연속성 5종·replay 16종·eligibility 6종·daily job 8종(동시 실행, 롤백, 시즌 행 불변 포함) |
| e2e (`pnpm test:e2e`, `JWT_ACCESS_SECRET=test-secret`) | 119/122 PASS | 실패 3건(readiness/wallets/orders-cancel)은 **BASELINE_FAIL** — 기준 커밋 d2713a9d에서 `git stash`로 동일 명령·환경 재현, 실패 목록 완전 동일 |
| `pnpm trading-accounts:audit-general` | PASS | dev DB findings 0, exit 0. 신규 검사 동작 확인: after 행 누적자금을 훼손하면 `GENERAL_PERFORMANCE_EXTERNAL_FUNDING_MISMATCH`·`EXTERNAL_FUNDING_PAIR_TOTAL_ASSET_MISMATCH` 포함 4건 검출, 복구 후 0건 |
| `trading-accounts:repair-snapshot-scope` dry-run | PASS | null·mismatch 0, exit 0, 무변경 |
| `trading-accounts:backfill-general-performance` dry-run | PASS | general 3계정 전부 already initialized, skipped 0, exit 0 |
| 일반 daily snapshot job dry-run | PASS | total 2 / wouldCreate 2 / excludedClosed 1 / integrityFailed 0 / valuationFailed 0, daily·scheduled equity 행 0건 유지 |
| 일반 daily snapshot job 실제 실행 | PASS | created 2(active·suspended), closed 계정 daily 0·scheduled equity 0, daily 행의 `seasonParticipantId` null·TWR 0%·누적자금·투자손익·factor 정상. 재실행 시 existing 2 / created 0 |
| 실제 광고 provider 연동 | **PROVIDER_NOT_CONFIGURED** | provider 미확정, 운영 registry 비어 있음. 모든 검증은 테스트 전용 fake verifier 기반이며 실제 provider end-to-end 검증이 아니다 |
| hosted CI (`.github/workflows/ci.yml`) | NOT_RUN (이번 커밋) / BASELINE_FAIL (기준 커밋) | workflow는 존재하며 `push`(main)·PR에서 동작한다. 이번 커밋은 push 자격증명이 없어 hosted 실행 결과가 없다(NOT_RUN). 기준 커밋 `d2713a9d`의 hosted run(id 30803274726)은 **failure**: `Backend quality → Candle-layer lint (check only, no fix)`, `Limit order PostgreSQL integration → Verify no schema drift against the deployed database`. 두 실패는 로컬에서 그대로 재현되며 이번 변경과 무관하다 — candle lint는 변경 전후 모두 15 error로 동일(`scripts/lib/repair-trading-scope.ts` 등), schema drift는 작업 7 migration이 만든 `equity_snapshots` 인덱스 3개의 **이름**이 schema.prisma에서 파생되는 이름과 달라 `migrate diff --exit-code`가 2를 반환하는 것으로, 컬럼·제약 자체의 차이는 없고 이번 작업은 schema를 변경하지 않았다. `Candle fixture integration`·`Frontend quality`는 기준 커밋에서 success. 위 표의 나머지 결과는 전부 로컬 실행이며 CI 결과가 아니다 |
| CI에서 신규 DB 통합 suite 실행 여부 | NOT_RUN | `limit-order-db-integration` job은 `TRADING_ACCOUNT_DB_INTEGRATION`을 설정하지 않으므로 기존 `general-account`와 마찬가지로 신규 `general-performance-hardening` suite도 hosted CI에서는 skip된다. 로컬 opt-in 실행 결과만 존재한다 |

### 7.4 일반계정·광고 영구 체크리스트 (작업 6에서 구현됨)

일반계정 provisioning:

- [ ] 인증 없이 `POST /trading-accounts/general` 호출 시 401, 계정·지갑·원장 미생성
- [ ] 최초 호출에서 general/active/1,000만 원 계정 + KRW 1,000만 + USD 0 지갑 + initial grant 1건
- [ ] SeasonParticipant 미생성, 두 지갑 모두 `seasonParticipantId = null`
- [ ] 원장 `referenceType=general_account_open`, `referenceId=account id`, amount=balanceAfter=1,000만
- [ ] 중간 단계(지갑/원장) 실패 시 계정까지 전체 rollback
- [ ] 재호출 시 `created=false`, 계정·지갑·원장 수 불변
- [ ] 동시 호출에서도 계정 1개, 통화별 지갑 1개, initial grant 1건
- [ ] suspended·closed general 계정 재활성화·재생성·재지급 없음
- [ ] 손상 계정(지갑 누락 등)은 500 `GENERAL_ACCOUNT_INTEGRITY`, 자동 재충전 없음
- [ ] general_account_open partial unique가 두 번째 grant 행을 거부
- [ ] account-scoped wallets/wallet-transactions가 일반계정 데이터를 반환하고 GET이 아무것도 생성하지 않음
- [ ] 일반 금융 행에 seasonParticipantId가 섞이면 500 `GENERAL_ACCOUNT_INTEGRITY`

광고 보상:

- [ ] `AD_REWARD_ENABLED=false`(기본값)에서 claim 503 `AD_REWARD_DISABLED`
- [ ] enabled=true인데 필수 설정 누락 시 부팅 실패
- [ ] provider adapter 미등록 시 503 `AD_REWARD_PROVIDER_UNAVAILABLE`
- [ ] 검증 실패 시 claim·지갑·원장 변화 없음 (422)
- [ ] 지급 성공 시 KRW 지갑만 증액, USD·reservedAmount·initialCapitalKrw 불변
- [ ] claim granted ↔ `ad_reward` 원장 1:1, amount 일치, balanceAfter 정확
- [ ] 동일 이벤트 재요청은 replay(지갑·원장 불변), 다른 계정/사용자는 409 `AD_REWARD_EVENT_ALREADY_USED`
- [ ] 동시 동일 이벤트에서 claim 1건·원장 1건·지급 1회
- [ ] 일일 횟수/금액 경계 동시 요청에서도 한도 초과 지급 없음
- [ ] cooldown 미경과 시 429, 경과 후 새 이벤트 지급 가능
- [ ] 한도·cooldown에 걸린 검증 완료 이벤트는 rejected claim으로 기록되고 이후에도 지급되지 않음
- [ ] rejected claim에 walletTransactionId 없음
- [ ] 시즌계정은 eligibility/claim/claims 전부 409 `AD_REWARD_GENERAL_ACCOUNT_ONLY`
- [ ] 타인 계정은 404 `TRADING_ACCOUNT_NOT_FOUND`
- [ ] suspended·closed 계정은 조회 가능·지급 불가(409 `TRADING_ACCOUNT_NOT_ACTIVE`)
- [ ] claim 응답에 providerEventId·verificationFingerprint·metadata 미노출
- [ ] 일일 경계가 서버 로컬 timezone이 아닌 `AD_REWARD_DAY_TIME_ZONE`을 따름
- [ ] 광고 보상금이 `ad_reward` 원장으로 구분 가능하고 투자손익이 아님

### 7.5 성과 경계·replay·일반 daily snapshot 영구 체크리스트 (작업 6·7 보완)

외부자금 before/after 정렬:

- [ ] before UUID > after UUID인 경우와 after UUID > before UUID인 경우 모두
      최신 상태가 after로 선택됨
- [ ] 두 경우 모두 이력이 before → after 순으로 반환됨
- [ ] 두 경우 모두 다음 TWR 계산이 정상 진행되고 `GENERAL_PERFORMANCE_INTEGRITY`가
      잘못 발생하지 않음
- [ ] before와 after가 같은 capturedAt뿐 아니라 같은 createdAt을 가져도 안전
- [ ] 일반 snapshot끼리의 기존 시간순 정렬은 변하지 않음
- [ ] 최신 상태 판정이 전체 이력을 메모리에 올리지 않음(최대 capturedAt 후보만)

외부자금 연속성:

- [ ] 원장 합계는 증가했는데 after snapshot이 없으면 portfolio가 성공 envelope가
      아니라 500 `GENERAL_PERFORMANCE_INTEGRITY`
- [ ] before만 있는 상태·after만 있는 상태 모두 fail-closed
- [ ] keyed granted claim의 경계 amount/account/factor/PnL/after 총자산 불일치가
      각각 검출됨
- [ ] 정상 경계 pair는 통과
- [ ] 과거 unkeyed claim + 검증된 `performance_baseline` 계정은 정상 동작하고
      과거 경계를 임의 생성하지 않음

광고 claim replay:

- [ ] 같은 idempotencyKey 정상 재시도 → duplicate=true, walletBalanceAfter non-null
- [ ] 같은 idempotencyKey + 다른 requestHash → 409 `AD_REWARD_IDEMPOTENCY_CONFLICT`
- [ ] 같은 providerEventId + 다른 idempotencyKey → duplicate=true
- [ ] account idempotency unique 동시 경쟁·provider event unique 동시 경쟁 모두
      지급 1회, 원장 1행, 경계 pair 1쌍
- [ ] granted claim의 원장 누락/금액 불일치/다른 account 연결/USD 지갑 연결/
      referenceId 불일치/경계 pair 누락 → 성공 replay 없음
- [ ] rejected claim에 원장이 잘못 연결되면 성공 replay 없음
- [ ] pending·verified·failed claim은 성공 replay되지 않음
- [ ] suspended·closed·기능 비활성·provider registry 제거 이후에도 이미 커밋된
      동일 command는 verifier 재호출 없이 최초 결과 반환

eligibility:

- [ ] 광고 disabled + 정상 계정 → 기존 정상 응답 유지
- [ ] 광고 disabled + USD 지갑 누락 → 500
- [ ] provider 미등록 + 초기 지급 원장 누락 → 500
- [ ] suspended + 지갑 scope 손상 → 500
- [ ] closed + 정상 계정 → 상태 기반 응답 유지
- [ ] 정상 active 계정 → 기존 한도·cooldown 계산 유지

일반계정 일별 snapshot job:

- [ ] active·suspended 계정에 daily 행 생성, closed 계정은 제외되고 어떤 write도 없음
- [ ] 시즌계정 기존 daily 행이 변경되지 않고 일반 job이 시즌 행을 만들지 않음
- [ ] 현금 전용 계정도 정상 생성되고 휴장일·주말에도 생성됨
- [ ] dry-run은 DB 무변경이며 wouldCreate/excludedClosed/integrityFailed/
      valuationFailed/existing을 보고
- [ ] 같은 account/date 재실행 멱등(daily 1행, scheduled equity 1행)
- [ ] 동시 실행에서 daily 1행 + scheduled equity 1행만 남음
- [ ] DailyPortfolioSnapshot 생성 실패 시 같은 트랜잭션의 EquitySnapshot도 남지 않음
- [ ] performance origin 누락·외부자금 불일치 계정은 실패로 보고되고 부분 snapshot 없음
- [ ] 일반 daily 행의 `seasonParticipantId`가 null이고 TWR·외부자금·투자손익
      컬럼이 채워짐

## 8. 배포 순서 (작업 6 migration 포함)

1. DB 백업 + 최신 main 확인
2. additive migration 2건 검토
   (`…180000_add_general_account_and_ad_reward_enums`,
   `…181000_add_general_account_and_ad_reward_foundation`) — enum 추가,
   `DROP NOT NULL` 2건, partial unique 2건, `ad_reward_claims` 테이블만
3. migration 전 fingerprint 수집 (§6 목록) → `prisma migrate deploy` →
   migration 후 fingerprint 비교. 기존 금융 값·행 수·ID·seasonParticipantId는
   **완전히 동일해야 한다.** 유일한 차이는 빈 `ad_reward_claims` 테이블이다.
4. 신버전 backend 배포
5. 기존 시즌 API smoke: 참가·지갑 조회·FX quote/execute·시장가/지정가 주문
6. `POST /api/v1/trading-accounts/general` smoke (신규 테스트 계정)
7. 같은 사용자 재호출에서 `created=false` + 중복 지급 없음 확인
8. account-scoped `wallets`·`wallet-transactions`로 KRW 1,000만/USD 0/
   initial grant 1건 확인
9. 광고 기능이 기본 비활성인지 확인 (`AD_REWARD_ENABLED` 미설정 → claim 503
   `AD_REWARD_DISABLED`)
10. **실제 provider adapter와 운영 정책값이 확정된 뒤에만** 광고 기능 enable
11. enable 전 reward amount·일일 횟수·일일 금액·cooldown·timezone 검토
12. enable 후에는 테스트용 이벤트가 아니라 provider sandbox 이벤트로 검증
13. `pnpm trading-accounts:audit-general` 실행 (findings 0 기대)
14. 일반계정 시장가·지정가 주문 lifecycle smoke + 일반 FX 차단 유지 확인

**migration만 적용한 상태에서 기존 사용자에게 general account를 자동 생성하지
않는다.** general 계정은 사용자가 명시적으로 POST를 호출할 때만 생긴다.

## 8-A. 작업 8 — SeasonRanking TradingAccount scope · 성과 조회 일관성

WORK-ID `GENERAL-PERFORMANCE-CONCURRENCY-AND-SEASON-RANKING-V1`.

### 8-A.1 일반계정 GET RepeatableRead

`GET /api/v1/trading-accounts/:accountId/portfolio` 와 `.../portfolio/equity`
의 **일반계정 경로만** Prisma interactive transaction(`RepeatableRead`)으로
감싼다. 시즌계정 경로와 legacy `/api/v1/portfolio*`는 변경하지 않는다.

이전에는 한 응답을 만드는 6개 read(최신 성과 snapshot·외부자금 원장·KRW/USD
지갑·Position·가격 snapshot·FX snapshot)가 각각 별도 암묵 트랜잭션이었다.
요청 도중 광고 지급이 커밋되면 **지갑은 지급 후, 외부자금 합계는 지급 전**을
읽는 조합이 가능했고, TWR은 그 차액을 전부 `investmentPnlKrw`로 계산했다 —
광고 시청이 투자수익으로 표시된다.

한 트랜잭션 안에서 읽는 것:

- TradingAccount (소유권·mode·status·initialCapitalKrw·participant link 재확인)
- 일반계정 금융 integrity, 최신 performance snapshot, 외부자금 원장
- wallet, Position, AssetPriceSnapshot, FxRateSnapshot
- equity/daily history, boundary pair 검증에 필요한 claim

GET 트랜잭션이 **하지 않는 것**: row lock, DB write, snapshot·지갑·원장·claim
생성, 성과 복구, 외부 네트워크 호출. valuation은 저장된 가격·환율 snapshot만
사용하므로 트랜잭션 안에서 안전하다.

`valuationAt`/`now`/range 기준시각은 요청당 **한 번만** 결정한다.

외부 계약은 유지: 미인증 401, 미존재·타인 account 동일 404
`TRADING_ACCOUNT_NOT_FOUND`, active·suspended·closed 모두 조회 가능.

### 8-A.2 일반 daily snapshot의 account row lock

`GeneralDailySnapshotJobService`는 계정별 트랜잭션 **시작 직후** 광고 지급과
동일한 잠금을 잡는다:

```sql
SELECT "id", "status" FROM "trading_accounts"
WHERE "id" = $1 AND "mode" = 'general' FOR UPDATE
```

전역 락도, 모든 계정을 한 트랜잭션에 넣는 것도 아니다 — 한 번에 한 계정.

잠금 후 **DB에서 다시 읽은 값**으로 재검사한다: 존재·mode=general·
status != closed·seasonParticipant=null·userId·initialCapitalKrw·금융
integrity·performance origin·외부자금 연속성. job 시작 시 목록에서 읽어둔
status는 신뢰하지 않는다.

목록 조회 후 closed로 전환된 계정은 **어떤 write도 없이** 건너뛰고
`excludedClosed`에 합산되며, 그중 실행 중 경쟁으로 건너뛴 수는
`skippedClosedDuringRun`으로 따로 보고된다(두 값 모두 결과에 포함).

`capturedAt`은 **계정 lock 획득 이후** 계정마다 한 번 결정한다. batch의
`startedAt`을 모든 계정에 강제하면, 앞 계정 처리나 광고 지급 대기로 시간이
흐른 뒤의 valuation이 실제와 다른 시각으로 기록된다. 같은 계정 트랜잭션에서
만드는 scheduled EquitySnapshot과 DailyPortfolioSnapshot은 **같은
capturedAt**을 쓴다.

가능한 정상 결과는 두 가지뿐이다:

- daily 선점 → 지급 전 상태로 daily commit, 이후 광고가 before/after 경계 생성
- 지급 선점 → 지급과 경계 commit, daily는 지급 후 상태 기준

혼합 상태(지급 후 wallet + 지급 전 외부자금 합계 등)는 발생하지 않는다.

### 8-A.3 일반 history 전체 무결성

반환할 **모든** EquitySnapshot·DailyPortfolioSnapshot 행을 검증한다
(`src/portfolio/general-history-integrity.ts`). 이전에는 최신 성과 상태만
검사하고 과거 행은 그대로 직렬화했기 때문에, 손상된 컬럼이
`"investmentPnlKrw": null`로 200에 실려 나갔고, 짝 잃은 `after` 경계는 차트에서
거래 수익과 구분되지 않는 수직 상승으로 그려졌다.

행 단위 요구사항:

- `tradingAccountId` = 요청 accountId, `seasonParticipantId` = null
- 누적 외부자금·투자손익·TWR factor 모두 non-null, 각각 >= 0
- `investmentPnlKrw = totalAssetKrw - cumulativeExternalFundingKrw`
- `returnRate = (factor - 1) × 100` (기존 scale 반올림)
- origin(`general_account_open`/`performance_baseline`): factor = 1,
  returnRate = 0, 계정당 1개
- ordinary: 외부자금 reference 3컬럼 모두 null
- boundary: before/after 완전 pair, 동일 account·referenceType·referenceId·
  amount·factor·returnRate·investmentPnl, after total = before + amount,
  after 누적자금 = before 누적자금 + amount

`ad_reward_claim` 경계는 관련 claim을 **1회 batch 조회**해 status=granted·
account 일치·금액 일치·원장 존재를 확인한다. history point마다 개별 조회하지
않는다. range 정책과 조회 범위는 그대로다.

작업 7 이전 legacy unkeyed claim에는 존재하지 않는 경계를 요구하거나 만들지
않는다. 다만 boundary 행이 실제로 하나라도 있으면 불완전한 pair는 정상으로
반환하지 않는다.

정렬은 기존 phase 순서 유지: 동일 capturedAt에서
`external_funding_before` → ordinary → `external_funding_after`. UUID는
before/after 순서를 결정하지 않는다.

오류: `GENERAL_PERFORMANCE_INTEGRITY` / HTTP 500.

### 8-A.4 keyed claim responsePayloadJson 필수 shape

`responsePayloadJson`은 최초 응답의 canonical 기록이다. "null이 아니기만 하면
된다"는 검사로는 `{}`, `{ data: {} }` 같은 payload가 모든 필드 비교를
공허하게 통과해 **증거 없는 성공 replay**가 됐다.

keyed granted claim에 요구하는 shape:

- top-level object, `success = true`
- `data` object, `data.granted`/`data.duplicate` boolean
- `data.claimId` string = claim.id
- `data.grantedAt` UTC ISO = claim.grantedAt
- `data.walletBalanceAfter` 금액 문자열 = ledger.balanceAfter
- 저장 payload는 **최초 사실**이므로 항상 `granted=true, duplicate=false`
  (재시도 응답이 뒤집히는 것은 API 계약이며 저장 기록은 뒤집지 않는다)

keyed rejected claim: object, `refused = true`, `code` = claim.failureCode,
`message` non-empty이며 claim.failureReason과 모순되지 않을 것.

legacy unkeyed claim에는 이 shape를 강제하지 않는다(payload가 null이거나
부분적일 수 있음). 단, 존재하는 필드가 원장과 어긋나면 여전히 오류다.
claim·ledger·wallet 금융 정합성 검사는 legacy에도 계속 수행한다.

오류: `AD_REWARD_CLAIM_INTEGRITY` / HTTP 500.

### 8-A.5 SeasonRanking.tradingAccountId

SeasonRanking은 **시즌 전용 모델로 유지**된다. `seasonParticipantId`는
NOT NULL이고 관계도 그대로다. `tradingAccountId`는 행의 자산 격리·소유권
scope를 명시하는 **두 번째 식별자**로 additive하게 추가됐다. 이번 작업에서
SeasonRanking을 일반계정 랭킹 모델로 확장하지 않는다.

schema:

- `tradingAccountId String? @map("trading_account_id")`
- `tradingAccount TradingAccount? @relation(onDelete: Restrict)`
- `TradingAccount.seasonRankings SeasonRanking[]` 역관계
- 기존 unique 2건 유지 + `@@unique([seasonId, rankType, rankingDate, tradingAccountId])`
- `@@index([tradingAccountId, rankingDate])`

`tradingAccountId`는 이번 작업에서 nullable로 유지한다. NOT NULL 강화는
repair 수렴 이후의 후속 hardening 작업이다.

정상 행 invariant:

- participant·account 모두 non-null
- ranking.seasonId = participant.seasonId
- ranking.tradingAccountId = participant.tradingAccountId
- account.mode = season, account.userId = participant.userId,
  account.seasonParticipant.id = participant.id
- 일반계정 TradingAccount 참조 금지

오류 코드: null scope → `SEASON_RANKING_SCOPE_REPAIR_REQUIRED`,
participant account 불일치 → `SEASON_RANKING_SCOPE_MISMATCH`,
participant link 자체 손상 → `TRADING_ACCOUNT_LINK_INTEGRITY`. 모두 HTTP 500
fail-closed이며, 구조 손상을 404·빈 배열·ranking unavailable로 감추지 않는다.

### 8-A.6 migration `…20260804120000_add_season_ranking_trading_account_scope`

additive only. 순서: nullable 컬럼 추가 → 기존 행 backfill → FK → unique →
index.

backfill source는 `season_rankings.season_participant_id` →
`season_participants.trading_account_id`이며, 양쪽 IS NULL/IS NOT NULL로
guard해 재실행이 no-op이다. participant link가 null이면 ranking도 null로
남긴다 — fail-open으로 잘못된 account를 연결하지 않는다.

이 migration이 **하지 않는 것**: rank·금액·수익률·MDD·fill count·시각·
createdAt·seasonParticipantId 재계산이나 재작성, ranking 삭제/재생성,
SeasonParticipant 결과 변경, Season.status 변경, TradingAccount status/closedAt
변경, TradingAccount·SeasonParticipant 생성, 정산 실행, 티어 계산.

migration 전후 fingerprint (§6 목록에 추가):

season_rankings 총 행 수, rankType별·seasonId별·rankingDate별 행 수,
SUM(rank)/SUM(total_asset_krw)/SUM(return_rate)/SUM(max_drawdown)/
SUM(total_fill_count), MAX(reached_return_at)/MAX(captured_at)/MAX(created_at),
season_participant_id multiset, SeasonParticipant current_rank/final_rank/
final_tier, Season status, TradingAccount status, wallet balance,
order·position 수.

허용되는 변화는 **기존 ranking의 tradingAccountId backfill과 FK·index·unique
추가뿐이다.**

### 8-A.7 ranking writer dual-write

모든 writer가 `seasonParticipantId`와 `tradingAccountId`를 함께 기록한다:

- `RankingRefreshService.replaceCurrentRankings`
- `SeasonRankingJobService.createRankingRowsAtomically`
- `writeSeasonRankings` (admin script 경로)
- `SeasonSettlementJobService` final ranking 생성
- `OperatorSeasonModerationService.upsertFinalRankingRank`
- 테스트 fixture 전부

공용 helper는 `src/ranking/season-ranking-scope.ts`:
`resolveSeasonRankingAccountScopes`(participant 목록 → 검증된 accountId map,
**1회 쿼리**), `requireSeasonRankingAccountScope`,
`assertExistingRankingRowScopeWritable`.

participant.tradingAccountId가 null이면 ranking을 **하나도** 만들지 않는다 —
한 명이 빠진 랭킹은 더 작은 정상 랭킹이 아니라 틀린 랭킹이다.

기존 행 update/upsert 시:

- 기존 null scope는 정상 row처럼 업데이트하지 않고 repair 필요 오류
- 기존 non-null mismatch도 덮어쓰지 않음 (둘 중 무엇이 맞는지 writer는 모른다)

### 8-A.8 ranking 입력 데이터 scope 검증

`src/ranking/ranking-source-scope.ts`. ranking 행만 dual-write하고 입력이
손상되면 scope는 완벽하고 숫자가 틀린 결과가 나온다.

검증 대상:

- daily ranking 기준 DailyPortfolioSnapshot: participant·account non-null,
  participant.seasonId = 대상 season, snapshot.account = participant.account,
  account.mode = season, 일반계정 성과 컬럼 3종 모두 null
- MDD·reachedReturnAt용 EquitySnapshot: 동일 조건
- totalFillCount용 executed Order: participant·account non-null, 일치,
  account mode season

**손상 행을 조용히 제외하지 않는다.** 제외는 중립적이지 않다: equity 저점
하나가 빠지면 MDD(tie-break #2)가 낮아지고, executed order 하나가 빠지면
fill count(tie-break #3)가 낮아진다 — 둘 다 손상된 계정을 **위로** 올린다.
해당 ranking job 전체를 fail-closed한다.

`seasonSnapshotWhere` 필터는 쿼리 필터로 유지하되, 필터만으로 무결성 검사를
대신하지 않는다.

participant 목록은 `RANKING_PARTICIPANT_SCOPE_SELECT`로 id·userId·seasonId·
participantStatus·tradingAccountId·account(mode/status/userId)를 **한 번에**
select한다 (N+1 금지).

오류: `SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED` /
`SEASON_RANKING_SOURCE_SCOPE_MISMATCH`, HTTP 500.

### 8-A.9 ranking reader fail-closed

모든 reader가 `SEASON_RANKING_SCOPE_SELECT`를 spread해 scope 컬럼을 select하고
`assertSeasonRankingScope(s)`로 검증한다: RankingService(목록·myRanking),
HomeService(daily/final), RecordsService(목록·상세·public summary),
FinalTierAssignmentJobService, SeasonSettlementJobService(기존 final ranking
재사용), SeasonRankingJobService(기존 행 skip 경로).

정상 set 안에 하나라도 null·mismatch가 있으면 **전체 set을 정상 응답으로
제공하지 않는다.** 빈 ranking으로 숨기지 않고, 해당 행만 제외하지 않고, rank를
재번호 매기지 않고, 자동 수정하지 않는다. 한 명을 조용히 빼면 그 아래 모든
순위가 밀리고, 아무도 볼 수 없는 방식으로 틀린 리더보드가 된다.

- 데이터 **부재** = ranking row 자체가 없음 → 기존 unavailable 응답 유지
- 데이터 **손상** = row는 있는데 accountId null / account·participant 불일치 /
  season 불일치 / account mode general / user 불일치 → 구조화된 500

같은 ranking set 안에서 한 account가 두 행을 차지하는 것도 손상이다.

`tradingAccountId`는 내부 scope 검증용이며 **공개 ranking 응답에 노출되지
않는다** (`formatRankingRow`/`formatMyRanking`에 없음).

### 8-A.10 ranking 계산 정책 불변

변경 없음: returnRate desc → maxDrawdown asc → totalFillCount asc → target
return 도달 시각 → userId → seasonParticipantId. 순위는 sequential(1,2,3,4)
유지이며 공동순위를 도입하지 않는다. 시즌 returnRate는 초기자본 기준이고 TWR을
쓰지 않는다. hidden·excluded 공개 필터, near_me·top10·pagination, provisional
tier, final tier cutoff 비율 모두 그대로다.

### 8-A.11 ranking writer 동시성 (season row lock)

`src/ranking/season-write-lock.ts`.
`SELECT ... FROM "seasons" WHERE "id" = $1 FOR UPDATE`.

`RankingRefreshService`의 in-memory Set은 단일 프로세스 중복 실행만 줄인다.
실제로 문제가 되는 경쟁은 **live refresh vs settlement**이며, 두 backend
instance나 API 옆에서 도는 batch는 메모리를 공유하지 않는다. in-memory Set은
같은 프로세스 안 보조 장치로 남고, **DB row lock이 최종 직렬화 수단**이다.
Redis lock·advisory lock namespace·큐를 도입하지 않는다.

같은 season lock을 쓰는 writer:

- current ranking refresh write — 잠금 후 season 존재·status=active·
  capturedAt이 [startAt, endAt) 안인지 재확인. settled면 write하지 않고 skip.
- snapshot 기반 daily ranking job write — 잠금 후 status 재검사. settled
  season에 daily ranking을 새로 만들거나 덮어쓰지 않는다
  (`SEASON_ALREADY_SETTLED`). 기존 ranking이 있으면 현재 skip/immutable
  계약 유지.
- season settlement write

settlement가 lock을 잡은 뒤에는 final result 작성·season account 종료·
settled 전환이 끝날 때까지 다른 ranking writer가 같은 season 결과를 바꾸지
못한다.

### 8-A.12 정산 시 season account 종료

settlement write 트랜잭션 순서:

1. Season row `FOR UPDATE`
2. status 재검사 (ended 또는 idempotent settled)
3. **open limit reservation 재검사** — 트랜잭션 밖 사전 검사만으로 끝내지
   않는다. 그 사이 지정가 주문이 들어와 현금이 다시 예약될 수 있고, 그러면
   미완결 주문서 위에서 정산하게 된다.
4. 시즌의 **모든** participant + account link 재조회·검증
5. 기존 final ranking scope 검증 (재사용 시)
6. settlement EquitySnapshot → final SeasonRanking(account dual-write) →
   participant final 결과 → participant 상태 전환 → season account 종료 →
   `Season.status = settled`

전부 한 트랜잭션이며, 하나라도 실패하면 **전체 rollback**이다.

final ranking 대상은 기존 정책 유지(active·finished·rewarded). 그러나
`Season.status`가 settled로 갈 때 **해당 시즌에 연결된 모든 season
TradingAccount**가 종료된다 — excluded participant의 계정도 포함. 시즌이
끝났는데 그 시즌 계정 하나가 거래 가능해 보이는 상태로 남으면 안 된다.

participant 중 하나라도 link null / account 없음 / mode != season /
userId 불일치 / 다른 participant와 연결이면 `SETTLEMENT_ACCOUNT_LINK_INTEGRITY`
로 정산을 중단한다. 일부 account만 closed하고 season을 settled로 만들지 않는다.

participant 상태: active → finished. finished·rewarded·excluded는 그대로.
**registered는 그대로 둔다** — 정산 시점에 registered로 남아 있는 것은 이상
상태이고(가입 흐름은 진입 시 활성화한다), 조용히 finished로 바꾸면 "경쟁했다"고
주장하는 셈이다. 상태를 유지하고 final rank·tier를 주지 않으며 구조화된 로그를
남긴다. 그 계정은 시즌의 나머지와 함께 closed된다.

account 종료:

- `status = closed`
- `closedAt = COALESCE(기존 closedAt, Season.endAt)` — 실제 거래 가능 기간은
  `endAt`에 끝났으므로, 정산 job이 3일 늦게 돌아도 그때까지 계정이 살아 있던
  것처럼 만들지 않는다. 이미 더 이른 closedAt이 있으면 보존한다.
- 모든 WHERE에 `mode = 'season'`을 고정해 general account는 절대 건드리지
  않는다. status는 오직 `closed`로만 쓰므로 재활성화도 없다.
- 종료 후 잔여 검사에서 active/suspended이거나 closedAt이 null인 연결 계정이
  하나라도 있으면 `SEASON_ACCOUNT_CLOSE_INCOMPLETE`로 전체 rollback.

기존 final ranking을 재사용하는 idempotent 정산에서도 모든 row의 account scope를
검증한다. null·mismatch면 재사용하지 않고 repair 실행을 요구하는 오류를 낸다.

settlement EquitySnapshot은 작업 7 계약 유지(participant·account non-null,
scope 일치, general 성과 컬럼 null, reason=settlement). 기존 snapshot을
update하는 현재 정책은 유지하되 **먼저 scope를 검증**한다: non-null mismatch
덮어쓰기 금지, null scope를 update로 조용히 고치지 않음
(`SETTLEMENT_SNAPSHOT_SCOPE_REPAIR_REQUIRED` /
`SETTLEMENT_SNAPSHOT_SCOPE_MISMATCH`). snapshot immutability 정책 자체는 이번
작업에서 바꾸지 않는다.

### 8-A.13 FinalTierAssignmentJob 보완

기존 역할 유지 + 다음 검증 추가:

- final ranking tradingAccountId non-null, participant account와 일치,
  account mode season
- settled season의 연결 account가 실제로 closed이고 closedAt이 있는지
  (`SEASON_ACCOUNT_CLOSE_INCOMPLETE`)
- participant final 결과와 ranking 불일치 감지

이전에는 finalRank 또는 finalTier가 **일부만** 설정된 participant를 단순
existing으로 건너뛰었다. 그 결과 사용자는 리더보드가 부정하는 절반짜리 결과를
영구히 갖고, job은 성공을 보고했다. 이제 다음 세 상태는
`FINAL_TIER_ASSIGNMENT_CONFLICT`로 중단한다:

- finalRank non-null인데 finalTier null (또는 그 반대)
- 저장된 finalRank가 ranking.rank와 다름
- 저장된 finalTier가 정책 계산 결과와 다름

완전히 동일한 finalRank·finalTier가 이미 있으면 기존대로 idempotent existing.

### 8-A.14 정산 완료 불변식

eligible participant마다: final SeasonRanking 정확히 1개, ranking.account =
participant.account, participant.finalRank = ranking.rank, finalTier = 정책
결과, currentRank = ranking.rank, totalAsset·returnRate·maxDrawdown 일치.

season: `status = settled`. 모든 linked season account: `status = closed`,
`closedAt` non-null.

final ranking set: rank 1..N 연속, rank·participant·account 중복 없음,
일반계정 없음.

final tier 비율 불변: master 4% / diamond 누적 11% / platinum 23% / gold 40% /
silver 70% / bronze 나머지.

### 8-A.15 repair-ranking-scope

`pnpm trading-accounts:repair-ranking-scope` (기본 dry-run, `--apply`로만 수정).

기존 repair-links / repair-financial-scope / repair-trading-scope /
repair-snapshot-scope와 역할을 섞지 않는다 — 각각 한 테이블 계열을 소유하므로
운영자가 어느 것을 돌려야 하는지 항상 명확하다.

apply 가능한 행: `ranking.tradingAccountId IS NULL` +
participant.tradingAccountId non-null + participant account가 정상 season
account + user 일치 + season 일치. **`ranking.tradingAccountId`만** 채운다.

수정 금지(보고만): non-null mismatch, participant link null, account mode
general, user 불일치, season 불일치, rank·금액·수익률·시각, participant 결과,
account status.

요건: batch·cursor 기반, 멱등(IS NULL guard), 변경 전후 count 보고, apply 후
null·mismatch 잔여 재검증, 잔여 문제 시 exit 1.

같은 스크립트가 **read-only audit**도 함께 출력한다(dry-run·apply 양쪽):
ranking scope null/mismatch/general account/중복 account, rank 중복,
rank sequence 누락, final ranking vs participant.finalRank 불일치, final tier
누락, settled season의 미종료 account, closedAt null, eligible participant final
ranking 누락, excluded participant의 final ranking, season snapshot scope 손상,
executed order scope 손상. audit는 재계산도 재번호 매기기도 하지 않는다 — 여러
findings(rank gap, tier 불일치)는 이 스크립트의 소관이 아니라 해당 job 재실행
대상이다.

### 8-A.16 배포 순서 (작업 8)

1. DB 백업 + 최신 main SHA 확인
2. migration SQL 검토
3. migration 전 SeasonRanking fingerprint 저장 (§8-A.6)
4. `prisma migrate deploy`
5. migration 후 fingerprint 비교 — tradingAccountId backfill과 FK/index/unique
   외에는 차이가 없어야 한다
6. 신버전 backend 배포
7. **구버전 backend 완전 종료** — 구버전 writer가 살아 있으면 repair 뒤에도
   null scope 행이 다시 생긴다
8. `repair-links` dry-run → `--apply` → 잔여 0
9. `repair-financial-scope` dry-run → `--apply` → 잔여 0
10. `repair-trading-scope` dry-run → `--apply` → 잔여 0
11. `repair-snapshot-scope` dry-run → `--apply` → 잔여 0
12. `repair-ranking-scope` dry-run → `--apply`
13. ranking null scope 0 / mismatch 0 확인
14. `trading-accounts:audit-general` findings 0
15. ranking·settlement audit findings 0
16. active season current ranking smoke
17. snapshot 기반 daily ranking dry-run
18. final settlement dry-run
19. 실제 종료된 테스트 season settlement smoke
20. settled season의 active/suspended linked account 0 확인
21. ranking API smoke / Home·Records smoke
22. 일반계정 portfolio concurrency smoke
23. 일반 daily snapshot dry-run
24. 실제 광고 provider가 계속 비활성·미등록인지 확인

repair가 끝나기 전에 NOT NULL을 적용하지 않는다.

### 8-A.17 당시 작업에서 하지 않은 것

일반계정 실제 주문·환전·Position 활성화, 일반모드 랭킹, 시즌+일반 통합 랭킹,
프런트엔드 변경(모드 선택·랭킹 화면·일반계정 portfolio 연결), 광고 SDK·실제
provider adapter·광고 정책값 확정, SeasonReward 지급 활성화 및 reward-grant
gate 개방, 경쟁 순위(1,2,2,4) 도입, 랭킹 계산 규칙·티어 비율 변경, 시즌
초기자금 수익률의 TWR 전환, SeasonParticipant 랭킹 캐시 컬럼 제거,
SeasonParticipant 제거, `SeasonRanking.seasonParticipantId` nullable 전환,
기존 `seasonParticipantId` 컬럼 제거, 모든 `tradingAccountId` NOT NULL 강화,
Order·Position·ExchangeTransaction·FxExecuteRequest의 participant FK 제거,
별도 랭킹 이벤트 로그 테이블, 랭킹 결과 무제한 버전 보관, Redis 분산락,
메시지 브로커, 범용 작업 큐.

당시에는 일반 주문과 FX 차단을 모두 유지했다. 일반 주문 차단은 2026-08-18
일반계정 거래 활성화 작업에서 제거됐고, FX 차단만 현재도 유지된다.

## 8-B. 작업 8 보완 · 작업 9 — 랭킹/정산 무결성 잔여 결함 + 프런트엔드 계정 전환

WORK-ID `SEASON-RANKING-HARDENING-AND-FRONTEND-ACCOUNT-SWITCH-V1`,
기준 커밋 `813e3043c0f363450ae8396ab29b174d0ca52dce`.

작업 8은 랭킹 **writer/reader**를 fail-closed로 만들었지만, ① 정산 경로의
**입력** snapshot, ② 기존 final ranking **재사용** 시의 결과 정합성,
③ routine refresh의 **삭제** 경로, ④ pagination **밖**의 손상,
⑤ settled 시즌의 final ranking **부재**, ⑥ final ranking에 **없는**
participant의 account 종료 — 이 6곳이 남아 있었다. 8-B가 그 6곳을 닫는다.

### 8-B.1 (§A-1) 정산 입력 snapshot scope 검증

`SeasonSettlementJobService`의 두 정산 경로가 모두 검증된
`seasonParticipantId → tradingAccountId` map(`buildRankingParticipantScopes`)을
기준으로 입력을 검사한다. map은 `findEligibleParticipants`가 이미 읽는 목록에서
**한 번** 만든다(N+1 없음).

- live valuation 경로: `findEquityHistory()`가 `id`,
  `seasonParticipantId`, `tradingAccountId`,
  `cumulativeExternalFundingKrw`, `investmentPnlKrw`,
  `timeWeightedReturnFactor`, `totalAssetKrw`, `returnRate`, `capturedAt`,
  `createdAt`를 select하고 `assertRankingSourceSnapshotScopes`로 검증한다.
- fallback 경로: `calculateFinalValuationsFromDailySnapshots()`가 동일한 scope
  컬럼을 select하고 동일하게 검증한다.
- `tradingAccountId IS NULL` → `SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED`.
- 다른 account / 일반계정 성과 컬럼 존재 →
  `SEASON_RANKING_SOURCE_SCOPE_MISMATCH`.
- **손상된 행만 제외하고 나머지로 계산하지 않는다.** 하나라도 손상되면 정산
  전체가 중단되고, 정상 participant도 final rank·tier를 받지 않으며 시즌은
  `ended`로 남는다. 제외는 중립적이지 않다: equity 저점이 빠지면 MDD가
  낮아지고(tie-break #2), snapshot이 빠지면 그 아래 순위가 전부 한 칸씩
  올라간다.
- scope 오류는 기존 `FINAL_VALUATION_FAILED`(503)로 **뭉개지지 않는다**.
  재시도로 고칠 수 없는 상태를 "잠시 후 다시" 라고 안내하면 안 되기 때문에,
  `isRankingSourceScopeError()`가 구조화 코드를 그대로 통과시킨다.
- 정상 계산식·MDD·reachedReturnAt·tier 비율·순위 규칙은 변경 없음.

### 8-B.2 (§A-2) 기존 final ranking 재사용 시 결과 정합성

기존 final ranking을 재사용하는 정산 경로에서 **그 ranking row가 확정 결과의
기준**이다. 이전에는 `finalRank`·`finalTier`·`currentRank`만 맞추어서,
participant가 마지막 live refresh 값(`totalAssetKrw`·`totalReturnRate`·
`maxDrawdown`·`totalFillCount`)을 그대로 들고 settled 되었다 — 리더보드와
내 기록 카드가 서로 다른 "확정" 숫자를 보여주는 상태였다.

- `assignFinalResultsForExistingRows()`가 6개 값을 모두 ranking row에서 쓴다:
  `totalAssetKrw`, `totalReturnRate`(=`ranking.returnRate`), `maxDrawdown`,
  `totalFillCount`, `currentRank`(=`rank`), `finalRank`(=`rank`),
  `finalTier`(현재 tier 정책 계산값).
- `assertExistingFinalRankingSetCovers()`가 **집합 정합성**을 먼저 본다:
  participant 중복, eligible participant 누락, 비-eligible participant의 row.
  개수만 비교하던 기존 검사는 "한 명 중복 + 한 명 누락"을 통과시켰다.
- `transitionSeasonToSettledIfReady()`가 settled 직전에
  `assertParticipantResultsMatchFinalRanking()`으로 **DB에서 다시 읽어**
  7개 값을 대조한다. Decimal은 값 비교(`1000` == `1000.00000000`)다.
- 불일치 → `FINAL_RESULTS_INTEGRITY`(409). participant 갱신·account 종료·
  season settled 전환이 **모두 rollback**된다.
- 정상 재실행은 idempotent다: 새 ranking row가 추가되지 않고 결과가 같다.

### 8-B.3 (§A-3) 손상된 ranking set 삭제 방지

`RankingRefreshService.replaceCurrentRankings()`가 season row lock 획득 후,
기존 delete 이전에 동일 `(seasonId, rankType, rankingDate)` set을
`SEASON_RANKING_SCOPE_SELECT`로 읽고 `assertSeasonRankingScopes()`로 검증한다.

refresh 정책은 delete-then-recreate이고 recreate는 항상 올바른 scope를
쓴다. 그 조합이 손상을 **세탁**한다: null·mismatch 행이 5분 tick마다 사라지고
정상처럼 다시 생기며, repair 스크립트는 고칠 것이 없다고 보고하고 어떤 계정이
영향을 받았는지 알 방법이 사라진다.

- 손상이 하나라도 있으면 `seasonRanking.deleteMany`·`create`,
  `seasonParticipant.update`(=`currentRank`) 중 **어느 것도 실행되지 않는다.**
- 코드: `SEASON_RANKING_SCOPE_REPAIR_REQUIRED` /
  `SEASON_RANKING_SCOPE_MISMATCH` / `TRADING_ACCOUNT_LINK_INTEGRITY`.
- 정상 set은 기존 delete-and-recreate 정책 그대로.

### 8-B.4 (§A-4) ranking reader 전체 set preflight

신규 `src/ranking/season-ranking-set-scope.ts`의
`assertSeasonRankingSetScope(client, { seasonId, rankType, rankingDate, capturedAt? })`.

기존 reader는 **현재 페이지와 내 행**만 검증했다. 100행 중 87위가 null scope여도
1페이지는 200으로 나갔고, `scope=top10`은 10행만 보고 나머지 90행에 대해
계산한 `total`로 percentile을 냈다.

- 적용: `RankingService.getRanking()`(선택 snapshot의 `capturedAt`까지 고정),
  `HomeService.buildRanking()`·`buildFinalResult()`,
  `RecordsService.getUserCurrentSeasonSummary()` — 즉 **전체 set에서 파생된
  값(`totalParticipants`·percentile·tier)** 을 내는 모든 경로.
- scope 컬럼만 select한다(공개 payload를 적재하지 않는다). 공개 WHERE(숨김·
  excluded 필터)를 **적용하지 않고** set 전체를 본다 — 숨겨진 행의 손상도
  손상이고, 그 주변 순위는 이 응답이 게시하는 순위다.
- 손상 시 전체 set이 구조화 500. 손상 행만 제외하지 않고, `total`을 정상 행만으로
  다시 세지 않고, rank를 다시 매기지 않는다.
- row가 하나도 없는 경우는 기존 unavailable 계약 유지.
- `tradingAccountId`는 공개 응답에 노출되지 않는다.
- 단일 participant만 읽는 운영자 내부 경로
  (`OperatorSeasonModerationService`)는 해당 row 검증을 유지하고 전체
  leaderboard를 적재하지 않는다.

### 8-B.5 (§A-5) settled 시즌의 final ranking 부재 차단

`assertSettledSeasonFinalResultsPresent()`가 season row lock **이전**에,
그리고 lock **이후**에 한 번 더 상태를 구분한다.

| 상태 | 처리 |
| --- | --- |
| `ended` + final ranking 없음 | 신규 정산 허용 |
| `ended` + final ranking 있음 | 검증 후 재사용 |
| `settled` + 완전한 final ranking | 검증된 idempotent replay |
| `settled` + final ranking 없음 | `FINAL_RESULTS_INTEGRITY`(409) |
| `settled` + 일부 participant만 | `FINAL_RESULTS_INTEGRITY`(409) |

settled 상태에서는 현재 wallet·가격으로 final valuation을 다시 계산하지 않고,
새 settlement snapshot·새 final ranking row를 만들지 않는다. 이미 게시된
리더보드를 다른 리더보드로 조용히 갈아끼우는 일이 없어야 하기 때문이다.
복구는 재실행이 아니라 조사 + final ranking 복원이다.

### 8-B.6 (§A-6) FinalTierAssignmentJob의 전체 시즌계정 종료 검증

`assertEverySeasonAccountClosed(seasonId)`가 `seasonId` 기준 **관계 조회 1회**로
그 시즌의 **모든** SeasonParticipant(active·finished·rewarded·excluded·
registered)를 읽고, 각 연결 account가 존재·`mode=season`·
`account.userId = participant.userId`·역방향 link 일치·`status=closed`·
`closedAt != null`인지 본다.

이전 검사는 final ranking 행만 순회했다. final ranking은 eligible participant만
담으므로, `excluded`/`registered` participant가 **active 계정을 그대로 들고
있는 settled 시즌**을 정상으로 통과시켰다.

- 하나라도 열려 있으면 `SEASON_ACCOUNT_CLOSE_INCOMPLETE`(409)로 중단.
- 이 job은 account를 **닫지 않는다.** 종료는 정산 트랜잭션과 원자적이어야 하고,
  이 job이 조용히 뒷정리를 하면 "닫은 트랜잭션 없이 닫힌 계정"이 생긴다.
  안내는 season settlement 재실행이다.
- general account는 조회 대상에도 들어가지 않는다(참가자 링크만 따라간다).

### 8-B.7 (§A-7) writer/reader 재점검 결과

writer — 전원 dual-write, participant link 없으면 write 없음, 기존 null/mismatch
자동 수정 없음: `RankingRefreshService`(+8-B.3),
`SeasonRankingJobService`, `writeSeasonRankings`,
`SeasonSettlementJobService`, operator 순위 정정.
`scripts/lib/repair-ranking-scope.ts`만 scope를 채운다(설계된 예외).

reader — 전원 scope 컬럼 select + 검증, null/mismatch를 empty/unavailable로
숨기지 않음, `tradingAccountId` 미노출: `RankingService`, `HomeService`,
`RecordsService`, `SeasonRankingJobService` existing-row 경로,
`SeasonSettlementJobService`, `FinalTierAssignmentJobService`,
operator 단일 participant 경로.

### 8-B.8 (작업 9) 프런트엔드 TradingAccount 전환

프레임워크는 기존 그대로다: Expo + React Native, React Navigation,
`@tanstack/react-query`, axios, AsyncStorage. **신규 전역 상태 라이브러리나
query 라이브러리를 추가하지 않았다.**

- 단일 source of truth: `TradingAccountProvider`
  (`src/features/tradingAccount/TradingAccountContext.tsx`). 소유 계정 목록은
  server state로 react-query에, 선택된 id만 `useState` + AsyncStorage.
- 선택 정책(`accountSelection.ts`, 순수 함수):
  저장값(소유 중) → 참가 중 active season → active general → 가장 최근 개설 →
  명시적 empty state. 소유 목록에 없는 저장값은 **버린다**(공유 기기에서 이전
  사용자 id로 404를 반복하지 않기 위해).
- 저장 키는 `selectedTradingAccountId:<userId>` — 사용자별 격리.
  로그아웃 시 `clearTradingAccountSession()`이 저장값과
  `['tradingAccount']`·`['me']` 캐시를 **remove**한다(invalidate가 아니다:
  invalidate된 항목은 refetch 중에도 읽히므로 다음 사용자의 첫 프레임에
  이전 사용자 잔고가 뜰 수 있다).
- query key: `QUERY_KEYS.tradingAccount.*`가 **accountId를 key에 직접** 담는다.
  mode만 담으면 시즌이 다른 두 season 계정이 한 캐시 항목을 공유한다.
  `normalizeFilterKey()`가 `undefined`/`null`/`''`/누락을 한 토큰으로 정규화하고
  key 순서를 정렬한다. accountId가 resource 바로 뒤에 오므로
  `['tradingAccount','portfolio',A]`가 A의 유효한 invalidation prefix이면서
  B의 항목과는 **절대 prefix-match하지 않는다.**
- 계정 전환 시 이전 account의 in-flight query를 `cancelQueries`로 취소하고,
  key 자체가 바뀌므로 늦게 도착한 응답은 이전 key의 캐시에 들어간다 — 새 화면을
  덮어쓸 경로가 구조적으로 없다. 전체 캐시를 비우지 않고 다른 account의 정상
  캐시도 건드리지 않는다.
- 사용 API는 기존 account-scoped 경로뿐이다(신규 endpoint 추측 없음):
  `GET /trading-accounts`, `/:id`, `/:id/portfolio`, `/:id/portfolio/equity`,
  `/:id/wallets`, `/:id/wallet-transactions`, `/:id/positions`, `/:id/orders`,
  `/:id/orders/:orderId`, `/:id/ad-rewards/eligibility|claims`.
- mode 분리: general은 `returnRateMethod: time_weighted` 라벨과
  `initialFundingKrw`·`cumulativeExternalFundingKrw`·`cumulativeAdRewardKrw`·
  `investmentPnlKrw`를 표시하고 "외부 자금 유입은 투자 수익이 아니다"를 명시한다.
  season은 `initial_capital` 라벨과 기존 시즌 UI를 유지한다. 라벨은 응답의
  `returnRateMethod`에서 읽는다(선택 계정 mode에서 추론하지 않는다).
  성과 unavailable은 **0%로 위장하지 않는다.**
- capability(`capabilities.ts`): mode·status 두 사실에서 파생된 작은 레코드다.
  status를 mode보다 **먼저** 본다 — 종료된 general 계정은 "준비 중"이 아니라
  "종료"다. 서버 게이트를 완화하는 경로는 없고, 취소는 예약 해제이므로
  suspended/closed에서도 허용(백엔드 계약과 동일).
- 오류(`integrityErrors.ts`): 구조적 무결성 코드 16종은 빈 데이터가 아니라
  전용 오류 상태로 간다. `GENERAL_ACCOUNT_*_NOT_IMPLEMENTED`는 무결성 집합에
  **넣지 않는다**(준비 중 안내이지 손상이 아니다). 선택 계정의 404는 존재를
  노출하지 않고 목록 재조회 + fallback으로 처리한다.
- 레이아웃(`AccountSwitcher.tsx`): 계정명/상태/모드는 한 줄 말줄임표가 아니라
  **줄바꿈**으로 처리하고, 상태 배지는 `flexShrink: 0`으로 절대 사라지지 않는다.
  잘린 시즌명은 옆 계정과 구분할 수 없고, 사라진 "종료" 배지는 종료 계정을
  운영 중으로 오인하게 만든다.

### 8-B.9 migration

**이번 작업에는 새 DB 컬럼도 migration도 없다.** `prisma migrate status`는
50개 migration 적용 완료 + drift 없음. 기존 rank·금액·수익률·MDD·fill count·
participant 결과를 재계산하는 migration은 만들지 않았고, 기존
repair-ranking-scope 정책과 "구버전 writer 종료 후 repair 실행" 배포 순서
(§8-A.16)를 그대로 유지한다. routine API/job은 repair 스크립트 역할을 대신하지
않는다 — 8-B.3이 그 경계를 코드로 강제한다.

### 8-B.10 당시 작업에서 하지 않은 것

`SeasonRanking.tradingAccountId` NOT NULL 강화, transitional nullable scope 제거,
Redis 분산락·메시지 큐·이벤트 소싱·전 계정 global lock·별도 ranking
microservice, 일반계정용 가짜 SeasonParticipant, 시즌/일반 wallet·position 통합,
실제 광고 provider 연동, 실제 reward 지급, 당시 일반계정 거래·환전 backend 활성화,
작업 10 hardening 선행 구현, 기존 API 주소 변경, 랭킹 계산·tier 비율 변경,
프런트엔드 디자인 전면 개편.

당시에는 일반 주문과 FX 차단을 모두 유지했다. 일반 주문 차단은 2026-08-18에
해제됐고, `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`만 현재도 유지된다.

## 9. 후속 작업 권장 순서

1. `season_participants.trading_account_id` NOT NULL 강화 (§3.5.5의 전제조건 5가지 확인 후)
2. ~~스냅샷 3모델(EquitySnapshot·DailyPortfolioSnapshot·SeasonRanking)의 accountId 전환~~
   — EquitySnapshot·DailyPortfolioSnapshot은 작업 7, SeasonRanking은 작업 8에서
   완료. 남은 것은 repair 수렴 이후의 `tradingAccountId` NOT NULL 강화
3. ~~일반모드 주문·Position 활성화~~ — 2026-08-18 완료. 남은 것은
   ExchangeTransaction·FxExecuteRequest participant optional 전환과 일반 FX 정책
4. 시즌 lifecycle 격리: finished/rewarded/settled 전환 시 account closed 동기화, suspended 재활성화, 운영자 일반계정 정지
5. 광고 제공자 선정 → `AdRewardVerifier` 구현체를 `AdRewardsModule`에 등록(additive) + 운영 설정값 확정 + sandbox 검증
6. 시간가중수익률 계산 + 외부자금 유입 경계 스냅샷 (`initial_grant`/`ad_reward` 원장을 외부 유입으로 분리)
7. tradingAccountId NOT NULL 강화·seasonParticipantId 제거(작업 10)는 스냅샷 전환과 구버전 writer 완전 종료 이후에만 검토


## Frontend account scope (작업 10)

The account-selection layer added in 작업 9 now covers **every current financial
screen and mutation**. The rules that matter to this document:

- The server still stores no "current account" anywhere. Selection is frontend
  state and every request names its accountId in the path.
- A mutation flow (order, FX) binds to ONE accountId captured when the user
  entered it. If the selection moves while the flow is open, the client drops
  the quote, its idempotency key and the inputs and refuses to continue rather
  than retargeting — a quote is pinned server-side to the account that issued
  it, and the amounts were chosen against that account's balances.
- Account fallback requires the SEASON to be active, not merely the account.
  An `ended` (settlement pending) or failed-to-close `settled` season account
  no longer outranks a live general account.
- Active general accounts use the same account-scoped market/limit order flow
  as season accounts. General FX alone remains 준비 중 and is not sent.

Full detail: `frontend/docs/trading-account-switching.md`.

## Recovery tool coverage (작업 10)

Every repair/audit tool now has an injected-damage integration test, not just a
clean-run one. A tool that reports "0 findings" is only meaningful if it is
known to report non-zero when there is something to find:

| Tool | Injected-damage coverage |
| --- | --- |
| `trading-accounts:repair-links` | `src/seasons/trading-account-link.integration.spec.ts` |
| `trading-accounts:repair-financial-scope` | `src/seasons/trading-account-financial-scope.integration.spec.ts` |
| `trading-accounts:repair-trading-scope` | `src/seasons/trading-account-trading-scope.integration.spec.ts` |
| `trading-accounts:repair-ranking-scope` | `src/ranking/season-ranking-scope.integration.spec.ts` |
| `trading-accounts:repair-snapshot-scope` | `src/portfolio/snapshot-scope-audit.integration.spec.ts` (작업 10) |
| `trading-accounts:audit-general` | `src/portfolio/snapshot-scope-audit.integration.spec.ts` (작업 10) |

Each asserts the same shape: damage is detected, a dry-run writes nothing,
`--apply` repairs only what can be inferred, a row with nothing to infer from is
REPORTED rather than guessed at, a non-null mismatch is never auto-overwritten,
re-running is idempotent, remaining damage exits non-zero, and `audit-general`
never writes.

## Client entry and general-account creation (작업 11)

`POST /api/v1/trading-accounts/general` is now reachable from the app. It was
implemented in 작업 6 and had no UI, so a user who owned nothing had no way to
start: every financial screen was empty and every route led back to the season
screen.

The contract is unchanged and the invariants it protects are the reason the UI
is shaped the way it is:

- **Creation is a POST behind an explicit press.** Opening the account grants
  starting capital and writes wallets and a ledger row. No GET, no screen mount,
  and no navigation may cause it — a read that creates money is indistinguishable
  from a bug the first time it is retried.
- **Idempotent.** `data.created` distinguishes the first open from a replay, and
  the status is pinned to 200 either way, so a double press yields one account.
- **The app never creates one implicitly.** Selecting an account issues reads
  only; a user with no accounts gets an explicit empty state offering the two
  real entrances (open a general account, or join a season when one is open).

App entry no longer depends on the current season at all: the client routes on
the owned-account list (`GET /api/v1/trading-accounts`). A user holding only a
general account, with every season settled, enters the app normally.
