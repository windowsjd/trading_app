# 2026-09-24 R09 잔여 / R10 / R11 완료 검증

저장소 범위의 R09/R10/R11 수정과 로컬 회귀 검증을 완료했다. Hosted CI는 미확인이다. 과거 [2026-09-22 감사](../2026-09-22-flow-audit/report.md)는 당시 증거로 보존한다.

## 1. 작업 기준

- 시작 HEAD: `445be583b53addc27fccd41ebed14a1a6278ec38` (`R04지정가 체결문제`). 시작 working tree clean.
- 최종 원본 HEAD: `3663dc0e1fcf34989eaca80c465817a3cbbd717b` (`r08 FX O(E²) + r09 scheduler/job lease ownership 작업`). 작업 중 외부 commit-message amend가 관찰됐다. 시작 HEAD와 tree hash가 완전히 같으며 이 변경을 보존했다. 검증 대상 파일 내용에는 영향이 없다.
- 원본 저장소에는 아래 변경을 미커밋 상태로 남겼다. 이 작업에서는 원본 branch의 commit/stage/push를 수행하지 않았다.
- 수정본 검증 commit: `3ab39a026bb85d647a071bf3567f33ed3a7c9ad1`. `/tmp/trading-final-audit/verify`에서만 만든 로컬 commit이며 GitHub commit이라고 주장하지 않는다.
- 이 commit의 **새 clone** `/tmp/trading-final-audit/final-clean`에서 frozen install/generate/clean-tree/release smoke를 실행했다. 18개 backend 변경 파일은 원본 working tree와 검증 commit이 byte-for-byte 동일하다. 파일별 SHA-256, 명령/exit code는 [validation.json](validation.json)에 보관한다.
- 아래 완료 증거 4개는 검증 후 추가한 자료이며 실행 대상 code/config를 바꾸지 않는다.

변경 파일(루트 기준):

| 범위 | 파일 |
|---|---|
| R09 production | `backend/src/ops/ops-job-runner.service.ts`, `backend/src/batch/season-lifecycle-transition-job.service.ts`, `backend/src/batch/season-lifecycle-transition-job.types.ts`, `backend/src/orders/limit-order-cancel.service.ts` |
| R09 tests | `backend/src/batch/season-lifecycle-transition-job.service.spec.ts`, `backend/src/orders/limit-order-cancel.service.spec.ts`, `backend/src/ops/ops-job-lock.integration.spec.ts`, `backend/scripts/ops-lease-integration.ts`, 신규 `backend/scripts/season-lifecycle-lease-integration.ts` |
| R10 generated | `backend/src/generated/prisma/internal/class.ts` |
| R10/R11 docs | `backend/AGENTS.md`, `backend/README.md`, `backend/docs/README.md`, `backend/docs/codex-rulepack.md`, `backend/docs/orders-api-contract.md`, `backend/docs/policy-decisions.md`, `backend/docs/scheduler-ops-foundation.md`, `backend/docs/trading-modes-and-accounts.md` |
| 완료 증거 | 이 디렉터리의 `report.md`, `validation.json`, `generated-inline-schema.diff`, `fixture-2026-09-24T03-26-35-946Z.json` |

## 2. R09 잔여 원인

runner의 lifecycle job에는 `renewLock: true`가 이미 있었지만 handler가 context를 받지 않았다. 따라서 `SeasonLifecycleTransitionJobService.run` → `runLifecycleTransition` → `cleanupEndedSeasonLimitReservations`까지 ownership callback이 도달하지 않았다. Cleanup은 transaction별 최대 100건을 반복하므로 lease loss 후 다음 batch를 계속 시작할 수 있었다.

## 3. R09 구현과 검증

기존 `isLockOwned?: () => boolean`을 네 production 파일에만 연결했다.

`OpsJobRunner.context.isLockOwned → lifecycle.run(input) → runLifecycleTransition → cleanup({now, isLockOwned})`

Lifecycle은 status transaction 시작 전, 완료 후 cleanup 진입 전에 검사한다. Cleanup은 매 batch 조회 전과 비동기 조회 후 transaction 시작 전에 검사한다. 이미 시작한 batch 안에는 ownership 검사/강제 cancellation을 넣지 않았다. 기존 runner가 lease loss를 `success=false`, `error.code=OPS_JOB_LOCK_LOST`, persisted Ops status `failed`로 기록한다. lock release 코드는 변경하지 않았다.

