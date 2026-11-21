# Meta 광고 성과 측정 (Meta SDK · App Events) — 2026-11-21

Meta(Facebook·Instagram) 앱 설치 광고를 보고 앱을 설치·실행했는지를 Meta App Events로 측정한다.
**선택 동의**이며, 동의(iOS는 동의 + 시스템 "앱 추적 허용")가 없으면 Meta SDK는 아무것도 보내지 않는다.
AdMob(배너·보상형)과는 별도 SDK·별도 동의다.

## 1. 구성

| 위치 | 역할 |
| --- | --- |
| `src/features/adMeasurement/consent.ts` | 순수 정책: 동의 기록 형식, 고지문(`AD_MEASUREMENT_NOTICE`)과 그 버전, 측정 허용 판정, iOS 시스템 요청 조건 |
| `src/features/adMeasurement/controller.ts` | 앱 세션 상태(읽기 → 적용 → 질문 → 답 → 철회 → iOS 재확인). SDK·저장소·시계를 주입받는 순수 팩토리. SDK가 **확인한** 시작만 실행 중, 확인한 중단만 중단으로 친다 |
| `src/features/adMeasurement/metaSdk.native.ts` | Meta SDK와 ATT를 부르는 **유일한** 파일. `NativeModules.FBSettings`만 사용(라이브러리 JS는 import하지 않음). Android는 패치한 `startMeasurement`/`stopMeasurement`(완료 후 응답)만, iOS는 기존 설정 호출 + 같은 큐의 읽기 호출로 실행 완료를 확인. 네이티브 응답은 10초 제한(멈춘 호출이 동의 화면을 잠그지 않게) |
| `src/features/adMeasurement/metaSdk.ts` | 웹·Node: 지원 안 함(아무것도 묻거나 보내지 않음) |
| `src/features/adMeasurement/adMeasurement.ts` | 앱 인스턴스(AsyncStorage 키 `trading-app:ad-measurement-consent`) + `useAdMeasurement` |
| `AdMeasurementHost.tsx` (RootNavigator, 푸시 호스트 옆) | 시작 시 적용, 스플래시 다음 첫 화면에서 1회 질문, 설정에서 연 시트, iOS 백그라운드 복귀 시 재확인 |
| `AdMeasurementConsentSheet.tsx` | 고지문 + `동의하지 않음` / `동의`(같은 모양). 첫 질문은 닫기 없음(둘 중 하나로 답) |
| `AdMeasurementSettingsSection.tsx` | MY › 설정(회원)과 투자모드 탭(둘러보기)의 카드: 상태 표시, 끄면 즉시 철회, 켜면 고지문부터 |
| `patches/react-native-fbsdk-next+13.4.3.patch` | 아래 3절 |
| `android/app/src/main/AndroidManifest.xml`, `res/values/strings.xml`, `android/build.gradle`, `android/app/proguard-rules.pro` | Android 네이티브 설정(EAS는 Android prebuild를 하지 않으므로 직접 관리). 매니페스트가 SDK의 `FacebookInitProvider`를 제거한다(3절) |
| `app.json` plugins `react-native-fbsdk-next`, `expo-tracking-transparency` | iOS Info.plist(EAS prebuild) |

동의는 **기기 단위**다(로그아웃·계정 전환과 무관, 앱 삭제 시 함께 삭제). 측정 대상인 설치·첫 실행은 로그인 전에 일어나기 때문이다.

## 2. 동의 정책

