# KRX completed-session 복구 수정 및 장중 공백 조사

검증일: 2026-09-16. 운영 변경 없이 코드 수정, 운영 DB 읽기 전용 조회, 로컬 HTTP fixture/PostgreSQL 검증을 수행했다.

## A. 시작 / 종료 상태

- 시작 HEAD, 종료 HEAD, 로컬 `origin/main`: `7900895c18fe4d8f82f85c6dc54a5c621adcba9e`.
- 시작 `git status --short`, `git diff`, `git diff --staged`는 모두 비어 있었다. 최근 15개 commit도 확인했다.
- 종료: 아래 관련 파일만 미커밋 상태. commit/push/branch/worktree 생성 없음. 원격 fetch 없이 현재 local ref를 확인했다.

## B. 기존 분석 검증

분석의 핵심은 현재 코드와 일치한다. 기존 startup catch-up은 missing coverage를 감지한 뒤 REST current-price ingestion을 호출했다. 실제 current-price 응답에는 거래일/체결시각이 없어 parser가 receipt time을 effectiveAt으로 사용한다. 휴장 후 만들어진 row는 완료 세션 밖이므로 selector가 거절한다. catch-up은 ingestion의 success/failed 개수만 검사했으므로 평가 가능한 가격이 없어도 completed를 기록할 수 있었다.

기존 current-price unit fixture에는 공식 응답 필드 목록에 없는 `stck_bsop_date`, `stck_cntg_hour`가 들어 있었다. 실제 timestamp-less 입력으로 수정했고, `sourceTimestamp=null`, `effectiveAt=receivedAt`임을 검증한다. parser의 기존 receipt fallback 자체는 수정하지 않았다. 해당 입력을 completed-session 복구에 사용하던 호출 경로를 수정했다.

반박되는 핵심 사실은 발견하지 못했다. 장중 snapshot 부재의 원인은 기존 분석에서도 미확정이며 이번 수정과 분리한다.

## C. 휴장 복구 실패 원인

기존 흐름:

```text
latest completed-session coverage 없음
→ startup catch-up
→ KIS current-price REST 수신
→ provider timestamp 없음
→ effectiveAt = 장 마감 후 receivedAt
→ AssetPriceSnapshot row 생성 성공
→ catch-up completed 오판
→ shared selector: effective_at_outside_last_completed_session
→ Market unavailable / Position stale_cache / Portfolio unavailable
```

최초 제품상 잘못된 선택은 **세션 귀속을 증명하지 못하는 current-price 응답을 completed-session 복구 근거로 사용한 것**이다. DB는 전달받은 값을 저장했고 selector는 정책대로 거절했다. 성공 판정에 소비 계층 재검증이 없었던 것도 복구 결함이다.

## D. 선택한 provider evidence

KIS 국내주식 기간별시세 `FHKST03010100`, `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`를 사용한다.

- `FID_COND_MRKT_DIV_CODE=J`: KRX. NXT/통합시세로 바꾸지 않는다.
- `FID_INPUT_DATE_1=FID_INPUT_DATE_2`: Backend Calendar가 결정한 당일 완료 세션 거래일.
- `FID_PERIOD_DIV_CODE=D`: 일봉.
- `FID_ORG_ADJ_PRC=1`: 원주가. 과거 수정주가를 평가가격에 사용하지 않는다.
- `rt_cd=0`, `output1.stck_shrn_iscd` 일치, `output2.stck_bsop_date`가 대상 거래일과 정확히 일치하는 row가 하나인 경우만 인정한다.
- 기존 일봉 normalizer로 양수 OHLC, 가격 범위 일관성, 거래량, 실제 세션 종료 여부를 검증한다. 요청일 이전/이후 row나 중복 row, 날짜 누락, 잘못된 종목, provider 오류를 거절한다.

공식 근거: [KIS 요청 계약](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/inquire_daily_itemchartprice.py), [KIS 응답 필드](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/chk_inquire_daily_itemchartprice.py), [current-price 응답 필드](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_price/chk_inquire_price.py).

