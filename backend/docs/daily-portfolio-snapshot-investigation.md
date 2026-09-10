# DailyPortfolioSnapshot 생성 경로 조사 및 수정 (2026-09-10)

## 1. Git 상태

- 시작 branch: `main`
- 시작 HEAD: `a1b1ebbbf03347af65545a69b91757783391c78e`
- 시작 `git status --short --branch`: `## main...origin/main`
- staged / unstaged / untracked: 모두 없음.
- `git fetch origin` 완료. 최초 sandbox의 `.git/FETCH_HEAD` 쓰기 차단 후 승인된 fetch로 확인.
- fetch 후 `origin/main` SHA도 위와 같고 `git rev-list --left-right --count HEAD...origin/main`은 `0 0`.
- 따라서 조사 시작 시 로컬 tracked 코드와 GitHub main은 동일했다. Render가 실제 배포한 SHA까지 확인한 것은 아니다.
- 수정은 로컬 working tree에만 있다. commit, push, Render 배포, DB 수정은 하지 않았다.

## 2. 조사한 실행 구조

저장소 전체에서 `DailyPortfolioSnapshot`, `dailyPortfolioSnapshot`, `daily_portfolio_snapshots`를 검색했다. generated·test·문서의 존재와 실제 호출 경로를 구분했다.

| 분류 | 실제 파일 및 의미 |
| --- | --- |
| 시즌 production writer | `src/batch/daily-portfolio-snapshot-job.service.ts`: participant/date 사전 조회 후 `create`. `src/portfolio/daily-portfolio-snapshot-generation.ts`의 data builder 재사용 |
| 일반 production writer | `src/batch/general-daily-snapshot-job.service.ts`: 계정 transaction 안에서 scheduled EquitySnapshot → DailyPortfolioSnapshot 순으로 `create` |
| 별도 수동 writer | `scripts/admin-generate-daily-portfolio-snapshot.ts` → `writeDailyPortfolioSnapshot`: participant/date `upsert`. 자동 스케줄러는 이 덮어쓰기 경로를 호출하지 않음 |
| Home daily reader | frontend Home → `features/tradingAccount/api.ts` → `/api/v1/trading-accounts/:accountId/portfolio/equity?range=30d&granularity=daily` → `TradingAccountPortfolioService.findDailyPoints` |
| legacy Home reader | `src/home/home.service.ts`의 `buildEquityChart`: 일별 row만 읽음. legacy 응답의 없는 이력은 unavailable이며 account daily endpoint의 empty와 구분 |
| Portfolio reader | `src/portfolio/trading-account-portfolio.service.ts`: explicit daily는 일별 row만. non-daily 일반 장기 범위는 daily 우선/Equity fallback, 시즌 non-daily는 Equity. `src/portfolio/portfolio.service.ts`에도 legacy daily 우선/Equity fallback 경로 존재 |
| Records reader | `src/records/records.service.ts`: 참가자별 최신 daily relation, 시즌 equity pagination, 기록 상세·MDD용 snapshot history |
| 수동 Ranking reader | `src/batch/season-ranking-job.service.ts`: 해당 날짜 daily 및 과거 daily history. `scripts/admin-generate-season-ranking.ts`도 daily 조회. 현재 실시간 `RankingRefreshService`는 별도 valuation + Equity history 경로 |
| Settlement reader | `src/batch/season-settlement-job.service.ts`: valuation service가 주입되지 않은 경우에만 daily fallback. 실제 BatchModule은 valuation service를 주입 |
| 실행 계층 | AppModule → OpsModule → 기존 OpsScheduler/OpsJobRunner. BatchModule은 두 daily service와 cycle을 provider/export로 등록 |
| CLI 실행 | `src/batch/batch-admin-runner.ts`: season daily, general daily, daily-season-cycle 분기. operator HTTP에서 daily job을 직접 호출하는 production 경로는 검색되지 않음 |
| cycle | `src/batch/daily-season-cycle-job.service.ts`: daily batch 후 season ranking batch. 실제 호출은 batch-admin-runner이며 OpsScheduler의 daily 경로가 아님 |
| migration | `prisma/migrations/20260507121528_add_daily_portfolio_snapshot_and_ranking_foundation/migration.sql`: 최초 테이블/participant unique. `20260803211000_add_general_performance_snapshot_foundation/migration.sql`: account scope·TWR 필드·account/date unique·기존 scope backfill |
| repair/audit | `scripts/repair-snapshot-scope.ts`, `scripts/lib/repair-snapshot-scope.ts`: 기존 scope 복구. `scripts/lib/repair-ranking-scope.ts`, `scripts/lib/audit-general-accounts.ts`: snapshot 참조/audit. 새로운 일별 이력을 자동 생성하는 경로가 아님 |
| scope/계산 보조 | `season-snapshot-scope.ts`, `general-history-integrity.ts`, `general-performance.policy.ts`: 타입·검증·계산. `general-account-performance.service.ts`는 일반 성과 값을 계산하고 Equity writer를 제공하지만 daily row 자체 writer는 batch에 있음. `general-accounts.service.ts`의 daily 언급은 주석 |
| generated/test | `src/generated/prisma`의 model/client/namespace/CRUD 타입은 실행 트리거가 아님. batch/ops/portfolio/home/records/ranking/settlement spec, `test/app.e2e-spec.ts`, DB opt-in integration 및 frontend Home 계약 테스트는 검증 코드 |
| 문서 | README, HANDOVER, batch/scheduler/policy/trading-modes 문서, home/records/ranking/orders/trading-account-finance/general-account API 계약, frontend `docs/home-equity-ledger-review.md` |

