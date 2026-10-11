# Futures 전용 25종목 구현 및 운영 등록 준비

2026-10-11 KST. 사용자 최신 지시에 따라 `main`의 working tree에서 구현했다. **이번 변경은 커밋·push하지 않았다.** 운영 DB에는 읽기 전용 등록 Dry-run만 수행했다. 운영 상품 등록, Migration, Render 설정 변경·배포·리소스 작업과 1,000명 시험은 실행하지 않았다.

## 기준과 선정 결과

시작 시 로컬 HEAD와 갱신한 `origin/main`은 모두 `3433701c9c9815da813ed21049d6126d3b6aefb2`였고 working tree는 깨끗했다. 선행 부하 테스트 도구 push를 확인한 후 이 작업을 시작했다. 관련 현재 코드·Prisma schema·seed·등록 CLI·Provider·HTTP/WS·금융 테스트와 Frontend의 Futures 조회·표시를 다시 조사했다.

선정 근거는 [YTD 조사](../2026-10-11-binance-futures-ytd/report.md)와 [선정 CSV](../2026-10-11-binance-futures-ytd/evidence/top25-conditional-new-underlying.csv)다. 새 카탈로그 테스트가 CSV의 25개 심볼과 순서를 직접 대조한다.

등록 대상은 다음과 같다. 단위 변환이나 alias는 없다.

```text
BTCUSDT ETHUSDT SOLUSDT ZECUSDT XRPUSDT HYPEUSDT DOGEUSDT BNBUSDT
SUIUSDT NEARUSDT ADAUSDT WLDUSDT TAOUSDT ENAUSDT LINKUSDT AVAXUSDT
UNIUSDT PUMPUSDT BCHUSDT TRUMPUSDT FILUSDT AAVEUSDT LTCUSDT ASTERUSDT XLMUSDT
```

기존 Spot 고정 25개 파일은 수정하지 않았다. 두 제공 목록의 교집합은 20개이고, HYPEUSDT/PUMPUSDT/BCHUSDT/FILUSDT/AAVEUSDT가 새로운 Futures 전용 기초자산이다.

## 실제 제약과 구현 결정

`Asset.isActive`가 Spot 검색·시세·캔들·Provider target과 Futures 기초자산 유효성에 함께 사용되는 구조를 확인했다. 새 기초자산을 활성화하는 것만으로는 Spot 목록과 여러 수집 대상에 들어갈 수 있다. 반대로 비활성화하면 기존 Futures 검증이 거부한다. 초기 원인 가설은 실제 사용처와 일치했다.

기존 Spot 고정 universe와 같은 방식의 작은 순수 카탈로그 모듈을 추가했다. `isActive`는 자산의 운영 유효성으로 유지하고, 제공 상품 조건은 별도로 적용한다. **DB 필드·테이블·Migration·dependency 추가는 없다.** 이미 등록된 Spot Asset ID와 주문·보유·원장·가격 증거도 그대로 유지한다.

Spot의 목록·검색에는 DB `where`에서 신규 5개를 제외하고, 상세·가격·캔들·WS·주문·조건부 등록에는 서버 검증을 둔다. Spot의 기존 base-form 입력도 차단 대상에 포함해 기존 normalization 경로로 우회할 수 없게 했다. Futures 계약 자체는 정확한 `*USDT` identity만 허용한다. 현물의 지정가 후보 선택과 체결 재검증, market execute 및 quote 재검증도 같은 조건을 사용한다.

Futures 목록과 open/increase·limit entry의 기존 coverage 검증에 선정 25개 제공 조건을 추가했다. 계약 parser의 exact 1:1, COIN/TRADING/USDT/PERPETUAL 조건과 24시간 재검증은 유지했다. 범위 밖의 기존 open lifetime이 있는 경우에는 Last/Mark 수집과 reduce/close·조건부 exit·위험관리·시즌 정산 경로를 유지한다. 등록 CLI도 기존 범위 밖 행을 삭제하거나 강제로 비활성화하지 않고 보고한다.

