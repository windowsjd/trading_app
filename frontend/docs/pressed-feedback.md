# 공통 Press·Navigation Motion 인수인계

2026-10-05 색상 보완: 기존 Primary Blue의 밝기와 브랜드 인상을 유지하면서
끝색을 `#4C32E5`로 조정해 Blue–Indigo 계열로 통일한다. 아래 색상 기준에 반영했으며
시작색, 흰 foreground, 수평 방향, 버튼 geometry와 press feedback은 유지한다.
하단 탭은 시작색 `#326FE5`를 계속 사용하며 Secondary/금융색 정책은 변경하지 않는다.

## 2026-10-04 일반 Primary CTA 브랜드 배경

의도: **일반 주요 행동에 브랜드 정체성을 부여하면서 금융 의미색과 선택 상태를 구분하고, 버튼 크기에 관계없이 공통 그라데이션 정책으로 통일감을 유지하기 위한 변경.**

- 조사: `CTAButton`, 인증/저장 버튼과 탭·필터가 `semantic.selected`를 공유했다.
  가설은 확인됐지만 일반 주요 행동이 모두 CTAButton에 모여 있지는 않았다.
  학습의 공통 `LessonAction`도 선택·보조·매수/매도 연습과 일반 진행에 함께 쓰였다.
  기존 그라데이션은 없었으며 `react-native-svg` 15.15.5는 이미 설치돼 있었다.
- 기준: **#326FE5 → #4C32E5**, 왼쪽 0% → 오른쪽 100%, y=50%의 수평 선형,
  두 stop opacity=1, 글씨/로딩 표시 #FFFFFF. 라이트·다크는 같은 기준을 쓴다.
  `theme/tokens.ts`의 `primaryGradient`와 공통 SVG 배경에서 관리한다.
- 크기: SVG/Rect는 실제 버튼의 100% 너비·높이, gradientUnits는
  `objectBoundingBox`다. 고정 픽셀 길이, 중간 stop, 폭별 보정은 없다.
  원래 padding/radius/font/label/layout/border를 유지하고 배경만 원래 모서리로 clip한다.
- 적용: 시즌 참가/투자 계정 시작·계속, 환전, 일반 확인·진행, 주요 결과/내역 이동,
  로그인·회원가입, 닉네임 저장, 일반 학습 진행 버튼.
  설정 화면의 저장은 일반 확인 행동이며 설정 메뉴·모드 선택은 대상이 아니다.
- 제외: 명시적 backgroundColor 재정의(현재 매수·매도), 오류 재시도, 뒤로가기,
  삭제/위험, 보조/텍스트/아이콘/설정 이동, 탭·필터·정렬·계정 선택,
  금융 표시와 방향별 금융 연습. CTA 예외는 `variant="neutral"`,
  학습 선택/보조와 금융 연습은 primary를 적용하지 않는다. selected/금융 토큰은 그대로다.
- 상태: disabled/blocked는 기존 배경과 opacity 0.45, 학습은 기존 opacity 0.6을
  유지한다. loading도 기존 배경·흰 spinner/진행 문구·터치 차단을 유지한다.
  활성 배경은 기존 static wash 아래에 놓이며 wash 0.055/0.065, 이벤트 시점,
  Reduced Motion, ref/접근성 계약에는 새 모션을 넣지 않았다.
  배경은 pointerEvents=none이고 접근성 트리에서 숨긴다. 서버 확인과 mutation 로직은 수정하지 않았다.

| 변경 파일 (`frontend/` 기준) | 이유 |
| --- | --- |
| `src/theme/tokens.ts`, `src/components/common/PrimaryButtonBackground.tsx` | 공통 브랜드 값과 크기에 맞는 배경 |
| `src/components/common/ActionPressable.tsx`, `CTAButton.tsx` | 기존 wash 아래 배경 opt-in, 명시적 색상과 neutral 역할 보존 |
| `src/screens/auth/LoginScreen.tsx`, `SignupScreen.tsx`, `src/screens/my/SettingsScreen.tsx`, `src/screens/guide/LessonUi.tsx` | 별도로 구현된 일반 주요 행동 연결 |
| `src/screens/guide/LiquidityScreen.tsx`, `OrderTypesScreen.tsx` | 방향별 금융 연습 제외 |
| `src/screens/entry/ModeSelectionScreen.tsx`, `src/screens/home/PortfolioScreen.tsx`, `src/screens/order/OrderPanel.tsx`, `OrderSuccessBottomSheet.tsx`, `src/screens/record/RecordProfitAnalysisScreen.tsx`, `src/screens/wallet/WalletFxScreen.tsx`, `FxSuccessBottomSheet.tsx` | 기존 CTA의 오류·뒤로가기 역할 제외 |
| `src/components/common/ActionPressable.test.ts`, `actionPressableVisual.test.ts`, `src/features/ranking/ranking.test.ts`, `test/interactionTestHarness.cjs` | 배경/누름 순서·상태·이벤트 검증과 Node의 SVG native host 경계 |
| `test/browser/motionFixture.jsx`, `primaryButtonBrowser.cjs`, `test/browser/README.md` | 실제 렌더, 변경 전 비교, 픽셀·반응형·화면 검증 |
| `package.json` | 새 배경 파일만 기존 lint gate에 추가; 의존성/lockfile 변경 없음 |

검증 (baseline HEAD `865551cda6b46aa36f404c709330be5c1308d2a8`):

- **PASS:** `npm run check` (accounts/guide lint, typecheck, 116개 테스트 파일, skip 0),
  `npm run export:web`, `git diff --check`와 전체 변경 자체 검토.
- **PASS, RN Web fixture:** `primaryButtonBrowser.cjs` **296개 렌더 검사**, pageerror 0.
  320/390/768px × fontScale 1/2 × Light/Dark; 두 금융 palette;
  같은 mounted 버튼을 430/360px로 resize; 넓은/좁은 버튼 크기를 baseline과 비교.
  실제 캡처 좌우 픽셀과 SVG stop/방향, 흰 글씨·줄바꿈·clip, 제외 대상 배경,
  한 개의 기존 wash, keyboard, loading 중 추가 클릭 차단, Reduced Motion을 확인했다.
