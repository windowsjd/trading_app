# season0 출시 및 제한 테스트 운영 계약

사용자 확정 정책(2026-10-21). **이번 변경은 구현·로컬 검증·절차 준비다. 운영 DB에 마이그레이션, 시즌 생성/전환/삭제를 실행하지 않았다. 공식 출시 날짜는 미정이다.** 실제 적용과 운영 배포는 별도 승인이 필요하다.

## 설계와 제품 정책

- 기존 `upcoming → active → ended → settled`와 lifecycle/settlement scheduler를 유지한다. `launchKind`(null/test/release)가 이름과 독립적인 출시 식별 정보다. test/release 모두 이름 `season0`, `displayBadge: "beta"`, 초기 10,000,000 KRW, 개발 시즌 수수료, **21×24시간(504시간)**, 최종 자격 **5종목 AND 인정 거래대금 3배(3,000만 원)**다. 기존 체결·FX 인정/평가·정산 계산은 그대로다. 개발 시즌 자격은 바꾸지 않는다.
- DB는 UTC 세션만 허용하며 비UTC 세션의 운영 명령은 거부한다. 앱은 기존 KST 포맷터로 표시한다. CLI는 `Z` 또는 명시적인 offset이 있는 ISO 시각을 요구한다. 준비 시 공식 날짜 기본값을 넣지 않는다.
- `suspendedAt`은 **거래·공개 조회·자동 배치에서 제외**하는 시즌 전체 표식이다. 개발 시즌 status/startAt/endAt과 금융 행을 유지한다. `rankingHiddenAt`이나 가짜 `settled`를 사용하지 않는다.
- `launchArmed` 기본 false: upcoming을 준비한 것만으로 자동 활성화하지 않는다. arm 시 개발 시즌 `tradingCutoffAt`을 출시 시작 시각으로 설정한다. 기존 Season 잠금과 잠금 후 DB 시각 검사가 해당 경계 이후 참가·신규 금융 쓰기를 거부한다. scheduler 지연 시 잠시 거래 가능 시즌이 없는 쪽으로 닫히며 개발 거래가 다시 열리지 않는다.
- 실제 전환은 기존 lifecycle 작업에서 **개발 시즌 중지/숨김 + 출시 시즌 활성화**를 동일 트랜잭션으로 처리한다. CLI와 lifecycle의 공통 DB advisory lock 및 Season 행 잠금은 기존 참가/거래/랭킹/정산 잠금과 직렬화한다. 중간 오류는 전체 롤백한다.
- `launchActivatedAt`과 원래 개발 설정 `launchSourceSnapshotJson`은 복구 소유권과 원상 검증에 사용한다. 복구는 개발 시즌 중지/예정 경계 표식만 해제한다. 설정이 달라졌거나 다른 활성 시즌이 있으면 자동 복구하지 않는다. 잔액·원장·주문·포지션을 재작성하지 않는다.
- 시작일 변경은 **upcoming, 원래 시작 이전, 미활성화, 참가/거래/랭킹 등 활동 없음**일 때만 가능하다. 새 시작도 미래여야 하며 종료는 항상 +21일이다. 다른 비공개가 아닌 시즌과 기간이 겹치면 거부한다(전환 대상 개발 시즌만 예외). arm 이후 변경은 개발 cutoff도 같은 트랜잭션에서 옮긴다. DB CHECK/trigger도 기간·출시 설정 및 시작 후 날짜 재사용을 방어한다.
- 테스트는 저장된 활성 사용자 ID 1~20개만 참가 가능하다. 일반 사용자는 `SEASON_TEST_ACCESS_DENIED`로 거부한다. 테스트 시즌의 금융/시즌 외부 push는 발행·발송 대상에서 제외한다. 실제 외부 발송/지급 흔적이 있으면 정리를 중단한다.
- 개발 초기화/seed 공통 경로는 production 또는 원격 DB에 쓰기를 거부한다. 로컬도 `/trading_app`, `*_dev`, `*_test` DB 이름만 허용한다. 출시 운영에 seed나 dev 복구 명령을 사용하지 않는다.

## 공개 API와 앱