Last/Mark의 활성 대상은 선정 25개이며 기존 open-position 대상 OR 조건도 유지한다. 새 5개는 일반 Spot snapshot/candle/호가 대상에 들어가지 않는다. 개별 Asset ID를 명시하는 Spot candle backfill도 Provider 요청 전에 거부한다. Binance 호가는 이미 Spot 고정 universe로 제한되어 있어 제품 코드를 변경할 필요가 없었다.

Futures 화면의 표시 정밀도는 저장한 FAPI `PRICE_FILTER.tickSize`를 우선하고, 선정 증거의 Futures tick 정밀도를 fallback으로 사용한다. 기존 presenter가 Spot universe의 tick을 재사용하던 점을 수정했다. 예를 들어 BTC Futures는 1자리, PUMP는 6자리다. 금융 계산·저장의 기존 Decimal 및 8자리 정책은 그대로다. Frontend는 기존 DTO의 `displayPriceDecimals`를 이미 사용하므로 Frontend 제품 변경은 필요하지 않았다.

## 변경 파일과 재사용

전체 Backend 변경 파일 45개는 [파일 목록](evidence/changed-backend-files.json)에 있다. 대부분 제품 변경은 기존 조회/검증에 카탈로그 조건을 한 번 추가하는 수준이다.

| 파일/영역 | 목적 |
| --- | --- |
| `src/providers/binance/binance-product-catalog.ts` 및 spec | 선정 25개, 전용 5개, Spot 조건, Futures 표시 metadata, CSV 일치 검증 |
| `src/assets/assets.service.ts`, `asset-candles.service.ts` 및 관련 spec | 일반 목록·검색·상세·시세·캔들 차단 |
| `src/assets/live-candle-event-normalizer.service.ts`, `market-candle-sync.service.ts` 및 spec, `market-candle-reconciliation.service.ts` | Spot live/backfill/reconciliation 대상 차단 |
| `src/realtime/asset-ticker.gateway.ts`, `live-candle-stream-supervisor.service.ts`, `realtime-asset-metadata-cache.service.ts` 및 spec | 기존 WS 프로토콜로 Spot ticker/candle/book 구독 거부 |
| `src/providers/provider-config.service.ts`, `provider-target-resolver.service.ts` 및 spec, `market-snapshot-health.service.ts`, Binance REST/WS ingestion | active/env/merged Spot target와 snapshot mapping에서 제외 |
| `src/orders/orders.service.ts` 및 spec, `limit-order-candidate.repository.ts`, `limit-order-execution.service.ts` | quote·create·재검증·자동 매칭 단계의 Spot 진입 차단 |
| `src/conditional/conditional-registration.ts`, `conditional-price.ts` | Spot protection 차단, Futures Last 분기는 유지 |
| `src/futures/futures-instrument-coverage.ts`, `futures.service.ts`, `futures.presenter.ts` | 제공 25개, exact coverage, Futures 표시 정밀도 |
| `src/futures/futures-last-price-ingestion.service.ts`, `futures-mark-ingestion.service.ts` 및 spec | 선정 25개 Last/Mark와 기존 open lifetime 수집 |
| `scripts/provision-futures-instruments.ts`, `scripts/lib/futures-provision-plan.ts` 및 spec | 읽기 전용 계획, 정확한 target 쓰기 가드, 승인 후 원자적 등록 |
| `scripts/load-test/prepare.ts`, `replay.ts`, README | 기존 harness를 Spot 25/Futures 25에 맞춤; 새 5개에 Last/Mark만 제공 |
| `scripts/futures-product-catalog-smoke.ts` | 기존 harness의 login/refresh·HTTP/WS·network guard·Decimal audit를 사용한 loopback ≤20명 회귀 확인 |
| `scripts/futures-integration.ts` | 가상의 임의 심볼 fixture를 선정 identity로 변경; 25개를 넘는 cursor 계정은 같은 가격 계약을 공유하고 원래 multi-batch 검증 유지 |
| `scripts/futures-collection-soak.ts` | 기존 진단 도구의 Futures universe를 선정 목록으로 갱신; soak는 실행하지 않음 |
| `test/app.e2e-spec.ts` | 기존 HTTP 목록 계약의 Spot 조건 검증 |
| Backend `docs/assets-api-contract.md`, `futures-api-contract.md`, `policy-decisions.md` | current 상품 제공·등록·표시 정책 명시 |

