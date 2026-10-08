# Futures 성능 검증 및 잔여 보완

## A. 성능 측정

### 시작 상태 및 측정 경계

시작 branch `main`, HEAD 및 fetch 후 `origin/main`:
`2411a0c67e5f9609f7a40ecd7ff20bd229cea49b` (`관리자 계정 설계 보완`).
시작 working tree는 clean이었다. GPT 검토 기준 `fee598ac...` 이후 커밋도 확인했다.
이전 Diagnostic 교정은 최신 커밋에 있으므로 중복 수정하지 않았다.

WSL2 6.6.87.2 / 논리 CPU 32개, Node 24.14.1, PostgreSQL 16.15, pnpm 10.33.0. 약 30GiB RAM 중
약 28GiB가 가용이었다. 별도 초기화한 loopback PostgreSQL `futures_performance`
(55549), Redis(56449)를 사용했다. 운영 DB/환경변수/실제 서비스 설정은 수정하지 않았다.
PG shared_buffers=64MB, work_mem=4MB, max_connections=50, UTC, jit=off.

기존 OOM 절차대로 각 작업은 systemd cgroup v2에 총 3GiB, swap=0,
Node heap=1152MiB(web export 1792MiB), TasksMax=256(Frontend/browser 192, export 128), RuntimeMax=900–1800s,
KillMode=control-group, OOMPolicy=kill을 적용했다. 실제 memory.max/swap/pids와
자식 소속을 확인하고 외부 50ms 감시를 두었다. 85% 메모리/90% tasks에서 중지,
core dump 비활성화. 무거운 Frontend/Backend/PG 작업은 순차 실행했다.
세부 실행 상한·peak·OOM events는 [verification.json](verification.json)에 기록한다.

### 재현 가능한 fixture와 해석

[측정 harness](../../../backend/scripts/futures-performance-benchmark.ts)는 기존
Futures integration fixture, 실제 FuturesLimitService/Worker/Ops lease,
FuturesService.instruments 및 PostgreSQL을 사용한다. 명시적 test opt-in과
`127.0.0.1/futures_performance` 전용 DB 검사를 통과해야 실행한다.
원본 HEAD는 별도 `git archive` 디렉터리로 비교했으며 작업 checkout은 되돌리지 않았다.

- Matching: 10상품, 최대 500 General accounts에 계정당 다른 상품 2주문.
  canonical 서비스로 생성하여 계정/상품별 pending 제한·담보 검증을 유지했다.
  Cross/Isolated 혼합, 10% 시나리오는 매 10번째 주문이 실행 가능하다.
  두 주문이 같은 계정 담보를 공유하고 매 20번째 평가에 동일 Wallet의 실제
  FOR UPDATE 경합 50ms를 주입한다. 스트레스 E는 전부 동일 가격 갱신 후 충족한다.
- 외부 Binance 호출 없음. Spot `binance_spot_ws_ticker`, Mark
  `binance_usdm_mark_ws`, 기존 FX source의 합성 증거를 PG에 200ms마다 갱신한다.
  준비/주문 생성 시간을 제외하고 기존 1초 Worker timer의 비중첩 cadence를 모방한다.
- 체결 지연 시작은 첫 실행 가능 canonical Spot insert commit 직후다.
  뒤따르는 초기 Mark/FX fixture 갱신 시간도 포함한다. 종료는 execute transaction commit 후 evaluate 반환 시점이다.
  화면 polling은 포함하지 않는다. 운영의 가격 ingestion 주기는 별도 추가 지연이다.
- 첫 전체 재검사와 잔여 pending의 두 번째 방문 간격을 기록한다. E는 모두 실행되어
  재방문 표본이 없다. 평가 throughput은 미충족 예외도 포함한다.
- 쿼리는 실제 pg_stat_statements calls/exec_time. Application에는 금융 tx 및
  Worker/Ops 쿼리를 포함하고 fixture feed/observer/경합 주입 SQL은 제외한다.
  총 DB 쿼리는 이들까지 포함한다. query 시간은 서버 SQL 실행 시간으로 네트워크,
  Prisma 객체 생성, JS 스케줄링 전체 시간을 뜻하지 않는다.
- CPU는 측정 구간 평균 및 약 200ms 표본 peak(100%=1 core),
  Node RSS/PG backend RSS 합은 샘플 peak. Node 값에는 harness feed/관측 비용도 포함한다.
  PG RSS 합은 공유 페이지를 중복 집계하며 짧은 burst CPU 표본은 부정확할 수 있다. 100ms 이상 CPU 표본이 없는
  경우 peak 0은 CPU 사용 없음이 아니라 표본 부족이다.
  전체 자식 프로세스 메모리 peak는 별도 cgroup 외부 감시 값이다.