`publicSeasonWhere`와 계정의 season 관계 필터를 공통으로 적용한다. 중지됐거나 cutoff에 도달한 시즌은 현재/목록, owned 계정, 홈, 랭킹/자격, 내 전적/최종 결과, 타인 시즌 요약/보유자산, 지갑/포트폴리오/주문/환전/보유자산, 보상/배지 목록에서 제외한다. 명시적 비공개 season/account ID 조회는 기존 not-found 계약으로 거부한다. 일반·초보 계정은 이 필터의 대상이 아니다. 운영자 진단/감사 접근은 유지한다.

기존 DTO에 선택 필드 `displayBadge?: "beta"`를 추가한다. 이름을 비교하거나 `beta`를 DB 이름에 합치지 않는다. owned 시즌에는 예정 `tradingCutoffAt`도 전달한다. 앱은 기존 계정 목록을 30초마다 갱신하고, 경계 또는 계정 목록에서 삭제된 계정을 발견하면 이전 계정 쿼리를 취소/제거하고 season/ranking/record 캐시를 reset한다. 저장된 선택을 해제하고 기존 계정 선택/참가 흐름으로 돌아간다. 서버가 최종 쓰기 권한을 판정한다.

배지는 공통 `SeasonTitle`로 홈 계정 제목, 계정 선택/전환/참가 카드, 시즌 참가(차단 상태 포함), 시즌 전적 목록/상세/수익 분석, 타인 시즌 요약, MY 시즌 배지, 시즌최종결과에 적용한다. 기존 랭킹 목록에는 시즌명 제목이 없어 새 제목을 추가하지 않는다. 회색 #565B63, 흰 글자 11, 최소 높이 20, 좌우 9, 반경 999, 간격 8. 큰 글꼴에서는 높이/줄바꿈을 허용한다. 개발·일반·초보는 metadata가 없어 표시하지 않는다.

## 운영 전 사전 확인 — 읽기 전용

1. 작업 main SHA, 실제 배포 SHA, schema migration 상태, Render 대상 workspace/service/DB를 대조한다. DB 접속 URL은 비밀 저장소로 전달하고 쉘 로그에 암호를 출력하지 않는다.
2. 운영 DB에서 아래를 읽고 별도 접근 제한된 점검 파일에 저장한다. 개발 참가자/계정/지갑/원장/주문/포지션/랭킹 건수와 자금 합계도 보존 전후 비교용으로 기록한다. 모든 금융 조회는 해당 개발 participant의 **tradingAccountId**로 제한한다.
3. 운영자 active admin/operator ID, 승인 테스트 사용자 ID, 허용 테스트 시간, 앱/API 버전, 기존 scheduler와 독립 금융 worker 구성을 확인한다.
4. 백업 식별자/완료 시각/복구 가능한 시점과 절차를 실제 대시보드에서 확인한다. 암호화된 논리 백업을 선택하면 PG17 호환 `pg_dump`를 쓰고 종료 코드/목차/접근권한을 확인한다. 기존 백업의 복구 이력이 없으면 운영 적용을 보류하고 먼저 복구 계획을 검토한다. 이 작업에서는 복구 DB나 새 클라우드 DB를 만들지 않는다.
5. Render 서비스 환경 변수는 이름과 불리언/숫자 값만 대조한다(비밀 값 출력 금지). 2026-10-20 기준 `SCHEDULER_RANKING_ENABLED`·`ENABLE_RANKING_SCHEDULER` 미설정(랭킹 자동 갱신 꺼짐), `SCHEDULER_SEASON_LIFECYCLE_ENABLED`·`SCHEDULER_SETTLEMENT_ENABLED`·`SCHEDULER_DAILY_SNAPSHOT_ENABLED`=true, `SCHEDULER_TICK_INTERVAL_MS` 미설정(60초). PITR은 Render API `GET /v1/postgres/{id}/recovery`의 `recoveryStatus`와 `startsAt`을 `--backup-ref` 근거로 기록한다.

