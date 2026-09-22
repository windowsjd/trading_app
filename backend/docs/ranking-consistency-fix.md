# Current ranking 정합성 수정 — R06 / R12

## 기준과 실제 원인

- 작업 시작/종료 HEAD: `66ab1e163a0152de6f116f8160ba597232bf5fbd`. 시작 working tree는 clean이었다. 사용자가 제시한 SHA와 동일하다.
- `docs/investigations/2026-09-22-flow-audit/report.md`를 현재 코드와 대조했다. R06/R12 원인 가설은 현재 HEAD에서도 유효했다. 이전 보고서는 R12를 정적으로 확인했고 새로운 PostgreSQL 경쟁 시험은 하지 않았지만, 이번에는 두 결함 모두 실제 PostgreSQL에서 재현했다.
- **R06:** 평가·history·정렬은 transaction 밖에서 진행된다. Season `FOR UPDATE`는 publication만 직렬화하므로 오래된 계산도 나중에 저장할 수 있었다. process-local Set은 key별이라 participant-change/scheduled 및 다른 인스턴스를 직렬화하지 못했고, 같은 key의 후속 요청은 버렸다.
- **R12:** metadata, scope, count, myRanking, page가 독립적인 DB snapshot에서 읽혔다. count/page에는 이미 capturedAt 조건이 있었지만, 그 조건만으로 삭제된 A 세대를 유지할 수는 없다. myRanking에는 capturedAt 조건도 없었다. 실제 재현 응답은 최상위 capturedAt=00:01, myRanking=00:02, 빈 목록/count=0인 available이었다.
- 추가 조사에서 admin daily 재생성(`writeSeasonRankings`)도 같은 daily 테이블의 writer인데 공통 Season 잠금에 참여하지 않는 점을 확인했다. 이 경로까지 보호하지 않으면 runtime의 검사 직후 우회 write가 가능하므로 daily 분기에만 동일 잠금/최신성 검사를 추가했다. final 재생성 정책은 그대로다.

## 구현과 ordering 정책

### 쓰기

1. 기존 Season row write lock을 획득한다. write transaction은 명시적인 `ReadCommitted`다. lock 대기 중 다른 writer가 commit해도 잠금 뒤의 조회는 그 결과를 본다.
2. 기존 active 상태와 `startAt <= capturedAt < endAt` 검사를 유지한다. ended/settled면 아무것도 쓰지 않는다.
3. 교체할 기존 ranking set의 canonical account scope를 검증한다. stale 요청이어도 손상된 set을 정상 skip처럼 처리하거나 삭제해 숨기지 않는다.
4. 저장된 daily ranking의 최대 capturedAt이 새 계산보다 **크거나 같으면**, participant 평가/rank, scheduled equity, ranking 삭제/생성 모두 건너뛴다. runtime은 시즌 전체 날짜를 비교해 이전 날짜의 늦은 계산도 participant current 값을 되돌리지 못하게 한다.
5. 저장 시점의 rankable participant ID 집합도 다시 비교한다. 대상이 바뀌면 `participants_changed`로 쓰기를 건너뛴다. 전원 제외된 빈 generation에는 capturedAt 행이 없기 때문에, 이 검사가 오래된 참가자 집합의 부활을 막는다.
6. 기존 participant/ranking publication은 동일 transaction 안에서 원자적으로 처리한다.

**동일 capturedAt:** millisecond 단위 시각은 여러 요청/인스턴스에서 같을 수 있다. 같은 시각을 같은 공개 snapshot 식별자로 취급하고, 먼저 commit한 publication을 유지한다. 같은 시각으로 나중에 완료한 계산이 다른 데이터를 덮어써 pagination snapshot의 의미를 바꾸지 못한다. 독립 인스턴스의 실제 계산 시작 순서를 wall clock만으로 추정하지 않는다. 후발 동일 시각 요청의 scheduled equity도 쓰지 않는다.

