# 가이드 수정 및 완료 전 검토 기록

현재 구성 보완일: 2026-10-14(05 ‘기업행동과 조정주가’ 삭제와 ‘ETF와 지수’ 4챕터 개편, 시작 HEAD `fd76c0067efd399a23ef74860318769db2292754`). 04의 최초 재구성 기준 `origin/main`: `cc37e6ea20c801c3bba39aa1b233f5ef530ab944`. 후속 정확성 보완의 시작 HEAD는 `59c907b2f5a9cd668a33b1dc19ec95e82c6ac030`이다. 아래 재구성 기록은 당시 실행 이력이며, 날짜별 변경 결과는 각 절에 구분한다.
이전 검증일: 2026-09-19. 당시 조사 기준 HEAD: `554c2c18` (작업 시작 시 working tree clean). 이전 실행 수치와 브라우저 기록은 역사적 검증이며 이번 실행을 의미하지 않는다.
공식 근거와 계산 가정은 [guide-market-sources.md](./guide-market-sources.md)에 정리했다.

## 유지한 교육 구조와 수정 결과

| 주제 | 최종 강의·실습 |
| --- | --- |
| 시장기초 | 호가창과 체결 유지. 유동성과 가격 충격은 ‘같은 주문, 다른 유동성’과 ‘호가 변화와 실제 체결은 다르다’ 두 실습 |
| 캔들 | 단일 예시 캔들에 시가·고가·저가·종가·몸통·윗꼬리·아랫꼬리의 위치와 정의 연결. 그 아래 기존 캔들 만들기, 같은 OHLC/다른 경로, 5분→15분 집계 유지 |
| 주문방식 | 기존 실습·계산 유지. 초기화 표시만 ‘처음부터’로 통일 |
| 주식특성 04 | ‘장이 닫혀 있는 동안’ 한 챕터·4장 카드: 정규장 마감 → 지정가 매수 10주 가상 예약·08:30 개장 접수 → 09:00 시가와 체결 여부 → 갭 정리·더 알아보기. 선택 가격은 10,100/10,300원. 종가와 체결 건수는 가상 개장 단일가 범위로 표시 |
| ETF와 지수 05 | 4챕터. 지수는 시장의 온도계(A만/C만 +10% 예측 → 세 종목을 하나의 지수로) / ETF는 한 번에 담는 바구니(펀드와 ETF 1주 → 한 종목 −20% 충격과 분산 → 세 종목 동시 −20%) / ETF 가격은 바구니 값을 따라간다(NAV·시장가격 정의 → 지수·순자산·1주당 NAV 흐름 → 괴리율 −2/0/+2%) / ETF를 고를 때 보는 세 가지(가상 ETF X/Y 비교 → 비용과 추적차이 → 확인 목록). 예측·선택은 기록 버튼 전까지 바꿀 수 있고 기록 후 고정. 핵심 정리는 챕터당 한 번, 4챕터만 6문장 전체 요약 |

삭제한 내용:

- 유동성 실습 3, 3/10/20/30주 수량 선택·비교, SizeTrial 및 전용 상태/결과/테스트, `SIZE_ASKS`.
- 주식특성의 거래정지·VI·상한가/하한가·가격제한 강의와 라우팅 항목, 상태 및 전용 테스트.
- 독립적인 한국 제도 암기형 선택 목록과 NXT 혼합 fixture를 두 시장 비교 구조로 교체.
- 개장·마감 강의의 중복 잔량 비교를 미국 경매 비교로 교체하고 사용처가 사라진 `limitBuy` 제거. 기존 주문방식의 지정가 실습은 유지.
- 2026-10-13: 기존 주식특성 세 챕터의 거래시간 비교·개장/마감 비교·갭/음봉/표시 범위 UI와 해당 렌더 테스트 3개를 단일 챕터로 교체. 단계 순서·앞선 결과 고정·가독성 검증은 새 렌더 테스트에 옮겼다. 기존 시간대·OHLC·시간축 export와 계산 테스트는 삭제하지 않았다.
- 2026-09-19: ETF 초반 부채 선택·고급 용어 중심 흐름을 기본 개념 중심으로 교체. 추적오차의 통계 공식 표시 대신 선의 변화를 비교.
- 2026-10-14: 05 ‘기업행동과 조정주가’(주식분할과 병합·배당과 배당락·조정주가 읽기)를 대체 없이 삭제. 라우트 `CorporateActions`, `CorporateLessons.tsx`, 전용 helper `adjustOhlc`·`shareConversion`·`dividendAssets`·`eligibleDividend`·`payoutRatio`와 fixture `splitCandles`·`dividendCandles`·`dividendNotice`, 전용 테스트(렌더 3개·계산 1개)를 지웠다. ‘ETF와 지수’는 06에서 05로 당겼다.
- 2026-10-14: ETF 5챕터(지수/ETF/추종/NAV/추적)를 4챕터로 재구성. `FollowingLesson`·`NavLesson`·`TrackingLesson`, 종목별 5지선다 지수 선택지, 추적오차의 일정/변동 비교와 `differenceStats`·`stableDifferences`·`variableDifferences`, 상품정보 7개 reveal과 `productInfo`, 평가 기준시각 실습, 분배금·가격수익/총수익 설명, 공유 `etfTakeaways`를 삭제. 기존 ETF 렌더 테스트 5개는 새 테스트로 교체했다.

## 계산과 상태 검증 (2026-09-19 작성, 2026-10-14 갱신)

가이드 상세 테스트 **56개**(측정 2026-10-14): `guideLesson` 10개, `guideContent` 21개, `marketGuides` 25개 통과. 2026-09-19 당시에는 61개(9/19/33개)였다. 아래 표에서 날짜 표시가 없는 행은 2026-09-19 당시 기록이다.

| 대상 | 확인한 결과 |
| --- | --- |
| 유동성 | A 20주 평균 10,010원/마지막 10,010원. B 평균 10,021원/마지막 10,030원. 참여자의 주문 취소만으로 10,000원 유지, 실제 체결 후 10,020원. 이전 비교/취소 결과 고정 |
| 캔들 | 7개 용어가 위치에 연결되고 실습 1 이전에 표시. 기존 geometry 변경·가격 경로·집계 계산, 선택값 고정 유지 |
| 거래시간 | KRX 09:00–15:30, 미국 09:30–16:00 ET. 2026-01-07 23:30→익일 06:00 KST, 2026-07-08 22:30→익일 05:00. 두 시장의 원본 필터링과 시간축 생성, 선택 결과 고정 |
| 갭/방향 | 한국 10,000→10,700원, 미국 100→107달러 갭. 한국 종가 10,600원은 음봉이면서 전일 대비 +6%. 실제 차트와 동일한 색상 상수 사용 |
| 세션 OHLC | 각 시장에서 원본 기록 하나로 정규장/확장 범위를 계산. 원본 가격을 바꾸는 테스트에서 OHLC도 변함. 원본 불변, 빈 구간은 null |
| 지수/ETF (2026-10-14 개편) | 지수 예측: A만 +10%는 50%×10%=+5%포인트·지수 1,050, C만 +10%는 20%×10%=+2%포인트·1,020. 선택에 따라 피드백이 달라지고 기록 후 고정. 합치기 +10/0/−5% → +5/0/−1%포인트, +4%, 지수 1,000→1,040. ETF −20% 충격: 그 종목에만 1,000,000→800,000원, ETF는 A/B/C 선택별 900,000/940,000/960,000원, 세 종목 모두 −20%면 ETF도 800,000원(−20%) |
| NAV/괴리율/추적차이 (2026-10-14 개편) | 같은 +10/0/−5% 변화로 순자산 1,000,000→1,040,000원, 1주당 NAV 10,000→10,400원. NAV 10,000원 고정에서 괴리율 −2/0/+2%. 지수 +10%, ETF NAV +9.8%, 추적차이 −0.2%포인트. 1·2챕터에는 NAV·괴리율·추적차이·운용비용이 없고, 1~3챕터 핵심 정리 문장은 서로 겹치지 않음 |
| 초기화/타이머 | 모든 초기화 이름 ‘처음부터’. 2026-10-14 실행 기준 `GuideChapterScreen`의 5개 챕터(closed-market과 ETF 4개)는 전체 완료 후 초기 텍스트·선택·결과로 복귀. 기존 재생은 중복 시작·blur·reset·unmount 회귀 검사 통과(2026-09-19). 새 타이머 없음 |
| 공통 | 결과→다음 실습의 DOM 순서, 앞선 결과 freeze, 중복 testID 없음, NaN/Infinity 없음, 가이드의 서비스/API import 및 외부 요청 없음 |

## 프로젝트 품질 게이트 (2026-09-19 작성, 2026-10-14 갱신)

`frontend/`에서 실행했다. npm 스크립트나 lint 범위는 변경하지 않았다.

- `npm run check` 통과(측정 2026-10-14, 종료 코드 0): `lint:accounts:check`, `lint:guides:check` 모두 경고 0, `npm run typecheck` 통과, 전체 테스트 파일 **188개**(`src/**/*.test.ts`)·테스트 **2,523개** 통과, 실패·취소·skip 0. 2026-09-19 당시에는 81개 파일 성공이었다.
- `node src/screens/guide/guideLesson.test.ts`, `node src/screens/guide/guideContent.test.ts`, `node src/screens/guide/marketGuides.test.ts`: 위 56개 상세 사례 확인(측정 2026-10-14).
- `npm run export:web` 통과(2026-09-19 기록, 2026-10-14 미실행). 결과 `frontend/dist`는 추적 제외.
- `npx expo export --platform android --output-dir /tmp/trading-guides-revised-android` 통과(2026-09-19 기록, 2026-10-14 미실행). Hermes 번들 생성.
- `git diff --check` 통과(2026-09-19 기록). 당시 모든 변경은 `frontend/src/screens/guide`와 `frontend/docs`에 한정.

## 이전 좁은 화면·큰 글꼴과 실제 화면 조작 (2026-09-19)

2026-09-19 기준이며 2026-10-14 개편분은 재검증하지 않음. 아래의 챕터 수·흐름·스크린샷은 삭제 전 05와 개편 전 ETF 5챕터를 포함한 당시 구성의 기록이다.

기존 임시 브라우저 하네스를 재사용했다. 실제 `GuideStack`, 각 화면, `ActionPressable`, React Native Web을 Chromium/Playwright에서 실행한다. 앱 로그인 및 계정 provider와 분리된 임시 진입점이며 제품 진입점/의존성은 변경하지 않았다.

