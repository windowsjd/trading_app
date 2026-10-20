# Android 출시 패키지 변경

- Android: `com.leagueoftrading` → `com.nanghwa.tradingclass`.
- Expo 설정, Gradle applicationId/namespace, Kotlin 선언·디렉터리와 ADB 검사 도구를 일치시킨다. Manifest의 `.MainApplication`/`.MainActivity`는 namespace를 기준으로 해석하므로 유지한다.
- 표시 이름 `트레이딩 클래스`, iOS `com.leagueoftrading`, Expo `@mycroft7947/leagueoftrading` 및 projectId `ea6190e3-80cd-43df-a7b1-d2b780f05985`, 아이콘, AdMob ID, `leagueoftrading://` 스킴은 유지한다. 과거 APK 검증 기록의 이전 패키지는 당시 결과이므로 수정하지 않는다.

## 외부 설정 확인 결과 및 후속 작업

- EAS 읽기 전용 조회: 기존 패키지에는 keystore 연결이 있으나 새 패키지의 자격 증명은 아직 없다. `cd frontend && eas credentials -p android`에서 production 프로필을 선택하고 새 application identifier의 업로드 키 연결을 준비한다. 기존 키 재사용 여부를 결정하고 백업한다. 이번 작업에서는 키 생성·이전·다운로드를 하지 않는다. EAS 원격 서명 경로를 사용하며, 로컬 Gradle release는 기존 debug signing 설정이므로 그대로 실행해 출시하지 않는다.
- 알림: EAS FCM V1 자격 증명, `google-services.json`, Google Services Gradle 플러그인이 현재 없다. Firebase에 **새 패키지의 Android 앱**을 등록하고 설정 파일·플러그인 및 해당 Firebase 프로젝트의 EAS FCM V1 키를 연결해야 한다. iOS APNs 설정은 별도다. 기존 [알림 QA](push-notifications-qa.md)의 2026-10-17 패키지 기준은 과거 기록이며 이후 Android 설정은 새 패키지를 사용한다.
- 딥링크: 커스텀 스킴 유지, Android App Links/패키지 고정 OAuth 클라이언트 설정은 저장소에서 발견되지 않았다. 구버전과 신버전을 함께 설치하면 동일 스킴의 처리 앱 선택이 발생할 수 있어 기기 확인이 필요하다.
- AdMob: Android 앱 ID와 광고 단위 ID는 유지한다. 콘솔의 앱 스토어 정보가 새 패키지를 가리키는지 확인하고 출시 후 스토어 연결을 완료한다. 현재 테스트 광고 및 production 광고 비활성화 정책은 유지한다. AdMob 콘솔은 이번 작업에서 변경하지 않았다.
- 새 패키지는 Android에서 별도 앱으로 설치된다. 구버전 앱과 그 데이터는 삭제하지 않는다. 서버 계정·금융 데이터는 변경하지 않으며 로그인으로 기존 계정을 사용한다. 기기 로컬 로그인·환경설정은 새 앱으로 자동 승계되지 않는다.

## 검증 범위

Expo public 설정, Android native/package 경로 일치 테스트, 관련 광고·ADB 검사 테스트, 타입 검사로 확인한다. 이 환경에는 Java/Android SDK가 없어 Android 네이티브 컴파일·설치 검증은 수행하지 못했다. 후속 승인된 preview APK에서 시작·로그인·알림·딥링크·테스트 광고와 서명 결과를 확인한다. AAB 빌드·Play 업로드·Render 배포·운영 DB 변경은 수행하지 않는다.

근거: [Expo 서명 관리](https://docs.expo.dev/app-signing/managed-credentials/), [Firebase Android 앱 등록](https://firebase.google.com/docs/android/setup), [AdMob 앱 등록·스토어 연결](https://support.google.com/admob/answer/9989980?hl=en).