- **실제 화면 확인:** 시즌 참가, FX, Record의 좁은 두 CTA, 로그인/회원가입의
  버튼 및 전체 화면, 긴 문구와 loading 캡처를 눈으로 확인했다.
  실제 컴포넌트/내비게이터와 결정적인 API fixture이며 운영 서버 실행 검증은 아니다.
  검증용 한글 폰트와 Chromium 라이브러리는 `/tmp`에서만 사용했다. 앱 폰트는 변경하지 않았다.
- **FAIL, 기존 모션 gate:** 한글 폰트 환경의 delayed Market→AssetDetail에서
  y=247→251px 이동. 변경 전 소스를 같은 환경에서 다시 빌드해 동일한 실패를 재현했다.
  이번 배경 변경의 회귀가 아니며 AssetDetail header/layout는 변경하지 않았다.
  이 실행은 두 flow 뒤 중단됐으므로 나머지 모션 flow를 PASS로 간주하지 않는다.
- **NOT_RUN:** Android/iOS 실제 기기·시뮬레이터(실행 도구 없음), 운영 서버/hosted CI.
  native의 SVG clip/실제 글꼴·터치 최종 확인이 남는다.
- **미리보기 이미지 비교 NOT_VERIFIED:** 이미지가 전달되지 않았다.
  확정 수치 기준과 실제 웹 캡처는 검증했으며 원본 이미지와 비교했다고 주장하지 않는다.

증거: `/tmp/trading-primary-browser/results.json` 및 PNG,
`/tmp/trading-primary-check.log`, `/tmp/trading-primary-export.log`,
`/tmp/trading-primary-motion/failure.json`, `/tmp/trading-primary-motion-baseline/failure.json`.
작업 중 별도로 나타난 `brandGradientAuditBrowser.cjs`/`brandGradientAuditFixture.jsx`는 수정하지 않았다.

## 2차 기록: 2026-10-04 모션 폴리시

1. **시작 / 종료 HEAD:** 작업 시작 전에 `git fetch origin main` 성공.
   HEAD와 최신 origin/main은 모두 `8238a7e4f616bc407a2d666f160ddec7120d0948`
   (`UI개편3보완작업`), 시작 working tree는 clean. 종료 HEAD도 동일하며 아래 변경은
   frontend에만 있는 미커밋 상태다. 1차 모션 변경은 이미 `fec57928`로 커밋돼 있다.
2. **최신 repository:** `fec57928` 이후 지갑 구성/보유 종목/quick action 보완이 추가됐다.
   실제 최신 소스를 기준으로 조사했고 이 변경을 유지했다. 기존 native-stack, Query,
   DTO, 계정 선택, 금융 mutation, API `/api/v1`, refresh 계약은 변경하지 않았다.
3. **기존 Bottom Tab:** 중앙 `tabTransition()`의 fade 130ms. Android soft ripple,
   iOS/web opacity 0.82와 원래 PlatformPressable 이벤트/접근성 계약이 이미 적용돼 있었다.
4. **최종 Bottom Tab:** fade **170ms**. 후보 160~190ms 안에서 기존보다 40ms만 늘린
   보수적인 조정이다. 설치된 Navigation의 기존 timing config와 fade interpolation을
   사용하고 별도 easing을 추가하지 않았다. browser에서 route state가 지연 응답보다 먼저
   반영되고 fresh cache 재방문 요청은 0개였다. native에서 가장 자연스러운 값인지의
   최종 체감 비교는 NOT_VERIFIED이며 web timing을 native duration으로 해석하지 않는다.
5. **Stack:** iOS `simple_push` **210ms**, Android `ios_from_right` 그대로.
   새 native hitch/abrupt stop 증거가 없으므로 튜닝하지 않았다. native back gesture,
   TradeHistory/SeasonJoin push/pop, hierarchy, AssetChart fullScreenModal 의미도 유지한다.
6. **기존 wash:** near-white 검정 0.05, 나머지 흰색 0.045.
7. **최종 wash:** near-white 검정 **0.065**, 나머지 흰색 **0.055**. 실제 themed
   Light/Dark 표면과 두 금융 palette의 held-press 렌더를 비교했다. 밝은 표면 눌림이
   더 식별되며 어두운 표면/금융 액션은 작은 중립색 wash로 유지된다. 값은
   `pressFeedback.ts` 한 곳에서 관리하고 brightness/alpha 판정은 그대로다.
8. **ripple/scale:** ActionPressable 소스는 변경하지 않았다. static wash 한 개,
   pressed 동안만 표시, release/cancel 즉시 복원. animation/timer/measure 없음.
   component tests에서 ref, 원래 event, functional style/children, disabled/loading/blocked,
   rapid tap, keyboard, accessibility, 단일 action 및 animation/measure 0을 확인했다.
9. **Market arrow:** ▲/▼의 `feedback="none"` 유지. TabBarButton, backdrop,
   sheet, chart gesture는 기존 정책이며 새로운 feedback variant가 없다.
10. **대표 flow arrival 조사:** immediate / 600ms delayed / fresh cache를 재사용했다.
    아래 위치는 390px/fontScale 1의 delayed 조건에서 data arrival 전후 비교다.

    | Flow | 조사 결과 / 처리 |
    | --- | --- |
    | Home → Market | root y=64 유지. 첫 row는 응답 후 y=252에 생성. route가 응답을 기다리지 않음; 가변 list row 예약 없음 |
    | Market → AssetDetail | 기본 폭에서 chart y=255, timeframe y=724, footer y=775 유지. 보조 가격줄 예약 유지. 작은 폭/큰 글꼴 줄바꿈은 아래 별도 기록 |
    | AssetDetail → Order | quantity y=383, slider y=513, CTA y=653 유지. fee/wallet/positions/holdings 요청 관찰. holdings top y=774 유지, 가변 내용 높이 189→1858은 예약하지 않음 |
    | Order → Back | 기존 native back 계약 유지. cached detail의 footer/selector 위치 유지, 추가 요청 0 |
    | Wallet → FX | available 환율의 늦은 도착으로 form/CTA가 44px 위로 이동하던 경로 발견 및 수정. unavailable도 별도 재실행 |
    | Wallet → TradeHistory | loading shell 뒤 empty history 교체. root y=64 유지. 가변 행 placeholder 추가 없음 |
    | Overall → Record | 기존 full loading shell 뒤 list 표시. 첫 시즌 row y=252 유지 |
    | Record → SeasonDetail | 기존 full loading shell 뒤 summary/CTA 표시. assets y=291, profit CTA y=428 유지 |
    | SeasonDetail → ProfitAnalysis | 기본 chartViewport 204px 유지. fontScale 2의 axis 높이 증가 18px를 추가 반영해 후속 card/CTA 위치 안정화 |

