# Trading Class 회원탈퇴·개인정보 삭제 구현 보고서

기준일: 2026-10-18. 구현과 격리 환경 자동 검증까지 완료했다. **커밋·push·운영 DB migration·배포·실제 메일 발송·실제 저장소 삭제·실기기 검증은 하지 않았다.** 모든 변경은 main 작업 트리에 커밋되지 않은 상태다.

- 서버 계약(기준 문서): [backend/docs/account-deletion-contract.md](../../../backend/docs/account-deletion-contract.md)
- 앱 QA: [frontend/docs/membership-deletion-qa.md](../../../frontend/docs/membership-deletion-qa.md)
- 정책 기록: [backend/docs/policy-decisions.md](../../../backend/docs/policy-decisions.md) 맨 위 절

## 1. 기존 구조와 문제점

- 시작: main HEAD `a40fe95d`(로컬 `origin/main` 참조와 같음), 작업 트리 clean. 회원탈퇴 API·화면·웹 경로가 없었다.
- `UserStatus.deleted`는 운영자의 상태 변경(제재)이며 `POST /operator/users/:id/restore`로 되돌릴 수 있다. 상태만 바꾸면 이메일·닉네임·사진·세션·투자 기록이 그대로 남고, 운영자 복구가 "탈퇴"를 되살린다.
- 회원 → 투자계정 → 지갑·원장·주문·포지션·선물·조건주문·시즌 참가로 이어지는 FK가 거의 모두 RESTRICT다. `DELETE FROM users`만으로는 지울 수 없고, Cascade로 바꾸는 것은 금지 사항이다.
- 확정 시즌 결과: 최종(`final`) 순위 행의 수와 순위 슬롯을 다른 참가자의 백분위·등급 fallback·홈 "N위/M명"·정산 replay의 등급 분모·최종 결과 무결성 검사·운영 audit이 읽는다. 행을 지우면 다른 회원의 확정 결과가 바뀐다.
- 프로필 사진 교체·삭제 뒤 이전 객체 삭제는 1회 best-effort였다(실패하면 로그만 남고 객체가 고아가 됨).
- 이메일 인증은 `signup`/`password_reset` 두 목적뿐이었다. Access 토큰은 Guard가 요청마다 회원 행(status·tokenVersion)을 읽으므로, 회원 행이 없어지면 즉시 401이 된다(이번에 그대로 활용).
- 운영 기록의 행위자 FK(`operator_audit_logs.actor` 등)가 RESTRICT라, 운영 행위를 한 회원을 지우면 다른 회원에 대한 운영 기록이 근거를 잃는다.

## 2. 데이터 분류

계약 §5 표가 기준이다. 요약:

| 분류 | 처리 |
| --- | --- |
| 계정·인증(`users`, 세션, 이메일 인증 challenge, 비밀번호 hash, tokenVersion) | 탈퇴 트랜잭션에서 삭제 |
| 프로필(닉네임·사진 URL·공개 설정) | 회원 행과 함께 삭제. 관리형 사진 객체는 commit 직후 삭제, 실패 시 durable queue 재시도 |
| 소셜·문의·알림(친구, 다른 회원에게 간 친구 요청 푸시, 문의와 그 답변, 푸시 기기·설정·알림) | 삭제 |
| 보상·배지 | 삭제 |
| 가상 투자(초보·일반·시즌 계정과 지갑·원장·견적·주문·포지션·환전·이체·선물·조건주문·LOC·보호 주문·스냅샷·학습 확인) | 체결·청산 없이 삭제 |
| 진행·대기·정산 전 시즌 참가와 일별 순위 | 삭제(이후 순위에서 빠짐, 제외/제재로 기록하지 않음) |
| 정산 완료 시즌의 최종 순위 결과 | 원 회원과 연결 없는 익명 placeholder로 결과 값만 보존(§4) |
| 공용 데이터(자산·시세·캔들·FX·시즌 정의·뱃지 카탈로그), 다른 회원 데이터 | 변경 없음 |
| 운영 기록·백업·애플리케이션 로그 | 이번 작업에서 지우지 않음. 보존기간은 결정 필요(§12) |