`stck_clpr`가 해당 거래일의 **종가**라는 의미를 근거로 `effectiveAt`을 그 거래일의 Calendar closeTime으로 정규화한다. 임의 current-price를 closeTime에 끼워 넣는 동작은 없다. 실제 수신 시각 `capturedAt`은 보존하며, provider가 체결시각을 제공하지 않으므로 `sourceTimestamp`는 null이다. raw metadata에는 endpoint/query/거래일/종가 row/원응답/`effectiveAtBasis=provider_daily_close_trading_date`를 남긴다. 기존 payload 크기 제한과 secret redaction을 재사용한다.

기존 `kis_krx_realtime_trade`는 현재도 KIS REST와 WebSocket이 공유하는 적격 source family이다. 이를 유지하며 raw metadata의 `messageType=rest_session_close`로 출처를 구분한다. source allowlist를 넓히지 않았다. 기존 candle reconciliation은 candle 저장 경로이므로, 그 전체 파이프라인을 snapshot 복구에 연결하지 않고 기존 client/endpoint 상수/normalizer만 재사용했다.

공식 계약과 동일한 형태의 로컬 HTTP 응답으로 검증했다. 이번 작업에서 운영 KIS 일봉 응답을 새로 요청하거나 운영 snapshot을 생성하지 않았다.

## E. 복구 성공 기준

1. 기존 health로 configured domestic symbols 중 missing session coverage만 선택한다.
2. 종목별로 shared DB query/selector를 재확인한다. 다른 writer가 이미 채웠으면 provider call 없이 종료한다.
3. 일봉 evidence를 검증한 뒤 snapshot을 저장한다.
4. 기존 `checkActiveAssetCoverage`를 다시 실행한다. **요청했던 모든 asset이 available**이어야 completed이다. 전체 universe의 미지원 종목/FX 상태로 이번 복구 성공을 판단하지 않는다.
5. 실패하면 `COMPLETED_SESSION_PRICE_UNAVAILABLE`과 assetId/symbol별 실제 이유를 기존 Logger에 남긴다. created=1이어도 coverage가 unavailable이면 failed임을 unit으로 검증한다.

## F. 소비 계층

Market 목록/Asset Detail/ticker, Position, Portfolio, Home의 코드와 공개 API 계약은 그대로다. 복구된 row가 기존 shared selector를 통과하므로 소비 계층 모두 같은 snapshot을 사용한다. Position의 과거 cache를 Portfolio 가격으로 사용하는 경로는 없다.

통합 fixture는 Samsung 248,500원×2주, Kia 122,200원×3주와 현금 10,000,000원을 사용하여 GENERAL/SEASON의 총자산 `10,863,600.00000000`까지 확인한다. 이 값은 테스트 값이며 운영 가격이라는 뜻이 아니다. 자산 mapping을 실제로 거치되 다른 로컬 자산을 건드리지 않도록 고유한 6자리 fixture symbol을 사용한다.

## G. Fail-safe

세션 귀속 근거가 없으면 snapshot을 만들지 않는다. 기존 post-close receipt row가 있더라도 그대로 거절된다. Market unavailable, Position stale_cache, Portfolio ASSET_PRICE_UNAVAILABLE/summary=null을 유지한다. 이전 거래일 무조건 fallback은 없다.

예: `KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS`, `KIS_SESSION_CLOSE_SYMBOL_MISMATCH`, `KIS_SESSION_CLOSE_INVALID_OHLCV`, `KIS_SESSION_CLOSE_NOT_COMPLETED`, `KIS_RESPONSE_NOT_SUCCESS`.

## H. 장중 snapshot 0건 조사 — 미확정

운영 DB 접속은 `default_transaction_read_only=on`, `BEGIN READ ONLY`, statement timeout을 사용했고 마지막에 ROLLBACK했다. 이번 재조회 결과:

| 관측                                                                 | 결과                                   |
| -------------------------------------------------------------------- | -------------------------------------- |
| 2026-09-16 09:00–15:30 KST 전체 자산의 capturedAt 기준 가격 snapshot | 0건                                    |
| 같은 시간 ops_job_runs.startedAt 기록                                | 0건                                    |
| Kia 당일 첫 snapshot receipt                                         | 16:24:42.544 KST                       |
| Samsung 당일 첫 snapshot receipt                                     | 16:24:42.850 KST                       |
| 조회 시점의 당일 Kia snapshot                                        | 134건, 마지막 receipt 21:21:07.799 KST |
| 조회 시점의 당일 Samsung snapshot                                    | 695건, 마지막 receipt 21:21:09.994 KST |

