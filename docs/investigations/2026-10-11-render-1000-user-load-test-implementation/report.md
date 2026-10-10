# Render 1,000명 부하 테스트 도구 구현 및 검증

이번 변경은 격리 환경에서 사용할 외부 Node/TypeScript harness다. 실제 Render/AWS 리소스 생성, 배포, 운영 DB/Valkey 접근, 1,000명 네트워크 부하 시험은 수행하지 않았다. Render의 1,000명 수용 능력은 아직 판단할 수 없다.

작업은 사용자 최신 지시에 따라 `main`에서 진행했다. 선물 전용 25종목 도입은 **현재 작업의 검증·커밋·push 이후** 별도 작업으로 대기하며 이번 변경에 섞지 않았다.

## 코드 및 환경 기준

작업 시작 시 로컬 HEAD, origin/main, GitHub 최신 main은 모두 `3985aa1fbdfb1be8fe7d778445a6580984f2d026`였고 working tree는 clean이었다. 구현 중 GitHub branches/main GET으로 같은 SHA를 다시 확인했다. 기존 설계의 원격 `55cda476…` 이후 제품 코드는 바뀌지 않았고 관련 차이는 조사 문서·증거 4개였다. 사용자의 진행 중 변경을 덮어쓰거나 다른 브랜치를 만들지 않았다.

Render CLI `services --output json` GET으로 다시 확인한 [최신 읽기 전용 구성](evidence/render-readonly-current.json)의 API 1 CPU/2GB, PG 0.5 CPU/1GB/PostgreSQL 17/5GB, Valkey 256MB/8.1.4/noeviction, Singapore를 비교 대상으로 유지한다. 이번 구현 검증에는 별도 로컬 PostgreSQL 16.15와 Redis 7.0.15를 사용했다. 이 버전·WSL 차이를 Render 기준선이라고 표현하지 않는다. 실제 클라우드 실행 전에 서비스 사양·버전·환경변수·계측 가용성을 다시 확인해야 한다.

## 구현 방식과 제품 변경

일반 HTTP/WS 클라이언트와 기존 AppModule을 사용하는 격리 API 진입점으로 구성했다. 새 금융 서비스, DB schema/migration, job queue, workload DSL, 새로운 dependency는 없다. 1,000명 Actor 배열과 독립 HTTP/session/shared WS를 처리할 구조이며 기본은 단일 발생기다. 불완전한 수동 분산 phase merge는 제거했고 multi-generator 설정은 fail closed 한다.

| 파일 | 목적 |
|---|---|
| `backend/scripts/load-test/manifest.ts`, `preflight.ts`, `network-guard.ts` | 승인 target/credential/SHA/물리 DB·Valkey identity, UTC/빈 DB, 외부 통신 차단, 동일 workload hash |
| `cli.ts`, `prisma.config.ts` | template/guard/migrate/serve/prepare/run/audit 명시적 명령, 기존 migration만 사용, 비밀값 파일 0600 |
| `server.ts`, `replay.ts` | 실제 AppModule과 middleware/guard/scheduler, 기존 provider wire parsing·정규화·저장·Pub/Sub·fan-out 경로 유지 |
| `client.ts`, `actor.ts`, `run.ts` | 정상 login/JWT/refresh/WS protocol, cache/focus/dwell/화면 이동/현재 Position에 맞는 주문, ramp/hold/drain 및 판정 |
| `prepare.ts`, `audit.ts` | 실제 금융 API를 통한 fixture, 기존 Decimal·Futures/FX 계산·general account audit 재사용, 전체 계정 audit |
| `metrics.ts`, `server-metrics.ts`, `observe.ts`, `verdict.ts` | bounded histogram, HTTP/WS/발생기/PG/Valkey/worker/Render 메트릭, 정합성·성능·여유도·유효성 분리 |
| `harness.spec.ts`, `jest.config.json`, `tsconfig.json`, `README.md` | safety/protocol/determinism/financial arithmetic 계측 테스트와 실행 절차 |
| `backend/package.json`, `backend/.gitignore`, `.github/workflows/ci.yml` | harness 명령 두 개, 실행 산출물·credential 제외, CI의 pure safety/protocol 테스트 |
| `backend/src/providers/provider-socket-factory.ts`, Futures Last/Mark ingestion 두 파일 | optional provider socket transport 주입 지점 |