```sql
SELECT current_setting('TimeZone') AS database_timezone, clock_timestamp();
SELECT id, name, status, start_at, end_at, initial_capital_krw,
       trade_fee_rate, fx_fee_rate FROM seasons ORDER BY start_at;
SELECT season_id, count(*) FROM season_participants GROUP BY season_id;
SELECT season_id, count(*) FROM season_rankings GROUP BY season_id;
SELECT mode, status, count(*) FROM trading_accounts GROUP BY mode, status;
SELECT job_name, expires_at FROM ops_job_locks
WHERE released_at IS NULL AND expires_at > clock_timestamp();
```

새 마이그레이션 승인·적용 후에는 `launch_kind, launch_armed, suspended_at, trading_cutoff_at, launch_activated_at`도 확인한다. 출시 행 생성/arm은 마이그레이션이나 앱 시작에서 실행하지 않는다.

보존 대조(읽기 전용, 로컬 스키마에서 실행 확인). 개발 시즌 행은 테스트 활성화 직후(cutoff 이후)와 stop/restore/cleanup apply 직전에 같아야 한다. 그 사이 개발 시즌은 동결되어 있다. 일반·초보 행은 정상 거래로 바뀌므로 `ledger_rows`가 줄지 않았는지와 cleanup 계획의 대상 계정에 포함되지 않았는지만 본다.

```sql
WITH acct AS (
  SELECT a.id, CASE WHEN a.mode = 'season' THEN 'dev_season' ELSE a.mode::text END AS grp
  FROM trading_accounts a
  LEFT JOIN season_participants p ON p.trading_account_id = a.id
  WHERE a.mode <> 'season' OR p.season_id = 'sea_2026_s1'
)
SELECT g.grp,
  (SELECT count(*) FROM acct x WHERE x.grp = g.grp) AS accounts,
  (SELECT md5(coalesce(string_agg(w.id || ':' || w.balance_amount || ':' || w.reserved_amount, ',' ORDER BY w.id), ''))
     FROM cash_wallets w JOIN acct x ON x.id = w.trading_account_id WHERE x.grp = g.grp) AS wallets_md5,
  (SELECT count(*) FROM wallet_transactions t JOIN acct x ON x.id = t.trading_account_id WHERE x.grp = g.grp) AS ledger_rows,
  (SELECT md5(coalesce(string_agg(o.id || ':' || o.status, ',' ORDER BY o.id), ''))
     FROM orders o JOIN acct x ON x.id = o.trading_account_id WHERE x.grp = g.grp) AS orders_md5,
  (SELECT md5(coalesce(string_agg(s.id || ':' || s.quantity, ',' ORDER BY s.id), ''))
     FROM positions s JOIN acct x ON x.id = s.trading_account_id WHERE x.grp = g.grp) AS positions_md5,
  (SELECT md5(coalesce(string_agg(f.id || ':' || f.status || ':' || f.quantity || ':' || f.isolated_margin, ',' ORDER BY f.id), ''))
     FROM futures_positions f JOIN acct x ON x.id = f.trading_account_id WHERE x.grp = g.grp) AS futures_md5
FROM (SELECT DISTINCT grp FROM acct) g ORDER BY g.grp;
```

