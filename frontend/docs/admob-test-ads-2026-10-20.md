# AdMob 보상형 테스트 광고 연동

작업일: 2026-10-20. 시작 HEAD/fetch한 origin/main: `6fe9b6ce23442616261cd0b09025aa9a1bb54b8b`, 작업 트리 clean. 사용자 지시에 따라 main에서 작업했다. 최종 SDK/권한 소스 커밋: `dfbf7b4164b7dd6902dba5b2c6e59d20ff7891f8`.

**이번 변경은 SDK 테스트 전용이다. 실제 지급·초기화·SSV·수익화는 활성화하지 않았다. Android/iOS 실기기 광고 표시는 미검증이다.**

## SDK 선택과 네이티브 설정

`react-native-google-mobile-ads` **16.3.4 고정 버전**을 npm으로 설치했다. 기존 lock 기준 Expo 55.0.17, React Native 0.83.6, React 19.2.0과 Kotlin 2.1은 변경하지 않았다.

- npm에서 받은 17.3.0의 실제 peer dependency는 RN `>=0.86.0`이라 제외했다. 릴리스 요약만 보고 최신 버전을 설치하지 않았다.
- 16.3.4는 선택적 Expo peer `>=47.0.0`, 패키지 개발 의존성 RN `^0.83.1`/React `^19.2.0`, TurboModule/Fabric codegen, Expo Config Plugin을 포함한다. 이는 정적 호환성 근거이며 네이티브 실행 검증을 대신하지 않는다.
- 최초 검토한 16.5.0은 peer/RN 소스 기준에는 맞았지만, 실제 EAS에서 Google Ads 25.4.0의 Kotlin metadata 2.3이 기존 컴파일러 2.1과 충돌해 실패했다. 빌드 로그와 [maintainer의 동일 이슈·16.3.4 고정 권고](https://github.com/invertase/react-native-google-mobile-ads/issues/863)를 확인했다. Kotlin을 올리거나 metadata 검사를 우회하지 않고 16.3.4로 내렸다. caret도 허용하지 않는 회귀 검사를 추가했다.
- 최종 패키지 SDK 버전: Android Google Mobile Ads 25.0.0/UMP 4.0.0, iOS Google Mobile Ads 13.1.0/UMP 3.1.0. Android minSdk 23 요구보다 앱의 기존 minSdk 24가 높다. 생성한 iOS 프로젝트의 deployment target은 15.1이다.
- 기존 앱은 Android 네이티브 프로젝트를 Git으로 관리한다. EAS가 그 파일을 사용하므로 Config Plugin만 추가하지 않고 실제 AndroidManifest에도 앱 ID·초기화 지연·최적화 metadata를 반영했다. 기존 applicationId, 아이콘, 딥링크, 알림 설정, backup/권한 설정은 보존했다.
- iOS 식별자는 원래 없었고 EAS iOS 빌드 이력도 없었다. 사용자 확인 후 `com.leagueoftrading`으로 최초 설정했다. 기존 식별자를 변경한 것이 아니다.
- iOS에는 앱 ID, 초기 측정 지연, Google SKAdNetwork 항목 `cstr6suwn9.skadnetwork`을 Plugin으로 적용한다. ATT 설명/권한과 정적 frameworks 설정은 추가하지 않았다. Firebase/중개 광고 SDK도 추가하지 않았다.
- Android `AD_ID`는 Config Plugin의 `blockedPermissions`와 실제 manifest에서 제거한다. 2차 APK 검사에서 SDK가 자동 병합한 `ACCESS_ADSERVICES_AD_ID`·`ACCESS_ADSERVICES_ATTRIBUTION`·`ACCESS_ADSERVICES_TOPICS`도 발견해 제거했다. 이 단계에 광고 관심사·기여도 측정 기능은 필요하지 않으며 [Google의 공식 opt-out 안내](https://developers.google.com/admob/android/privacy/sandbox)에 따른다. 네트워크·화면 표시 및 기존 앱 권한은 보존한다. 이 제거가 SDK의 모든 데이터 수집을 막는다는 뜻은 아니다.

참고: [라이브러리 설치](https://docs.page/invertase/react-native-google-mobile-ads), [16.3.4 소스](https://github.com/invertase/react-native-google-mobile-ads/tree/v16.3.4), [Google Android 시작](https://developers.google.com/admob/android/quick-start), [iOS 시작](https://developers.google.com/admob/ios/quick-start).

## 식별자 및 EAS 환경

| 플랫폼 | 네이티브 앱 ID | 공식 테스트 Rewarded 단위 | 준비한 운영 Rewarded 단위 |
| --- | --- | --- | --- |
| Android | `ca-app-pub-7899930948413451~9002185139` | `ca-app-pub-3940256099942544/5224354917` | `ca-app-pub-7899930948413451/3165650506` |
| iOS | `ca-app-pub-7899930948413451~7288069200` | `ca-app-pub-3940256099942544/1712485313` | `ca-app-pub-7899930948413451/8170740188` |

앱 ID는 `app.json`의 Plugin에, 광고 단위는 빌드별 `extra.adMob`에 들어간다. 공개 식별자이며 인증 비밀이 아니다. 기존 `extra.eas`와 `extra.build` 커밋·프로필·빌드 ID 스탬프는 보존했다.

- Development/Preview: 공식 테스트 단위로 강제한다. 환경변수에 실광고 ID를 넣어도 테스트 요청에 사용하지 않는다.
- Production: `mode=disabled`. 두 운영 단위는 EAS **production 프로젝트 환경**의 `ADMOB_REWARDED_ANDROID_ID`, `ADMOB_REWARDED_IOS_ID`에 plaintext로 새로 저장했다. 기존 값이 없음을 확인했으며 다른 EAS 환경변수는 변경하지 않았다. 값은 설정 준비에만 사용한다.
- 각 기존 EAS 프로필의 `ADMOB_BUILD_PROFILE` 한 항목은 EAS CLI의 로컬 config 평가와 원격 worker를 일치시킨다. 로컬 평가에서는 worker 전용 `EAS_BUILD_PROFILE`이 placeholder 객체라 문자열 비교가 성립하지 않았던 문제를 실제 `eas config`로 확인했다. worker의 실제 프로필과 명시 프로필이 다르면 비활성화한다.
- 알 수 없는 프로필/일반 로컬 실행은 비활성이다. 로컬 개발 클라이언트는 `EAS_BUILD_PROFILE=development npx expo start --dev-client`로 실행한다.
- 플랫폼·프로필·mode·정확한 공식 단위를 모두 확인하며 native adapter에서도 `TestIds.REWARDED`와 재대조한다. 앱 일반 설정/UI 토글로 전환할 수 없다. Production은 `__DEV__` 값과 무관하게 실행되지 않는다.
- Expo Go에는 네이티브 모듈이 없어 테스트 UI를 노출하지 않는다. 구 APK/모듈 누락은 사용자가 테스트를 시작할 때만 오류 상태가 되며 앱 시작을 막지 않는다. 웹은 SDK를 import하지 않는 fallback을 사용한다.

공식 단위 근거: [Android 테스트 광고](https://developers.google.com/admob/android/test-ads), [iOS 테스트 광고](https://developers.google.com/admob/ios/test-ads).

## 사용자 흐름과 금융 경계

일반모드 홈 헤더의 **보상 → 자금 관리 → 보상형 테스트 광고**를 사용한다. 기존 자금 추가/초기화 버튼은 계속 비활성이다. 시즌·초보 계정에는 테스트 패널이 없다.

`테스트 광고 불러오기` → SDK/UMP 준비 → 로딩 → 준비 완료 → 사용자가 `테스트 광고 시청` → 표시 요청 → 네이티브 OPENED → 표시 중 → EARNED_REWARD → CLOSED 순서로 처리한다. 네이티브 표시 이벤트가 없으면 성공으로 처리하지 않는다. 보상 이벤트 수신과 광고 종료를 구분하고, 종료 후에만 `테스트 광고 시청 완료`를 표시한다. 완료 전에 닫으면 조기 종료로 표시한다.

SDK 준비 오류, 로딩 오류/광고 미수신, 표시 오류를 구분한다. 준비·로딩·표시 시작에는 45초 제한이 있고 자동 재시도/자동 재로딩은 없다. 다시 누르는 경우에만 새 광고 객체를 생성한다. 준비 전 표시 금지, 연속 터치 시 동기 상태 변경으로 중복 실행 금지, 한 광고 객체 재사용 금지, 앱 전체 동시 표시 금지를 적용했다.

화면을 숨기거나 계정이 바뀌면 패널이 언마운트되어 timer·구독·상태를 정리한다. 세션 generation 검사로 로그아웃 이전 callback도 무시한다. v16은 표시 중인 네이티브 광고를 강제로 닫는 API가 없으므로, 이때는 UI observer만 먼저 해제하고 CLOSED/ERROR 처리만 남겨 표시 잠금을 정확히 해제한다. SDK가 종료 이벤트를 잃으면 광고 기능만 재시작이 필요할 수 있으며 다른 거래 기능을 차단하지 않는다.

테스트 실행기는 **proof/purpose/idempotency/금융 콜백을 받거나 만들지 않는다.** 금융용 `getRewardedAdProvider()`는 계속 null이다. 완료 이벤트에서 eligibility 조회, claim/reset, cache 무효화, 원장·잔액·성과 변경을 요청하지 않는다. UI 통합 테스트에서 읽기/쓰기 금융 요청과 무효화가 모두 0임을 확인했다. 운영 DB 잔액을 직접 조회·변경한 검증은 하지 않았다.

기존 서버는 verifier registry가 비어 있고 검증된 제공자 증명이 없으면 거부한다. 서버·DB·API·운영 verifier 설정은 변경하지 않았다. 추후 SSV에서는 Google 서명/키·이벤트 재생 방지·사용자/일반계정/명령 목적 결합을 검증한 뒤에만 기존 멱등 지급·초기화 경계와 연결해야 한다. 클라이언트 EARNED_REWARD는 그 증명이 아니다.

## 동의 및 출시 전 준비

테스트 SDK 준비 시 UMP `gatherConsent()` 후 `canRequestAds`를 확인하고, 허용된 경우에만 SDK를 초기화한다. 필수 privacy options가 있으면 같은 패널에 다시 선택할 수 있는 버튼을 표시한다. 선택 변경 시 기존 로드 광고를 버린다. 요청은 NPA(`requestNonPersonalizedAdsOnly`)이며 ATT 요청은 구현하지 않았다. 동의 조회 실패를 허용 상태로 바꾸지 않는다.

공식 테스트 단위는 실광고 과금/무효 트래픽 테스트를 피하기 위한 것이며 **개인정보 전송이 없다는 뜻은 아니다.** SDK/UMP가 처리하는 데이터, AdMob 계정의 지역별 메시지, 연령 정책, ATT/IDFA 사용 여부를 출시 전에 확정해야 한다. iOS IDFA 메시지/ATT는 현재 구현·선언과 맞춰 준비해야 한다.

스토어 출시 전 Google Play의 광고 포함 표시·Data safety, Apple App Privacy·암호화 분류·필요한 ATT/동의·SKAdNetwork 구성을 실제 SDK 버전과 앱 사용 방식에 맞춰 검토해야 한다. 저장소에서 Trading Class의 확정된 개인정보처리방침 문서/공개 URL은 확인하지 못했다. 앱/스토어/웹 정책의 광고 SDK 관련 설명도 정비해야 한다. 준수 완료로 판정하지 않는다.

근거: [UMP](https://developers.google.com/admob/ios/privacy), [Android 데이터 공개](https://developers.google.com/admob/android/privacy/play-data-disclosure), [Apple 공개 항목](https://developers.google.com/admob/ios/privacy/data-disclosure), [ATT/IDFA](https://developers.google.com/admob/ios/privacy/idfa). 데이터 공개 문서는 최신 SDK 기준이므로 선택한 25.0.0/13.1.0과 출시 시점의 차이도 재확인해야 한다.

## 검증 및 빌드

- 타입 검사, `lint:accounts:check`, 진단 우회 검사 PASS.
- 전체 `npm run check`: 최초 768MB 제한에서 ESLint heap 부족으로 종료됐다. 프로세스 종료와 원인을 확인하고 1536MB/600초 제한으로 실행했다. 린트 2종·타입 PASS, 테스트 2,890개 PASS 후 시간 제한으로 36개 파일이 취소되어 명령은 exit 124였다(단언 실패 0). 자식 프로세스 종료를 확인한 뒤 취소 파일만 같은 메모리/시간 제한으로 실행해 434개 PASS, 취소/skip 0을 확인했다. 두 실행으로 전체 파일의 **3,324개 테스트를 검증**했으며 단일 `npm run check`의 성공 종료로 표현하지 않는다. 테스트 삭제/완화·메모리 부족 실패를 성공으로 치환하지 않았다.
- 광고·기존 보상/홈·현물/선물 상세·시트 회귀 87개 PASS. 이후 로그아웃·SDK 고정 항목을 추가하고 변경 관련 27개 PASS(중복 제외 89개). skip/검증 삭제 없음. ReactTestInstance 직접 null/undefined 비교 없음.
- 실제 EAS 설정 평가: Android Development 및 Android/iOS Preview는 공식 테스트 단위, Production은 제공된 운영 단위가 준비되어 있으나 실행 비활성 확인. 자동 테스트도 각 프로필·충돌/unknown/실광고 단위 거부를 확인한다. [공개 광고 설정만 추린 결과](artifacts/admob-test-ads-2026-10-20/eas-config-results.json).
- Expo introspect: 두 앱 ID·측정 지연·기존 Plugin/빌드 스탬프·Android AD_ID 제거·iOS ATT 설명 미추가 확인.
- 별도 `/tmp` 프로젝트에서 iOS prebuild PASS. Bundle Identifier와 Info.plist/GAD 설정 확인. 원본 저장소에 생성 iOS 프로젝트나 임의 네이티브 재생성 변경을 넣지 않았다. CocoaPods/Xcode 컴파일을 통과한 결과는 아니다.
- Android Hermes JS export와 Web export PASS. 두 플랫폼 네이티브 앱에서 실제 광고를 본 결과는 아니다.
- Android EAS Preview 1차: [e7c463a2](https://expo.dev/accounts/mycroft7947/projects/leagueoftrading/builds/e7c463a2-9f40-4992-ac5c-64308a0a2289), SHA `7b77de83`, 16.5.0의 Kotlin metadata 충돌로 실패. 실패를 정상으로 처리하지 않았다.
- Android EAS Preview 2차: [49ff1a33](https://expo.dev/accounts/mycroft7947/projects/leagueoftrading/builds/49ff1a33-7d03-428a-8558-e8100797c56b), SHA `3a0408a5`, SDK 16.3.4, 기존 keystore 사용, **FINISHED**. 권한 정리 전 중간 빌드다.
- 생성된 2차 APK를 내려받아 binary AndroidManifest와 `assets/app.config`를 직접 파싱했다. 패키지 `com.leagueoftrading`, Android 앱 ID/초기화 지연·최적화 metadata, AD_ID 권한 부재, 내장 `mode=test/profile=preview`·양 플랫폼 공식 단위·빌드 SHA/프로필을 확인했다. 이 검사에서 추가 광고 권한 3개를 찾아 제거한 후 재빌드했다. [중간 APK 검사 기록](artifacts/admob-test-ads-2026-10-20/android-build-interim-results.json).
- 광고 권한 정리 후 config/build-stamp 회귀 7개·타입 검사·Expo introspect PASS. Android 실제 manifest와 생성 manifest 모두 네 광고 권한을 제거한다.
- **최종 Android EAS Preview 3차:** [062b84f1](https://expo.dev/accounts/mycroft7947/projects/leagueoftrading/builds/062b84f1-6f9d-48f6-a346-fd877d3d458f), SHA `dfbf7b41`, SDK 16.3.4, 기존 keystore 사용, **FINISHED**. [최종 설치용 APK](https://expo.dev/artifacts/eas/HJqhPhLrOcQ7DmHAGdbQG5yneMNoVks0-S3jK1P0mKY.apk).
- 최종 APK도 binary manifest/내장 app.config를 직접 검사했다. 올바른 앱 ID·초기화 지연·최적화, 테스트 모드/공식 단위, `dfbf7b41 · preview` 스탬프, 네 광고 권한 부재를 확인했다. 2차 대비 권한 차이는 위 AdServices 3개 제거뿐이며 추가 권한은 없다. [최종 APK 검사 및 SHA-256](artifacts/admob-test-ads-2026-10-20/android-build-results.json). 소스 설정만 읽은 결과와 구분하며, 기기 설치/광고 실행 검증은 아니다.
- EAS Expo Doctor는 18/20이다. 기존 네이티브 디렉터리와 app config의 동기화 경고, 기존 Expo/dev-client/RN/SVG patch 버전 불일치(55.0.17/55.0.28/0.83.6/15.15.5)가 남아 있다. 이번 SDK 설치에서 이 버전들은 바뀌지 않았다. 요청 범위를 넘어 업그레이드하거나 검사를 무시하는 설정을 추가하지 않았다. Android 실제 manifest의 SDK metadata를 별도로 반영했다.
- 격리한 RN-Web UI fixture 8개(320/390px × 글꼴 1/2 × Light/Dark) PASS: 버튼 텍스트 잘림·가로 넘침 없음, 시청 완료와 금융 성공 UI 분리, 금융 요청 0. [결과 JSON](artifacts/admob-test-ads-2026-10-20/ui-results.json). 실제 Google 광고/네이티브 화면 검증은 아니며 fixture는 `/tmp`에서만 실행했다.
- iOS EAS Preview: 실제 명령을 실행했으나 **internal distribution에 맞는 기존 서명 credentials가 없어 중단**됐다. `--freeze-credentials`로 서명 정보를 새로 만들지 않았다. EAS가 최초 iOS 원격 buildNumber를 1로 초기화했으며 빌드는 생성되지 않았다. 암호화 공개 항목 미설정 경고도 있어 출시 전에 분류가 필요하다.
- Android/iOS 기기·에뮬레이터 없음: 광고 최초 표시·완료·닫기·조기 종료, 실제 네트워크 장애, 네이티브 Safe Area/시스템 바·Light/Dark·작은 화면·큰 글꼴의 시각 검증 **NOT_RUN**.

[검사 결과 요약과 시간 제한 후 재실행 파일 목록](artifacts/admob-test-ads-2026-10-20/verification-results.json).

검증 명령:

```sh
cd frontend
npm run typecheck
npm run lint:accounts:check
# 전체 check의 시간 제한 후 취소 파일만 재실행한 결과는 위에 구분 기록.
NODE_OPTIONS=--max-old-space-size=1536 timeout --kill-after=10s 600s npm run check
NODE_OPTIONS=--max-old-space-size=512 timeout --kill-after=5s 120s \
  node --test --test-isolation=none --test-reporter=tap --test-concurrency=1 \
  src/features/adRewards/rewardedTest*.test.ts src/features/adRewards/rewardFlow.test.ts \
  src/screens/home/RewardedTestPanel.test.ts src/screens/home/GeneralRewardSheet.test.ts \
  src/screens/home/homeRewardEntry.test.ts src/utils/buildInfo.test.ts \
  src/screens/asset/AssetDetailFlow.test.ts src/screens/futures/FuturesDetailScreen.test.ts \
  src/components/common/InlineBottomSheet.test.ts
eas config -p android --profile preview --json
eas config -p android --profile development --json
eas config -p ios --profile preview --json
eas config -p android --profile production --json
EAS_BUILD_PROFILE=preview npx expo config --type introspect --json
eas build -p android --profile preview --non-interactive --freeze-credentials
```

## 남은 실기기 절차 및 Git/배포

1. 최종 Android Preview APK를 설치하고 앱 정보의 `빌드 dfbf7b41 · preview`를 확인한다. 최초 실패 빌드·권한 제거 전 중간 APK와 구분한다. 일반모드 보상 패널에서 불러오기/표시를 별도로 누르고 공식 테스트 광고 표시를 확인한다.
2. 완료 후 닫기와 완료 전 닫기를 각각 확인한다. 비행기 모드·실패·연속 클릭·뒤로가기·다른 계정/로그아웃·재진입을 확인한다. 금융 버튼이 비활성이고 지갑/총자산/수익률/원장에 변화가 없는지도 동일 계정에서 비교한다.
3. 3버튼/제스처, Light/Dark, 작은 화면·큰 글꼴에서 패널 끝까지 스크롤과 닫기, 시스템 영역 침범, 광고 종료 후 홈·주문·차트 사용을 확인한다.
4. iOS는 Apple Developer 팀·`com.leagueoftrading` App ID·테스트 기기 UDID/프로비저닝을 준비한 뒤 `cd frontend && eas build -p ios --profile preview`를 **대화형으로** 실행한다. 서명 확인 후 동일 테스트와 Safe Area를 확인한다. Expo Go/OTA 업데이트만으로는 새 SDK를 설치할 수 없다.
5. 실제 SSV, 광고 수익화, 스토어/개인정보 준비, 실제 지급/초기화 연동, 양 플랫폼 운영 광고 검증은 후속 작업이다. 이번 코드의 Production 차단을 환경변수만 바꿔 해제할 수는 없다.

Render 읽기 전용 확인: `league of trading`, 서비스 `trading_app`, rootDir `backend`, main/commit 자동 배포, 현재 live `9ed671c2`. GitHub 워크플로는 품질 검사이며 EAS 자동 제출/스토어 배포 경로는 없다. [Render 공식 문서](https://render.com/docs/deploys#skipping-an-auto-deploy)에 따라 모든 이번 main 커밋에 `[skip render]`를 사용한다. 이는 Render 자동 배포만 건너뛰며 수동 배포/다른 CI/스토어 제출을 막는 기능은 아니다. 운영 Render 배포·EAS Update·스토어 제출·금융 데이터 변경은 수행하지 않는다.

전체 diff 자체 검토: 버전·식별자·테스트/실광고 분리·구독 정리·금융 경계·테스트 실패 경로·기존 UI/프로필/스탬프 보존 확인. 일반 금융·주문·체결·시즌·FX·선물 위험관리와 백엔드는 변경하지 않았다.

## 변경 파일의 역할

| 파일 | 목적 |
| --- | --- |
| `package.json`, `package-lock.json` | 호환 버전 고정 및 npm 잠금 파일 |
| `app.json`, `app.config.js`, `config/admob.cjs`, `eas.json` | 두 앱 ID·승인한 iOS 식별자·환경별 테스트/disabled 선택·기존 빌드 스탬프 보존 |
| `android/app/src/main/AndroidManifest.xml` | 실제 관리 네이티브 프로젝트에 SDK metadata 및 불필요한 광고 권한 제거 적용 |
| `src/features/adRewards/rewardedTest{,Config,Sdk.native,Sdk}.ts` | 테스트 전용 상태 전환·엄격한 단위 선택·지연 네이티브 로드·웹 fallback |
| `src/screens/home/RewardedTestPanel.tsx`, `GeneralRewardSheet.tsx` | 기존 일반모드 시트에 테스트 전용 실행과 독립 결과 안내 연결 |
| `src/features/adRewards/rewardedAd.ts` | 금융용 provider null 유지 이유를 SSV 경계로 명확화(동작 불변) |
| 광고/보상/빌드 정보 `*.test.ts`, `test/rewardSheetHarness.cjs` | 상태·환경·금융 요청 0·회귀·구독 정리 검증, 기존 검증 의미 유지 |
| 이 문서, `docs/artifacts/admob-test-ads-2026-10-20/`, 루트 `HANDOVER.md` | 설계 이유·실패 원인·실제 빌드/검사 근거·미검증·후속 절차 기록 |