11. **발견된 shift:** FX 390px/1× form **-44px**. FX 320px/2×에서는 환산 값
    줄바꿈 +42px와 rate status 축소가 함께 발생해 기존 net **-32px**였다.
    Profit 2×는 viewport **204→222px**, 대표 손익 card/CTA **+18px**였다.
    별도로 AssetDetail은 placeholder 이름/가격이 실제 문자열로 바뀌면서 작은 폭에서
    가격·이름이 더 많은 줄을 사용했다. chart top 이동은 아래 표와 같다.
12. **수정한 shift:** FX는 로딩 rate status의 실제 `onLayout` 높이만 최소 공간으로
    보존한다. 높이 상수를 추측하지 않으며 큰 내용은 계속 늘어날 수 있다.
    큰 글꼴의 USD 환산 라벨/값은 loading부터 두 줄 구조로 시작한다. unknown 값은
    기존 `-`를 유지한다. 최종 available FX의 방향/input/CTA y 이동은 8개 조합 모두 0이다.
    Profit은 기존 204px 최소 공간을 유지하고 18px axis의 fontScale 증가분만 반영한다.
    2× 최소 공간은 222px이며 후속 card/CTA 이동은 8개 조합 모두 0이다.
13. **수정하지 않은 영역:** AssetDetail의 임의 이름/가격 길이에 따른 줄바꿈은 남는다.
    추정 가격 길이로 고정 높이를 예약하거나 큰 글꼴을 줄여 숨기지 않았다. 이번 결과를
    모든 화면 CLS=0으로 판정하지 않는다. Wallet/Market/history/Order holdings의 가변
    item 수, error/긴 텍스트 확장, FX unavailable spinner→label의 약 1px 차이도 유지한다.
    AssetDetail의 별도 responsive header 검토가 후속 과제다.
14. **Reduced Motion:** PASS. stack/root/chart `none`, tab `none`/0ms,
    tab press ripple transparent/opacity 1 및 실행 중 opacity 억제 유지. 일반 wash는
    moving animation 자체가 없다. unit tests와 live browser media 변경으로 확인했다.
15. **Light/Dark:** PASS (RN Web). 실제 themed surface/selected/action 버튼 held-press
    screenshot과 computed styles를 확인했다. 텍스트 투명도와 clipping shape는 그대로다.
16. **금융 palette:** PASS (RN Web). Red/Blue와 Green/Red의 buy/sell 및 Record
    금융 색상 검증. 색 role/원래 background/text는 유지하고 중립 wash만 소폭 강화했다.
17. **폭:** 320/360/390/430 × fontScale 1/2를 실행했다. 최종 delayed y 이동(px):

    | 폭 / scale | AssetDetail chart (미수정) | FX input (수정) | Profit 후속 card (수정) |
    | --- | ---: | ---: | ---: |
    | 320 / 1 | +46 | 0 | 0 |
    | 320 / 2 | +218 | 0 | 0 |
    | 360 / 1 | 0 | 0 | 0 |
    | 360 / 2 | +91 | 0 | 0 |
    | 390 / 1 | 0 | 0 | 0 |
    | 390 / 2 | +91 | 0 | 0 |
    | 430 / 1 | 0 | 0 | 0 |
    | 430 / 2 | +91 | 0 | 0 |

18. **fontScale:** 1.0/2.0 PASS: 수정한 FX/Profit의 arrival 위치 gate와 Record
    detail/profit 128개 glyph clipping 검사. 기존 nativeWeb adapter의 시뮬레이션이며
    native 글꼴/접근성 실측은 아니다. 큰 글꼴 error/내용을 제한하는 고정 height나
    numberOfLines를 추가하지 않았다. 기존 Record history 실패는 23번에 별도 기록한다.
19. **Motion Browser:** 최종 matrix **172 interactions PASS**, pageerror 0.
    기본 44개(immediate/delayed/cache + season Ranking/live Reduced Motion), 추가 7개
    폭/글꼴 조합 각 16개, unavailable 조건 16개. 시작 HEAD 번들의 44개 및 layout 수정
    전 320px/2× 번들도 별도로 재사용했다. route/commit/request/geometry만 측정하며
    native FPS, 실제 touch latency, 실제 native transition timing은 NOT_VERIFIED.
    기존 390px/1× reservation gate를 유지하고 FX/Profit 위치 gate를 모든 조합으로
    확장했다. 다른 문자열 wrap 이동은 trace에 기록해 없어진 것처럼 처리하지 않았다.
    Reduced Motion held-press 캡처의 ScrollView observation 시간 보정 후 추가 16개
    interaction도 PASS (합계 188개). 이는 production press duration 변경이 아니다.
20. **Android 실제 검증:** NOT_RUN. adb/emulator/연결된 실행 환경 없음.
21. **iOS 실제 검증:** NOT_RUN. xcrun/simulator/연결된 실행 환경 없음.
22. **CI / frontend quality:** local `npm run check` PASS (두 lint gate, typecheck,
    전체 **116개 테스트 파일**, skip 0); transitionPolicy/MainTabs/ActionPressable/
    pressFeedback/TabBarButton/Reduced Motion 포함. `npm run export:web` PASS.
    Trading browser **138 scenarios PASS**, Record detail/profit **128 layouts PASS**.
    hosted CI는 NOT_RUN. 수정 중 발견한 기존 130ms assertion과 새 dimensions hook의
    test-host mock은 최종 정책에 맞게 보완했고 최종 검사를 다시 통과했다.
