# 회원탈퇴(계정 삭제) 계약

2026-10-18. 앱의 MY → 설정 → 회원탈퇴와 회사 웹사이트(`nanghwa.com`) 계정 삭제 요청이 함께 쓰는 서버 계약이다. 여기서 "계정"은 Trading Class 회원(`users`)이며 `TradingAccount`(가상 투자계정)가 아니다. 모든 경로는 `/api/v1` 아래다(`/api/v2` 없음).

## 1. 원칙

- **확정 = 삭제.** 서버는 탈퇴를 "상태 변경 후 나중에 삭제"로 나누지 않는다. 본인 확인 증거를 검사한 **한 DB 트랜잭션**이 회원 행과 개인·가상 투자 데이터를 모두 지우고 영수증(`account_deletions`)을 쓴다. 모두 commit되거나, 하나도 바뀌지 않는다(실패·서버 재시작·연결 종료 시 rollback).
- `UserStatus.deleted`는 쓰지 않는다. 그것은 운영자의 제재성 상태(복구 가능)이며, 자기 탈퇴는 `users` 행 자체가 없어진다. 운영자 복구(`POST /operator/users/:id/restore`)는 지워진 회원에 대해 `404 TARGET_USER_NOT_FOUND`다.
- commit 뒤 남는 일은 관리형 프로필 사진 객체(S3 호환 저장소) 삭제뿐이다. 즉시 시도하고 실패하면 `profile_image_cleanups`에 남아 워커가 재시도한다. 영수증은 그 객체까지 지워져야 `completed`가 된다.
- 삭제 결과의 Source of Truth는 서버 영수증이다. 앱·웹은 응답이 유실되면 요청 키로 상태를 조회하며, 요청 성공 여부나 로컬 상태로 완료를 판단하지 않는다.
- 허위 체결·청산·손익을 만들지 않는다. 미체결 주문·예약·조건주문·선물 포지션은 체결/청산 없이 행째 삭제된다. 다른 회원의 지갑·원장·주문·포지션은 바뀌지 않는다. 외래 키·Cascade는 바꾸지 않았다(모든 금융 FK는 그대로 RESTRICT; 명시적 순서로 삭제).

## 2. API

| 경로 | 인증 | 요청 | 성공 `data` |
| --- | --- | --- | --- |
| `POST /me/account-deletion/password-check` | Bearer | `{ password }` | `{ verified: true }` — 아무것도 쓰지 않는다(IP 예산 제외) |
| `POST /me/account-deletion` | Bearer | `{ password, requestKey, confirm: true }` | `{ deletion }` |
| `POST /auth/account-deletion` | 공개 | `{ email, verificationToken, requestKey, confirm: true }` | `{ deletion }` |
| `POST /auth/account-deletion/status` | 공개 | `{ requestKey }` | `{ deletion }` |

- `deletion` = `{ status: "cleanup_pending" | "completed", deletedAt, completedAt | null }` (ISO-8601, DB 시각).
  - `cleanup_pending`: 회원·개인정보·가상 투자 데이터는 이미 삭제됨, 로그인 불가. 프로필 사진 객체 삭제만 남음.
  - `completed`: 이 회원의 데이터와 관리형 프로필 사진 객체 삭제가 모두 끝남. 정산 완료 시즌의 익명 최종 결과(§5.1)와 백업·운영 기록(§9)은 이 판정 밖이다.
- 모든 POST는 200(성공)이며 기존 `success/data`, `success:false/error{code,message}` envelope를 쓴다.
- `requestKey`: 클라이언트가 확인 시도마다 만드는 임의 문자열 `^[A-Za-z0-9_-]{32,128}$`(앱: 플랫폼 UUID 두 개). 서버는 SHA-256만 저장한다. 같은 키로 다시 보낸 요청은 저장된 영수증을 돌려준다(재시도·응답 유실 대비). 다른 사람의 키를 추측할 수 없고, 상태 조회는 영수증 외 정보를 주지 않는다.
- 앱 경로는 `request.user.userId`만 신뢰한다(본문의 `userId`는 무시). 비밀번호 불일치는 400이다(401이 아니므로 세션을 끝내지 않는다).
- IP 예산(기존 email auth 버킷 재사용): 비밀번호 확인·삭제(앱·웹)는 `complete` 30회/10분, 상태 조회는 `status` 100회/10분.