Redis에는 회원·투자계정 키가 없다(시세·공급자 조정 키뿐). WebSocket은 공개 시세 채널만 있다.

## 3. 선택한 삭제 방식과 이유

**확정 = 한 트랜잭션 hard delete + 영수증.** 본인 확인 증거 검사, 47개 테이블의 명시적 순서 삭제(자식 → 부모, 마지막 `users`), 정산 시즌 결과 익명 보존, 영수증(`account_deletions`) 기록이 하나의 DB 트랜잭션이다. 모두 commit되거나 아무것도 바뀌지 않는다.

- 상태 변경만(금지), soft delete 후 지연 purge(개인정보가 남는 기간과 상태가 늘어남, 별도 삭제 플랫폼 필요), FK Cascade 변경(금지·다른 금융 데이터로 번질 위험), 제자리 익명화(원 ID 연결이 남아 "익명 처리"라고 할 수 없음)는 택하지 않았다.
- 모든 금융 FK는 그대로 RESTRICT이며, 마지막 `DELETE`의 RESTRICT가 완전성 검사가 된다(빠진 행·동시에 생긴 행이 있으면 전체 rollback). `account-deletion.purge.spec.ts`가 `schema.prisma`를 읽어, 회원·투자계정을 전이적으로 참조하는 모든 테이블이 삭제 목록이나 사유 있는 예외(`operator_audit_logs` = 운영자 거절, `push_deliveries` = 기존 cascade)에 있는지 검사한다. 새 테이블을 추가하면 이 테스트가 실패한다.
- 잠금 순서를 기존 writer와 맞췄다: 이메일 advisory lock → `users` `FOR NO KEY UPDATE` → `quotes` → 시즌 `FOR SHARE` → 투자계정·참가 `FOR UPDATE`(잠금 전 집합과 다르면 재시도) → `orders`. 교착·직렬화·잠금 시간 초과·동시 삽입 FK·unique 경합은 트랜잭션 전체를 최대 3회 재실행하고, 그 밖은 `503 ACCOUNT_DELETION_FAILED`(아무것도 바뀌지 않음)다.
- 진행 중 주문·예약·조건주문·선물 포지션은 체결·청산·손익 없이 행째 삭제한다. 다른 회원의 행은 바뀌지 않는다.
- 운영자·관리자(`ROLE_RESTRICTED`), 운영 기록의 행위자였던 회원(`REQUIRES_SUPPORT`), 정지·운영자 삭제 상태 회원(`USER_NOT_ACTIVE`)은 스스로 탈퇴하지 못한다(감사 기록·마지막 관리자 보호·제재 정책 유지). 이들의 삭제 절차는 결정 필요 항목이다.

## 4. FK·시즌 무결성 처리

- **진행 중·정산 전 시즌:** 참가·일별 순위·보상 행을 삭제한다. 다음 랭킹 갱신부터 순위에 없다. 정산과 겹치면 시즌 `FOR SHARE`가 정산(`FOR UPDATE`)과 직렬화한다: 정산이 먼저면 탈퇴가 기다린 뒤 확정 결과를 보고(익명 보존), 탈퇴가 정산의 평가와 최종 기록 사이에 commit되면 그 정산은 기존 `SETTLEMENT_PARTICIPANTS_CHANGED`로 실패하고 재실행이 남은 참가자로 순위를 매긴다(통합 테스트로 확인).
- **정산 완료 시즌:** 최종 순위 행이 있는 참가만 새 placeholder 회원(`ghost-{uuid}@deleted-member.invalid`, 닉네임 `탈퇴한 회원 XXXXXX`, 사용할 수 없는 hash, `status=deleted`) + 새 종료 시즌 계정(지갑·거래 없음) + 새 참가(확정 결과 열만 복사)로 옮기고, 그 시즌의 `final` 순위 행만 새 ID로 다시 가리킨다. 원 회원·계정·참가 ID, 닉네임, 사진, 이메일, 거래와의 연결은 남지 않는다.
  - 남는 값: 순위표에 보이는 최종 순위·등급·총자산·수익률 등 확정 결과 값. 탈퇴 전 순위표를 본 사람이 기억·캡처로 그 자리를 알아볼 가능성은 남는다(확정 순위표를 유지하는 한 피할 수 없음). 순위 공백을 허용하는 대안은 다른 회원의 표시·replay·무결성 검사 변경이 필요해 택하지 않았다.
  - placeholder는 로그인·비밀번호 재설정·친구 검색·푸시 대상이 아니며, 운영자 복구는 `409 USER_RESTORE_NOT_ALLOWED`다.
  - 통합 테스트: 실제 정산 replay·최종 등급 job 뒤에도 다른 참가자의 순위·등급·보상·뱃지·참가 행이 그대로다.