진행 중 같은 process/key로 들어온 요청은 최신 pending 요청 하나로 병합해 후속 계산한다. 대기 중 더 오래된 요청이 와도 최신 pending 기준을 낮추지 않는다. snapshot 생성 요청은 OR로 유지한다. 명시적인 capturedAt은 그대로 쓰며, 기본 현재 시각 요청은 후속 계산이 실제 시작할 때 시각을 다시 잡는다. 선행 계산이 실패해도 pending 계산은 실행하고, 마지막 실패라면 호출자에게 전달한다. 완료 뒤 새 요청도 다시 실행할 수 있다. 이것은 trigger 유실 방지이며 PostgreSQL의 최신성 검사를 대신하지 않는다.

admin daily writer는 동일 Season 잠금 아래 교체할 **해당 날짜**의 최신성을 비교하고 stale/equal이면 명시적인 오류를 반환한다. 이 경로는 기존처럼 historical ranking만 재생성하며 participant current 값은 쓰지 않는다. final 분기와 dry-run 동작은 변경하지 않았다. 역사 daily job은 기존 set이 있으면 잠금 아래 검증 후 skip하므로 기존 보호를 유지했다.

기존 timestamp와 Season 잠금으로 ordering을 보장할 수 있어 영구 revision/watermark 모델은 추가하지 않았다. 비교 기준은 capturedAt 값이며, 서버 시계가 어긋났을 때 실제 사건의 물리적 순서까지 복원하는 설계는 아니다.

### 읽기

`RankingService.getRanking()`의 인증/쿼리 파싱 뒤 짧은 `RepeatableRead` transaction에서 시즌 선택, metadata, 참가자 공개 여부, 전체 set scope, count, myRanking, page를 모두 같은 transaction client로 읽는다. myRanking에도 선택 capturedAt 조건을 명시한다.

writer가 A를 삭제하고 B를 commit해도 기존 reader는 PostgreSQL MVCC로 A의 행·참가자 공개 상태를 끝까지 읽는다. 새 reader는 B를 읽는다. 외부 호출, valuation, write/row lock은 읽기 transaction에 넣지 않았다. 기존 전체 set scope 검사의 O(P) 비용은 유지한다. 데이터베이스 오류/timeout을 혼합 available 응답으로 바꾸는 fallback은 없다.

이전 capturedAt으로 다음 페이지를 요청했을 때의 `409 RANKING_SNAPSHOT_CHANGED`, all/top10/near_me의 window 계산, pagination 응답 의미는 유지한다.

## 조사한 호출 경계

| 경로 | capturedAt / lockKey | 호출·실패·동시성 |
|---|---|---|
| OrdersService 시장가 완료 | 기본 현재 시각 / participant-change:seasonId | 거래 commit 뒤 fire-and-forget, catch 로그. 다른 거래·scheduler와 겹칠 수 있음 |
| LimitOrderMatchingService 지정가 완료 | 기본 현재 시각 / participant-change:seasonId | fill commit 뒤 participant dedupe, fire-and-forget/catch |
| FxService 환전 완료 | 기본 현재 시각 / participant-change:seasonId | FX commit 뒤 fire-and-forget/catch |
| OpsJobRunner current ranking | 입력 now 또는 현재 시각 / scheduled:seasonId | await, OpsJobRun 실패 기록, createEquitySnapshots 옵션 전달 |
| 직접 refreshCurrentRankingForSeason | options.capturedAt 또는 현재 시각 / season:seasonId 또는 지정 key | Promise 반환. 다른 key/인스턴스와 겹칠 수 있음 |
| SeasonRankingJobService | BatchService job startedAt / Season row lock | 역사 daily set 생성. 기존 set은 scope 검증 후 skip, 덮어쓰지 않음 |
| admin-generate-season-ranking CLI | 실행 시작 시각 / 이제 daily에 Season row lock | await, stale/equal 오류. 날짜별 재생성으로 participant current 값은 변경하지 않음 |
| lifecycle/settlement/operator | current refresh 직접 호출 없음 | Season 상태·final 결과·참가자 상태 변경. 기존 잠금/종료 차단 유지 |

RankingController, calculation/tier/source scope/set scope 정책, SeasonRanking·SeasonParticipant model, ranking migrations와 unique/index, current/final/settlement 테스트까지 확인했다. 기존 `(seasonId, rankType, rankingDate, participantId/rank/accountId)` unique는 중복만 막고 publication 최신성이나 여러 SELECT의 snapshot을 보장하지 않는다.

