# 초보모드 기반 계약

`beginner`는 사용자당 평생 하나인 독립 TradingAccount다. 일반·시즌계정과
금융 행을 공유하거나 이전하지 않는다. 시즌 참가·랭킹·티어·정산·보상과
광고 보상에서 제외한다. QUEST 01 진행 판정만 구현하며 기능 해금·보상 정책은
미정이므로 구현하지 않는다.

## 기본 제공 정책 (2026-10-10)

초보모드는 development·test·production에서 모든 로그인 사용자에게 항상
제공되는 정식 계정 유형이다. 별도 활성화 환경변수나 허용 목록은 없다.
기존 배포 앱과의 호환성을 위해 계정 목록의 `beginnerModeEnabled`는 항상
`true`를 반환한다. 새 클라이언트는 이 필드의 누락이나 `false`에 의존하지 않는다.
기존 계정은 재생성·재지급 없이 노출되며 계정 상태·소유권·금융 무결성 검사는
유지한다. 선물과 조건부 주문의 독립적인 출시·안전 정책도 유지한다.

## API 및 금융

- `POST /api/v1/trading-accounts/beginner`: 본문 없음, 200,
  `{success:true,data:{created,account,wallets}}`. 재시도는 기존 계정 반환.
- 기존 accountId 기반 GET/주문/환전/지갑 이체/선물 API를 재사용한다.
  GET 및 계정 선택은 계정·지갑·지급·스냅샷을 생성하지 않는다.
- 초기 10,000,000 KRW, 증권 KRW/USD 및 Crypto Spot/Futures USD 네 지갑,
  초기 원장과 TWR origin을 한 PostgreSQL transaction에서 생성한다.
- 기존 비시즌 생성·TWR 코어를 재사용한다. 역사적 이름인
  `general_account_open` 원장 referenceType 및 snapshotReason은 초보계정의
  최초 지급에도 사용한다. referenceId와 모든 금융 행은 초보 accountId다.
  기존 reference별 유일 인덱스 및 TWR origin 제약을 그대로 적용한다.
- 최초 지급은 외부 유입, TWR factor=1, 수익률=0, 투자손익=0이다.
  시세·수수료·거래·예약·취소·TWR·일별 평가 규칙은 일반계정 코어를 사용한다.
  광고 및 추가 지급은 제공하지 않는다.
- 계정 간 이체 API는 없다. 내부 지갑 이체는 같은 accountId에서만 처리한다.

## QUEST 01 진행 상태 (읽기 전용)

`GET /api/v1/trading-accounts/:accountId/quests`: 소유자 전용, beginner 계정만
(그 외 모드는 409 `BEGINNER_QUEST_ACCOUNT_ONLY`, 남의/없는 계정은 404
`TRADING_ACCOUNT_NOT_FOUND`). 기존 금융 무결성 게이트(`assertGeneralAccountReady`)를
통과해야 응답하며 손상 시 실패한다.

```json
{ "success": true, "data": { "tradingAccountId": "…", "quests": [{
  "questId": "common-01-trading-funds",
  "status": "not_started | in_progress | completed",
  "completedStepCount": 0, "totalStepCount": 2,
  "steps": [
    { "stepId": "fx_krw_to_usd", "completed": false, "completedAt": null, "referenceId": null },
    { "stepId": "transfer_securities_usd_to_crypto_spot_usd", "completed": false, "completedAt": null, "referenceId": null }
  ] }] } }
```

퀘스트 테이블·상태 저장·보상·해금은 없다. 진행은 매 요청마다 커밋된 금융 행에서
도출하며 GET은 아무것도 쓰지 않는다.

- 환전 단계: 같은 계정의 `ExchangeTransaction` KRW→USD 중 복합 명령
  (`WalletTransferExecuteRequest`)에 연결되지 않고, 같은 계정의 `succeeded`
  `FxExecuteRequest`가 있으며, 원장(`referenceType=exchange_transaction`)이 정확히
  증권 KRW debit `exchange_source` + 증권 USD credit `exchange_target` 두 행인
  가장 이른 건. `referenceId`=ExchangeTransaction.id.