- **알려진 영향(결정 필요):** 삭제된 일별(잠정) 순위 행 자리에는 그날 순위표에 빈 순위가 남고 운영 audit `SEASON_RANKING_RANK_SEQUENCE_BROKEN`에 집계된다. 대안: 일별 행도 익명 보존하거나 audit에 탈퇴 공백 표시 추가.

## 5. 상태 판단 기준

서버 영수증이 Source of Truth다. 앱·웹은 응답 성공 여부나 로컬 상태로 완료를 판단하지 않는다.

| 상태 | 의미 |
| --- | --- |
| 영수증 없음(`404 ACCOUNT_DELETION_NOT_FOUND`) | 삭제되지 않음. 같은 요청 키로 다시 시도 가능 |
| `cleanup_pending` | 회원·개인정보·가상 투자 데이터 삭제 commit됨, 로그인 불가. 관리형 프로필 사진 객체 삭제가 남음 |
| `completed` | 이 회원의 데이터와 관리형 사진 객체 삭제가 모두 끝남. 익명 최종 결과(§4)와 백업·운영 기록(§12)은 이 판정 밖 |

- commit 직후 사진 삭제를 바로 시도하고 영수증을 다시 읽어 응답하므로, 저장소가 정상이면 응답이 바로 `completed`다.
- 실패분은 `ProfileImageCleanupWorker`가 1분마다 Ops lease로 재시도한다(1, 2, 4… 분, 최대 6시간 간격, 포기 없음). 7일이 지나도 `cleanup_pending`이면 경고 로그와 실패 Ops run(`ACCOUNT_DELETION_CLEANUP_OVERDUE`)을 남긴다. 7일은 목표이지 보장이 아니며 화면 문구도 그렇게 표시한다.
- 업로드는 저장소 쓰기 전에 키를 10분 lease로 등록하고 URL 변경 트랜잭션이 소비한다. 그래서 탈퇴와 겹친 업로드·서버 중단으로 생긴 객체도 영수증에 연결되어 지워진다. 일반 사진 교체·삭제의 정리 실패도 이제 같은 queue로 재시도된다.

## 6. 앱 UX와 API

- 위치: MY → 설정 → 맨 아래 로그아웃 아래 "회원탈퇴"(작은 밑줄 링크).
- 흐름: 안내(삭제되는 정보 / 남는 정보와 이유, "위 내용을 모두 확인했습니다" 체크) → 본인 확인(현재 비밀번호 → `password-check`, 아무것도 쓰지 않음) → 최종 확인("정말 탈퇴하시겠어요?" 탈퇴하기 / 취소) → 영수증 판정 → 로그아웃과 같은 세션 종료(React Query 전체 초기화, 토큰, 그 회원의 계정 선택 키) → 인증 스택 결과 화면 → 확인 → 로그인.
- 취소·뒤로가기는 아무 요청도 보내지 않는다. 연타는 1회 전송. 응답 유실·502·401은 같은 요청 키로 상태를 조회한다(있음 = 삭제, 404 = 미삭제 후 같은 키로 재시도, 조회 실패 = "결과 다시 확인", 재전송 없음). 서버 거절은 상태 조회 없이 최종이며, 확인 뒤 비밀번호가 바뀌었으면 본인 확인으로 돌아간다.
- 비밀번호와 요청 키는 메모리에만 있다(탐색 파라미터·저장소에 없음). 결과 화면은 키가 메모리에 있을 때만 "처리 상태 다시 확인"을 보인다.
- 오류 문구 7개(한국어): 비밀번호 불일치, 최종 확인 필요, 요청 준비 실패, 운영자·관리자 계정, 고객센터 필요, 처리 실패(계정 유지), 요청 없음.