## 변경 파일

| 파일 | 역할과 변경 이유 |
|---|---|
| `src/ranking/current-ranking-generation.ts` | Season lock 아래 기존 capturedAt 비교. runtime/CLI daily writer가 공유하는 작은 함수 |
| `src/ranking/ranking-refresh.service.ts` | 저장 최신성·대상 재검증, pending trigger 실행, rank Map |
| `src/ranking/ranking.service.ts` | 한 응답의 Repeatable Read 경계 및 myRanking capturedAt 고정 |
| `src/portfolio/season-ranking-generation.ts` | 공통 잠금을 우회하던 admin daily writer 보호. final 정책 유지 |
| `src/ranking/ranking-refresh.service.spec.ts` | stale/equal 무쓰기, scope 오류 우선, 암묵 시각 후속 계산 검증 |
| `src/ranking/ranking.service.spec.ts` | transaction mock/격리 수준·capturedAt 검증. 기존 모든 무쓰기 assertion 유지 |
| `scripts/ranking-consistency-integration.ts` | 실제 PostgreSQL 두 pool/서비스 인스턴스, barrier와 query 경계 hook을 사용한 30개 시나리오 |
| `src/ranking/ranking-consistency.integration.spec.ts` | 기존 opt-in/migrate-only 방식으로 runner 실행 |
| `test/app.e2e-spec.ts` | Prisma mock에 RepeatableRead enum 추가 |
| `../.github/workflows/ci.yml` | 기존 Core account PG job에 새 suite 한 줄 추가 |
| `docs/ranking-consistency-fix.md` | 조사·설계·검증·범위 기록(본 문서) |

## DB/API 영향과 유지한 불변조건

- schema, migration, dependency, index 변경 없음. 기존 데이터 migration 불필요. API base path `/api/v1`, 랭킹 response shape 변경 없음.
- current는 active/window 안에서만 갱신하고 Season lock 뒤 상태 재확인을 유지한다. ended/settled/final 불변성 및 settlement serialization을 유지한다.
- account canonical scope, ranking row scope, 전체 set 검증을 제거/약화하지 않았다. 손상은 오류로 남는다.
- totalAssetKrw, returnRate, MDD, totalFillCount, reachedReturnAt, rank와 tie-break 계산 정책은 변경하지 않았다.
- hidden/excluded/public 정책, current/final 구분, finalTier/provisionalTier, not_joined 및 pagination 의미는 유지한다.
- 주문·FX transaction, wallet/position/fee/reservation/idempotency, 가격·환율 eligibility 코드는 변경하지 않았다. 호출자도 변경하지 않았다.
- 내부 refresh 결과에는 `stale_generation`/`participants_changed` skip 이유가 생긴다. 진행 중 trigger는 기존 `already_running` 즉시 skip 대신 후속 계산 결과를 기다린다. 공개 ranking 응답과는 별도다.

## 검증 결과

2026-09-22, Node 24.14.1 / pnpm / PostgreSQL 16.15, UTC의 격리 DB에서 수행했다. Docker가 없는 환경이라 PostgreSQL 패키지를 `/tmp`에 풀고 loopback 전용 임시 서버를 사용했다. 실제 앱의 `.env`는 로드하지 않은 로컬 checkout 복사본에 변경 파일을 반영했고, 테스트 URL과 opt-in 환경변수만 명시했다. 외부 provider/운영 DB는 사용하지 않았다.

| 구분 | 명령 (backend 기준) | 결과 |
|---|---|---|
| 타입 | `pnpm run typecheck` | PASS |
| 빌드 | `pnpm run build` | PASS |
| 전체 unit/mock suite | `pnpm exec jest --runInBand` | 200 suites / 2,963 tests PASS. opt-in 44 suites / 48 tests는 이 명령에서 skip |
| HTTP E2E (DB mock) | `pnpm run test:e2e --runInBand` | 1 suite / 341 tests PASS |
| 변경 product/runner lint | 아래 exact-scope ESLint | 오류/경고 0 |
| 새 실제 PG runner | `pnpm exec tsx scripts/ranking-consistency-integration.ts` | 30 scenarios PASS |
| 관련 실제 PG 회귀 | 아래 13-suite Jest 명령 | 13 suites / 13 runner tests PASS |
| diff | `git diff --check` | PASS |