### 오류

| HTTP | code | 의미 |
| --- | --- | --- |
| 400 | `ACCOUNT_DELETION_PASSWORD_MISMATCH` | 비밀번호 불일치(또는 확인 뒤 비밀번호가 바뀜) |
| 400 | `ACCOUNT_DELETION_CONFIRMATION_REQUIRED` | `confirm !== true` |
| 400 | `ACCOUNT_DELETION_REQUEST_KEY_INVALID` | 요청 키 형식 오류 |
| 400 | `EMAIL_VERIFICATION_REQUIRED` | 웹: 증거 없음/만료/사용됨/다른 목적·이메일/발급 뒤 비밀번호 변경 |
| 400 | `INVALID_EMAIL` | 웹: 이메일 형식 |
| 401 | `UNAUTHORIZED` | 앱: 토큰 없음, 또는 이미 지워진 회원 |
| 403 | `USER_NOT_ACTIVE` | 정지·운영자 삭제 상태 회원 |
| 404 | `ACCOUNT_DELETION_NOT_FOUND` | 상태 조회: 이 키의 영수증 없음(삭제되지 않음) |
| 409 | `ACCOUNT_DELETION_ROLE_RESTRICTED` | operator/admin 역할 |
| 409 | `ACCOUNT_DELETION_REQUIRES_SUPPORT` | 운영 기록의 행위자였던 회원(§3) 또는 익명 placeholder |
| 429 | `EMAIL_RATE_LIMITED` | IP 예산 초과 |
| 503 | `ACCOUNT_DELETION_FAILED` | 트랜잭션 실패·재시도 소진. **아무것도 바뀌지 않았다**(rollback) |
| 503 | `EMAIL_UNAVAILABLE` | 웹: 이메일 설정 없음 |

## 3. 자격과 운영자·관리자

- `status = active`인 `role = user`만 스스로 탈퇴한다. 정지·운영자 삭제 상태는 고객센터 경로다(제재 회피·조사 대상 보존 판단은 운영 정책).
- operator/admin은 `ACCOUNT_DELETION_ROLE_RESTRICTED`. 관리자가 역할을 해제해도, 운영 행위의 행위자로 남은 회원(감사 로그 actor, 문의 답변자, 보상 지급 요청/처리/취소자, 공지 작성/게시/철회자, 장 운영 override 작성/수정자, 수동 환율 승인자, 참가자 제외/숨김/결과 정정자)은 `ACCOUNT_DELETION_REQUIRES_SUPPORT`다. 근거: 감사 로그 actor FK가 RESTRICT이며, 지우면 다른 회원의 운영 기록이 근거를 잃는다. 마지막 관리자 보호 규칙은 그대로다(관리자는 이 경로로 탈퇴할 수 없다).
- 처리 방식(별도 결정 필요): 운영자 계정 삭제는 감사 기록 보존기간과 actor 익명화 정책이 정해진 뒤 별도 절차로 한다.

## 4. 삭제 트랜잭션

`AccountDeletionService` → `account-deletion.purge.ts`. Prisma 상호작용 트랜잭션(`timeout 60 s`, `maxWait 10 s`) 안에서 `lock_timeout 10 s`, `statement_timeout 30 s`.

잠금 순서(기존 writer와 같은 순서로 직렬화, 교착 대신 대기):

