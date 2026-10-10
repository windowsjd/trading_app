# Binance Futures Last Price 후속 보완·통합 검증

구현과 문서 보완을 완료했다. **출시 검증은 PARTIAL**이다. 현재 WSL 금융
게이트가 통과하지 않았고, 최종 패치의 원격 CI 및 24시간 검증도 완료되지
않았다. 실패를 성공으로 처리하거나 가격 안전 조건을 완화하지 않았다.

## A. 변경 요약

- 시작 HEAD, origin/main 및 확인한 원격 main:
  `4e61bc4ae42e30e5c6d2ce4c8dc8f6ddc51619a4`. 시작 시 main working tree는 깨끗했다.
  병행 변경과 worktree를 조사한 뒤 현재 checkout에서 작업했다. commit,
  push, merge, 강제 push 및 배포를 하지 않았다. 최종 상태는
  [repository-final.txt](evidence/repository-final.txt)에 기록한다.
- `.env.local`의 DB/Redis가 Render 원격 대상을 가리킴을 확인했다. 값이나
  자격 증명을 증거 파일에 복사하지 않았다. 운영 DB 조회도 하지 않았다.
  모든 실 DB 명령은 명시적 `127.0.0.1:55439` PostgreSQL과
  `127.0.0.1:56389` Redis 및 새 `_test` DB에서 실행했다.
- 확정한 기존 결함: readiness가 `active && verified` 항목만 blocker로
  계산하여 만료된 상품을 숨겼고, 일부 정상 상품만으로 성공할 수 있었다.
  필수 ingestion/risk 구성과 작업이 있는 worker의 관측도 판정에 없었다.
- 확정한 조회 병목: 23종 catalog에서 Last/Mark 조회가 종목 수에 비례하여
  총 SQL 75개였다. 두 배치 조회로 총 8개가 됐다. positions는 31개를 유지한다.
- 기존 retention SQL의 금융 증거 삭제 결함은 확인하지 못했다. 실제 경합과
  200만 행 검증을 추가했고 SQL, FK, 보존 정책 및 migration을 변경하지 않았다.

변경 코드와 목적:

| 파일 | 목적 |
|---|---|
| `backend/scripts/futures-price-readiness.ts` | READ ONLY CLI의 전체 대상, 가격/구성/worker/종료 시즌 증거 판정과 진단 |
| `backend/scripts/lib/futures-readiness.ts`, `.spec.ts` | 독립 판정 정책과 실패/정상 대기/모드 시나리오 |
| `backend/src/futures/futures-reference-prices.ts`, `.spec.ts` | parameterized Last/Mark 배치 조회, 기존 우선순위·검증 유지 |
| `backend/src/futures/futures.service.ts` | instruments 조회만 배치 helper 사용 |
| `backend/scripts/futures-price-safety-integration.ts` | 실제 PostgreSQL 보존·경합·재시작·정산 readiness 검증 |
| `backend/src/futures/futures-price-safety.integration.spec.ts` | 명시적 opt-in으로 위 게이트 실행 |
| `backend/scripts/futures-read-api-benchmark.ts` | 실제 Nest HTTP/PG, 독립 소유자, SQL/지연/CPU/메모리 계측 |
| `backend/scripts/futures-collection-soak.ts` | 실제 Last/Mark/Spot·worker·금융 probe·장애 및 장시간 계측 |
| `.github/workflows/ci.yml` | 기존 금융 게이트 뒤 별도 DB의 readiness/retention 게이트 추가 |
| `backend/docs/futures-last-price-contract.md`, `futures-f3-contract.md` | 판정 의미, 적용 순서, 혼합 writer·롤백 제한 보완 |
| 이 조사 폴더의 `reproduction/`, `evidence/` | 명령, 자원 제한, 원시 결과 및 재현 절차 |

## B. 요구사항 충족 여부