| API(`/api/v1`) | 인증 | 용도 |
| --- | --- | --- |
| `POST /me/account-deletion/password-check` | Bearer | 본인 확인(쓰기 없음) |
| `POST /me/account-deletion` | Bearer | 앱 탈퇴 확정 `{ password, requestKey, confirm: true }` |
| `POST /auth/account-deletion` | 공개 | 웹 탈퇴 확정 `{ email, verificationToken, requestKey, confirm: true }` |
| `POST /auth/account-deletion/status` | 공개 | 요청 키로 영수증 조회 |

앱 경로는 `request.user.userId`만 신뢰한다(본문 `userId` 무시). 비밀번호 불일치는 400이라 세션을 끝내지 않는다.

## 7. 웹 계정 삭제 요청 상태

- **이 저장소에 회사 웹사이트(nanghwa.com) 코드가 없다.** 외부 저장소·서버는 건드리지 않았다.
- 서버 API(웹 확정·상태 조회, `account_deletion` 목적 이메일 인증)와 웹페이지가 구현해야 할 계약(계약 §7: 화면 단계, 요청 키 생성, 결과·재조회, 보안 요구)을 준비했다.
- 운영 반영 전 필요: 서버 배포(승인 필요), `CORS_ORIGINS`에 웹페이지의 정확한 Origin 추가, 웹페이지 구현·공개.
- **웹페이지가 공개되지 않았으므로 Google Play 계정 삭제 URL은 준비되지 않았다.**

## 8. Resend 재사용

- 기존 `POST /auth/email/request`·`/auth/email/verify`에 `purpose: "account_deletion"`을 추가했다. 새 발송 경로·SDK·큐는 없다.
- 메일: 제목 "Trading Class 회원탈퇴 인증번호", 코드·10분 안내에 "이 인증번호로 회원탈퇴를 확정하면 계정과 가상 투자 기록이 삭제되며 복구할 수 없습니다", "본인이 요청하지 않았다면 이 메일을 무시하고 비밀번호를 변경해주세요"를 추가했다(text/HTML).
- 목적 분리: `signup`/`password_reset` 증거로 삭제할 수 없고, 삭제 증거로 가입·재설정할 수 없다. 삭제 증거는 이메일·대상 회원·발급 시 tokenVersion에 묶인다(발급 뒤 비밀번호가 바뀌면 무효). 소비는 삭제 트랜잭션 안에서 한다(1회용, 실패하면 소비도 rollback).
- 기존 규칙 그대로: 6자리, 10분, 5회 오입력, 재발송 60초, 이메일 합계 시간당 5회, IP 예산, 존재 여부 비노출(미등록·비활성 주소에는 발송하지 않고 같은 응답), 제공자 실패 시 그 코드 무효. 새 IP bucket `status`(상태 조회 100회/10분)만 추가했다.

## 9. 변경 파일과 migration

Migration(추가만, 기존 행·테이블·제약 변경 없음):

- `20261018200000_add_account_deletion_enums`: `EmailAuthPurpose += account_deletion`, `OpsJobName += account_deletion_cleanup`(같은 트랜잭션에서 새 enum 값을 쓸 수 없어 분리; 기존 패턴).
- `20261018200100_add_account_deletion`: `account_deletions`(영수증; 회원 FK 없음, 개인정보 없음, 키 hash 형식·완료 시각 CHECK), `profile_image_cleanups`(객체 키 형식 CHECK, 영수증 FK RESTRICT) + 인덱스.
- 로컬 drift 검사: "No difference detected". Prisma client 재생성.

Backend:

- 신규: `src/auth/account-deletion.{controller,service,purge}.ts`, `src/auth/profile-image-cleanup.{service,worker}.ts`, 테스트 `account-deletion.{purge,service,integration}.spec.ts`, `profile-image-cleanup.service.spec.ts`, `test/account-deletion.e2e-spec.ts`, PG 러너 `scripts/account-deletion-integration.ts`, `docs/account-deletion-contract.md`.
- 수정: `auth.module.ts`(등록), `auth.service.ts`(`verifyPassword` 공개), `email-verification.service.ts`(목적·대상 바인딩·`status` bucket·`lockEmail` 공개), `auth-email.service.ts`(제목·경고 문구), `profile-image.service.ts`(업로드 lease·URL 변경 시 소비·교체 객체 queue), `profile-image-storage.service.ts`(`isConfigured`), `operator-user-status.service.ts`(placeholder 복구 거절), `ops-config.ts`(전용 워커라 일반 Ops 스케줄 off), `common/public-error-message.ts`, `prisma/schema.prisma`, `src/generated/prisma/*`, 테스트 `auth-email.service.spec.ts`·`profile-image.service.spec.ts`·`asset-ticker.gateway.spec.ts`(삭제된 회원 handshake)·`test/profile-image.e2e-spec.ts`.
- 문서: `docs/README.md`, `auth-api-contract.md`, `operator-api-contract.md`, `inquiries-contract.md`, `push-notifications-contract.md`, `policy-decisions.md`, `trading-modes-and-accounts.md`(재가입 = 새 회원).

Frontend:

- 신규: `src/features/me/membershipDeletion{Api,Flow}.ts`, `src/screens/my/MembershipDeletionScreen.tsx`, `src/screens/auth/MembershipDeletionResultScreen.tsx`, 각 테스트, 브라우저 검사 `test/browser/membershipDeletion{Browser.cjs,Fixture.jsx,Mocks.js}`, `docs/membership-deletion-qa.md`.
- 수정: `SettingsScreen.tsx`(+테스트), 내비게이션 `types.ts`·`MyStack.tsx`·`AuthStack.tsx`·`navigationRef.ts`, `constants/testIds.ts`, `models/enums/errorCode.ts`, `services/api/errorMapper.ts`.

CI: `.github/workflows/ci.yml` core account job에 "Account deletion PostgreSQL integration (mocked storage and delivery)" 단계 추가(새 `account_deletion_test` DB).

증거: `docs/investigations/2026-10-18-account-deletion/evidence/*.png`(320 폭, 2배 글자, Light/Dark 5장).

## 10. 테스트 결과와 미검증 항목

모든 DB 검증은 로컬 사용자 공간 PostgreSQL 16 / Redis 7의 새 `*_test` DB에서 했다. 저장소·메일은 in-memory 대역이며 실제 Resend·S3·운영 DB는 쓰지 않았다. 아래 "최종 트리"는 이 보고서 시점의 작업 트리다.

