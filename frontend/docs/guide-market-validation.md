# 가이드 수정 및 완료 전 검토 기록

현재 구성·문구 보완일: 2026-10-13. 최초 재구성 기준 `origin/main`: `cc37e6ea20c801c3bba39aa1b233f5ef530ab944`. 후속 정확성 보완의 시작 HEAD는 `59c907b2f5a9cd668a33b1dc19ec95e82c6ac030`이다. 아래 재구성 기록은 당시 실행 이력이며, 이번 문구 보완 결과는 마지막 절에 구분한다.
이전 검증일: 2026-09-19. 당시 조사 기준 HEAD: `554c2c18` (작업 시작 시 working tree clean). 이전 실행 수치와 브라우저 기록은 역사적 검증이며 이번 실행을 의미하지 않는다.
공식 근거와 계산 가정은 [guide-market-sources.md](./guide-market-sources.md)에 정리했다.

## 유지한 교육 구조와 수정 결과

| 주제 | 최종 강의·실습 |
| --- | --- |
| 시장기초 | 호가창과 체결 유지. 유동성과 가격 충격은 ‘같은 주문, 다른 유동성’과 ‘호가 변화와 실제 체결은 다르다’ 두 실습 |
| 캔들 | 단일 예시 캔들에 시가·고가·저가·종가·몸통·윗꼬리·아랫꼬리의 위치와 정의 연결. 그 아래 기존 캔들 만들기, 같은 OHLC/다른 경로, 5분→15분 집계 유지 |
| 주문방식 | 기존 실습·계산 유지. 초기화 표시만 ‘처음부터’로 통일 |
| 주식특성 04 | ‘장이 닫혀 있는 동안’ 한 챕터·4장 카드: 정규장 마감 → 지정가 매수 10주 가상 예약·08:30 개장 접수 → 09:00 시가와 체결 여부 → 갭 정리·더 알아보기. 선택 가격은 10,100/10,300원. 종가와 체결 건수는 가상 개장 단일가 범위로 표시 |
| 기업행동과 조정주가 | 주식분할과 병합 / 배당과 배당락 / 조정주가 읽기 유지. 배당은 용어 설명→배당락 전→배당락 후(권리와 이후 지급)→배당성향 계산 |
| ETF와 지수 | 지수란 무엇인가 / ETF란 무엇인가 / ETF는 지수를 어떻게 따라가는가 / ETF 시장가격과 NAV / ETF를 볼 때 확인해야 할 정보 |

삭제한 내용:

- 유동성 실습 3, 3/10/20/30주 수량 선택·비교, SizeTrial 및 전용 상태/결과/테스트, `SIZE_ASKS`.
- 주식특성의 거래정지·VI·상한가/하한가·가격제한 강의와 라우팅 항목, 상태 및 전용 테스트.
- 독립적인 한국 제도 암기형 선택 목록과 NXT 혼합 fixture를 두 시장 비교 구조로 교체.
- 개장·마감 강의의 중복 잔량 비교를 미국 경매 비교로 교체하고 사용처가 사라진 `limitBuy` 제거. 기존 주문방식의 지정가 실습은 유지.
- 2026-10-13: 기존 주식특성 세 챕터의 거래시간 비교·개장/마감 비교·갭/음봉/표시 범위 UI와 해당 렌더 테스트 3개를 단일 챕터로 교체. 단계 순서·앞선 결과 고정·가독성 검증은 새 렌더 테스트에 옮겼다. 기존 시간대·OHLC·시간축 export와 계산 테스트는 삭제하지 않았다.
- ETF 초반 부채 선택·고급 용어 중심 흐름을 기본 개념 중심으로 교체. 추적오차의 통계 공식 표시 대신 선의 변화를 비교.

## 이전 계산과 상태 검증 (2026-09-19)

가이드 상세 테스트 **61개**: `guideLesson` 9개, `guideContent` 19개, `marketGuides` 33개 통과.

| 대상 | 확인한 결과 |
| --- | --- |
| 유동성 | A 20주 평균 10,010원/마지막 10,010원. B 평균 10,021원/마지막 10,030원. 참여자의 주문 취소만으로 10,000원 유지, 실제 체결 후 10,020원. 이전 비교/취소 결과 고정 |
| 캔들 | 7개 용어가 위치에 연결되고 실습 1 이전에 표시. 기존 geometry 변경·가격 경로·집계 계산, 선택값 고정 유지 |
| 거래시간 | KRX 09:00–15:30, 미국 09:30–16:00 ET. 2026-01-07 23:30→익일 06:00 KST, 2026-07-08 22:30→익일 05:00. 두 시장의 원본 필터링과 시간축 생성, 선택 결과 고정 |
| 갭/방향 | 한국 10,000→10,700원, 미국 100→107달러 갭. 한국 종가 10,600원은 음봉이면서 전일 대비 +6%. 실제 차트와 동일한 색상 상수 사용 |
| 세션 OHLC | 각 시장에서 원본 기록 하나로 정규장/확장 범위를 계산. 원본 가격을 바꾸는 테스트에서 OHLC도 변함. 원본 불변, 빈 구간은 null |
| 배당 | 주요 단계 2개만 표시. 배당락 후 9,500원×10주=95,000원, 받을 배당 5,000원, 현금 0. 지급 후 받을 배당 0, 현금 5,000원. 총액 100,000원 유지, 연속 클릭에도 중복 지급 없음 |
| 배당성향 | 20/30/50억원 ÷ 순이익 100억원 → 20/30/50%. 0/음수 분모는 null |
| 지수/ETF | 기본 입력의 기여도 +5/0/−1%포인트, 지수 1,000→1,040. ETF 순자산 1,000,000→1,040,000원, 100주당 한 주 가치 10,000→10,400원. B 수익률을 바꾸면 결과도 재계산 |
| NAV/추종 | 괴리율 −2/0/+2%, 추적차이 −0.2%포인트. 추적오차는 시간에 따른 차이의 변동으로 구분. 지수/ETF 정의가 NAV/추적 강의보다 먼저 나옴 |
| 초기화/타이머 | 모든 초기화 이름 ‘처음부터’. 11개 챕터는 전체 완료 후 초기 텍스트·선택·결과로 복귀. 기존 재생은 중복 시작·blur·reset·unmount 회귀 검사 통과. 새 타이머 없음 |
| 공통 | 결과→다음 실습의 DOM 순서, 앞선 결과 freeze, 중복 testID 없음, NaN/Infinity 없음, 가이드의 서비스/API import 및 외부 요청 없음 |

## 이전 프로젝트 품질 게이트 (2026-09-19)

`frontend/`에서 실행했다. npm 스크립트나 lint 범위는 변경하지 않았다.

- `npm run check` 통과: `lint:accounts:check`, `lint:guides:check` 모두 경고 0, `npm run typecheck`, 전체 테스트 **81개 파일 성공 / 실패 0**.
- `node src/screens/guide/guideLesson.test.ts`, `node src/screens/guide/guideContent.test.ts`, `node src/screens/guide/marketGuides.test.ts`: 위 61개 상세 사례 확인.
- `npm run export:web` 통과. 결과 `frontend/dist`는 추적 제외.
- `npx expo export --platform android --output-dir /tmp/trading-guides-revised-android` 통과. Hermes 번들 생성.
- `git diff --check` 통과. 모든 변경은 `frontend/src/screens/guide`와 `frontend/docs`에 한정.

## 이전 좁은 화면·큰 글꼴과 실제 화면 조작 (2026-09-19)

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
- `frontend/src/screens/guide/CorporateLessons.tsx`
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
