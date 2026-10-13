# 가이드 수정 및 완료 전 검토 기록

현재 구성 변경일: 2026-10-13. 이번 작업 기준 `origin/main`: `cc37e6ea20c801c3bba39aa1b233f5ef530ab944`. 이번 검증 결과는 아래 2026-10-13 변경 기록에 별도로 정리한다.
이전 검증일: 2026-09-19. 당시 조사 기준 HEAD: `554c2c18` (작업 시작 시 working tree clean). 이전 실행 수치와 브라우저 기록은 역사적 검증이며 이번 실행을 의미하지 않는다.
공식 근거와 계산 가정은 [guide-market-sources.md](./guide-market-sources.md)에 정리했다.

## 유지한 교육 구조와 수정 결과

| 주제 | 최종 강의·실습 |
| --- | --- |
| 시장기초 | 호가창과 체결 유지. 유동성과 가격 충격은 ‘같은 주문, 다른 유동성’과 ‘호가 변화와 실제 체결은 다르다’ 두 실습 |
| 캔들 | 단일 예시 캔들에 시가·고가·저가·종가·몸통·윗꼬리·아랫꼬리의 위치와 정의 연결. 그 아래 기존 캔들 만들기, 같은 OHLC/다른 경로, 5분→15분 집계 유지 |
| 주문방식 | 기존 실습·계산 유지. 초기화 표시만 ‘처음부터’로 통일 |
| 주식특성 04 | ‘장이 닫혀 있는 동안’ 한 챕터·4장 카드: 장 마감 → 내 지정가 매수 10주와 주문 누적 → 개장 단일가 및 내 체결 결과 → 갭 정리·더 알아보기. 선택 가격은 10,100/10,300원 |
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
