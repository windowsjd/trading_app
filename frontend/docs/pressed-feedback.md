# 일반 ripple·시간봉 selector 구현 및 검증

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
