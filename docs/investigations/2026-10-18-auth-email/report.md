# Trading Class Resend 이메일 인증·비밀번호 재설정 구현 보고서

기준일: 2026-10-18. 구현·로컬 자동 검증 완료. **운영 적용·실제 메일·실기기 검증은 수행하지 않았다.**

## 1. 시작 상태와 범위

- `git fetch origin main` 후 origin/main = 로컬 HEAD = `6f7459cff55dd9a63acb8af946b47c52870efb80`.
- 시작 시 main 작업 트리 clean. 기존 다른 worktree와 stash 2개를 변경하지 않았다.
- 열린 PR 읽기 확인: #8 `Allow stock conditional orders to be registered outside regular sessions`만 존재했다. 이메일 인증 관련 진행 PR은 없었다.
- NestJS/Prisma 7 adapter/PostgreSQL/기존 Expo React Native 인증 구조를 사용했다. 새 인증 플랫폼, 큐, Redis 의존성, 발송 워커, 금융 정책 변경은 없다.
- 루트/백엔드 AGENTS와 현행 Auth 계약·관련 테스트를 대조했다. 사용자가 명시적으로 요청한 Auth API·migration 범위로 계약을 먼저 갱신했다.

## 2. 회원가입 최종 흐름

1. 이메일·닉네임·비밀번호/확인을 입력한다. 기존 입력 정책을 유지한다.
2. 공통 발송 API에 `purpose=signup`으로 요청한다. 사용할 수 있는 이메일에만 Resend를 호출하며 User·Session·금융 데이터는 만들지 않는다.
3. 서버에서 6자리 코드를 검증한다. 성공 시 해당 이메일/목적의 제한된 `verificationToken`을 받는다.
4. 기존 `/auth/signup`에 증거와 입력값을 제출한다. 인증 증거 검증·소비, 이메일/닉네임 충돌 검사, User·Refresh Session 생성이 같은 트랜잭션에 있다.
5. 기존 user/tokens 응답과 세션 설치·모드 선택 흐름을 사용한다. 인증 전 투자 계정/지갑/시즌 참가도 만들지 않는다.

이메일 존재 여부를 무인증 중복 검사로 열거하지 못하도록 충돌 검사는 유효한 가입 증거 이후에만 수행한다. 기존 충돌 코드와 unique 제약은 유지한다.

## 3. 비밀번호 재설정 최종 흐름

로그인 아래 `비밀번호를 잊어버리셨나요?` → 이메일 입력 → `password_reset` 코드 → 서버 검증 → 새 비밀번호/확인 → 최종 변경 → 완료 문구 → 로그인으로 돌아가기.

이메일이 등록되어 있지 않거나 비활성 상태면 실제 메일을 보내지 않는다. 발송 외부 응답은 같은 코드·메시지·형식이며, 제한 예산도 동일하게 사용한다. 제공자 실패도 발송 요청에서는 같은 응답을 사용하되 해당 코드는 무효화한다. 제공자 timeout보다 긴 최소 응답 지연과 jitter를 적용한다.

최종 재설정은 대상 계정·이메일·active 상태·발급 시점 tokenVersion·목적·증거 수명·미사용 여부를 다시 확인한다. 기존과 같은 Argon2 해싱을 사용한다. 기존 비밀번호는 요구하지 않는다. 새 비밀번호 저장 성공만 완료로 표시하며, 토큰을 발급하거나 자동 로그인하지 않는다.

## 4. Resend와 환경변수

