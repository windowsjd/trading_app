# Binance Futures Last Price 후속 보완·통합 검증

**현재 main에 대한 코드 보완 완료, 출시 검증은 PARTIAL이며 운영 적용은 보류한다.**
이번 재검증은 2026-10-10 KST에 수행했다. WSL 금융/Frontend 실패와 수집 시험의
시계 역행을 숨기지 않았다. 실제 24시간 시험은 아직 RUNNING이고, 수정 패치의
원격 CI는 실행하지 않았다. 운영 조회·쓰기·배포·활성화는 모두 실행하지 않았다.

최신 결과는 [집계 JSON](evidence/main-f512-recheck/summary.json),
[재현 절차](reproduction/README.md), 아래 A–G에 있다. 이전 작업의 원시 증거는
기존 `evidence/`에 그대로 보존했다. 이전 보고 본문은 Git의 `f512dab0`에서 확인할
수 있으며 당시 미완료 판정과 이번 결과를 구분한다.

## A. 변경 요약

- 요청 기준: `4e61bc4ae42e30e5c6d2ce4c8dc8f6ddc51619a4`.
- 이번 시작/최종 HEAD, 로컬 origin/main, 실제 원격 main:
  `f512dab0a612681b14e2320b6631a2bd7459a3c8`.
  `git ls-remote`로 원격 main을 확인했고 commit/push/merge/deploy하지 않았다.
  이번 변경은 uncommitted 패치다.
- 기준 이후 `cb02b4ac`, `c0d91862`, `64dc9e17`에 후속 보완이 이미 반영돼 있었다.
  Readiness의 만료 상품 누락과 catalog N+1(75→8 SQL)은 새로 재설계하지 않았다.
- 시작 working tree에는 기존 soak가 갱신하는 JSON/JSONL 두 파일만 변경돼 있었다.
  이 파일을 덮어쓰거나 되돌리지 않았다. 해당 unit/PG/Redis를 유지하고,
  새 `futures_recheck_*_test` DB와 Redis 10–15번에서 검증했다.
  `/tmp/trading-binance-rest-weight`의 병행 REST 수정과 다른 세션은 건드리지 않았다.
  [시작 상태](evidence/main-f512-recheck/repository-start.txt),
  [worktrees](evidence/main-f512-recheck/worktrees.txt).
- `.env.local`은 여전히 Render DB/Redis를 가리킨다. 비밀값은 출력·저장하지 않았다.
  DB 쓰기에 앞서 실제 서버의 data_directory가 `/tmp/futures-followup-pg/data`인지
  확인했다. 모든 연결은 `127.0.0.1:55439` PG / `127.0.0.1:56389` Redis다.

이번 변경 파일과 이유:

| 파일 | 변경 이유 |
|---|---|
| `backend/scripts/futures-price-readiness.ts` | 지나간 endAt의 active 시즌도 검사; Worker dryRun과 보호 기능 설정 읽기 |
| `backend/scripts/lib/futures-readiness.ts`, `.spec.ts` | preview-only Worker·비활성 보호 기능의 잘못된 성공 차단, 모드별 회귀 |
| `backend/scripts/futures-price-safety-integration.ts` | 실제 CLI의 위 경계조건, 실제 최신 관측을 보장하는 Retention fixture |
| `backend/scripts/futures-read-api-benchmark.ts` | 부하 중 늘어나는 PostgreSQL backend PID까지 CPU 계측 |
| `backend/docs/futures-last-price-contract.md` | 새 판정 조건 명시 |
| `backend/docs/futures-risk-contract.md`, `codex-rulepack.md` | 남아 있던 Spot 종료·TP/SL 설명을 현행 Last 계약과 일치시킴 |
| `reproduction/run-core-gate.sh`, `README.md` | 최신 CI의 추가 계정 suite 및 정확한 pnpm/REST opt-in 명령 |
| `reproduction/reproduce-readiness-regression.sh` | DB 없는 변경 전/후 결함 재현 |
| 이 보고서와 `evidence/main-f512-recheck/` | 최신 실행 결과·실패·부하·진행 상태 보존 |

추가 확정 결함은 다음과 같다.

1. Readiness는 ended/settled 상태만 읽어서 **endAt은 지났지만 status=active인
   시즌**의 누락된 정산 증거를 보고하지 않았다. 실제 PG에서 재현·수정했다.