23. **기존 Record overflow:** 전체 Record browser **FAIL**. 320px/2×/긴 금액의
    `실제 차감액`/`실제 수령액` glyph x=-29.75px. 1차 기록의 실패와 동일한 수치다.
    history 소스/geometry는 이번 diff에 없고 wash는 absolute overlay이므로 악화 없음.
    해당 실패를 skip으로 숨기거나 이 작업에 묶어 수정하지 않았다.
24. **변경 파일 및 이유:** 아래 16개, 모두 frontend. production 변경은 4개다.

    | 파일 (`frontend/` 기준) | 이유 |
    | --- | --- |
    | `src/app/navigation/transitionPolicy.ts` | tab fade 170ms 중앙 정책 |
    | `src/components/common/pressFeedback.ts` | static wash 6.5%/5.5% |
    | `src/screens/wallet/WalletFxScreen.tsx` | measured rate status 예약 및 큰 글꼴 환산 line 안정화 |
    | `src/screens/record/RecordProfitAnalysisScreen.tsx` | 기존 viewport에 axis fontScale 증가분만 반영 |
    | `src/app/navigation/transitionPolicy.test.ts` | 최종 중앙 duration 검증 |
    | `src/app/navigation/MainTabs.test.ts` | duration 중복 literal 제거, 중앙 policy 계약 비교 |
    | `src/components/common/pressFeedback.test.ts` | 최종 wash 및 dark/금융 action 표면 검사 |
    | `src/components/common/ActionPressable.test.ts` | 중앙 wash와 즉시 상태, native ripple 없음 검사 |
    | `src/components/navigation/TabBarButton.test.ts` | 정상 tab도 중앙 policy 연결 검증 |
    | `src/features/wallet/fxUiDisplay.test.ts` | loading 측정 공간을 도착 후 유지하고 height 제한 없음 검사 |
    | `test/recordScreenHarness.cjs` | 새 dimensions 사용에 기존 native boundary 제공 |
    | `test/browser/motionBrowser.cjs` | 기존 harness에 geometry/폭/font/press 관찰과 최소 위치 gate 추가 |
    | `test/browser/motionFixture.jsx` | 실제 Light/Dark·금융 버튼 probe |
    | `test/browser/motionMocks.js` | valid FX available fixture; mutation/외부 요청 차단 유지 |
    | `test/browser/README.md` | 기존 harness 실행/관찰 범위와 한계 |
    | `docs/pressed-feedback.md` | 최신 HEAD/정책/증거/남은 실패 기록; 1차 역사 보존 |

25. **전체 diff 자체 검토:** PASS. fade/짧은 timing/중앙화 유지. Stack 210ms와
    Android preset 변경 없음. ActionPressable 본체·Market arrow·TabBarButton 변경 없음.
    최소 geometry 수정 외 금융/query/account/refresh 변경 없음. 새 dependency, backend,
    DB, animation framework, production profiling, 임의 row reservation 없음.
    `git diff --check` PASS.
26. **판정:** PASS = local quality/motion gates/web export/변경 화면 Record/Trading.
    FAIL = 전체 Record의 기존 history overflow. NOT_RUN = Android/iOS/hosted CI.
    NOT_VERIFIED = **Server**, native timing/FPS/touch latency/최종 체감.
    전체 앱 arrival 무이동은 달성했다고 주장하지 않는다.
27. **남은 사용감 / 후속:** 동일 native 기기에서 Home→Market fade, Light/Dark press,
    Market→Detail→Order→Back, Wallet→FX 확인 필요. 작은 폭/큰 글꼴 AssetDetail header
    줄바꿈, 기존 Record overflow는 별도 검토 대상이다. native evidence 없이 Stack을
    느리게 만들거나 content entrance animation을 추가하지 않는다.

원본 증거 (모두 `/tmp/`, 앱 번들에 포함되지 않음):

- 시작 HEAD + 확장한 test-only 관찰: `/tmp/trading-motion2-baseline/` (130ms/5%/4.5%).
- 도착 수정 전: `/tmp/trading-motion2-arrival-before/`, `/tmp/trading-motion2-large-before/`.
  이 두 번들은 후보 tab/wash 조정 이후, FX/Profit layout 수정 이전 소스다.
- 최종: `/tmp/trading-motion2-final/`, `/tmp/trading-motion2-matrix-{폭}-{scale}/`,
  `/tmp/trading-motion2-unavailable/`; results.json에 request/route/geometry/색상 기록.
- Reduced Motion held-press 캡처 재확인: `/tmp/trading-motion2-press-final/`.
- Record/Trading: `/tmp/trading-motion2-record-charts/`, `/tmp/trading-motion2-record-full/`,
  `/tmp/trading-motion2-trading/`와 각 `.log`.
- quality/export: `/tmp/trading-motion2-check-final.log`, `/tmp/trading-motion2-web-export.log`.

---

## 1차 기록: 2026-10-03~04 Interaction Motion 진단/개선

아래 내용은 당시 작업 기록이다. 이 변경은 이후 `fec57928f4395ecd1cb077d655ac84ceeea8ef1d`
(`앱 모션 개선`)로 커밋됐다. 아래 `95591275` 종료 HEAD/미커밋 표현은 그 커밋 직전의 상태를
뜻하며, 현재 최신 repository 상태가 아니다. 현재 정책/검증은 위 2차 기록을 기준으로 한다.

- 시작 직전 `git fetch origin main` 성공. 시작 HEAD/origin/main 및 종료 HEAD는
  `955912752d56d1d7fd6269ac59f6af89c9592409` (`관리자용 계정강화4`). 시작 working tree는 clean,
  종료는 frontend 변경만 있는 미커밋 상태다.
- **확인된 문제:** scale + ripple + wash 중첩, `useNativeDriver: false` scale listener의
  프레임별 React state 갱신, Reduced Motion에서도 버튼 animation 지속. 실제 네이티브
  체감/30fps 영상의 정확한 시간은 확인하지 못했다. 영상 파일은 이번 첨부에 포함되지 않았다.
- **의도:** Pressable의 즉각적인 pressed 상태를 한 개 배경으로 표현하고, 버튼 자체의
  이동·크기 변화·효과 종료 대기를 없앤다. 금융 실행은 기존 loading/server confirmation을 유지한다.