| 요구사항 | 상태 | 실제 근거/남은 일 |
|---|---|---|
| A 전체 대상 readiness | PASS | 새 정책/배치 단위 28개 및 실제 CLI 검증. 22개 만료+1개 정상은 실패 |
| B Last 증거 보존·삭제 안전 | PASS | 100,000행 최종 10그룹, 2,000,000행 9그룹, FK 양방향 경합·lease·재실행 |
| C 금융 회귀 분리/전체 통과 | PARTIAL | 전체 단위/E2E/frontend/core PASS. WSL 금융 게이트 FAIL. 변경 전 Ubuntu CI PASS |
| D 실제 조회 측정/필요 최적화 | PASS | 실제 HTTP/PG 전후 및 50 독립 계정. 10,000명 수용 판정은 PARTIAL |
| E 단기 전체 안정성 | FAIL | 수집·출처·재연결·복구 관측. 반복 clock step 및 수정 전 probe 오류 때문에 전체 FAIL |
| E 실제 24시간 이상 | PARTIAL | 최종 전용 systemd unit RUNNING. 86,400초 완료/최종 판정은 아직 없음 |
| F 최종 패치 원격 CI | NOT_RUN | uncommitted 패치. push/deploy hook 안전성이 확인되지 않아 원격 실행하지 않음 |
| F migration/status/drift | PASS | 격리 PG16에 기존 70개 migration 모두 적용, status 정상, drift 없음 |
| G 적용·롤백 검토 | PASS | 기존 계약 문서 보완. 운영 적용/롤백 실행 자체는 NOT_RUN |

readiness의 active 등록 상품은 계약 만료/검증 실패 상태에서도 대상이다.
비활성이고 금융 작업이 없으면 제외하지만 열린 포지션/제출 entry/살아 있는
TP/SL은 가격과 실제 worker 관측을 요구한다. 필수 구성은 DISABLED에서도
출시 판정에 필요하다. idle worker는 생존 확인으로 주장하지 않는다.
최신 성공 run은 완료 시각이 현재 이하이며 120초 이내여야 한다. stale
price 등 실행 오류가 담긴 성공 run도 실패다. 명시적인 limit-not-reached
결과만 정상 대기로 구분한다. 종료 시즌의 미고정 후보와 Last/legacy Spot
pin은 별도 판정한다. 최종 실수집 DB의 실제 read-only CLI도 23/23 target과
실제 pending worker run으로 launchReady=true, blocker 0을 확인했다
([JSON](evidence/readiness-live-at-handoff.json)). checker 모드는 DISABLED라
newTradingAvailable=false이며 이를 현재 unit의 거래 활성화 주장으로 사용하지 않는다. `userExitsAvailable` 등은 운영 준비 추정치이며 실제
명령의 Reduce/Close 권한이나 Mark 없이 가능한 기존 동작을 바꾸지 않는다.

## C. 금융 불변조건 검증

| 불변조건 | 변경/검증 |
|---|---|
| Futures Last = 실행·entry·TP/SL·종료 가격 | 유지. 배치/개별 조회 실제 PG parity, stale newest/older REST 부활 방지 |
| Mark = UPNL/위험관리/강제청산 | 유지. 배치도 WS 우선 및 기존 Mark REST만 선택 |
| Spot/Futures 출처 분리 | 유지. 실제 25 Spot/23 Futures 수집 및 기존 E2E/financial/core 검증 |
| 가격 없으면 fail closed, 시각/계약 검증 | 유지. freshness 상수, validators, source/product/currency 정책 변경 없음 |
| Decimal·원장·예약·계정 소유권/분리 | 유지. 조회 helper는 읽기 전용; 명령/lock/settlement/ledger 코드 변경 없음 |
| idempotency/replay/rollback·One-way/OCO | 기존 테스트와 core gate 유지. 새 PG fixture도 기존 명령을 사용 |
| 과거 Spot 실행/종료 pin 재사용 | 기존 호환 테스트 유지. 새 CLI는 legacy pin도 검증하고 재작성하지 않음 |
| immutable evidence와 FK | execution/trigger/pin 행이 삭제 전후 동일하고 모든 참조 snapshot 생존 |
| 미고정 시즌 가격 | endAt−10s/endAt 경계 포함, 경계 밖 삭제, 미고정 후보 유지 |
| 실행 중 삭제/다중 worker | SKIP LOCKED 및 FK race 두 순서, Ops lease takeover/fencing, 실패 후 재실행 |