| 영역 | 결과 |
| --- | --- |
| 회원탈퇴 PostgreSQL 통합 `scripts/account-deletion-integration.ts` | **26/26 PASS**(최종 트리: jest 래퍼 1회, 직접 실행 1회; 이전 트리 2회). 실행 뒤 남는 행 0 |
| 백엔드 단위 전체 | **349 suites / 5,651 tests PASS**, opt-in DB 84 suites / 117 tests skip(기존 방식) |
| 백엔드 HTTP e2e | 구현 중 전체 411 PASS, 최종 트리에서 변경 2 스위트(`account-deletion`, `profile-image`) 13/13 PASS |
| 인증 DB(`auth`, `email-verification`, 활성 관리자 경합) | 3/3 PASS(최종 트리, CI와 같은 env·새 DB) |
| core account CI 목록 | 26/27 PASS. `krx-session-close-recovery`(`live.created 2 !== 4`)는 main CI에서 이미 실패하던 기존 실패 |
| 거래 회귀 subset 7개(공유 DB 1회) | 1 PASS / 6 FAIL → 아래 분류 |
| ↳ 조건부 매수, 독립 TP/SL, 주문 실행, 시장가 체결, FX 실행 | 각자 새 DB에서 단독 재실행 **5/5 PASS**. 공유 DB 실패는 앞선 실패가 남긴 fixture(고정 심볼 P2002, 잔여 환율 행 `RATE_CHANGED_REQUOTE_REQUIRED`) 연쇄 |
| ↳ Futures F1 | **로컬 미통과(환경 원인으로 분류)**. 내 트리 4/4, 손대지 않은 `git archive HEAD` 사본 4/4가 같은 조건(새 DB, 시계 역전 기준 같은 시작 offset)에서 모두 실패. 실패 시각은 매번 journal "Clock change detected"(약 30.5초마다 약 −2초)와 같은 초였고, 코드는 같은 계열(`BEGINNER_QUEST_EVIDENCE_REQUIRED`, 선물 퀘스트 증거 순서 `executedAt > 이전 증거`, `ASSET_PRICE_UNAVAILABLE`, `FUTURES_PRICE_UNAVAILABLE`). F1 한 번(약 32초)이 역전 주기보다 길어 로컬에서 역전 없는 실행이 불가능하다. F1 import graph에서 바뀐 파일은 재생성 Prisma client(enum 값·모델 추가)와 공개 오류 문구 맵뿐이다. 같은 날 A·B 후속 작업도 같은 이유로 F1을 CI에서 확인했다 → **push 후 CI 확인 필요** |
| 백엔드 typecheck(`tsconfig.build.json`) | PASS |
| 백엔드 eslint(check-only, 변경 TS 24개) | 새·수정 product 파일과 새 spec 0건. 기존 spec 2개(`asset-ticker.gateway.spec.ts`, `auth-email.service.spec.ts`)의 위반은 모두 내 hunk 밖 기존 부채(백엔드 gated lint 범위 밖) |
| 진단 게이트 backend / frontend | PASS / PASS(검토 중 1건 수정, §13) |
| 프론트 `npm run check`(lint·guides·typecheck·test) | **362 suites / 3,119 tests PASS**, lint·guides·typecheck PASS(최종 트리) |
| 프론트 Web export | PASS(최종 트리) |
| 브라우저 레이아웃 `membershipDeletionBrowser.cjs` | **156/156 PASS**(최종 문구): 320/375/430 × Light/Dark × 글자 1/2배 + 키보드 높이, 13 상태, 잘림·가로 스크롤·hit-test, 검출기 self-test |

통합 러너가 실제 PostgreSQL로 확인한 것(26): 모든 계정 도메인을 가진 회원 fixture, 앱 탈퇴의 한 commit 삭제, 다른 회원·공용 시세·시즌 불변, 정산 시즌 익명 보존과 replay·최종 등급 job 뒤 순위·등급 불변, 이전 토큰·로그인·운영자 복구 불가, 늦게 도착한 거래 명령 무기록 실패, 같은 이메일·닉네임 재가입 = 새 회원, 투자계정 없는 회원의 웹 탈퇴, 초보 계정(퀘스트 확인 포함), 잘못된 비밀번호·확인 누락·키 오류 무변경, 운영자·전 운영자·비활성 회원 거절, 미등록 이메일 동일 응답·무발송, 목적·이메일이 다른 증거 거절과 삭제 증거로 재설정 불가, 만료 증거·비밀번호 변경 전 증거 거절, 웹 1회용·요청 키 재생·서버 상태 조회, 동시 요청 1회 commit, 진행 중 거래 대기 후 삭제, refresh 경합, 정산 평가~최종 기록 사이 탈퇴 시 정산 실패 후 재실행, 정산 뒤 대기한 탈퇴의 최종 결과 보존, 겹친 업로드, 저장소 장애 → 워커 완료, DB 오류(임시 trigger) 중간 rollback 후 재시도, 연결 종료 rollback, 로그에 비밀번호·토큰·증거·요청 키·회원 ID 없음.

**미검증(NOT_RUN):**

