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

**이번 작업에서 구현됨:**

- `TradingAccount` DB foundation (enum, 테이블, 제약, 인덱스)
- 기존 `SeasonParticipant` 전건에 대한 season TradingAccount backfill
- 신규 시즌 참가 시 같은 트랜잭션 안에서 TradingAccount 생성·연결

**아직 구현되지 않음 (문서만 보고 사용 가능하다고 오해하지 말 것):**

- 일반모드 계정 생성(진입) API, 일반모드 지갑, 최초 1,000만 원 실제 지급
- 로그인 후 모드 선택 화면, 앱 내 모드 전환
- 거래 API의 accountId 전환 (주문·포지션·지갑은 여전히 seasonParticipantId 기준)
- 광고 SDK, 광고 시청 UI, 광고 보상 검증·지급 API, 광고 보상 이력 테이블,
  광고 보상 WalletTransactionType, 광고 1회당 지급액·일일 한도 확정
- 시간가중수익률 계산 코드
- 일반모드 포트폴리오·주문·포지션·스냅샷

## 1. 게임규칙 (01 게임규칙서 대응)

### 1.1 공통 모드 구조

로그인한 사용자에게 장기적으로 두 투자 모드를 제공한다.

- **시즌모드** — 기간제 대회형 가상투자 (현재 구현되어 있는 기능)
- **일반모드** — 시즌 없는 무기한 가상투자 (향후 구현)

두 모드는 하나의 사용자 계정을 공유하지만 **거래계정과 가상자산은 완전히 분리**한다. KRW/USD 지갑, 주문, 미체결 주문, 포지션, 평균단가, 실현/미실현손익, 환전 기록, 지갑 원장, 포트폴리오 스냅샷, 투자손익, 수익률은 모드 간에 공유하지 않는다. 예: 일반모드 KRW 800만 원과 시즌모드 KRW 950만 원은 서로 영향을 주지 않고, 일반모드에서 매수한 종목은 시즌모드 포지션에 나타나지 않는다. 거래계정 간 가상자금·자산 이전은 지원하지 않는다.

### 1.2 게임 흐름 (목표 구조)

1. 회원가입과 로그인
2. 시즌모드 또는 일반모드 선택 *(모드 선택 화면은 미구현)*
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
- 일반모드 계정은 향후 사용자가 일반모드에 **최초 진입할 때** 생성한다. (이번 작업에서는 생성 API와 실제 계정 생성을 구현하지 않았다.)

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

기존 `SeasonStatus`·`ParticipantStatus`는 삭제·대체하지 않는다. `WalletTransactionType`에 `ad_reward`류 값은 이번 작업에서 추가하지 않았다(광고 보상 실제 구현 작업에서 추가).

## 5. API 방향 (03 API 명세서 대응)

### 5.1 현재 구현 (변경 없음)

- `GET /api/v1/seasons`, `GET /api/v1/seasons/current`
- `POST /api/v1/seasons/:seasonId/join` — 응답 계약 불변. 내부적으로 season TradingAccount가 함께 생성되지만 응답에 `tradingAccountId`는 노출하지 않는다.
- 기존 wallets / orders / positions / portfolio / fx / records API — 전부 seasonParticipant 기준 그대로.

### 5.2 향후 예정 (미구현 — 어떤 endpoint도 아직 존재하지 않음)

- `GET /trading-accounts` — 내 거래계정 목록
- `GET /trading-accounts/:accountId` — 거래계정 상세
- 일반계정 최초 생성 또는 조회 (최초 진입 시 생성 + 1,000만 원 1회 지급)
- accountId 기반 portfolio/wallet/order API (seasonParticipantId 경로의 전환)
- 광고 보상 시작/claim API, 광고 완료 검증 callback 또는 server verification API, 광고 보상 내역 API
  (광고 제공자가 미정이므로 provider별 endpoint는 확정하지 않는다)

## 6. 향후 광고 보상 데이터 구조 초안 (설계 예정 — 현재 schema/migration에 없음)

`AdRewardClaim`(가칭): `id`, `userId`, `tradingAccountId`, `provider`, `providerEventId`, `rewardAmountKrw`, `status`, `requestedAt`, `verifiedAt`, `grantedAt`, `failureReason`, `createdAt`, `updatedAt`.

핵심 제약(구현 시):

- `(provider, providerEventId)` unique — 동일 광고 이벤트 중복 지급 금지
- 일반모드(`mode=general`) TradingAccount에만 지급
- 지급 완료 상태에서만 WalletTransaction 생성, WalletTransaction과 지갑 증액은 하나의 트랜잭션
- 클라이언트가 rewardAmount를 결정하지 않음 — 서버 운영 설정값 사용
- 누적 광고 보상금은 완료된 광고 보상 원장 거래의 집계로 계산 (TradingAccount 컬럼 누적 금지)

## 7. QA 체크리스트 (05 QA 체크리스트 대응)

### 7.1 이번 작업 검증 항목

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

### 7.2 향후 광고 QA 초안 (전부 NOT_IMPLEMENTED)

- [ ] NOT_IMPLEMENTED — 광고 완료 검증 실패 시 지급 없음
- [ ] NOT_IMPLEMENTED — 동일 광고 이벤트 재전송 시 중복 지급 없음
- [ ] NOT_IMPLEMENTED — 시즌계정에는 광고 보상 지급 불가
- [ ] NOT_IMPLEMENTED — 다른 사용자의 거래계정에 지급 불가
- [ ] NOT_IMPLEMENTED — 광고 보상금이 투자손익으로 집계되지 않음
- [ ] NOT_IMPLEMENTED — 광고 지급 직후 가격 변동이 없다면 대표 수익률 불변

## 8. 후속 작업 권장 순서

1. `season_participants.trading_account_id` NOT NULL 강화 (모든 writer가 값을 채우는 것 확인 후)
2. 일반모드 계정 최초 생성 API + 일반모드 지갑 + 최초 1,000만 원 1회 지급 (지급·원장 원자성, 재지급 차단)
3. `GET /trading-accounts` 계열 조회 API
4. 지갑·주문·포지션·스냅샷의 accountId 전환 (seasonParticipantId와 병행 기간 필요)
5. 광고 보상: 제공자 선정 → AdRewardClaim 테이블 + `ad_reward` WalletTransactionType + 서버 검증·지급 API + 운영 설정값
6. 시간가중수익률 계산 + 외부자금 유입 경계 스냅샷