시즌 종료·liquidation을 실제 운영에서 다시 실행한 것이 아니다. 위 근거는
격리 fixture 및 명시된 테스트다. 호환 migration의 down/rewrite는 실행하지 않았다.

## D. 테스트 결과 및 실패 분석

환경: Node 24.14.1, PostgreSQL 16.15 UTC, Redis 7.0.15, WSL Linux.
DB는 각 게이트별 독립 이름, Redis fixture는 독립 DB 번호다. 자식 프로세스
전체 RSS/시간 제한과 monotonic/wall 차이를 로그에 남겼다.

| 검사 | 결과 | 증거 |
|---|---|---|
| backend 전체 단위 최종 | 4,143 PASS, 0 FAIL, DB/환경 opt-in 83 skip; 255 suites PASS | [JSON](evidence/backend-unit-complete-jest.json), [실행](evidence/backend-unit-complete.json) |
| backend E2E | 404/404 PASS, 2 suites | [JSON](evidence/backend-e2e-jest.json) |
| 신규 readiness/배치 | 28/28 PASS; 전체 단위에도 포함 | [JSON](evidence/readiness-batch-final-jest.json) |
| 신규 실제 PG 게이트 | 1/1 Jest PASS, 내부 10그룹 PASS | [결과](evidence/price-safety-verified.json), [실행](evidence/price-safety-verified-run.json) |
| 200만 행 retention | 9그룹 PASS | [실측/EXPLAIN](evidence/price-safety-scale.json) |
| core CI 22 suites | 22 PASS, 23 tests PASS | [JSON](evidence/core-gate-jest.json), [실행](evidence/core-gate.json) |
| 기존 금융 CI 22 suites 첫 실행 | 20 PASS / 2 FAIL, 21 tests PASS / 2 FAIL | [JSON](evidence/financial-gate-jest.json) |
| 기존 금융 CI 22 suites 최종 실행 | 19 PASS / 3 FAIL, 20 tests PASS / 3 FAIL | [JSON](evidence/financial-gate-final-jest.json), [실행](evidence/financial-gate-final.json) |
| 공유 REST Redis integration | 18/18 PASS, mocked HTTP 429/418/cooldown/fail-closed | [JSON](evidence/rest-redis-jest.json) |
| frontend npm check | lint/typecheck + 2,105/2,105 PASS, 203 suites, skip 0 | [로그](evidence/frontend-check-unsandboxed.log), [실행](evidence/frontend-check-unsandboxed.json) |
| backend typecheck/build/gated lint | PASS | `backend-typecheck-final.log`, `backend-build-final.log`, `backend-lint-final.log` |
| diagnostic / 새 파일 prettier | PASS | `diagnostic-enforcement-final.log`, `new-files-format.log` |
| migration deploy/status/drift | PASS (기존 70개; 새 migration 없음) | `migrations.log`, `migration-status.log`, `migration-drift.log` |

첫 금융 실패는 wallet-fx-transfer의 `PROVIDER_RATE_UNAVAILABLE`,
order-input-policy의 `FX_RATE_UNAVAILABLE`이었다. 최종 실행은 wallet-fx-transfer
`FX_RATE_UNAVAILABLE`, futures-risk/F3의 `FUTURES_PRICE_UNAVAILABLE`이다.
isolated-boundary와 order-input-policy는 이번 최종 실행에서 통과했다.
실패가 순서/실행마다 바뀌었으며 서로 다른 새 DB에서도 나타났다.

독립 wrapper가 약 32.5초 monotonic 주기마다 wall clock −1.8초 내외의
역행을 기록했다. 최종 금융 실행은 171.470초에 6번 역행했다. 증거를
저장한 직후 DB clock이 역행하면 미래 증거 제외 조건이 정상적으로 가격을
거부한다. 오류 지점/변동 양상과 일치하지만 **각 실패의 인과를 전부
확정한 것으로 주장하지 않는다**. 새로운 실행 가격/FX 로직 결함이나
DB 공유 오염은 확인하지 못했다. 안전 조건·fixture 시각 정책을 완화하지 않았다.

