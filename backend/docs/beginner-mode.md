# 초보모드 기반 계약

`beginner`는 사용자당 평생 하나인 독립 TradingAccount다. 일반·시즌계정과
금융 행을 공유하거나 이전하지 않는다. 시즌 참가·랭킹·티어·정산·보상과
광고 보상에서 제외한다. 퀘스트·기능 해금 정책은 미정이며 구현하지 않는다.

## 개발 환경 활성화 경계

기본 비활성. `NODE_ENV=development` 또는 `test`이면서
`BEGINNER_MODE_ENABLED=true`일 때만 신규 개설 및 계정 목록 노출을 허용한다.
production에서는 항상 비활성이다. 계정 목록의 `beginnerModeEnabled`를
클라이언트 진입 표시의 근거로 사용한다. 이는 개발 검증용 접근이며 기능
해금 판정이 아니다. 이미 소유한 계정의 조회·취소·청산 및 커밋된 명령 재시도는
자금 관리 안전성을 위해 유지하며 신규 거래는 비활성 경계에서 거절한다.

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

## DB 및 화면

enum 추가와 초보 사용자별 partial unique index를 별도 migration으로 적용한다.
기존 계정·원장·금융 금액의 갱신, 계정 backfill, seed 변경은 없다.
Prisma client를 재생성한다. 기존 일반·시즌 유일 제약 및 시즌 관계를 유지한다.

초보 탭은 홈/마켓/퀘스트/지갑/MY다. 퀘스트의 첫 화면은 퀘스트/가이드
세그먼트와 준비 상태를 제공한다. 가이드는 기존 GuideStack의 콘텐츠와
학습 화면을 사용한다. 실제 퀘스트·진행률·레벨·잠금/해금 상태는 표시하지 않는다.
계정 변경 시 탭 내비게이터를 accountId로 다시 마운트하여 이전 계정의
내비게이션·입력·표시 상태를 유지하지 않는다. 쿼리는 기존 accountId scope다.

## 적용 및 검증

DB migration을 먼저 적용하고 `prisma generate`로 client를 생성한 뒤 서버를
배포한다. 새 enum을 사용하는 인덱스는 다음 migration에 분리되어 PostgreSQL의
enum commit 경계를 지킨다. 기존 데이터에 대한 DML은 없다. 운영 활성화는
이번 작업의 범위가 아니며 플래그만 true로 바꿔도 production에서는 열리지 않는다.

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