## 3. 변경 전 시즌 생성 흐름

`OpsScheduler.runEnabledJobs` → daily flag 확인 → env seasonId + timezone business date → `OpsJobRunner.runDailyPortfolioSnapshotJob` → Ops lock/audit → `DailyPortfolioSnapshotJobService.run` → BatchService → active participant 조회 → valuation → daily create.

- runner는 seasonId 또는 snapshotDate가 없으면 `NOT_CONFIGURED` skipped를 기록하고 writer를 호출하지 않았다.
- scheduler는 기본 60초마다 같은 날짜를 전달했다. timezone 기본은 `Asia/Seoul`; DB `snapshotDate`는 날짜를 담는 `@db.Date`, 파싱은 UTC midnight이다. `capturedAt`은 실제 시각이다.
- batch 자체는 `active` 또는 `ended` 시즌을 허용하고, `participantStatus=active`만 처리한다. 시즌 선택은 기존 scheduler에서 env 고정 ID였다.
- 기본 batch 키는 `daily-portfolio-snapshot:<seasonId>:<YYYY-MM-DD>`.
- 성공한 batch 키는 재실행 시 응답만 재생한다. 참여자 평가 실패를 result에 담아 전체 batch가 succeeded가 될 수 있어, 그날 첫 실행에서 누락된 participant가 이후 tick에서 재평가되지 않았다. 첫 실행 후 참가한 계정도 같은 문제가 있다.
- batch 자체가 failed이면 동일 키 재시도는 `BATCH_JOB_RETRY_REQUIRES_NEW_IDEMPOTENCY_KEY`로 거절한다. 기존 runner는 새 키를 전달하지 않았다.
- DB participant/date 및 account/date unique와 `P2002` 처리는 중복 row를 방지한다. batch writer는 기존 row를 덮어쓰지 않는다. 별도 admin upsert helper와 구분해야 한다.

## 4. 변경 전 일반계정 생성 흐름

`batch-admin-runner`의 `general-account-daily-snapshot` 분기 → GeneralDailySnapshotJobService → BatchService → 계정별 transaction.