제품 변경은 Futures ingestion의 optional socket factory뿐이다. 기존 candle provider의 socket factory 패턴을 재사용했다. 기존 Futures `new WebSocket(existingURL)`를 유지한 채 fake transport를 공급하려면 이 두 주입 지점이 필요했다. Production에서는 provider가 등록되지 않아 기존 생성자로 그대로 동작하며 계측·synthetic transport는 production main에서 import되지 않는다. Gateway, PrismaService, pool 설정, timeout, transaction isolation, lock ordering, 가격/수수료/권한/멱등성 계약은 변경하지 않았다.

재사용 대상은 기존 raw WS/WsAdapter 및 JWT/session, ProviderHttpClient/Binance coordinator, live candle socket factory·parser·normalizer·hydrator·Redis reducer·finalizer·repository, Futures Last/Mark parser/ingestion, OpsJobLock/worker, quote/create/execute/cancel, 금융 PostgreSQL gate, `auditGeneralAccounts`, Futures/FX Decimal 정책이다.

## Workload와 데이터

| 상태 | 시간 점유 목표 | dwell | 실제 요청 조건 |
|---|---:|---:|---|
| Spot market | 30% | 30–90초 | 목록 entry, 일부 다음 page, mounted ticker 유지 |
| detail/chart/book | 25% | 30–60초 | 상세·차트 entry/reconnect, ticker/candle/book WS |
| Spot 주문 | 10% | 60–180초 | wallet/position, 60–180초 think, quote→create |
| Futures | 15% | 60–180초 | instruments+positions focus polling 2초, history/final reads entry |
| home/wallet/portfolio | 15% | 30–90초 | 집계 portfolio 및 화면의 기존 조회, 일부 equity 조회 |
| history/FX | 5% | 30–90초 | pending history만 4초 polling, FX WS 무효화 및 300초 fallback |

이 비율은 실제 운영 통계가 아닌 **초기 workload 가정**으로 manifest에 표시한다. dwell 가중 전이를 사용해 긴 화면 체류 때문에 목표 시간 점유가 왜곡되지 않게 했다. 동일 화면에 고정하거나 전체 사용자 동시 주문을 만들지 않는다. 공통 staleTime 5초, `/me` 60초, 계정 목록 30초, 조회 1회 retry·mutation retry 0, 10초 HTTP timeout과 in-flight dedupe를 재현한다. Cache를 무효화하는 거래/WS recovery도 반영한다.

Spot market/limit=70/30, BUY/SELL=60/40. Futures market/limit=70/30은 **flat entry가 가능한 decision**의 비율이다. 기존 포지션은 현재 방향·leverage/margin과 quantity에 맞는 increase/reduce/close를 사용하므로 전체 execution에서 limit 비중을 30%라고 강제하지 않는다. Futures viewer의 30%가 거래하며 120–240초 think를 사용한다. Protection/cancel 초기 decision 비율은 10/20%다. 거래는 Crypto Spot/Futures를 기본으로 하고 주식은 목록·시세·차트 조회 경로이며 휴장 검증을 우회하지 않는다.

1,000명 기준 steady Futures polling만 약 150 HTTP RPS다. 화면 전이율은 약 16회/초이고 entry/read/거래/refresh를 더하면 대략 **210–250 RPS**가 초기 추정이다. 실제 값은 occupancy/cache/현실적 Position state에 따라 바뀌므로 결과에는 endpoint별 실측 count/hold 초를 기록한다. 이번 10명 smoke에서는 212 HTTP requests/90초=2.36 RPS였고 100배 참고값은 235.56 RPS다. 이 추정은 1,000명 실측값이 아니다.

사용자별 shared WS 1개, 총 1,000개다. 최소 ticker 1개를 명시적으로 유지하는 **1,000-WS stress 조건**을 manifest에 기록한다. Mounted market 목록 때문에 화면별 1구독으로 제한하지 않으며 대략 10,000–20,000개 ticker/focus subscription을 예상하되 실측으로 확정한다. 첫 subscribe는 transport open 후 100ms 대기한다. 현재 gateway는 비동기 DB 인증 뒤 listener를 설치해 즉시 보낸 loopback frame을 놓칠 수 있기 때문이다. 이 가정은 공개 기록하며 제품 gateway를 변경하거나 인증을 우회하지 않았다.

