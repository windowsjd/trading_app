# R07: current ranking refresh 비용 개선

기준은 로컬 HEAD `34628d13d2c30d50ea8a2458ba960736437319a0` (`랭킹정합성 보수`)이며 시작 working tree는 clean이었다. 기존 flow audit의 R07과 `../ranking-consistency-fix.md`를 현재 코드와 대조했다. 구현 전 격리 PostgreSQL pilot으로 비용을 확인했고, 같은 HEAD의 고정 checkout을 보존하여 최종 benchmark를 변경 전·후에 동일하게 적용했다. 운영 DB와 환경 파일은 사용하지 않았다.

## 1. 실제 병목과 기존 최적화

- 한 거래도 전체 rankable participant를 평가한다. account의 canonical scope·wallet·position·asset 조회 후 position별 적격 가격을 선택하고 필요하면 USD/KRW를 읽는다. 가격·환율은 **DB snapshot 조회**이며 이 경로에서 외부 provider HTTP를 호출하지 않는다. 기존 selector는 후보 수·eligibility·폐장 세션·우선순위·fallback을 이미 제한하지만 참가자 사이의 결과 재사용은 없었다.
- P=500/K=12/H=1,000에서 거래 후 SQL 11,016회 중 가격 조회 6,000회, FX 조회 1,000회였다. history도 500회/500,000행이다. 반복 source 조회는 SQL 수의 가장 큰 부분이었다. 긴 H의 읽기·Decimal 계산·정렬도 실제 시간을 늘린다. 개별 단계 CPU 비율은 측정하지 않았으므로 SQL 수를 wall time의 비율로 해석하지 않는다.
- Season lock 안에서 participant UPDATE P회, ranking INSERT P회와 DELETE 1회가 실행됐다. scheduled는 bucket 존재 조회 P회 및 equity INSERT P회가 추가됐다.
- `CurrentRankingValuation.history`는 계산 이후 사용하지 않지만 전체 참가자의 history를 publication까지 보유했다.
- `rows.find` O(P²)는 이미 Map으로 해결됐다. 같은 lockKey 요청을 마지막 pending으로 합치고 첫 계산 실패 후에도 pending을 실행하는 구조도 이미 존재한다. 이를 다시 구현하지 않았다.
- valuation 내부의 position `Promise.all`에 참가자 동시 실행까지 곱하면 pool 부하가 늘어난다. 새 참가자 병렬 처리는 추가하지 않았다.

호출자와 경계도 확인했다.

| 경로 | 시각·key·실행 방식 | 이번 변경 |
| --- | --- | --- |
| 시장가 OrdersService | commit 후 participant-change, 명시 시각 없음, fire-and-forget 및 catch/log | 없음 |
| 지정가 LimitOrderMatchingService | 체결 commit 후 participant-change, 명시 시각 없음, fire-and-forget 및 catch/log | 없음 |
| FxService | commit 후 participant-change, 명시 시각 없음, fire-and-forget 및 catch/log | 없음 |
| Ops scheduler | 고정 now, scheduled:{seasonId}, await, scheduled equity 생성 | 없음 |
| lifecycle / settlement | Season row lock과 종료·정산 정책 | 없음 |
| admin daily/final generator | 기존 daily generation 검사 및 final 정책 | 없음 |

종류별 key 및 별도 service instance의 계산은 계속 겹칠 수 있다. publication의 PostgreSQL 검증이 최종 권한이며 process-local 병합에 correctness를 맡기지 않는다.

## 2. 구현 방법과 선택 이유