- 서비스는 구현·등록·export되어 있었지만 OpsJobRunner 주입/호출과 OpsScheduler 호출이 없었다. production에서는 명시적 CLI 실행만 가능했다.
- `mode=general`, `status in [active,suspended]`; closed는 제외하고 개수를 기록한다.
- 계정 row `FOR UPDATE` 후 DB에서 계정을 다시 읽어 mode/status/participant와 금융·성과 연속성을 검증한다. 처리 도중 closed가 된 계정도 쓰지 않는다.
- 실제 lock 획득 후 capturedAt을 결정하고 기존 valuation/TWR 계산을 사용한다.
- scheduled EquitySnapshot과 daily row를 하나의 transaction에서 기록한다. 두 행의 금액·capturedAt은 같은 계산에서 나온다. daily unique 충돌 시 transaction 전체가 rollback되어 중복 Equity도 남지 않는다.
- 일반 daily의 participant는 null이고 accountId가 소유 scope다. 기본 batch 키는 `general-account-daily-snapshot:<YYYY-MM-DD>`.

## 5. 실제 확인한 원인과 환경변수

코드로 확정한 자동 생성 누락: **일반계정 자동 호출 누락**, **daily flag의 scheduler 활성화 OR 조건 누락**, **시즌 고정 ID가 없으면 skipped**, **날짜 batch 키 때문에 당일 누락분 재시도 불가**.

실행 환경의 모든 조건을 확인했다고 주장하지 않는다. AppModule과 같은 `.env.local` → `.env.development` → `.env` 우선순위로 로컬 비밀이 아닌 scheduler 설정만 읽었으며 daily 활성화 flag와 seasonId는 없었다. 따라서 이 로컬 설정으로는 기존 daily 자동 생성이 켜지지 않는다. Render env·로그는 미조회다.

| 변수 | 기본값 / 미설정 동작 | 사용 위치 / 변경 의미 |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | false | `ops-config.ts`, scheduler `onModuleInit/runEnabledJobs`. true만으로 개별 daily flag까지 켜지지는 않음 |
| `SCHEDULER_DAILY_SNAPSHOT_ENABLED` | false | 변경 전 job flag만 true여도 scheduler 자체는 활성화되지 않음. 변경 후 이 flag 단독으로 기존 scheduler 및 season/general daily 활성화 |
| `SCHEDULER_DAILY_SNAPSHOT_SEASON_ID` | 없음 | 기존: runner NOT_CONFIGURED. 변경 후: 선택 필터, 없으면 기간 내 모든 active 시즌. general에는 영향 없음 |
| `SCHEDULER_TIMEZONE` | Asia/Seoul | business date 및 scheduled capture 날짜 검증. 유효하지 않은 IANA timezone은 오류 |
| `SCHEDULER_TICK_INTERVAL_MS` | 60000 | 없거나 양의 정수가 아니면 `RANKING_REFRESH_INTERVAL_SECONDS ?? SEASON_SETTLEMENT_INTERVAL_SECONDS`의 양의 값×1000, 그것도 없으면 60000 |
| `SCHEDULER_LOCK_TTL_SECONDS` | 600 | 기존 OpsJobLock TTL, crash 후 만료되면 다음 tick 획득 가능 |
| `SCHEDULER_MAX_ATTEMPTS` | 1 | Ops audit의 maxAttempts 메타데이터. 이것만 늘린다고 BatchService 동일 키 실패를 자동 재실행하지 않음 |
| ranking/lifecycle/settlement flags 및 `ENABLE_*_SCHEDULER` alias | false | 기존부터 scheduler 활성화 OR에 포함. lifecycle은 active 상태 전이에 간접 영향. 이번 작업에서 정책 변경 없음 |
| `SCHEDULER_PROVIDER_FX_ENABLED`, `...BINANCE_ENABLED`, `...KIS_ENABLED` 및 KIS alias | false | upstream 가격/환율 자동 수집. daily writer를 직접 호출하는 flag가 아님. 기존부터 scheduler 활성화 OR에 포함 |
| `SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS`, `...BINANCE_INTERVAL_SECONDS`, `...KIS_INTERVAL_SECONDS` | 3600, 60, 60 | upstream 수집 간격 |
| `SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP` | false | upstream 시작 수집. daily에는 별도 시작 즉시 실행 옵션이 없음 |
| `SCHEDULER_PROVIDER_TARGET_SOURCE` | merged | active assets와 env symbol 목록을 합침. 가격 자료 coverage에 간접 영향 |
| `SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS` | `PROVIDER_INGESTION_MAX_SNAPSHOTS` 또는 500 | upstream 수집량. `KIS_PRICE_INGESTION_MODE` 기본 websocket_trade |
| `PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS`, `PROVIDER_ASSET_PRICE_QUOTE_FRESHNESS_SECONDS` | 300, 60 | `source-eligibility.policy.ts`: 시즌 daily workflow에 적용되는 freshness |
| `PROVIDER_FX_RATE_DISPLAY_FRESHNESS_SECONDS`, `PROVIDER_ASSET_PRICE_DISPLAY_FRESHNESS_SECONDS` | 7200, 300 | 기존 일반 성과 계산의 home_live_valuation workflow에 적용 |
| `DATABASE_URL` | 필요 | Prisma/DB 접근. 값을 출력하거나 변경하지 않음 |