2. 활성 보호주문이 있어도 `CONDITIONAL_ORDERS_ENABLED=false`를 판정하지 않았다.
   Worker가 정상 `disabled` 결과를 보고하면 launchReady가 true가 될 수 있었다.
3. 성공한 `dryRun=true` Ops 기록도 실제 Worker 실행으로 인정했다.
   2·3은 같은 입력에서 변경 전 true/변경 후 false로 재현했다.
   [재현 결과](evidence/main-f512-recheck/readiness-before-after-reproduced.json).
4. Retention 테스트의 `now+1ms`는 시계 역행 후 실제 최신 행이 아닐 수 있었다.
   그 행을 정상 삭제한 SQL을 잘못 실패로 판정했다. 같은 source의 실제 최대
   capturedAt+1ms로 fixture를 고쳤으며 보존 검증은 유지했다.
5. 과거 benchmark의 PG CPU는 시작 시 PID만 계산해 부하 중 추가된 연결을
   누락했다. 계측만 수정했다. 과거 PG CPU 수치를 현재 값과 직접 비교하지 않는다.

Retention SQL의 금융 삭제 결함과 신규 체결/원장 로직 회귀는 확인하지 못했다.
WSL 시계 가설은 동일 HEAD의 실제 Ubuntu 결과로 추가 검증했지만, 모든 로컬
실패의 개별 인과를 확정했다고 주장하지 않는다.

## B. 요구사항 충족 여부

| 항목 | 상태 | 근거/잔여 항목 |
|---|---|---|
| Readiness | PASS | 32개 단위/배치 검사, 실제 CLI 포함 PG 12그룹; 22개 만료+1개 정상 거부 유지 |
| Retention 안전성 | PASS | 실제 10만/200만 행, FK 경합 양방향·Ops lease·재실행·가격 증거 보존 |
| 금융 회귀 | PARTIAL | Ubuntu 동일 HEAD 금융 23/23·Frontend 2120/2120; 현재 WSL은 2개/1개 실패 |
| API 성능 | PASS | 실제 HTTP/PG 50 소유자, C=1/10/50, 8/31 SQL 재확인; 10,000명 수용 검증은 PARTIAL |
| 수집 안정성 | FAIL | 300초 종료 시험의 금융·출처·복구 조건은 통과, clock 조건 실패 |
| CI 통합 | PARTIAL | 현재 원격 5/6 jobs 성공; 기존 quest 진단 위반으로 전체 FAIL; 최종 패치 원격 NOT_RUN |
| 실제 24시간 이상 | PARTIAL | 기존 전용 unit RUNNING, 고정 사본 6896.288초, actual24hCompleted=false |
| 운영 절차 검토 | PASS | 기존 계약/운영 문서 확인·보완; 운영 실행 자체는 NOT_RUN |

대상은 **활성 등록 상품 전체 + 금융 작업이 남은 비활성 상품**이다. 만료된 활성
등록 상품을 필터링해 숨기지 않는다. 등록하지 않은 비지원 자산 및 작업 없는
의도적 비활성 상품은 제외한다. Last/Mark/risk 설정은 DISABLED 출시 점검에서도
필수다. 보호 기능은 Futures 보호주문이 있을 때 필요하다.

설정, 실제 가격 유효성, launchReady/existingWorkReady, 모드별 사용자 거래 가능
추정을 구분한다. Worker 관측은 실제 작업이 있을 때 필요한 최근 120초 이내의
완료·성공·dryRun=false 기록이다. 개별 실행 오류도 실패이며 정상 지정가 미도달은
허용한다. idle Worker는 healthy로 주장하지 않는다. 이 관측은 모든 idle 프로세스의
상시 heartbeat나 transport 연결 상태를 보장하지 않는다.

## C. 금융 불변조건 검증

| 불변조건 | 확인 근거 |
|---|---|
| Spot / Futures Last / Mark 분리 | 별도 테이블·validator·출처, 실제 세 수집기 동시 기록, 기존 domain 분리 테스트 |
| 체결·TP/SL·정산 증거 보존 | 실제 execution/trigger/pin 생성 후 삭제·경합·반복 실행에서 FK와 행 불변 확인 |
| 기존 금융 기록 불변 | 이번 패치는 금융 writer/schema/migration을 변경하지 않음; 기존 legacy Spot replay/pin 회귀 유지 |
| 강제청산/평가 Mark 유지 | liquidation/valuation 경로 무변경, Ubuntu Futures risk/F3/F3.1 및 로컬 해당 suites 통과 |
| 잠금·멱등성·원장 | 기존 금융 22 suites, core 23 suites, 레이스/재생/시즌 정산 회귀를 실제 실행 |
| 주문 생성 이전 증거 사용 금지 | 기존 matcher/Conditional 통합 계약 유지, locked price re-read 경로 무변경 |
| Fail-Closed | 신선도·미래시각·identity 검증 무완화; 환경 clock 오류도 실제 가격 거부로 남김 |

