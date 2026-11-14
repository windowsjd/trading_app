# 일반 시즌 생성·시작 운영 절차 (2026-11-14, current)

두 번째 `season0`부터 쓰는 **일반 시즌**(launch 아님) 준비 절차다. 코드: `src/seasons/scheduled-season.operations.ts`,
CLI `scripts/launch-season.ts`의 `prepare-season` / `reschedule-season` 동작, 실제 PostgreSQL 검증
`scripts/season-schedule-integration.ts`(`pnpm run integration:season-schedule`, CI core-account 작업의 별도 DB 단계).

**운영 DB에 시즌을 만들거나 시작하는 것은 이 문서의 apply 단계이며 매번 별도 승인이 필요하다.** dry run은 READ ONLY다.

## 1. 왜 launch 경로가 아닌가

- 첫 출시용 `prepare/arm` 경로(`launch-season0-operations.md`)는 **개발 시즌 `sea_2026_s1`을 같은 트랜잭션에서 중지하며 넘기는
  전환** 전용이다. DB CHECK `seasons_launch_policy_check`가 launch 행(`launch_kind` test/release)에 정확히 504시간(21일),
  이름 `season0`, 10,000,000원, 5종목·3배를 강제하고, 활성화는 개발 시즌의 `tradingCutoffAt`이 시작 시각과 같아야 한다.
  개발 시즌은 2026-10-24 출시 때 이미 중지(`suspended_at`)되어 이 전환을 다시 할 수 없다.
- 그래서 이후 시즌은 `launch_kind = NULL`인 **일반 시즌**으로 만든다. CHECK의 일반 분기에는 기간 제한이 없고, 기존 lifecycle
  작업이 `upcoming → active`(시작 시각, 분당 tick) → `ended`(종료 시각) 전환을 이미 지원한다. 참가·초기 지급·랭킹·정산·최종 결과는
  모두 시즌 ID 기준 기존 경로 그대로다. **DB 스키마·마이그레이션·API·정산/랭킹 산식은 바꾸지 않았다.**
- 결과: 21일 고정은 launch 행에만 적용된다. 이번 시즌의 16일(2026-11-14~11-29)은 운영자가 정한 기간 그대로이며 12월로
  늘리지 않는다. 기존 launch 계약·검증은 우회하거나 완화하지 않았다.
- `displayBadge`(beta)는 기존 정책대로 launch 행에만 붙는다. 일반 시즌에는 붙지 않는다(이름이 같아도).

## 2. 날짜 규칙 (Asia/Seoul)

- 운영자는 **첫 운영일·마지막 운영일(KST, 양끝 포함)** 과 정확한 시작 시각을 준다. 종료 경계 `endAt`은 입력받지 않고
  **마지막 운영일 다음날 00:00 KST**로 계산한다(배타적 경계: `now < endAt`일 때만 거래). 9시간 밀린 값이 들어갈 수 없다.
- `--start-at`은 `Z` 또는 명시 offset이 있는 ISO 시각만 받고, KST 날짜가 `--first-day-kst`와 다르면 거부한다.
  DB 시각 기준으로 미래가 아니면 거부한다(**소급 등록 없음**). 그래서 적용 시점이 11-15 이후면 11-14 시작 계획은 자동으로
  거부되고, 운영자가 날짜를 바꾸지 않는 한 진행되지 않는다.
- DB 세션은 UTC여야 한다(`seasonDatabaseNow`가 확인). 저장은 UTC instant, 앱은 고정 KST 포맷터로 표시한다.
- 앱 홈 상단 표시(`2026.11.14 ~ 2026.11.29`) = `startAt`의 KST 날짜 ~ (`endAt − 1ms`)의 KST 날짜. plan의
  `schedule.appDisplay`가 같은 규칙으로 미리 보여 준다.

## 3. 검증(코드가 거부하는 것)

새 ID(형식 3–64자, 개발 시즌 ID 불가, 기존 시즌·기존 감사 기록에 없는 ID), 이름 1–40자, 초기자본 양수, 최소 종목 ≥ 1,
최소 거래대금 배수 > 0(소수 4자리), 수수료 원본 시즌 존재(수수료는 **입력하지 않고 복사**), 시작이 승인된 첫날·미래,
마지막날 ≥ 첫날, 366일 이하, armed launch 없음, **중지되지 않은 upcoming/active 시즌과 기간이 겹치지 않음**(개발 시즌 포함).
같은 계획의 재적용·동시 적용은 공통 advisory lock + plan 지문으로 하나만 성공한다. 일반 사용자 API에는 생성 경로가 없다
(CLI + active admin/operator ID 필요). 시즌 생성은 아무에게도 자금을 주지 않는다(참가 시 1회 지급).

`reschedule-season`: 이 도구로 만든(감사 `launch_season.prepare-season`) upcoming 일반 시즌만, 원래 시작 전,
참가·랭킹·보상 등 활동 0건일 때만 시작/종료를 옮긴다. 이름·자본·수수료·자격은 그대로.

## 4. 이번 시즌 설정 (사용자 확정)