| 상태 | Android | iOS |
| --- | --- | --- |
| 모든 실행의 시작 | SDK 코드가 전혀 돌지 않음(시작 provider 제거). 이번 실행에서 JS가 동의 기록을 읽고 확인한 뒤 `startMeasurement`로만 초기화 | SDK 미초기화(어댑터 미링크). 동의 + ATT 허용 확인 뒤 `initializeSDK` |
| 첫 실행(기록 없음) | SDK 미기동, 질문 1회 | SDK 미초기화, 질문 1회(ATT는 묻지 않음) |
| `동의하지 않음` | 아무것도 보내지 않음, 다시 묻지 않음 | 같음(ATT 요청 안 함) |
| `동의` | 즉시 측정 시작(이번 실행의 실행 이벤트 포함) | ATT 미결정이면 시스템 요청 1회 → **허용일 때만** 측정. 거부·제한이면 동의는 기록되지만 측정 안 함 |
| 철회(설정 스위치 끔) | **SDK를 먼저** 중단(이번 실행에서 더 전송·광고 ID 없음, 그 동의를 SDK 쪽에 '철회됨'으로 남김) → 선택 저장. 다음 실행부터 SDK 초기화 안 함 | 즉시 중단 → 선택 저장, 다음 실행부터 SDK 초기화 안 함 |
| 철회 후 같은 실행에서 다시 동의 | 동의는 저장, 측정은 **다음 실행부터**(설정: "앱을 다시 실행하면 측정을 시작합니다") — 이유는 3·4절 | 즉시 다시 시작 |
| iOS 설정에서 앱 추적 변경 | — | 백그라운드 복귀 시 따라감(허용→시작, 끔→중단) |
| 기록 읽기 실패 | 측정 안 함, 질문 안 함. SDK는 시작 전이며, 중단 호출이 이전 실행의 미전송 데이터를 다음 시작 때 버리게 표시 | 측정 안 함, 질문 안 함 |
| 기록 누락·손상 | 선택 없음으로 처리: 측정 안 함, 다시 질문 | 같음 |
| 동의 저장 실패 | 적용 안 함(SDK 시작 안 함) + 안내 | 같음 |
| 철회 저장 실패 | SDK는 이미 중단. SDK 쪽 '철회됨' 기록이 남았으면 철회로 처리(다음 실행에서 그 동의를 거절 → 동의하지 않음으로 다시 저장). 그것도 실패하면 안내 | 이번 실행만 중단 + 안내. iOS에는 두 번째 저장소가 없어, ATT를 허용한 기기는 다음 실행에 측정이 재개될 수 있다(미보장) |
| SDK 시작 실패 | 측정 안 함, 다음 실행에서 다시 시도 | 같음 |
| SDK 중단 실패·무응답 | 성공으로 기록하지 않음: `sdkOn` 유지 → 다음 실행에서 다시 중단, 설정·알림에 "바로 중단하지 못했습니다" 표시. 다음 실행은 선택이 거부이므로 시작 안 함 | 같음 |
| 고지문 개정(`AD_MEASUREMENT_CONSENT_VERSION` 변경) | 이전 동의 무효 → 실행 시작부터 측정 없음, 다시 질문 | 같음 |

- 동의 기록 `{ choice, version, decidedAt, sdkOn }`. **측정 권한의 유일한 근거는 현재 고지문 버전의 `granted` 기록**이다. `sdkOn`은 "마지막으로 확인된 중단 이후 SDK가 돌았을 수 있음" 표시일 뿐 SDK를 켜지 않는다: 시작 **전에** true, SDK가 다음 실행까지 유지되는 중단을 **확인한 뒤** false → 앱이 중간에 꺼지거나 SDK가 실패하면 다음 실행에서 다시 중단한다.
- `decidedAt`은 SDK에 넘기는 동의 식별자다: Android 중단은 그 동의를 '철회됨'으로 남기고, 같은 동의로 시작하면 SDK가 `withdrawn`으로 거절한다(새 동의는 새 `decidedAt`이라 영향 없음).
- Android 광고 ID: 동의 시에만 수집 설정을 켠다. 사용자가 OS에서 광고 ID를 삭제(0으로 반환)하거나 맞춤 광고를 제한하면 SDK가 그 값을 그대로 보낸다(`advertiser_tracking_enabled=false`) — 앱이 따로 우회하지 않는다.
- iOS: SDK v17+는 IDFA·추적 여부를 `ATTrackingManager` 상태에서 직접 읽는다(`setAdvertiserTrackingEnabled`는 무시됨, SDK 소스 확인). ATT 허용이 아니면 SDK 자체를 켜지 않는다.
- AdMob UMP 결과는 Meta 동의로 간주하지 않는다(코드 경로가 아예 다름).