1. **한 refresh 내 가격·환율 선택 재사용.** 동일 client·capturedAt·workflow에 대해 기존 selector의 Promise와 진단 정보를 공유한다. asset id/type/market/currency/priceCurrency가 같아야 가격을 재사용한다. holdings와 canonical scope는 매번 조회한다. 기존 valuation 호출의 첫 네 인자와 반환 계약은 유지하고 ranking만 optional 다섯 번째 context를 전달한다. 다음 refresh는 새 context를 만든다.
2. **16개 참가자씩 전체 history 조회.** account IN query로 읽고 모든 scope column을 검증한다. account 안의 capturedAt/createdAt/id 순서와 모든 row를 보존한다. MDD/reachedReturnAt 함수, 동일 capturedAt의 current point 생략, future history 포함 동작은 그대로다. 처리한 batch history를 전체 valuation 결과에 보관하지 않는다.
3. **200행 단위 publication.** ranking은 createMany, scheduled equity는 같은 5분 bucket의 존재 account를 batch 조회한 뒤 누락 행만 createMany 한다. skipDuplicates는 쓰지 않는다. 오류는 기존 transaction 전체를 rollback시킨다. participant UPDATE는 그대로다.

가격 재사용은 “이 refresh에서 먼저 선택한 적격 관측값을 같은 조건에 공유”한다는 의미다. 계산 도중 늦게 DB에 유입되는 소급 관측값을 참가자마다 다시 선택하던 관측 순서까지 동일하다는 보장은 아니다. 고정 입력에서 값·source decision·진단 동등성을 검증했고 다음 refresh에서는 다시 조회한다. source eligibility 규칙 자체는 바꾸지 않았다.

원래의 계산/쓰기 경계를 유지했다. Season lock 안으로 valuation/history 계산을 이동하지 않았다. 기존 lock → 상태/시간 → 기존 set scope → stale generation → participant 집합 재검증 뒤에만 batch write를 실행한다.

영구 MDD summary, incremental ranking, participant raw SQL bulk UPDATE, scheduler/거래 queue 통합은 채택하지 않았다. 앞의 세 수정만으로 효과가 확인됐고 추가 상태·보정·정산 경로나 trigger 시각/bucket의 새 정책을 관리할 필요가 없다.

## 3. 변경 파일

| 파일 (backend 기준) | 역할과 이유 |
| --- | --- |
| src/ranking/ranking-refresh.service.ts | refresh-local source context, history 16명 batch, 불필요한 history 보유 제거, publication helper 연결 |
| src/portfolio/portfolio-valuation.service.ts | 기존 source selector를 같은 계산 안에서 재사용하는 optional context |
| src/ranking/current-ranking-publication.ts | 200행 단위 ranking INSERT 및 scheduled bucket 조회/INSERT |
| src/ranking/ranking-refresh.service.spec.ts | createMany에도 기존 성공·무쓰기 assertion 적용, valuation 인자 확인 보강 |
| src/ranking/ranking-refresh-batching.spec.ts | 16/16/1 조회, 전체 history, MDD·도달 시각·순위·동일 시각·future history·마지막 batch 손상 회귀 |
| src/ranking/current-ranking-publication.spec.ts | 200/200/1 payload, bucket 양 경계, 중복 방지·실패 전파 |
| src/portfolio/portfolio-valuation-source-reads.spec.ts | 값·선택·실패 진단 동등성, client/time/workflow/asset 격리, 새 refresh 및 scope 검사 |
| scripts/ranking-refresh-benchmark.ts | opt-in 실제 PostgreSQL fixture와 driver 계측; production instrumentation 없음 |
| docs/ranking-r07/report.md | 설계·검증·재현 방법·한계 |
| docs/ranking-r07/{baseline,after}.json | 동일 12조건의 원본 sample metrics |
| docs/ranking-r07/{baseline-burst,after-burst}.json | 22개 동시 trigger의 원본 metrics |
| docs/ranking-r07/measurement-provenance.json | 기준 SHA·환경·candidate 파일 SHA256·결과 동등성 |
| docs/ranking-r07/validation.json, ci-evidence.json | 로컬 검증과 별도로 확인한 기존 HEAD Actions 상태 |

## 4. DB / API 영향