PrismaService, ProviderHttpClient와 Binance admission limiter, RedisService, 기존 Last/Mark ingestion, 금융 execution primitive, integration fixture, load-test replay/target guard 및 audit를 재사용했다. 거래 실행·수수료·wallet scope·예약금·margin·liquidation·lock ordering·OpsJobLock·멱등성·권한·가격 freshness 정책을 변경하지 않았다. 테스트를 삭제·skip하거나 단언을 완화하지 않았다.

## 검증 결과

요약 수치는 [테스트 요약](evidence/test-summaries.json), [금융 검증 상세](evidence/financial-gate-results.json), [최종 추가 검증](evidence/final-checks.json)에 있다.

| 검증 | 결과 |
| --- | --- |
| Backend 전체 Jest 실행 | 144 suite, 2,361 test PASS; 기존 opt-in DB test 63개 미활성은 별도 표기 |
| 새 카탈로그·등록 및 ingestion 집중 테스트 | 4 suite, 25 test PASS, skip 0; 전체 unit 결과와 중복 집계하지 않음 |
| 최종 Spot candle sync 회귀 | 기존 suite 전체 및 신규 5개 explicit backfill 차단 PASS |
| 기존 PostgreSQL 금융 gate | 원래 22 suite/23 wrapper test를 실제 실행해 각 PASS, skip 0. 실행 분리·실패 기록은 아래 설명 |
| Backend E2E | 2 suite, 404 test PASS, skip 0 |
| 기존 load-test harness 자체 | 38 test PASS |
| Backend build/typecheck, accounts/candles check lint, 신규 파일 lint | PASS |
| Frontend typecheck 및 Futures/가격 표시 관련 테스트 | 6 test 파일 PASS, skip 0; Frontend 제품 변경 없음 |
| 로컬 등록 및 반복 등록 | Asset 5개·계약 25개 생성 후 재실행 추가 생성/변경 0; Spot 25개와 금융 행 유지 |
| 등록 target 가드 / DB READ ONLY | 잘못된 apply target 거부; READ ONLY 쓰기 시 SQLSTATE 25006 확인 |
| 운영 DB Dry-run | 아래 계획 PASS, 쓰기 0 |

[5종목 집중 smoke](evidence/focused-product-smoke.json)는 실제 로그인·refresh, 인증된 HTTP/공유 WS, 기존 Provider transport replay와 DB의 Last/Mark 증거로 검증했다. Spot 목록 25개·Futures 목록 25개를 대조했고, 신규 5개 각각의 검색·상세·시세·캔들 접근을 거부했다. BUY/SELL × market/limit Spot quote 거부 20개, 기존 ticker/candle/book WS 오류 ACK 15개, Last/Mark WS 원천 5개, market open/increase/reduce/close 20체결, idempotent replay 5개, limit create/cancel 5개를 확인했다. 해당 계정의 exact Decimal 원장 chain과 예약금은 PASS이고 외부 Provider 연결 시도는 0이다.

### 시계 문제와 실패 기록

현재 WSL에서 monotonic 시간과 wall clock의 차이를 측정했으며 약 31초 주기로 -1.03~-1.14초 역행이 관측됐다. [기존 시계 조사](../2026-10-09-wsl-clock-regression/report.md)의 현상과 일치한다. 공유 DB 금융 gate의 두 실행은 각각 22 PASS/1 FAIL, 16 PASS/7 FAIL이었다. freshness 거부와 실패 후 남은 fixture가 후속 canonical-symbol fixture에 충돌하는 문제가 포함됐다. 이 실행들을 성공으로 표시하지 않았다.

