# 초보모드 기반 계약

`beginner`는 사용자당 평생 하나인 독립 TradingAccount다. 일반·시즌계정과
금융 행을 공유하거나 이전하지 않는다. 시즌 참가·랭킹·티어·정산·보상과
광고 보상에서 제외한다. 공통 기초 6개는 순차 진행하며, QUEST 06 완료 후
한국주식·미국주식·선물 롱·숏 실습은 서로 독립적으로 진행한다. 보상은 없다.
모든 거래 기능은 10개 퀘스트를 모두 완료해야 열린다(아래 단계별 학습 권한).

## 단계별 학습 권한 (B차, 2026-10-18 — 현행)

10개 퀘스트를 모두 완료하기 전에는 **지금 진행 중인 퀘스트 실습에 필요한 신규
거래만** 허용한다. 서버(`BeginnerQuestEvidence` → `beginnerLearningPermissions`)가
커밋된 금융 증거만으로 판단하는 유일한 기준이며, 클라이언트가 보낸 단계·안내
상태는 근거가 아니다. 판단은 각 명령의 기존 계정 잠금 안에서 다시 수행한다.

| 시점 | 새로 허용하는 명령 (`learningPermissions` 키) |
| --- | --- |
| 항상 | 환전 KRW↔USD (`exchange`; QUEST 01 실습·후속 실습 자금 준비) |
| QUEST 01 완료 후 | 같은 계정 USD 지갑 간 이체 (`transfer`; 현물·선물 지갑 자금 준비 포함) |
| QUEST 02 완료 ~ QUEST 05 완료 전 | 암호화폐 현물 시장가 BUY (`cryptoMarketBuy`; QUEST 03 실습, QUEST 04·05에서 실습 보유분을 다시 마련) |
| QUEST 03 완료 ~ QUEST 04 완료 전 | 암호화폐 현물 손절가/익절가 등록 (`spotProtection`; 독립형 설정·진입 계획·기존 OCO) |
| QUEST 05 완료 ~ QUEST 06 완료 전 | 암호화폐 현물 지정가 BUY (`cryptoLimitBuy`) |
| QUEST 06 완료 후 | 복합 환전+이체 (`fxTransfer`; 기존과 같은 시점, 앱은 사용하지 않음) |
| QUEST 06 완료, QUEST 07 미완료 | 국내주식 시장가 BUY (`krStockMarketBuy`) |
| QUEST 06 완료, QUEST 08 미완료 | 미국주식 시장가 BUY (`usStockMarketBuy`) |
| QUEST 06 완료, QUEST 09 미완료, 열린 롱 포지션 없음 | 선물 롱 신규 진입, 레버리지 1배 초과 (`futuresLongOpen`) |
| QUEST 06 완료, QUEST 10 미완료, 열린 숏 포지션 없음 | 선물 숏 신규 진입, 레버리지 1배 초과 (`futuresShortOpen`) |
| 10개 모두 완료 | 운영 정책 안의 모든 거래 (`allTrading`) |

- **항상 허용(위험 축소·정리):** 시장가 SELL, 보호주문·매도 설정이 발동시킨 SELL,
  선물 reduce/close, 모든 주문·보호·설정·진입 계획 취소, 커밋된 명령의 멱등 재생
  (재생 조회는 새 제한보다 먼저 처리한다).
- **모든 퀘스트 완료 전 잠금:** 사용자의 지정가·LOC SELL(포괄적 SELL 예외에서 제외),
  주식 지정가·LOC BUY, 조건부 매수, 매도 조건, 주식 손절가/익절가, 선물 지정가·조건부
  진입·손절/익절, 선물 증액, 이미 완료한 퀘스트의 실습 거래(예: QUEST 07 완료 후의
  국내주식 매수, QUEST 05 완료 후의 암호화폐 시장가 매수).
- **선물 실습:** 1배 진입은 퀘스트 증거(레버리지 1배 초과)가 아니므로 거부한다. 같은
  방향의 열린 포지션이 있으면 감소·종료만 허용하고, 종료 후 다시 진입한다. 강제청산·
  시즌정산된 실습은 증거가 아니며 열린 포지션도 없으므로 다시 진입할 수 있다.
  롱·숏은 서로 독립이다.
- **자동 실행:** 이미 접수된 선물 지정가 진입의 체결은 새 명령이 아니므로 다시
  검사하지 않는다(현물 지정가 체결과 같음; 거부하면 예약이 묶인 채 매처가 매초
  재시도한다). 조건부 매수·선물 조건부 진입의 발동은 기존처럼 발동 시점 권한으로 다시
  검사하고, 거부되면 그 감시는 `BEGINNER_FEATURE_LOCKED`로 실패 종료된다(예약 없음).
  이 정책 이전에 QUEST 06만 마치고 등록한 조건주문이 전체 완료 전에 발동되면 이렇게
  종료될 수 있다. 보호주문·매도 설정·선물 손절/익절의 발동은 위험 축소라 영향이 없다.