schema, migration, index, backfill 및 API response 변경 **없음**. 기존 데이터 이동도 없다. current/final, hidden/excluded, 전체 set integrity, canonical account, 동률·수익률·MDD·tier·pagination 규칙은 유지한다. 주문·환전·지갑·포지션·예약금·수수료·멱등성 및 거래 transaction은 수정하지 않았다.

schema와 migration SQL을 함께 확인했다. history의 (trading_account_id, captured_at)와 bucket의 (trading_account_id, snapshot_reason, captured_at)는 20260803211000 migration에 있고 20260911120000 canonical scope 전환도 확인했다. 기존 구조의 bounded IN 조회와 round trip 감소만으로 효과가 있었다. 새 index의 필요성을 주장하거나 수행하지 않은 EXPLAIN 결과를 인용하지 않는다.

## 5. 실측 전후 비교

PostgreSQL 16.15, Node 24.14.1, UTC, loopback의 새 격리 DB에서 각 shape/mode마다 warmup 1회 후 3회 중앙값을 측정했다. pool을 늘리거나 외부 provider/Redis를 사용하지 않았다. reset은 기존 ranking set을 유지하며 capturedAt만 기준보다 1ms 낮추므로 기존 set scope 검증도 포함된다. fixture 준비·reset·hash 조회·cleanup은 계측에서 제외했다.

K는 **각 참가자가 공유하는 K개 종목**, H는 참가자당 과거 equity 행 수다. 종목이 모두 다른 포트폴리오에서는 source 재사용 효과가 작아진다. 전후 각각 단일 계측 프로세스로 동일 호스트에서 순차 실행했으며 운영 p95/최대 처리량을 뜻하지 않는다.

SQL은 driver의 실제 statement 수이며 BEGIN/COMMIT/SET도 포함한다. writes는 participant UPDATE + ranking DELETE/INSERT + equity INSERT 합계다. lock 시간은 같은 connection의 FOR UPDATE 응답부터 COMMIT 응답까지로 대기 시간을 제외한다.

| P/K/H | trigger | refresh ms 전→후 | 시간 감소 | SQL 전→후 | writes 전→후 | lock ms 전→후 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 20/3/20 | participant | 81.0 → 46.6 | 42.5% | 276 → 144 | 41 → 22 | 19.4 → 15.3 |
| 20/3/20 | scheduled | 90.5 → 44.1 | 51.2% | 316 → 146 | 61 → 23 | 33.0 → 16.8 |
| 100/3/20 | participant | 328.7 → 168.8 | 48.6% | 1,316 → 629 | 201 → 102 | 75.7 → 53.0 |
| 100/3/20 | scheduled | 392.8 → 172.0 | 56.2% | 1,516 → 631 | 301 → 103 | 146.9 → 59.9 |
| 100/12/20 | participant | 377.8 → 167.9 | 55.6% | 2,216 → 638 | 201 → 102 | 73.4 → 50.0 |
| 100/12/20 | scheduled | 451.0 → 174.2 | 61.4% | 2,416 → 640 | 301 → 103 | 139.1 → 58.8 |
| 100/3/1000 | participant | 680.0 → 513.1 | 24.6% | 1,316 → 629 | 201 → 102 | 76.0 → 52.5 |
| 100/3/1000 | scheduled | 742.9 → 512.0 | 31.1% | 1,516 → 631 | 301 → 103 | 146.1 → 58.8 |
| 500/3/100 | participant | 1663.3 → 893.9 | 46.3% | 6,516 → 3,056 | 1,001 → 504 | 340.9 → 232.2 |
| 500/3/100 | scheduled | 1992.4 → 905.3 | 54.6% | 7,516 → 3,062 | 1,501 → 507 | 675.6 → 267.0 |
| 500/12/1000 | participant | 3817.3 → 2681.0 | 29.8% | 11,016 → 3,065 | 1,001 → 504 | 342.2 → 237.6 |
| 500/12/1000 | scheduled | 4224.5 → 2781.5 | 34.2% | 12,016 → 3,071 | 1,501 → 507 | 689.0 → 280.9 |