- Market은 ownership을 거친 service-level이며 HTTP/auth 직렬화/네트워크를 제외한다.
  20→100→300명, 각각 3회 burst와 실제 Frontend 5초 polling의 2회 staggered round.
  상품 수 1/5/10도 확인한다. 운영 HTTP 성능이나 거래소 처리 능력으로 일반화하지 않는다.

### 측정 결과

최종 원본 수치: [baseline.json](baseline.json).
최종 변경 수치: [optimized.json](optimized.json).
측정 cgroup 전체 peak는 원본 711.2MiB(Matching+Market), 최종 543.2MiB(Matching만),
OOM events=0이었다. 전체 phase가 달라 이 두 peak를 메모리 개선률로 비교하지 않는다.
동일 Matching 시나리오의 RSS/CPU 비교는 아래 표를 따른다.

단위: ms. A는 미충족 100건, B/C/D는 100/500/1,000건 중 10%, E는 1,000건 전량 충족.

| 시나리오 | 변경 전 체결 p50/p95/최대 | 변경 후 체결 p50/p95/최대 | 첫 전체 재검사 전→후 | 재방문 최대 전→후 | SQL 전→후 |
|---|---:|---:|---:|---:|---:|
| A | 표본 없음 | 표본 없음 | 2247.42 → 428.71 | 2998.63 → 996.67 | 12,438 → 2,438 |
| B | 1014.78/2112.43/2112.43 | 512.02/946.68/946.68 | 2291.05 → 982.15 | 2897.61 → 882.27 | 12,208 → 3,248 |
| C | 6946.37/13573.85/14027.57 | 2443.01/4686.83/4870.76 | 14196.26 → 4905.02 | 14924.91 → 4899.48 | 61,032 → 16,200 |
| D | 14099.94/27950.85/28987.8 | 4906.01/9369.07/9775.06 | 29141.54 → 9806.23 | 29921.31 → 9907.8 | 122,054 → 32,382 |
| E | 19577.73/37858.97/39719.06 | 19750.19/37531.85/39176.14 | 39720.69 → 39177.32 | 0 → 0 | 103,182 → 107,142 |

| 구현/시나리오 | cycle 표본 수·p50/p95/최대 | 평가/s | commit/s (첫 순회) | 가장 오래 미평가(ms) | Node/PG 평균 CPU % | Node/PG peak CPU % | Node/PG RSS peak MiB | 연결/active/lock wait 최대 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 원본/A | 2·2161.89/2244.24/2244.24 | 38.74 | 0 | 2998.63 | 48.63/31.1 | 79.92/54.16 | 391.0/133.5 | 6/2/1 |
| 원본/B | 2·1712.4/2288.45/2288.45 | 40.32 | 4.36 | 2897.61 | 47.07/34.17 | 71.49/54.1 | 399.2/150.8 | 6/2/1 |
| 원본/C | 10·1836.46/2271.71/2271.71 | 39.85 | 3.52 | 14924.91 | 42.39/33.93 | 70.64/54.35 | 405.6/184.9 | 7/2/1 |
| 원본/D | 19·2134.49/2337.75/2337.75 | 39.68 | 3.43 | 29921.31 | 42.53/34.1 | 71.9/59.04 | 407.3/203.3 | 7/3/1 |
| 원본/E | 10·3656.39/3723.9/3723.9 | 25.18 | 25.18 | 39687.09 | 45.99/37.55 | 67.97/59 | 396.7/221.1 | 7/2/1 |
| 최종/A | 2·405.73/425.09/425.09 | 142.09 | 0 | 996.67 | 37.53/16.1 | 65.88/39.47 | 376.2/88.4 | 4/2/0 |
| 최종/B | 2·349.76/979.5/979.5 | 140.82 | 10.18 | 976.31 | 48.08/23.19 | 59.69/34.53 | 388.2/148.1 | 6/2/1 |
| 최종/C | 6·777.33/1861.79/1861.79 | 131.98 | 10.19 | 4901.56 | 39.7/26.89 | 60.16/44.17 | 409.1/162.3 | 6/2/1 |
| 최종/D | 10·776.14/1872.97/1872.97 | 132.12 | 10.2 | 9907.8 | 38.48/28.29 | 62.74/44.23 | 411.9/176.1 | 6/3/1 |
| 최종/E | 5·7487.01/7538.71/7538.71 | 25.52 | 25.52 | 39146.71 | 49.32/39.89 | 73.17/59.06 | 414.1/207.7 | 7/2/1 |