Baseline fixture는 사용자/계정 1,000, wallet 4,000, Spot history 12 buy/sell round+3 holding으로 약 27,000 executed order와 최대 200 pending, Futures position 2,000과 최대 200 pending entry, 일부 attached protection, 7일 candles다. 대략 Crypto 50,400+주식 실제 거래 세션 candle 등 6만대 row이며 5GB를 채우지 않는다. smoke는 10명·history 1 round·2일 candles다. 최종 smoke 준비 row는 users/accounts 10/10, wallets 40, orders 52, Spot positions 30, Futures positions 20, pending entry 2, ledger 160, candles 16,350이다. 정확한 `fixture.counts`와 준비 후 audit을 산출물에 저장한다.

현재 고정 Spot universe에는 Unicode 심볼이 있으나 Futures coverage parser는 ASCII exact symbol만 승인한다. 조사 시 fixture를 무조건 Spot 25개와 같게 만들면 Futures 한 종목이 목록에서 사라졌다. 현재 코드에 맞춰 **Spot 25개/verified Futures 24개**를 준비하고 계약 alias나 상품 정책을 바꾸지 않았다. 후속 Futures25 작업이 완료되면 새 catalog로 fixture/replay와 smoke를 다시 확인해야 한다.

Replay는 tick 200ms, ticker/candle/Mark 1Hz, depth 1.67Hz, Last 5Hz다. Seed와 상대 price event sequence는 재현 가능하고 UTC event timestamp는 실제 수신 시각에 맞춰 freshness/JWT 정책을 유지한다. Mark는 Last와 구분하며 기존 처리 경로의 snapshot persistence cadence·rate limit/coordinator를 변경하지 않는다. 합성 FX는 기존 Ops ingestion job을 30초마다 실행한다. 기본 운영 FX schedule 1시간과 체결 freshness 60초를 그대로 조합하면 USD 지정가가 stale FX 때문에 장시간 미체결된다. 이 문제를 실제 smoke에서 확인했고, harness의 데이터 공급 주기만 분리했다. 기존 OpsJobLock·파싱·DB snapshot 경로와 60초 체결 검증은 유지하며 shared scheduler tick·금융 worker cadence는 변경하지 않는다. 준비 중 가격은 고정하고 ramp에서 상대 경로를 시작한다. missed tick은 burst catch-up 없이 기록한다. Binance/KIS/KOSCOM으로 실제 transport 호출은 0이어야 하며 하나의 **시도**도 실패다.

## 안전성·판정·계측 범위

운영 API host/운영 및 upgrade clone physical resource ID denylist, manifest의 승인 URL/resource/db/role allowlist, credential URL 재검증, mode 0600 test credential, SHA/clean-tree/workload hash, 빈 test DB/physical Valkey identity와 API health HMAC identity를 사용한다. DB name은 `_load_test`, role은 `load_test_` 접두사, Redis DB는 0만 허용한다. 알려진 운영 target은 network 연결 전에 거부한다. 단순 user ID·key prefix·Redis logical DB 분리를 격리라고 인정하지 않는다.

마이그레이션도 target/실제 DB role/UTC/빈 user를 먼저 검사한다. 준비는 real signup/login/account/Season join/grant/transfer quote+execute/order quote+create/Futures execute로 수행한다. 직접 금융 balance/position/ledger는 만들지 않는다. 물리 resource creation/deploy/cleanup은 도구가 자동 실행하지 않는다. cloud 승인 manifest를 검토한 사용자가 전용 secret과 target을 공급해야 하며 production secret을 재사용하지 않는다.

정합성은 전체 wallet ledger balance chain·예약금·수량·평균원가·fee/PnL·상태, account mode/ownership/wallet scope, Futures 전체 lifetime open/increase/reduce/close·Isolated/Cross·limit reservation·Last execution evidence·Mark risk/valuation/collateral, conditional/OCO·liquidation evidence, FX+transfer 및 command↔execution↔ledger 연결을 기존 Decimal 정책으로 정확히 검사한다. 1e-8 오류도 허용 오차로 숨기지 않는다. 금융 finding은 1건이라도 CORRECTNESS FAIL이다. 감사 미완료는 PASS가 아니다.

