# Trading Class 이메일 인증 UI·운영 보완

작업일: 2026-10-19 KST. 코드 변경만 완료하며 Push·배포·Render 설정 변경·운영 DB 삭제·실제 Resend 발송은 하지 않았다.

## 1. 기준 및 조사

- 요청 검토 SHA: `ddeb5576887acd6fddf8caa1654026d3b71425ef`.
- 시작 시 fetch 후 HEAD = origin/main = `7ffeed0b90b47bf3f2f67face119e248acd948ca`, Working Tree clean.
- 이후 변경 중 회원탈퇴 목적 `account_deletion`, 증거의 계정/버전 바인딩, 프로필 이미지 정리 타이머를 우선 조사하고 보존했다.
- 기존 React Hook·공통 Panel·Nest Logger·PrismaService·PostgreSQL을 재사용한다. 새 의존성·테이블·migration·API·별도 worker service·큐·외부 cron은 없다.

## 2. 실제 원인과 이메일 단계

가설과 실제 코드가 일치했다. Signup/PasswordReset은 기본 제출 버튼을 항상 렌더링하고 토큰 유무로만 문구를 선택했다. 인증 대기 중에는 버튼을 disabled로 바꾸었지만 `인증번호 발송` 문구가 남았다. Panel은 인증 성공 후에도 challenge가 남아 있어 재발송을 표시했다. 또한 기존 request()는 재발송 직전에 state 전체를 null로 만들어, 실패/응답 유실 후 최초 단계로 되돌아갔다.

`hasRequested`를 이메일/목적 key에 연결하고 challenge/proof 유무와 분리했다.

| 상태 | 동작 |
| --- | --- |
| 최초 발송 전 | 최초 발송 버튼만 표시. 실패는 같은 버튼에서 재시도 가능 |
| 발송 요청 중 | 연타 fence·비활성·대기 표시. 기존 문구의 높이를 보존해 loader/대기 문구로 바뀌어도 버튼 높이가 변하지 않음 |
| 일반화 발송 응답 성공 | 최초 버튼 제거. 코드 입력·확인·재발송·유효시간/대기시간 표시. 실제 수신을 확정하는 문구를 추가하지 않음 |
| 번호 오류 | 오류 표시, 서버 허용 범위에서 재입력. 최초 버튼 재등장 없음 |
| 만료/서버 횟수 초과 | 확인 비활성, 재발송 안내. 기존 6자리·10분·5회 정책 유지 |
| 재발송 시도 | 이전 proof 즉시 폐기, 이전 코드 확인 차단. 결과 불명/실패에도 재발송 단계 유지. 보수적인 60초 로컬 대기 후 재시도, 서버 예산이 최종 권위 |
| 인증 성공 | 코드·확인·재발송 숨김. 가입은 회원가입, 재설정은 새 비밀번호/확인과 비밀번호 변경 표시 |
| 증거 만료/서버 거부 | 최종 동작 차단·재인증 안내·재발송 표시. 이전 증거 재사용 없음 |
| 이메일 변경 | 새 최초 단계. 변경 전 발송/검증의 늦은 응답은 generation 비교로 폐기. 같은 이메일로 왕복해도 폐기 |
| 비밀번호 변경 성공 | `{ changed: true }` 확인 후에만 완료 안내. 로그인 토큰을 받거나 자동 로그인하지 않음 |

코드 확인/재발송 액션을 기존 측정용 AuthSubmitBox에 연결해 키보드 위로 함께 스크롤한다. 새 상태 관리 라이브러리는 없다.

## 3. 로그인 버튼

로그인 주 버튼의 코드·그라데이션·높이·동작을 보존했다. 그 아래를 `flexDirection: row`, 간격 12, 각 `flex: 1`과 stretch로 배치한다. 왼쪽 회원가입, 오른쪽 **비밀번호 찾기**다. 고정 높이·줄 수 제한·글꼴 배율 제한은 없다. 기존 외곽선·색상·모서리를 사용한다.

기존 navigation.navigate, 뒤로가기 및 trim한 이메일 초기값 전달을 유지했다. 진행 중 로그인·비밀번호 찾기는 비활성이고, 회원가입 진입은 기존처럼 가능하다. 기존 세션·앱 진입 정책은 변경하지 않았다.

## 4. IP 제한·프록시

사용자가 확인한 `league of trading` 워크스페이스에서 Render MCP를 읽기 전용으로 조회했다. GitHub `windowsjd/trading_app`, backend root, 공개 Node web service, Singapore, main commit 자동 배포, onrender 주소 활성, 단일 인스턴스임을 확인했다. 인증 관련 운영 환경변수 값·원본 사용자 IP·인증 계정 이메일·운영 요청 로그는 조회하거나 기록하지 않았다.