| 요구 | 이번 검증 |
|---|---|
| R09-FINAL-1 | 실제 PG에 매수/매도 102건. 첫 100건 transaction callback 완료·commit 직전에 barrier. renewal rejection 후 callback false를 관찰하고 commit 허용. old worker selection=1, transaction=1로 다음 조회/tx 미시작 |
| R09-FINAL-2 | 정상 lease로 102건을 두 batch에서 처리. 이미 ended인 시즌의 다음 tick에서도 self-healing 유지 |
| R09-FINAL-3 | 첫 100건 canceled/season_ended/reservationReleasedAt 보존. wallet cash reservation 510→10, position reservation 51→1. 잔여 두 주문 submitted/예약 유지. successor가 잔여를 정리하고 기존 100건 전체 row 불변 확인. 총 현금 1000·총 수량 100 불변 |
| R09-FINAL-4 | 실제 runner response와 persisted OpsJobRun 모두 실패/OPS_JOB_LOCK_LOST 확인 |
| R09-FINAL-5 | 기존 두 PostgreSQL client renewal/takeover/old-release 보호와 lifecycle/join/cancel/matching/settlement 회귀 재실행 PASS |

Unit에서는 lifecycle transaction 전/중 loss, cleanup 조회 전/조회 중 loss도 검증한다. 전용 4 suites/81 tests PASS. PG 신규 시나리오는 기존 `OPS_JOB_LOCK_DB_SMOKE=1` 및 Core account CI 명령에 자동 포함된다. Renewal error만 통제해 주입하며 DB transaction, row lock, wallet/position release, cancel, Batch/Ops audit는 실제 구현을 실행한다.

## 4. R10 실제 원인과 generated 정책

시작 clean tree에서 `pnpm exec prisma generate` 후 `git diff --exit-code`가 exit 1이었다. 변경 파일은 `backend/src/generated/prisma/internal/class.ts` 하나, 단일 `inlineSchema` JSON 문자열이다. 해독한 [정확한 schema diff](generated-inline-schema.diff)는 fee comment 5줄을 현재 4줄로 바꾸는 내용뿐이다:

- 이전: limit/general market pin, season market/FX null.
- 현재 schema: 양 모드 market/limit/FX pin, nullable은 legacy compatibility; market/FX amount는 execute 가격/환율 사용.

Runtime model/필드 변경이나 migration 추가가 아니다. Prisma 7.6.0과 pnpm 10.33.0으로 현재 HEAD에서 직접 재현했다.

`src/generated/prisma`는 40개 파일이 Git에 추적되며 이전 canonical/legacy-scope migration commit들도 이 경로를 갱신했다. schema generator output도 이 경로이고 production source·PrismaService·scripts·tests가 직접 import한다. `build`는 `nest build`이며 generate hook이 없다. typecheck/test도 자동 생성하지 않는다. CI 여섯 job은 generate를 명시적으로 선행한다. 실제 Render 설정은 이번 작업에서 조회하지 않았고, 저장소 밖 배포가 항상 generate한다고 가정하지 않았다. `.gitignore`의 `/generated/prisma`는 현재 `/src/generated/prisma` 출력 경로와 다르다.

따라서 추적 정책을 유지하는 것이 현재 소비자·build 정책과 일치한다. untracked 전환이나 ignore 변경은 하지 않았다.

## 5. R10 구현

현재 schema로 실제 생성한 `class.ts`를 수정본에 포함했다. `backend/README.md`에는 schema 변경과 generated artifact를 함께 반영하고 새 checkout에서 clean generation을 검증하는 현재 정책을 짧게 명시했다.

`ci.yml`, `smoke-git-identity.ts`, schema, package.json, lockfile, `.gitignore`는 변경하지 않았다. `SMOKE_ALLOW_DIRTY`, SHA override, `|| true`, `continue-on-error`를 사용하지 않았다. `assertReleaseCleanTree`와 artifact traceability guard를 그대로 통과했다.

## 6. R10 clean checkout 검증

Node 24.14.1 / pnpm 10.33.0. 별도 clone에 local `.env*`와 node_modules symlink 없이 설치했다. PostgreSQL 16.15(UTC, port 55446)와 Redis 7.0.15(port 56386)는 이번 작업에서 `/tmp`에만 구성한 loopback 서비스다. 운영 DB·공급자 credentials를 사용하지 않았다.