두 종목의 첫 effectiveAt도 첫 receipt와 같다. 이전 분석의 해당 완료 세션 적격 snapshot 0건, 장후 REST 수신 및 장후 WS 수신과 일치한다. **DB 기록 부재는 backend 중단/인증 실패/구독 실패 중 하나를 증명하지 않는다.** ops job 자체가 비활성일 수도 있다.

조사한 경로: streaming enabled/provider gate → startup catch-up → approval authentication → configured domestic watchlist → subscription send → ACK → parser → asset mapping → duplicate/throttle → snapshot create → realtime cache/event/gateway. catch-up은 OPEN에서 일찍 반환하므로 이번 복구 변경은 장중 수집을 가로막지 않는다. WS transport를 장 종료 때 끊는 변경도 없다.

`connected with N subscriptions`는 구독 요청 전송 수이며 성공 ACK 수가 아니다. `acknowledged`, `receivedFrames`, `created`, `skipped`, `failed`, `lastMessageAt`, `lastSnapshotAt`, `lastErrorCode`, `subscriptionSkips`를 별도로 봐야 한다. 이런 메모리 상태는 재배포 후 과거 값을 복원하지 못한다.

이 환경에 Render 로그 커넥터/인증된 운영 로그 접근 수단이 없어 runtime/deploy 로그를 확인하지 못했다. 원인 확정에 필요한 추가 자료:

- Render runtime + deploy/event 로그: **2026-09-16 08:50–16:35 KST** (UTC **2026-09-15 23:50–2026-09-16 07:35**). 직전 process 시작/중단 시각까지 확장한다. start/stop/restart/suspend/crash/health-check와 배포 SHA/instance를 대조한다.
- 해당 실행 인스턴스의 당시 `PROVIDER_INGESTION_ENABLED`, `KIS_MARKET_DATA_ENABLED`, `KIS_WS_STREAMING_ENABLED`, `KIS_DOMESTIC_SYMBOLS` 및 KIS 환경/URL 설정. key/secret/token 값은 필요 없다. 로컬 .env가 당시 Render 설정이라는 가정은 하지 않는다.
- `KisWebSocketStreamingService`: connected, reconnect scheduled, configuration failed, status changed; `KIS_WATCHLIST_EMPTY`, `KIS_SUBSCRIPTION_ACK_FAILED`, `KIS_WEBSOCKET_ERROR`, `KIS_WEBSOCKET_CLOSED`, `KIS_WEBSOCKET_HEARTBEAT_TIMEOUT`, approval/auth/provider 오류. symbol별 구독 요청과 ACK의 rt_cd/msg_cd 및 연결 식별 정보.
- 보존된 health/status가 있으면 위 카운터와 마지막 시각. provider trade frame의 H0STCNT0 symbol/BSOP_DATE/STCK_CNTG_HOUR, parse 실패 이유.
- ingestion 결과: ASSET_MAPPING_NOT_FOUND/AMBIGUOUS, DUPLICATE_PROVIDER_SNAPSHOT, THROTTLED_PROVIDER_SNAPSHOT, created/failed 및 DB 오류. 일반적인 skip은 전부 영속 로그로 남는 구조가 아니므로 기록이 없다고 성공으로 해석하지 않는다.
- read-only DB: 두 종목의 effectiveAt/capturedAt/source별 시간대 집계, raw metadata의 provider date/time, 당시 자산 활성/통화/mapping, ops_job_runs 및 calendar override 변경 이력.

따라서 **문제 A(장중 수집 공백)의 최초 실패 지점과 정확한 장애 시각은 미확정**이다. **문제 B(휴장 복구 경로 결함)는 확정했고 수정했다.** B 수정으로 A까지 해결했다고 주장하지 않는다.

## I. KIS 변경 범위