전체 12조건에서 ranking과 participant 현재 평가 필드의 정규화 SHA256이 전후 모두 같았다. 원본 JSON은 각 반복의 값도 포함한다. hash는 scheduled equity나 모든 금융 데이터를 포함하지 않으며 그 정책은 별도 회귀 테스트로 검증했다.

| P/K/H | history query 전→후 | history rows 전후 동일 | query 최대 history rows 전→후 | 가격 query 전→후 | FX query 전→후 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20/3/20 | 20 → 2 | 400 | 20 → 320 | 60 → 3 | 40 → 2 |
| 100/3/20 | 100 → 7 | 2,000 | 20 → 320 | 300 → 3 | 200 → 2 |
| 100/12/20 | 100 → 7 | 2,000 | 20 → 320 | 1,200 → 12 | 200 → 2 |
| 100/3/1000 | 100 → 7 | 100,000 | 1,000 → 16,000 | 300 → 3 | 200 → 2 |
| 500/3/100 | 500 → 32 | 50,000 | 100 → 1,600 | 1,500 → 3 | 1,000 → 2 |
| 500/12/1000 | 500 → 32 | 500,000 | 1,000 → 16,000 | 6,000 → 12 | 1,000 → 2 |

두 trigger 모두 위 read 수가 같다. account/holdings/scope 관련 SELECT는 이 fixture에서 4P+3으로 전후 동일하다. 기본 holdings 조회와 scope 검사는 줄이지 않았다. participant UPDATE도 P회 그대로다. P=500 ranking write는 501→4(DELETE 1 + INSERT 3), scheduled equity INSERT는 500→3이다.

history 총 읽기량은 **감소하지 않았다**. 한 query 반환량은 최대 16명분으로 늘었지만 전체 참가자 history를 결과에 보관하던 참조를 제거했다. 실제 peak RSS/heap은 측정하지 않았고, 16명 제한은 H가 늘어도 일정 메모리라는 뜻이 아니다.

동시 trigger는 P=100/K=3/H=20에서 첫 valuation을 barrier로 멈춘 뒤 같은 key 요청 20개와 scheduler 요청 1개를 추가했다. 총 22개 요청이며 capturedAt은 명시적으로 basis/+1s/+2s다.

| 지표 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 전체 참가자 계산 횟수 | 3 | 3 |
| 전체 완료 시간 중앙값 | 672.7ms | 338.4ms |
| SQL | 3,943 | 1,783 |
| history rows | 6,042 | 6,068 |
| 최종 ranking/participant hash | 동일 | 동일 |

기존 pending 병합을 유지했으므로 계산 횟수를 추가로 줄였다는 주장은 하지 않는다. history row 차이는 계산 도중 scheduler가 생성한 100행을 어느 참가자 history부터 관측하는지의 interleaving 차이다. 최종 publication은 +2s 결과로 동일했다. 고정 history 읽기량 비교는 앞의 단일 refresh 표를 사용한다.

### Benchmark 재현

빈 loopback DB ranking_r07 또는 ranking_r07_benchmark만 허용한다. 새 DB에 기존 migration을 적용한 뒤, 환경 파일 없는 각 checkout의 backend/에서 실행한다. baseline HEAD에도 **동일한 최종 benchmark 파일**을 복사하고 해당 checkout용 Prisma client를 생성한다. 아래 URL은 격리 fixture 예시이며 운영 URL을 사용하지 않는다.

```bash
DATABASE_URL='postgresql://ranking_test@127.0.0.1:55439/ranking_r07?schema=public' pnpm exec prisma migrate deploy
DATABASE_URL='postgresql://ranking_test@127.0.0.1:55439/ranking_r07?schema=public' pnpm exec prisma generate
NODE_ENV=test TZ=UTC RANKING_BENCHMARK=1 \
  DATABASE_URL='postgresql://ranking_test@127.0.0.1:55439/ranking_r07?schema=public' \
  RANKING_BENCHMARK_LABEL=baseline RANKING_BENCHMARK_OUTPUT=/tmp/baseline.json \
  pnpm exec tsx scripts/ranking-refresh-benchmark.ts
```