추가 upstream 의존성은 `providers/provider-config.service.ts`의 `PROVIDER_INGESTION_ENABLED`, `EXCHANGE_RATE_API_ENABLED`, `KOREA_EXIM_EXCHANGE_ENABLED`, `BINANCE_PUBLIC_MARKET_DATA_ENABLED`, `KIS_MARKET_DATA_ENABLED` 및 provider별 인증·endpoint·symbol·WebSocket 설정이다. 이는 provider 수집을 제어하며 daily batch는 외부 API를 직접 호출하지 않고 저장된 적격 가격/환율을 읽는다. 기존 market-aware 가격 선택과 안전한 admin_manual fallback 정책은 유지했다. KRW 현금만 있고 USD 자산이 없는 계정에는 FX 자료가 필요 없다.

`SCHEDULER_ENABLED=false`는 기존부터 전역 kill switch가 아니다. ranking/provider 등 enabling flag가 true이면 켜졌으며, 이번 수정은 daily도 그 OR에 포함한다. 모든 개별 flag가 동일하게 작동했던 것은 아니다(reward marker만 켜서는 활성화되지 않음).

## 6. 원인 분류

| 분류 | 판단 |
| --- | --- |
| A 코드 | 확정: general scheduler/runner wiring 누락, daily 활성화 OR 누락, 고정 seasonId 의존, 같은 날짜 누락분 재시도 막힘 |
| B 환경설정 | 로컬 daily flag 미설정은 확인. Render 누락 여부는 미확인. 수정 후에도 flag를 명시적으로 켜야 함 |
| C 데이터 이전 | DB 내용·이전 이력을 확인하지 않았으므로 증거 없음. 원인으로 단정하지 않음 |
| D 운영 파이프라인 | 확정: 일반 daily는 수동 batch까지만 완성되어 있었음. 기존 Ops 경로에 연결함 |

## 7. 수정한 파일과 이유

- `src/ops/ops-config.ts`: daily flag를 scheduler 활성화 조건에 포함.
- `src/ops/ops-scheduler.service.ts`: 기존 tick에서 season/general sweep 호출; 같은 프로세스의 겹치는 sweep 방지 및 실패 후 guard 해제.
- `src/ops/ops-job-runner.service.ts`: GeneralDailySnapshotJobService 필수 주입, 일반 Ops 실행 연결, 기존 active 시즌 선택 패턴으로 복수 시즌 처리, attempt별 새 batch 키 전달, 부분 실패 Ops 기록.
- `src/batch/daily-portfolio-snapshot-job.service.ts`, `general-daily-snapshot-job.service.ts`: scheduled capture가 요청 business day와 다른 경우 쓰지 않는 날짜 guard. 기존 valuation·TWR·transaction·unique 의미 유지.
- 두 daily `*.types.ts`: 내부 scheduler용 선택적 timezone 인자. HTTP API 변경 없음.
- 대응 `ops-config`, `ops-scheduler`, `ops-job-runner`, 두 daily service의 `*.spec.ts`: 연결·재시도·늦은 계정 생성·scope·자정 경계 검증 추가.
- `.env.example`, `docs/scheduler-ops-foundation.md`, 이 조사 문서: 활성화와 운영 절차, 원인/검증 범위 명시.