HTTP endpoint별 count/p50/p95/p99/status/timeout/transport failure, 주문 quote/create/execute/cancel, 동일 key replay와 실패 reason, WS ACK/subscription/message/bytes/duration/disconnect/recovery/ingress delay, 기존 fan-out pending/coalesced/drop/send, API CPU/RSS/event loop/PG pool occupancy/acquire/query/transaction spans, PG active/lock wait/deadlock/storage, Valkey memory/client/error/timeout/noeviction/PubSub, worker cycle/revisit/lease/ownership/queue를 기록한다. Render CPU/RAM/managed connection은 30초 GET metric으로 수집한다. 관측기는 action loop와 분리해 느린 cloud metric 응답이 발생기 스케줄을 막지 않는다.

일반 HTTP p95/p99 1/2초, 정상 주문 2/5초, realtime ingress 2/5초, unrecovered 예정 요청 오류율 <0.1%다. 정상 expired-401→실제 refresh/retry의 성공은 unrecovered 실패와 구분하되 status는 보존한다. Baseline은 각 사용자 15분 TTL refresh도 확인한다. 지정가 accepted/create→fill 및 조건부 triggered→commit, worker eligible evaluation→commit/revisit은 HTTP accepted SLO와 분리한다. **첫 이론적 시장가격 교차부터의 지연을 완전 추적했다고 주장하지 않는다.**

CPU/RAM/pool/network는 Capacity Headroom review이며 latency FAIL 조건이 아니다. 충분/제한/증설 권장/병목 근접의 참고 경계 60/80/95%는 승인 자원 한도·실측 추세와 함께 판단한다. 실제 restart/OOM/deadlock/timeout/send failure/pending 축적은 서비스 실패다. Missing Render series를 0% 사용량으로 해석하지 않는다. Linux generator CPU/RAM/event-loop/socket/dispatch delay/backlog 부족, clock step/offset 불확실성·계측 누락·미완료 workload는 INVALID RUN이다.

수집 가능한 지표와 수집됐다고 확인한 지표를 구분한다. Render 계정 metrics credential/실제 series 권한은 이번 로컬 검증에서 쓰지 않았고 별도 cloud smoke에서 확인해야 한다. Lightsail DB CPU/RAM/instance network는 같은 harness의 PG 통계 외에 native read-only collector를 실행 시 보완해야 한다. Payload bytes는 TLS·TCP 재전송/청구 네트워크 전체와 같지 않다. 빈 DB에 대한 완성 ticker JSON Redis 직주입을 baseline으로 사용하지 않는다.

## 검증 및 발견 사항

[검증 집계](evidence/verification.json), [smoke 결과](evidence/smoke-functional.json), [Decimal 실패 검출 및 복구](evidence/financial-negative-proof.json)에 최종 결과를 기록했다. 실패한 로컬 준비/실행 기록도 별도 `/tmp/trading-load-impl/`에 보존했으며 성공으로 덮어쓰지 않았다.

- 기존 금융 PostgreSQL gate: 22 suite/23 wrapper test PASS, skip 0. 내부 fixture의 원자성/rollback/fee/evidence/lifecycle/idempotency/race 검증을 그대로 실행했다.
- 관련 기존 unit: parser/gateway/supervisor/auth 5 suite/171 test PASS. ingestion/auth guard 4 suite/71 test PASS. 중복 auth suite는 총 unique test 수로 합산하지 않는다.
- Harness 38 tests PASS, Backend build/typecheck PASS, accounts lint 및 diagnostic gate PASS. CI에 동일 pure harness test를 추가했다.
- 격리 10명 smoke: ramp 인증 및 ACK 10/10, 정상 login/refresh, WS ticker/candle/book/FX 구독 ACK·해제·재연결, Spot 시장가/지정가·매칭·멱등 replay, Futures limit/market open/increase/reduce/close·취소·SL/TP/OCO 모두 기능 PASS. 90초 hold 완료, hold refresh 15회, 금융 audit 10계정/Spot 54건/Futures execution 26건/ledger 171건, finding 0. Liquidation 발생 계정은 0이며 기존 금융 gate에서 해당 정책을 검증했다.
- 연결 유지율 99.8885%, 종료 후 서버 WS clients/pending 0, send failure/coalesced/drop 0. 짧은 정상 토큰 갱신 reconnect는 기록하고 실패로 처리하지 않았다.
- Provider 외부 연결 시도 0. 운영 URL CLI guard는 network 전에 거부, 이미 사용자가 있는 DB의 migration은 거부했다.
- 실제 로컬 wallet에 0.00000001 차이를 주면 audit가 `WALLET_LEDGER_BALANCE_CHAIN`으로 CORRECTNESS FAIL을 내고, 정확한 원상 복구 후 전체 audit가 다시 PASS함을 확인했다.
- Frontend/DB schema 변경 없음. 이 단계에서 1,000개 실제 연결이나 Render 서비스 smoke는 실행하지 않았다.