candidate는 label/output만 after로 바꾼다. burst는 RANKING_BENCHMARK_SHAPES=100/3/20 및 RANKING_BENCHMARK_MODES=burst를 추가한다. script는 생성한 fixture ID만 cleanup하며 빈 season/FX table을 검증한다. 기본 samples=3, shape는 위 6개다. P/H 상한과 explicit opt-in을 둔다.

## 6. 정확성 회귀

기존 실제 PostgreSQL test 두 개를 수정하지 않고 다시 실행했다.

- ranking-consistency.integration.spec.ts: 내부 **30개 scenario PASS**. 별도 instance participant↔scheduled/participant, stale scheduled equity 차단, 동일 capturedAt, previous-day, 같은 instance 다른 key, trailing pending 및 첫 실패 후 pending, ended/settled, participant 집합 변경, 시간 경계, all/top10/near_me 각각 metadata/count/my-before/my-after/page interleaving, pagination snapshot changed, hidden/excluded/not_joined/final, scope 오류, admin daily writer.
- season-ranking-scope.integration.spec.ts: 손상된 입력·기존 ranking의 fail-closed, 실제 settlement의 final 결과·participant 값·계정 종료 원자성, 실패 rollback, 기존 final 재사용 및 불완전 final 거절, settled 재작성 금지, repair 경로 PASS.
- 신규 unit은 마지막 history batch 손상도 모든 write 전에 실패하고, 동일 capturedAt에 current point를 잘못 추가하거나 future history를 누락하면 실패하도록 기대값을 고정했다. 기존 정책 기대값은 완화하지 않았다.

R12 reader Repeatable Read, R06 current-ranking-generation.ts, Season lock 자체는 수정하지 않았다. participant와 ranking write는 여전히 하나의 transaction으로 commit한다. final 생성 경로도 그대로다.

## 7. 전체 검증 결과

실제 명령·환경·개수는 [validation.json](validation.json)에 기록했다. 환경 파일 없는 테스트 checkout을 사용하고 PostgreSQL suite는 별도의 새 ranking_r07_regression에 기존 migration을 적용했다.

| 명령 / 범위 | 결과 |
| --- | --- |
| pnpm run typecheck | PASS |
| pnpm run build | PASS |
| pnpm exec jest --runInBand | 203 suites / 2,987 tests PASS; opt-in 등 44 suites / 48 tests SKIP |
| 실제 PG opt-in 13개 suite (아래 목록) | 13 suites / 13 wrapper tests PASS; 내부 scenario 실제 실행 |
| pnpm run test:e2e --runInBand | release-critical 341 tests PASS |
| 신규 파일 + ranking-refresh.service.ts strict ESLint | PASS |
| 수정 ranking 파일·신규 파일 Prettier check | PASS |
| portfolio-valuation.service.ts strict ESLint | 기존 Prettier 43개로 FAIL; HEAD 43개와 동일 |
| ranking-refresh.service.spec.ts strict ESLint | 기존 unsafe mock 7개로 FAIL; HEAD 7개와 동일 |
| valuation service에서 Prettier 규칙만 제외한 ESLint | PASS |
| git diff --check | PASS |

PG 명령은 `pnpm exec jest --runInBand`에 다음 파일들을 전달했다. 전체 command와 명시적 DB URL/opt-in 환경은 validation.json에 보존했다.

```text
src/ranking/ranking-consistency.integration.spec.ts
src/ranking/season-ranking-scope.integration.spec.ts
src/orders/limit-order-reservation.integration.spec.ts
src/orders/limit-order-create-race.integration.spec.ts
src/orders/limit-order-transaction-time.integration.spec.ts
src/orders/trading-transaction-time.integration.spec.ts
src/orders/trading-fee-pinning.integration.spec.ts
src/orders/limit-order-create-no-redis.integration.spec.ts
src/orders/limit-order-idempotent-replay.integration.spec.ts
src/orders/limit-order-matching.integration.spec.ts
src/orders/orders.execute.integration.spec.ts
src/fx/fx.execute.integration.spec.ts
src/mvp-flow.integration.spec.ts
```

