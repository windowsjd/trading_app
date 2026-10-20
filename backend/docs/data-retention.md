# 개인정보·로그 보관기간과 자동 삭제 (2026-10-21)

이용약관·개인정보처리방침의 보관기간 결정(7·8번)을 코드로 옮긴 계약이다. 보관기간이 지난 행은 **물리 삭제**되며 되돌릴 수 없다.

## 1. 대상과 기준

| 대상 | 표 | 기준 시각 | 보관 | 설정 (기본, 허용 범위) | 구현 |
| --- | --- | --- | --- | --- | --- |
| 세션·접속정보(IP, User-Agent) | `refresh_token_sessions` | 폐기된 세션은 `LEAST(expires_at, revoked_at)`, 그 외 `expires_at` (`revoked_at`이 없으면 `expires_at`) | 종료 후 90일 | `AUTH_SESSION_RETENTION_DAYS` (90, 30–365) | `DataRetentionCleanupService` |
| 운영·보안 감사로그 | `operator_audit_logs` | `created_at` | 1년 | `OPERATOR_AUDIT_LOG_RETENTION_DAYS` (365, **365**–3650) | 〃 |
| 고객문의(+답변) | `inquiries`, `inquiry_answers` | 답변이 있으면 `answered_at`, 없으면 `created_at` | 처리 완료 후 3년 | `INQUIRY_RETENTION_DAYS` (1095, 30–3650) | 〃 |
| 일반 푸시 기록 | `push_notifications` (+`push_deliveries` cascade) | `created_at` | 30일 | — | `PushDispatcher.prune` (기존) |
| 시즌 최종 결과 푸시 기록 | `push_notifications` (`season_final_result`) | `created_at` | 30일 | — | 같은 prune, 2026-10-21부터 면제 없음 ([push 계약](push-notifications-contract.md) §2.6) |
| 이메일 인증 기록 | `email_auth_challenges`, `email_auth_rate_buckets` | 코드·증명 만료 | 만료 24시간 후 | — | `EmailAuthCleanupService` (기존) |
| 푸시 토큰·프로필 이미지·회원 정보 | 회원 관련 표 | 탈퇴 | 탈퇴 시 삭제 | — | [회원탈퇴 계약](account-deletion-contract.md) (기존) |
| 서버 오류 로그 | 호스팅(Render) | — | 30일 이내 | 호스팅 설정 | 코드 아님 |

- 아직 유효한 세션(만료 전·미폐기)은 종료 시각이 미래이므로 절대 삭제되지 않는다.
- **미답변 문의는 접수일 기준 3년**이다(결정 확인 필요: 기본 가정).
- 감사로그는 법정 최소 1년 미만으로 설정할 수 없다(365 미만은 서버 시작 거부). 회원이 5만 명에 가까워지면 730으로 올린다.
- 설정값은 엄격한 10진 정수만 받는다. 잘못된 값은 서버 시작을 거부하며(`common/env-validation.ts`), 오류에는 변수 이름과 범위만 나온다. `DATA_RETENTION_CLEANUP_ENABLED`(기본 `true`, 정확히 `true`/`false`)는 비상 정지 스위치다. **운영 환경변수는 설정하지 않아도 위 기본값으로 동작한다.**

## 2. 실행 방식