- **다시하기:** 완료한 퀘스트는 그 실습 명령이 지금 허용될 때만 다시 시작한다. 전체
  완료 전에는 QUEST 01·02(자금 준비)와 QUEST 04·05 단계의 QUEST 03뿐이다.
- **학습 제한과 다른 제한:** 운영 플래그(`operations`, 기능 비활성), 시장 휴장, 시세
  장애는 학습 권한과 별개로 기존 검증이 그대로 판정하고 앱도 따로 안내한다.
- **응답 계약:** `learningPermissions`(신규, 위 표)가 서버가 집행하는 권한이다.
  기존 `learningAccess` 6개 키는 배포된 앱 파서가 퀘스트 상태와 정확히 비교하므로
  의미를 바꾸지 않는다(`allTrading` = QUEST 06 완료, 집행하지 않음). 새 앱은
  `learningPermissions`가 없는 이전 서버에서는 기존 규칙(QUEST 06 = 전체)을 쓴다.
- **오류:** `BEGINNER_FEATURE_LOCKED`(403). 공개 메시지는 검토된 영문 고정 문구
  (`common/public-error-message.ts`)이며 앱은 코드 기준 한국어 안내를 표시한다.
- **배포 영향:** 서버를 먼저 배포한다. 구버전 앱은 QUEST 06 이후 잠긴 거래 버튼을
  그대로 보여 주지만 서버가 거부하고 일반 학습 안내가 표시된다(퀘스트 목록은 정상).
- **비용:** 초보 계정에서만 증거를 읽는다. QUEST 06 이후에는 심화 증거 4종과, 선물
  퀘스트가 남아 있으면 열린 방향 조회 1회가 추가된다.
- **변경 이유:** QUEST 06 완료만으로 국내·미국주식·선물·조건부·지정가 거래가 모두
  열려, 남은 심화 퀘스트를 거치지 않고 자유 거래를 할 수 있었다.

## 전체 퀘스트와 학습 접근 계약 (2026-10-11)

이번 사용자 승인 정책은 아래의 기존 QUEST 01·02 계약을 확장한다.
기존 두 퀘스트의 ID·판정·완료 기록은 유지한다. 모든 API는 `/api/v1`이다.

| ID | 금융 증거 | 추가 학습 확인 |
| --- | --- | --- |
| common-01-exchange | 기존 독립 KRW→USD 환전과 원장 | 없음 |
| common-02-transfer | 기존 환전 이후 증권→현물 USD 이체와 원장 | 없음 |
| common-03-market-buy | Q02 이후 실제 수량이 체결된 현물 crypto 시장가 BUY | 해당 주문 종목의 보유종목·수익률 확인 |
| common-04-protection | Q03 확인 이후 같은 crypto 종목의 활성화된 TP+SL(OCO) 등록, 또는 독립형 손절·익절 설정(하나로 충분, 2026-10-15) 등록 중 가장 이른 것 | 없음; 발동·취소 후에도 등록 증거 보존 |
| common-05-market-sell | Q04 이후 사용자 crypto 시장가 SELL 체결 | 보호주문·SELL 설정(조건/손절·익절)의 자동 체결 제외 |
| common-06-limit-buy | Q05 이후 crypto 지정가 BUY 접수·예약 | 해당 주문의 사용자 취소/예약 해제 또는 실제 체결 결과 확인 |
| market-kr-stock | Q06 이후 국내 주식 시장가 BUY 체결 | 없음 |
| market-us-stock | Q06 이후 미국 주식 시장가 BUY 체결 | 없음 |
| market-futures-long | Q06 이후 leverage > 1 롱 진입과 동일 lifetime 사용자 전량 종료 | 강제청산·시즌정산·보호주문 종료 제외 |
| market-futures-short | Q06 이후 leverage > 1 숏 진입과 동일 lifetime 사용자 전량 종료 | 롱과 독립 |