새 price cache, fallback, 금융 계산식/모드/수수료/담보 정책, 사용자 DTO/API,
Frontend 제품 코드 또는 `/api/v2` 경로를 추가·변경하지 않았다. 과거 Spot pin은
기존 증거를 재사용하고 새 pin은 Last를 재사용하는 기존 회귀를 유지했다.

## D. 테스트 결과

이번 로컬 환경: Node 24.14.1, pnpm 10.33.0, npm(Frontend), PG16.15 UTC,
Redis7.0.15, WSL2 6.6.87.2. fsync/synchronous_commit=on.
추출 PG의 LLVM/JIT 누락 때문에 **새 safety/perf 전용 DB**에만 jit=off 설정을
적용했다. 기존 soak 또는 공유 서버의 설정을 변경하지 않았다.
모든 긴 실행은 기존 run-bounded.py의 프로세스 그룹 RSS/monotonic 시간 제한을
사용했다. OOM/시간 초과 종료는 없었다.

| 실제 명령/게이트 | 통과/실패 | 증거 (`evidence/main-f512-recheck/`) |
|---|---|---|
| `pnpm run typecheck`, `build`, `lint:accounts:check`, 새 파일 prettier | PASS | `backend-quality*.json/.log` |
| `pnpm exec jest --runInBand` | 4162 PASS, 0 FAIL; opt-in 84 skip, 256 suites PASS | `backend-unit-jest.json` |
| readiness/배치 2 suites | 32 PASS, 0 FAIL | `readiness-unit-jest.json` |
| `pnpm run test:e2e --runInBand` | 409 PASS, 0 FAIL, 2 suites | `backend-e2e-final-jest.json` |
| 실제 PG safety Jest | 1 PASS, 내부 12그룹 | `price-safety-final*.json` |
| 실제 PG safety 200만 행 직접 실행 | 12그룹 PASS | `retention-2m-final*.json` |
| CI core 및 최신 추가 quest suite(순차) | 합계 24 PASS, 0 FAIL, 23 suites | `core-jest.json`, `core-quest-jest.json` |
| 기존 CI 금융 22 suites | 21 PASS / 2 FAIL; 20 suites PASS / 2 FAIL | `financial-jest.json` |
| 공유 REST Redis fixture | 18 PASS, 0 FAIL, skip 0 | `rest-redis-final-jest.json` |
| `npm run check` | lint/typecheck PASS; 2119 PASS / 1 FAIL, 205 suites, skip 0 | `frontend-check.log` |
| migrate deploy/status/drift | 기존 70개 적용, up to date, no difference | `migrate-*.log`, `migration-status-drift.log` |
| 변경 파일 diagnostic gate | PASS | `diagnostic-working-tree.log` |
| 실제 CI 기준 diagnostic gate | 기존 quest 파일 2 findings, FAIL 재현 | `diagnostic-ci-base.log` |

로컬 금융 실패는 Conditional `CONDITIONAL_PRICE_UNAVAILABLE` 및
order-input-policy의 `ASSET_PRICE_UNAVAILABLE`이다. 금융 실행 202.154초 동안
6번 약 −1.96~−2.06초 clock step을 기록했다. 이전 FX/risk 실패와 지점이 다르며
새 DB에서도 나타났다. 미래 관측을 제외하는 정상 가격 정책과 일치하지만 모든
실패의 순간 DB 행/시계 관계를 복원한 것은 아니다.

Frontend는 `FuturesScreen.test.ts`의 season B Long Isolated 37x 케이스에서
submit이 enabled 대신 disabled였다. Fixture는 실제 Date.now 기반 가격을 쓰며,
173.942초 실행 중 clock step 5회를 기록했다. 가격 시각 검사를 느슨하게 하거나
테스트를 삭제·skip/가짜 PASS 처리하지 않았다.

