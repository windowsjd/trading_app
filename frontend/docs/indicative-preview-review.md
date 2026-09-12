# 매수·환전 Indicative Preview 변경 보고서

검증일: 2026-09-12. 로컬 작업만 수행했으며 commit/push, GitHub 수정, 배포, 운영 DB 변경은 하지 않았다.

## A. 최초 구조

- `OrderScreen`은 매수/매도 및 시장가/지정가가 공유하는 화면이었다. REST 자산 상세 가격을 표시하고, 사용자가 `견적 확인`을 누르면 account-scoped order Quote를 생성했다. Quote와 idempotency key를 화면에 보관한 뒤 별도 실행 버튼에서 주문을 생성했다.
- `WalletFxScreen`은 `환전 미리보기`로 FX Quote를 발급하고, 별도 실행 버튼에서 환전했다. 환율 조회와 지갑 조회는 기존 React Query를 사용했다.
- 실제 금융 요청은 `/api/v1/trading-accounts/:accountId/orders/quote → orders`, `fx/quote → fx/execute`로 이어졌다. 기존 legacy API도 같은 서버 정책을 사용한다.

## B. 실제 원인/설계 판단

화면 표시값이 executable Quote 응답에 종속되어 중간 버튼이 필요했다. 예상값 계산은 입력·표시 시세·수수료 정책으로 분리할 수 있지만, Quote와 실행 검증은 그대로 필요하다.

일반 계좌의 실제 수수료율은 환경 설정에만 있었고 계좌 조회 응답에는 없었다. 따라서 임의의 0.1%를 프런트엔드에 고정하지 않고, 기존 계좌 상세 응답에 `feePolicy`를 추가했다. FX 표시의 시간 만료도 기존 서버 설정과 일치시키기 위해 현재 환율 응답에 `validUntil`을 추가했다. 새 endpoint나 schema/migration은 만들지 않았다.

## C. 변경 파일

| 파일 | 목적 |
| --- | --- |
| `frontend/src/screens/order/OrderScreen.tsx` | 매수 자동 preview, 공유 ticker 사용, 최종 버튼에서 quote→create, 입력 잠금·계좌 scope 보호 |
| `frontend/src/screens/wallet/WalletFxScreen.tsx` | FX 중간 버튼 제거, 자동 preview, 최종 quote→execute, 환율 조회 갱신·scope 보호 |
| `frontend/src/features/tradingAccount/indicativePreview.ts` | Decimal 예상 계산, 입력·최신성 검증, 긴 금액 문자열 표시 |
| `frontend/src/features/tradingAccount/quotedAction.ts` | 한 액션의 Quote/key 보존, 중복 실행 차단, Quote 응답 뒤 scope 확인 |
| `frontend/src/components/tradingAccount/PreviewAmounts.tsx` | 화면 폭·글자 배율에 따른 금액 줄바꿈 |
| `frontend/src/features/tradingAccount/api.ts` | 계좌 상세 `feePolicy` DTO |
| `frontend/src/features/wallet/api.ts` | FX `validUntil` DTO |
| `frontend/src/features/tradingAccount/indicativePreview.test.ts` | 수량/가격/환율/수수료/반올림/invalid/stale/긴 금액 테스트 |
| `frontend/src/features/tradingAccount/quotedAction.test.ts` | quote→execute, 연속 클릭, 응답 유실 재시도, scope 이탈, 서버 오류 테스트 |
| `frontend/src/components/tradingAccount/accountLayout.test.ts` | 변경된 FX callback 구조에서도 기존 scope·cache 격리 검사 유지 |
| `frontend/package.json`, `frontend/package-lock.json` | `decimal.js` 추가. 상태관리·금융 실행 프레임워크는 추가하지 않음 |
| `backend/src/trading-accounts/trading-account-access.service.ts` | 소유권 검증된 연결 시즌의 수수료 필드 조회 |
| `backend/src/trading-accounts/trading-accounts.service.ts` | detail-only 수수료 정책 응답. 일반 계좌는 기존 독립 config 재사용 |
| `backend/src/trading-accounts/trading-accounts.service.spec.ts` | 시즌 수수료 및 일반 계좌 독립 override 검증 |
| `backend/src/fx/fx.service.ts` | 현재 환율 조회 응답에 표시 유효시각 추가 |
| `backend/src/fx/fx.service.spec.ts` | 기본/override/provider/admin 유효시각 검증 추가 |
| `backend/docs/policy-decisions.md` | preview와 실행 정책 분리 문서화 |
| `backend/docs/trading-accounts-api-contract.md` | additive feePolicy 계약 |
| `backend/docs/fx-api-contract.md` | additive validUntil 계약 |
| `frontend/docs/indicative-preview-review.md` | 조사·변경·검증 및 남은 문제 기록 |

