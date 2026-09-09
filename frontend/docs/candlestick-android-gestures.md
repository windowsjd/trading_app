2026-09-09 모바일 캔들 차트 수정 및 검증 기록

1. **확인된 원인**

   설치된 RNGH 2.30.1의 Android `PinchGestureHandler.onHandle()`은 첫 손가락의 DOWN에서도 `begin()`을 호출한다. 기존 Native adapter는 pinch의 `onBegin`에서 `session.takeOver('pinch')`를 실행했다. 따라서 한 손가락만 사용해도 세션이 pinch 소유가 되고, chart pan의 `session.begin('pan')`과 long press의 `session.startCrosshair()`가 거절됐다. pan 업데이트도 `session.isOwner('pan')` 검사에서 반환됐다.

   추가로 기존 scrub의 `manager.activate()`는 Reanimated가 없는 현재 설치에서 경고만 출력하는 경로다. 기존 Android LongPress는 ACTIVE 이후에도 이동 거리 10px 제한을 넘으면 취소하므로, 세션 선점만 고쳐도 긴 scrub은 유지되지 않는다.

2. **초기 가설과 조사 결과**

   Native lifecycle/session 및 recognizer 구성 결함이 맞았다. 설치된 Android 소스와 기존 adapter를 함께 실행한 JS 이벤트 재현으로 확인했다. 오래된 APK, adapter 누락, root 누락을 원인으로 가정할 필요가 없다. 부모 ScrollView가 모든 터치를 선점한다는 가설은 이번 증상의 필수 원인이 아니다. 실제 기기에서 별도의 interception 문제가 있는지는 아직 측정하지 못했다.

   변경 이력에서는 `ccda963e`에 session 소유 모델과 pinch의 `onBegin` 선점 조합이 들어갔고, `0cdbedfe`에서 Reanimated를 제거하면서 수동 활성화가 남은 것을 확인했다. 이후 `4408e99b`는 Web drag/wheel 및 화면 높이 변경이다.