앱은 `AUTH_TRUST_PROXY_HOPS`(미설정 기본 0)를 Express trust proxy에 설정하고 controller가 `request.ip`만 metadata로 전달한다. 별도 Forwarded/CF/X-Real-IP 직접 파싱은 없다. 유효 IP 또는 unknown을 서버 secret으로 HMAC 처리한 IP 예산 및 기존 이메일 예산을 유지한다.

- 로컬 Express HTTP 테스트: 기본 0은 X-Forwarded-For, Forwarded, X-Real-IP, CF-Connecting-IP 위조를 모두 무시한다.
- 검증된 한 hop **테스트 환경**은 서로 다른 클라이언트를 분리하고, XFF의 공격자 prefix를 무시한다. 테스트용 1은 Render 권장값이 아니다.
- PostgreSQL 테스트는 인스턴스 간 IP 예산 공유·초과 거부·만료 후 복구를 확인한다.
- 실제 ingress의 정확한 hop 수/신뢰 suffix 덮어쓰기/직접 접근 경로는 MCP service metadata로 확정할 수 없다. 현재 운영값도 확인하지 않았다. 따라서 운영 IP별 분리·위조 방어의 종단 검증은 **NOT_RUN**이다.
- 기본 0이면 Render proxy socket IP별로 예산이 묶일 위험이 있다. 양의 hop 수가 실제 경로보다 크거나 짧은 우회 경로가 있으면 위조 위험이 있다. 실제 정책을 추측해서 코드/설정을 바꾸지 않았다. 같은 NAT를 공유하는 클라이언트가 IP 예산을 공유하는 기존 정책도 유지한다.