1. 이메일 advisory lock(웹은 증거 소비가 잡음, 앱도 같은 순서로 잡음).
2. `users` 행 `FOR NO KEY UPDATE` — 로그인·refresh·비밀번호 재설정·프로필 사진·운영자 상태 변경을 막는다. FK KEY SHARE 삽입(FX 요청, 시즌 참가)은 끝까지 진행할 수 있고, 마지막 `DELETE FROM users`가 그들을 기다린다.
3. 상태·역할·비밀번호 hash·tokenVersion 재검사(웹: 증거의 대상 회원·발급 버전), 운영 기록 검사.
4. `quotes` `FOR UPDATE`(id 순) — 견적 우선 거래와 같은 첫 잠금.
5. 참가 시즌 `FOR SHARE`(id 순) — 랭킹 갱신·정산·참가(`FOR UPDATE`)와 직렬화. 진행 중 정산이 있으면 끝날 때까지 기다린 뒤 그 결과(예: 방금 확정된 최종 순위)를 본다.
6. `trading_accounts` `FOR UPDATE`, `season_participants` `FOR UPDATE` — 잠금 전 읽은 집합과 다르면(동시 계좌 개설·참가) 다시 시도.
7. `orders` `FOR UPDATE`(id 순) — 취소·LOC·시즌 종료 정리가 주문 → 지갑 순서로 잡기 때문.
8. 영수증 생성 → 정산 시즌 최종 결과 익명 보존(§5) → 행 삭제(자식 → 부모) → 프로필 객체 연결 → `users` 삭제.

교착(40P01)·직렬화(40001)·잠금 시간 초과(55P03)·동시 삽입 FK(23503/P2003)·unique 경합(P2002)·Prisma 트랜잭션 오류(P2028)는 트랜잭션 전체를 최대 3회 다시 실행한다. 그 밖의 오류와 소진은 `503 ACCOUNT_DELETION_FAILED`(rollback 보장)다. 로그는 안전한 분류만 남긴다(비밀번호·토큰·증거·요청 키·이메일·회원 ID 없음; 삭제 성공 로그는 영수증 ID와 테이블별 건수만).

마지막 `DELETE FROM trading_accounts`/`users`의 RESTRICT FK가 완전성 검사 역할을 한다: 목록에서 빠진 행이나 동시에 생긴 행이 있으면 전체가 rollback된다. 단위 테스트(`account-deletion.purge.spec.ts`)는 `schema.prisma`를 읽어 회원·투자계정을 (전이적으로) 참조하는 모든 테이블이 삭제 목록에 있거나 사유가 있는 예외인지, 자식이 RESTRICT 부모보다 먼저 지워지는지 검사한다(새 테이블을 추가하면 이 테스트가 실패한다).

## 5. 데이터 분류와 처리

| 분류 | 테이블/저장소 | 처리 |
| --- | --- | --- |
| 계정·인증 | `users`(이메일·hash·닉네임·인증 시각·tokenVersion·사진 URL·공개 설정·역할) | 삭제 |
| 세션 | `refresh_token_sessions`(IP·user agent 포함) | 삭제 |
| 이메일 인증 | `email_auth_challenges`(이메일·대상 ID) | 그 이메일·대상의 행 삭제. IP 버킷(`email_auth_rate_buckets`)은 IP digest라 회원과 무관 — 유지 |
| 프로필 사진 | 관리형 객체 `profile-images/{userId}/{uuid}.jpg` | 객체 삭제(§6). 외부/레거시 URL은 객체를 요청하지 않음(우리 소유 아님), URL은 회원 행과 함께 삭제 |
| 소셜 | `friendships`(양방향), 다른 회원에게 간 친구 요청 푸시(`friend:{회원}:…`, 닉네임 포함) | 삭제 |
| 문의 | `inquiries` + 그에 대한 `inquiry_answers` | 삭제 |
| 알림 | `push_devices`, `notification_preferences`, 회원의 `push_notifications`(+`push_deliveries` cascade) | 삭제 |
| 보상 | `season_rewards`, `reward_fulfillment_requests`(대상), `user_badges` | 삭제 |
| 가상 투자 | 모든 투자계정(초보·일반·시즌)과 지갑·원장·견적·주문·포지션·환전·이체·FX 요청·광고 보상·선물 포지션/체결/요청/지정가/청산/시즌 정산·조건주문·LOC·보호 주문·진입 TP/SL·학습 확인·스냅샷 | 삭제(체결·청산 없이) |
| 시즌 | 진행·대기·정산 전(`upcoming/active/ended`) 참가와 그 일별 순위 | 삭제 |
| 시즌 | **정산 완료 시즌에서 최종 순위 행이 있는 참가** | §5.1 익명 보존 |
| 공용 데이터 | 자산·시세·캔들·FX·선물 Last/Mark·시즌 정의·뱃지 카탈로그·증거 | 변경 없음 |
| Redis | 회원·투자계정 키 없음(시세·공급자 조정 키뿐) | 해당 없음 |
| WebSocket | 공개 시세 채널만 존재 | 새 연결은 회원 행이 없어 1008로 거부. 이미 열린 시세 연결은 강제 종료하지 않음(비밀번호 재설정과 같은 기존 정책; 회원 데이터 채널 없음) |