- 320×800, 기본 글꼴.
- 280×800, `Text` fontSize/lineHeight 3배 및 `useWindowDimensions().fontScale=3`인 어댑터. OS 접근성 확대를 근사한 브라우저 환경.
- 수정된 11개 챕터×2환경: **22개 전체 흐름** 성공. 조작/결과/초기화/Stack 뒤로가기/재진입 확인.
- 기존 호가창·유동성·캔들·주문방식×2환경: **8개 전체 흐름** 성공. 호가창 3주/8주 체결, 유동성 2개 실습, 캔들 3개 실습, 주문방식 전체 진행.
- 마지막 문구 정리 후 거래시간·배당·ETF 기본 3개 챕터×2환경 **6개 추가 확인**.
- 표시 중인 Text의 화면 가로 경계 초과와 hidden overflow, 중복 testID 검사 통과. 큰 글꼴에서 문장·금액이 줄바꿈되고 세로로 읽을 수 있었다.
- 캔들 용어 그림, 시간축의 회색 공백/세션 캔들, 음봉과 +6%, 배당락 직후의 평가액/권리/현금, 지급 및 배당성향, ETF 펀드→1주 구조, 지수→ETF 가치 흐름의 스크린샷을 직접 열어 확인했다.
- 외부 네트워크 요청 0, 브라우저 실행 오류 0. 수정된 챕터에는 자동 스크롤이 없으며 기존 호가 실습의 보조 스크롤은 현재 실습 안에서만 동작했다.

실행 로그와 임시 이미지: `/tmp/guide-final-check.log`, `/tmp/revised-browser.log`, `/tmp/revised-old-browser.log`, `/tmp/revised-detail.log`, `/tmp/trading-guide-browser/revised-*.png`, `/tmp/trading-guide-browser/detail-*.png`. 브라우저 하네스와 도구 설치물은 저장소에 추가하지 않았다.

물리 iOS/Android 기기·네이티브 OS 글꼴 확대·TalkBack/VoiceOver의 실제 음성 탐색은 검증하지 못했다. Android export는 실제 기기 실행 검증과 구분한다.

## 이전 완료 전 자체 검토 (2026-09-19)

| 요청 순서 | 검토 |
| --- | --- |
| 1–6 유동성 | 실습 1→평균/최종 체결·소진 결과→실습 2 주문 취소→실제 체결 결과→핵심 정리. 실습 3 없음 |
| 7–10 캔들 | 조작 전에 7개 용어와 연결선을 확인할 수 있음. 기존 만들기/경로/집계 완료, 결과 유지 |
| 11–16 주식특성 | 한국/미국 시간표·세션 캔들 전환, 서머타임, 개장/마감, 갭, 음봉+6%, 세션 OHLC 확인. 삭제한 강의는 챕터 목록·런타임 콘텐츠에 없음 |
| 17–22 기업행동 | 배당 정의→전 상태→후 권리 상태→그 아래 이후 지급일→배당성향. 지급과 배당락을 분리하고 관련 총액 중복 증가 없음 |
| 23–28 ETF | 지수 정의/가중 기여→펀드/1주→같은 구성자산의 변화→NAV/시장가격→추적 개념/상품정보 7개. 마지막 핵심 정리는 요청한 기본 6개 문장 |

다음 실습 버튼은 이전 결과 아래에 있고, 앞선 입력을 다시 변경할 필요가 없다. 비교 범위를 바꾸는 조작은 해당 실습 내부에 한정된다. 용어를 먼저 설명하고 가격·캔들·자산구성·화살표 도식으로 결과와 원인을 연결했다. 추가된 순수 helper는 시간축 생성과 배당성향 계산뿐이며 새로운 상태관리/차트/애니메이션 라이브러리나 범용 엔진은 없다.

실제 TradingAccount/Wallet/Position/Ledger/주문·quote·캔들 API/실시간 시세/기업행동 처리는 사용하지 않는다. 실제 거래시간 정책·휴장 정책·자산평가·주문 가능 여부·backend·DB·migration은 변경하지 않았다. 관련 없는 diff 없음.

## 이전 변경 파일 목록 (2026-09-19, 19개)

화면·교육 그림:

- `frontend/src/screens/guide/LiquidityScreen.tsx`
- `frontend/src/screens/guide/CandleFigures.tsx`
- `frontend/src/screens/guide/CandlesScreen.tsx`
- `frontend/src/screens/guide/StockLessons.tsx`
- `frontend/src/screens/guide/CorporateLessons.tsx` (2026-10-14 삭제)
- `frontend/src/screens/guide/EtfLessons.tsx`
- `frontend/src/screens/guide/MarketBasicsScreen.tsx`
- `frontend/src/screens/guide/OrderTypesScreen.tsx`
- `frontend/src/screens/guide/MarketLessonUi.tsx`

챕터 연결·데이터·계산:

- `frontend/src/screens/guide/GuideChapterScreen.tsx`
- `frontend/src/screens/guide/guideTopics.ts`
- `frontend/src/screens/guide/lessonCalculations.ts`
- `frontend/src/screens/guide/marketLessonData.ts`
- `frontend/src/screens/guide/marketLessonCalculations.ts`

검증·문서:

- `frontend/src/screens/guide/guideLesson.test.ts`
- `frontend/src/screens/guide/guideContent.test.ts`
- `frontend/src/screens/guide/marketGuides.test.ts`
- `frontend/docs/guide-market-sources.md`
- `frontend/docs/guide-market-validation.md`

## 2026-10-13 변경 기록 · 주식특성 04

기준 `origin/main`: `cc37e6ea20c801c3bba39aa1b233f5ef530ab944`.
전용 Worktree: `/tmp/trading-guide04-closed-market-20261013`, 브랜치: `codex/guide04-closed-market-20261013`.
기존 Worktree·브랜치 목록과 미커밋 상태를 확인한 뒤 새 Worktree에서만 조사·수정·검증했다.

04는 ‘장이 닫혀 있는 동안’ 한 챕터의 장 마감/밤사이 주문/09:00 개장/정리 카드 4장으로 바꿨다. 선택은 지정가 매수 10주, 10,100원 또는 10,300원뿐이다. 예측 문제 없이 버튼을 눌러 다음 카드를 열며 진행 버튼과 주문 선택은 완료 후 잠긴다. 주문 접수·밤사이 누적·개장 결과는 이후 조작으로 바뀌지 않는다. 공용 컴포넌트와 스타일을 사용한다.

| 새 검증 | 실제 결과 |
| --- | --- |
| 10,300원 경로 | 주문 전에 시간 버튼 없음. stage 0~3 동안 현재가 10,000원·체결 0건. 쌓인 주문은 매수 170주·매도 180주. 시가 10,200원·80주 체결, 전일 대비 +2%. 내 10주는 시가에 체결되고 총 1,000원 절약 |
| 10,100원 경로 | 같은 시가 10,200원·80주 체결, 내 주문은 미체결. 두 경로에서 반대 선택의 결과도 설명 |
| 순서·결과 고정 | 주문 접수 → 주문 누적 결과 → 내 개장 결과 → 핵심 정리 순서. 이후 더 알아보기 열기/접기에도 이전 카드·결과 텍스트 유지. 내 주문은 ‘내 주문’ 텍스트와 굵기로 표시 |
| 더 알아보기·초기화 | 처음에는 닫힘. 열기/접기 확인. 열린 상태에서 ‘처음부터’를 누르면 카드 1로 돌아가며 선택·주문·추가 내용도 초기화. 공용 완료 루프에서도 초기 텍스트 복귀 확인 |
| 본문 길이 | 더 알아보기 제외, `Body`(Takeaways 포함)와 `Basis`의 한글 음절을 한 번씩 집계. 공용 캔들 Basis·출처까지 포함해 체결 경로 651, 미체결 경로 646으로 700 이하 |
| 순수 계산 | `openingBuyOrder`의 filled/unfilled/undetermined, 시가·체결량·절약액, 결과 없는 입력, 입력 배열/주문 객체 불변 확인. 기존 `callAuction`·시간대·세션 OHLC·시간축 계산 테스트 유지 |
| 큰 글꼴·격리 | 공용 루프의 1·2·3배 fontScale 가독성 검사 통과. 새 소스의 타이머·자동 스크롤·외부 요청 금지 검사와 기존 교육 모듈의 서비스 격리 검사 통과 |

삭제한 렌더 테스트는 기존 거래시간 비교(`compares Korea and the US…`), 개장·마감 비교(`collects without execution…`), 갭/음봉/범위 비교(`renders the gap…`) 3개뿐이다. 새 렌더 테스트 3개는 각각 10,300원 체결 경로, 10,100원 미체결 경로, 4장 순서·결과 고정·추가 내용 토글을 검증하며 기존 단계 순서·결과 고정·가독성 성질을 이어받는다. 기존 챕터 목록/Stack 테스트와 완료·초기화 공용 루프는 새 챕터로 갱신했다. 순수 계산 테스트 1개를 추가했다. 신규 UI 존재 검증은 boolean으로 단언하며 큰 ReactTestInstance를 null/undefined와 직접 비교하지 않는다. 테스트 삭제·skip·실패 무시로 검증을 줄이지 않았다.

이번에 `frontend/`에서 실행한 검사:

- `npm run typecheck`: 통과.
- `npm run lint:guides:check`: 경고 0으로 통과.
- `node src/screens/guide/marketGuides.test.ts`: 32개 통과.
- `node src/screens/guide/guideContent.test.ts`: 21개 통과.
- `node src/screens/guide/guideLesson.test.ts`: 10개 통과. 개별 상세 테스트 합계 63개, 실패·skip 0.
- `npm run check`: 종료 코드 0. `lint:accounts:check`·`lint:guides:check` 경고 0, typecheck 통과, 전체 테스트 파일 186개 통과/실패·skip 0. npm 스크립트와 lint 범위는 변경하지 않았다.
- `git diff --check`: 통과. 전체 diff와 status를 검토했으며 변경 파일은 frontend의 가이드 소스 5개·문서 2개뿐이다.
- `rg`로 frontend 전체 `src`·`test`·`docs`를 조사했다. 제거한 챕터 id·레슨 export·전용 testID 참조는 남지 않았다. 다른 기능의 `market-session-summary`, `execution-gap-protection`과 일반 영어 단어/계산 주석은 관련 없는 기존 참조다.

Chromium/Playwright 임시 하네스는 이 Worktree의 실제 `GuideChapterScreen`, `AppearanceProvider`, 공용 컴포넌트와 React Native Web을 사용했다. 기존 Text/fontScale 어댑터와 외부 임시 브라우저 도구·라이브러리·한글 폰트를 재사용했으며 제품 소스/의존성/진입점은 바꾸지 않았다.