```sh
pnpm exec eslint --no-fix --max-warnings=0 \
  src/ranking/current-ranking-generation.ts \
  src/ranking/ranking-refresh.service.ts src/ranking/ranking.service.ts \
  src/portfolio/season-ranking-generation.ts \
  scripts/ranking-consistency-integration.ts

# 격리된 test DB에 DATABASE_URL, NODE_ENV=test를 명시하고 실행한다.
# TRADING_ACCOUNT_DB_INTEGRATION=1
# ORDER_EXECUTE_DB_INTEGRATION=1, FX_EXECUTE_DB_INTEGRATION=1
# LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1
# LIMIT_ORDER_MATCHING_DB_INTEGRATION=1
# LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1
# MVP_FLOW_DB_SMOKE=1, LIMIT_ORDER_ENABLED=true
pnpm exec prisma migrate deploy
pnpm exec jest --runInBand \
  src/ranking/ranking-consistency.integration.spec.ts \
  src/ranking/season-ranking-scope.integration.spec.ts \
  src/orders/limit-order-reservation.integration.spec.ts \
  src/orders/limit-order-create-race.integration.spec.ts \
  src/orders/limit-order-transaction-time.integration.spec.ts \
  src/orders/trading-transaction-time.integration.spec.ts \
  src/orders/trading-fee-pinning.integration.spec.ts \
  src/orders/limit-order-create-no-redis.integration.spec.ts \
  src/orders/limit-order-idempotent-replay.integration.spec.ts \
  src/orders/limit-order-matching.integration.spec.ts \
  src/orders/orders.execute.integration.spec.ts \
  src/fx/fx.execute.integration.spec.ts src/mvp-flow.integration.spec.ts
```

새 PostgreSQL 검증은 valuation 자체와 모든 SELECT/DML을 실제 DB로 수행했다. barrier/query wrapper는 실행 순서만 제어하고 DB 결과를 mock하지 않는다.

- old 계산 중단 → new publication commit → old 재개에서 ranking/participant/equity 전체 상태가 new 상태 그대로임을 검사했다.
- participant-change vs scheduled, participant-change vs participant-change를 서로 다른 인스턴스로 검사했다. 같은 인스턴스의 다른 key도 검사했다. 역방향으로 stale scheduled writer가 equity를 추가하지 않는지도 확인했다.
- 동일 capturedAt의 first-publication-wins, 이전 날짜 지연 계산, 빈 generation, pending 최신 요청/선행 실패 후 후속 실행을 검사했다. 기본 시각의 재샘플링은 별도의 fake-clock unit으로 검증했다.
- refresh 계산 도중 Season lock 아래 ended/settled로 전환한 뒤 final/participant 데이터가 보존되는지 검사했다. 이 경쟁 fixture의 final rows는 합성한다. **실제 settlement transaction, 계정 closure, rollback 및 final 불변성은 기존 season-ranking-scope PostgreSQL suite로 별도 검증했다.**
- all/top10/near_me 각각 metadata 직후, count 직후, myRanking 직전/직후, page 직전의 5개 경계에 B writer commit을 삽입했다. 15개 조합 모두 응답 전체가 기존 A 응답과 동일하고 이후 읽기는 B였다. reader가 열린 상태에서 writer commit도 완료됐다.
- pagination, 409 snapshot-changed, myRanking, not_joined, hidden/excluded, final tier, scope 손상과 season 시작 포함/종료 제외를 검증했다.
- admin daily의 stale/equal 거부와 newer 정상 교체, participant current 무변경도 검증했다.