### 5.1 정산 완료 시즌의 최종 결과

확정된 최종 순위표는 다른 참가자의 결과 자체다: 순위 연속성(1..N), 표시 시점에 계산되는 백분위·등급 fallback·홈 "N위/M명", 정산 replay의 등급 분모, 최종 결과 무결성 검사(자격 시즌), 운영 audit이 모두 행의 수와 순위 슬롯에 의존한다(조사: 행을 지우면 replay가 다른 회원의 등급을 N−1로 다시 계산하고 홈에 "10위/9명"이 생긴다). 그래서 **최종 순위 행이 있는 정산 완료 시즌 참가만** 새 익명 placeholder로 옮긴다:

- 새 회원(`ghost-{uuid}@deleted-member.invalid`, 닉네임 `탈퇴한 회원 XXXXXX`, 사용할 수 없는 비밀번호 hash, `status=deleted`), 새 시즌 투자계정(같은 상태·초기자본·개시/종료 시각, 지갑·거래 없음), 새 참가 행(최종 순위·등급·총자산·수익률·MDD·체결 수·자격 판정·운영자 숨김/정정 표시 등 확정 결과 열만 복사)을 만들고 그 시즌의 `final` 순위 행만 새 참가/계정으로 옮긴다.
- 원래 회원·계정·참가 ID와는 아무 연결이 없다(새 ID). 닉네임·사진·이메일·거래 내역은 남지 않는다. 일별(잠정) 순위·보상·뱃지·모든 거래 행은 삭제된다.
- placeholder는 로그인·비밀번호 재설정·친구 검색·푸시 대상이 될 수 없고, 운영자 복구는 `409 USER_RESTORE_NOT_ALLOWED`다. 운영자 회원 목록에는 `deleted` 상태 placeholder로 보인다.
- 다른 참가자의 최종 순위·등급·보상·뱃지·참가 행은 바뀌지 않는다(통합 테스트: 실제 정산 replay·최종 등급 job 뒤에도 동일).

조회 계약 변경은 없다(순위표에는 그 자리에 "탈퇴한 회원 …"이 보인다). 알려진 영향: 삭제된 **일별(잠정)** 순위 행 자리에는 그날 순위표에 빈 순위가 남아, 운영 audit `SEASON_RANKING_RANK_SEQUENCE_BROKEN`에 그 set이 집계된다(진행 중 시즌의 당일 set은 다음 갱신에서 다시 1..N). 대안(별도 결정): 일별 행도 익명 보존하거나 audit에 탈퇴 공백 기록을 추가.

## 6. 프로필 사진 객체

`profile_image_cleanups`(object_key PK, account_deletion_id, attempts, next_attempt_at, last_error_code):