GET quests는 읽기 전용이며 일관된 DB snapshot에서 증거를 조회한다.
응답은 기존 `quests`와 별도의 `learningAccess`, `learningPermissions`(2026-10-18),
`operations`를 반환한다. 학습 권한은 위 「단계별 학습 권한」이 현행이다
(2026-10-11의 "QUEST 06 완료 = 그 밖의 모든 신규 거래, 이후 추가 잠금 없음"을 대체).
일반·시즌계정은 학습 검사에서 즉시 제외한다. 기존 소유권·상태·운영 플래그·
시장시간·시세·금융 위험 검증은 그대로 적용한다. 취소·시장가 SELL·발동된 SELL·
선물 reduce/close는 학습 제한에서 제외한다. 커밋된 명령 재생은 새로운 명령 제한보다
먼저 처리한다.

금융 원장에 존재하지 않는 UI 확인 두 가지만 `BeginnerQuestAcknowledgement`에
계정/step별 최초 한 행으로 저장한다. 주문과 계정을 복합 FK로 연결하고 확인 시각은
계정 잠금 후 DB 시각이다. `POST :accountId/quests/acknowledgements`의 본문은
`{stepId: "holdings_reviewed" | "limit_result_reviewed", orderId: string}`이다.
서버는 선행 완료·해당 주문의 소유권·적격 금융 증거·최종 상태를 재검증한 후 기록한다.
UI 확인은 금융 체결 증거를 대신하지 않으며 GET으로 생성되지 않는다.
재시도는 최초 확인을 유지한다. 금융 상태/계산/보상/seed는 변경하지 않는다.

`LIMIT_ORDER_ENABLED`, `CONDITIONAL_ORDERS_ENABLED`, `FUTURES_TRADING_MODE`와
각 매칭·위험 엔진 플래그는 이 작업에서 변경하지 않는다. 비활성 기능은 운영 제한으로
안내하며 학습 미완료와 구별한다. 운영 비활성이 Q04/Q06 실습을 막을 수 있다.

2026-10-15: 앱의 Q04 실습은 주문 화면 매도 주문방식 「손절가/익절가 설정」(독립형
손절·익절)이다. 응답 `operations.conditionalOrdersEnabled`는 필드 이름을 유지한 채
`INDEPENDENT_TP_SL_ORDERS_ENABLED`를 반영한다(퀘스트 카드의 운영 제한 안내 전용).
이 플래그가 꺼져 있으면 새 Q04 실습은 운영 제한으로 안내된다.

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

## QUEST 01·02 금융 증거 계약 (전체 응답 중 기존 두 항목)

`GET /api/v1/trading-accounts/:accountId/quests`: 소유자 전용, beginner 계정만
(그 외 모드는 409 `BEGINNER_QUEST_ACCOUNT_ONLY`, 남의/없는 계정은 404
`TRADING_ACCOUNT_NOT_FOUND`). 기존 금융 무결성 게이트(`assertGeneralAccountReady`)를
통과해야 응답하며 손상 시 실패한다.

```json
{ "success": true, "data": { "tradingAccountId": "…", "quests": [
  { "questId": "common-01-exchange",
    "status": "not_started | completed",
    "completedStepCount": 0, "totalStepCount": 1,
    "steps": [
      { "stepId": "fx_krw_to_usd", "completed": false, "completedAt": null, "referenceId": null }
    ] },
  { "questId": "common-02-transfer",
    "status": "not_started | completed",
    "completedStepCount": 0, "totalStepCount": 1,
    "steps": [
      { "stepId": "transfer_securities_usd_to_crypto_spot_usd", "completed": false, "completedAt": null, "referenceId": null }
    ] }
] } }
```

환전과 이체는 각각 독립된 퀘스트이며 단계는 하나씩이다(2026-10-10 분리, 이전
`common-01-trading-funds` 2단계 퀘스트를 대체). `status`·`completedStepCount`는 각
퀘스트의 단계와 일치해야 하며 클라이언트는 불일치 응답을 거부한다. 알 수 없는
questId는 무시한다. QUEST 01·02 자체의 상태 테이블·보상은 없다. 진행은 매 요청마다
커밋된 금융 행에서 도출하며 GET은 아무것도 쓰지 않는다.

- QUEST 01 환전 단계: 같은 계정의 `ExchangeTransaction` KRW→USD 중 복합 명령
  (`WalletTransferExecuteRequest`)에 연결되지 않고, 같은 계정의 `succeeded`
  `FxExecuteRequest`가 있으며, 원장(`referenceType=exchange_transaction`)이 정확히
  증권 KRW debit `exchange_source` + 증권 USD credit `exchange_target` 두 행인
  가장 이른 건. `referenceId`=ExchangeTransaction.id.