## D. Preview 구조

- 매수: 기존 공유 WebSocket의 `useAssetTicker`, `selectDisplayPrice`, ticker 최신성 판정을 재사용한다. 새로운 WebSocket은 없다. ticker가 없을 때는 기존 REST baseline만 사용하고, 유효 timestamp 및 앱의 60초 ticker 최신성 기준을 확인한다. REST 기준은 `최근 조회 시세 기준`으로 구분한다. 오래된 ticker를 새 REST 값과 섞지 않는다.
- 환전: 기존 `getCurrentFxRate(..., refresh=true)` query를 60초마다 확인한다. 서버의 source priority와 refresh 재사용 정책을 유지한다. 값이 같으면 숫자가 바뀌지 않는다. 서버 `validUntil`이 지나면 preview와 실행 버튼을 막는다.
- 수수료: 해당 accountId의 detail query에서 읽는다. 일반은 `GENERAL_TRADE_FEE_RATE`/`GENERAL_FX_FEE_RATE`, 시즌은 그 계좌 시즌의 `tradeFeeRate`/`fxFeeRate`이다.
- 주문 계산은 `gross=round8(price×qty)`, `fee=round8(gross×rate)`, `total=round8(gross+fee)`이다. FX는 받는 통화 기준 gross와 fee를 계산한 후 각 최종 필드를 round8한다. Prisma.Decimal과 같은 precision 20/ROUND_HALF_UP을 사용한다.
- 입력/가격 tick은 로컬 계산만 수행한다. Quote POST와 금융 mutation은 최종 버튼에서만 발생한다. 일반 조회 및 기존 FX provider refresh는 발생할 수 있지만 preview용 Quote row는 만들지 않는다.

## E. 실제 실행 구조

`최종 버튼 → 입력·계좌 snapshot/key 저장 → 기존 Quote endpoint → scope 재확인 → 기존 create/execute`

실행 payload에는 preview 금액을 넣지 않는다. 서버가 반환한 Quote ID와 canonical 수량/금액/지정가를 사용한다. 성공 화면과 cache invalidation은 실제 서버 응답 뒤에만 처리한다.

다음 서버 정책은 변경하지 않았다:

- Quote TTL 15초, 변동 한도 30bps.
- asset quote freshness 기본 60초, execute 10초.
- FX quote freshness 기본 300초, execute 60초. 기존 provider 우선순위 및 admin fallback 제한 유지.
- requestHash, legacy v1 hash 호환성, Quote scope/consume, idempotency replay.
- PostgreSQL authority, TradingAccount 소유권, General/Season isolation, Wallet/Ledger transaction, 잔액·수량·예약금 검증.
- asset tradability/시장시간, 자동환전 없음.

## F. 매수