1. GitHub Actions CI(push하지 않음) — F1 포함 전체 CI는 push 후 확인해야 한다.
2. Android/iOS 실기기: 실제 키보드, OS 글꼴 최대 배율, 비밀번호 자동완성, VoiceOver/TalkBack(웹 레이아웃 검사가 대체하지 않음).
3. 실제 Resend 발송(`account_deletion` 메일 수신·표시), 실제 S3 호환 저장소 객체 삭제와 CDN 캐시 만료.
4. 운영 DB migration·배포·운영 회원 데이터(승인 없음, 실험하지 않음).
5. 웹 계정 삭제 페이지(저장소에 없음).
6. 기록이 매우 많은 회원의 삭제 소요 시간(문장 30초·트랜잭션 60초 제한). 초과 시 `503`으로 아무것도 바뀌지 않으며 고객센터 처리가 필요하다 — 운영 데이터 규모 측정은 하지 않았다.

## 11. 배포 시 주의사항

- **main push = Render 자동 배포 + 운영 DB migration.** 이번 변경은 운영 DB 스키마를 바꾸고(추가 2개 migration) 운영 회원을 삭제할 수 있는 API를 연다. 사용자 승인 전에는 push하지 않는다. 기존 관행대로 `[skip render]` 커밋 후 별도 승인 배포가 안전하다.
- migration은 추가만 한다: enum 값 추가 2개, 새 테이블 2개. 기존 테이블 잠금·재작성·backfill 없음. 실패 시 Render build가 멈추고 기존 서버가 유지된다.
- 순서: 서버 먼저(migration → 모든 인스턴스 교체) → 새 앱 배포. 새 앱 + 구서버는 탈퇴 API가 없어(404) 오류 문구가 보이고 아무것도 지워지지 않는다. 구앱 + 신서버는 탈퇴 진입점이 없을 뿐 다른 동작은 같다(프로필 업로드 lease는 서버 내부 변경).
- 환경: 웹 흐름은 기존 `RESEND_API_KEY`/`EMAIL_FROM`/`EMAIL_VERIFICATION_SECRET`이 필요하고, 웹페이지 Origin을 `CORS_ORIGINS`에 추가해야 한다. 사진 정리 워커는 저장소 설정이 있는 서버에서만 돈다(여러 인스턴스는 Ops lease로 한 곳만 처리).
- Rollback: 코드를 되돌려도 새 테이블·enum 값은 남아도 무해하다. 단 `cleanup_pending` 영수증의 사진 객체는 새 코드가 다시 돌 때까지 지워지지 않는다. 되돌린 코드는 업로드 lease를 쓰지 않으므로 그 사이 교체 사진은 이전처럼 best-effort다.
- 배포 후 확인: 테스트 전용 회원(운영 실제 회원 금지)으로 앱 탈퇴 1회, `account_deletions` 상태, Ops run(`account_deletion_cleanup`) 경고 여부. 실제 사용자 계정·운영 DB에서 삭제 실험을 하지 않는다.
- 고객센터·개인정보처리방침 문구는 §12 결정 뒤 갱신해야 한다.

## 12. 개인정보처리방침 반영용 보존·삭제 정리