- 업로드는 저장소 쓰기 **전에** 회원 행을 잠그고 키를 10분 lease로 등록한다. URL 변경 트랜잭션이 그 등록을 소비한다(없어졌으면 URL을 쓰지 않고 실패). 그래서 서버 중단·정리 실패·탈퇴와 겹친 업로드의 객체도 추적된다.
- 교체·삭제된 사진은 URL 변경과 같은 commit으로 즉시 기한 등록되고 바로 삭제를 시도한다(기존 best-effort의 실패분도 이제 재시도된다).
- 탈퇴 트랜잭션은 현재 사진을 즉시 기한으로, 진행 중 업로드 등 그 회원 prefix의 모든 행을 영수증에 연결한다(lease 유지). 영수증은 연결된 행이 모두 없어져야 `completed`.
- `ProfileImageCleanupWorker`: 저장소가 설정된 서버에서만 1분마다 Ops lease(`account_deletion_cleanup:current`)로 기한 행을 처리한다. 실패 시 1, 2, 4… 분, 최대 6시간 간격으로 계속 재시도하고(포기 없음), 실패 원인은 `STORAGE_UNAVAILABLE`/`STORAGE_TIMEOUT`/`STORAGE_DELETE_FAILED`로만 기록한다. 탈퇴 7일이 지나도 `cleanup_pending`이면 `account_deletion_cleanup_overdue` 경고와 실패 Ops run(`ACCOUNT_DELETION_CLEANUP_OVERDUE`)을 남긴다. 일이 없으면 lease·run을 쓰지 않는다.
- 한계: 이 변경 이전의 정리 실패로 남은 고아 객체(로그 `profile_image_storage_failed`)는 키를 모르므로 지우지 못한다(목록 권한 없음). CDN/브라우저 캐시는 만료까지 남을 수 있다. 저장소 설정이 꺼진 동안의 관리형 URL은 키를 판정할 수 없다.

## 7. 웹 계정 삭제 요청(nanghwa.com) 계약

이 저장소에는 회사 웹사이트 코드가 없다. 아래는 웹페이지가 구현해야 할 요구사항이다. **페이지가 실제로 공개되기 전에는 Google Play 계정 삭제 URL이 준비된 것이 아니다.**

흐름(로그인·앱 설치 불필요):

1. 이메일 입력 → `POST /api/v1/auth/email/request` `{ email, purpose: "account_deletion" }`. 응답은 계정 존재 여부와 무관하게 같다(`message`: "입력하신 이메일로 계정이 등록되어 있다면 인증번호가 발송됩니다."). 활성 회원에게만 Resend 메일(제목 "Trading Class 회원탈퇴 인증번호", 복구 불가 경고, 요청하지 않았다면 비밀번호 변경 안내).
2. 인증번호 6자리 → `POST /api/v1/auth/email/verify` `{ email, purpose: "account_deletion", challengeId, code }` → `verificationToken`(10분, 1회용).
3. 삭제 대상·보관 안내 표시(§5 요약: 로그인 불가, 가상 투자계정·기록·친구·문의·보상 삭제, 복구 불가, 정산 완료 시즌 최종 순위표에 익명 결과만 남음, 백업·운영 기록은 별도 보존·파기 정책) + 명시적 동의 체크.
4. 최종 요청 → `POST /api/v1/auth/account-deletion` `{ email, verificationToken, requestKey, confirm: true }`. `requestKey`는 브라우저 `crypto.randomUUID()` 두 개를 이어 하이픈을 뺀 값으로 만들고, 결과를 받을 때까지 메모리에 둔다.
5. 결과 안내: `completed` → 삭제 완료. `cleanup_pending` → "계정과 기록은 삭제됐고 프로필 사진 파일은 7일 이내 완료를 목표로 정리 중"(보장이 아니라 목표다; 서버는 계속 재시도하고 7일 초과 시 경고한다). 응답 유실·타임아웃 → 같은 키로 `POST /api/v1/auth/account-deletion/status`(404 = 삭제되지 않음, 다시 시도 가능; 같은 키로 재요청하면 같은 영수증).