- 320×800, 기본 글꼴/3배 글꼴 각각에서 10,300원·10,100원 전체 흐름, 총 4개 성공.
- 단계별 현재가·체결 수, 선택 잠금, 결과 고정, 더 알아보기 토글, 처음부터 초기화 확인.
- 텍스트의 가로 화면 경계 초과/잘림과 중복 testID 없음. 브라우저 실행 오류 0, 외부 요청 0.
- 기본 화면과 3배 글꼴 결과 스크린샷을 직접 열어 확인했다. 큰 글꼴은 세로 스크롤로 이어 읽는다.
- 실행 로그: `/tmp/guide04-marketGuides.log`, `/tmp/guide04-guideContent.log`, `/tmp/guide04-guideLesson.log`, `/tmp/guide04-check.log`, `/tmp/guide04-browser.log`. 임시 하네스·결과·이미지는 `frontend/dist/guide04-browser` 아래이며 추적 제외다.

실기기 iOS/Android, 네이티브 OS 접근성 글꼴 확대, TalkBack/VoiceOver, 전체 앱 로그인/실계정 흐름, Expo web/Android export는 이번에 실행하지 않았다. 브라우저의 3배 글꼴은 OS 확대를 근사한 어댑터이며 이 검증과 구분한다.

사용처가 사라진 `calendarCases`, `marketExamples`, `sessionTrades`, `usSessionTrades`, `sessionOhlc`, `sessionTimeline` export는 보존한다. `SessionTrade` 타입은 기존 데이터/helper에서 계속 사용하며 `usTradingSession`은 04에서만 빠졌고 06 NAV에서 계속 사용한다. `callAuction`과 주문 fixture, `VERIFIED_ON('2026-09-19')`은 변경하지 않았다. KRX의 가격·시간 우선 문장과 Coinbase의 암호화폐 24/7 설명만 2026-10-13에 확인해 출처 문서에 기록했으므로 근거 미확인으로 뺀 문장은 없다.

이번 변경 파일:

- `frontend/src/screens/guide/guideTopics.ts`
- `frontend/src/screens/guide/GuideChapterScreen.tsx`
- `frontend/src/screens/guide/StockLessons.tsx`
- `frontend/src/screens/guide/marketLessonCalculations.ts`
- `frontend/src/screens/guide/marketGuides.test.ts`
- `frontend/docs/guide-market-sources.md`
- `frontend/docs/guide-market-validation.md`

## 2026-10-13 후속 변경 기록 · 교육 내용 정확성 보완

전용 Worktree `/tmp/trading-guide04-closed-market-20261013`와 브랜치 `codex/guide04-closed-market-20261013`, HEAD `59c907b2f5a9cd668a33b1dc19ec95e82c6ac030`의 일치와 시작 시 미커밋 변경 없음부터 확인했다. 아래는 초기 재구성 이후의 문구 보완 기록이다.

밤사이 주문을 실제 KRX 호가 접수로 오해하지 않도록 ‘가상 예약’으로 표현한다. 기존 `stage`를 이용해 0~2는 ‘가상 예약’, 3(08:30)은 ‘거래소 개장 주문 접수’라고 표시하는 설명 행만 더했다. 새로운 예약·전송 상태나 실제 처리 로직은 없다. 카드 1과 정리에서 가상 준비 → 08:30 접수 → 09:00 체결 여부의 흐름을 안내하고, 상단 Basis에서 개장 단일가만 다루는 가상 예제임을 명시한다.

| 보완 대상 | 변경 전 → 변경 후 |
| --- | --- |
| 챕터 소개 | ‘개장 때 한 가격으로 체결되는 과정’ → ‘시가 결정과 내 지정가 주문의 체결 여부’ |
| 야간 주문 | ‘주문 접수’ → ‘가상 예약 완료’. 실제 증권사 예약주문의 시간·처리 방식은 이용하는 증권사에서 확인하도록 더 알아보기에서 안내 |
| 종가·체결 수 | ‘오늘의 마지막 가격’/‘현재가’/‘장 마감 후 체결’ → ‘정규장 종가’/‘전일 정규장 종가’/‘예제 속 체결’. 더 알아보기에서 KRX의 별도 시간외 거래와 0건의 범위를 설명 |
| 내 체결 결과 | ‘낸 가격보다 1,000원 싸게’ → ‘10,300원 지정가 매수 10주가 주당 10,200원에 체결’, ‘주당 100원, 10주 전체는 총 1,000원 싸게’ |
| 같은 가격 | 체결되는 주문에 같은 시가를 적용하며, 같은 가격에서는 접수 순서에 따라 일부만 체결될 수 있다고 Basis에서 안내. 동일 지정가 전량 체결을 보장하지 않음 |

기존 카드 4장과 순서, 10주·두 가격 선택, 버튼으로 시간 3단계 진행, 선택 잠금, 앞선 결과 고정, 더 알아보기 토글·처음부터 초기화를 유지했다. 두 경로 모두 시가 10,200원·전체 체결량 80주·전일 정규장 종가 대비 +2%이며, 10,300원은 10주 전량 체결, 10,100원은 미체결이다. 주당 가격 차이는 기존 `openingBuyOrder` 결과의 `saved / quantity`, 전체는 `saved`로 표시한다. 계산 함수·주문 fixture·같은 가격의 `undetermined` 정책·05/06 챕터와 라우팅·`VERIFIED_ON('2026-09-19')`은 변경하지 않았다.

기존 렌더 테스트에서 가상 예약/08:30 접수 단계, 종가 기준값/예제 체결 수, 주당/전체 차이, 실제 시간외 거래 안내 및 동일 지정가의 일부 체결 가능성을 추가로 확인했다. 기존 계산·순서·결과 고정·초기화·글꼴 1/2/3배 검증은 유지했다. 테스트 삭제·skip·단언 완화 없음. 수정한 UI 존재 단언은 boolean이며 큰 객체를 null/undefined와 직접 비교하지 않는다.

중단 전 실행 기록(작업 도중 Worktree의 브랜치·HEAD가 변경되었으므로 지정 기준에서의 최종 완료 기록과 구분):

- `npm run typecheck`: 통과.
- `npm run lint:guides:check`: 경고 0으로 통과.
- `node src/screens/guide/marketGuides.test.ts`: 32개 통과.
- `node src/screens/guide/guideContent.test.ts`: 21개 통과.
- `node src/screens/guide/guideLesson.test.ts`: 10개 통과. 개별 상세 테스트 합계 63개, 실패·취소·skip 0.
- `npm run check`: 종료 코드 0. `lint:accounts:check`·`lint:guides:check` 경고 0, typecheck와 전체 테스트 파일 188개 통과, 실패·취소·skip 0. 위 초기 재구성의 186개는 당시 기록이며 이번 실행 수치와 구분한다.
- `git diff --check`: 통과. 이번에 수정한 5개 파일의 전체 diff를 검토했다.
- 더 알아보기 제외, `Body`(Takeaways 포함)와 `Basis`를 한 번씩 집계한 한글 음절: 체결 646자, 미체결 644자. 공용 캔들 Basis와 출처까지 포함해 700자 이하.

기존 Chromium/Playwright 임시 하네스를 같은 Worktree의 `frontend/dist/guide04-accuracy`로 복사해 최신 소스를 번들링했다. 실제 `GuideChapterScreen`·`AppearanceProvider`·공용 UI와 React Native Web을 사용하며 제품 진입점/의존성을 변경하지 않았다.

- 320×800, 글꼴 1배·3배 각각에서 체결·미체결 경로 **4개 통과**.
- 단계별 종가/0건/가상 예약·개장 접수 표시, 선택 잠금, 시가/체결량/주당·총액 결과, 이전 결과 고정, 더 알아보기 열기·접기 및 초기화 확인.
- 표시된 텍스트의 가로 경계 초과·잘림·중복 testID 없음, 브라우저 오류 0, 외부 요청 0. 3배 결과 이미지를 직접 열어 확인했으며 긴 문장은 세로 스크롤로 이어 읽는다.
- 실행 로그·결과·이미지는 `frontend/dist/guide04-accuracy`에 보관하며 추적 제외다. 이번 테스트에서 메모리 급증이나 비정상 종료는 없었다.

미실행: 실기기 iOS/Android, 네이티브 OS 글꼴 확대와 TalkBack/VoiceOver, 전체 앱 로그인·실계정 흐름, Expo web/Android export. 브라우저 3배는 OS 접근성 확대를 근사한 기존 어댑터이며 실기기 검증과 구분한다.

이번 수정 파일은 `StockLessons.tsx`, `guideTopics.ts`, `marketGuides.test.ts`, 이 문서와 `guide-market-sources.md`의 5개뿐이며 모두 frontend 안에 있다. KRX 공식 근거의 이번 확인 범위는 출처 문서에 별도로 기록했다. 같은 가격의 배분·체결 시각의 세부 규칙·시간외 거래 상세는 구현 범위 밖으로 유지한다. 초기 요청에 따라 중단 전에는 Commit·Push·Merge·PR 생성을 수행하지 않았다. 이후 사용자가 Commit·Push를 요청하여 최종 검증과 게시를 재개했다.

중단 전 본문과 추가 설명을 처음부터 다시 읽고, 가상 예약/거래소 접수/체결의 구분과 문서·화면의 일치를 검토했다. 수정 전후 상태 선언·단일가 입력·이벤트 처리 코드를 대조해 동일함을 확인했으며 계산/데이터/공용 UI/라우팅/05·06 소스의 diff는 없다. 기존 테스트의 기능 검증을 삭제하거나 약화하지 않았고 새 스타일·라이브러리·예약 시스템·불필요한 추상화도 없다. 다만 최종 Git 확인에서 브랜치 `integration/guide04-long4h-20261013`, HEAD `31894fe19ef3ad6ae3007e2b3bd2111ef14832e9`로 변경된 사실을 발견해 작업을 중단했다. 당시 HEAD가 시작 HEAD와 같다는 문장은 잘못된 기록이므로 정정한다. Codex는 이 브랜치 전환·Merge·복구를 수행하지 않았고, 가이드 수정 5개 파일은 미커밋 상태로 보존했다. main과 다른 Worktree는 수정하지 않았다.

## 2026-10-13 재개 · 지정 브랜치에서 최종 검증

사용자의 Commit·Push 요청 후 같은 Worktree를 다시 확인했다. 이미 원래 브랜치 `codex/guide04-closed-market-20261013`와 HEAD `59c907b2f5a9cd668a33b1dc19ec95e82c6ac030`로 돌아와 있었고, 가이드 보완 5개 파일은 그대로 미커밋 상태였다. `git fetch origin` 후 원격 작업 브랜치도 동일한 HEAD임을 확인했다. Codex는 checkout/reset/복구를 수행하지 않았다.