| 계층                                                        | 변경                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| WebSocket transport/subscription/reconnect/parser/ingestion | 없음                                                                        |
| REST auth/quote client/rate limiter                         | 없음, 그대로 재사용                                                         |
| REST current-price parser/ingestion                         | production 변경 없음, 실제 계약에 맞춰 fixture 수정                         |
| session-close parser/ingestion                              | 추가: 날짜·종목·OHLCV·마감 검증 후 기존 snapshot에 저장                     |
| startup recovery                                            | current-price 호출을 dated daily-close 호출로 교체, 저장 후 coverage 재검증 |
| selector/health/calendar/consumer/API/frontend              | production 변경 없음                                                        |

## J. General / Season

복구 서비스는 tradingAccount mode를 입력받지 않는다. validity/session eligibility는 자산과 Backend Calendar에만 의존한다. 실제 PostgreSQL에서 두 계좌 mode가 같은 recovered snapshot을 선택하고 같은 총자산을 계산했다. Season lifecycle/참가 정책은 수정하지 않았다.

## K. Order regression

휴장 carry-forward 허용 workflow와 orders quote/execute는 그대로 분리된다. 기존 orders unit의 휴장 quote/create/execute 거절과 PostgreSQL/Release-critical E2E를 유지했다. 새 recovery 통합에서도 GENERAL/SEASON 모두 복구 후 market quote가 MARKET_CLOSED임을 확인했다.

## L. 성능 / 복잡도 / 한계

- 기존처럼 process startup당 한 번만 실행하고 재연결 때 재실행하지 않는다. 당일 regular session 종료 후 configured missing symbol당 일봉 요청 최대 1회. 기존 current-price 요청을 대체한다. token cache와 기존 shared rate limiter를 사용한다.
- 이미 coverage가 있거나 OPEN/주말/휴일이면 추가 provider 호출 없음. 주말·휴일에는 기존 latest completed-session 가격을 계속 사용한다.
- 복구 대상마다 자산/기존 snapshot 확인, 성공 시 snapshot insert가 추가되고, 실제 복구를 시도한 batch에 health 조회 1회가 추가된다. 지속 polling/queue/table/distributed engine 없음.
- 기존 startup-only 트리거를 유지한다. 장중에 시작해 계속 실행 중인 process에 새 일일 recovery timer를 추가하지 않았고, 실패 직후 자동 재시도도 추가하지 않았다. 이 변경은 기존 startup 복구의 정확성을 고친다.
- 운영 배포와 운영 daily-close live 응답 확인은 수행하지 않았다. provider가 근거를 제공하지 못하면 기존 fail-safe가 유지된다.

## M. 검증

Node 24.14.1, pnpm 10.33.0(CI 버전), frontend npm. 로컬 PostgreSQL 16의 **서로 다른 일회용 DB**를 core/limit job에 사용했고 Redis도 로컬 별도 port로 실행했다. migration은 기존 파일을 로컬에 적용했다. 운영 접속을 차단한 test process 설정을 사용했다.

| 검증                                       |               PASS | FAIL |                                  SKIP |
| ------------------------------------------ | -----------------: | ---: | ------------------------------------: |
| Backend 전체 Jest                          | 2,775 (193 suites) |    0 | 45 (41 suites, 기존 opt-in 패턴 포함) |
| 관련 parser/ingestion/catch-up 단위 재실행 |      41 (4 suites) |    0 |                                     0 |
| Core account PostgreSQL                    |     18 (18 suites) |    0 |                                     0 |
| Limit/order/FX PostgreSQL                  |     11 (11 suites) |    0 |                                     0 |
| Release-critical E2E                       |                341 |    0 |                                     0 |
| Frontend 전체                              |                757 |    0 |                                     0 |

Core의 18개에는 기존 KRX closed-price와 새 recovery 통합 wrapper가 각각 포함되며 각 script는 5개 시나리오를 실행한다. 전체 unit 명령은 저장소 관례상 DB integration opt-in을 비활성화한다. 요청된 통합 검증은 위 별도 실행에서 모두 활성화했고 skip이 없다. 기존 assertion/시나리오를 제거하지 않았다.