전체 DB 쿼리(feed/observer/경합 포함), 개별 평가 지연, 상위 SQL calls/mean/max는 JSON 참조.
성능 측정의 모든 시나리오에서 예상 체결 수·equity snapshot 수가 일치했고 unexpectedStates/deadlock은 0이다.
SQL timeout/DB 오류도 관측되지 않았다. 대기 끝에서 canonical 가격을 다시 읽는 금융 검증이
남으므로 E 전량 체결은 여전히 10초를 넘는다. 정상 10% 체결의 B/C/D p95 및 D 첫 순회는
이 fixture에서 10초 이내다. D는 여유가 작아 운영 보장으로 해석하지 않는다.

| 상품 | 동시 사용자/패턴 | 요청 수 | p50/p95/최대(ms) | 오류 | SQL/요청 | 실제 app/전체 DB SQL | Node/PG 평균 CPU % | Node/PG peak CPU % | Node/PG RSS MiB | 연결/active 최대 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20/burst | 60 | 24.25/27.47/27.88 | 0 | 9 | 540/545 | 38.78/0 | 표본 부족 | 396.6/287.9 | 11/2 |
| 1 | 20/polling-5s | 40 | 3.52/3.91/4.18 | 0 | 9 | 360/553 | 1.21/1.41 | 1.86/9.73 | 397.6/343.4 | 13/1 |
| 5 | 20/burst | 60 | 56.18/64.08/64.81 | 0 | 21 | 1,260/1,265 | 107.3/0 | 표본 부족 | 397.6/281.9 | 13/2 |
| 5 | 20/polling-5s | 40 | 4.56/5.16/6.87 | 0 | 21 | 840/1,033 | 1.88/2.52 | 6.24/14.63 | 400.4/293.1 | 13/1 |
| 10 | 20/burst | 60 | 94.38/106.25/108.53 | 0 | 36 | 2,160/2,169 | 86.11/59.55 | 120.2/118.83 | 400.4/297.9 | 13/2 |
| 10 | 20/polling-5s | 40 | 6.58/7.46/10.08 | 0 | 36 | 1,440/1,633 | 3.1/4.13 | 21.14/18.73 | 401.9/303.4 | 13/1 |
| 10 | 100/burst | 300 | 450.93/521.46/537.74 | 0 | 36 | 10,800/10,833 | 109.56/91.74 | 142.92/139.02 | 471.9/305.9 | 13/3 |
| 10 | 100/polling-5s | 200 | 6.15/7.57/10.29 | 0 | 36 | 7,200/7,397 | 11.65/15.49 | 29.01/29.49 | 471.9/310.6 | 13/2 |
| 10 | 300/burst | 900 | 1340.77/1518.1/1550.55 | 0 | 36 | 32,400/32,485 | 123.99/96.5 | 171.05/138.65 | 551.1/314.4 | 13/2 |
| 10 | 300/polling-5s | 600 | 5.8/6.91/10.65 | 0 | 36 | 21,600/21,797 | 31.59/39.48 | 49.13/61.39 | 551.3/319.6 | 13/2 |

상품 수에 따라 요청당 SQL은 9→21→36(6+3N)으로 증가한다. 모든 Market 오류/DB deadlock은 0.
burst는 풀의 대기/반복 selector 조회를 포함한다. staggered polling은 화면의 5초 주기를
사용했지만 모든 클라이언트가 같은 시각에 polling하면 burst 쪽에 가까워질 수 있다.
300명 burst도 로컬 서비스 p95 1.52초였으므로 이번 범위에서 API 코드는 수정하지 않았다.