금융 writer(주문/환전/지갑/포지션), RankingRefreshService, SeasonRanking schema/enum, 정산 주 경로, frontend/API 코드는 수정하지 않았다.

## 8. 변경 후 실제 실행 흐름

기존 AppModule/BatchModule/OpsModule DI → 기존 interval → provider 수집 → daily flag → `runScheduledDailySnapshotJobs` → dispatch 시점 실제 날짜 결정 → general Ops lock/batch → 기간 내 활성 시즌 조회 → 각 시즌의 기존 daily Ops lock/batch.

general lock은 `daily_portfolio_snapshot:general:<date>`, 시즌은 기존 `daily_portfolio_snapshot:<seasonId>:<date>`다. Ops enum 추가 없이 batch jobName으로도 구분된다.

각 tick은 `<기존 batch job>:<scope/date>:<attempt UUID>`를 사용한다. batch 키는 시도 식별, 기존 DB unique는 계정/날짜 중복 방지를 담당한다. 이미 있는 row는 읽고 건너뛰며 실패 계정/새 계정만 실제 계산한다. 부분 실패는 Ops failed + 결과 요약으로 남고 다음 tick에서 재시도한다. DB 장애로 lock/audit 생성부터 실패하면 tick이 실패하고 다음 tick에서 다시 시도한다. 재시작 후에도 같은 DB unique가 유지된다.

첫 row는 그날 최초로 성공한 실제 capture다. 종가나 하루 마지막 값으로 덮어쓰는 정책이 아니다. 휴일도 계정은 대상으로 삼되 valuation의 기존 적격 가격 정책을 따른다. 과거 빈 날짜를 순회하거나 복제·보간하지 않는다.

## 9. DB 조회 결과

실행 환경의 DATABASE_URL은 loopback(localhost/127.0.0.1/::1) 주소가 아니었다. 안전하게 로컬 개발 DB로 확인할 수 없어 연결 전 중단했다(`DB_NOT_LOCAL: skipped`). 요청한 count/최근 30개/Equity 비교 SELECT는 실제 실행하지 못했다. credential 변경, Render DB 수정, migration/seed/repair 실행은 없었다.

배포 뒤 확인할 read-only SQL:

```sql
BEGIN READ ONLY;
SELECT COUNT(*) FROM daily_portfolio_snapshots;
SELECT snapshot_date, trading_account_id, season_participant_id,
       total_asset_krw, captured_at
FROM daily_portfolio_snapshots
ORDER BY snapshot_date DESC LIMIT 30;
SELECT job_name, status, started_at, error_code, result_json
FROM ops_job_runs
WHERE job_name = 'daily_portfolio_snapshot'
ORDER BY started_at DESC LIMIT 10;
ROLLBACK;
```

## 10. 실행한 테스트와 결과

| 검증 | 결과 |
| --- | --- |
| backend `pnpm test --runInBand` | 188 suites / 2,663 tests 통과, opt-in 36 suites / 40 tests skipped |
| 마지막 추가한 interval 등록/겹침 guard 테스트 포함 scheduler 재실행 | 35 tests 통과 (위 전체 실행 이후 2개 추가) |
| backend `pnpm test:e2e --runInBand` | 126 tests 통과. Prisma mock을 사용하는 API E2E이며 실제 DB integration과 구분 |
| backend `pnpm build` | 통과 |
| backend `pnpm exec tsc --noEmit -p tsconfig.build.json` | 통과 |
| frontend `npm test` | Node test runner 기준 55 files 통과 |
| `git diff --check` | 통과 |

