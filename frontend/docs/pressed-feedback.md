# 눌림 피드백 구현·검증 보고

## 실제 구조와 적용 정책

- 일반 UI에는 기본 React Native `Pressable` 선언 55곳이 있었다. 이 중 액션이 있는 53곳에 적용했다. 공통 CTA, 상태 화면의 재시도, 계정 선택 컴포넌트와 화면별 직접 Pressable이 함께 사용된다.
- 하단 5개 탭은 React Navigation Bottom Tab이 터치 영역·이벤트·접근성을 관리하며 `TabBarIcon`은 SVG 표시만 담당한다. 설치된 Navigation은 기본 탭 버튼에 `pressOpacity: 1`을 전달한다. Android의 기존 기본 ripple은 있었지만 iOS/web에서는 opacity 피드백이 없었다.
- 차트 직접 조작은 별도 `CandlestickGestures` 계층이 담당한다. `최신` 버튼은 이 계층 밖의 형제 Pressable이다.

| 종류 | 구현 | 눌림 / 해제 |
| --- | --- | --- |
| 일반 액션 | `withPressedFeedback(style, disabled)` | 눌리는 동안 opacity 0.76, 해제·취소 시 원래 style 즉시 복원 |
| 하단 탭 | `tabBarButton`에 작은 `TabBarButton` 연결, 기존 `PlatformPressable` 사용 | Android는 각 탭 내부의 12% 검정 ripple, iOS/web은 즉시 opacity 0.76 및 기존 Navigation의 짧은 복원 |

일반 효과는 state·effect·타이머·wrapper 없이 기존 Pressable의 style callback만 사용한다. disabled/loading/blocked 및 기존 pending 조건을 그대로 전달하며, 실행 함수가 없는 CTA도 피드백을 표시하지 않는다. 기존 onPress, navigation, mutation에 지연이나 debounce를 추가하지 않았다. scale, 이동, bounce는 사용하지 않는다.