| 계층 | 최종 정책 |
| --- | --- |
| ActionPressable / CTA / 계정·목록 행 | 정적 wash 하나. 밝은 면은 검정 5%, 나머지는 흰색 4.5%. root scale/ripple/추가 release timer 없음. 원래 Pressable 이벤트·취소·ref·style callback 유지 |
| 일반 stack | 기존 iOS `simple_push` 210ms, Android `ios_from_right` 유지. 숫자 튜닝은 native 비교 전 보류 |
| root context (Auth/Entry/MainTabs) | 기존 fade 170ms 유지 (duration 옵션은 iOS용) |
| TradeHistory / SeasonJoin | root fade에서 공통 stack push/pop으로 변경. route/back stack 자체는 동일 |
| AssetChart | fullScreenModal + fade 유지, policy 함수로 중앙화 |
| Bottom Tabs | 기존 fade 130ms 유지, `transitionPolicy.ts`로 이동. 일반 TabBarButton은 설치된 PlatformPressable 유지 |
| Reduced Motion | stack/root/chart/tab `none`, tab duration 0. tab ripple 투명/opacity 1, 실행 중 opacity도 style로 억제. 일반 버튼은 OS 설정 조회 전에도 움직이는 효과 자체가 없음 |
| 예외 | Market 초소형 정렬 화살표 `feedback="none"`, 기존 sheet/backdrop/차트 gesture 유지 |