- 시장가는 유효 수량 입력 즉시 예상 현재가·주문금액·수수료·결제금액을 표시하고 ticker에 따라 갱신한다.
- 지정가는 같은 화면에 있으므로 함께 적용했다. 사용자 지정가×수량으로 예상 예약금액을 계산한다. 현재가는 지정가 예약 예상액을 변경하지 않는다.
- 실제 지정가 등록은 서버가 Quote에 고정한 예약 근거를 그대로 사용한다. 성공 sheet도 해당 executable Quote를 보관한다.
- 매도는 기존 견적 확인/실행 흐름을 유지했다. 공유 입력 컴포넌트와 매수 분기 처리에 필요한 부분만 수정했다.

## G. 환전

유효 금액과 최신 유효 FX snapshot으로 자동 계산한다. KRW→USD 수수료는 USD, USD→KRW 수수료는 KRW로 표시한다. 기준시각을 함께 표시하며 FX를 실시간 ticker처럼 표현하지 않는다. 최종 `환전하기` 한 번으로 기존 서버 Quote→execute를 수행한다.

## H. Race / Idempotency

- React가 disabled 상태를 그리기 전의 연속 클릭도 동기 ref 잠금으로 막는다.
- Quote 생성부터 execute 응답 처리까지 수량·금액·주문 방식·방향 변경을 잠근다.
- 요청의 accountId, epoch, 입력, 시즌 UI 여부를 snapshot으로 보관한다. 계좌 변경/이탈 뒤 늦은 Quote는 execute를 시작하지 않는다.
- 이미 전송된 execute는 원래 계좌에서 완료된다. 다른 계좌 화면에 성공값을 표시하지 않고 원래 계좌 cache를 무효화한다.
- 응답 유실 등 결과가 불확실한 실패는 동일 Quote/key를 유지하여 명시적인 재시도가 서버 replay로 처리되게 한다. 로컬 TTL만 보고 새 Quote를 생성하지 않는다.
- 서버의 명시적인 requote 오류에서는 액션을 비운다. 다음 최종 버튼 클릭이 새 Quote를 요청한다. 자동 재시도나 optimistic financial mutation은 없다.

## I. 검증

| 검증 | 결과 | 근거/범위 |
| --- | --- | --- |
| Frontend lint | PASS | `npm run lint:accounts:check` |
| Frontend typecheck | PASS | `npm run typecheck` |
| 전체 frontend test | PASS | `npm run test`, 57개 test 파일 통과 |
| Order/FX targeted test | PASS | order/wallet 및 새 preview/action test, 7개 파일 |
| Web export | PASS | `npm run export:web`, 최종 `expo export --platform all`도 통과 |
| Android export | PASS | Hermes bundle 생성 |
| iOS export | PASS | Hermes bundle 생성 |
| 실제 화면 브라우저 검증 | PASS | 실제 React Native Web 화면·React Query·API client, API/context fixture. General/Season × Order/FX |
| 작은 화면 | PASS | Chromium 320/360/390/768px, 긴 KRW/USD/crypto, DOM text bounds 검사 및 screenshot 확인 |
| 키보드 상당 높이 | PASS | 320×360 viewport에서 입력 focus 후 최종 버튼으로 스크롤 접근 |
| Android/iOS 실기기·네이티브 키보드/APK·IPA 설치 | NOT_RUN | 해당 장치·에뮬레이터·iOS 빌드 환경 없음. Export와 구분 |
| Prisma validate/generate | PASS | schema 변경 없음 |
| Backend 계좌 scope lint | PASS | `pnpm run lint:accounts:check` |
| Backend 전체 lint | FAIL | 1,273 errors / 28 warnings. HEAD baseline과 파일·메시지별 완전 동일, 신규 finding 0 |
| Backend typecheck/build | PASS | `pnpm run typecheck`, `pnpm run build` |
| Backend unit | PASS | 188 suites / 2,693 tests. 기본 실행에서 opt-in 40개는 skip되어 통과 수에 포함하지 않음 |
| PostgreSQL integration 전체 선택 범위 | FAIL | PostgreSQL 16.15 + Redis 7, UTC, 24 suites 중 22 PASS / 2 FAIL |
| Core account integration | PASS | 계좌/시즌 소유권·연결·금융 scope·replay·portfolio/ranking/auth/ops 및 general audit |
| Order execute / FX execute / General FX | PASS | 실 PostgreSQL에서 기존 금융 안전 검사 수행 |
| 지정가 예약·race·matching·idempotent replay·no Redis | PASS | 기존 assertion 유지 |
| General trading integration | FAIL | 아래의 기존 토요일 가정 문제 |
| 지정가 transaction-time integration | FAIL | TTL 및 시즌 만료 lock-wait 검사는 통과, 시장 종료 fixture에서 기존 실패 |
| Release-critical E2E | PASS | `pnpm run test:e2e`, 126/126 |
| 외부 provider live opt-in | NOT_RUN | 실제 공급자/운영 계정에 접속하지 않음 |
| `git diff --check`, 전체 diff self-review | PASS | 변경 코드·테스트·문서 확인 |