초기 로컬 실패는 UTC DB 설정, Spot 6자리 수량 및 Crypto BUY amount 계약, JSONB key canonicalization, Futures pending row replay 계약, 즉시 loopback subscribe, Unicode Futures coverage, stale FX cadence 등을 드러냈다. 실제 금융 규칙을 줄이는 대신 harness 입력과 audit를 현재 계약에 맞췄다. 조건부 Futures 체결은 normal durable execute request와 protection child를 **함께** 보유하므로 이를 두 commit으로 세던 audit 오류도 실제 row/제품 코드에 맞춰 수정했다.

이 WSL에는 [기존 시계 역행 조사](../2026-10-09-wsl-clock-regression/report.md)가 있다. 이번 최종 smoke에서 약 -580/-598/-604ms의 clock step 3회를 감지해 **INVALID RUN / CORRECTNESS PASS / PERFORMANCE NOT EVALUATED**로 종료했다. HTTP unrecovered error는 0이고 내부 SLO failure도 없지만, 이것을 유효한 성능 PASS로 발표하지 않는다. 시스템 time service를 임의로 변경하거나 guard를 완화하지 않는다. 금융/인증/WS 기능 smoke 통과와 신뢰할 수 있는 latency baseline 통과는 구분해야 한다.

## 실제 Render 실행 준비 및 비용

필요한 리소스는 동일 사양의 **전용** API 1 CPU/2GB, PostgreSQL 0.5 CPU/1GB, Valkey 256MB 및 별도 Linux 발생기 2 CPU/4GB다. 기존 운영 API/PG/Valkey나 용도 불명 upgrade clone을 재사용하지 않는다. Render API는 private DB/Valkey URL, 발생기는 승인된 외부 observer URL 및 제한된 IP 접근을 사용한다. Production main startCommand는 변경하지 않고 전용 테스트 서비스에서만 compiled `serve`를 실행한다.