| 항목 | 값 |
| --- | --- |
| 시즌 ID(제안) | `sea_2026_s0_20261114` (새 ID, `sea_2026_s0_release` 재사용 금지) |
| 이름 | `season0` |
| 운영 기간 | 2026-11-14 ~ 2026-11-29 KST (16일) |
| 시작 | 2026-11-14 중 운영자가 정한 미래 시각(예: 20:00 KST = 11:00Z) |
| 종료 경계 | 2026-11-30 00:00 KST = 2026-11-29T15:00:00Z (자동 계산) |
| 초기 가상자본 | 10,000,000 KRW |
| 최종 랭킹 자격 | 서로 다른 5종목 AND 인정 거래대금 300% (`--min-turnover-ratio 3`) |
| 수수료 | `sea_2026_s0_release`에서 복사 (0.001 / 0.001) |

## 5. 명령 (backend/에서)

`.env.local`이 운영 DB를 가리키므로 아래 명령은 운영 대상이다. dry run은 READ ONLY 트랜잭션이며 `PGOPTIONS`로 세션도
읽기 전용으로 고정한다. 계획 파일은 덮어쓰지 않고(0600) 운영자만 읽는 곳에 둔다.

```sh
# 1) 읽기 전용 계획 (감사 행도 쓰지 않음)
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000' \
pnpm run season:launch --action prepare-season --season-id sea_2026_s0_20261114 \
  --actor-user-id "$OPERATOR_USER_ID" --name season0 \
  --start-at 2026-11-14T20:00:00+09:00 --first-day-kst 2026-11-14 --last-day-kst 2026-11-29 \
  --initial-capital-krw 10000000 --min-traded-instruments 5 --min-turnover-ratio 3 \
  --fee-source-season-id sea_2026_s0_release --out "$PLAN"

# 2) 검토: inspection.preview.schedule(startAtKst/endAtKst/appDisplay), season(자본·자격),
#    feeSource, before(겹치는 upcoming/active 없음, armed 없음)

# 3) 별도 승인 후에만 (계획 이후 상태가 바뀌면 지문 불일치로 거부 → 새 계획)
pnpm run season:launch --apply --plan "$PLAN" --backup-ref "$VERIFIED_BACKUP_REF" \
  --confirm "<CLI가 출력한 host:port/database>/sea_2026_s0_20261114"
```

시작 시각이 계획보다 늦어져야 하면(아직 시작 전·활동 0건): `--action reschedule-season --season-id … --start-at …
--first-day-kst … --last-day-kst …`로 새 계획 → 승인 → apply. 시작이 지난 시즌의 날짜는 바꾸지 않는다.

## 6. 적용 후 확인 (읽기 전용)

```sql
SELECT id, name, status, start_at, end_at, launch_kind, launch_armed, suspended_at, trading_cutoff_at,
       initial_capital_krw, trade_fee_rate, fx_fee_rate,
       final_ranking_min_traded_instruments, final_ranking_min_turnover_ratio
FROM seasons ORDER BY start_at;                                   -- 새 행 upcoming, 기존 행 불변
SELECT action, target_id, created_at FROM operator_audit_logs
WHERE target_type = 'launch_season' ORDER BY created_at DESC LIMIT 3;  -- launch_season.prepare-season
-- 시작 1~2분 후: lifecycle이 활성화했는지
SELECT status, count(*), max(started_at) FROM ops_job_runs
WHERE job_name = 'season_lifecycle_transition' AND started_at > now() - interval '10 minutes' GROUP BY status;
SELECT id, status FROM seasons WHERE id = 'sea_2026_s0_20261114';  -- active
-- 첫 참가 후: 계정 1개, 지갑 4개, initial_grant 1건 10,000,000
```

(`ops_job_*`·`seasons` 타임스탬프 열은 timezone 없는 UTC 값이다. node `pg`로 읽을 때는 `TZ=UTC`로 실행해야 9시간 어긋나
보이지 않는다.) 공개 API `GET /api/v1/seasons/current`도 `effectiveMode: upcoming → active`로 바뀐다.

앱: 기존 앱은 `다음시즌이 곧 시작됩니다`를 60초마다 다시 확인하다 활성화 후 `시즌참가하기`로 바뀐다. 지난 시즌 결과를 아직
보지 않은 사용자는 계정 선택에서 `시즌결과 확인하기`가 먼저 보인다(기존 정책) — 참가는 계정 시트·랭킹 탭에서도 가능하다.

## 7. 종료·정산

종료 경계(11-30 00:00 KST) 다음 tick에 lifecycle이 `ended`, 같은/다음 tick에 정산 작업이 자격 판정 → 선물 최종 종료 →
평가 → 최종 순위(적격자만) → `settled`. 이 경로는 바뀌지 않았다. 확인: `seasons.status = settled`, `season_rankings`의
final 행 = 적격자 수, 시즌 계정 전원 `closed`, 앱 최종 결과(`/records/me/seasons/:id/final-result`).

## 8. 실패 시

- 시작 전: `reschedule-season`(활동 0건일 때). 행 삭제 도구는 만들지 않았다.
- 시작 후 lifecycle 실패: 원인을 고치고 기존 lifecycle로 재시도한다. status를 수동으로 바꾸지 않는다.
- 이전 시즌(`sea_2026_s0_release`)은 어떤 동작도 건드리지 않는다. 새 시즌의 생성·활성화·정산은 이전 시즌의 정산 상태와 독립이다.