Express는 hop 수를 socket에서 XFF 오른쪽 방향으로 적용하며, 길이가 다른 접근 경로가 있으면 위조 위험이 있음을 명시한다. [Express 공식 문서](https://expressjs.com/en/guide/behind-proxies/). Render web service의 공개/사설 접근 가능성은 [Render 공식 문서](https://render.com/docs/web-services)를 대조했다.

### 운영 확인 절차와 설정 기준

1. Dashboard/운영 네트워크에서 custom domain·onrender·CDN·사설 호출을 포함한 실제 ingress와 직접 접근 가능성을 확인한다.
2. 승인된 두 독립 네트워크에서 정상/위조 XFF·Forwarded·X-Real-IP 요청을 비교한다. 이메일 발송 대신 격리된 점검 경로/진단을 사용한다. 실제 주소/헤더는 메모리 안에서만 다루고 비교 결과·hop 수·위조 불변 여부만 보고한다. 원본 IP나 환경변수 값은 로그에 남기지 않는다.
3. 신뢰 suffix를 상위 proxy가 덮어쓰거나 안전하게 생성하고 모든 허용 경로의 길이가 일치함을 확인한 후에만 정확한 hop 수를 선택한다. 불명확하면 기본 보수 설정을 유지한다. 짧은 우회 경로가 있으면 숫자만 올려 해결하지 않는다.
4. 해당 설정 후 두 네트워크 예산 분리, 위조 prefix 변경에도 동일 예산 사용, 초과 거부를 승인된 제한적 검증으로 확인한다. 이번 작업은 설정/배포를 수행하지 않았다.

## 5. 이메일 장애 진단

기존 Nest Logger/AdminDiagnosticLogger 경로에 고정 JSON만 전달한다.

| 이벤트 | outcome | 의미 |
| --- | --- | --- |
| auth_email_delivery | accepted | 실제 Resend HTTP 요청이 2xx로 접수됨. 수신함 도착을 의미하지 않음 |
| auth_email_delivery | rejected | 실제 요청의 HTTP 거부. 응답 본문은 읽지 않음 |
| auth_email_delivery | timeout | 4초 AbortSignal 만료 |
| auth_email_delivery | network_error | timeout 이외 fetch 실패 |
| auth_email_configuration | disabled / invalid | 이메일 설정 비활성/오류. startup의 기존 설정 검증도 유지 |

자격 없는 계정은 mail.send를 호출하지 않으므로 accepted 이벤트가 생기지 않는다. 비밀번호·이메일·코드·증거·API Key·Authorization·provider 본문/예외 메시지·IP·challenge ID를 이벤트에 넣지 않는다. 본문은 취소하고 취소 실패도 전달 결과를 뒤집지 않는다. logger가 throw해도 인증/정리 결과에 영향을 주지 않는다. 외부 HTTP 상태·일반화 응답·계정 존재 보호 정책은 그대로다. 실제 Resend 시간/수신 성공률은 실메일 미발송으로 NOT_RUN이다.

## 6. 만료 정리

기존 ProfileImageCleanupWorker의 23초 시작 지연/1분 타이머에서 EmailAuthCleanupService.runIfDue를 호출한다. 프로필 저장소 설정 여부와 무관하며, 프로필 정리의 기존 Ops lease/run 경로는 보존한다.

- 인스턴스당 성공한 시도 후 1시간 간격, 1회에 challenge 500행 + bucket 500행까지.
- DB UTC 시각 기준 code expiry와 존재하는 proof expiry **모두** 24시간 초과 경과한 challenge만 정리한다. consumed 행도 이 보수 조건을 만족해야 한다.
- bucket은 expiry가 24시간 초과 경과한 것만 정리한다. 현재 이메일 발송 시간창과 유효 IP 예산을 삭제하지 않는다.
- 트랜잭션 advisory try-lock, FOR UPDATE SKIP LOCKED, 삭제 시 만료 조건 재검사. 갱신 중인 bucket은 건너뛴다.
- lock_timeout 100ms, statement_timeout 2초, Prisma maxWait 500ms/transaction timeout 5초. 실패 시 전체 롤백, 다음 분 재시도. 인증 요청 경로와 독립이다.
- 고정 completed 이벤트/삭제 건수 또는 failed 이벤트만 기록한다. 사용자·세션·금융 테이블에 접근하는 정리 SQL은 없다.
- 설정·migration·외부 cron 추가 없이 다음 승인된 코드 배포 후 동작한다. 큰 기존 backlog는 여러 시간에 나누어 정리된다. 운영 DB에서는 실행하지 않았다.

## 7. 응답 지연·대기 UX

기존 Resend 4초 timeout, 서버 최소 5–5.2초 padding, 공통 HTTP 10초 timeout을 그대로 두었다. 전자는 후자보다 짧으며 직접적인 설정 충돌은 없다. DB/네트워크 지연이 추가되면 10초를 넘길 수 있으므로 서버의 실제 완료 여부는 응답 유실 시 확정하지 않는다. 자동 재시도를 추가하지 않았다. Hook의 동기 fence로 연타를 막고, loader/대기 문구를 보여 주되 원래 텍스트의 줄바꿈 높이를 유지한다. timeout은 기존 안전한 오류 매퍼와 최초 재시도/재발송 경로로 복구한다.

## 8. 검증

모든 DB 검증은 `/tmp`의 새 PostgreSQL 16, loopback:56484, 이름이 `_test`인 DB에서만 실행했다. 실제 Resend와 저장소는 mock이다.

| 검증 | 결과 |
| --- | --- |
| Frontend npm run typecheck / lint:accounts:check / export:web | PASS |
| Frontend 인증 화면/feature 관련 node --test | 10개 파일 PASS |
| Frontend 전체 npm test | **246개 파일 전부 PASS**. 162 + 44 + 40개로 제한 시간 내 분할 완료 |
| Backend typecheck / build / 변경 src의 ESLint --no-fix --max-warnings=0 | PASS |
| Backend 관련 6 unit suites | 84 tests PASS |
| 기존 auth-email-integration.ts + 정리 검증 | 68 grouped checks PASS |
| 기존 account-deletion-integration.ts | 26 checks PASS, 최종 완료 문자열 확인 |
| RN Web 레이아웃 | 228 사례 PASS, overflow/clipping/pageerror 0 |
| Android/iOS 실제 기기·OS FontScale·IME·실메일 | NOT_RUN |
| Render ingress IP 종단 검증 | NOT_RUN, 운영 확인 절차 위 참조 |
| git diff --check / 자체 리뷰 | PASS |

인증 DB 검증은 서버 시간대 KST에서도 통과했다. 기존 회원탈퇴의 금융 fixture는 UTC와 query parameter가 있는 DATABASE_URL을 전제로 해 새 `auth_deletion_test`에 그 조건을 맞추어 완료했다. 앱 금융 코드는 바꾸지 않았다. 초기에 소켓 사용이 sandbox에서 차단되어 로컬 HTTP/DB/Chromium 작업만 승인된 확장 실행으로 검증했다. 브라우저의 누락 공유 라이브러리는 기존 임시 도구를 재사용했다.

레이아웃은 320/375/430 × Light/Dark × 1/2배에서 로그인, 양 화면 최초/발송 중/코드·긴 오류/420px 모의 키보드/만료/재발송 중/응답 유실/인증 완료, 재설정 최종 요청 중/완료를 확인했다. 검출기 negative control도 통과했다. 320px·2배 로그인 보조 버튼은 둘 다 130×104px이며 같은 y, 양쪽 끝 정렬이다. 대기 전후 버튼 높이도 같았다. 실제 OS 글꼴/기기 키보드 검증을 대신한다고 주장하지 않는다.

[레이아웃 수치](evidence/layout-results.json), [Light 로그인](evidence/login-light-2x.png), [Dark 로그인](evidence/login-dark-2x.png), [Dark 코드](evidence/PasswordReset-code-dark-2x.png), [인증 DB](evidence/auth-db.log), [회원탈퇴 DB](evidence/account-deletion-db.log), [프런트 인증](evidence/frontend-auth-tests.log), [백엔드 단위](evidence/backend-unit.log).

재현은 frontend의 npm 명령과 `test/browser/authEmailBrowser.cjs`(기존 browser README의 외부 도구 지정)를 사용한다. backend 단위는 관련 6 spec을 Jest --runInBand로 실행한다. DB 스크립트는 명시적 loopback `_test` URL과 mock 발송을 사용하고, 회원탈퇴는 NODE_ENV=test/ACCOUNT_DELETION_DB_INTEGRATION=1/FUTURES_DB_INTEGRATION=1을 요구한다. 실제 환경변수 값을 기록하지 않는다.

## 9. 회귀·자체 리뷰·잔여 작업

서버의 signup/reset/consume/limit/세션 폐기 구현과 API 경로는 변경하지 않았다. 회원탈퇴용 메일 제목과 목적 분리도 보존했다. 기존 미인증 회원 로그인/재설정, 목적 혼용 방지, 5회 오입력/재발송 무효화, 동시 증거 1회 소비, password/session 롤백 및 tokenVersion 폐기는 인증 DB 검증으로 확인했다. 회원탈퇴 회귀는 거래·정산·Refresh·프로필 업로드 경합과 다른 회원/공유 금융 데이터 보존도 확인했다. 정리 전후 사용자·Refresh Session·지갑 개수를 비교하고, 활성/보존 유예/갱신/잠금/동시 실행/두 번째 DELETE 실패 롤백을 검증했다.

변경 테스트는 UI 인스턴스를 boolean/개수/작은 props로 비교한다. OOM 방지를 위해 검증을 삭제·skip하거나 실패를 성공으로 처리하지 않았다. 초기 전체 실행은 180초, 다음 실행은 300초 누적 제한으로 종료되었다. 각 종료 확인 후 시간 제한으로 취소되거나 아직 완료하지 못한 파일만 실제로 이어 실행했으며, 162 + 44 + 40 = 246개 전체 파일의 PASS를 [검증 요약](evidence/verification-summary.json)의 목록과 대조했다. 단일 npm test 실행이 성공했다고 보고하지 않는다. unrelated API/client/DTO/financial/schema/dependency 변경과 /api/v2 추가가 없음을 diff로 확인했다.

운영 수동 변경은 이번 패치 자체에는 필요 없다. 다음 승인된 배포 뒤 고정 발송/정리 진단을 확인한다. 프록시 설정은 위 ingress 실측 후 별도 적용해야 하며, 실메일·실기기 QA도 남아 있다. 운영 IP 식별의 종단 보장은 확인 전까지 미해결이다. 실제 Resend 왕복 지연과 메일 도착 시간도 측정하지 않았다.

## 10. 전체 변경 파일

- `HANDOVER.md`
- `backend/docs/auth-api-contract.md`
- `backend/scripts/account-deletion-integration.ts`
- `backend/scripts/auth-email-integration.ts`
- `backend/src/auth/auth-email.service.spec.ts`
- `backend/src/auth/auth-email.service.ts`
- `backend/src/auth/auth.module.ts`
- `backend/src/auth/email-auth-cleanup.service.ts`
- `backend/src/auth/email-verification.service.spec.ts`
- `backend/src/auth/profile-image-cleanup.worker.ts`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/PasswordReset-code-dark-2x.png`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/account-deletion-db.log`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/auth-db.log`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/backend-unit.log`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/frontend-auth-tests.log`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/layout-results.json`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/login-dark-2x.png`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/login-light-2x.png`
- `docs/investigations/2026-10-19-auth-email-ui-ops/evidence/verification-summary.json`
- `docs/investigations/2026-10-19-auth-email-ui-ops/report.md`
- `frontend/docs/auth-email-qa.md`
- `frontend/src/features/auth/useEmailVerification.ts`
- `frontend/src/screens/auth/AuthFormLayout.tsx`
- `frontend/src/screens/auth/EmailVerificationPanel.tsx`
- `frontend/src/screens/auth/LoginScreen.tsx`
- `frontend/src/screens/auth/PasswordResetScreen.tsx`
- `frontend/src/screens/auth/SignupScreen.tsx`
- `frontend/src/screens/auth/authKeyboardLayout.test.ts`
- `frontend/src/screens/auth/emailRecovery.test.ts`
- `frontend/src/screens/auth/loginBusy.test.ts`
- `frontend/test/browser/README.md`
- `frontend/test/browser/authEmailBrowser.cjs`
- `frontend/test/browser/authEmailFixture.jsx`
- `frontend/test/browser/authEmailMocks.js`