[공식 Render 가격](https://render.com/pricing) 기준 API $25, PG $19, Valkey $10/월을 비용 근사로 사용한다. 5GB PG storage $1.50을 더하면 약 $55.50/월 상당이고 4시간만 사용하는 근사는 $0.30대다. 가격 페이지와 compute 문서의 Valkey connection limit 표기가 달라 실제 instance INFO/계약 한도를 실행 전 확인한다. Hobby 추가 구매는 필수로 하지 않는다. Storage는 사용 데이터의 목표 크기가 아니다. [Render 과금 안내](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses).

발생기 예시는 Linux IPv4 Lightsail 2 vCPU/4GB $24/월, 4시간 약 $0.13이다. Burst credit이 소진되면 발생기가 병목이 될 수 있어 CPU/스케줄 자격을 검증한다. 이는 향후 후보·비용 근사이며 이번에 AWS를 생성하지 않았다. [Lightsail 가격](https://aws.amazon.com/lightsail/pricing/), [CPU baseline 문서](https://docs.aws.amazon.com/en_en/lightsail/latest/userguide/baseline-cpu-performance.html).

실행 payload egress 기본 예산은 90GB다. 측정되는 WS+HTTP received bytes를 합쳐 중단하지만 TLS/transport/관측/준비 송신이 추가돼 청구 상한과 동일하지 않다. 최종 10명 smoke hold의 HTTP 2,421,040 bytes + WS 14,823,291 bytes, 90초를 단순히 100배·40배 환산하면 **1,000명 hold 60분 약 68.98GB payload**다. Ramp/drain까지 약 75–85GB를 준비 기준으로 사용하며 정확한 값은 cloud에서 측정한다. 기존 70GB cap은 정상 baseline을 끝까지 유지하기에 부족할 수 있어 기본 cap을 90GB로 조정했다. 이는 실제 cloud egress나 capacity 측정이 아니다. Hobby 공식 포함량 5GB와 이미 소비한 양을 청구 화면에서 확인해야 하며 초과분 $0.15/GB면 90GB 전량 과금 근사는 $13.50이다. Compute와 transport/준비·계측 버퍼를 포함해 한 번의 4시간 실행 창에 **추가 총예산 $20**를 초기 승인안으로 제안한다. 도구의 payload cap은 청구액 hard cap이 아니므로 비용 감시와 초과 시 중단 범위를 실행 승인에 포함한다. [Bandwidth 정책](https://render.com/docs/outbound-bandwidth), [추가 과금](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses).

Baseline 시험 자체는 ramp5+hold60+drain5=70분에 cleanup/audit가 추가된다. 현재 1,000명 fixture는 약 3만개의 normal Spot 주문과 2천 Futures execution, 계정/transfer를 만드는 과정이므로 DB 사양에 따라 준비 20–60분 이상이 필요할 수 있다. 배포/metrics 확인·cloud smoke·증거 export를 포함해 3–4시간 창을 잡고 정상 1회만 실행한다. 50/100/250/500은 실패 진단 때 선택한다. 반복 3회, 10배 dataset, chaos/대규모 reconnect/강제청산/24h soak는 구현 정책으로 강제하지 않는다.

실행 명령과 credential/observer URL 형식은 [harness README](../../../backend/scripts/load-test/README.md)에 있다. `template --smoke → migrate → serve → prepare → guard → run → audit`를 사용하며 baseline에는 `--smoke` 없는 새 template와 새 fixture/전용 resources를 사용한다. API process는 JWT/거래/ingestion/risk/protection flags를 격리 진입점에서만 설정한다. 서버 런타임 pool 설정은 바꾸지 않는다.

실행 전 사용자 승인이 필요한 항목은 전용 리소스 생성·정확한 resource/URL/DB/Valkey/credential allowlist, 별도 API 배포 및 테스트용 기능 활성화, 발생기 사양/IP 접근, 1,000명 단일 70분 시험/추가 예산/egress 상한, 증거 보관 및 전용 자원 회수 범위다. 신규 리소스와 권한 없이는 도구만으로 cloud 시험을 시작하지 않는다.

최신 GET 관측에서도 운영 서비스는 main commit 자동 배포와 build의 `prisma migrate deploy`를 사용한다. [Render 공식 배포 문서](https://render.com/docs/deploys#skipping-an-auto-deploy)의 `[skip render]` commit phrase를 사용해 승인된 main push와 운영 배포 금지 조건을 함께 충족한다. 저장소 CI에는 별도 운영 deploy hook이 없다. Render 설정을 임의로 끄거나 배포를 요청하지 않는다. Push 전 live deploy는 `dep-db58lj740ujc73c8q3tg` / `3985aa1f…`이며 push 이후 GET으로 신규 deploy가 없고 live ID가 유지되는지 확인한다. 이 절차를 완료하기 전 후속 Futures25 구현을 시작하지 않는다.

## 남은 한계

이번 WSL 결과는 기능 smoke 증거이며 신뢰할 수 있는 지연 기준선이 아니다. 안정된 Linux와 승인된 전용 cloud resources에서 10명 smoke를 한 번 더 수행해 시계·Render metric 권한·발생기 headroom을 확인한 후 1,000명 1회 시험을 실행해야 한다. Production과 다른 FX 공급 주기 및 launch 기능 profile은 동일 비교 manifest에 명시한다. Liquidity/강제 청산/Chaos/24시간 soak는 workload에 강제하지 않는다. 실제 1,000명 시험 전에는 Render가 1,000명을 처리한다고 결론 내릴 수 없다.