`animationDuration`의 Android 제어를 추가하지 않았다. 설치된 native-stack 7.14.12와
screens 4.23.0 타입, [React Navigation 문서](https://reactnavigation.org/docs/native-stack-navigator/#animationduration)를 확인했다.
새 animation dependency, backend/API 경로, telemetry/production timing log는 없다.

**원인 분리와 측정 범위**

`test/browser/motionBrowser.cjs`는 실제 RootNavigator/화면/React Query와 production React
profiling을 실행한다. HTTP·WS와 인증 bootstrap은 fixture다. mutation/외부 요청은 차단한다.
동일 Chromium 390×844에서 즉시 fixture, 모든 새 요청 600ms 지연, fresh cache 재방문을 비교한다.
T0는 주입된 pointerdown, T2는 실제 ActionPressable handler 앞의 test-only 기록이다.
Tab/Back은 click-capture를 대신 쓴다. 35ms hold는 테스트가 의도적으로 넣은 값이다.
`route-state`는 navigation 상태 반영이며 **native T3가 아니다**. shell/data는 visible DOM
marker다. native T1/T3/T4, T0→T3/T3→T4/T4→T6 및 실제 서버 비교는 **NOT_VERIFIED**다.
주문 입력 marker는 이미 캐시된 종목을 사용하며, 수익 분석 요약은 equity보다 먼저 표시된다.
환율은 unavailable, 거래 내역은 empty fixture이므로 해당 주요 데이터 T6는 측정하지 않았다.
요청 시작/응답, 전체 React subtree commit, RAF, layout-shift source는 별도로 저장한다.

단위 ms, **handler/click → route-state**. 지연 조건의 shell/data도 같은 기준이다.

| Flow | 즉시 fixture | 600ms 지연 | cache | 지연 shell / data marker |
| --- | ---: | ---: | ---: | --- |
| Home → Market tab | 6.9 | 4.9 | 2.8 | 11.1 / 610.2 |
| Market → AssetDetail | 11.0 | 7.3 | 6.5 | 8.8 / 613.1 |
| AssetDetail → Order | 18.1 | 14.0 | 15.2 | 15.4 / 15.5 |
| Order → Back | 20.7 | 18.1 | 19.9 | 18.9 / 19.0 |
| Market → Guide tab | 10.6 | 4.9 | 2.6 | 11.9 / 11.9 |
| Guide → Wallet tab | 8.8 | 6.2 | 2.5 | 12.2 / 12.2 |
| Wallet → FX | 8.9 | 4.9 | 5.9 | 5.8 / 미측정 |
| Wallet → TradeHistory | 4.1 | 2.5 | 3.2 | 3.4 / 미측정 |
| Wallet → Overall tab | 6.4 | 4.7 | 3.4 | 12.5 / 12.5 |
| Overall → Record | 6.6 | 4.9 | 7.8 | 5.5 / 608.6 |
| Record → SeasonDetail | 6.0 | 4.6 | 5.2 | 5.5 / 606.4 |
| SeasonDetail → ProfitAnalysis | 7.3 | 6.8 | 7.4 | 7.7 / 7.7 |
| Overall → Home tab | 3.3 | 3.2 | 2.8 | 12.6 / 12.6 |
| Home → AssetDetail | 7.7 | 7.1 | 9.2 | 13.1 / 612.4 |

위 값은 한 번의 controlled browser sample이며 기기 latency 기준/개선율이 아니다.
지연 조건에서 새 요청이 있는 모든 flow는 응답 전에 route state가 반영되었고, fresh cache
재방문은 새 요청이 0개다. Home↔Market↔Guide↔Wallet↔Overall, 시즌 Ranking 및 live Reduced
Motion 변경까지 총 44개 interaction을 전후 실행했다.

- **Server 판정: NOT_VERIFIED.** 실제 로그인 API/서버·cold start 비교를 실행하지 않았다.
  대표 화면을 여는 handler에는 `await`, fetch/refetch/mutation success 대기가 없다.
  코드와 지연 fixture에서는 network-before-navigation을 발견하지 않았다.
  로그인/복원, 계정 개설, 시즌 참가에는 identity/account integrity를 위한 대기가 있고,
  주문·환전 quote/create와 성공 후 계정 범위 invalidation은 그대로 유지한다.
- **Client 판정:** 고립된 버튼 short tap의 React commit은 일반/Reduced Motion 모두
  **35→3회**였다. 이는 web subtree 측정이며 native frame drop 감소율이 아니다.
  AssetDetail은 detail/candles, Order는 detail/fee/wallet/positions/holdings, Record는
  detail/equity observer가 화면 mount 후 동작한다. observer 수와 commit 기록만으로 폭발이나
  native 병목을 단정하지 않았다. navigation이 전체 cache를 invalidate하는 경로는 발견하지 않았다.
  화면 memoization, query 정책, provider 수명/계정 전환 시 mode별 remount는 바꾸지 않았다.
- **Arrival 측정 및 수정:** USD 보조 가격줄 삽입으로 차트가 21px 내려가던 경로에 접근성에서
  제외한 동일 Text 공간을 확보했다. 수익 분석은 154px skeleton 뒤 204px 차트가 와서 다음
  카드가 50px 내려갔다. 기존 skeleton을 유지하고 plot+gap+axis의 204px 최소 공간을 확보했다.
  `minHeight`이므로 큰 글꼴/error 내용은 늘어날 수 있다. 동일 지연 fixture에서 두 수직 이동은
  사라졌다. 이름 길이에 따른 작은 가로 이동은 남으며, 임의 길이 데이터 전체의 CLS=0을 주장하지 않는다.
- **남은 layout 사항:** 지갑 cold holdings의 가변 행 수에 따른 확장, 큰 글꼴에서 차트 축
  label wrap에 따른 높이 변화는 남는다. 임의 row 수를 가정하는 placeholder나 새 skeleton
  framework를 도입하지 않았다.

**검증과 한계**

| 검사 | 결과 |
| --- | --- |
| `npm run check` | PASS: 두 lint gate, typecheck, 116개 테스트 파일; skip 0 |
| Press/ActionPressable/실제 RN Web style/TabBarButton/Reduced Motion/route tests | PASS. 이전 ripple/scale assertions는 최종 pressed 정책 검사로 교체. disabled/loading/blocked, 즉시 handler, 취소/rapid tap, 금융 중복 제출·계정 scope 기존 테스트 유지 |
| Motion browser | PASS: 전후 각 44개 interaction, 일반/Reduced Motion press probe |
| 기존 Trading browser | PASS: 138개 시나리오 |
| Record detail/profit browser | PASS: 128개 레이아웃, Light/Dark·금융 색상·큰 글꼴·긴 값·tooltip/해제·unavailable |
| 전체 Record browser | FAIL: history 320px/fontScale 2/긴 금액의 글자 x=-29.75px. 시작 HEAD의 ActionPressable/pressFeedback/Record 화면으로도 동일 재현. 이번 변경으로 생긴 회귀가 아님; 실패를 skip 처리하지 않음 |
| `npm run export:web` | PASS |
| Android Expo export | PASS: Hermes 번들만 검증, APK/실기기 실행 결과 아님 |
| Android / iOS 실제 motion | NOT_RUN: adb/emulator/xcrun 및 연결된 실행 환경 없음 |
| 실제 API·cache·fixture의 native before/after | NOT_VERIFIED |
| `git diff --check` / 자체 검토 | PASS; 금융 mutation, 계정 선택, API `/api/v1`, pull-to-refresh, financial color, disabled/accessibility/Market arrow 예외 유지 |

소스 변경은 공통 press 2개, navigation policy/MainTabs/Root/TabBarButton, 측정된 두 도착 화면에
한정했다. 나머지는 테스트/하니스/이 문서다. 예전 Record browser의 사라진 `line-chart-plot`
selector를 실제 접근성 SVG로 바꾸고, 현행 gesture의 pointer-up 해제도 검증한다.
`RECORD_BROWSER_SCREENS=detail,profit`은 변경 화면을 선택할 수 있으며, 기본 전체 검사는 history도 계속 검사한다.

원본 trace/보존된 before 번들: `/tmp/trading-motion-before/`, 최종 trace:
`/tmp/trading-motion-final/`; 단계별 layout source 비교: `/tmp/trading-motion-layout/`.
검사 로그: `/tmp/trading-motion-{check,web-export,android-export,trading,record-charts}.log`.
기존 history 실패 비교: `/tmp/trading-motion-record.log`, `/tmp/trading-motion-record-baseline.log`.
실행 방법과 환경 변수는 [browser README](../test/browser/README.md)에 있다.

**완료 상태:** 코드 개선/자동 검증까지 진행. 사용자가 요구한 native push/pop 정착감과
실제 touch latency의 최종 승인 조건은 미충족이다. 동일 Android 기기에서 보존한 HEAD와 수정본을
설치해 Market→Detail→Order→Back, Home→Market, Wallet→FX를 OS frame profiler/영상 및
T0~T6·request trace로 비교해야 한다. iOS는 별도 확인하며 210/130ms 튜닝은 이 증거 이후에 한다.
원인 비중을 숫자로 배분할 근거는 없다. 확인한 개선 대상은 중첩 press의 렌더 작업과 두 도착
layout 변화이고, 서버·native transition 성능은 미검증이다.

---

# 2026-09-17 일반 ripple·시간봉 selector 기록 (이전 정책)

2026-09-17 작업. 시작 시 작업 트리는 깨끗했고 HEAD는 `7c1eeb55`였다. 과거 작업 상태 대신 이 HEAD의 전체 사용처와 테스트를 조사했다.

## 실제 원인과 공통 구조

기존 `withPressedFeedback()`은 Pressable style callback에서 전체 opacity를 0.76으로 바꿨다. 터치 좌표·원형 레이어·시간에 따른 확산이 없어서 이번 요구를 표현할 수 없었다.

일반 액션을 `ActionPressable`로 통일하고 `pressFeedback.ts`는 좌표/반경 및 색상 정책을 담당하는 작은 순수 helper로 바꿨다. 기존 Pressable의 style, onPress, disabled, children, 접근성, testID는 그대로 전달한다. CTA와 직접 선언한 버튼·목록 행은 모두 같은 컴포넌트를 사용한다.

- 루트는 기존 RN Pressable 한 개다. 버튼 자체에는 opacity 변경, scale, 이동, bounce를 넣지 않는다.
- 별도의 절대 위치 레이어만 `overflow: hidden`으로 잘라낸다. 기존 corner radius를 복사하고, 루트의 shadow/elevation/border/padding/flex와 콘텐츠는 자르지 않는다.
- 효과 레이어는 콘텐츠 뒤에서 렌더링하며 `pointerEvents="none"`과 접근성 제외 속성을 사용한다. 텍스트 자체의 투명도는 바꾸지 않는다.
- [RN 기본 Animated](https://reactnative.dev/docs/animated)로 원의 scale과 효과 레이어의 opacity만 제어한다. 새 의존성·전역 상태·별도 제스처 프레임워크는 없다.

## 좌표·색상·플랫폼

`onPressIn`에서 배경 연화를 즉시 시작하고, 실제 Pressable 루트를 측정한다. 이벤트의 `pageX/pageY`에서 루트의 page 좌표를 뺀 위치가 원의 중심이다. 자식 Text/View 기준의 `locationX/locationY`에 의존하지 않는다. 매 터치마다 다시 측정하므로 리스트/페이지 스크롤 뒤에도 위치를 갱신한다. 좌표가 없는 키보드 입력은 중앙으로, hitSlop 등으로 경계를 벗어난 좌표는 버튼 내부로 보정한다.

원 반경은 터치 위치에서 가장 먼 모서리까지의 거리다. 작은 원에서 240ms 동안 확산하고 해제·취소 시 160ms 동안 사라진다. 배경 연화는 120ms로 복원한다. 아주 빠른 탭에서는 측정이 늦게 도착해도 남은 fade를 표시할 수 있으며, 이미 종료된 효과나 비활성/언마운트 상태를 되살리지는 않는다. 연속 터치의 이전 콜백도 새 효과를 제거하지 못한다.

| 배경 | 색상 연화 | ripple |
| --- | --- | --- |
| 검정·파랑·일반 회색 등 | 4.5% 중립 흰색 레이어로 원래 색을 약하게 연화 | 16% 흰색 원형 레이어 |
| 거의 흰색/투명 배경 | 별도 색상 변화 없음 | 10% 검정 원형 레이어 |

RN `processColor` 결과로 밝기를 판단하며 새 강조색은 도입하지 않는다. 배경 연화는 ripple보다 약하다. 선택 필터가 배경색을 바꾸면 현재 style에서 다시 색상 정책을 계산한다.

Android/iOS/web은 같은 좌표·색상·확산 구조를 사용한다. Android/iOS는 native Animated driver, web은 RN Web Animated driver를 쓴다. 일반 UI에 플랫폼별 opacity 대체 정책은 없다. `isInteraction: false`로 설정했고 `onPress` 자체는 감싸거나 지연하지 않는다. navigation/mutation은 효과 종료나 측정 콜백을 기다리지 않는다.

## 적용 및 제외

현재 55개 ActionPressable 선언에 적용된다. 여기에는 CTA, 재시도, 계정 선택 trigger/row, 로그인/가입, 일반 투자/시즌 진입, 홈·MY·설정 메뉴, 마켓 검색/필터/종목 행, 랭킹 카드/행/필터, 전적 행/주문 취소, 주문 방식/비율, 환전 방향, 포트폴리오 필터/행, 차트 최신 버튼과 새 시간봉 selector/닫기/선택 행이 포함된다. 목록에서 반복 렌더링되는 각 실제 행도 같은 정책을 사용한다.

명시적 제외:

- **하단 탭:** MainTabs, TabBarButton, TabBarIcon과 기존 테스트까지 HEAD와 동일하다. 기존 Android ripple 및 iOS/web opacity 0.76을 유지한다. route/order/active 색상/접근성/safe area/큰 글꼴 정책도 변경하지 않았다.
- **차트 직접 조작:** CandlestickGestures native/web, GestureDetector, 렌더러와 gesture session 코드는 그대로다. 차트 컴포넌트에서는 별도 최신 버튼만 공통 컴포넌트로 연결했다.
- **투명 backdrop:** 기존 BottomSheetBackdrop 파일 자체에 변경이 없다.
- **표시용 Pressable:** 주문 내역의 onPress 없는 외곽 행은 그대로다.
- **비활성:** disabled/loading/blocked, accessibility disabled, onPress 없는 CTA는 효과 레이어를 표시하지 않는다. 활성 도중 disabled로 바뀌어도 제거한다.

## 시간봉 선택

기존 일곱 버튼 나열을 현재 값 하나를 보여주는 selector로 바꿨다. 누르면 기존 BottomSheetBackdrop을 사용하는 하단 목록이 열린다.

| 그룹 | 사용자 표시 | 기존 interval |
| --- | --- | --- |
| 분 | 5분 / 15분 / 30분 | 5m / 15m / 30m |
| 시간 | 1시간 / 4시간 | 1h / 4h |
| 일 / 주 | 1일 / 1주 | 1d / 1w |

데이터는 기존 `ASSET_CHART_TIMEFRAMES`의 **객체를 그대로** 참조한다. interval/range/limit/내부 label은 바꾸지 않았다. 다른 값을 선택하면 목록을 닫고 그 객체를 `setSelectedTimeframe`에 전달한다. 같은 값은 목록만 닫는다. 기존 candle query, getAssetCandles, useAssetCandle의 interval, snapshot merge, resync, stale 처리와 viewportResetKey를 유지했다. unsupported interval 및 1m은 추가하지 않았다.

선택 행은 배경과 체크 표시 및 accessibilityState로 구분한다. 텍스트에는 줄 수/높이 제한을 추가하지 않았다. 작은 화면·큰 글꼴에서는 제목/닫기/선택 목록 전체를 스크롤할 수 있고, 화면 높이와 상단 safe area로 최대 높이를 제한하며 하단 inset을 확보한다. 닫기 버튼·backdrop·시스템 뒤로가기 모두 목록을 닫는다.

## 테스트와 실행 결과

- `pressFeedback.test.ts`: 기존 opacity 강제 검증을 좌표, 반경, 확산/해제, 중립색 연화, 세 플랫폼, 원래 onPress의 즉시 단일 실행, disabled 전환, 빠른 연속 탭/측정 지연/종료, CTA 공통화, 전체 action coverage, 제외 영역 및 마켓 memoization 검증으로 교체했다. 총 13개 통과.
- `ChartTimeframeSelector.test.ts`: 실제 selector의 열기/닫기/7개 선택/재선택, 같은 정책 객체 전달, 공통 ripple, safe-area/스크롤/텍스트, 실제 AssetDetailScreen의 query/live interval/viewport 연결 등 5개 통과.
- 기존 홈 레이아웃·랭킹·차트 제어·candle error assertions는 유지하면서 static style/children 또는 일곱 버튼 나열에 대한 가정만 새 구조에 맞췄다.
- 기존 screen/query/gesture harness의 interaction 경계는 새 컴포넌트를 기본 Pressable host로 대체하고, 별도 interaction harness에서는 **실제 ActionPressable + React reconciliation**을 실행한다. 네이티브 측정·애니메이션 clock만 제어한다. 기존 랭킹 테스트는 RN Web 실제 렌더링을 계속 사용한다.

frontend 명령은 `frontend/`에서 실행했다.

| 명령 | 최종 결과 |
| --- | --- |
| `npm run check` | lint(경고 0), typecheck, 전체 69개 테스트 파일 통과 |
| `node src/components/common/pressFeedback.test.ts` | 13개 통과 |
| `node src/components/charts/ChartTimeframeSelector.test.ts` | 5개 통과 |
| `node src/components/charts/candlestickNativeIntegration.test.ts` | 17개 통과 |
| `node src/components/charts/candlestickWebIntegration.test.ts` | 3개 통과 |
| `npm run export:web` | 통과 (`dist`) |
| `npx expo export --platform android --output-dir /tmp/trading-ripple-export-android` | 통과 (Hermes 번들) |
| `git diff --check` | 통과 |

초기 검사에서는 obsolete opacity assertion, 새 selector 경계가 없던 screen harness, render-prop children을 정적 노드로 가정한 랭킹 테스트를 발견해 보완했다. 기존 동작 assertion을 삭제하거나 느슨하게 바꾸지 않았다.

## 성능·최종 자체 검토

- 누른 요소 안에서만 geometry state를 갱신한다. animation frame마다 React state를 갱신하지 않으며 부모 화면/FlatList에 pressedItemId 같은 상태를 두지 않았다.
- 실제 MarketAssetRow를 렌더링한 회귀 테스트에서 두 행의 가격 렌더링은 처음 2회, 부모는 1회였고 한 행을 누르고 떼어도 증가하지 않았다. 기존 memo comparator/ticker identity/useMemo는 유지된다. 기기 FPS 벤치마크를 수행했다는 의미는 아니다.
- 전체 TSX AST coverage로 일반 액션의 누락과 raw Pressable 제외 대상을 확인했다. 기존 일반 opacity 0.76/withPressedFeedback 호출은 남지 않았으며 0.76은 하단 탭에만 있다.
- 25개 기존 TSX는 import·컴포넌트명·기존 helper 제거를 정규화하면 HEAD와 동일했다. AssetDetailScreen은 시간봉 UI/미사용 chip style 제거까지 별도로 diff를 검토했다. 나머지 navigation/onPress/disabled/testID/접근성/계정/금융 로직 변경은 없다.
- 하단 navigation 디렉터리, BottomSheetBackdrop, timeframe 정책 파일, native/web chart gesture와 renderer, package-lock은 HEAD 대비 diff가 없다. package.json 변경은 새 공통 컴포넌트/selector를 lint 대상으로 추가한 것뿐이다.
- 일반 효과를 위한 라이브러리 추가, backend/API/DB 변경, global animation state, 루트 overflow clipping은 없다.

## 실기기에서 추가 확인할 항목

현재 검증은 source/React render/제어된 native 경계/기존 RNGH JS integration 및 export까지다. 실제 Toss 영상과의 픽셀·프레임 일치, Android/iOS 물리 기기 터치 및 시각 검증은 수행하지 않았다.

- 밝은 목록·검정 CTA·선택 필터에서 ripple 속도/강도와 배경 연화의 체감, 가장자리 및 자식 텍스트 위 터치 원점.
- 스크롤 직후 터치, 아주 빠른 탭/연속 탭/스크롤 취소와 화면 전환, disabled 전환.
- rounded corner/shadow/elevation, 작은 화면·큰 글꼴·가로 화면에서 목록 전체 스크롤 및 safe area.
- 실시간 ticker 갱신 중 스크롤 성능, 캔들 pan/pinch/long-press/scrub 및 부모 세로 스크롤과의 실제 터치 경합.

## 변경 파일 전체 목록

아래 경로는 `frontend/` 기준이다.

| 범위 | 파일 |
| --- | --- |
| 공통 interaction | `src/components/common/ActionPressable.tsx`, `pressFeedback.ts`, `CTAButton.tsx` |
| selector/차트 버튼 | `src/components/charts/ChartTimeframeSelector.tsx`, `CandlestickChart.tsx` |
| 상태/계정 | `src/components/states/AdminDiagnosticPanel.tsx`, `BlockedState.tsx`, `EmptyState.tsx`, `ErrorState.tsx`; `src/components/tradingAccount/AccountSwitcher.tsx` |
| 마켓 row | `src/features/market/MarketAssetRow.tsx` |
| 인증/진입 | `src/screens/auth/LoginScreen.tsx`, `SignupScreen.tsx`; `src/screens/entry/ModeSelectionScreen.tsx`; `src/screens/season/SeasonJoinScreen.tsx` |
| 홈 | `src/screens/home/GeneralAccountHome.tsx`, `SeasonAccountHome.tsx`, `PortfolioScreen.tsx`, `WalletTransactionsScreen.tsx` |
| 마켓/종목 | `src/screens/market/MarketScreen.tsx`, `MarketSearchScreen.tsx`; `src/screens/asset/AssetDetailScreen.tsx` |
| 주문/환전 | `src/screens/order/OrderScreen.tsx`; `src/screens/wallet/WalletFxScreen.tsx` |
| 랭킹/전적 | `src/screens/ranking/RankingScreen.tsx`; `src/screens/record/RecordOrderListScreen.tsx`, `RecordSeasonListScreen.tsx` |
| MY | `src/screens/my/MyScreen.tsx`, `SettingsScreen.tsx` |
| 테스트 | `src/components/common/pressFeedback.test.ts`; `src/components/charts/ChartTimeframeSelector.test.ts`, `candlestickChartControls.test.ts`; `src/features/asset/candleErrors.test.ts`; `src/features/ranking/ranking.test.ts`; `src/screens/home/homeIntegration.test.ts` |
| harness | `test/interactionTestHarness.cjs`, `test/ledgerTestHarness.cjs`, `test/tradingUiHarness.cjs`; `src/components/charts/chartIntegrationHarness.cjs` |
| 설정/보고 | `package.json`, `docs/pressed-feedback.md` |
