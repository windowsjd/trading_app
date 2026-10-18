# Trading Class 이메일 인증·비밀번호 재설정 QA

기준일: 2026-10-18. API는 `/api/v1`이다. 실제 Resend 발송·Render DB 변경·배포는 수행하지 않았다.
구현/자동 검증 상세와 전체 파일 목록: [작업 보고서](../../docs/investigations/2026-10-18-auth-email/report.md).
서버 계약: [Auth API](../../backend/docs/auth-api-contract.md).

## 자동 검증

| 영역 | 검증 내용 | 결과 |
| --- | --- | --- |
| 공통 발송 | 목적별 제목·HTML/text·발신자·timeout·idempotency, 장애 시 안전한 오류, 로그 비노출 | PASS, mocked fetch |
| 설정 | 전체 미설정 시 비활성, 부분 설정/짧은 비밀값/잘못된 발신자 거부, 프록시 hop 범위 | PASS |
| 인증 코드 | DB 시간 만료, 5회 오입력 영속화, 재발송 시 코드/증거 무효화, 목적/이메일 혼용 거부 | PASS, PostgreSQL |
| 남용 제한 | 60초·동일 이메일 양 목적 합계 5회/시간, IP 발송/검증/완료 제한과 만료 후 복구 | PASS, PostgreSQL |
| 동시성 | 두 서비스 인스턴스 동시 발송/검증, 같은 증거 동시 가입/재설정 시 성공 1회 | PASS, PostgreSQL |
| 가입 | 인증 전 User/Session/투자계정/참가 없음, 인증 후 기존 토큰 응답, 중복 이메일/닉네임 충돌, 구버전 무인증 가입 거부 | PASS |
| 기존 회원 | 미인증 기존 계정 로그인·재설정, 이전 `tv` 없는 JWT의 배포 호환성 | PASS |
| 재설정 | 다른 목적/이메일/만료/재사용 증거 거부, 기존 비밀번호 실패·새 비밀번호 로그인, 자동 로그인 없음 | PASS |
| 세션 | 이전 Access/Refresh·새 WebSocket 인증 거부, 새 로그인·Rotation 성공, 요청만으로 세션 종료 안 함, 재설정과 로그인 경합 방어 | PASS |
| DB 실패 | 비밀번호 저장 후 Refresh 폐기 실패를 주입 → 비밀번호·증거·세션 모두 롤백 | PASS, PostgreSQL |
| 상태/금융 | suspended/deleted 발송 안 함, 인증 후 정지/삭제도 최종 거부, role/status/닉네임/공개 설정/투자계정·지갑 보존 | PASS |
| 앱 상태 | 6자리 입력만으로 진행 안 함, 서버 오류 시 완료 표시 안 함, 확인 비밀번호 불일치 요청 안 함 | PASS |
| 앱 비동기 | 버튼 연타 1회, 요청 중 입력 제어, 실패 후 재시도, 이메일 왕복 변경의 늦은 응답 폐기, 재발송 시 증거 폐기 | PASS |
| 앱 진입 | 기존 세션 설치·계정 분리·모드 선택 회귀, 재설정 완료 후 명시적으로 로그인 이동 | PASS |

## 레이아웃 검증 범위

Chromium에서 Expo Web 실제 빌드와 한글 NanumBarunGothic을 사용했다. 외부 API는 전부 차단/모의 처리했다.

- 폭: 320 / 375 / 430px, 높이 812px.
- 테마: 앱 저장 설정 Light / Dark.
- 글자 크기: 1배 / 2배 CSS 확대. **OS FontScale의 실기기 검증을 대체하지 않는다.**
- 화면: 로그인, 재설정 이메일, 코드+긴 오류+타이머, 새 비밀번호/확인+불일치 오류, 완료, 가입 입력, 가입 코드.
- 3 × 2 × 2 × 7 = 84 사례에서 폼 밖 가로 넘침·텍스트 높이 잘림 감지 0건. 긴 폼은 기존 ScrollView로 스크롤한다.
- 결과: [레이아웃 측정](../../docs/investigations/2026-10-18-auth-email/evidence/layout-results.json).
- 예시: [320px Dark·2배 새 비밀번호](../../docs/investigations/2026-10-18-auth-email/evidence/dark-password-error.png),
  [320px Light·2배 인증번호](../../docs/investigations/2026-10-18-auth-email/evidence/light-code-error.png).