쿼리 시간의 대표 사례(D)는 원본 Wallet FOR UPDATE가 3,800회,
총 약 2.5초(50ms 경합 포함)였다. 개별 비잠금 조회는 대체로 수십 µs 수준이며,
다수의 순차 Prisma/DB 왕복과 rollback transaction이 cycle 시간을 늘렸다.
최종 Wallet FOR UPDATE는 200회, 총 2.39초, mean 11.95ms/max 48.83ms다.
같은 50ms 경합을 유지하면서 빠른 미충족 잠금들이 사라져 mean이 높아진 것이며,
최종 수치의 다른 SQL mean/max는 JSON의 pgTopStatements 참조.
E는 SQL이 103,182→107,142회로 약 3.8% 증가했다. preview가 실행 후보에게 추가
읽기를 주기 때문에 전량 충족 시 DB 부하를 개선했다고 보고하지 않는다.
E p95도 37.86→37.53초로 큰 개선이 없다. 이번 최적화의 근거는 주로 미충족 주문이
있는 B/C/D의 p95, 쿼리량과 재검사 간격 개선이다.
Pending 화면의 기존 4초 polling과 Market의 5초 polling을 금융 commit 지연과
합산해 측정하지 않았다. 화면 반영 시간/운영 ingestion 지연은 별도 확인 대상이다.

## B. 성능 개선

미충족 주문의 반복 금융 transaction/lock과 100건 cycle의 순회 간격이 확인된
병목이었다. read-only canonical Spot negative preview 및 200건 상한만 추가했다.
실행 후보는 기존 lifecycle cleanup transaction과 금융 실행 transaction을 모두
유지하며 기존 evidence/DB 시간/operating mode/season/account/wallet/position 잠금,
예약 원자성, 중복 체결 방지, ledger/fee/PnL/fill count 검증을 생략하지 않는다.
`FuturesService.execute`는 변경하지 않았다. 신규 queue/index/migration은 없다.

초기 실험에서 활성 계정의 lifecycle cleanup transaction을 생략하자 실제 Season
lock race 회귀가 검출됐다. 이 실험은 폐기하고 후보의 기존 transaction을 복원했다.
최종 수치는 복원된 구현에서 재측정했으며 회귀 테스트도 다시 실행했다.

Market API는 5초 staggered 조회에서 낮은 p95/0 오류였으므로 수정하지 않았다.
상품당 Spot/Mark 선택 N+1(6+3N queries/request)은 남지만 이번 측정에서 불필요한
금융 selector 재설계나 미측정 캐시 최적화의 근거가 되지 않았다.

## C. 잔여 보완

1. **대기:** Spot/Futures 양쪽이 0을 확인했을 때만 전체 지정가 empty를 표시한다.
   오류/로딩을 0으로 취급하지 않으며 TP/SL은 별도 상태로 유지한다.
2. **정산:** 목표 Season의 canonical `submitted` Futures entries를 예약금과 독립적으로
   preflight와 Season lock 내부에서 검사한다. 기존 code/status와 Spot 검사를 유지한다.
   실제 PG에서 zero-reservation 불일치/다른 Season·General 무영향/executed·canceled
   무영향/cleanup 후 실제 final settlement 성공을 검증했다.
3. **Attached:** 기존 ProtectionEditor의 optional entry context에서 Decimal 비교로
   LONG SL<entry<TP / SHORT TP<entry<SL을 안내한다. 기존 Market/Limit child 입력 유지.
   frontend에서 잘못된 입력은 transport 전에 중단하며 서버 검증도 authoritative하다.
   서버 PROTECTION_ALREADY_TRIGGERED는 방향 관계 안내로 매핑하고 기존 failure 유지.

## D. 검증 및 변경사항

첫 전체 금융 gate는 21/22 suite PASS, F2만 fixture의 일반 Market open에서
FUTURES_INSTRUMENT_UNVERIFIED로 실패했다. 해당 경로의 FuturesService.execute와
상품 verification 코드는 이번에 변경하지 않았다. 같은 환경의 F2 단독 재실행은
PASS였으며 최초 실패 원인은 확정하지 않았다. 실패를 숨기거나 검증을 완화하지 않고
전체 gate를 다시 실행했다. 두 번째 전체 gate는 F2가 PASS였으나 F3의 기존 increase 경로에서 같은
verification 오류로 21/22 suite PASS였다. 원본 HEAD의 별도 테스트 복사본에서
판정을 바꾸지 않는 test-only 관측으로 원인을 확인한다. 관측용 원본 F3 5회는 모두 48 scenarios PASS였고 verification 실패는
재현되지 않았다. 원본 F2 direct runner에서는 별도의 Mark metrics null fixture 실패가
재현됐다. 이를 동일 원인이라고 단정하지 않는다. 원본 관측 코드/출력은 `/tmp`에만
있으며 저장소의 verification 판정·금융 정책을 바꾸지 않았다. 결과는 아래 기록한다.