원래 기준에서 재실행한 검사:

- `npm run typecheck`, `npm run lint:guides:check`: 통과, lint 경고 0.
- 개별 `marketGuides` 32개, `guideContent` 21개, `guideLesson` 10개: 합계 63개 통과, 실패·취소·skip 0.
- `npm run check`: 종료 코드 0. 두 lint 경고 0, typecheck 및 전체 테스트 파일 186개 통과, 실패·취소·skip 0. 중단 전의 통합 브랜치 기준 188개와 구분한다.
- 기존 Chromium 하네스: 320×800, 글꼴 1배/3배, 체결·미체결 4개 흐름 통과. 가로 넘침·잘림·중복 testID·브라우저 오류·외부 요청 없음. 최신 결과 이미지를 직접 확인했다.
- 본문 한글 음절 646/644자 유지. 상태 선언·이벤트 처리·단일가 입력, 계산·fixture·공용 UI·05/06·라우팅 불변을 다시 확인했다. 테스트 삭제·skip·단언 완화 없음.
- `git diff --check`와 5개 파일 전체 diff 자체 검토 통과. 검증 전후 HEAD·브랜치·HEAD reflog 및 검증한 소스 해시가 동일함을 확인해 지정 기준에서의 최종 검증을 확정했다. 중단으로 남았던 검증 기록·Git 상태 정합성 확인을 완료했다.

재개 실행 로그와 브라우저 결과는 추적 제외인 `frontend/dist/guide04-accuracy-final`에 보관한다. 실기기·네이티브 접근성·전체 앱 로그인/실계정·Expo export 미실행 범위는 위 기록과 같다. 검증 후 가이드 보완 5개 파일만 원래 작업 브랜치에 커밋하고 해당 브랜치만 Push한다. main·다른 Worktree 수정, Merge 및 PR 생성은 수행하지 않는다. 최종 게시 커밋과 Push 상태는 Git 기록 및 완료 보고로 확인한다.

## 2026-10-14 보완 · 실제 거래소 개장 방식과 Trading Class 모의 체결 구분

04는 KRX 개장 단일가(10,300원 지정가 매수가 시가 10,200원에 체결)를 설명하지만, Trading Class에서 장이 닫혀 있을 때 낸 지정가 매수는 다음 정규장을 기다린 뒤 앱의 체결 기준으로 처리된다. 신선한 시세가 지정가에 닿으면 그 시세로, 마감된 5분봉이 지정가에 닿으면 지정가로 체결되며 개장 단일가는 없다(`backend/src/orders/market-hours.policy.ts`, `limit-order-matching.service.ts`). 기존 문구는 이 차이를 말하지 않아 학습자가 앱의 모의 주문도 시가로 체결된다고 이해할 수 있었다.

- 카드 3 결과 아래 본문 한 줄: “이 체결은 실제 거래소의 개장 방식입니다. Trading Class의 모의투자 주문은 개장 단일가를 거치지 않습니다.” 체결·미체결 두 경로 모두 표시된다.
- 더 알아보기에 앱의 실제 처리(다음 정규장 대기, 시세 또는 지정가 체결, 경쟁하는 개장 단일가 없음) 한 단락을 추가했다.
- 계산·예제 값·카드 순서·결과 고정·초기화·더 알아보기 토글·접근성 라벨과 주문·체결 엔진은 바꾸지 않았다.

검증: 본문 한글 음절 684/682자(700 이하). `marketGuides` 32·`guideContent` 21·`guideLesson` 10개 통과, `lint:guides:check`·`typecheck` 통과. 실제 `GuideChapterScreen`의 RN Web 렌더링 48개 조합(320/360/390/430px × Light/Dark × 글꼴 1/1.5/2배 × 두 가격 경로)에서 새 두 문장 표시, 가로 넘침·잘림·말줄임 없음, 최소 대비 5.97:1, 외부 요청 0. 숫자와 단위가 줄바꿈으로 갈라지는 현상(예: `20`/`주`)은 변경 전 HEAD와 동일하게 38개 조합에서 관찰되며 새 문장에는 숫자·단위가 없다. 이 기존 현상과 실기기·네이티브 글꼴 확대 확인은 별도 과제로 남긴다.

## 2026-10-14 변경 기록 · 05 삭제와 ‘ETF와 지수’ 4챕터 개편

`main` 체크아웃(HEAD `fd76c0067efd399a23ef74860318769db2292754`, 작업 트리 clean)에서 바로 작업했다. 04 작업(`59c907b2`·`33d4d81f`·`2bd7071e`)은 커밋된 상태 그대로 두었고 새 Worktree·브랜치·커밋은 만들지 않았다.

시작 전 기준선(같은 날 실행): `guideLesson` 10개, `guideContent` 21개, `marketGuides` 32개, 합계 63개 통과. `npm run typecheck` 통과. 참고로 `MainTabs` 18개 통과, `lint:guides:check` 경고 0.

05 ‘기업행동과 조정주가’는 대체 없이 지웠고 ‘ETF와 지수’를 05로 당겼다. ETF는 4챕터로 다시 만들었다. 분산의 ‘왜’를 2챕터 충격 실습으로 보여 주고, 지수 예측·충격 기업·괴리율 가격·ETF X/Y 선택은 기록 버튼 전까지 바꿀 수 있으며 기록 후 선택지가 잠기고 결과가 고정된다. 처음에는 정의 Section과 첫 실습만 보이고 이후 Section·결과·핵심 정리는 버튼으로만 열린다. 용어는 정의한 챕터부터 쓴다(분산 2챕터, NAV·괴리율·추종 3챕터, 추적차이 4챕터). 핵심 정리는 챕터당 한 번이며 1~3챕터는 서로 다른 3문장, 4챕터만 6문장 전체 요약이다. 공용 `Section`·`Body`·`Result`·`LessonAction`·`Takeaways`·`Values`·`Basis`·`Choices`·`LessonPlot`과 기존 `Flow`만 사용했고, 새 스타일·라이브러리·타이머·애니메이션·자동 스크롤은 없다.

| 테스트 변경 | 내용 |
| --- | --- |
| 삭제(05 전용) | 렌더 3개(`applies split/reverse…`, `teaches dividends…`, `adjusts all OHLC values…`)와 계산 1개(`conserves conversion value…`). 대상 화면·helper가 함께 삭제되어 검증할 대상이 없다 |
| 단언만 삭제 | `filters the same trades…`의 `adjustOhlc` 블록(불변 검사는 `JSON.stringify(sessionTrades)`로 유지), `builds both market timelines…`의 `payoutRatio` 3줄, 계산 테스트의 `differenceStats` 단언(제목에서 dispersion 제거). `changeRate(10000, 10980) − changeRate(1000, 1100) ≈ −0.2`는 유지 |
| 교체 | 기존 ETF 렌더 5개 → 메타(4챕터·번호 05/04·삭제된 토픽/챕터 없음), `index`, `etf`, `etf-price`, `etf-pick`, 1~3챕터 핵심 정리 중복 없음, 4챕터 전체 완료 후 `추적오차`·`분배금`·`총수익` 없음의 7개 |
| 공용 루프 | `completionActions`를 새 4챕터로 바꿔 `처음부터` 라벨, 글꼴 1·2·3배 `readable`, 초기화 후 초기 텍스트 복귀를 5개 챕터에서 확인 |
| 스펙 외 최소 수정 | `guideLesson`의 홈 글꼴 테스트가 가이드 번호 6개를 세고 있어 5개로, `MainTabs`의 GuideStack 화면 수 10을 9로 바꿨다. 둘 다 05 삭제의 직접 결과이며 다른 단언은 그대로다 |

새·수정 테스트의 UI 존재 단언은 `=== undefined`의 boolean으로 비교하고 비활성 여부는 `props.disabled` 원시값으로 비교한다. 큰 ReactTestInstance를 null/undefined와 직접 비교하지 않는다. 테스트 삭제는 위 05 전용 항목뿐이며 skip·실패 무시·단언 완화는 없다. 소스를 일부러 4가지로 망가뜨려(같은 피드백, 기록 후 선택지 활성, 4챕터에 `추적오차` 추가, 2챕터가 1챕터 정리 문장 반복) 각각 해당 테스트가 실패하는 것을 확인한 뒤 원본으로 복원했다(복원 후 파일 동일 확인).

이번에 `frontend/`에서 실행한 검사(2026-10-14):

- `npm run typecheck`: 통과.
- `npm run lint:guides:check`: 경고 0으로 통과.
- `node src/screens/guide/guideLesson.test.ts`: 10개 통과(기준선 10).
- `node src/screens/guide/guideContent.test.ts`: 21개 통과(기준선 21).
- `node src/screens/guide/marketGuides.test.ts`: 25개 통과(기준선 32 − 삭제·교체 16 + 신규 9).
- `node src/app/navigation/MainTabs.test.ts`: 18개 통과(기준선 18).
- `npm run check`: 종료 코드 0. 두 lint 경고 0, typecheck 통과, 테스트 파일 188개·테스트 2,523개 통과, 실패·취소·skip 0.
- `git diff --check` 통과. 변경은 `frontend/src/screens/guide`, `frontend/src/app/navigation`, `frontend/docs`에만 있다.
- 잔여 참조 검색(`src`·`docs`): 제거한 레슨·helper·fixture·라우트 이름은 `src`에서 새 테스트의 ‘없음’ 단언에만 남는다. `docs`에서는 날짜가 붙은 기록(2026-09-19 절, 이 절, 삭제 항목, 과거 파일 목록의 삭제 표시)에만 남는다.
- 모든 테스트는 프로세스 전체에 메모리·시간 제한(`systemd-run --user --scope -p MemoryMax=…`, `timeout`)을 걸고 실행했다. 메모리 급증이나 비정상 종료는 없었다.

출처 확인(2026-10-14): investor.gov ‘Diversify Your Investments’에서 분산이 한 투자의 손실을 줄일 수 있지만 시장 하락 시 손실을 막는다고 보장하지 않는다는 설명을 확인해 2챕터 출처를 `SEC ETF, SEC 분산투자`로 넓혔다. ‘ETF는 원금이 보장되는 상품이 아닙니다’는 기존 ETF 공지(investor-bulletins-24) 본문에는 없고, investor.gov ‘Exchange-Traded Funds (ETFs)’ 기본 페이지에서 확인했다. 두 출처는 [guide-market-sources.md](./guide-market-sources.md) 표에 확인일과 함께 추가했다.