- QUEST 02 이체 단계: 같은 계정의 `WalletTransfer` 중 복합 명령이 아니고, 원천이 이 계정의
  증권 USD 지갑, 대상이 이 계정의 암호화폐 현물 USD 지갑이며, `executedAt`이 위 환전보다
  엄격히 늦고, 원장(`referenceType=wallet_transfer`)이 정확히 해당 두 지갑의
  debit/credit인 가장 이른 건. 선물 지갑·역방향·다른 계정 이체는 제외. 증명된
  환전이 없으면 이체 행은 조회하지 않으며 QUEST 02는 완료될 수 없다.
- 복합 FX+이체 명령은 두 단계 어느 쪽에도 인정하지 않는다(각 실습을 따로 수행).
- 견적·실패·롤백된 명령은 행을 남기지 않으므로 인정될 수 없다. 잔액 변화는 근거가 아니다.
- 멱등 재시도는 같은 커밋 행 하나를 재생하므로 중복 진행이 없다. 퀘스트 도입·분리
  전에 이미 같은 순서로 완료한 초보계정도 같은 규칙으로 두 퀘스트 모두 복원된다.
- `executedAt`은 계정 잠금 뒤 DB `clock_timestamp()`로 기록되어 두 명령이 계정 행
  잠금으로 직렬화되므로 시간 순서가 실행 순서다.

화면 문구와 스포트라이트 안내 단계는 클라이언트 카탈로그에 있고, 안내를 따라가거나
읽는 것은 진행에 포함하지 않는다.

## DB 및 화면

enum 추가와 초보 사용자별 partial unique index를 별도 migration으로 적용한다.
기존 계정·원장·금융 금액의 갱신, 계정 backfill, seed 변경은 없다.
Prisma client를 재생성한다. 기존 일반·시즌 유일 제약 및 시즌 관계를 유지한다.

초보 탭은 홈/마켓/퀘스트/지갑/MY다. 퀘스트 탭은 퀘스트/가이드 세그먼트를
유지한다. 퀘스트 세그먼트는 QUEST 01 환전하기와 QUEST 02 이체하기 카드를 각각의
상태·시작 버튼과 함께 보여준다(QUEST 02는 QUEST 01이 증명된 뒤 시작). 시작하면
별도 설명 화면 없이 지갑 탭의 기존 `Wallet` → `WalletFx`/`WalletTransfer` 화면으로
이동하고, 실제 컨트롤 위의 스포트라이트와 짧은 안내가 단계를 따라간다. 안내는
화면이 공개한 상태를 읽기만 하며 금융 명령을 실행·재시도·우회하지 않는다. 사용자가
직접 실행한 명령이 성공하면 이 API를 다시 읽어 완료가 증명된 경우에만 완료 연출 후
퀘스트 탭으로 돌아간다. 가이드는 기존 GuideStack의 콘텐츠와 학습 화면을 사용한다.
레벨·경험치·보상·해금은 표시하지 않는다.
계정 변경 시 탭 내비게이터를 accountId로 다시 마운트하여 이전 계정의
내비게이션·입력·표시 상태를 유지하지 않는다. 쿼리는 기존 accountId scope다.

## 적용 및 검증

DB migration을 먼저 적용하고 `prisma generate`로 client를 생성한 뒤 서버를
배포한다. 새 enum을 사용하는 인덱스는 다음 migration에 분리되어 PostgreSQL의
enum commit 경계를 지킨다. 기존 데이터에 대한 DML은 없다. 이 정책 변경에는 추가 migration이 없으며
서버 배포 후 모든 로그인 사용자가 바로 초보모드를 이용할 수 있다.

퀘스트 판정의 실제 DB 검증은 같은 조건에서
`npm test -- --runInBand --testPathPatterns=beginner-quest.integration.spec.ts`로
실행한다. 초보 기반의 실제 DB 검증은 `NODE_ENV=test`,
`BEGINNER_ACCOUNT_DB_INTEGRATION=1` 및 명시적 `DATABASE_URL`로
`npm test -- --runInBand --testPathPatterns=beginner-account.integration.spec.ts`를
실행한다. 먼저 해당 테스트 DB에 `npm run test:db:prepare`를 실행한다.
스크립트는 localhost/127.0.0.1의 `*_test` DB만 허용하며, 기존 GitHub Actions의
PostgreSQL service DB(`trading_app`)도 `GITHUB_ACTIONS=true`일 때 허용한다.
기존 core account CI job에서도 이 검증을 수행한다. 임의의 원격 DB를 사용하지 않는다.

일반계정만을 대상으로 하는 과거 audit/backfill 도구는 범위를 넓히지 않았다.
초보 계정 손상은 공통 runtime integrity 검사로 차단하며 GET/재시도에서 복구하거나
재지급하지 않는다. 향후 초보 계정의 운영 복구는 별도 명시적 작업이다.