[Resend 공식 Send Email API](https://resend.com/docs/api-reference/emails/send-email)를 HTTPS fetch로 호출한다. 신규 SDK 의존성은 없다.

```env
RESEND_API_KEY=<서버용 실제 키>
EMAIL_FROM="Trading Class <admin@nanghwa.com>"
EMAIL_VERIFICATION_SECRET=<별도의 32자 이상 암호학적 랜덤 비밀값>
AUTH_TRUST_PROXY_HOPS=0
```

앞의 세 값은 함께 필요하며 모든 서버에서 같아야 한다. 모두 미설정이면 이메일 기능은 503으로 닫히고 기존 로그인은 유지된다. **이 경우에도 인증 없는 신규 가입은 허용하지 않는다.** 부분 설정/잘못된 값은 중앙 검증에서 시작을 거부한다. 실제 `.env`와 Expo 공개 환경변수는 변경하지 않았다.

- 제목: `Trading Class 이메일 인증번호` / `Trading Class 비밀번호 재설정 인증번호`.
- HTML/text에 코드·10분·본인 요청이 아니면 무시하라는 안내를 넣는다.
- 4초 timeout, redirect 거부, challenge별 idempotency key, 자동 재시도 없음.
- 제공자 오류 본문을 읽거나 로깅/전파하지 않는다. 키·코드·새 비밀번호를 feature log/분석 이벤트에 남기지 않는다.

## 5. 코드·증거·남용 방지

| 항목 | 구현 |
| --- | --- |
| 코드 | crypto.randomInt의 균등한 6자리 숫자(앞자리 0 포함) |
| 저장 | 서버 전용 비밀값으로 challenge ID+이메일+목적+코드를 HMAC-SHA256. 원문 저장 없음 |
| 코드 수명/오입력 | DB 서버 epoch 기준 10분 / 최대 5회. 실패 응답 전 시도 증가를 commit |
| 증거 | 32 random bytes, DB에는 SHA-256만 저장. 검증 후 10분, 이메일·목적·대상 사용자·발급 버전에 연결 |
| 재발송 | 최소 60초, 이전 같은 목적의 코드와 증거 모두 무효화 |
| 이메일 예산 | 두 목적 합계 rolling 5회/시간. 실패·미등록 요청도 예약 기록 |
| IP 예산 | 발송 30회/시간, 검증 100회/10분, 최종 완료 30회/10분 |
| 다중 서버 | 이메일 transaction advisory lock, IP atomic upsert, unique proof hash와 DB unique email/nickname |
| 완료 | 가입/재설정의 실제 DB 변경과 증거 소비가 동일 트랜잭션 |

브라우저 상태나 6자리 형식만으로 인증되지 않는다. 인증 증거는 JWT/로그인 토큰이 아니며 보호 API에서 사용할 수 없다. 원본 오류는 화면 상태에서 보존하되 public mapper로 안전한 문구만 표시한다.

## 6. 기존 사용자 호환성

기존 회원에게 인증을 강제하지 않으며 migration은 이메일 인증 시각을 채우지 않는다. 실제 신규 가입 인증 또는 성공한 비밀번호 재설정에 한해서 `emailVerifiedAt`을 기록한다. suspended/deleted에 메일을 보내지 않으며 인증 이후 상태가 바뀌어도 최종 재설정에서 다시 차단한다.

역할/계정 상태/닉네임/포트폴리오 공개 설정/기존 금융 데이터는 재설정으로 변경하지 않는다. 운영자·관리자 권한 판정은 계속 Guard의 현재 DB role/status를 사용한다.

## 7. Access/Refresh 무효화

재설정 트랜잭션에서 passwordHash 갱신, tokenVersion +1, 모든 active Refresh Session 폐기, 증거 소비를 함께 commit한다. Access JWT의 `tv`와 DB tokenVersion이 다르면 보호 API는 401이다. 구형 JWT의 누락 `tv`는 0이며 migration 기본값도 0이다.

로그인과 Refresh Rotation도 같은 사용자 행을 잠근다. 비밀번호 확인 중 재설정이 먼저 완료되면 이전 hash/version으로 새 세션을 만들지 못한다. 이미 발급된 응답이 재설정과 겹쳐도 그 응답은 이전 버전을 포함하므로 이후 Guard에서 거부된다. 시세 WebSocket도 별도의 JWT 인증 경계에서 현재 버전을 검사해 이전 토큰의 새 연결을 거부한다. 기존 시세 구독·전송 처리는 변경하지 않았다. 전체 JWT 블랙리스트는 없다. 기존 logout/logout-all의 별도 동작은 유지한다.

## 8. DB migration과 적용 조건

`backend/prisma/migrations/20261018120000_auth_email_verification/migration.sql`:

- User: nullable email_verified_at, NOT NULL token_version DEFAULT 0.
- email_auth_challenges: 두 목적의 코드·검증·소비 증거와 발송 예산의 단일 저장소.
- email_auth_rate_buckets: 계정 존재 여부와 무관한 공유 IP 예산. raw IP 대신 keyed digest를 key로 사용한다.
- 인증 데이터용 인덱스와 attempts 0..5 CHECK. 금융 테이블 변경/기존 계정 인증 시각 백필 없음.
- Prisma client를 재생성했고 prisma validate와 격리 DB의 모든 migration 적용을 확인했다.

운영 migration은 **NOT_RUN**. 적용 전 backup/릴리스 승인과 서버 전체 전환 계획이 필요하다. 만료 24시간이 지난 인증/예산 행의 bounded batch 정리를 기존 DB 유지보수에 연결한다. 신규 유지보수 워커는 만들지 않았다.

## 9. API·프론트엔드

모두 `/api/v1`의 기존 success/data 또는 success/error envelope를 사용한다.

| API | 주요 입력 | 결과 |
| --- | --- | --- |
| POST /auth/email/request | email, purpose | challengeId, expiresAt, resendAt, serverTime, 일반화된 메시지 |
| POST /auth/email/verify | email, purpose, challengeId, code | verificationToken, expiresAt, serverTime |
| POST /auth/signup | 기존 입력 + verificationToken | 기존 user/tokens, 201 |
| POST /auth/password/reset | email, password, verificationToken | changed:true, 200, 로그인 토큰 없음 |

최종 신규 가입은 증거가 필수다. 코드/증거 오류, 만료, 시도 초과, 429, 일시적인 이메일 비활성 오류는 기존 public mapper에 한국어 문구를 추가했다.

앱은 기존 AuthFormLayout/스크롤/테마/React Query/세션 설치를 재사용한다. 증거는 메모리에서만 유지하며 이메일 변경·재발송 시 폐기한다. 이메일을 바꿨다가 원래 주소로 돌아와도 이전 요청 응답을 받아들이지 않는다. 버튼 연타를 즉시 ref로 막으며 최종 요청 중 이메일을 수정할 수 없다.

## 10. 자동 테스트 결과

| 실행 | 결과 |
| --- | --- |
| backend pnpm test --runInBand | 346 suites / 5,618 tests PASS, 기존 opt-in 83 suites / 116 tests SKIP |
| backend pnpm run test:e2e | 2 suites / 411 tests PASS |
| AUTH_DB_SMOKE=1 기존 Auth + 새 이메일 PostgreSQL | 2 suites PASS |
| MVP_FLOW_DB_SMOKE=1 기존 MVP PostgreSQL | 1 suite PASS |
| 최종 Resend/설정/응답 지연 단위 테스트 | 2 suites / 7 tests PASS |
| frontend npm test | 243 파일 단위 항목 PASS, 실패/skip 0 |
| 최종 frontend Auth 관련 Node 테스트 | 9 파일 단위 항목 PASS |
| backend/frontend typecheck | PASS |
| frontend lint:accounts:check, 변경 Auth backend source lint | PASS, check-only, 경고 0 |
| backend build / frontend export:web / Prisma validate | PASS |
| backend/frontend diagnostic-enforcement | PASS |
| git diff --check | PASS |

Resend는 모의 처리했다. PostgreSQL은 127.0.0.1:56483의 격리된 auth_email_test(KST 서버 시간대), auth_mvp_test(UTC)만 사용했다. 운영 DB에는 접속하지 않았다.

초기 전체 backend 실행에서 로컬 소켓/tsx IPC/Git 자식 프로세스의 샌드박스 제한으로 실패했다. 실행 종료와 원인을 확인한 뒤 허용된 로컬 환경에서 시간/힙 한도를 두어 실패 스위트만 확인했고, 이후 전체 실행도 위와 같이 통과했다. 테스트 삭제/우회 skip/실패를 성공으로 처리한 변경은 없다.

Prisma의 void advisory lock 반환형은 명시적으로 text로 바꿨다. KST PostgreSQL adapter의 TIMESTAMPTZ 해석 차이는 Auth 만료 계산에서 DB epoch를 사용해 피했다. 다른 금융 시간 정책은 변경하지 않았다. DB 비밀번호 저장 후 Refresh 폐기 실패를 주입해 비밀번호·증거·세션의 전체 롤백도 확인했다.

상세 상태: [verification.json](evidence/verification.json). 수정 테스트는 boolean/작은 DTO를 단언하며 ReactTestInstance 직접 null 비교를 추가하지 않았다.

## 11. 레이아웃·실기기

폭 320/375/430px, Light/Dark, 글자 1배/2배, 7개 화면 상태의 **84개 브라우저 사례 PASS**. 긴 오류·인증 코드·타이머·새 비밀번호/확인·가입 입력을 포함하며 폼 가로 넘침/높이 잘림 감지 0건이다.

글자 2배는 실제 한글 글꼴을 적용한 Web CSS 시뮬레이션이다. Android/iOS OS FontScale·실제 키보드·실기기 결과는 **NOT_RUN**이다. 기존 native keyboard 측정 단위 테스트는 통과했다. [측정](evidence/layout-results.json), [QA](../../../frontend/docs/auth-email-qa.md).

## 12. 실제 이메일 발송

**NOT_RUN**. 승인된 수신 주소가 제공되지 않아 실제 Resend 호출을 하지 않았다. 실제 domain verification/DNS/SPF/DKIM·발송 한도·스팸함·도달률도 이번 작업에서 확인하지 않았다.

## 13. Render·EAS 배포 전 준비

도메인 검증/서버 비밀값/발신자 설정 → 운영 migration 승인 → 프록시 신뢰 hop 확인 → 모든 backend 교체 → 새 앱 전달 → 승인 주소의 실제 메일과 두 기기 세션 종료 검증이 필요하다. 자세한 순서는 QA 문서에 있다. 새 네이티브 의존성은 추가하지 않았으며 EAS runtime/channel 및 최소 앱 버전 정책은 기존 배포 정책에 맞춰야 한다.

## 14. 구버전 앱·안전한 전환

구버전의 기존 로그인/Rotation은 유지된다. 인증 증거가 없는 구버전 신규 가입은 실패하므로 앱 업데이트 안내가 필요하다. 혼합 서버 배포에서는 가입 ingress를 제한하거나 일괄 교체해 이전 서버의 무인증 가입을 차단해야 한다. 새 UI보다 새 서버가 먼저 준비되어야 한다. rollback도 증거 검증·tokenVersion Guard를 유지하며 과거 무인증 Auth로 되돌리지 않는다.

## 15. 남은 검증·회귀 위험

- 실메일/Android/iOS 실기기/OS FontScale 검증은 위와 같이 NOT_RUN이다.
- 프록시 hop이 0인 상태로 프록시 뒤에 배포하면 사용자들이 같은 IP 예산을 공유한다. 과도한 trust 설정은 IP 위조를 허용할 수 있으므로 실제 ingress 기준으로 설정한다.
- 가입/재설정에는 의도적인 약 5초 발송 요청 대기와 DB 잠금/쓰기 부하가 추가된다. 사용자 행 잠금은 짧은 인증 트랜잭션에만 사용하며 메일/Argon2를 잠금 안에서 실행하지 않는다.
- 이메일 미수신/불확실한 네트워크 결과는 새 인증이 필요할 수 있다. 증거는 디바이스에 영속 저장하지 않는다.
- 인증 행 retention을 기존 운영 유지보수에 연결해야 한다. 미설정이면 저장량과 이메일 보존 기간이 늘어난다.
- 기존 시세 전용 WebSocket 연결을 강제로 끊지는 않는다. 이전 토큰의 새 WebSocket 인증·보호 HTTP API·Refresh는 차단된다.
- 배포·운영 변경·커밋·push·PR 생성은 수행하지 않았다. 현재 변경은 로컬 작업 트리에 있다.

## 전체 변경 파일

아래 목록은 최종 작업 트리의 tracked diff와 신규 파일을 합친 것이다. generated/prisma 항목은 Prisma 생성 결과다.

총 64개 파일.

- `.github/workflows/ci.yml`
- `HANDOVER.md`
- `backend/.env.example`
- `backend/docs/auth-api-contract.md`
- `backend/prisma/migrations/20261018120000_auth_email_verification/migration.sql`
- `backend/prisma/schema.prisma`
- `backend/scripts/auth-email-integration.ts`
- `backend/scripts/friends-integration.ts`
- `backend/scripts/lib/auth-email-fixture.ts`
- `backend/src/auth/access-token.guard.spec.ts`
- `backend/src/auth/access-token.guard.ts`
- `backend/src/auth/auth-email.service.spec.ts`
- `backend/src/auth/auth-email.service.ts`
- `backend/src/auth/auth.controller.ts`
- `backend/src/auth/auth.integration.spec.ts`
- `backend/src/auth/auth.module.ts`
- `backend/src/auth/auth.service.spec.ts`
- `backend/src/auth/auth.service.ts`
- `backend/src/auth/auth.types.ts`
- `backend/src/auth/email-auth.config.ts`
- `backend/src/auth/email-verification.integration.spec.ts`
- `backend/src/auth/email-verification.service.spec.ts`
- `backend/src/auth/email-verification.service.ts`
- `backend/src/common/env-validation.ts`
- `backend/src/common/public-error-message.ts`
- `backend/src/generated/prisma/browser.ts`
- `backend/src/generated/prisma/client.ts`
- `backend/src/generated/prisma/commonInputTypes.ts`
- `backend/src/generated/prisma/enums.ts`
- `backend/src/generated/prisma/internal/class.ts`
- `backend/src/generated/prisma/internal/prismaNamespace.ts`
- `backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts`
- `backend/src/generated/prisma/models.ts`
- `backend/src/generated/prisma/models/EmailAuthChallenge.ts`
- `backend/src/generated/prisma/models/EmailAuthRateBucket.ts`
- `backend/src/generated/prisma/models/RefreshTokenSession.ts`
- `backend/src/generated/prisma/models/SeasonParticipant.ts`
- `backend/src/generated/prisma/models/User.ts`
- `backend/src/main.ts`
- `backend/src/mvp-flow.integration.spec.ts`
- `backend/src/realtime/asset-ticker.gateway.spec.ts`
- `backend/src/realtime/asset-ticker.gateway.ts`
- `backend/test/app.e2e-spec.ts`
- `backend/test/profile-image.e2e-spec.ts`
- `docs/investigations/2026-10-18-auth-email/evidence/dark-password-error.png`
- `docs/investigations/2026-10-18-auth-email/evidence/layout-results.json`
- `docs/investigations/2026-10-18-auth-email/evidence/light-code-error.png`
- `docs/investigations/2026-10-18-auth-email/evidence/verification.json`
- `docs/investigations/2026-10-18-auth-email/report.md`
- `frontend/docs/auth-email-qa.md`
- `frontend/src/app/navigation/AuthStack.tsx`
- `frontend/src/app/navigation/types.ts`
- `frontend/src/features/auth/api.ts`
- `frontend/src/features/auth/useEmailVerification.ts`
- `frontend/src/models/enums/errorCode.ts`
- `frontend/src/screens/auth/EmailVerificationPanel.tsx`
- `frontend/src/screens/auth/LoginScreen.tsx`
- `frontend/src/screens/auth/PasswordResetScreen.tsx`
- `frontend/src/screens/auth/SignupScreen.tsx`
- `frontend/src/screens/auth/authKeyboardLayout.test.ts`
- `frontend/src/screens/auth/emailRecovery.test.ts`
- `frontend/src/screens/auth/loginBusy.test.ts`
- `frontend/src/screens/auth/publicAuthErrors.test.ts`
- `frontend/src/services/api/errorMapper.ts`