미실행: Chromium/RN Web 실제 화면 조작과 좁은 화면·큰 글꼴 확인, 실기기 iOS/Android, 네이티브 OS 글꼴 확대, TalkBack/VoiceOver 읽기, Expo web/Android export. 위 2026-09-19 브라우저 기록은 개편 전 구성이다.

이번 변경 파일:

- `frontend/src/screens/guide/CorporateLessons.tsx` (삭제)
- `frontend/src/screens/guide/EtfLessons.tsx`
- `frontend/src/screens/guide/GuideChapterScreen.tsx`
- `frontend/src/screens/guide/guideTopics.ts`
- `frontend/src/screens/guide/marketLessonCalculations.ts`
- `frontend/src/screens/guide/marketLessonData.ts`
- `frontend/src/screens/guide/marketGuides.test.ts`
- `frontend/src/screens/guide/guideLesson.test.ts`
- `frontend/src/app/navigation/GuideStack.tsx`
- `frontend/src/app/navigation/types.ts`
- `frontend/src/app/navigation/MainTabs.test.ts`
- `frontend/docs/guide-market-sources.md`
- `frontend/docs/guide-market-validation.md`

## 2026-10-14 후속 보완 · ETF와 지수 정확성과 화면 검증

시작 상태: `main`, HEAD = `origin/main` = `b4a517155bb0bb7c054b81bb898a7acb9db829c4`, 작업 트리 clean. 이전 검토 기준 `5505abfe` 이후 `frontend/src/screens/guide`와 가이드 문서의 변경은 없었다. 새 Worktree·브랜치·커밋은 만들지 않았다.

구현 의도: ETF의 분산 효과를 설명하면서 미래 수익률이나 변동성을 보장하는 것처럼 오해하지 않도록 하고, 추적차이의 원인을 정확하게 전달하며, 다양한 모바일 화면에서도 교육 콘텐츠를 온전히 읽을 수 있도록 한다.

| 대상 | 변경 전 → 변경 후 |
| --- | --- |
| 4챕터 X/Y 질문 | ‘한 업종이 크게 부진할 때 어느 쪽이 덜 흔들릴까요?’ → ‘카드에 적힌 구성만 보고 답해 보세요. 업종 분산 측면에서 더 폭넓게 구성된 ETF는 어느 쪽일까요?’ 카드만으로 판단할 수 있는 질문이다. 정답 ETF X와 선택·기록 흐름은 그대로 두었다 |
| X/Y 피드백 | ‘ETF X가 덜 흔들립니다’, ‘담은 종목이 거의 함께 내려갑니다’ 삭제 → 정답은 예측이 아닌 카드 판독이므로 ‘예상이 맞았습니다’ 대신 ‘판단이 맞았습니다’로 시작한다. 정답·오답 모두 ‘ETF X가 업종 분산 측면에서 더 폭넓게 구성’, ‘특정 업종에 집중된 위험을 낮출 수 있다’, ‘ETF Y는 그 업종의 부진에 더 직접적으로 노출’로 설명한다. 이어서 ‘업종이 넓게 나뉘어 있다는 사실만으로 손실이 더 작거나 가격이 덜 움직인다고 보장되지는 않는다’, ‘종목별 구성 비중과 상관관계(서로 얼마나 비슷하게 움직이는지)도 함께 본다’를 보인다. 원금 비보장 문장은 유지. 결과 제목은 ‘업종 분산 비교 결과’, testID는 `etf-pick-shake*` → `etf-pick-spread*` |
| 비용 구간 본문 | ‘비용은 펀드 자산에서 나갑니다. 그래서 … 지수와 조금 달라질 수 있습니다’ → 비용은 지수와 달라지는 원인 **중 하나**이고, 현금 보유와 구성종목 편입·조정 과정에서도 차이가 생길 수 있다고 설명 |
| 버튼 | ‘비용이 지수와의 차이로 나타나는 모습 보기’ → ‘지수와 ETF 수익률 차이 보기’ |
| 추적차이 결과 | 정의와 ‘원인별 비중은 추정하지 않음’ 유지. ‘편입 조정’ → ‘구성종목 편입과 조정’으로 풀고 ‘따라서 이 차이 전체를 비용 때문이라고 볼 수는 없습니다’ 한 문장 추가 |
| 4챕터 핵심 정리 3·5 | ‘분산은 한 종목의 위험을 줄이지만’ → ‘한 종목이나 한 업종에 집중된 위험을 낮출 수 있지만’. ‘비용 등의 영향으로’ → ‘비용·현금 보유·구성종목 조정 등의 영향으로’. 6문장·챕터당 한 번은 유지 |
| 출처 표시 | 4챕터 ‘SEC ETF·지수펀드, Vanguard 지수 추종’ → ‘SEC ETF·지수펀드·분산투자, Vanguard 지수 추종’. 근거 행은 [guide-market-sources.md](./guide-market-sources.md)에 추가·재확인. `VERIFIED_ON('2026-09-19')`은 변경하지 않았다 |

지수 +10%, ETF NAV +9.8%, 추적차이 −0.2%포인트, `benchmarkPath`·`fundNavPath` 정규화 그래프, ETF X/Y 카드 값, 1~3챕터 계산·문구·fixture는 바꾸지 않았다. 새 ETF·종목·수익률·변동성 수치나 예측 모델은 없다. ETF X의 연 0.2%와 −0.2%포인트는 계속 ‘별개의 예제’로 분리한다.

초기 단계 표시 정책(각 챕터의 첫 화면에 개념 설명과 첫 학습 활동을 함께 표시하고, 첫 활동의 결과와 후속 단계는 정해진 조작 전에는 숨김)은 현재 구현이 이미 충족하므로 상태 코드를 바꾸지 않았다. 1챕터는 정의와 예측, 2챕터는 정의와 ‘ETF 1주 보기’, 3챕터는 정의와 ‘구성종목 가격 변화 적용’, 4챕터는 소개와 X/Y 비교가 처음에 보인다. 결과·다음 Section·핵심 정리는 선택이나 버튼 이후에만 열린다. 기록 후 선택지가 잠기고 이전 결과가 유지되며 ‘처음부터’로 최초 화면에 돌아오는 것을 단위 테스트와 브라우저에서 확인했다.

테스트 보완(`marketGuides.test.ts`의 4챕터 렌더 테스트와 공용 완료 동작 목록): 문자열만 바꾸지 않고 새 질문, 정답·오답 피드백, 집중 위험·보장 불가·구성 비중·상관관계 문장, ‘흔들/함께 내려갑니다/덜 움직입니다/손실이 더 작습니다’ 같은 단정 표현이 없음을 확인한다. 비용 구간의 ‘원인 중 하나’, 현금·편입·조정, 기존 ‘그래서 같은 지수를 따라가도’ 문장과 ETF X·Y 비용 수치가 없음, 버튼 접근성 라벨, ‘비용 때문이라고 볼 수는 없습니다’, 기록 후 선택 상태(`selected`)도 확인한다. 소스에서 지운 두 문장(‘…거의 함께 내려갑니다’, ‘담은 종목 수가 많아도 … 분산 효과가 작을 수 있습니다’)의 기존 단언은 각각 새 집중 위험 문장과 구성 비중·상관관계 문장의 단언으로 바꿨다. 테스트 삭제·skip·단언 완화는 없다. UI 존재 단언은 기존처럼 boolean으로 비교한다. 소스 사본을 6가지로 망가뜨렸을 때(단정 피드백 복원, 옛 버튼 문구, 비용 단독 원인 문장, 보장 불가 문장 삭제, 기록 후 선택지 활성, 추적차이를 ETF X 비용과 연결) 각각 테스트가 실패하고, 원복 후 통과함을 확인했다. 작업 트리 소스는 건드리지 않았다.

`frontend/`에서 실행한 검사(모두 `systemd-run --user --scope -p MemoryMax=…`와 `timeout` 아래에서 실행했으며 메모리 급증·비정상 종료는 없었다):

| 검사 | 변경 전(HEAD) | 변경 후 |
| --- | --- | --- |
| `node src/screens/guide/guideLesson.test.ts` | 10개 통과 | 10개 통과 |
| `node src/screens/guide/guideContent.test.ts` | 21개 통과 | 21개 통과 |
| `node src/screens/guide/marketGuides.test.ts` | 25개 통과 | 25개 통과 |
| `node src/app/navigation/MainTabs.test.ts` | 18개 통과 | 18개 통과 |
| `npm run typecheck` | 통과 | 통과 |
| `npm run lint:guides:check` | 경고 0 | 경고 0 |
| `npm run check` | 종료 코드 0, 테스트 2,601개·suite 287개 통과, 실패·취소·skip 0 | 종료 코드 0, 테스트 2,601개·suite 287개 통과, 실패·취소·skip 0(최종 소스, 검사 전후 소스 해시 동일) |
| `git diff --check` | — | 통과 |

피드백 문구를 다듬기 전의 중간 `npm run check`에서는 가이드와 무관한 `src/screens/futures/FuturesLimitEntry.test.ts`의 ‘Limit B/long/cross/1 uses the account contract’(`h.requests.length` 0 !== 1) 1건이 실패했다. 이 파일과 import 경로는 이번 diff에 없다. 같은 파일을 단독 실행하면 작업 트리 3회 중 1회, 변경 없는 HEAD 사본 8회 중 1회 실패했다. Date.now를 단조 증가로 고정한 preload에서는 5/5 통과했고, 같은 시간대 시스템 로그에 ‘Clock change detected’가 약 30초마다 기록되었다. 따라서 기존의 WSL 시계 역행 간헐 실패로 분류했으며 테스트는 수정하지 않았다.

실제 화면 검증(2026-10-14): 저장소 밖 임시 하네스(Playwright + Chromium 1248, esbuild)로 실제 `GuideChapterScreen`·`AppearanceProvider`·공용 `LessonUi`/`MarketLessonUi`·`ActionPressable`을 React Native Web으로 렌더링했다. `react-native`는 기존 `test/browser/nativeWeb.jsx`로 연결해 `?fontScale=`만큼 `Text`의 fontSize·lineHeight와 `useWindowDimensions().fontScale`을 키운다. Light/Dark는 앱 저장값 `trading-app:appearance`로 지정하고 화면 배경이 해당 테마로 바뀐 뒤 검사했다. 제품 소스·진입점·의존성·npm 스크립트는 바꾸지 않았다.