브라우저 검증은 빈/invalid/stale, tick/환율 변경, 입력 시 POST 없음, 연속 클릭 1회 quote/execute, transport failure 후 동일 payload/key 재시도, Quote 대기 중 계좌 변경, execute 중 계좌 변경 후 늦은 성공 숨김, 지정가 현재가 독립성을 포함했다.

DB 테스트는 `/tmp`의 새 PostgreSQL/Redis 인스턴스와 별도 포트(55432/56379)에서 실행했고, `DATABASE_URL`/`REDIS_URL`을 명시해 운영 설정을 사용하지 않았다. 기존 migration만 빈 테스트 DB에 적용했다.

실패한 두 파일:

1. `backend/src/orders/general-account-trading.integration.spec.ts`
2. `backend/src/orders/limit-order-transaction-time.integration.spec.ts`

두 fixture는 실행일에 KRX custom session을 만들어 `tradable:true`를 기대한다. 검증일 2026-09-12는 토요일이며 기존 `resolveMarketSession`은 주말을 custom override 조회보다 먼저 차단한다. 변경 전 HEAD를 별도 `/tmp` 디렉터리에 풀어 같은 DB/날짜에서 두 실패를 그대로 재현했다. calendar 정책과 assertion을 변경하거나 테스트를 skip/delete하지 않았다.

검증 로그와 브라우저 fixture/screenshot은 `/tmp/trading-*.log`, `/tmp/trading-preview-tools/`에 있다. 마지막 모든 플랫폼 export는 `/tmp/trading-final-export/`이다.

## J. Self-review

- 서버 변경은 조회 필드 두 종류에 한정했다. Quote/execute/transaction/reservation 계산 코드는 변경하지 않았다.
- preview helper와 작은 실행 함수만 추가했으며 새 상태관리나 orchestration framework는 없다.
- feePolicy와 validUntil이 없는 구서버에 대해서는 임의 기본값을 쓰지 않고 preview/실행을 비활성화한다. 실제 배포 시 서버의 additive 필드를 먼저 제공해야 한다.
- 새 API 버전/테이블/DB migration/새 WebSocket/슬리피지/자동환전은 없다.
- 기존 source와 freshness 구분, 요청 snapshot, 늦은 응답 및 원래 계좌 cache 처리를 확인했다.
- 남은 사항은 기존 전체 backend lint debt, 위 두 날짜 의존 통합 테스트, 네이티브 실기기 검증이다. 이번 범위 밖의 calendar 재설계나 assertion 완화로 숨기지 않았다.

## K. 최종 판정

**거의 완료 — 남은 항목 있음**

요청한 매수·환전 UX 및 실행 안전장치 구현은 완료했다. 다만 완료 조건의 관련 테스트 전체 Green을 선언할 수 없다. 기존 코드에서도 재현되는 두 DB 통합 실패와 네이티브 실기기 검증이 남아 있다.