Production typecheck/build PASS. CI candle lint/format, account lint, 변경 파일 전체 lint/format PASS. `git diff --check` PASS. 전체 저장소 check-only lint는 **기존 미변경 파일의 1,393 errors / 32 warnings**로 FAIL이며 이번 변경 파일의 오류는 0이다. 이를 회피하기 위해 lint 규칙/범위를 변경하지 않았다.

실행 명령(backend에서, DB/Redis는 로컬 URL 지정):

```bash
pnpm exec jest --runInBand
pnpm exec jest --runInBand src/providers/kis/kis-krx-session-close.parser.spec.ts src/providers/kis/kis-krx-session-close.ingestion.service.spec.ts src/providers/kis/kis-krx-startup-catch-up.service.spec.ts src/providers/kis/kis-rest-current-price.ingestion.service.spec.ts
pnpm exec tsx scripts/krx-session-close-recovery-integration.ts
pnpm run test:e2e --runInBand
pnpm run typecheck
pnpm run build
pnpm run lint:candles:check
pnpm run format:candles:check
pnpm run lint:accounts:check
pnpm exec eslint --no-fix --max-warnings=0 src/providers/kis/kis-krx-session-close* src/providers/kis/kis-krx-startup-catch-up* src/providers/kis/kis-rest-current-price.ingestion.service.spec.ts src/providers/providers.module.ts scripts/krx-session-close-recovery-integration.ts src/portfolio/krx-session-close-recovery.integration.spec.ts
pnpm exec eslint --no-fix '{src,apps,libs,test}/**/*.ts'
```

Core/Limit integration은 `.github/workflows/ci.yml`의 각 job에 있는 전체 `pnpm exec jest --runInBand ...` 목록과 해당 opt-in flags를 그대로 실행했다. 새 recovery wrapper도 Core CI 목록에 추가했다. frontend에서는 `npm test`로 핵심 KRX 테스트를 포함한 전체 suite를 실행했다.

새 통합의 5개 CASE:

1. completed-session row 0건에서 실제 current-price HTTP 응답→receipt snapshot→unavailable 재현 후, dated-close HTTP 응답→parser→ingestion→PostgreSQL→shared selector→모든 소비 계층 복구.
2. 일봉 거래일 근거 누락: 추가 row 없음, recovery failed와 구체적 이유, Market/Position/Portfolio fail-safe.
3. 이미 coverage 존재: provider call 0회. 동일 bootstrap promise 반복도 호출 0회.
4. 주말/휴일: 오늘자 recovery 0회, 직전 완료 세션 가격으로 모든 소비 계층 평가.
5. OPEN: recovery 호출/DB 변경 없음, 기존 실제 WS frame parser→ingestion→가격 available.

## N. DB

schema/migration/table/index 변경 없음. 운영 DB에 INSERT/UPDATE/DELETE/DDL 없음. 기존 AssetPriceSnapshot/provider metadata를 사용한다. 로컬 테스트에서는 기존 migration 적용과 테스트 fixture 생성/정리만 수행했다.

## O. 변경 파일 / diff 검토

Production:

- `src/providers/kis/kis-krx-session-close.parser.ts`
- `src/providers/kis/kis-krx-session-close.ingestion.service.ts`
- `src/providers/kis/kis-krx-startup-catch-up.service.ts`
- `src/providers/providers.module.ts`

검증/문서:

- 위 parser/ingestion/startup의 spec 3개
- `src/providers/kis/kis-rest-current-price.ingestion.service.spec.ts`
- `scripts/krx-session-close-recovery-integration.ts`
- `src/portfolio/krx-session-close-recovery.integration.spec.ts`
- `../.github/workflows/ci.yml`
- `docs/policy-decisions.md`
- 이 보고서

전체 diff와 새 파일을 검토했다. unrelated refactor, provider 근거 없는 timestamp, selector/source 완화, 주문 정책 변경, frontend Calendar, WebSocket daily disconnect, 테스트 assertion 약화, any/@ts-ignore 추가, 대규모 abstraction, 운영 수정은 없다. 새로운 로직은 기존 KIS client/Calendar/normalizer/snapshot/health를 재사용하는 복구 경로에 한정된다.