- 조합: 4챕터 × 너비 320/360/390/430px(높이 800) × Light/Dark × 글꼴 1/2/3배 = **96개 전체 흐름**. 상태마다 레이아웃을 검사해 총 528개 상태를 확인했다. 1·4챕터는 최초·오답 선택·정답 선택·기록·최종·처음부터의 6개, 2·3챕터는 최초·첫 버튼 이후·선택·기록 겸 최종·처음부터의 5개 상태다.
- 흐름 단언: 최초에는 정의와 첫 활동만 보이고 결과·다음 Section·핵심 정리가 없음, 기록 버튼은 선택 전 비활성, 선택에 따른 결과 표시와 기록 후 선택지·버튼 비활성(`aria-disabled`), 다음 단계가 열린 뒤에도 앞선 결과 텍스트가 같음, 최종 핵심 정리 1개, 4챕터 그래프 두 선, 처음부터 후 최초 화면 텍스트 복귀.
- 레이아웃 검사: 모든 텍스트 노드의 실제 글자 영역(줄 끝의 매달린 공백 제외)이 화면·버튼·잘림 조상 안에 있는지 확인했다. 요소가 부모 가로 경계나 화면을 넘는지, 가로 스크롤, 서로 다른 텍스트 줄과 버튼의 겹침, 말줄임·줄 수 제한 스타일, 텍스트 대비(그라데이션 버튼과 비활성 투명도 반영), 숫자+단위 분리, 선택/미선택 배경 차이도 검사했다. 검사기가 실제로 잡는지 7가지 결함(nowrap 넘침, 음수 여백, 버튼 글자 잘림, 저대비, 단위 분리, 겹침, 말줄임)을 주입해 모두 검출되는 것을 먼저 확인했다.
- 결과: 변경 전 HEAD 사본과 변경 후 모두 96/96 흐름 통과, 528개 상태에서 잘림·넘침·겹침·가로 스크롤·말줄임·대비 문제 **0건**, 외부 요청 0, 페이지 오류 0. 활성 텍스트 최소 대비는 Light·Dark 모두 4.62:1. 실제 글꼴 최솟값은 1/2/3배에서 14/28/42px로, 배율 적용을 확인했다. 선택/미선택 배경의 휘도 대비는 Light 2.81:1, Dark 1.44:1이다. Dark에서도 선택은 채워진 배경, 미선택은 테두리만 있는 버튼이라 캡처에서 구분된다. 기록 후 비활성 버튼(투명도 0.6)의 글자 대비 최소는 Light 2.56:1이며 비활성 컨트롤이라 기준 적용 대상이 아니다. 공용 스타일이라 바꾸지 않았다.
- 대표 상태 캡처 11개 조합(4챕터, 320~430px, Light/Dark, 1~3배)의 최초·선택·최종 화면과 결과 카드·버튼·그래프·핵심 정리 요소를 직접 열어 확인했다. 정답 피드백 문구를 다듬은 뒤 최종 소스로 96개 흐름을 다시 실행해 같은 결과(문제 0건, 분리 수 동일)를 얻었고, 4챕터 4개 조합을 다시 캡처해 확인했다. 320px·3배 결과 카드는 세로로 길어지지만 잘리지 않는다.
- 이번 변경으로 고친 레이아웃 문제는 없다. 새 문구와 버튼은 모든 조합에서 위 검사를 통과했다.

변경 전과 같은 기존 현상(이번 범위 밖, 수정하지 않음):

- 숫자와 단위의 줄바꿈 분리: 528개 상태 중 192개로 변경 전후 챕터별 수가 같다. 기본 글꼴에서는 2챕터(320px `1,000,000원`, 390px `100주`)와 3챕터(320px 본문 `1주당`, 390px 계산식 `10,000원`)에서만 생긴다. 4챕터는 기본 글꼴에서 0건이고, 3배 글꼴 320·360px 최종 상태에서만 `-0.2%포인트`가 `-0.2%포`/`인트`로 나뉜다. 320px·3배 캡처에서는 그래프 축 값 `98.9~111.1`도 숫자 중간에서 줄이 바뀐다. 공용 `Text`와 `won()`/`percent()` 형식에서 한글 음절 단위 줄바꿈이 숫자 뒤에도 허용되어 생기며 01~04 가이드에도 같은 구조가 있다. 공용 형식을 바꾸는 별도 과제로 남긴다.
- 큰 글꼴의 버튼 문구는 한글 단어 중간에서 줄이 바뀔 수 있다(예: ‘수익률’). 잘림·겹침은 없다.

미검증: 실기기 iOS/Android, 네이티브 OS 글꼴 확대(브라우저 1/2/3배는 기존 어댑터의 근사), TalkBack/VoiceOver 읽기, 전체 앱 로그인·실계정 흐름, Expo web/Android export. 320px·3배의 2·4챕터 전체 화면 캡처는 16,000px 상한에서 잘렸으므로, 그 아래 구간은 요소 캡처와 DOM 검사로만 확인했다.

이번 변경 파일:

- `frontend/src/screens/guide/EtfLessons.tsx`
- `frontend/src/screens/guide/GuideChapterScreen.tsx`
- `frontend/src/screens/guide/marketGuides.test.ts`
- `frontend/docs/guide-market-sources.md`
- `frontend/docs/guide-market-validation.md`

## 2026-10-14 보완 · 숫자·단위 줄바꿈과 선택 상태 표시

시작 상태: `main`, HEAD = `origin/main` = `98a3c448081d1ab3b460b2eaae972275ea20308f`(앞섬·뒤처짐 0/0), 작업 트리 clean. 이전 검토 기준 `ae534a98` 이후의 커밋은 `98a3c448`(랭킹 탭 보완) 하나이며 가이드 소스와 가이드 문서를 바꾸지 않았다. 다른 브랜치의 Worktree는 건드리지 않았고 새 브랜치·Worktree·커밋은 만들지 않았다.

구현 의도: 금액·수량·수익률·%포인트가 숫자와 단위 사이나 단어 중간에서 끊기지 않게 하고, Dark에서도 선택된 선택지를 색 차이에 기대지 않고 알아볼 수 있게 한다. 계산·학습 흐름·접근성 정보·테마 토큰은 바꾸지 않는다.

실제 원인(가설과 비교):