탭은 Navigation이 전달한 children, style, href, onPress/onLongPress, 접근성, testID를 그대로 전달한다. route/순서/색상/폰트·safe-area 계산을 바꾸지 않았다. API 근거: [React Navigation tabBarButton](https://reactnavigation.org/docs/bottom-tab-navigator/#tabbarbutton).

이미 설치·잠금되어 있던 `@react-navigation/elements` 2.9.15를 직접 의존성으로 명시했다. lockfile의 실제 패키지 목록·버전은 변하지 않았고, 애니메이션 엔진이나 다른 패키지를 새로 설치하지 않았다.

## 명시적 제외

- 캔들 plot, GestureDetector/RNGH, pan, pinch, long-press crosshair, scrub, gesture session, 부모 스크롤과의 공존 코드.
- `BottomSheetBackdrop`의 투명 닫기 영역. 기존 style/onClose/onRequestClose 유지.
- `RecordOrderListScreen`의 onPress 없는 표시용 외곽 행. 내부 주문 취소 버튼에만 적용.
- TextInput의 입력 영역, 비활성 CTA/버튼의 활성 눌림 효과. Navigation이 제공하는 기본 헤더 버튼은 기존 플랫폼 피드백 유지.

## 회귀 테스트

- `pressFeedback.test.ts` 신규 11개: 눌림/복원, 기존 style callback, 비활성 상태, CTA의 동기 실행·testID·줄바꿈, 모든 직접 Pressable의 적용/제외와 disabled 조건 AST 검사, backdrop 닫기, 차트 gesture subtree 제외, 마켓 row memo comparator.
- `TabBarButton.test.ts` 신규 4개: 실제 설치된 Navigation 버튼을 native 경계만 대체해 실행. Android/iOS/web 각각 모든 5개 탭의 active/inactive, icon props, 이벤트·접근성·href·testID 전달, ripple/즉시 opacity, disabled 및 큰 글꼴/safe-area 정책 검증.
- `homeIntegration.test.ts` 수정: 기존 일반/시즌 홈 CTA 레이아웃 assertion을 유지하고 style callback을 평가하도록 변경. 눌림 시 opacity만 추가되는지도 검증.
- 기존 탭 route/order/icon 검사, 계정 전환·capability·account binding·주문/환전 테스트, 마켓 ticker 테스트 및 차트 통합 테스트를 유지했다.

## 실행한 검증과 결과

모든 frontend 명령은 `frontend/`에서 실행했다.

| 명령 | 결과 |
| --- | --- |
| `npm run check` | 통과: `lint:accounts:check`(경고 0), `typecheck`, `test`(65개 테스트 파일) |
| `node src/components/common/pressFeedback.test.ts` | 신규 11개 테스트 통과 |
| `node src/components/navigation/TabBarButton.test.ts` | 신규 4개 테스트 통과 |
| `node src/components/charts/candlestickNativeIntegration.test.ts` | 17개 통과: pan, long-press, scrub, pinch, session 종료, 세로 스크롤 양보 설정 등 |
| `node src/components/charts/candlestickWebIntegration.test.ts` | 3개 통과 |
| `npm run export:web` | 통과 (`dist`) |
| `npx expo export --platform android --output-dir /tmp/trading-pressed-export-android` | 통과 (Hermes 번들) |
| `git diff --check` | 통과 |
| 변경된 기존 TSX의 AST 기반 HEAD 비교 | 26개 파일에서 helper import/style 호출을 제거하면 기존 코드와 동일. 총 53개 액션 Pressable 적용 |

처음 전체 테스트 실행에서는 홈 테스트가 style을 정적 배열로 가정해 실패했다. 위 테스트 수정으로 기존 레이아웃 검증을 유지했고, 최종 전체 검사는 통과했다.

## 완료 전 자체 검토

- 전체 Pressable AST를 순회해 주요 액션의 누락 및 제외 영역의 오적용을 검사했다.
- 일반 버튼은 모두 동일 opacity를 사용하고 탭의 시각 설정은 한곳에서 관리한다. 기존 색상·크기·여백·줄바꿈·testID·접근성 속성은 변경하지 않았다.
- 실행 가능 여부와 pending 조건, onPress/navigation/React Query/account binding 로직은 변경하지 않았다.
- 마켓의 memo comparator, ticker identity와 useMemo 구조가 보존되었고 화면 전체에 pressed state를 추가하지 않았다.
- 차트 변경은 `최신` 버튼 style뿐이다. 실제 RNGH JS 이벤트를 사용하는 기존 통합 테스트를 통과했다.
- 전체 diff는 frontend 내 피드백 구현, 테스트, lint 대상 및 기존 의존성 직접 명시, 이 보고서로 한정된다.

자동 검증은 native host/애니메이션 경계를 대체한 테스트와 export까지다. Android/iOS 실기기에서 ripple의 감각, 실제 손가락 gesture arbitration, 작은 화면·큰 글꼴의 시각적 잘림을 직접 확인하지는 못했다. 탭 높이/safe-area와 버튼 줄바꿈은 기존 규칙 보존 및 회귀 테스트로 확인했다.

관련 기존 구조 중 주문 내역의 표시용 외곽 행이 action 없는 Pressable인 점은 유지했다. 별도 View 전환은 이 작업의 피드백 범위에 필요하지 않다. 이번 자동 검증에서 다른 관련 회귀는 발견하지 못했다.

## 변경 파일 전체 목록

아래 경로는 `frontend/` 기준이다.

| 범위 | 파일 |
| --- | --- |
| 공통 구현 | `src/components/common/pressFeedback.ts`, `src/components/common/CTAButton.tsx` |
| 하단 탭 | `src/components/navigation/TabBarButton.tsx`, `src/app/navigation/MainTabs.tsx` |
| 공통 상태/계정 | `src/components/states/AdminDiagnosticPanel.tsx`, `BlockedState.tsx`, `EmptyState.tsx`, `ErrorState.tsx`; `src/components/tradingAccount/AccountSwitcher.tsx` |
| 차트 버튼 | `src/components/charts/CandlestickChart.tsx` |
| 마켓 row | `src/features/market/MarketAssetRow.tsx` |
| 인증/진입 | `src/screens/auth/LoginScreen.tsx`, `SignupScreen.tsx`; `src/screens/entry/ModeSelectionScreen.tsx`; `src/screens/season/SeasonJoinScreen.tsx` |
| 홈 | `src/screens/home/GeneralAccountHome.tsx`, `SeasonAccountHome.tsx`, `PortfolioScreen.tsx`, `WalletTransactionsScreen.tsx` |
| 마켓/종목 | `src/screens/market/MarketScreen.tsx`, `MarketSearchScreen.tsx`; `src/screens/asset/AssetDetailScreen.tsx` |
| 주문/환전 | `src/screens/order/OrderScreen.tsx`; `src/screens/wallet/WalletFxScreen.tsx` |
| 랭킹/전적 | `src/screens/ranking/RankingScreen.tsx`; `src/screens/record/RecordOrderListScreen.tsx`, `RecordSeasonListScreen.tsx` |
| MY | `src/screens/my/MyScreen.tsx`, `SettingsScreen.tsx` |
| 테스트 | `src/components/common/pressFeedback.test.ts`, `src/components/navigation/TabBarButton.test.ts`, `src/screens/home/homeIntegration.test.ts` |
| 설정/보고 | `package.json`, `package-lock.json`, `docs/pressed-feedback.md` |