검증 범위에는 두 writer의 정상 생성, 동일 날짜 기존 row/P2002 처리, general closed 및 처리 중 close 제외, participant/account scope, 신규 계정의 당일 후속 capture, 자정 경계, active 복수 시즌, general의 시즌 독립성, batch 오류·부분 실패 재시도, daily API 빈 상태/정확한 daily 값/no Equity fallback, Portfolio non-daily fallback, 기존 ranking/settlement 경로가 포함된다.

실제 PostgreSQL unique 경쟁·transaction rollback은 기존 opt-in integration 코드가 있지만 이번에는 실행하지 않았다. 사용 중인 DB에 테스트 데이터를 쓰지 않았다.

## 11. git diff 요약

backend 15개 파일만 수정/추가. production 변경은 기존 Ops 연결, batch 인자/날짜 guard에 한정했다. diff를 직접 검토했다. generated Prisma, schema, migration 추가/수정 없음. 새 scheduler/queue/worker/분산락 없음. 기존 lock과 unique 재사용. Home source·랭킹·정산·금융 writer의 정책 변경 없음.

## 12. Render 추가 작업

수정 코드를 GitHub에 commit/push하고 해당 SHA가 배포되도록 해야 한다. 이 작업에서는 push/배포하지 않았다. 배포 환경에 다음을 설정하고 서비스 프로세스를 재시작하는 배포를 수행한다.

```dotenv
SCHEDULER_DAILY_SNAPSHOT_ENABLED=true
SCHEDULER_TIMEZONE=Asia/Seoul
SCHEDULER_TICK_INTERVAL_MS=60000
```

`SCHEDULER_ENABLED=true`도 명시할 수 있지만 수정 후 daily flag만으로 활성화된다. `SCHEDULER_DAILY_SNAPSHOT_SEASON_ID`는 특정 시즌 제한이 필요하지 않으면 비워두거나 제거한다. 이 설정만으로 일반계정도 함께 처리한다. 신규 schema migration은 필요 없다.

프로세스 시작 뒤 첫 tick(기본 약 60초 + 선행 provider 수집/DB 처리 시간)에서 오늘 row를 만들 수 있다. 적격 가격/환율·정상 계정 scope/성과 baseline이 필요하며 실패 원인은 Ops 결과와 batch result.errors에서 확인한다. 오늘부터 실제 데이터가 쌓이므로 즉시 30일 이력이 생기는 것은 아니다.

## 13. 남은 위험과 미확인 사항

- Render의 실제 env, 실행 SHA, scheduler 로그, DB row 및 데이터 이전 여부는 확인하지 않았다. 따라서 운영 화면이 이미 복구됐다고 주장하지 않는다.
- daily flag를 켜지 않거나 서비스가 실행되지 않는 시간에는 생성되지 않는다. 서버가 하루 종일 중단됐던 날짜를 만들어 채우지 않는다.
- 기존 가격/환율 freshness, 잘못된 account link, 일반 성과 baseline/원장 무결성 문제는 계정별 실패로 남는다. 이번 연결 수정은 그런 데이터를 임의 복구하지 않는다.
- Home daily 날짜 범위는 기존 Asia/Seoul 기준이다. 배포 timezone도 Asia/Seoul로 유지해야 한다.
- 매 tick에서 기존 row 존재 여부를 확인하므로 계정 수에 비례하는 read와 scope별 Ops/batch audit가 발생한다. 기존 가상 앱 구조를 재사용했고 별도 큐/스케줄러를 도입하지 않았다.
- 과거 수동 admin upsert와 명시적 날짜 CLI는 기존 도구로 남아 있다. 이번 자동 경로는 이 upsert를 쓰지 않으며, 누락된 과거 날짜를 현재 값으로 생성하는 운영 복구는 수행하지 않았다.