- 기존 Auth 유지보수 타이머(`ProfileImageCleanupWorker.tick`, 1분)가 이메일 인증 정리 바로 뒤에 `DataRetentionCleanupService.runIfDue()`를 부른다. 프로필 저장소 설정과 무관하며, 요청 경로에서는 실행하지 않는다.
- 배치 하나 = 트랜잭션 하나: `pg_try_advisory_xact_lock(hashtextextended('data-retention', 0))`(못 잡으면 다른 인스턴스가 하는 중이므로 조용히 건너뜀), `SET LOCAL lock_timeout = '100ms'`, `statement_timeout = '5s'`, 트랜잭션 제한 20초.
- 표마다 최대 500행, `FOR UPDATE SKIP LOCKED` 후보 CTE + 고정 SQL(동적 표 이름·사용자 입력 없음). 기간은 설정값 파라미터, 기준 시각은 그 트랜잭션의 DB 시각(UTC)이다.
- 한 실행에서 어느 표든 배치가 가득 차면 최대 10배치까지 이어서 돌리고, 그래도 가득 차면 다음 실행을 **1분 뒤**로 잡는다(밀린 데이터 해소). 그렇지 않으면 1시간 뒤.
- 문의: 같은 트랜잭션에서 배치의 문의 id를 잡고(문의 행 잠금) **답변을 먼저, 그다음 문의를** 지운다(두 FK 모두 RESTRICT).
- 진단 로그는 고정 이벤트와 건수만: `data_retention_completed {sessions, auditLogs, inquiries}`, 실패는 `data_retention_failed`. ID·IP·내용은 남기지 않는다. 실패한 배치는 롤백되고(앞서 커밋된 배치는 삭제된 상태로 남음) 다음 1분 tick이 다시 시도한다.

## 3. 참조·업무 로직 확인 (2026-10-21)

- `operator_audit_logs`와 `inquiry_answers`를 참조하는 FK는 없다. `inquiries`는 `inquiry_answers`만 참조한다. 푸시 등 다른 표는 문의 id를 FK로 갖지 않는다.
- `refresh_token_sessions.replaced_by_session_id`(자기참조, `ON DELETE SET NULL`): 교체 세션이 지워지면 이전 세션의 링크만 NULL이 된다. 이 열에는 **인덱스가 없어**, 세션 1행을 지울 때마다 참조 행을 찾는 순차 스캔이 한 번 돈다. 2026-10-15 운영 기준 459행이라 영향은 무시할 수준이지만, 수십만 행 규모가 되면 인덱스 추가(별도 승인)를 검토한다.
- 감사로그를 읽는 업무 코드: 기록(`OperatorAuditService.record`) 외에는 회원탈퇴의 `hasOperatorFootprint`(감사로그 actor·문의 답변자 여부)뿐이며, 멱등성·정산·중복 방지에 감사로그를 쓰는 곳은 없다. 영향: 보관기간이 지나 감사로그·답변이 삭제되면, 그것만이 운영 흔적이던 **전 운영자는 앱에서 스스로 탈퇴할 수 있게 된다**([회원탈퇴 계약](account-deletion-contract.md) §3, 결정 확인 필요).

## 4. 배포 주의

- **첫 배포 후 첫 실행(서버 시작 약 23초 뒤)에서, 이미 보관기간이 지난 과거 행이 즉시, 되돌릴 수 없게 삭제된다.** 배포 전 백업과 건수 확인은 운영자 몫이다. 2026-10-15 감사 기준 운영 DB: 세션 459행(폐기 434), 감사로그 0행, 문의 1행 → 2026-07-23 무렵 이전에 끝난 세션만 지워질 것으로 예상된다.
- 비상 정지: `DATA_RETENTION_CLEANUP_ENABLED=false`(Render 환경변수 변경은 재배포·재시작 후 반영).
- 스키마·마이그레이션 변경 없음. 이전 코드로 되돌리면 삭제가 멈출 뿐이다(이미 지운 행은 복구되지 않음).

## 5. 검증

- 단위: `pnpm exec jest src/auth/data-retention`
- PostgreSQL(일회용 loopback `*_test` DB만, CI 미포함): `DATA_RETENTION_DB_INTEGRATION=1 NODE_ENV=test DATABASE_URL=postgresql://…@127.0.0.1:…/…_test pnpm exec jest --runInBand --runTestsByPath src/auth/data-retention.integration.spec.ts` — 89/91일·364/366일·1094/1096일 경계, 유효 세션 보존, 폐기 후 90일, SET NULL, 답변→문의 순서, 500행 제한, 잠금 미획득·잠긴 행 건너뜀, 비상 정지, 한 실행의 연속 배치. 서비스가 DB 전체의 기간 경과 행을 지우므로 공유 DB에서는 돌리지 않는다.