| 증상 | 원인 가설 | 확인한 원인 |
| --- | --- | --- |
| 숫자·단위 분리(`100`/`주`, `-0.2%포`/`인트`, `24시`/`간`, `2026-09-`/`19`) | 공용 Text 줄바꿈 처리, 숫자 포맷 문자열, 그래프 레이블 레이아웃 제약의 복합 작용 | 포맷 문자열은 원인이 아니다. `won()`·`percent()`는 숫자와 단위를 공백 없이 붙여 반환한다. 가이드 Text는 테마 `Text`(React Native `Text`에 테마 색만 입힘)로 줄바꿈 처리가 따로 없다. 유니코드 줄바꿈 규칙(UAX #14)은 숫자·`%` 뒤의 한글 앞, 한글 음절 사이, 하이픈 뒤를 줄바꿈 가능 위치로 보며 브라우저와 Android·iOS가 이 규칙으로 줄을 나눈다. React Native에는 Android용 한글 어절 단위 줄바꿈 속성이 없다(iOS 전용 `lineBreakStrategyIOS`만 있음). `100만 원`은 문구 안의 일반 공백에서 끊겼다 |
| 그래프 축 `98.9~111.1`, 시각 범위 `15:20~15:30`이 숫자 중간에서 분리 | 그래프 레이블의 레이아웃 제약 | 축 범위는 SVG 아래의 일반 Text(`공통 세로축: …`)다. `~`로 이은 범위는 같은 규칙에서 중간에 줄바꿈 가능 위치가 없는 한 덩어리라, 줄보다 넓으면 브라우저가 비상 줄바꿈(`overflow-wrap: break-word`)으로 임의의 글자 사이(`111.`/`1`, `15:3`/`0`)에서 자른다. SVG 안의 글자는 캔들 순번(한두 자리)뿐이라 해당 없다 |
| Dark 선택 구분이 약함 | 선택·비선택 배경의 명도 차이, 공용 토큰과 버튼 스타일 조합, 색상 의존 | 가설과 같다. 선택 여부를 나타내는 비텍스트 단서가 채움색 하나였다(테두리는 선택·비선택 모두 1px, 선택 표시 없음). Dark에서 04·05의 선택 채움(`infoAction` `#245b76`)은 주변 대비 2.42:1, 비선택 채움 대비 1.93:1, 02 캔들의 검정 톤 선택(`#000000`)은 1.17:1·1.47:1이다. 기록 후(투명도 0.6)에는 1.63:1·1.44:1이라 Dark 캡처에서 기록한 선택과 비활성 비선택이 거의 같아 보였다. Light는 7.23:1·6.98:1(검정 톤 20.48:1·19.76:1)로 충분했다. 토큰 값 자체보다 선택을 색 채움으로만 표시하는 가이드 선택지 구조가 원인이다 |

표시 정책(새 파일 `figureText.ts`의 순수 규칙과 가이드용 `Text`인 `GuideText.tsx`):

1. 숫자와 단위는 한 덩어리로 둔다. 숫자와 단위 사이와 단위 글자 사이에 보이지 않는 WORD JOINER(U+2060)를 넣는다. `만 원`의 공백은 NO-BREAK SPACE(U+00A0)로 바꾼다(브라우저는 앞뒤에 WORD JOINER가 있어도 일반 공백에서 줄을 바꾼다). 날짜 `2026-09-19`의 하이픈 뒤도 붙인다.
2. 범위는 `~` 뒤에서만 줄을 바꾼다. 물결표 뒤에 ZERO WIDTH SPACE(U+200B)를 넣어 `98.9~`/`111.1`로 나뉘게 한다.
3. 대상은 단위 목록(원·주·주당·%·%포인트·포인트·만 원·종목·시간·개월·건·분·초·시·일·월·년·개·명·배)이 바로 뒤에 붙은 숫자뿐이다. 일반 문장과 조사는 그대로 줄바꿈한다(예: `10,100원`/`에 매수`). 모든 Text에 줄바꿈 금지를 적용하지 않는다.
4. 수치 하나가 줄 전체보다 넓을 때만 대체 표시를 쓴다. 숫자가 있는 Text는 `onLayout`으로 자기 너비를 재고, 수치 너비는 글꼴 크기 × 글꼴 배율로 넉넉히 추정한다. 줄보다 넓은 수치만 천 단위 쉼표 뒤·단위 앞·`%포인트`의 `%` 뒤에서 줄을 바꿀 수 있게 한다. 자릿수 묶음 안, 단위 단어 안, 부호와 숫자 사이는 끊지 않는다. 글꼴 축소·말줄임·가로 스크롤·고정 너비는 쓰지 않는다.
5. 보이는 글자·값·정밀도, `won()`·`percent()` 반환값, `accessibilityLabel`은 그대로다. 제어 문자는 화면에 그리는 Text 내용에만 들어간다.

포맷 함수를 바꾸면 계산 결과 문자열과 다른 화면·테스트가 함께 바뀐다. `numberOfLines`·nowrap·글꼴 축소는 금지 사항이며 잘림 위험이 있다. 유니코드 표준 제어 문자는 웹·Android·iOS의 줄바꿈 엔진이 공통으로 따르는 방식이며 라이브러리를 추가하지 않는다.

선택 상태: 선택된 선택지 안쪽에 흰색(`onAccent`) 2px 링과 앱의 선택 표시인 ✓(주문방식 선택·차트 기간 선택과 같은 표시)를 그린다. 모든 선택지가 좌우 21px 여백을 미리 확보하므로 선택해도 크기와 줄바꿈이 변하지 않는다. 링과 ✓는 장식이라 접근성 트리에서 숨긴다(`aria-hidden`, `importantForAccessibility="no-hide-descendants"`, `accessibilityElementsHidden`). 선택 의미는 기존 `accessibilityState.selected`와 라벨이 전달한다. 기존 채움·테두리·글자색·비활성 투명도·테마 토큰은 바꾸지 않았다. `infoAction` 토큰은 앱 전체 버튼에 쓰이고 기존 테스트가 가이드 선택지 색을 고정하므로, 색 대신 모양 단서를 더했다.

공용 컴포넌트 재사용:

- `LessonUi`(Body·Section·LessonAction·GuideCard 등), `MarketLessonUi`(Metric·Values·Basis·LessonPlot·CandleSeries·Choices), `StockLessons`, `CandleFigures`의 import만 테마 `Text`에서 `GuideText`의 `Text`로 바꿨다. 04·05 전 챕터와 01 유동성·02 캔들·03 주문방식의 공용 부분, 가이드 목록(`GuideCard`, 초보 모드 학습 탭 포함)에 함께 적용된다. 가이드 목록 문구에는 단위가 붙은 수치가 없어 표시 결과가 같다.
- `EtfLessons.tsx`, `GuideChapterScreen.tsx` 등 챕터 파일은 수정하지 않았다. 선택 표시는 `LessonAction` 한 곳에서 그리므로 04·05의 `Choices`, 02 캔들, 03 주문방식 선택지에 같이 적용된다.
- 적용하지 않은 곳: 01 ‘호가창과 체결’(`MarketBasicsScreen.tsx`)의 자체 Text. `guideLesson.test.ts`가 호스트 Text의 parent를 따라 화면 구조를 확인하므로 래퍼를 넣으면 단언 구조가 바뀌고, 이번 범위(04·05) 밖이다. `CandlesScreen.tsx`의 선택 제목 1곳은 숫자가 없다.

변경 전후 줄바꿈 사례(브라우저 캡처로 직접 확인, `/`는 줄바꿈 위치):

| 위치(너비·글꼴 배율) | 변경 전 | 변경 후 |
| --- | --- | --- |
| ETF 1주 구성(320px·1배) | `펀드 지분의 1/100 = 1,000,000`/`원 ÷ 100주 = 한 주당 가치`/`10,000원` | `펀드 지분의 1/100 =`/`1,000,000원 ÷ 100주 = 한 주당`/`가치 10,000원` |
| 04 가격별 체결 가능 수량(360px·1배) | `… → 20`/`주`, `… → 40`/`주` | `… →`/`20주`, `… →`/`40주` |
| 추적차이(320px·3배) | `-0.2%포`/`인트` | `-0.2%`/`포인트`(수치가 줄보다 넓어 `%` 뒤에서 나눔) |
| 그래프 축(320px·3배) | `98.9~111.`/`1 (시작`/`=100)` | `98.9~`/`111.1 (시작`/`=100)` |
| 한 종목 충격(320px·3배, Dark) | `1,000,0`/`00원 →`, `ETF에 100`/`만 원` | `1,000,`/`000원 →`, `ETF에`/`100만 원` |
| 04 더 알아보기(320·360px·3배) | `15:3`/`0`, `24시`/`간` | 범위는 `~` 뒤에서만 나뉘고 `24시간`은 한 덩어리 |
| 확인일(390px·3배) | `2026-09-`/`19` | 한 덩어리 |

실제 화면 검증(2026-10-14): 저장소 밖 임시 하네스로 실제 `GuideChapterScreen`·`AppearanceProvider`·가이드 공용 컴포넌트·`ActionPressable`을 React Native Web(Playwright + Chromium 1248)에서 렌더링했다. 기존 `test/browser/nativeWeb.jsx` 어댑터가 `?fontScale=`만큼 Text 크기와 `useWindowDimensions().fontScale`을 키운다. 이전 절의 검사(잘림·넘침·겹침·가로 스크롤·말줄임·대비)에 수치 분리 위치 분류, 줄보다 넓은 수치 판정, 선택 표시의 위치·숨김, 선택 전후 다른 요소의 위치 변화, 링과 글자의 겹침 검사를 더했다. 결함 8종(이전 7종과 ‘붙인 수치가 줄보다 넓은 경우’)을 주입해 모두 검출되는 것을 먼저 확인했다. 숫자 Text는 측정 후 한 번 더 렌더되므로 각 동작 뒤 렌더가 안정된 다음 검사했다. 제품 소스·진입점·의존성·npm 스크립트는 바꾸지 않았다.

04·05: 6개 흐름(04 체결·미체결 두 경로, 05 4챕터) × 너비 320/360/390/430px × Light/Dark × 글꼴 1/2/3배 = **144개 전체 흐름, 1,008개 상태**. 04는 흐름마다 최초·밤사이 주문·다른 가격 선택·선택·기록·접수 누적·개장·최종·더 알아보기·처음부터의 10개 상태, 05의 1·4챕터는 6개, 2·3챕터는 5개 상태다.

| 항목 | 변경 전(HEAD 사본) | 변경 후 |
| --- | --- | --- |
| 전체 흐름 통과 | 144/144 | 144/144 |
| 잘림·넘침·겹침·가로 스크롤·말줄임·대비 문제 | 0 | 0 |
| 수치가 나뉜 상태 | 480/1,008(04 220/480, 05 260/528) | 62/1,008(04 6, 05 56) |
| 글꼴 1/2/3배별(각 336개 상태) | 82 / 166 / 232 | 0 / 0 / 62 |
| 3배의 너비 320/360/390/430별(각 84개 상태) | 74 / 70 / 44 / 44 | 32 / 26 / 4 / 0 |
| 그중 수치가 한 줄에 들어가는데도 나뉜 상태 | 472 | 0 |
| 분리 위치(발생 횟수) | 숫자와 단위 사이 1,042, 단위 안 102, 부호·하이픈 뒤 138(날짜), 숫자 안 22, `%포인트`의 `%` 뒤 26. 줄보다 넓은 수치의 숫자와 단위 사이 94, 단위 안 64, 숫자 안 52 | 줄보다 넓은 수치에서만: 단위 앞 138, 쉼표 뒤 52, `%` 뒤 20 |
| 활성 텍스트 최소 대비 | 4.62:1 | 4.62:1 |
| 실제 글꼴 최솟값(1/2/3배) | 14/28/42px | 14/28/42px |
| 선택 시 다른 요소의 위치 변화 | 0 | 0 |
| 외부 요청·페이지 오류 | 0 | 0 |

이 검사기는 단위가 없는 범위·시각·날짜의 숫자 분리도 센다. 그래서 같은 05의 528개 상태에서 이전 절 기록(192개)보다 많은 260개가 나왔다. 변경 전후는 같은 검사기로 비교했다.

남은 62개 상태의 평가:

- 모두 3배 글꼴에서 수치 하나가 줄 전체보다 넓은 경우다. 예를 들어 320px에서 굵은 48px(16px × 3배) 글꼴의 `1,000,000원`은 315px, 줄은 258px이라 한 줄 유지가 물리적으로 불가능하다.
- 나뉘는 위치는 설계한 세 곳뿐이다. 쉼표 뒤(`1,000,`/`000원`, `1,040,`/`000원`), 단위 앞(`800,000`/`원`, `940,000`/`원`, `10,000`/`원`, `10,200`/`원`, `1,040`/`포인트`, `1,050`/`포인트`, `1,020`/`포인트`), `%` 뒤(`-0.2%`/`포인트`, `+5%`/`포인트`, `+2%`/`포인트`).
- 자릿수 묶음·단위 단어·부호와 숫자는 끊기지 않는다. 쉼표가 줄 끝에 남아 이어짐이 보이고 단위는 다음 줄 첫머리에서 숫자에 바로 이어지므로, 값을 잘못 읽을 여지는 없다고 판단했다. 320px·3배 캡처(추적차이, 한 종목 충격, ETF 1주 흐름)로 직접 확인했다.
- 측정 전 첫 렌더에서는 수치가 붙은 형태로 그려지므로, 줄보다 넓은 수치가 브라우저의 비상 줄바꿈으로 한 번 나뉠 수 있다. 안정 대기 없이 동작 직후 검사한 실행에서는 1,008개 상태 중 6곳(단위 안 2, 숫자 안 4)이 이랬고, 대기 후 검사에서는 0이었다.

01 유동성·02 캔들·03 주문방식(공용 컴포넌트 회귀 확인, 축소 조합 320/390px × Light/Dark × 1/3배 = 24개 흐름, 160개 상태): 수치가 나뉜 상태 110 → 62, 한 줄에 들어가는데도 나뉜 상태 106 → 0. 남은 것은 3배에서 호가 가격 칸처럼 좁은 칸보다 넓은 수치의 쉼표 뒤(`10,`/`000원`) 128회와 단위 앞(`10,000`/`원`) 92회다. 레이아웃 문제는 아래 기존 문제 1번(유동성 32개 상태)뿐이며 변경 전후가 같다.

선택 상태의 시각적 구분과 대비(측정 대상과 기준을 구분. 비활성 투명도까지 합성한 실제 표시 색으로 계산):

| 측정 대상 | 기준 | Light 변경 전 → 후 | Dark 변경 전 → 후 |
| --- | --- | --- | --- |
| 04·05 선택 채움 대 주변 배경 / 대 비선택 채움 | 상태 식별 비텍스트 3:1(참고) | 7.23 / 6.98, 변화 없음 | 2.42 / 1.93, 변화 없음 |
| 02 검정 톤 선택 채움 대 주변 / 대 비선택 채움 | 〃 | 20.48 / 19.76, 변화 없음 | 1.17 / 1.47, 변화 없음 |
| 추가한 링·✓ 대 맞닿은 선택 채움 | 상태 식별 비텍스트 3:1 | 없음 → 7.41(검정 톤 21) | 없음 → 7.41(검정 톤 21) |
| 선택 글자 / 비선택 글자 | 텍스트 4.5:1 | 7.41 / 5.97, 변화 없음 | 7.41 / 9.14, 변화 없음 |
| 기록 후(비활성) 선택 글자·링 / 비선택 글자 | 비활성 컨트롤은 적용 제외 | 2.91 / 2.56 | 4.33 / 4.29 |

- 배경색 두 개의 대비만으로 판단하지 않았다. 변경 전 Dark에서는 선택을 알리는 비텍스트 단서가 3:1에 못 미치는 채움 차이뿐이었다. 변경 후에는 선택된 항목에만 7.41:1(검정 톤 21:1)의 링과 ✓가 있어 색 차이를 구분하기 어려워도 선택을 알 수 있다. 기록 후에도 링과 ✓가 남아 기록한 선택과 비활성 비선택이 구분된다.
- 브라우저: 04·05에서 선택이 있는 624개 상태(Light·Dark 각 312)와 02·03의 80개 상태 모두 표시가 선택된 항목에만 있고 비선택 항목에는 없다. 선택 전에는 없고, 선택을 바꾸면 따라가며, 선택해도 다른 요소 위치가 변하지 않고, 링이 글자와 겹치지 않는다. 테두리 두께는 선택·비선택 모두 1px로 같다.
- 캡처: 360px·1배, 390px·2배, 320px·3배의 선택·기록 상태(Light·Dark)와 02 캔들 검정 톤(360px·1배, Light·Dark)을 직접 열어 확인했다. ✓는 12px 고정이라 3배 글꼴에서는 작게 보이며, 이때는 버튼과 함께 커지는 링이 주된 단서다.
- 접근성 정보: `accessibilityLabel`과 `accessibilityState.selected`·`disabled`는 그대로다(단위 테스트). React Native Web은 `accessibilityState.selected`를 DOM에 내보내지 않으므로 브라우저에서는 `aria-disabled`와 표시 숨김(`aria-hidden`)만 확인했다. 버튼 컴포넌트(`ActionPressable`)·터치 영역·눌림 피드백은 그대로이며, 선택지의 좌우 여백만 16px에서 21px로 늘었다.

테스트 보완:

- `figureText.test.ts`(신규 6개): 붙임 규칙, 조사·문장 줄바꿈 유지, 범위·날짜, 보이는 글자 불변과 멱등성, 줄보다 넓은 수치의 대체 위치, 들어가는 수치는 한 덩어리 유지.
- `marketGuides.test.ts`(3개 추가): 5개 챕터 완료 화면의 수치 붙임과 접근성 라벨에 제어 문자가 없음, 매우 큰 글꼴(3배)과 좁은 줄에서 측정 후 `-0.2%`/`포인트`로 대체되고 넓은 줄에서는 한 덩어리로 돌아옴, 선택 표시의 위치·모양·숨김·크기 불변·기록 후 유지.
- `guideContent.test.ts`·`marketGuides.test.ts`의 텍스트 추출 helper는 보이는 글자(`visibleText`) 기준으로 바꿨다. 화면 문구는 같으므로 기존 단언은 그대로다. 제어 문자가 실제로 들어갔는지는 새 테스트가 원문으로 확인한다.
- `src/screens/quest/BeginnerLearningScreen.test.ts`: 이 테스트는 `GuideCard`를 그리는 가이드 목록까지 렌더링한다. `GuideText`가 `useWindowDimensions`·`StyleSheet.flatten`을 쓰면서 이 파일의 최소 `react-native` mock에 두 API가 필요해져 다른 테스트와 같은 형태로 추가했다. 단언은 바꾸지 않았다. 최종 소스의 첫 `npm run check`에서 이 파일의 1건이 `useWindowDimensions is not a function`으로 실패해 발견했다.
- 테스트 삭제·skip·단언 완화는 없다. UI 존재 단언은 boolean으로 비교한다.
- 변이 검사: 최종 소스를 16가지로 망가뜨렸다. 붙임 없이 렌더, 측정 안 함, 글꼴 배율 무시, 대체 표시 미사용·항상 사용, `만 원`에 일반 공백, 범위 줄바꿈 제거, `%포인트`를 단위에서 분리, 자릿수 안 줄바꿈, 날짜 붙임 제거, 접근성 라벨에 제어 문자, 선택 표시 미출력·모든 선택지에 출력, 선택 시에만 여백, 링 두께 제거, 표시를 접근성 트리에 노출. 16가지 모두 테스트가 실패했고 원복 후 소스가 바이트 단위로 같음을 확인했다.

`frontend/`에서 실행한 검사(모두 `systemd-run --user --scope -p MemoryMax=…`와 `timeout` 아래에서 실행, 메모리 급증·비정상 종료 없음):

| 검사 | 변경 전(HEAD) | 변경 후 |
| --- | --- | --- |
| `node src/screens/guide/guideLesson.test.ts` | 10개 통과 | 10개 통과 |
| `node src/screens/guide/guideContent.test.ts` | 21개 통과 | 21개 통과 |
| `node src/screens/guide/marketGuides.test.ts` | 25개 통과 | 28개 통과 |
| `node src/screens/guide/figureText.test.ts` | — | 6개 통과 |
| `node src/app/navigation/MainTabs.test.ts` | 18개 통과 | 18개 통과 |
| `node src/screens/quest/BeginnerLearningScreen.test.ts` | 6개 통과 | 6개 통과 |
| `npm run typecheck` | 통과 | 통과 |
| `npm run lint:guides:check` | 경고 0 | 경고 0 |
| `npm run check` | 테스트 2,635개(아래 참고) | 종료 코드 0, 테스트 2,644개·suite 300개 통과, 실패·취소·skip 0(최종 소스, 검사 전후 소스 해시 동일) |
| `git diff --check` | — | 통과 |

변경 전 `npm run check`는 저장소 밖 HEAD 사본에서 실행해 저장소 루트의 `scripts/`·`backend/` 파일을 읽는 5개 항목이 환경 차이로 실패했고 나머지 2,566개는 통과했다. 이 5개 항목은 작업 트리에서 모두 통과한다. 사본에서 파일 단위로 실패한 4개 파일의 실제 테스트 68개를 더하면 HEAD는 2,635개이고, 변경 후 2,644개와의 차이 9개는 새 테스트(`figureText` 6개, `marketGuides` 3개)와 일치한다. 가이드와 무관한 `FuturesLimitEntry.test.ts`의 간헐 실패는 이번 실행에서 재발하지 않았다.

수정하지 않은 기존 문제:

1. 01 유동성 실습 1의 두 시장 비교(`LessonUi`의 `Comparison` 세로 배치)에서 React Native Web은 ‘시장 A · 두꺼운 호가’ 카드 위에 ‘시장 B · 얇은 호가’ 카드를 겹쳐 그린다. 검사한 320·390px, 1·3배, Light·Dark의 유동성 32개 상태 전부에서 생기며 변경 전후가 같다. 원인은 세로 배치용 `stackedColumn: { flex: 0 }`이다. React Native Web은 이 값을 CSS `flex: 0`(= `0 1 0%`)으로 그대로 넘겨 열 높이의 기준값이 0이 된다. 네이티브(Yoga)의 `flex: 0`은 내용 크기를 따르므로 웹에서만 생기는 것으로 판단한다(실기기 미확인). 2026-09-19 `c1f31f62`부터 있던 코드이고 이번 범위(04·05) 밖이라 수정하지 않았다.
2. 한글 단어 중간 줄바꿈: 본문 `C 주`/`식`, 지표 이름 `ETF NAV 수`/`익률`, 큰 글꼴 버튼 `수익률`·`기록하고` 등. 변경 전후 같다. React Native에 Android용 어절 단위 속성이 없고 일괄 처리는 금지 범위라 남겼다.
3. 조사·괄호·이름과 값 사이의 줄바꿈: 버튼 `10,100원`/`에 매수`(320px·3배, 변경 전후 같음), 축 설명 `(시작`/`=100)`, `C`/`-5%`. 수치와 단위는 붙어 있어 읽는 데 문제는 없다고 판단했다.
4. Dark 선택 채움 자체의 대비(2.42:1, 검정 톤 1.17:1)는 그대로다. 색은 바꾸지 않고 링과 ✓로 보완했다.
5. 01 ‘호가창과 체결’(`MarketBasicsScreen.tsx`)의 자체 Text는 적용 대상이 아니므로 이 화면의 수치 분리는 남을 수 있다. 이번에 측정하지 않았다.

미검증: 실기기 iOS/Android. Android(Minikin)·iOS(Core Text)에서 U+2060·U+200B·U+00A0의 줄바꿈 처리와 글꼴 표시(빈 네모 등으로 보이지 않는지)는 표준상 기대 동작이며 기기에서 확인하지 않았다. 실제 글꼴이 너비 추정과 다를 때의 동작도 미확인이다. 추정보다 실제 수치가 조금 넓으면 플랫폼이 수치 안에서 비상 줄바꿈할 수 있다(잘림·넘침은 아님). 측정 전 첫 프레임의 임시 줄바꿈, 네이티브 OS 글꼴 확대(브라우저 1/2/3배는 기존 어댑터의 근사), TalkBack/VoiceOver 읽기(라벨 없는 본문 Text의 제어 문자, 링·✓ 숨김), 키보드 포커스 이동(버튼 컴포넌트는 그대로, 별도 키보드 조작은 하지 않음), `npm run export:web`·Expo Android export도 확인하지 않았다. 01 유동성·02·03은 축소 조합(320/390px × 1/3배)만 확인했고 01 ‘호가창과 체결’은 측정하지 않았다. 320px·3배 일부 요소 캡처의 아랫부분은 React Native Web 스크롤 영역 밖이라 비어 보인다. 변경 전후가 같으며 그 구간은 DOM 검사로만 확인했다.

이번 변경 파일:

- `frontend/src/screens/guide/figureText.ts`(신규)
- `frontend/src/screens/guide/GuideText.tsx`(신규)
- `frontend/src/screens/guide/figureText.test.ts`(신규)
- `frontend/src/screens/guide/LessonUi.tsx`
- `frontend/src/screens/guide/MarketLessonUi.tsx`
- `frontend/src/screens/guide/StockLessons.tsx`
- `frontend/src/screens/guide/CandleFigures.tsx`
- `frontend/src/screens/guide/guideContent.test.ts`
- `frontend/src/screens/guide/marketGuides.test.ts`
- `frontend/src/screens/quest/BeginnerLearningScreen.test.ts`
- `frontend/docs/guide-market-validation.md`