Render 유료 PostgreSQL의 PITR은 복원 인스턴스를 만드는 절차다. 2026-10-20 API 조회에서 `recoveryStatus=AVAILABLE`, 복구 가능 시작 2026-10-16T23:43:38Z, 논리 export 0건이었다. 복원 연습 여부는 확인하지 않았다. [Render 백업/복구 문서](https://render.com/docs/postgresql-backups)를 기준으로 승인 전 확인한다.

## 랭킹 자동 갱신 운영 설정

2026-10-20 읽기 전용 조회 기준 운영에는 `SCHEDULER_RANKING_ENABLED`(alias `ENABLE_RANKING_SCHEDULER`)가 없어 `season_ranking_generation`이 한 번도 실행되지 않았다. 발행은 시즌 계정의 현물 체결·환전·LOC·지정가 체결 직후 이벤트 갱신에서만 생기고 5분 자산 스냅숏은 만들어지지 않는다. 출시 시즌 랭킹을 기존 1분 주기로 운영하려면 별도 승인 후 다음을 따른다.

1. Render 환경 변수 `SCHEDULER_RANKING_ENABLED=true`를 추가하고 재배포한다(환경 변수는 부팅 시 읽는다). `SCHEDULER_TICK_INTERVAL_MS`는 설정하지 않아 기본 60000을 유지한다. 테스트에서 자동 갱신을 검증하려면 테스트 활성화 전에 켠다. 켜면 현재 개발 시즌에도 분당 갱신과 5분 스냅숏이 시작된다.
2. 반영 확인(읽기 전용):

```sql
SELECT status, count(*), max(started_at), max(duration_ms) FROM ops_job_runs
WHERE job_name = 'season_ranking_generation' AND started_at > now() - interval '15 minutes' GROUP BY status;
SELECT season_id, max(captured_at) FROM season_rankings GROUP BY season_id;
SELECT count(*), max(captured_at) FROM equity_snapshots
WHERE snapshot_reason = 'scheduled' AND captured_at > now() - interval '15 minutes';
```

기대값: 분당 1건 성공(이전 실행이 길면 잠금 skip 행), 공개 활성 시즌의 `captured_at`이 1~2분 이내, 5분 구간마다 참가자당 scheduled 스냅숏 1건. 실패가 이어져도 기존 순위는 유지되므로 `error_code`로 원인을 찾는다.
3. 비용: refresh마다 참가자별 시즌 전체 스냅숏 이력을 읽는다. [측정](launch-season0-readiness-2026-10-21.md#참가자-수에-따른-비용-로컬-측정) 기준 21일차 참가자당 약 35ms(로컬 warm cache)이며 운영 PG에서는 더 느리다. `duration_ms`가 30초에 가까워지면 주기를 바꾸지 말고 별도 개선을 검토한다.

## 운영 명령의 공통 승인 경계

`backend/`에서 `pnpm run season:launch` 사용. 기본은 **READ ONLY**(RepeatableRead + `SET TRANSACTION READ ONLY`)로 감사 행도 쓰지 않는다. 모든 동작에 active admin/operator 사용자 ID가 필요하다. `--out`은 기존 파일을 덮어쓰지 않는 권한 0600 계획 파일이다. DB host/port/database/user, 요청, 관련 시즌 상태와 운영자 권한, cleanup의 행/참조 지문을 고정한다.

아래 변수는 모두 **운영자가 승인한 실제 값으로 별도 설정**한다. `START_ISO`에 예시 출시 날짜를 지정하지 않는다. `TARGET_CONFIRM`은 CLI에 출력된 `host:port/database/seasonID`를 정확히 사용한다.

```sh
# 읽기 전용 계획. 승인된 운영 접속 환경을 명시해 실행한다.
pnpm run season:launch --action prepare --season-id "$TEST_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --kind test --start-at "$TEST_START_ISO" \
  --test-user-ids "$APPROVED_TEST_USER_IDS_CSV" --out "$PREPARE_PLAN"

# 아래 apply 형태는 별도 운영 승인과 백업 확인 후에만 실행한다.
pnpm run season:launch --apply --plan "$PREPARE_PLAN" \
  --backup-ref "$VERIFIED_BACKUP_REF" --confirm "$TARGET_CONFIRM"
```

계획을 검토한 뒤 해당 **동작의 실제 운영 승인**을 받는다. `--backup-ref`는 운영자가 확인한 증거 참조이며, CLI가 백업 성공을 증명하는 값이 아니다. 계획 이후 상태/범위/권한이 바뀌면 새 dry-run과 재승인이 필요하다. cleanup apply에는 추가로 `--workers-stopped`가 필요하다. 새 plan을 apply에 섞어 전달한 `--action` 등이 아니라 **검토된 plan.request**가 대상이다. 성공 감사는 기존 `operator_audit_logs`에 같은 트랜잭션으로 기록한다.

## 개발 → 테스트 → 복구 → 정식 출시

각 동작마다 위와 같은 **독립 dry-run/out → 검토/승인 → plan apply** 순서를 따른다. 아래는 dry-run 명령이며 apply는 공통 형식으로 수행한다.

1. **배포/스키마 준비:** 별도 승인으로 서버와 추가 마이그레이션 적용, 새 앱 빌드 설치. 기존 개발 시즌 이용·잔액·주문이 유지되고 launch 행이 없음을 확인한다.
2. **검증용 신규 ID 준비:** `kind test`, 이름은 코드가 `season0`으로 고정한다. 시작은 운영자가 승인한 제한 테스트 시작 시각. 만료는 +21일이며 제한 테스트 종료 시에는 날짜를 바꾸지 않고 stop한다. 테스트와 출시 ID는 절대 재사용하지 않는다.
3. **테스트 전환 예약:** 기존 lifecycle scheduler의 `SCHEDULER_SEASON_LIFECYCLE_ENABLED`(legacy alias `ENABLE_SEASON_LIFECYCLE_SCHEDULER`)와 실제 정상 tick/lease를 확인한다. 아래 arm을 승인한다. **arm은 시작 시각부터 개발 거래를 막으므로 준비 명령보다 운영 영향이 크다.** 시작 전 취소는 disarm이다.

```sh
pnpm run season:launch --action arm --season-id "$TEST_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --out "$ARM_PLAN"
pnpm run season:launch --action disarm --season-id "$TEST_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --out "$DISARM_PLAN"
```

4. **테스트 활성화:** 기존 lifecycle이 시작 경계에 활성화한다. 늦으면 원인을 조사하고 운영자가 due 시점 `--action activate`로 새 계획을 검토해 같은 전환 함수를 실행할 수 있다. 시각 전 강제 활성화는 불가하다. dev는 status active를 유지하지만 숨김/거래 중지, test는 active인지 확인한다. 두 거래 가능 시즌이 없어야 한다.
5. **앱 실제 검증:** 승인된 계정의 참가, 별도 시즌 계정·네 지갑·초기 지급 1회, 현물/선물 주문·취소/예약·환전, 자산·수익률·랭킹·beta, 재시작/로그인/계정 전환/큰 글꼴을 확인한다. 비승인 계정의 참가 거부, 과거 개발 선택에서 복귀, 개발/일반/초보 금융 행 불변을 대조한다. 이 단계는 이번 작업에서 운영/기기로 실행하지 않았다.
6. **테스트 쓰기 중단:** `stop-test`를 승인해 숨기고 신규 쓰기를 차단한다. 기존 시즌 잠금을 보유한 작업이 끝난 뒤 stop이 커밋된다. 실제 외부 알림·지급이 발생했으면 자동 정리하지 않는다.

```sh
pnpm run season:launch --action stop-test --season-id "$TEST_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --out "$STOP_PLAN"
```

7. **worker 중단·정리:** 기존 설정을 기록하고 Ops scheduler, 금융 매칭/조건/청산/LOC worker, push 발행/발송 worker를 중단·drain한다. HTTP의 test 쓰기는 이미 stop으로 차단되어 있어야 한다. **모든 살아 있는 Ops lease가 0**인지 확인한다. 실제 끄는 방법과 한계는 [worker 중단·drain 실제 방법](#worker-중단drain-실제-방법)을 따른다. 아래 cleanup plan의 44개 테이블 건수/행 지문/참조·유지 대상을 검토한다. 예상에 없던 데이터/외부 효과/FK는 삭제하지 않고 원인을 보고한다.

```sh
pnpm run season:launch --action cleanup-test --season-id "$TEST_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --out "$CLEANUP_PLAN"
# 검토·별도 삭제 승인 후에만:
pnpm run season:launch --apply --plan "$CLEANUP_PLAN" \
  --backup-ref "$VERIFIED_BACKUP_REF" --confirm "$TARGET_CONFIRM" --workers-stopped
```

8. **개발 복구:** cleanup은 **개발 표식 복구 + test 종속 행 삭제**를 한 트랜잭션으로 처리한다. 실패하면 둘 다 롤백한다. 삭제가 외부 효과 등으로 보류되었지만 개발만 먼저 복구해야 한다면 별도 `restore-development` 계획을 승인한다. 테스트는 비공개/중지 상태로 남는다. 기존 설정이 달라졌거나 소유권/다른 활성 시즌이 충돌하면 중단한다. 개발/일반/초보 사전 금융 비교와 test 잔존 검사 후 worker를 원래 설정으로 재개한다. test ID가 이미 삭제됐으면 반복 cleanup은 not-found로 거부하며 다른 데이터는 건드리지 않는다.
9. **깨끗한 정식 출시 ID 준비:** 테스트와 다른 새 ID, `--kind release`, allowlist 없음. 공식 시각이 확정된 뒤에만 prepare한다. 시작을 아직 확정할 수 없으면 행을 만들지 말고 이 절차만 보관한다. 준비/날짜 변경만으로 개발 시즌을 중지하지 않는다.

```sh
pnpm run season:launch --action prepare --season-id "$RELEASE_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --kind release --start-at "$OFFICIAL_START_ISO" \
  --out "$RELEASE_PREPARE_PLAN"
pnpm run season:launch --action reschedule --season-id "$RELEASE_SEASON_ID" \
  --actor-user-id "$OPERATOR_USER_ID" --start-at "$NEW_OFFICIAL_START_ISO" \
  --out "$RESCHEDULE_PLAN"
```

10. **정식 예약·출시/종료 점검:** 별도 arm 승인, 기존 lifecycle/랭킹/스냅샷/정산 scheduler의 활성 설정과 heartbeat/실패 알림을 확인한다. 기존 `SCHEDULER_RANKING_ENABLED`, `SCHEDULER_DAILY_SNAPSHOT_ENABLED`, `SCHEDULER_SETTLEMENT_ENABLED`의 정책을 바꾸지 않고 실제 운영 값을 확인한다. 시작 경계 dev 숨김/거래 거부, release active·신규 참가/초기 지급을 점검한다. 종료 경계 +21일 신규 거래 거부 → 기존 미체결/예약 cleanup·선물 종료·정산·자격/최종 순위/등급 확정을 확인한다. 정산 실패는 저장 결과/랭킹 공개로 덮어쓰지 않는다. 출시 시즌의 실제 시작 후 날짜 이동·개발 복구·삭제는 이 CLI에서 지원하지 않는다.

### 장애 시 중단/복구

- 시작 이전이면 disarm 후 새 시각을 reschedule한다. 경계를 지난 upcoming을 미래 날짜로 되돌리지 않는다.
- 시작 이후 lifecycle 실패는 dev cutoff를 유지한 채 원인을 해결하고 같은 기존 lifecycle/activate 경로로 재시도한다. 수동으로 active/ended/settled를 조작하지 않는다.
- 테스트의 stop/cleanup 실패는 원장/잔액 직접 수정 없이 중단한다. cleanup 실패는 전체 롤백된다. 테스트를 중지 상태로 보관하고 필요 시 승인된 restore-development만 사용한다.
- 정식 출시 후 장애는 거래를 임의로 개발 시즌에 재개시키지 않는다. 기존 운영 장애 절차로 중단·점검하고 백업 복원은 별도 사고 대응 승인으로 수행한다.
- **코드 롤백 한계:** launch 행·개발 cutoff·중지 표식이 하나라도 생긴 뒤에는 season0 이전 백엔드로 롤백하지 않는다. 구 코드는 이 표식을 몰라 개발 시즌을 다시 공개·거래 가능하게 다루거나 활성 시즌 중복으로 lifecycle이 실패한다. 배포 후 prepare 전이면 롤백해도 안전하다.

## worker 중단·drain 실제 방법

`cleanup-test` apply는 같은 트랜잭션에서 `ops_job_locks`에 살아 있는 lease(`released_at IS NULL AND expires_at > clock_timestamp()`)가 하나라도 있으면 전체를 거부한다. lease를 잡는 구성과 끄는 방법은 다음과 같다.

| 구성 | 끄는 방법 |
| --- | --- |
| Ops scheduler tick(lifecycle·정산·일일 스냅숏·랭킹·FX·캔들 sync/long sync/reconciliation·KRX compaction) | 켜져 있는 `SCHEDULER_*_ENABLED`, `KOSCOM_CENTRAL_CANDLES_ENABLED`, `CANDLE_RECONCILIATION_*_ENABLED`를 모두 false. 하나라도 true면 tick이 등록된다 |
| 지정가 매칭(전용 interval) | `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED=false` |
| 선물 청산 risk worker | `FUTURES_RISK_ENGINE_ENABLED=false` |
| retention worker | `FUTURES_MARK_RETENTION_ENABLED=false`, `FUTURES_LAST_PRICE_RETENTION_ENABLED=false`(미설정이면 ingestion 플래그를 따라 켜짐), `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false`, `CRYPTO_ORDER_BOOK_RETENTION_ENABLED=false` |
| push 발송 | `PUSH_NOTIFICATIONS_ENABLED`(운영 미설정 = 꺼짐) |
| 조건·조건 매수·조건 매도·선물 지정가·선물 TP/SL·선물 조건 진입·LOC 정산 worker, 프로필 이미지 정리 | **끄는 환경 변수가 없다.** 공개 계정에 처리할 live 행(또는 정리 대기)이 있을 때만 tick 동안 lease를 잡는다 |

선택지(각각 별도 승인):

- **A. 서비스 중지(결정적):** Render 서비스를 suspend해 API와 모든 worker를 멈춘다. 운영자 환경에서 lease 0을 확인하고 apply한 뒤 resume한다. 그동안 앱 전체를 쓸 수 없다.
- **B. 플래그 끄기 + 재배포:** 원래 값을 기록하고 위 표의 플래그를 끈 뒤 재배포한다. 비정상 종료로 남은 스케줄러 lease는 TTL(기본 600초)까지 기다린다. 1초 worker가 그 순간 lease를 잡으면 apply가 거부·롤백되므로 다시 시도한다. 이 동안 모든 계정의 선물 청산과 retention이 멈추므로 창을 짧게 잡고 끝나면 원래 값으로 재배포한다.
- **C. 물리 삭제 보류:** `restore-development`만 승인한다. lease 조건이 없고, 테스트 시즌은 중지·비공개 상태로 데이터가 남는다. 나중에 A/B로 정리할 수 있다.


## cleanup 영향/삭제 순서와 방어

정확한 코드는 `src/seasons/launch-test-cleanup.ts`의 명시적 children-first 목록이다. `season_rewards ↔ reward_fulfillment_requests`의 기존 nullable 양방향 FK는 같은 test season의 두 포인터만 먼저 명시 해제한다. dry-run의 `detachedRewardLinks` 건수를 apply에서 대조한다. 다른 시즌 연결과 과거 processing/fulfilled 시각 흔적은 정리를 막는다. FK/trigger를 제거하거나 implicit SET NULL에 삭제를 맡기지 않는다. 실제 dry-run은 **실제 PG catalog의 모든 incoming FK(복합 키 포함)**를 조사해 대상 부모를 참조하는 범위 밖 자식이 있으면 중단한다. 알려지지 않은 새 테이블/FK도 자동 cascade 하지 않는다. 아래 그룹 순서는 실제 목록과 같다.

| 범위 | 테이블 |
| --- | --- |
| 전용 주문 설정/조건 | beginner_quest_acknowledgements(반드시 0), entry_tp_sl_plans, futures_tp_sl_settings, conditional_sell_orders, conditional_buy_orders, futures_conditional_entries |
| 보호주문 | protection_children, protection_legs → protection_groups, protection_commands |
| LOC/선물/자금 요청 | limit_on_close_orders, futures_execute_requests, futures_limit_orders, futures_liquidation_closes, futures_liquidations, futures_season_closes, futures_season_settlements, futures_executions, futures_positions, wallet_transfer_execute_requests |
| 환전/원장/현물/평가 | wallet_transfer_quotes → wallet_transfers, fx_execute_requests, general_account_resets(반드시 0), ad_reward_claims(반드시 0), wallet_transactions, exchange_transactions, orders, quotes, positions, cash_wallets, equity_snapshots, daily_portfolio_snapshots |
| 시즌 결과 | season_rankings, season_rewards, reward_fulfillment_requests, user_badges |
| 알림/배치/부모 | push_deliveries → push_notifications, 해당 seasonId 전용 batch_job_runs, futures_season_prices → season_participants → trading_accounts → seasons |

대상 계정은 target season participant에서만 얻으며 mode=season·동일 소유자·허용 테스트 사용자 일치를 검사한다. 금융 행은 account ID, 시즌 결과는 season ID로 제한한다. 알림의 계정 컬럼/JSON accountId/seasonId를 함께 추적하며 모순되는 참조나 다른 사용자 대상이면 중단한다. quote는 Season보다 먼저, 이후 Season/Account/Participant 및 outbox 잠금으로 잠금 순서를 지킨다. apply에서 row count와 지문을 재검사하고 삭제 건수가 계획과 다르면 롤백한다. 삭제 후 직접 조건 잔존 및 FK를 확인한다. 테이블당 최대 10,000행을 넘으면 이 제한 도구로 처리하지 않는다.

**삭제하지 않는 것:** 사용자, 개발·일반·초보 및 다른 시즌 계정/금융 행, 시장 종목/시세/FX/캔들 근거, 공통 Ops run/lease/worker checkpoint 및 운영자 감사 이력. 공유 실행의 JSON 진단에는 삭제한 테스트 ID가 남을 수 있으며 이는 테스트 금융 데이터가 아닌 의도적인 운영 흔적이다. 처리 중/완료된 외부 reward, push 전송/claim/delivery, 미완료 전용 batch가 있으면 자동 정리하지 않는다. `TRUNCATE`, reset, 임의 cascade, 날짜 기준 삭제를 사용하지 않는다.

## 실제 앱 검증 (Android·iOS)

beta 배지, cutoff 타이머·계정 목록 30초 갱신, `SEASON_TEST_ACCESS_DENIED` 문구는 새 앱 빌드에서만 보인다(EAS 빌드는 별도 승인). 서버 차단은 구버전 앱에도 적용된다. 승인된 테스트 계정과 비승인 계정 각 1개 이상으로 확인한다.

- season0 참가와 초기 지급 10,000,000 KRW 1회, 새 시즌 계정·지갑 4개, 기존 개발 시즌 자산 미승계
- 현물 시장가 1회 이상, 지정가 생성·취소, 환전, 선물 진입·종료
- 계정 간 격리: 일반·초보 계정 잔액/주문 불변, 개발 시즌 계정이 목록에서 사라지고 직접 접근 시 not-found
- 랭킹 자동 갱신(`SCHEDULER_RANKING_ENABLED` 켠 경우), 60초 재조회, 테스트 시즌 이름 `season0` + 회색 `beta`
- 개발 시즌 계정을 선택한 채 cutoff를 넘길 때 선택 해제와 계정 선택 화면 복귀, 앱 재시작·재로그인 후 캐시 정상
- 비승인 계정 참가 거부 문구, 테스트 종료(stop) 후 테스트 계정 숨김, 개발 복구 후 개발 계정 재표시·거래 가능
- Android/iOS 각 기본 글꼴과 큰 글꼴, Light/Dark에서 홈 제목·배지·계정 변경 버튼 겹침 없음

## 검증과 배포

후속 CI 분류·랭킹 운영 상태·재검증 결과는 [2차 보고서](launch-season0-readiness-2026-10-21.md)에 있다.

로컬 실제 PG17, 전체 단위/앱 테스트, CLI와 브라우저 레이아웃 결과 및 미검증 범위는 [검증 보고서](launch-season0-validation-2026-10-21.md)에 기록한다. CI의 기존 core-account DB 작업에도 새 DB 로컬 fixture 단계만 추가하며 클라우드 DB를 만들지 않는다.

Render는 backend/main commit 자동 배포이고 build에 `prisma migrate deploy`가 포함되어 있다. 이 변경은 `[skip render]` 커밋으로 push하며 수동 deploy/환경 변경/운영 migrate는 하지 않는다. 이 문구는 [Render의 자동 배포 건너뛰기](https://render.com/docs/deploys#skipping-an-auto-deploy)에만 적용되며 GitHub CI·수동 배포·다음 커밋의 배포를 막지 않는다. 다음 운영 배포가 이 마이그레이션을 포함한다는 점을 별도 승인에서 확인한다.