## 3. 왜 패치가 필요한가 (`patch-package`, `postinstall`)

SDK 소스(facebook-android-sdk 18.3.0, facebook-ios-sdk v18.1.1)를 직접 읽어 확인한 결과:

- **iOS**: `FacebookAutoInitEnabled`는 SDK v9.0.0에서 제거됐다(CHANGELOG). 그런데 라이브러리의 Expo 어댑터(`FacebookAppDelegate`, `expo-module.config.json`의 `appDelegateSubscribers`)가 **매 실행 시** `ApplicationDelegate.application(_:didFinishLaunchingWithOptions:)`를 불러 동의 전에 SDK를 초기화하고 서버 설정을 받는다(upstream 이슈 #704: 콜드 스타트마다 `server_domain_infos` 요청). Expo autolinking의 `exclude`는 패키지 전체(JS 브리지 포함)를 빼므로 어댑터만 뺄 수 없다.
  → 패치: `expo-module.config.json`을 `{"platforms": []}`로 바꿔 어댑터를 링크하지 않는다. RN 모듈(`react-native-fbsdk-next.podspec`)은 그대로 링크된다. 동의 후 `Settings.initializeSDK()`가 첫 초기화이며, 앱이 이미 활성 상태이므로 SDK가 지금 실행을 바로 기록한다(`handleDeferredActivationIfNeeded`).
  검증: 스크래치 prebuild에서 생성한 ExpoModulesProvider에 `FacebookAppDelegate`가 없음, 패치 없는 사본에서는 등록됨(음성 대조).
- **Android (2026-11-21 보완)**: SDK의 `FacebookInitProvider`(ContentProvider)는 **모든 프로세스 시작 시, JS보다 먼저** `sdkInitialize()`를 부른다. 이 안에서 플래그와 무관하게 ① 지난 실행에서 디스크에 남은 미전송 이벤트를 flush하고(`FacebookSdk.sdkInitialize`의 init task → `AppEventQueue.flushAndWait` → `readAndClearStore`), ② 서버에서 받아 캐시한 앱 설정의 `auto_log_app_events_enabled`가 있으면 그것이 앱의 `AutoLogAppEventsEnabled=false`보다 우선한다(`UserSettingsManager.checkAutoLogAppEventsEnabled`, 캐시 `com.facebook.internal.preferences.APP_SETTINGS`) → 추적 시작·`activateApp`. 완전 초기화 전이어도 POST는 본문이 **이미 전송된 뒤** 응답만 오류 처리되고(`GraphRequest.createConnection`의 chunked streaming → `serializeToUrlConnection`이 본문을 씀, 검사는 `GraphResponse.fromHttpConnection`), 오류 코드 −1이 "연결 없음"으로 분류돼 다시 저장·재전송된다(`AppEventQueue.handleResponse`). 예전 구현은 동의 후 `AutoInit/AutoLog/AdvertiserIDCollection`을 SDK 설정에 **저장**해 다음 실행이 JS 전에 측정을 시작했으므로, 고지문 개정·기록 손상·읽기 실패·확인되지 않은 철회에서도 JS 확인 전에 이벤트가 나갈 수 있었고, 철회의 `setAutoLogAppEventsEnabled(false)`는 서버 값에 덮일 수 있었다.
  → 앱 매니페스트가 `FacebookInitProvider`를 `tools:node="remove"`로 제거한다. SDK 전체(facebook-core/common/login/share/applinks/gamingservices/messenger 18.3.0 바이트코드)에서 `sdkInitialize`를 부르는 곳은 이 provider와 `FacebookActivity`(exported 아님, 로그인·공유에서만 열림 — 앱은 쓰지 않음)뿐이다. 외부에서 열 수 있는 `CustomTabActivity`(`fbconnect://cct.…`) 경로는 초기화하지 않고 초기화가 필요한 SDK 메서드도 부르지 않는다. 라이브러리 RN 모듈 생성자 10개는 SDK를 부르지 않고, RN 0.83 브리지리스 interop은 레거시 모듈의 `initialize()`를 JS가 그 모듈을 처음 쓸 때만 부른다(`TurboModuleManager.getOrCreateModule`, eager init은 TurboModule만).
  → 패치(`FBSettingsModule`)는 Promise로 답하는 두 호출만 JS에 준다. 둘 다 메인 스레드에서 모든 단계를 마친 뒤 응답한다.
  - `startMeasurement(consent)`: 광고 ID 수집·자동 초기화를 이번 값으로 정하고(첫 요청 전에 완전 초기화 → 위 −1 재전송 없음) `sdkInitialize` → 자동 이벤트(추적 시작) → `activateApp`(설치 1회). 추적이 활동보다 늦게 시작되므로 SDK가 Unity SDK용으로 공개한 `ActivityLifecycleTracker.onActivityCreated/onActivityResumed`로 현재 활동을 재생해 **이번 실행을 지금 기록**한다(세션 저장값·60초 규칙 그대로). 놓친 `onActivityStarted` 횟수는 SDK 18.3.0의 private 필드 `activityReferences`를 1 올려 맞춘다(안 맞추면 이번 프로세스 이벤트의 백그라운드 표시가 뒤집힘; 실패해도 측정은 계속, ProGuard keep 추가). 응답: `started` / `withdrawn`(그 동의는 이 기기에서 철회됨) / `nextLaunch`.
  - `stopMeasurement(consent)`: SDK가 이번 프로세스에서 돌았다면 먼저 flush를 `EXPLICIT_ONLY`로(이후 기록·설정 변경 이벤트 포함 아무것도 자동 전송 안 함 — 앱은 flush를 부르지 않음), `LimitEventAndDataUsage`로 Facebook 앱으로의 기기 내 전달도 막고, 광고 ID 수집(전송 시점에 읽힘)·자동 이벤트·자동 초기화를 끈 뒤, 이 모듈의 SharedPreferences에 그 동의를 `commit()`으로 남긴다. 응답: 저장까지 됐으면 true.
  - 남긴 기록이 있으면 다음 `startMeasurement`는 SDK 초기화 **전에** SDK의 미전송 이벤트 파일(`AppEventsLogger.persistedevents`)과 저장된 세션을 지운다 → 철회 전·중에 쌓인 것은 나중에 다시 동의해도 보내지 않는다.
  - SDK는 추적을 멈추거나 메모리 큐를 비우는 API가 없다. 그래서 한 번 돌다 멈춘 프로세스에서는 다시 시작하지 않고(`nextLaunch`) 다음 실행부터 측정한다.
- 패치는 13.4.3 전용이다(정확한 버전 고정, 위 private 필드·파일 이름은 SDK 18.3.0 고정과 함께 유효). 버전을 올리면 `npx patch-package`가 실패하거나 테스트(`nativeConfig.test.ts`)가 실패한다 — upstream이 #704/#705를 고치면 패치를 지우고 그 방식으로 옮긴다. 패치를 다시 만들 때는 `npx patch-package react-native-fbsdk-next --exclude '^android/build/|package\.json$'`(로컬 Gradle 빌드 산출물이 node_modules 안에 남기 때문).

## 4. 동의 전 SDK가 하는 일 (소스로 확인)

- **Android**: 시작 provider가 없으므로 동의 확인 전에는 SDK가 **초기화되지 않는다** — 설정 로드, anon_id 생성, 이전 실행 이벤트 flush, 서버 설정 조회, Facebook 앱 프로토콜 조회 모두 없음. SDK의 manifest 플래그 셋(false)은 두 번째 방어선으로 둔다. 동의가 없는 실행에서 JS가 부르는 것은 `stopMeasurement`뿐이며, 초기화되지 않은 SDK에서는 메모리 값만 바꾸고(초기화 불필요) 이 모듈의 기록만 쓴다.
  JS는 `FBSettings` 외의 라이브러리 모듈을 만들지 않는다(AppEvents 모듈의 `initialize()`는 광고 ID를 메모리로 읽는다 — 전송은 수집 설정이 켜졌을 때만).
- **Android, 철회한 실행 안에서 남는 것(SDK 한계)**: 추적 콜백은 등록된 채로 남는다. 서버가 자동 이벤트를 강제하면 SDK가 이벤트를 메모리·디스크 큐에 계속 **기록**할 수 있으나 자동 전송은 막혀 있고(`EXPLICIT_ONLY`) 다음 시작 전에 지워진다. 같은 프로세스에서 SDK가 앱 설정·게이트키퍼 GET(이벤트·광고 ID 없음)을 보낼 가능성은 남는다. 광고 ID는 수집 설정이 꺼진 뒤 어떤 요청에도 실리지 않는다(`AttributionIdentifiers.androidAdvertiserId` 게터가 전송 시점에 확인). 이미 전송된 이벤트는 철회로 회수되지 않는다.
- **iOS**: 패치 후 동의 전에는 SDK가 초기화되지 않는다(로드 시 초기화 코드 없음, RN 0.83은 이 라이브러리 모듈을 미리 만들지 않음 — `enableEagerMainQueueModulesOnIOS` 기본 false). 시작 시 iOS는 Info.plist의 세 스위치(false)만 가진다.
- 동의 후에는 SDK의 자동 이벤트(설치·실행·세션 종료, SDK 초기화 정보)만 나간다. 앱 코드는 이벤트를 직접 기록하지 않으므로 자동·수동 중복이 없다. Meta 문서 기준 60초 안의 두 번째 실행은 기록되지 않는다. Android `activateApp`의 설치 핑은 설치당 1회(`lastPing`).

## 5. 데이터 경계 — 이벤트를 늘릴 때 지킬 것

- Meta에 보내는 것: SDK 자동 이벤트와 그 부가정보(설치·실행·종료 시각과 사용 시간, 광고 식별자(동의·허용 시), SDK 임의 식별자(anon_id), Android에서 Facebook 앱이 있으면 그 광고 기여도 식별자, 기기 모델·OS·언어·시간대·통신사·화면, 앱 버전, 설치 리퍼러, IP, SDK 오류 기록). 고지문·개인정보처리방침 2항이 이 목록이다.
- 보내지 않는 것: 이메일, 닉네임, 회원 ID, 잔액·수익률·포트폴리오, 주문·체결·거래 기록, 지갑·원장·시즌, 토큰. `setUserID`/`setUserData`/`logEvent`를 쓰지 않는다 — `nativeConfig.test.ts`가 라이브러리 JS import, `AppEventsLogger`·`logEvent(`·`setUserData`·`setUserID` 사용, `FBSettings`/ATT 접근 위치(어댑터 1개)를 검사한다.
- 이벤트를 추가하려면: ① 고지문(`AD_MEASUREMENT_NOTICE`)과 개인정보처리방침에 항목을 먼저 넣고 두 버전을 올린다(고지문 버전 → 모든 기기 재동의, 방침 버전 → 서버 허용 목록에도 추가) ② 금융·계정 정보는 값·범주·해시 어떤 형태로도 넣지 않는다 ③ 호출은 `metaSdk.native.ts`에만 두고 동의 판정(`measurementAllowed`)을 거친다 ④ 경계 테스트를 의도적으로 수정한다.
- Meta 서버 측 기능이 앱 데이터를 더 가져갈 수 있다: **자동 고급 매칭(AAM)** 은 켜져 있으면 입력란(로그인 이메일 등)의 값을 해시해 보낸다(Android `MetadataIndexer`, 서버 규칙으로 동작) — 이벤트 관리자에서 반드시 꺼 둔다. 코드리스 이벤트(이벤트 설정 도구)도 쓰지 않는다.

## 6. AdMob과의 관계

- 두 SDK는 초기화 경로가 다르다: AdMob은 광고 자리가 생길 때 UMP → `initialize()`(기존 그대로, 코드 변경 없음), Meta는 이 기능의 동의 후에만. 서로의 동의를 참조하지 않는다.
- **Android `AD_ID` 권한은 앱 전체에 적용된다.** Google Mobile Ads 25.0.0도 이 권한을 선언하므로, 이번 변경으로 Android 13+ 기기에서 **AdMob도 광고 ID를 읽을 수 있게 된다**(지금까지는 0으로 받음; Android 12 이하는 권한과 무관하게 이미 읽을 수 있었다). 광고 요청은 계속 비개인화(`requestNonPersonalizedAdsOnly`)지만 Google은 비개인화 광고에도 빈도 제한·집계 보고·부정 방지에 기기 식별자를 쓴다. 개인정보처리방침 2·4항과 Play 데이터 보안·광고 ID 선언에 반영해야 한다.
- **iOS 앱 추적 허용도 앱 단위다.** 사용자가 Meta 측정을 위해 허용하면 AdMob도 IDFA를 쓸 수 있다 → ATT 문구와 고지문에 적었다.
- AdMob의 AdServices(Privacy Sandbox) 권한 3개와 Meta SDK가 새로 선언한 `ACCESS_ADSERVICES_CUSTOM_AUDIENCE`는 계속 제거한다(필요성 미검증).
- AdMob 콘솔에 **IDFA 설명 메시지(UMP)** 가 게시돼 있으면 UMP가 ATT를 동의와 무관하게 띄울 수 있다(이제 Info.plist에 ATT 문구가 있으므로). 게시돼 있지 않은지 확인해야 한다.
- 보상형 광고 SSV·지급·배너 코드는 변경하지 않았다.

## 7. ATT 미허용 환경의 개인정보 보호형 측정 (검토 결과, 미적용)

- **Meta AEM(Aggregated Event Measurement)**: ATT를 거부한 iOS 사용자도 SDK 이벤트(IDFA 없이, 비추적 도메인)로 집계 측정한다. SDK가 동작해야 하므로 현재 정책(ATT 허용 시에만 SDK)에서는 쓰이지 않는다. 켜려면 `measurementAllowed`의 iOS 조건을 "동의만"으로 바꾸면 되지만, Apple의 "추적" 정의(광고 측정을 위한 타사 데이터 연결 포함)와 App Review 5.1.2 해석이 걸려 있어 운영·법무 판단이 필요하다.
- **Apple SKAdNetwork**: Apple이 중계하는 집계형 설치 기여도(ATT 불필요, 앱→Meta 직접 전송 없음). 광고되는 앱이 SKAdNetwork 전환값 API를 호출해야 설치가 등록되는 것으로 알려져 있으나 이번 작업에서 Apple 문서 원문을 확인하지 못했다(확인 필요). Meta SDK가 이 호출을 하므로 현재는 동의 + ATT 허용 사용자만 해당. 미허용 사용자까지 넓히려면 iOS 네이티브 코드(작은 Expo 모듈)로 첫 실행에 전환값을 호출해야 한다 — 미구현.
- Info.plist의 `SKAdNetworkItems`에 플러그인이 넣은 Meta ID 2개(`v9wttpbfk9`, `n38lu8286q`)는 **우리 앱 안에 Meta 광고를 띄울 때**(퍼블리셔) 쓰는 값이라 설치 측정과 무관하며 무해하다(AdMob `cstr6suwn9`와 함께 병합됨).

## 8. 개인정보처리방침·버전 호환

- 앱 내 방침(`constants/legalDocuments.ts`)을 `2026-11-21`로 개정: 처리 목적·항목(광고 성과 측정 — 선택, 앱 안 광고 — AdMob), 보유기간 2행, 4항을 "처리위탁, 제3자 제공 및 국외 처리"로 바꾸고 Meta·Google(AdMob) 표 추가, 6항에 철회·OS 설정 방법, 기존 "광고 ID … 수집하지 않습니다" 문장 교체. **초안이다 — 법무·운영 검토 후 웹 게시본과 글자까지 같게 맞춰야 배포할 수 있다.**
- 서버(`backend/src/auth/terms.constants.ts`)는 `2026-11-21`과 `2026-10-20`을 모두 받고, 회원이 실제로 본 버전을 기록한다(구버전 앱의 가입 유지). 배포 순서: 서버 먼저 → 앱. 구버전 앱이 사라지면 `2026-10-20`을 목록에서 뺀다.

## 9. 콘솔·스토어 작업 (사용자)

**Meta 개발자센터 (developers.facebook.com › 내 앱 › 트레이딩클래스, 앱 ID 1450675133819583)**
1. 앱 설정 › 기본 설정: iOS — 번들 ID `com.leagueoftrading`, iPhone 스토어 ID(App Store 앱 ID, 2026-11-12 조회값 `6824899937` — 확인), Android — 패키지 `com.nanghwa.tradingclass`, 클래스 `com.nanghwa.tradingclass.MainActivity`, Google Play 패키지 연결. (키 해시는 Facebook 로그인용 — 이번 범위 아님.)
2. 자동 앱 이벤트 로깅이 켜져 있는지 — Meta 문서: 이벤트 관리자의 데이터 세트 설정에서 자동 이벤트 로깅을 끄면 코드에서 켜도 동작하지 않는다(정확한 메뉴명은 운영자 확인). 플랫폼 카드의 인앱 결제 자동 로깅은 해당 없음(아니요).
3. 앱이 "라이브" 모드이고, 광고 계정이 이 앱의 광고를 집행할 수 있는지(앱 설정 › 고급 › 광고 계정 승인).
4. App Secret은 앱·저장소에 넣지 않는다(이번 변경에 없음).

**Meta 이벤트 관리자 (business.facebook.com › 이벤트 관리자 › 데이터 소스 › 해당 앱)**
5. 설정: **자동 고급 매칭 끔**, 코드리스 이벤트(이벤트 설정 도구) 미사용 확인. (메뉴 이름은 콘솔 버전에 따라 다를 수 있어 운영자 확인 필요.)
6. iOS: SKAdNetwork/전환값 설정과 AEM은 7절 결정 후.

**Google Play Console (앱 › 정책 › 앱 콘텐츠)**
7. **광고 ID 선언**: "예, 광고 ID 사용" — 목적: 광고 또는 마케팅, 분석(Meta 설치 측정), 사기 방지·보안(AdMob). `AD_ID` 권한이 든 빌드를 올리기 전에 해야 한다(선언 불일치 시 출시 차단).
8. **데이터 보안**: 기기 또는 기타 ID(수집·공유: Meta, Google), 앱 활동 › 앱 상호작용(설치·실행 — Meta, 사용자 선택 가능), 앱 정보 및 성능 › 비정상 종료 로그·진단(Meta SDK, AdMob). 각 SDK의 공개 안내(Google Mobile Ads 데이터 공개 가이드, Meta)와 대조.

**App Store Connect (앱 › 앱 개인정보 보호)**
9. 식별자 › 기기 ID(제3자 광고·분석, **추적에 사용**), 사용 데이터 › 제품 상호작용(분석·제3자 광고), 진단 › 충돌 데이터, 기타 데이터(분석). "추적에 사용되는 데이터"에 기기 ID. FBSDKCoreKit privacy manifest: Tracking=true, 추적 도메인 `ep1.facebook.com`, DeviceID(linked·tracking), OtherDataTypes(analytics), CrashData.
10. 심사 메모: "앱 내 광고 성과 측정 동의(개인정보 보호법상 별도 동의)를 먼저 묻고, 동의한 경우에만 ATT를 요청한다. 거부해도 모든 기능 사용 가능." — App Review가 ATT 앞의 자체 화면에 '동의하지 않음'이 있는 것을 5.1.1(iv)로 문제 삼은 사례가 있다(포럼 사례, 공식 규정 아님). 반려되면 대응 방향을 운영자가 결정.

**AdMob 콘솔 (개인정보 보호 및 메시지)**
11. iOS **IDFA 설명 메시지가 게시돼 있지 않은지** 확인(게시돼 있으면 UMP가 동의와 무관하게 ATT를 띄운다).

**개인정보처리방침 웹 게시 (nanghwa.com/tradingclass/privacy/)**
12. 검토된 개정본을 게시하고(앱 내 텍스트와 동일, 버전 라벨 `2026-11-21` 또는 바뀐 라벨로 세 곳 동시 수정: `frontend/src/constants/legal.ts`, `backend/src/auth/terms.constants.ts`, `legalDocuments.test.ts`), 방침 10항에 따라 시행 전 공지.

## 10. 실기기 검증 절차 (미실행 — EAS 빌드 필요)

1. 새 EAS **preview/internal** 빌드(Android APK, iOS TestFlight 내부). 기존 빌드에는 SDK가 없다(OTA 경로 없음).
2. 동의 전 무전송: 프록시(Charles/mitmproxy 등)로 `*.facebook.com` 연결이 없는지 — 첫 실행 질문이 떠 있는 동안, `동의하지 않음` 후 재실행까지.
3. Android: 설치 → 첫 질문 `동의` → 설치 핑과 이번 실행 이벤트가 즉시 1회씩(재생된 실행). 콜드 스타트를 반복하면 매번 `graph.facebook.com` 첫 연결이 JS의 동의 확인 **뒤**에 일어나는지(앱 프로세스 시작 직후 연결 없음), 60초 안의 재실행은 실행 이벤트가 없는지. iOS: `동의` → ATT 허용 → 즉시 실행 이벤트. ATT 거부 → 무전송.
4. 수신 확인: App Ads Helper(developers.facebook.com/tools/app-ads-helper › 앱 선택 › 앱 이벤트 테스트) 또는 이벤트 관리자 › 테스트 이벤트 / 개요(지연 있음). 이벤트의 앱 ID가 1450675133819583인지, 같은 실행이 두 번 오지 않는지, 실행 이벤트에 `_inBackground`가 붙지 않는지(Android 재생 보정 확인).
5. 철회: 설정 스위치 끔 → 같은 실행의 이후 사용·백그라운드 전환에도 `/activities` POST 없음, 이후 실행·복귀에도 무전송. 로그아웃·재실행 후에도 선택 유지. 같은 실행에서 다시 동의 → "앱을 다시 실행하면 측정을 시작합니다" → 재실행 시 측정 재개, 철회 중 기록분은 오지 않음.
5-1. Android 실패·중간 종료: 비행기 모드로 측정 중 이벤트를 쌓고 철회 → 재실행·재동의 후에도 그 이벤트가 오지 않는지. 철회 직후 강제 종료(설정 › 앱 › 강제 중지) → 재실행 무전송. 고지문 버전을 올린 빌드로 업데이트 → 재동의 전 무전송. `adb shell run-as com.nanghwa.tradingclass` 로 앱 데이터의 AsyncStorage 기록을 지우거나 손상 → 질문, 무전송.
6. AdMob 회귀: 홈·커뮤니티 배너, 보상형 광고 충전 1회(SSV 지급) — 기존 절차(`admob-ads-2026-11-07.md`).
7. 실제 광고 귀속: Meta 앱 설치 캠페인을 집행해 광고 관리자 결과에 설치가 귀속되는지 — 이벤트 수신과 별개 단계.