**동일 현재 HEAD의 실제 Ubuntu CI**:
[run 38034977229](https://github.com/windowsjd/trading_app/actions/runs/38034977229)
(2026-10-10 16:36–16:41 KST). 금융 22 suites/23 tests, 신규 PG safety 1 test,
core 23 suites/24 tests, E2E 409 tests, Frontend 2120 tests가 모두 통과했다.
Backend 단위도 4158 PASS였다(이번 추가 단위 4개 이전).
원격 job/log를 읽기 전용으로 수집했으며 새 workflow를 트리거하지 않았다.
`github-current-jobs.json`, `github-*-excerpt.log`, `github-frontend-counts.log`에
근거가 있다. 이는 변경 전 옛 4e61 HEAD 결과가 아니라 **이번 시작 HEAD의 결과**다.
다만 이번 uncommitted Readiness 추가 패치의 원격 CI 결과로 대체하지 않는다.

원격 전체 실패는 `beginner-quests.service.ts:286–287`의 direct HttpException/
structured error 진단 정책 위반이다. 이번 가격 작업과 무관한 기존 결함으로
보고하며 quest 제품 동작은 수정하지 않았다. 현재 CI 게이트를 줄이지 않았다.

초도 실행 오류도 보존했다: 새 fixture의 잘못된 `trigger=manual` enum, pnpm의
불필요한 `--`에 의한 E2E 미실행, 잘못된 REST opt-in에 의한 skip-only 결과,
sandbox git spawn EPERM, 시계 역행 후 최신 행이 아닌 Retention fixture.
각 원인을 수정/실행 환경을 분리한 뒤 실제 검사 수를 확인했다. 해당 초도 결과를
PASS로 집계하지 않는다. 실행 가격의 시각이나 보존 SQL을 수정해 통과시키지 않았다.

## E. 성능 및 장시간 검증

실제 Nest HTTP/FuturesService/PG, 23상품, 50 독립 소유자, 계정당 Cross 포지션
2개, catalog/positions 50:50, Last/Mark/FX 1초 feed, C=1/10/50 각 12초다.
다른 사용자로 두 route를 읽으면 각각 404임도 검사했다. 인증은 fixture header며
JWT 비용·인터넷 RTT·다른 제품 API는 제외된다. 추가 소유자의 포지션은 조회용
fixture 복제이고 100포지션 동시 금융 체결을 측정한 것은 아니다.
기존 24h 수집은 같은 PG 서버의 다른 DB에서 동시에 실행됐다.

| 동시 요청 | req/s | catalog p50/p95/p99 ms | positions p50/p95/p99 ms | SQL/s | Node/해당 PG backend CPU % core | Node RSS MiB / 연결 |
|---|---:|---|---|---:|---|---|
| 1 | 153.36 | 3.07/3.83/5.52 | 9.66/11.92/13.83 | 3000.67 | 68.29/39.96 | 522.54 / 3 |
| 10 | 316.20 | 15.48/19.38/21.72 | 47.07/52.58/55.88 | 6176.06 | 101.73/71.31 | 616.79 / 10 |
| 50 | 325.29 | 166.80/189.61/204.48 | 139.74/163.29/173.85 | 6346.62 | 100.96/74.69 | 623.48 / 10 |

[원본 SQL·실측](evidence/main-f512-recheck/api-50-owners.json).
응답 오류/누락 가격/feed 오류는 0이다. catalog 8 SQL, positions 31 SQL/req다.
기존 작업의 실제 전후 측정은 [이전 비교](evidence/api-summary.json)에 있으며
catalog 75→8, C=50 처리량 약 126→323 req/s였다. 현재 읽기 경로는 그대로
유지하고 추가 리팩터링하지 않았다. PG CPU는 이번에 pool 증가분을 포함하므로
과거 시작 PID만 측정한 값과 비교하지 않는다. PG backend RSS 합계는 shared
mapping을 포함하며 전체 서버 RAM 사용량과 다르다.

**10,000명은 산술 추정이고 실측이 아니다.** 독립 그룹으로 detail 2%(200명)가
두 API를 2초마다, market 5%(500명)가 catalog를 5초마다, holdings 2%(200명)가
positions를 2초마다 사용한다고 가정하면 각 200 req/s, 총 400 req/s와
7800 SQL/s다(이전 21200). 측정한 단일 Node 약 325 req/s를 넘는다.
앱은 focus/enabled 조건을 쓰고 동일 query key의 in-flight 요청을 억제하지만
이용자별 account query 전체를 공유 캐시로 상쇄한다고 추정하지 않았다.
실제 배포의 도착 부하·다중 instance·수집/금융 간섭·SLA는 미검증이다.

Retention: 실제 200만 행 전체 삭제, EXPLAIN의 1000행 이후 drain 33350.96ms,
약 59938 rows/s; plan 11.503ms다. candidate/newer 조회와 PK DELETE가 index를
사용했다. 10만 행 계획은 전체 스캔·정렬/spill도 관측했고 약 13121 rows/s였다.
계획이 모든 규모에서 동일하다고 주장하지 않는다. 작은 금융 참조 테이블의
스캔은 정상이며 대형 운영 ledger/다수 시즌에서의 비용은 별도 검증이 필요하다.
현재 실측으로 SQL이나 보존 정책을 변경할 근거는 부족했다.

완료된 단기 수집은 **300.015827초**다. Last 4269행/2482176 bytes,
Mark 6026행/3481600 bytes, Spot 1197행/1794048 bytes다.
Last accepted frame 11589, Spot received frame 11585; Mark frame 수는 별도
계측하지 않았으며 저장 행 수와 혼동하지 않는다. Last/Mark 연결은 각 3회,
Spot reconnect 0. REST는 exchangeInfo 2회, Last ticker 79회, Mark 8회,
Spot 5회였다. 계획 장애의 transport 실패 11건을 기록했고 실제 429/418은 0이다.
429/418/cooldown/Redis 실패는 별도 18개 fixture에서 검증했다.
Node 평균 CPU 8.36% core, peak RSS 417.02MiB였다.
시장가 9회 p50/p95/p99=41.57/66.25/66.25ms,
지정가 8회 실제 체결=1945.45/3062.62/3062.62ms,
대기 평가=3.15/3.96/3.96ms였다. 계획 장애 pending/cancel 1회,
예상 밖 금융 오류 0, 비정상 프레임 5종 모두 거부, 최종 23종 가격 회복이다.
신선도 평가 23개 중 누락 0이지만 clock step이 있어 전체 **FAIL**이다.
[원본](evidence/main-f512-recheck/soak-300.json), 시간/RSS는 `soak-300-run.json`.

기존 24h unit `trading-futures-soak-followup-24h-v2`는 중단하지 않았다.
시작 **2026-10-10 15:31:49 KST**, PG `futures_soak_24h_final_test`, Redis DB 5,
4GiB cgroup/2GiB Node heap/27시간 상한이다. 이번 고정 사본은
**6896.288초(약 114.94분), RUNNING, actual24hCompleted=false**다.
677 신선도 평가 표본 중 누락 0, 시장가 229회/지정가 228회, 예상 밖 금융 오류 0,
clock step 212회, peak Node RSS 444.97MiB다. 당시 Last 101510행/60358656 bytes,
Mark 148901행/85745664 bytes, Spot 27372행/37658624 bytes였다.
Retention 최근 run은 성공/삭제 0이었다(보존 기본 24시간 미도달).
[고정 사본](evidence/main-f512-recheck/soak-24h-observed.json),
[실제 unit 상태](evidence/main-f512-recheck/soak-24h-service.txt),
[출처별 DB 집계](evidence/main-f512-recheck/soak-24h-source-counts.txt).
이 관측은 완료된 24시간 검증이 아니다.

`Linger=no`이고 WSL 종료/로그아웃 이후 지속성은 보장되지 않는다.
자연 24시간 재연결·계약 만료/갱신·누적 후 Retention·장기 RSS/지연 추이는 아직
검증 완료가 아니다. 지속 시험은 구성·실행 중이나 **안정적인 clock 환경의
24시간 PASS**가 없고 현재 clock 조건으로는 최종 FAIL이 예상된다.
시계를 수정하거나 관측 오류를 무시하지 않았다. 일부 시장 시간대의 단기 결과로
고변동 시장 안정성을 확정하지 않는다.

## F. 운영 적용 준비

기존 [Last 계약](../../../backend/docs/futures-last-price-contract.md) 및
[F3 운영 절차](../../../backend/docs/futures-f3-contract.md#migrations-and-release-operations)를
따른다. 중복 운영 문서를 추가하지 않았다.

1. 최종 패치의 안정 Linux 금융/전체 CI와 24h 결과, 목표 workload/SLA를 확인한다.
   운영 접근 승인 후 기존 열린 포지션·제출 지정가·TP/SL·시즌 경계 증거를 점검한다.
   이번에는 운영 inventory를 조회하지 않았으므로 기존 조사 수치를 현재값으로 쓰지 않는다.
2. 구 서버와 additive migration의 호환성을 확인하고 migration을 적용한다.
   이번에 새 migration은 없다. 기존 70개 체인/status/drift는 새 격리 PG에서 통과했다.
   모든 API/financial worker를 Last evidence-aware 버전으로 전환한다.
3. 검토한 exact 계약만 provision dry-run 후 승인된 등록 단계에서 적용한다.
   등록 직후 공식 coverage를 재확인한다. 25개 Spot 중 과거 23개 적격/2개 제외 결과는
   당시 공개 데이터이며 실제 운영 등록 전 exchangeInfo를 다시 확인한다.
4. DISABLED에서 Mark ingestion(5분 coverage 갱신), Last ingestion, risk를 가동한다.
   금융 작업이 있는 matcher/Conditional/risk의 실제 Ops 관측과 보호 기능 설정,
   전체 대상 Last/Mark 신선도, endAt 증거를 확인한다. 등록 직후 가격이 없으면 실패다.
5. `futures:price-readiness --require-ready`를 mode 변경 직전/직후 실행한다.
   승인된 최소 계정으로 시장가·지정가·TP/SL·replay·원장·종료/정산 금융 smoke를
   수행하고 REDUCE_ONLY/ENABLED를 별도 운영 결정으로 단계 적용한다.
6. 계약 만료·가격 누락·Worker 장애 시 신규 진입을 REDUCE_ONLY로 차단하고
   Last/Mark/risk 수집을 유지한다. Last가 없으면 사용자 종료도 fail closed다.
   금융 무결성 사건에는 DISABLED가 필요할 수 있다. DISABLED는 독립 risk/시즌
   정산 Worker까지 멈추는 스위치가 아니므로 혼합 writer를 방지한다.
7. 첫 Last execution/trigger/pin 이후 pre-Last 코드 단순 롤백은 안전하지 않다.
   nullable Spot relation 오독, 정산 재시도 실패 또는 다음 체결 정책 변경 위험이 있다.
   migration과 증거를 보존하고 호환 코드/roll-forward로 복구한다. 과거 Spot pin과
   새 Last pin은 각각 기존 증거로 재시도한다. 과거 기록 재작성/down migration은 금지다.

별도 승인 사항: 운영 DB 읽기/검증·migration·상품 등록, Render 배포/환경변수,
거래 모드 전환, 실제 운영 smoke/복구. 이번에는 어느 것도 수행하지 않았다.
현재 release blockers가 남아 있어 운영 승인 요청이나 배포를 진행하지 않는다.

## G. 최종 자체 검토

전체 변경 diff, 작은 원시값 단언, 초기 실패와 최종 결과를 검토했다.
금융 writer/가격 정책/잠금/멱등성/schema/Frontend 제품 동작은 변경하지 않았다.
Readiness read-only 도구·fixture·계측·관련 문서만 보완했다. 시험과 가격 보존
조건을 삭제/완화하지 않았고 새 test skip은 없다. 테스트는 boolean/문자열/ID로
검증하여 대형 ReactTestInstance를 actual로 넘기지 않았다. 증거 폴더에서 실제
`.env` 비밀값이 포함되지 않았음도 검사했다. 생성·실행한 프로세스는 모두 종료했으며
작업 시작 전부터 실행된 기존 24h unit은 계속 유지했다.

잔여 우선순위:

- P1: 안정 clock 환경에서 최종 패치 금융/Frontend/통합 게이트, 24h 완료·판정.
- P1: 현재 CI의 기존 quest 진단 정책 위반 해결 및 최종 패치 원격 CI.
- P2: 실제 배포 자원과 도착 부하에서 목표 사용자 규모, 운영 ledger/다수 시즌 비용 검증.
- 운영 전: 승인된 실제 inventory/상품/배포 전환 점검과 금융 smoke.

**구현 보완 완료와 출시 준비 완료를 구분한다. 현재 근거로 운영 활성화는 권고하지 않는다.**