- 이체 단계: 같은 계정의 `WalletTransfer` 중 복합 명령이 아니고, 원천이 이 계정의
  증권 USD 지갑, 대상이 이 계정의 암호화폐 현물 USD 지갑이며, `executedAt`이 위 환전보다
  엄격히 늦고, 원장(`referenceType=wallet_transfer`)이 정확히 해당 두 지갑의
  debit/credit인 가장 이른 건. 선물 지갑·역방향·다른 계정 이체는 제외.
- 복합 FX+이체 명령은 두 단계 어느 쪽에도 인정하지 않는다(각 실습을 따로 수행).
- 견적·실패·롤백된 명령은 행을 남기지 않으므로 인정될 수 없다. 잔액 변화는 근거가 아니다.
- 멱등 재시도는 같은 커밋 행 하나를 재생하므로 중복 진행이 없다. 퀘스트 도입 전에
  이미 같은 순서로 완료한 초보계정도 같은 규칙으로 복원된다.
- `executedAt`은 계정 잠금 뒤 DB `clock_timestamp()`로 기록되어 두 명령이 계정 행
  잠금으로 직렬화되므로 시간 순서가 실행 순서다.

화면 문구·단계 구성(지갑 역할·환전 개념 학습 2단계 + 실습 2단계)은 클라이언트
카탈로그에 있고, 학습 단계 열람은 진행에 포함하지 않는다.

## DB 및 화면

enum 추가와 초보 사용자별 partial unique index를 별도 migration으로 적용한다.
기존 계정·원장·금융 금액의 갱신, 계정 backfill, seed 변경은 없다.
Prisma client를 재생성한다. 기존 일반·시즌 유일 제약 및 시즌 관계를 유지한다.

초보 탭은 홈/마켓/퀘스트/지갑/MY다. 퀘스트 탭은 퀘스트/가이드 세그먼트를
유지한다. 퀘스트 세그먼트는 확정된 QUEST 01(공통 기초 — 암호화폐 현물) 카드와
상세 화면(`QuestDetail`, QuestStack 전용 라우트)을 제공하고 실습은 기존
지갑 탭의 `WalletFx`/`WalletTransfer`로 이동한다. 가이드는 기존 GuideStack의
콘텐츠와 학습 화면을 사용한다. 레벨·경험치·보상·잠금/해금은 표시하지 않는다.
계정 변경 시 탭 내비게이터를 accountId로 다시 마운트하여 이전 계정의
내비게이션·입력·표시 상태를 유지하지 않는다. 쿼리는 기존 accountId scope다.

## 적용 및 검증

DB migration을 먼저 적용하고 `prisma generate`로 client를 생성한 뒤 서버를
배포한다. 새 enum을 사용하는 인덱스는 다음 migration에 분리되어 PostgreSQL의
enum commit 경계를 지킨다. 기존 데이터에 대한 DML은 없다. 이 정책 변경에는 추가 migration이 없으며
서버 배포 후 모든 로그인 사용자가 바로 초보모드를 이용할 수 있다.

초보 기반의 실제 DB 검증은 `NODE_ENV=test`,
`BEGINNER_ACCOUNT_DB_INTEGRATION=1` 및 명시적 `DATABASE_URL`로
`npm test -- --runInBand --testPathPatterns=beginner-account.integration.spec.ts`를
실행한다. 먼저 해당 테스트 DB에 `npm run test:db:prepare`를 실행한다.
스크립트는 localhost/127.0.0.1의 `*_test` DB만 허용하며, 기존 GitHub Actions의
PostgreSQL service DB(`trading_app`)도 `GITHUB_ACTIONS=true`일 때 허용한다.
기존 core account CI job에서도 이 검증을 수행한다. 임의의 원격 DB를 사용하지 않는다.

일반계정만을 대상으로 하는 과거 audit/backfill 도구는 범위를 넓히지 않았다.
초보 계정 손상은 공통 runtime integrity 검사로 차단하며 GET/재시도에서 복구하거나
재지급하지 않는다. 향후 초보 계정의 운영 복구는 별도 명시적 작업이다.