각 suite를 같은 schema의 새 격리 DB에서 실행해 오염의 전파를 제거했다. 최초 분리 실행은 F1 freshness 실패 1개와 임시 실행기의 opt-in 변수 추출 오류로 F3/F3.1 미활성 2개가 있었다. 이후 F1은 시계 step 직후 원래 테스트를 그대로 실행했고, F3/F3.1은 원래 opt-in을 명시해 새 DB에서 실제 실행했다. 최종 결과는 모든 22 suite/23 test PASS, skip 0이다. 원래 일괄 runner 자체가 이 WSL에서 연속 PASS했다고 주장하지 않는다. 제품의 timestamp/freshness 검사, 테스트의 시각·단언, 시스템 시계 설정은 변경하지 않았다.

또한 최초 10명 전체 fixture audit는 [CORRECTNESS FAIL 8건](evidence/initial-full-fixture-audit.json)이다. 원장 balance chain의 timestamp 순서 역전이 확인됐으며 이 결과를 삭제하거나 tolerance로 숨기지 않았다. 집중 smoke의 계정별 PASS는 이 전체 audit를 대체하지 않는다. 안정된 Linux 시계에서 전체 fixture smoke/audit를 다시 통과시켜야 기존 부하 harness의 cloud 실행 준비가 완료된다. 이번 결과로 성능 기준선이나 Render 1,000명 수용 능력을 판단할 수 없다.

## 운영 DB 읽기 전용 등록 Dry-run

[실제 계획 JSON](evidence/production-registration-dry-run.json)의 평가 시각은 `2026-10-10T23:46:53.737Z` / `2026-10-11 08:46:53 KST`다. 대상은 기존 Singapore PostgreSQL `dpg-da7ac0e1egvs73e2sv20-a.singapore-postgres.render.com:5432/trading_app_fbbk`다.

| 대상 | 생성 예정 | 유지 | 변경 예정 |
| --- | ---: | ---: | ---: |
| 선정 25개 Futures의 기초자산 | 5 | 20 | 0 |
| FuturesInstrument | 25 | 0 | 0 |

전체 Binance Asset 행은 25→30 예정이고 Spot 제공 행은 **25→25**다. 기존 Spot의 나머지 5개도 유지한다. blockers 0, 범위 밖 기존 Futures 행 0이었다. 위 25개 심볼이 모두 현재 public FAPI의 exact TRADING COIN USDT perpetual 검증을 통과했다. 계약 정보 확인은 소수의 public exchangeInfo GET만 사용했으며 거래·계정 API나 대량 요청을 보내지 않았다.