| 실행 명령 | 결과 |
|---|---|
| `pnpm exec tsx scripts/futures-performance-benchmark.ts` (원본 archive/최종 checkout) | matching A–E, Market 1/5/10상품·20/100/300명 실측 완료; OOM/DB 오류 0 |
| `pnpm exec tsx scripts/futures-limit-entry-integration.ts` | 실제 PostgreSQL 65 checks PASS (예약/cancel/replay/duplicate/가격·mode·endAt 잠금 경합/Attached/정산 guard 포함) |
| `pnpm exec jest --runInBand <22 financial integration specs>` | 최종 20/22 suites PASS, 2 FAILED; 전체 command/flags는 verification.json 참조 |
| `pnpm run lint:candles:check`, `format:candles:check`, `lint:accounts:check` | 모두 PASS |
| `pnpm run typecheck`, `pnpm run build` | 모두 PASS |
| `pnpm test --runInBand` | 247 suites / 3,982 tests PASS, DB opt-in 등 58 suites / 63 tests skipped. Skip을 PASS로 계산하지 않음 |
| `pnpm run test:e2e --runInBand` | 2 suites / 397 tests PASS |
| `node ../scripts/diagnostic-enforcement.cjs backend` | PASS |
| `npm run check` | lint/accounts+guides, typecheck, 1,825 tests PASS / skipped 0 |
| `node ../scripts/diagnostic-enforcement.cjs frontend` | PASS |
| `node test/browser/futuresIntegrationBrowser.cjs` | 208 layouts PASS, page errors 0, overflow/glyph 검사 통과 |
| `npm run export:web -- --max-workers 1` (`EXPO_OFFLINE=1 CI=1`) | PASS |
| `git diff --check` | 최종 결과는 verification.json 참조 |

[브라우저 결과](browser-validation.json)는 4개 width × 2 themes × 2 font scales ×
13 scenarios다. Spot-only/Futures-only/empty 및 TP/SL 전환, 네 방향 오류, Market
navigation, 기존 Limit/Holding 화면을 실제 RN Web에서 검증했다. 잘못된 Attached
입력은 API transport 0회를 확인한다. 320px/2배 글꼴의
[오류 안내](320-dark-2-limit-long-sl-error.png)와
[대기 목록](320-light-2-pending-futures-only.png)을 직접 보아 줄바꿈·가로 잘림 없음도 확인했다.
세로 스크롤/숫자 줄바꿈은 유지하며 native device/IME를 검증했다고 보고하지 않는다.

처음 확장한 브라우저 matrix는 navigation history/context 누적으로 85% memory guard에
중지됐고 OOM events=0이었다. 시나리오마다 owned page/context를 종료하도록 기존
harness를 보완했다. 같은 3GiB 상한에서 재실행 peak 466.6MiB, 208 layouts PASS다.
메모리 상한을 올리거나 보호를 해제하지 않았다.

### 수정 파일과 이유

- `backend/src/futures/futures-limit.service.ts`: canonical Spot 미충족 preview;
  기존 후보 lifecycle/금융 fence 유지.
- `backend/src/futures/futures-limit-worker.service.ts`: bounded cycle 100→200.
- `backend/src/batch/season-settlement-job.service.ts`: Season submitted entry 직접 guard.
- `frontend/src/screens/asset/PendingOrders.tsx`, `PendingFuturesAndProtections.tsx`:
  양쪽 목록의 scope-valid count를 합쳐 empty를 표시, TP/SL 독립 유지.
- `frontend/src/features/conditional/ProtectionEditor.tsx`,
  `frontend/src/screens/futures/FuturesLimitEntryForm.tsx`: Decimal 방향 검사/안전한 code mapping.
- `backend/scripts/futures-performance-benchmark.ts`: bounded opt-in 실측 harness.
- `backend/scripts/futures-limit-entry-integration.ts`: 가격 preview 경합, Attached 방향
  rollback/valid matrix, canonical submitted guard/cleanup/final settlement 실제 PG 테스트.
- `backend/src/batch/season-settlement-job.service.spec.ts`, `backend/test/app.e2e-spec.ts`:
  preflight/Season lock guard 테스트와 delegate mock 계약 유지.
- `frontend/src/screens/asset/accountHoldings.test.ts`,
  `frontend/src/screens/futures/FuturesLimitEntry.test.ts`: empty/전환, 입력·정밀도·server mapping.
- `frontend/test/futuresFixtures.cjs`: HTTP 이전 합성 증거 timestamp 여유; 정책 변경 없음.
- `frontend/test/browser/tradingMocks.js`, `futuresIntegrationBrowser.cjs`: 조합 fixture,
  direction error/좁은 화면 검사 및 expanded matrix context 수명 제한.