| 데이터 | 탈퇴 시 처리 | 시점 |
| --- | --- | --- |
| 이메일, 비밀번호 hash, 닉네임, 인증 시각, 역할·공개 설정 | 삭제 | 탈퇴 확정 즉시(같은 트랜잭션) |
| 로그인 세션(IP·기기 정보 포함), 이메일 인증 기록 | 삭제 | 즉시 |
| 프로필 사진 URL / 사진 파일 | URL 즉시 삭제 / 파일은 즉시 시도, 실패 시 재시도 | 파일 7일 이내 목표(보장 아님). CDN·브라우저 캐시는 만료까지 남을 수 있음 |
| 친구 관계, 문의와 답변, 푸시 기기·설정·알림, 보상·배지 | 삭제 | 즉시 |
| 가상 투자계정·자산·주문·체결·환전·이체·선물·조건주문·성과 기록 | 삭제(체결·청산 없음) | 즉시 |
| 진행 중·정산 전 시즌 기록 | 삭제 | 즉시 |
| 정산 완료 시즌 최종 결과(순위·등급·총자산·수익률 등) | 닉네임·사진·원 계정 연결 없는 익명 결과로 유지 | 시즌 기록 보존 기간 동안(별도 기간 없음 — 결정 필요) |
| 탈퇴 영수증(상태·시각·채널·요청 키 hash, 개인정보 없음) | 유지 | 보존기간 결정 필요 |
| 운영 감사 기록·작업 기록의 회원 ID·사유 텍스트, 공지 발송 커서 | 이번 작업에서 변경 없음 | 보존기간·마스킹 결정 필요 |
| 서버 백업, 애플리케이션 로그(회원 ID·IP) | 변경 없음 | 백업·로그 보존 주기 결정 필요(Render 설정 확인 포함) |
| 이메일 인증 IP 예산 bucket(IP digest) | 회원과 연결 없음 — 변경 없음 | 기존 이메일 인증 정책 |

**정하지 않은 것(임의로 30일·90일·1년 등을 정하지 않았다):** 백업·로그·운영 기록·영수증·익명 결과의 보존기간, 재가입 남용 방지 식별자 보존 여부, 운영자·정지 회원 삭제 절차, 법정 보존 의무 해당 여부(법무 판단). 목록은 계약 §9.

## 13. 최종 git diff 검토

- `git diff --check` 깨끗함. 새 파일에 행 끝 공백 없음. 디버그 출력·`.only`·임의 skip 없음(skip은 기존 opt-in DB 게이트 패턴뿐). 기존 테스트 삭제·skip 없음.
- 기존 migration 수정 없음(새 디렉터리 2개만). `schema.prisma` diff는 추가만이며 기존 관계의 `onDelete`/Cascade 변경 없음. `/api/v2` 없음. 운영 DB·외부 저장소·Render·EAS 접근 없음.
- 로그 검토: 새 로그는 이벤트 이름·영수증 ID·테이블별 건수·안전 분류 코드만 남긴다(비밀번호·인증번호·증거·요청 키·이메일 없음). `profile_image_storage_failed`의 회원 ID는 HEAD부터 있던 기존 로그다. 통합 러너가 실제 로그 출력에서 이를 검사한다.
- 테스트 단언: 새·수정 테스트는 원시값(문자열·불리언·개수)만 비교하고 ReactTestInstance 같은 큰 객체를 actual로 넘기지 않는다. 통합 러너의 상태 비교는 바뀐 경로만 제한 출력한다.
- 검토 중 찾아 고친 것:
  1. 프론트 진단 게이트가 `failure.message`를 JSX에 넣은 것을 원문 오류 노출로 판정 → 고정 문구 표를 outcome 키로 고르게 바꿈(원본 오류는 계속 ErrorNotice에 전달).
  2. 완료 화면의 "모두 삭제되었습니다"는 익명 최종 결과가 남을 수 있어 과장 → "삭제되었습니다 + 정산 완료 시즌 최종 순위표에는 닉네임 없는 결과만 남을 수 있음"으로 바꾸고 테스트로 고정.
  3. 정리 중 화면·웹 계약의 "7일 이내에 완료됩니다"는 보장이 아님 → "7일 이내 완료를 목표로" + 계약의 `completed` 정의에 익명 결과·백업 제외를 명시.
  4. 새 spec 2개의 eslint(prettier, `any` 접근) 수정.
  5. `trading-modes-and-accounts.md`의 "탈퇴 후 재가입 정책은 별도" 문장을 현재 동작(새 회원)과 결정 항목으로 갱신.
- 남은 판단 사항: §4 일별 순위 공백, §12 보존기간·재가입 남용 방지, 운영자·정지 회원 삭제 절차, 웹페이지 구현은 사용자 결정이 필요하다.
- git 인덱스: 진단 게이트 확인용으로 잠시 표시했던 intent-to-add를 되돌려, 시작 때처럼 아무것도 stage하지 않은 상태로 남긴다. 커밋·push 없음.