3. **이벤트가 막히는 단계와 증거**

   코드로 재현된 차단 지점은 `recognizer → callback → session 소유 검사 → viewport/crosshair state` 사이이다. 이벤트가 GestureDetector에 도착하지 않아야만 발생하는 문제가 아니다. Android DOWN에 해당하는 BEGAN을 설치된 RNGH JS eventReceiver에 전달하면 기존 코드의 pan/crosshair 갱신이 차단된다.

   기존 adapter로 새 회귀 테스트 중 첫 손가락 BEGAN, pan, long press 3개를 실행해 **3개 모두 실패**하는 것을 확인했다. 이후 수정본을 복원해 동일 테스트를 통과시켰다. 원본 APK의 MotionEvent나 logcat을 캡처한 결과와는 구분해야 한다.

   근거: `node_modules/react-native-gesture-handler/android/src/main/java/com/swmansion/gesturehandler/core/PinchGestureHandler.kt`, `LongPressGestureHandler.kt`, `PanGestureHandler.kt`; `src/handlers/gestures/eventReceiver.ts`, `gestureStateManager.ts`. 수동 state manager의 Reanimated 의존성은 [공식 RNGH 문서](https://docs.swmansion.com/react-native-gesture-handler/docs/legacy-gestures/state-manager/)에도 명시돼 있다.

4. **선택한 해결 방식**

   pinch는 `onStart`, 즉 ACTIVE에서만 세션을 선점한다. LongPress와 수동 crosshair pan 두 개를 `Pan().activateAfterLongPress(300)` 하나로 합친다. 구성은 `Simultaneous(pinch, Race(crosshairPan, chartPan))`이다. chart pan은 X 이동 10px를 넘으면 활성화되고, 활성화 전에 Y 이동이 10px를 넘으면 실패한다. 지연 pan의 hold 이동 허용치는 RNGH native touch slop을 따른다.

5. **선택 이유**

   설치된 RNGH의 native timer와 recognizer가 hold/이동 판정을 처리하므로 JS timer나 수동 state manager가 필요 없다. hold가 활성화된 뒤에는 같은 Pan이 자유롭게 scrub을 추적한다. Race는 pan과 crosshair의 동시 활성화를 막고, 외부 Simultaneous는 두 손가락 pinch 전환을 허용한다. 부모 ScrollView를 끄거나 touch DOWN부터 차트가 이벤트를 독점하는 처리는 필요 없다. viewport 계산과 renderer는 계속 공통으로 사용한다.

6. **변경 파일**

   아래 경로는 모두 `frontend/` 기준이다.

   | 파일 | 내용 |
   | --- | --- |
   | `src/components/charts/CandlestickGestures.native.tsx` | pinch 활성화 시점, delayed pan, composition, 종료 cleanup |
   | `src/components/charts/CandlestickChart.tsx` | timeframe별 adapter key, 가격축 여백, 기존 가격 범위 계산 함수 추출 |
   | `src/components/charts/CandlestickChartRenderer.tsx` | 가격/시간 라벨 크기 및 경계 처리 |
   | `src/components/charts/candlestickGesturePolicy.ts` | composition 설명 갱신, 사용하지 않는 기존 hold 거리 상수 제거 |
   | `src/components/charts/candlestickLayout.ts` | 라벨 너비 추정 및 글자 크기 계산 |
   | `src/components/charts/chartIntegrationHarness.cjs` | Node용 TSX/RNGH JS integration harness |
   | `src/components/charts/candlestickNativeIntegration.test.ts` | Native adapter부터 상태/renderer까지 연동 검증 |
   | `src/components/charts/candlestickWebIntegration.test.ts` | 실제 Web adapter 이벤트 리스너의 회귀 검증 |
   | `docs/candlestick-android-gestures.md` | 이 기록 |

7. **주요 변경과 유지한 조건**

   화면 회전/adapter 교체/unmount 때 세션을 닫고, timeframe 변경 때 adapter key도 변경한다. 기존 session의 중복 종료 방지는 유지한다. 가격축 폭은 전체 loaded 데이터의 가격 자릿수를 기준으로 정해 pan 중 plot 폭이 바뀌지 않게 한다. Y 가격 범위는 기존처럼 보이는 캔들만 사용하고 최신 구간에서만 현재가를 포함한다.

   candle viewport 계산 파일, 가격 formatter, responsive height, Web adapter, AssetDetailScreen의 단일 ScrollView, App root, Android 설정은 수정하지 않았다. 캔들/현재가/축을 그리는 공통 renderer를 유지한다. backend, API, DB, package.json, package-lock.json 변경 및 의존성 추가는 없다.

8. **Web 회귀 결과**

   Web adapter에 등록된 실제 리스너를 실행해 mouse hover/drag, 외부 mouseup, mouseleave, wheel 누적 zoom, Ctrl/Cmd trackpad pinch, Shift/horizontal wheel pan, drag 중 wheel 소비, 최신 reset을 검증했다. 통과. Web export도 통과했고 소스맵에서 `.web.tsx`만 선택되는 것을 확인했다. 실제 브라우저에서의 수동 조작은 실행하지 못했다.

9. **Android pan 검증 결과**

   Native adapter가 생성한 실제 RNGH gesture builder와 JS eventReceiver를 통해 Chart의 startIndex 변경, 과거 이동, 같은 drag 및 다음 drag에서의 반대 방향 이동, 양쪽 data edge clamp, 최신 버튼 reset을 검증했다. 통과. Android MotionEvent recognition 자체를 실행한 실기기 검증은 아니다.

10. **Android long press/crosshair 검증 결과**

    hold ACTIVE에서 crosshair 표시, 선택 캔들의 정확한 KST 시간, Y 좌표에 대응하는 가격, 수직/수평선, 10px를 훨씬 넘는 scrub, 정지 hold의 lift, cancel/fail, 네 방향 outside와 재진입, timeframe/회전 cleanup을 검증했다. 통과. 실제 native hold timer와 촉감/프레임 속도는 기기 확인이 필요하다.

11. **Pinch 검증 결과**

    한 손가락 BEGAN에서 세션을 열지 않는 것, 실제 ACTIVE에서 zoom하는 것, 확대/축소, fresh pinch 및 pan/crosshair에서의 전환, 늦게 도착한 다른 recognizer finalize가 pinch를 종료하지 않는 것을 검증했다. 통과. 두 손가락 native recognition은 기기 확인이 필요하다.

12. **Parent ScrollView 검증 결과**

    화면의 React Native ScrollView는 그대로이며 scrollEnabled 변경, 강제 responder, 추가 root, 부모 scroll 차단 설정을 넣지 않았다. pan의 failOffsetY, delayed activation, simultaneous/race 관계를 실제 RNGH builder config에서 검사했다. vertical swipe에 해당하는 CANCELLED 흐름은 viewport/crosshair/session을 변경하지 않는다. Android 부모 View의 실제 interception은 Node 테스트가 재현하지 못하므로 차트 위 세로 swipe는 기기에서 확인해야 한다.

13. **추가 테스트와 한계**

    Native 17개, Web 3개, 총 20개 integration 테스트를 추가했다. production TSX, 설치된 RNGH gesture builder/composition/registry/eventReceiver, 실제 Chart 콜백/viewport 함수/renderer를 실행한다. Host View와 React hook scheduling은 Node harness의 대체 구현이다. RNGH native recognizer, Android dispatch/interception, React Native 실제 mount 및 SVG 폰트 rasterization을 모사했다고 주장하지 않는다. 기존 정책 테스트에만 의존하지 않으면서 추가 의존성 없이 JS 연결 결함을 잡도록 했다.

14. **검증 명령과 결과**

    `frontend/`에서 실행:

    | 명령 | 결과 |
    | --- | --- |
    | `npm run check` | lint:accounts:check, typecheck, 전체 테스트 통과; runner 출력 기준 52개 테스트 파일 |
    | `node --test --test-isolation=none 'src/components/charts/*.test.ts'` | 차트 테스트 147개 통과, 29 suites |
    | `npx --no-install eslint --no-fix --max-warnings=0 src/components/charts/CandlestickChart.tsx src/components/charts/CandlestickChartRenderer.tsx src/components/charts/CandlestickGestures.native.tsx src/components/charts/candlestickLayout.ts src/components/charts/candlestickGesturePolicy.ts` | 수정한 production chart 파일도 별도 lint 통과 |
    | `npx --no-install expo export --platform android --output-dir /tmp/chart-android-export --source-maps --max-workers 2` | Android Hermes bundle/export 성공 |
    | `npx --no-install expo export --platform web --output-dir /tmp/chart-web-export --source-maps --max-workers 2` | Web bundle/export 성공 |
    | `npx --no-install expo-modules-autolinking react-native-config --platform android --json` | RNGestureHandlerPackage 및 rngesturehandler_codegen 등록 확인 |
    | `npm ls react-native-gesture-handler react-native-reanimated react-native-worklets` | RNGH 2.30.1 설치, Reanimated/Worklets 없음 |
    | `git diff --check` | 통과 |

    Expo 55의 bundledNativeModules는 RNGH `~2.30.0`, RN `0.83.6`을 지정하며 설치/프로젝트와 일치한다. Android 설정은 `autolinkLibrariesFromCommand`, `autolinkLibrariesWithApp`, `PackageList(this).packages`를 사용하고 Fabric/Hermes가 켜져 있다. AppEntry → App의 GestureHandlerRootView → RootNavigator → MainTabs → MarketStack → AssetDetailScreen 연결을 확인했다. 소스맵에도 Android root native component, RNGH native module spec, Native adapter와 공통 Chart/renderer가 포함된다. 현재 설치된 APK의 바이너리 링크/모듈 초기화까지 확인한 것은 아니다.

15. **모바일 라벨 검토**

    320px/360px 휴대전화의 카드 안에 해당하는 차트 폭 254px/294px와 landscape 폭 650px, USD/KRW 긴 가격 및 displayPriceDecimals=8을 검사했다. 가격축 여백을 확보하고 한계를 넘는 긴 문자열은 글자 크기를 줄인다. 작은 화면에서 두 정적 시간이 겹치면 마지막 시간 하나를 표시하며, crosshair는 선택된 캔들의 전체 시간을 유지한다. crosshair 시간 배경과 문자를 plot 내부로 제한한다. 텍스트 너비 추정치와 배경의 가로/세로 경계 검사는 통과했다. 실제 Android 폰트의 육안 가독성/잘림 검증은 남아 있다.

16. **실기기 추가 확인 및 전체 diff 재검토**

    현재 환경에서 adb, emulator, Java 실행파일을 찾을 수 없어 APK 조립·설치·실행·logcat 캡처를 수행하지 못했다. 새 APK 또는 dev client에서 60개보다 많은 캔들이 있는 구간을 열어 좌우 이동/역방향/양 끝/최신 reset, 300ms hold와 큰 수평·수직 scrub, lift/cancel/outside, fresh pinch와 hold/pan 도중 pinch, 차트 위 세로 swipe를 확인해야 한다. 60개 미만 timeframe의 오른쪽 정렬, timeframe 전환, 화면 회전, 긴 가격·8자리 소수·시간 라벨을 확인한다. Web에서도 실제 mouse/wheel/trackpad 조작을 한 번 확인한다.

    테스트 후 전체 변경을 다시 읽어 session 선점 시점, race/simultaneous 관계, 중복 start/end, teardown, 부모 scroll 보존, 공통 viewport와 단일 renderer, 라벨 경계를 검토했다. 가격축 여백 때문에 pan 중 폭이 바뀌는 일이 없도록 전체 loaded 데이터 기준 여백을 사용했다. backend/DB/API 및 무관한 변경, dependency 추가가 없는 것도 확인했다.

17. **Git 상태**

    기존 파일 수정 5개, 새 파일 4개로 모두 frontend 내부다. 변경 파일은 6번 표와 동일하다. commit, push, GitHub 직접 수정은 하지 않았다. export와 실행 로그는 `/tmp/chart-*`에만 저장했다.