- `backend/docs/futures-limit-entry-contract.md`, `frontend/README.md`, `HANDOVER.md`,
  이 조사 디렉터리: 최종 계약·측정·검증·운영 전 한계 기록.

전체 `git diff`와 신규 harness/결과 파일을 직접 검토했다. 상세 final status/command,
source hash, resource bounds/history는 [verification.json](verification.json)에 있다.

### 재실행 주의

빈 **전용 테스트 DB** `127.0.0.1/futures_performance`를 새로 초기화하고 기존 migration을
적용한다. PostgreSQL에 `shared_preload_libraries=pg_stat_statements`가 필요하다.
이 harness는 시나리오 사이에 전용 DB의 합성 users/assets/seasons를 TRUNCATE한다.
실제 서비스 DB에 사용하지 않는다. verified cgroup preflight/외부 감시 절차를 먼저
적용하고 `NODE_OPTIONS=--max-old-space-size=1152`, `NODE_ENV=test`,
`FUTURES_DB_INTEGRATION=1`, `FUTURES_PERFORMANCE_BENCHMARK=1`, 전용 DATABASE_URL,
`BENCHMARK_CONTENTION_MS=50`, `BENCHMARK_REPORT=<output.json>`으로 tsx command를 실행한다.
`BENCHMARK_PHASE=matching|market`은 부분 재실행, 생략 시 전체다. 원본 비교는 archive의
source를 쓰고 같은 harness/DB/자원 상한/fixture를 유지한다. 금융 gate의 opt-in flags와
full spec 목록은 verification.json에 기록한다. API 측정은 service-level 그대로다.


금융 Source of Truth/금융 실행 코어/Season lifecycle cleanup/가격 정책/상태 계약을
변경하지 않았다. 이번 범위 외의 기능 변경, migration/schema/생성 Prisma 변경 없음.
commit/push/merge 및 운영 활성화는 수행하지 않았다.

UI 초기 검사에서 새 empty test는 mocked InlineEmptyState의 title props를 children로
읽어 실패했다. 기존 empty helper로 관측을 교정했다. 기존 Futures Market/Close
테스트는 50ms 여유의 합성 증거가 화면의 cached clock보다 미래가 될 수 있어,
fixture가 1초 이전 증거를 생성하도록 보완했다. 실제 5초 freshness/서버 정책,
invalid/stale 검사와 요청 assertion은 유지한다. 단순 재시도/skip으로 우회하지 않았다.

### 남은 한계와 운영 활성화 전 확인

합성 fixture, 로컬 단일 Worker/단일 PostgreSQL 결과다. HTTP-level 부하,
실제 운영 규모의 계정 데이터/26상품 전체 universe/실제 공급자 갱신 지연, 여러
인스턴스의 지속 장시간 부하와 native device UI는 측정하지 않았다.
1,000건 전량 동시 체결은 여전히 10초 목표를 넘는 스트레스 조건이다. 이를 이유로
새 분산 matcher를 도입하지 않았다. 운영 활성화 전 기존 migration 배포 상태,
canonical Spot/Mark coverage/freshness, 담보 무결성, lease/backlog와 실제 HTTP
concurrency·DB pool·lock 경합을 확인해야 한다. Feature flag 기본값은 그대로다.

**최종 판정: PARTIAL.** 구현/성능 측정/대상 65개 PG 검증/품질/UI 검증은 완료했으나,
전체 금융 PostgreSQL gate의 최종 결과는 20/22 suites PASS다. F2/F3/F3.1/Conditional/
Futures Limit 등은 마지막 실행에서 통과했고, F1의 기존 marginAndFlags open 경로가
FUTURES_INSTRUMENT_UNVERIFIED, Spot transfer legacy fill이 price_evidence_unavailable로
실패했다. 두 실패 경로의 금융 코어는 이번 diff에서 변경하지 않았다. 전체 금융 회귀가
없다고 단정하거나 release-ready/PASS로 보고하지 않는다. 검증을 완화하지 않았으며
이들의 안정성/원인 확인은 운영 활성화 전에 필요하다.

최종 `main`/HEAD·origin/main은 시작과 동일하다. `git diff --check` exit 0.
최종 status: tracked modified 18개 + untracked benchmark 1개 + 이 보고 디렉터리.
상세 목록은 verification.json의 finalStatus. Migration/schema/Prisma generated status는 clean.