동일 시작 HEAD의 실제 GitHub Ubuntu24 CI는 2026-10-10 05:25–05:29 UTC에
6 jobs 모두 성공했고 금융 게이트 22 suites/23 tests도 모두 통과했다.
[실제 run](https://github.com/windowsjd/trading_app/actions/runs/38027432956),
[job 메타데이터](evidence/github-baseline-jobs.json),
[금융 로그 발췌](evidence/github-baseline-financial.log).
이는 환경 가설을 지지하는 **변경 전 결과**다. 최종 패치의 안정적 Linux
전체 금융/원격 CI 결과로 대체할 수 없다.

sandbox에서 backend tsx IPC/git spawn EPERM이 있었고 frontend Node test는
내부 테스트를 실행하지 않은 채 파일 154개만 성공으로 표시했다. 이 결과는
유효한 전체 테스트 PASS로 사용하지 않았다. 정상 프로세스 환경에서 전부
재실행해 위 개별 테스트 수를 확인했다. 탐색용 전체 tsconfig 검사에는
기존 spec 타입 오류도 있으므로 공식 `pnpm run typecheck`와 구분한다.

신규 계측 오류도 숨기지 않았다: probe 계정의 One-way 충돌, 정상 지정가
대기 오분류, order status(`executed`) 및 close leverage 누락, PG 통계 bigint
직렬화, 계획 WS/REST 장애 동안 체결 timeout 처리였다. 수정 전 FAIL/
INTERRUPTED 로그를 보존했다. 최종 probe는 별도 소유자, execution FK,
실제 정상 close를 사용하며 계획 장애에서 pending을 확인하고 정상 cancel로
예약을 해제한다. 계획 구간 밖 timeout은 계속 실패다. 추출 PG의 LLVM JIT
라이브러리 누락은 전용 대량 테스트 DB의 JIT만 꺼서 해결했다.

## E. 성능 및 장시간 검증

실측은 실제 Nest HTTP + FuturesService + PG다. 인증만 fixture header로
대체했다. 23개 검증 상품, 계정당 Cross 포지션 2개, 1초 Last/Mark/FX feed,
catalog/positions 50:50, 각 concurrency 12초 closed-loop다. 전후 1계정
조건을 맞췄고 추가 50 소유자 검증을 했다. 50 소유자 시험은 실수집과 같은
PG 서버의 다른 DB에서 동시에 실행됐다. 사전 positions도 거래 명령으로
만들었으며 추가 소유자는 조회 부하용 fixture 복제다. 100포지션 동시 체결
시험으로 주장하지 않는다. 조회 오류/가격 누락은 모든 stage에서 0이다.

| 조건 | 동시 요청 | req/s | catalog p50/p95/p99 ms | positions p50/p95/p99 ms | Node/PG CPU % core | Node RSS MiB / 연결 |
|---|---:|---:|---|---|---|---|
| 이전 1계정 | 1 | 92.43 | 11.51/14.97/19.66 | 9.29/11.50/13.14 | 82.9/20.5 | 498/10 |
| 이전 1계정 | 10 | 130.56 | 84.36/98.09/107.37 | 60.34/108.32/118.95 | 100.7/27.2 | 603/10 |
| 이전 1계정 | 50 | 126.38 | 615.97/654.80/667.31 | 170.88/311.96/409.08 | 103.8/26.6 | 667/10 |
| 이후 1계정 | 1 | 155.89 | 3.01/4.06/6.08 | 9.45/11.50/13.63 | 68.0/40.6 | 545/3 |
| 이후 1계정 | 10 | 322.30 | 15.19/18.89/21.09 | 46.16/52.12/55.65 | 103.0/22.2 | 647/10 |
| 이후 1계정 | 50 | 323.25 | 168.52/190.22/203.64 | 139.85/165.82/175.40 | 101.3/22.4 | 654/10 |
| 이후 50계정 | 50 | 327.54 | 165.92/185.16/195.63 | 138.30/158.76/167.35 | 102.4/23.1 | 604/10 |

[전후/50계정 요약](evidence/api-summary.json), 원본 `api-before.json`,
`api-after.json`, `api-50-owners.json`에는 실제 SQL counts와 PG 통계가 있다.
catalog는 75→8 SQL/req, positions는 31 SQL/req다. 이후 C=1 PG CPU에는
짧은 retention 실행 간섭이 있어 그 수치만으로 CPU 회귀를 결론 내리지
않았다. 네트워크 RTT/JWT/다른 제품 API/운영 DB 크기/다중 서버 부하는
포함되지 않으며 단일 Node CPU가 C=10부터 약 한 core를 사용했다.

**10,000명은 산술 가정이며 실측이 아니다.** detail 2%(200명)가 두 API를
2초마다, market 5%(500명)가 catalog를 5초마다, holdings 2%(200명)가
positions를 2초마다 조회하고 나머지는 해당 API를 호출하지 않는 독립
그룹이라고 가정하면 catalog 200 + positions 200 = **400 req/s**, DB
**7,800 SQL/s**다(이전 21,200). 측정한 단일 worker ~328 req/s보다 높다.
실제 동시 사용자 10,000명/운영 수용량 PASS로 판정할 수 없다. 앱의 focus
조건, 같은 query key의 in-flight 중복 억제는 존재하지만 서로 다른 계정이나
여러 observer의 interval 전체를 공유 캐시로 상쇄한다고 계산하지 않았다.
실제 배포에서 도착 부하·다중 instance·PG 전체 부하와 SLA를 검증해야 한다.

200만 행 retention은 2,000,000행을 실제 삭제했다. EXPLAIN의 1,000행을
제외한 drain은 **29,308.47ms / 약 68,206 rows/s**, plan execution은
11.226ms였다. captured candidate/source 최신 확인 및 PK DELETE가 index를
사용했다. 실제 FK 경합과 보존 snapshot 생존을 확인했고 삭제 SQL/배치
상한을 변경할 근거는 없었다. 금융 참조 테이블 크기는 소규모 fixture이므로
거대한 운영 ledger에서 같은 처리량이 보장되는 것은 아니다.

단기 실행은 세 수집기를 실제 동시에 사용했다. 300.003초 corrected-owner
시험에서 Last 4,580 / Mark 6,049 / Spot 1,168행, 각각 2,654,208 /
3,465,216 / 1,703,936 bytes를 기록했다. Node peak RSS 409.66MiB,
CPU 7.85% core, 시장가 9개 p50/p95 37.44/67.39ms였다.
Last/Mark 연결은 각 3회, Spot 재연결/실패 0, 25종·50 streams 수신했다.
WS/REST 계획 장애 20초 후 최종 23종 Last/Mark가 회복됐고, 계획 구간 밖
가격 누락 표본은 0이었다. 중복/역순/0/미래/타 도메인 프레임 5개가 모두
거절됐다. 실제 REST 429/418은 0이었고 해당 동작은 별도 18개 fixture로
확인했다. [300초 원본](evidence/soak-short-fixed.json).

이 시험의 전체 판정은 **FAIL**이다. clock 역행 9회 및 당시 계측의
정상 지정가 대기 오분류가 있었다. 후속 240.088초는 실제 지정가 1회
2,970.67ms 체결을 확인했지만 close fixture의 leverage 누락으로 이후
계정이 막혀 FAIL이었다. 해당 계측은 보완됐고 완료되지 않은 마지막 실행은
완료된 단기 PASS로 바꾸지 않는다. [240초 원본](evidence/soak-ready.json).

실제 24시간 최종 시도는 `trading-futures-soak-followup-24h-v2.service`,
PG `futures_soak_24h_final_test`, Redis DB 5에서 실행 중이다. 시작은
**2026-10-10 15:31:48 KST**; 4GiB cgroup/Node heap 2GiB/27시간 상한이다.
[launch](evidence/soak-24h-final-launch.log),
[계속 갱신되는 결과](evidence/soak-24h-final/soak-24h.json),
[handoff 관측 사본](evidence/soak-24h-handoff.json).
[출처별 실제 PG 행 수](evidence/sources-at-handoff.json)는 Last agg-trade/REST,
Mark WS/REST, Spot WS/REST가 서로 다른 테이블·source에 저장됨을 보여준다.
handoff 관측 사본은 303.633초, 시장가 10회, 지정가 실제 체결 9회, 계획 장애 pending/cancel 1회, 예상 밖 금융 오류 0건이다. 시장가 p50/p95 35.94/66.46ms, 지정가 체결 p50/p95 2039.52/2952.44ms, 대기 평가 p50/p95 2.92/4.32ms다. 유효 신선도 표본 24개 중 누락 0개, Node peak RSS 425.62MiB, clock step 9회다. 이 관측은 완료된 24시간 결과가 아니다. monotonic 86,400초를 실제 완료하기 전에는 PARTIAL이다. 초기 unit은 계획
장애 probe 처리를 수정하기 위해 정상 종료했고 그 INTERRUPTED 증거도 보존했다.

사용자 systemd 실행은 확인했지만 `Linger=no`이며 WSL 종료/로그아웃 이후
지속성은 보장되지 않는다. 기존 clock 역행으로 안정적 운영 환경 합격도
기대할 수 없다. 24시간 완료 후 계약 갱신·retention 실제 누적/삭제·RSS/지연
추이·자동 reconnect·Ops 실패를 검토해야 한다. 최초 몇 분 또는 단일 시장
시간대 결과로 고변동 시장·자연 24시간 disconnect·24시간 만료를 검증했다고
주장하지 않는다. [재현·합격·중단 절차](reproduction/README.md).

## F. 운영 적용 준비

기존 [Last 계약](../../../backend/docs/futures-last-price-contract.md)과
[F3 release operations](../../../backend/docs/futures-f3-contract.md#migrations-and-release-operations)을
보완했다. 별도 승인 후 exact catalog 등록/공식 검증, additive migration 및
모든 API/financial worker의 evidence-aware 코드 확인, DISABLED에서 Mark와
Last/risk 가동, 전체 가격/실제 작업 run/종료 경계 증거 확인,
`--require-ready` 직전·직후 실행, 단계적 mode 변경 순서다.

장애 때 신규 진입은 REDUCE_ONLY로 차단하고 Last/Mark/risk 수집·보호를
유지한다. Last가 없으면 사용자 종료도 fail closed다. 금융 무결성 사건에는
DISABLED가 필요할 수 있다. DISABLED 자체가 자동 위험관리/시즌 정산을
중지하지 않으므로 혼합 버전 writer 전환을 방지해야 한다.

첫 Last execution/trigger/pin 생성 이후 pre-Last 서버로 단순 롤백하면
nullable Spot evidence를 잘못 읽거나 다음 가격 기준을 바꿀 수 있다.
migration/evidence를 되돌리지 않고 호환 코드로 복구/roll forward한다.
legacy Spot pin 및 새 Last pin의 재시도는 각각 기존 증거를 재사용한다.

남은 별도 승인 대상은 운영 DB 조회/검증·migration, 실제 상품 등록,
Render 배포/환경 변경, 거래 모드 활성화 및 운영 복구 작업이다. 이번 작업은
어느 것도 수행하지 않았다. 승인 전에 최종 패치의 안정적 Linux 금융/원격 CI,
24시간 판정, 실제 배포 workload/SLA 검토가 필요하다.

## G. 최종 자체 검토

실제 production 변경은 catalog 조회와 read-only readiness에 한정했다.
거래·위험관리·청산·정산·원장·FX·Spot·WebSocket 정책, DTO 응답 형태,
frontend 및 `/api/v1` 계약을 유지했다. 전역 price cache, 안전 fallback,
신선도 완화, 새 framework, schema/migration 수정은 없다. 신규 CLI/부하/
삭제 스크립트는 운영 DB 접근을 거부한다. 테스트는 제거/skip 추가로
통과시키지 않았고 새 단언은 ID/boolean/개수/작은 결과로 검사했다.

잔여 리스크는 WSL clock과 최종 금융 gate 미통과, 안정 환경의 최종 패치 CI
미검증, 실제 24시간/10,000 사용자·운영 ledger 규모 미검증이다. 전체 diff,
whitespace, 타입/build/lint, raw failure, process 종료 여부 및 전용 실행
서비스를 확인한 상태로 넘긴다. 현재 근거로 출시 준비 완료를 선언하지 않는다.