접속 세션의 `default_transaction_read_only=on`과 코드의 `SET TRANSACTION READ ONLY`를 함께 사용했다. client `statement_timeout=15000`과 RepeatableRead로 범위를 제한했다. [Render 접속 문서](https://render.com/docs/postgresql-creating-connecting)에 따른 TLS `sslmode=verify-full`로 인증서 검증도 유지했다. 연결 credential은 기존 관리 도구에서 메모리로 받아 사용했고 파일·문서·테스트 credential에 보관하지 않았다.

Dry-run의 ProviderHttpClient rate admission은 명시한 **loopback Redis**를 사용한다. 운영 Valkey에는 접속하거나 limiter 키를 쓰지 않는다. API 공개 요청·금융 쓰기·운영 설정 변경 없이 계획 조회만 수행했다. 적용은 loopback 전용 DB에서만 검증했다.

## 운영 적용 전에 필요한 작업과 위험

1. 이 미커밋 변경을 리뷰하고 사용자가 승인한 별도 배포 절차로 새 카탈로그 코드를 먼저 운영에 배포한다. **현재 운영 코드에 신규 활성 Asset 5개를 먼저 등록하면 Spot에 노출될 수 있다.** 거래 mode는 DISABLED를 유지한다.
2. 안정된 Linux에서 금융 gate와 전체 fixture smoke/audit를 재확인한다. 현재 WSL의 전체 audit 실패는 해결되거나 다른 환경에서 검증되기 전까지 cloud load-test의 GO 근거가 될 수 없다.
3. 실제 배포 SHA와 전체 effective 환경변수를 다시 확인한다. [읽기 전용 service-level 조회](evidence/service-level-flags-readonly.json)에는 Futures 관련 override가 없었다. 이 결과만으로 연결된 env group까지 검증했다고 간주하지 않는다. 이번 작업은 `FUTURES_TRADING_MODE` 기본 DISABLED와 운영 환경변수를 변경하지 않았다.
4. 등록 직전 최신 FAPI와 운영 DB를 다시 Dry-run해 현재의 5/25 생성 계획 및 Spot 25 유지가 유효한지 확인하고 **상품 등록 쓰기에 대한 사용자 별도 승인**을 받는다. 이 보고서의 계약 검증을 장기 유효한 증거로 사용하지 않는다.
5. 승인 후 `--apply`와 정확한 target assertion을 함께 사용한다. 한 Serializable transaction에서 기초자산·계약만 등록한다. 중간 오류는 rollback하고, 예상 밖 inactive/identity/Spot universe 변화는 fail closed한다. 24시간이 지난 metadata의 갱신은 계획의 `change`에 나타날 수 있다.
6. 수집 활성화가 필요한 경우 Last/Mark ingestion 관련 운영 flag 변경은 별도 승인으로 진행한다. 등록만으로 꺼진 collector를 켜지 않는다. `FUTURES_LAST_PRICE_INGESTION_ENABLED`, `FUTURES_MARK_INGESTION_ENABLED`와 실제 수집 상태를 확인하며 `FUTURES_TRADING_MODE=DISABLED`를 유지한다. 이번 작업에서 flag 변경·배포·거래 enable을 실행하지 않았다.
7. 등록 후 인증된 조회와 기존 readiness 도구로 Spot 25/Futures 25, 신규 5개 Last/Mark source·identity·freshness, 가격 표시를 확인한다. Spot 캔들·호가·현재 사용자 보유·원장에 변경이 없는지도 확인한다. 신규 계약마다 Last/Mark socket에 각 1개씩 총 25 stream이 대상이며 Spot 기존 고정 universe와 구독 상한을 바꾸지 않았다.

등록 CLI 명령은 Backend에서 실행한다. 아래는 절차를 보여주는 예시이며 production `--apply`는 이번에 실행하지 않았다. `DATABASE_URL`은 승인된 연결 방식으로 공급하고 출력하거나 파일에 저장하지 않는다.

```bash
# 읽기 전용 재확인: 별도 loopback Redis가 필요하다.
FUTURES_PROVISION_DRY_RUN_REDIS_URL=redis://127.0.0.1:56388/0 \
  npm run futures:provision-instruments -- --dry-run

# 새 코드 배포와 등록 승인 후에만 실행. READ ONLY client 옵션은 apply에 사용하지 않는다.
FUTURES_PROVISION_EXPECTED_TARGET='<승인된 host:port/database>' \
  npm run futures:provision-instruments -- --apply
```

테스트 재현은 기존 Backend Jest/gate와 [harness README](../../../backend/scripts/load-test/README.md)를 따른다. 집중 회귀 runner는 loopback target과 ≤20명 manifest만 허용한다.

```bash
npm run typecheck
npm run build
npm run lint:accounts:check
npm run lint:candles:check
npm run test:load-test
npx jest --runInBand
npm run test:e2e -- --runInBand
npx tsx scripts/futures-product-catalog-smoke.ts \
  /path/to/smoke.manifest.json /path/to/test.credentials.json /path/to/fixture.json
```

임시 검증에만 사용한 suite별 새 DB 실행기는 `/tmp`에 두고 제품 테스트 프레임워크로 추가하지 않았다. 전체 금융 gate의 파일·opt-in은 기존 [실행 스크립트](../2026-10-10-futures-last-price-followup/reproduction/run-financial-gate.sh)를 그대로 사용했다. 현재 등록·검증에 추가 유료 리소스 비용은 발생하지 않았다. 향후 부하 비교는 **같은 코드 SHA·상품 카탈로그·새 replay fingerprint·fixture 조건**으로 Render/Lightsail 양쪽을 실행해야 한다. 기존 24계약 baseline fixture와 새 25계약 fixture의 결과를 동일 workload로 비교하면 안 된다.