보안·운영 요구:

- 인증번호 목적 분리: `signup`/`password_reset` 증거로는 삭제할 수 없고, `account_deletion` 증거로 가입·재설정할 수 없다. 증거는 이메일·대상 회원·발급 시 tokenVersion에 묶인다(발급 뒤 비밀번호가 바뀌면 무효).
- 기존 email auth 규칙 그대로: 코드 10분·5회 오입력 소진, 재발송 60초·이메일당 시간 5회, IP 예산, 응답 지연·jitter, 존재 여부 비노출, Resend 실패 시 그 코드 무효.
- CORS: 서버는 `CORS_ORIGINS`(또는 `FRONTEND_ORIGINS`)에 있는 Origin만 허용한다. 운영 배포 전 `https://nanghwa.com`(사용하는 정확한 Origin) 추가가 필요하다(환경변수 변경은 이번 작업에서 하지 않았다).
- 페이지는 HTTPS, 서드파티 스크립트로 요청 본문(이메일·코드·증거)을 보내지 않는다. 코드·증거·요청 키를 URL·localStorage·분석 이벤트에 남기지 않는다.
- Google Play 계정 삭제 URL 신고 시 이 페이지 URL을 쓴다. 고객센터 이메일 등 대체 경로도 함께 안내하는 것을 권장한다.

## 8. 앱(Expo)

설정 화면 맨 아래(로그아웃 아래) "회원탈퇴" → `MembershipDeletion`(안내 확인 체크 → 비밀번호 본인 확인(`password-check`) → 최종 확인 → 탈퇴하기). 취소·뒤로가기는 아무것도 바꾸지 않는다. 결과는 위 영수증으로 판정하며(응답 유실·502·401·세션 교체는 상태 조회), 확인되면 로그아웃과 같은 세션 종료(React Query 전체 초기화, 토큰, 그 회원의 계정 선택 키; 푸시 토큰 해제와 WebSocket 종료는 종료된 세션을 따라감) 뒤 인증 스택의 결과 화면을 연다. 비밀번호와 요청 키는 메모리에만 있다.

## 9. 보존기간·정책 결정 필요 항목(이번 작업에서 정하지 않음)

- 서버 백업(Render 관리 PostgreSQL)과 Render 애플리케이션 로그(회원 ID·IP가 들어간 요청/경고 로그)의 보존기간·파기 주기.
- `operator_audit_logs`의 `targetId`·`metadataJson`(운영자 검색어·사유 자유 텍스트 포함 가능), `batch_job_runs`/`ops_job_runs` 결과 JSON의 회원·계정 ID, 공지 fan-out 커서의 회원 ID — 운영 기록으로 보존 중. 보존기간 또는 마스킹 정책 결정 필요.
- `account_deletions` 영수증(개인정보 없음: 상태·시각·채널·키 hash)의 보존기간.
- 이메일 인증 challenge 일반 보존(계약상 24시간 정리)이 아직 운영에 연결되지 않음 — 탈퇴 뒤 그 이메일로 새 요청이 오면 행이 생길 수 있다.
- 재가입 남용 방지: 지금은 탈퇴 회원과 아무 연결(이메일 hash 등)도 남기지 않으므로 같은 이메일 재가입은 완전히 새 회원이다(진행 중 시즌 재참가, 일반모드 최초 가상자금 재지급 포함). 제한하려면 식별자 보존과 그 보존기간을 함께 정해야 한다.
- 광고 보상이 운영되면(현재 검증기 없음) `(provider, providerEventId)` 중복 지급 방지 기록을 개인정보 없이 남기는 별도 표가 필요하다(지금은 회원과 함께 삭제).
- 정지·운영자 삭제 상태 회원과 운영자 계정의 삭제 절차, 그리고 전자상거래·통신 관련 법정 보존 의무 해당 여부(법무 판단).