## 실기기 및 실제 메일 검증 — NOT_RUN

Android/iOS 기기와 승인받은 수신 주소가 없어 아래 항목은 NOT_RUN이다.

1. 320/375/430px에 준하는 기기에서 Light/Dark, OS FontScale 1/2로 모든 단계 확인.
2. Android 숫자 키패드·이메일/비밀번호 키보드 및 iOS 키보드에서 입력·확인·재발송·스크롤·뒤로가기 확인.
3. 긴 오류/큰 글씨/작은 화면에서 하단 버튼까지 접근하고 입력값·타이머가 겹치지 않는지 확인.
4. 백그라운드 복귀 후 만료·재발송 제한, 앱 종료 후 새 인증 필요, 뒤로가기 중 늦은 응답 확인.
5. 승인된 이메일 한 주소로 회원가입/재설정 실메일 수신, 제목·발신자·HTML/text·스팸함·코드 만료 확인.
6. 두 기기로 로그인 → 한 기기에서 재설정 → 두 기기의 이전 보호 API/Refresh 거부 및 새 비밀번호 재로그인 확인.
7. 서버 연결 실패·요청 시간 초과·메일 제공자 장애에서 완료 오표시가 없고 재시도 안내가 가능한지 확인.

단위 테스트의 키보드 이벤트/측정 모의 검증은 Android/iOS에서 기존 스크롤 동작을 보존하지만, 실제 키보드 검증은 위와 같이 NOT_RUN이다.

## 릴리스 순서

1. Resend에서 `nanghwa.com` 발신 도메인 검증과 발송 권한/한도 확인. 승인된 수신 주소 확보.
2. 운영 변경 승인 후 migration `20261018120000_auth_email_verification` 적용. 기존 이메일 인증 시각은 null, 토큰 버전은 0이다.
3. backend에만 `RESEND_API_KEY`, `EMAIL_FROM="Trading Class <admin@nanghwa.com>"`, 32자 이상 랜덤 `EMAIL_VERIFICATION_SECRET` 설정. 모든 서버에서 같은 값을 사용한다.
4. 실제 ingress를 확인한 뒤 `AUTH_TRUST_PROXY_HOPS` 설정. 기본 0이면 프록시 뒤 모든 요청이 같은 IP 제한에 묶일 수 있다.
5. 전환 중 이전 서버로 무인증 가입이 통과하지 않게 가입 ingress를 잠시 제한하거나 서버를 일괄 교체한다. 모든 인스턴스에 증거 검증·토큰 버전 Guard가 있는지 먼저 확인한다.
6. 새 API 제공 후 Expo 업데이트 채널/runtimeVersion 정책에 맞춰 앱 배포. 새 네이티브 라이브러리는 추가하지 않았다. EAS 빌드/업데이트 실행은 별도 승인 대상이다.
7. 구버전 앱의 기존 로그인/Refresh는 유지된다. 구버전 회원가입은 인증 증거가 없어 실패하므로 업데이트 안내/최소 지원 버전 정책을 릴리스 전에 준비한다. 우회 API는 두지 않는다.
8. 실제 메일 및 위 기기 QA 후 가입 제한을 해제한다. 롤백 시에도 인증 증거 검사와 버전 Guard를 제거하지 않는다.

만료된 인증 행의 정리는 서버 계약에 있는 보존 규칙으로 운영 유지보수에 연결한다. 이 작업은 별도 큐·워커·크론을 추가하지 않는다.