**결함 탐지력 확인:** 격리 복사본에서 writer만 HEAD 버전으로 되돌리면 같은 테스트가 실제 ranking/participant 값의 후퇴를 탐지해 실패했다. reader만 HEAD 버전으로 되돌리면 A metadata와 B myRanking/빈 목록의 혼합 응답을 탐지해 실패했다. 작업 저장소의 파일은 되돌리지 않았다. 선택 실행은 `RANKING_CONSISTENCY_CASE` substring filter를 사용했다.

환경 보정 과정의 실패도 있었다. 최초 임시 PostgreSQL의 KST 설정은 timestamp 경계/quote 만료 실패를 만들었고, 해당 실패 fixture가 남아 후속 현재 시즌 선택을 방해했다. UTC로 바꾼 새 DB에서 재검증했다. 새 DB의 첫 time-policy runner는 자체 migrate 단계가 없어 schema 준비 전 실패했으며, 기존 migrations 적용 후 13개 전체 suite가 통과했다. 제품 기대값을 완화하거나 금융 코드를 수정해 통과시키지 않았다.

이번 검증은 운영 규모 부하 시험, 외부 provider 연동 시험, 배포 확인을 포함하지 않는다. frontend는 변경하지 않아 frontend 검증을 실행하지 않았다. 전체 opt-in suite/전체 repository lint를 모두 실행한 것은 아니며, 관련 PostgreSQL suite와 변경 코드 lint를 실행했다. R10 Candle fixture 실패는 이번에 재실행·수정하지 않았다.

## 부수 개선과 남은 위험

- rank 반영 시 반복하던 `rows.find`를 participant ID → rank Map으로 바꿨다. 같은 유일 참가자 집합에서 동일 rank를 조회하므로 정렬·tie-break 의미가 변하지 않는다. 해당 lookup 단계의 O(P²)를 O(P)로 줄였다.
- **R07은 남는다.** 거래 후 시즌 전체 valuation, 전체 equity history/MDD, 정렬, 행별 participant/ranking 쓰기 및 전체 set scope 검증은 유지한다. incremental/partial ranking, summary 모델, queue/worker는 도입하지 않았다.
- 최신성 비교는 기존 season/rankType 인덱스로 후보를 좁히지만 capturedAt 전용 정렬 인덱스를 새로 만들지 않았다. 참가자·시즌 이력이 커지면 이 조회와 writer lock 시간, reader transaction/pool 사용량을 측정해야 한다. 부하에 대한 성능 보장은 이번 시험 범위가 아니다.
- 서버 시계 동기화와 비정상적으로 미래인 capturedAt을 운영에서 확인해야 한다. 기록된 기준보다 뒤처진 시각의 계산은 의도적으로 폐기된다.
- 새 코드의 검사에 의존하므로 **구버전 writer가 함께 실행되는 동안에는 구버전이 이 검사를 우회할 수 있다.** 배포 시 runtime/운영 CLI writer를 모두 갱신하고 구버전 실행을 종료해야 한다. rollback해 구버전으로 돌아가면 R06/R12 보호도 사라진다. 데이터 형식 호환성 문제나 data migration은 없다.
- 프로세스 재시작을 넘는 durable trigger 보관은 기존처럼 없다. 이번 pending 병합은 실행 중 들어온 요청 유실을 해결하며, 외부 scheduler 실패/restart 복구 체계를 새로 설계하지 않았다.

## 최종 자체 검토

전체 tracked diff와 새 파일을 검토했다. read snapshot과 write 최신성은 독립적인 작은 경계로 구현했고, 새 공통 함수는 capturedAt 비교 한 가지 역할이다. 기존 ranking/settlement/금융 정책을 재작성하지 않았다. scope 검증을 제거하지 않았고 기존 테스트의 금융/랭킹 기대값도 완화하지 않았다. reader 테스트에서 없앤 것은 읽기 transaction 도입과 양립하지 않는 “transaction 미호출” assertion뿐이며, 모든 write 미호출 assertion은 유지했다.

변경은 ranking runtime/reader/admin daily writer, 관련 테스트·CI 한 줄·본 문서로 제한했다. frontend, 금융 코어, schema/migration, dependency, 기존 조사 산출물 및 R10 코드에는 변경이 없다. 새 서비스/worker/영구 상태/호환 계층은 없다.