settlement job, ranking 계산/read/write, 주문/FX/provider 선택 unit도 전체 unit 실행에 포함된다. 일반 unit에서 skip된 DB suite 중 위 13개는 별도로 실제 실행했다. 나머지 unrelated opt-in/external-provider suite, 운영 부하·다중 호스트 pool, peak memory는 측정하지 않았다.

성능 fixture는 최대 50만 history 행을 반복 생성하므로 일반 CI에 추가하지 않았다. 작은 deterministic source 재사용/history batch/publication unit tests는 기존 전체 Jest CI에서 자동 실행된다. 기존 CI의 ranking consistency/scope PostgreSQL gate는 그대로 유지했다.

GitHub API로 확인한 기준 HEAD [CI #119](https://github.com/windowsjd/trading_app/actions/runs/35717383936)는 전체 FAILURE이며 **Candle fixture integration**만 실패했다. Backend quality, Core account PostgreSQL, Limit order PostgreSQL, release-critical E2E, Frontend quality는 성공했다. 이는 기준 HEAD 상태이며 이번 미커밋 로컬 변경의 Actions 결과가 아니다. R10/Candle fixture는 수정하지 않았다.

## 8. 남은 확장성 한계

- 전체 참가자 valuation/holdings 조회와 전체 정렬은 남는다. 종목이 겹치지 않으면 가격 조회와 refresh-local source Map도 고유 종목 수에 따라 늘어난다.
- 모든 P×H history를 읽고 기존 MDD/reachedReturnAt 정렬·계산을 수행한다. 매우 긴 H는 여전히 큰 비용이다. 과거 snapshot은 삭제하지 않았다.
- participant UPDATE P회와 기존 set integrity 검사는 Season lock 안에 남는다. 개선 후 P=500 lock 중앙값도 약 232~281ms다.
- 같은 key의 trailing 병합만 유지한다. scheduler와 participant-change 또는 다중 instance의 중복 계산은 가능하다. stale 계산은 PostgreSQL에서 폐기하지만 이미 쓴 계산 비용은 회수하지 않는다.
- 로컬 warm fixture를 운영 pool/DB latency/contention에 그대로 대입할 수 없다. 실제 P/K/H, 종목 중복도, 거래 burst에서 query 수와 publication 지연을 추가 관측해야 한다.

## 9. 과도한 구현 검토

새 infrastructure, Redis authority, worker, queue, DB summary/cache state를 추가하지 않았다. production 추가 개념은 한 refresh의 source 읽기 context와 작은 publication helper 두 함수다. batch 크기는 내부 상수이며 새 설정 체계도 없다. source/금융 policy를 복제하지 않고 기존 함수를 호출한다. raw SQL bulk update나 MDD 알고리즘 변경 없이 12개 측정 조건 모두 감소가 확인되어 범위를 여기서 멈췄다.

## 10. 최종 자체 검토

tracked diff 및 신규 production/test/benchmark 파일을 끝까지 다시 읽고 독립 리뷰도 수행했다. 기존 무결성 기대값을 낮춘 수정, 대규모 이동, rename, format churn은 없다. 기존 lint debt 50건은 HEAD와 대조한 뒤 범위 밖으로 보존했다.

처음 clean이던 tree에 R07 관련 backend 코드·테스트·증거 문서만 추가했다. frontend, schema/migration, 금융 core, reader, settlement, trigger callback, CI에는 변경이 없다. R06/R12/participant generation과 current/final·정산·scope·동률/MDD/수익률·pagination을 정적 diff와 실제 PostgreSQL 회귀로 확인했다. 신규 병렬 실행이나 장기 write transaction은 추가하지 않았다.