| 명령 (backend cwd) | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm exec prisma generate` | PASS |
| `git diff --exit-code` | PASS, 출력 없음 |
| `git status --porcelain` | PASS, 빈 출력 |
| `pnpm exec prisma migrate deploy` | PASS. fresh 전용 DB에 전체 migration 적용; 최종 clone 재검사도 PASS |
| `pnpm exec prisma migrate status` | PASS, up to date |
| `CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture` | PASS, 실제 24개 시나리오 실행 |

[새 fixture artifact](fixture-2026-09-24T03-26-35-946Z.json):

- `gitCommit=3ab39a026bb85d647a071bf3567f33ed3a7c9ad1` = 실행 clone의 실제 HEAD.
- `gitDirty=false`, `result=passed`, `passed=24`, `failed=0`.
- 시작 `2026-09-24T03:26:34.942Z`, 종료 `2026-09-24T03:26:35.946Z`.
- 실행 전 파일명 집합에는 `fixture-2026-07-13T10-23-13-789Z.json`만 존재. 집합 차이로 새 파일 정확히 1개를 식별하고 SHA/clean/result를 assertion했다.
- migrations/coverage, DB serving/Redis cache, real app WS pubsub, fixture provider sockets, finalizer/REST repair/reconciliation, lease loss, retention, cleanup 실행. provider network 자체는 fixture다.
- cleanup 후 DB rows=0, Redis keys=0, errors=[]이다.
- smoke 완료 후 clone의 유일한 untracked 파일은 이번 artifact다. `gitDirty=false`는 실행 전 확인 상태이며, 완료 후 생성된 artifact를 숨긴 것이 아니다.

## 7. R10 GitHub Actions

수정본 push는 수행하지 않았다. 검증 SHA는 `/tmp` clone의 로컬 commit이다. 따라서 **로컬 equivalent PASS / hosted CI 미확인**이다. 과거 SHA의 CI 결과를 새 수정본의 성공으로 사용하지 않았다. Branch protection/required checks/ruleset/organization 설정은 조회·변경하지 않았다.

## 8. R11 실제 stale 문서와 수정

| 파일 | 이전 충돌 | 실제 계약 / 수정 |
|---|---|---|
| `backend/AGENTS.md` | rulepack 최상위, 시즌 gate가 전체 모드처럼 보임 | 명시적 current 정책과 구현/tests/migrations를 함께 대조; current contracts 우선, 시즌/일반 분리 |
| `codex-rulepack.md` | 시즌 중심 core flow, 시장가만 | TradingAccount 모드 선택, 양 모드 market/limit BUY·SELL, quote pinning, scheduler Path A/B |
| `docs/README.md` | NOT NULL이 remaining exclusion, scheduler dry-run으로 안내 | 두 완료 migration 연결, scheduled dryRun=false 및 Ops lease 계약 안내 |
| `policy-decisions.md` | 항상 provider limit 체결가, market/FX fee null, participant-first, matching 인가 lock 누락, participant 단위 replay 설명 | Path A snapshot/Path B limit 가격, 양 모드 fee pin·legacy 예외, Season→Account→Participant, account unique/replay/cancel scope, 실제 matcher cursor/scan 예산 |
| `orders-api-contract.md` | Quote→Participant→Season 순서 | actual helper의 lock order와 DB clock 위치; cancel/cleanup과 execution 경계 구분 |
| `scheduler-ops-foundation.md` | TTL/acquire/release만 설명, 오래된 matching 예산 설명 | TTL/3 renewal, local deadline, false/error loss, safe boundaries, lifecycle cleanup, actual scan/attempt 예산·지표 |
| `trading-modes-and-accounts.md` | 뒤쪽 후속 계획에 NOT NULL/participant 제거/TWR/account closure 남음 | 현재 완료 상태 추가, 전환 단계와 당시 후속 목록을 Historical/superseded로 명시 |
| `backend/README.md` | cancel 불가, matching 미구현, CI 3개·frontend export 없음 | limit cancel/matcher/current six jobs, tracked generated 정책 |

`trading-account-orders-api-contract.md`와 `trading-account-finance-api-contract.md`의 현재 scope/fee pin 계약은 실제 코드와 일치해 그대로 유지했다. 관련 `20260910120000` required account scope / `20260911120000` legacy financial participant 제거 migration과 fee/transaction-time/create-race/ranking-final-scope tests를 대조했다.

최종 repository 전체 keyword 검색 분류:

| 검색 결과 | 분류 |
|---|---|
| `orders-api-contract.md`의 `reservation_only` | 현재 정책: matching flag off 응답값. 정상 유지 |
| order/finance/FX 계약의 null fee | 현재 정책: legacy season fallback, general invalid/null reject. 새 quote가 null이라는 뜻 아님 |
| policy의 `Redis Stream matcher` | 제거된 계층이라고 명시한 역사 설명. 현재 PostgreSQL polling 유지 |
| policy 작업 7·8 및 modes 문서의 nullable/dual-write/NOT NULL 후속 | Historical migration 섹션. current required scope를 우선하도록 명시 |
| 기존 flow-audit/수정 investigation의 시장가만·participant-first | 당시 결함/수정 근거. 과거 문서를 현행화하지 않음 |
| source/tests의 null·reservation_only | 호환성/응답/손상 검증. 제품 계약에 맞는 정상 사용 |
| canonical의 시장가 전용·역순 lock·새 market/FX fee null·현재 NOT NULL 미완료 안내 | 수정 후 남지 않음 |

## 9. Canonical source 구조

1. 현재 구현·tests·migrations와 명시적 current 제품 정책을 함께 확인한다. 충돌을 자동으로 코드 우선으로 덮지 않는다.
2. docs index에서 current account/order/finance/ops 계약으로 이동한다.
3. policy-decisions의 current section과 rulepack을 대조한다.
4. HANDOVER/investigations/Historical migration notes는 과거 근거로만 사용한다.

문서를 이유로 정상 제품 코드를 과거 정책으로 되돌린 변경은 없다.

## 10. R01~R12 최종 상태

기존 보고서의 상태를 복사하지 않고 현재 경계 구현과 실행한 테스트를 대조했다. 이번 제품 수정은 R09/R10만이다.

| ID | 판정 | 현재 코드·검증 근거 |
|---|---|---|
| R01 | 해결 | frontend sessionOwnership generation, refreshFlight generation, token storage 직렬화; sessionLifecycle tests PASS |
| R02 | 해결 | session 종료 시 authority 무효화, 저장소 실패와 teardown/cache/navigation 분리; sessionLifecycle/sessionTeardown 테스트 PASS |
| R03 | 해결 | join의 Season write lock 뒤 clock_timestamp 재검증; 실제 PG 종료/정산/join barrier PASS |
| R04 | 해결 | matcher keyset cursor + 독립 scan/attempt budget; 양 모드·양 방향 liveness unit 및 PG matching PASS |
| R05 | 해결 | ticker pollInFlight/try-catch-finally, 자산별 오류 격리; gateway와 child-process poll 오류 회귀 PASS |
| R06 | 해결 | Season lock 아래 publication generation·participant set 재검증; ranking consistency PG PASS |
| R07 | 개선 완료 | bounded account history batches·공유 valuation context·Map publication·coalesced/trailing refresh; batching/publication unit 및 ranking PG PASS. 전체 ranking 계산 자체가 상수 비용이라는 주장은 하지 않음 |
| R08 | 해결 | FX ledger를 referenceId Map으로 한 번 그룹화; 손상 동치성과 6×E reference 접근 테스트 PASS, general FX/performance PG PASS |
| R09 | 해결 | 기존 장기 job lease 보호 + 이번 lifecycle cleanup 경계; 실제 두 client renewal/takeover와 102건 cleanup 회귀 PASS |
| R10 | 해결 (로컬 검증) | fresh clone frozen install/generate clean + 실제 PG16/Redis7 fixture 24 PASS, 현재 검증 SHA/clean artifact. Hosted는 별도 미확인 |
| R11 | 해결 | current canonical 충돌 정리, historical 분류, 코드/fee/lock/migration 재대조 |
| R12 | 해결 | RankingService read RepeatableRead, metadata/count/my/page 동일 snapshot; 실제 reader/writer consistency PG PASS |

## 11. 전체 테스트

| 검사 | 결과 |
|---|---|
| Backend `pnpm run typecheck`, `pnpm run build` | PASS |
| Backend accounts/candles lint + candles format (check-only) | PASS |
| Backend 전체 `pnpm exec jest --runInBand` | PASS: 206 suites / 3,052 tests. opt-in 등 44 suites / 48 tests는 기본 실행에서 SKIP; 필요한 실제 DB suites는 별도 아래 실행 |
| Release-critical `pnpm run test:e2e --runInBand` | PASS: 1 suite / 341 tests |
| R09 전용 unit/PG 4 suites | PASS: 81 tests; 이후 UTC Core PG에서 기존·신규 lease 재확인 |
| CI Core account PostgreSQL 명령 그대로 | PASS: 19 suites / 20 wrapper tests, 내부 실제 DB 시나리오 실행 |
| CI Limit order PostgreSQL 명령 그대로 | PASS: 11 suites / 11 wrapper tests, 내부 실제 DB 시나리오 실행 |
| migration deploy/status/schema drift | PASS; diff exit 0 |
| repair-links / repair-ranking-scope / audit-general (모두 기본 dry-run) | PASS |
| Fresh Candle fixture | PASS: 24 scenarios, 실제 PostgreSQL/Redis |
| Frontend accounts lint/typecheck/tests/web export | PASS: 1,189 tests, UI 코드 변경 없음 |
| `git diff --check`, 추가 파일 whitespace/증거 대조 | PASS |
| Hosted CI / 실제 모바일 / 실제 공급자 smoke | 미실행/미확인 |

Core PG는 join, account/financial scope, 일반 trading/FX/performance, 일반 daily snapshot의 원자성/동시성, snapshot scope audit, ranking consistency, settlement/final scope, auth, Ops lease를 포함한다. Limit PG는 reservation/cancel/create race, time/fee pin, no-Redis registration, idempotent replay, Path A/B matching, orders execute, FX, MVP flow를 포함한다. Season daily writer의 unit도 전체 unit에 포함되며 일반 daily writer의 실제 PG와 구분한다.

첫 전체 PG 실행은 임시 서버가 OS의 KST를 상속해 QUOTE_EXPIRED/season boundary/takeover에서 실패했다. 제품 코드를 바꾸지 않고 CI의 UTC 조건으로 서버를 맞춘 뒤 **새 DB**에 migration부터 다시 적용하여 Core/Limit 모두 PASS했다. 원시 실패·성공 로그는 `/tmp/trading-final-audit`에 보존했다.

## 12. 전체 GitHub Actions

| Job | 로컬 equivalent | 수정본 hosted run |
|---|---|---|
| Backend quality | PASS | 미확인 |
| Frontend quality | PASS | 미확인 |
| Release-critical E2E | PASS | 미확인 |
| Core account PostgreSQL integration | PASS | 미확인 |
| Limit order PostgreSQL integration | PASS | 미확인 |
| Candle fixture integration | PASS | 미확인 |

Hosted workflow 전체 green이라는 주장은 하지 않는다. 이번 변경에서 workflow/설정/required check를 완화하지 않았다.

## 13. 남은 비감사 항목

- 실제 mobile/browser UX 및 실제 Binance/KIS/FX 공급자 장기 smoke는 이번 fixture 검증 범위 밖이다.
- Ops docs의 provider quota·운영 실패 알림·실제 배포 uptime/중단 구간 확인은 별도 운영 검증이다. 현재 Render plan이나 always-on 상태를 추정하지 않았다.
- 광고 real verifier와 외부 보상 지급은 기존 미연동 범위다.
- R07 개선 후에도 전체 활성 시즌 ranking의 계산/이력 읽기는 대상과 이력에 비례한다. 대규모 운영의 메모리/DB 비용은 실제 관측으로 판단해야 한다.

## 14. 과설계 검토

새 queue/worker/Redis lock/microservice/CI framework 없음. schema/migration/package/lockfile/runtime config 추가 없음. 새 인프라는 저장소 제품에 도입하지 않았으며 임시 PostgreSQL/Redis는 검증용이다. 기존 callback과 batch loop만 사용하고 테스트는 기존 Core CI 경로에 연결했다.

## 15. 최종 자체 검토

Production/test/docs 전체 diff를 재독했다. Order FOR UPDATE, cash/position reservation release, release+cancel 원자성, submitted→canceled, reservationReleasedAt, season_ended, user cancel race, settlement open-reservation check, successor owner release, R04 liveness는 변경하지 않았다. Generated diff는 schema comment만이며 clean-tree guard 우회가 없다. 과거 investigation/HANDOVER는 보존했다. R01~R08/R12 제품 파일과 frontend/UI는 변경하지 않았다. 시작 사용자 변경은 없었다. 작업 중 관찰된 동일 tree의 commit-message amend는 보존했으며 무관한 기존 파일 수정·임시 debug 코드를 남기지 않았다.
