# 코스콤 국내주식 전환 구현·검증 기록

검증 기준일: 2026-10-10. 실제 API 키, Render, 운영 DB/Redis를 사용하지 않았다.

## 시작 상태와 조사 결과

- 로컬 HEAD와 로컬에 저장된 `origin/main`은 모두 `ed3a1904376f81c86236a5af392312bb50c420b8`이었다. 원격 fetch는 하지 않았다. 커밋·배포·환경변수 등록도 하지 않았다.
- 시작부터 변경되어 있던 `docs/investigations/2026-10-10-futures-last-price-followup/evidence/soak-24h-final/soak-24h.json`과 `.json.samples.jsonl`은 별도 실행의 증거 파일이며 수정·복원하지 않았다.
- `/tmp/trading-binance-rest-weight`의 `fix/binance-rest-weight-observability` 작업을 확인했다. 해당 작업의 공통 HTTP/Binance 파일과 워크트리는 수정하지 않았다. 존재하지 않는 경로의 prunable 워크트리 3개도 정리하지 않았다.
- 기존 주식 집합은 국내 15종목·미국 25종목이다. 국내 DB 시장 `KRX`에는 KOSDAQ 종목도 포함되어 있었다. 코스콤 시장별 목록에서 기존 종목의 실제 시장을 확인하며 ID·활성 여부·종목 수를 바꾸지 않는다.
- 국내·미국은 KIS 설정, REST 인증/요청, WebSocket 및 수집 진입점을 공유했다. 국내 전송 대상을 제거하고 미국 연결·인증·종목 목록을 유지했다. Binance 현물·선물 공급 코드는 교체하지 않았다.
- 가격 선택은 `source-eligibility.policy.ts`에서 주문·견적·평가·홈·랭킹·스냅샷에 공통 적용된다. 신규 국내 가격은 코스콤 출처만 선택하고, 과거 KIS evidence는 일별 스냅샷·시즌 정산 경로에서 읽을 수 있게 유지했다.
- 차트는 PostgreSQL 5분/일/주 기본 봉, 15분·30분·1시간·4시간 집계, Redis 캐시와 수집/복구 락을 이미 사용했다. 기존 호환 1분 조회도 유지한다. 분봉 보관·조회 정책과 공급자가 실제 제공하는 과거 범위는 별개로 다룬다.
- 국내 호가는 기존 스냅샷과 최우선 호가 계약에 연결했다. 별도의 국내 호가 화면은 추가하지 않았다.

## 구현 결과

| 영역 | 변경 및 보존 |
| --- | --- |
| 인증·HTTP | 독립 KOSCOM 환경변수, v3 GET `apikey`, 허용된 운영/테스트 origin, 숫자 토큰 정밀도 보존, 고정 오류 코드와 비밀정보 제거 |
| 매핑·현재가·호가 | 공식 목록 캐시, 같은 시장 최대 20종목, KOSPI/KOSDAQ 분리, KONEX 단일 요청, Decimal 정규화·등락 부호·10호가·유효 시각 검증 |
| 수집·배포 | 기존 스케줄러/실시간 supervisor, Redis 소유권 및 전체 호출 제한, PostgreSQL 증거 저장, 기존 canonical 가격 PubSub·ticker 계약 |
| 분봉 | 당일 KST의 코스콤 1분봉, 95분 이하 요청 창·응답 100건 제한, 완성된 연속 구간만 5분봉으로 집계, 기존 상위 집계 재사용 |
| 실시간 차트 | 중앙에서 분당 native 분봉 조회, 정확한 절대 OHLCV를 기존 Redis reducer/publisher/finalizer에 전달. 현재가 표본으로 거래량·고저가를 만들지 않음. 마지막 constituent 누락 시 REST 복구 |
| 일·주봉·장 종료 | 최대 100건의 D/W 날짜 창 조회, 기존 주 기준일 정규화, 정확한 거래일이 있는 D history로 종료 가격 복구·coverage 재검사 |
| 과거 데이터 | 기존 PostgreSQL 행 삭제·재라벨링 없음. CLOSED KIS 분봉/일·주봉은 겹치는 KOSCOM import로 덮어쓰지 않음. 응답 및 live overlay에서 혼합 출처 표시 |
| KIS 정리 | 국내 WebSocket 구독·수집 대상 제거, 국내 REST 경로 인증 전 차단, 국내 startup/close/minute/period 어댑터 런타임 등록 제거. 과거 파서·공통 시간/Decimal 집계 도구·기존 테스트는 유지 |
| 금융·UI | 주문/체결/수수료/예약금/원장/시즌/랭킹 계산 코드는 변경하지 않음. frontend 변경은 공급자 메타데이터 TypeScript 타입뿐이며 HEAD 대비 컴파일된 JavaScript 동일 |

API별 연동 상태, 환경변수 전체, 재시도·잠금·호출량 및 키 등록 후 절차는 [운영·연동 문서](../../../backend/docs/koscom-market-data.md)에 있다.

## 호출량과 장애 처리

기본 동시 HTTP 수는 2개(최대 4), 요청 시작 간격은 200ms, 가격/호가 수집 주기는 완료 후 3초다. 기존 scheduler 타이머 경로에서도 같은 프로세스와 Redis 수집 락으로 겹친 수집을 막는다. 21종목은 20+1로 분할하고 시장을 섞지 않는다. 현재 집합의 정상 가격/호가 cycle은 두 시장 × 두 API = 4회다. live chart를 켜면 별도로 최대 15회의 intraday 요청/분이 추가되며 같은 전역 HTTP 제한을 공유한다. 사용자 접속 수와 무관하다.

네트워크·timeout·5xx는 500ms 후 한 번 재시도한다. 401/403, 비정상 응답은 재시도하지 않으며 429는 공통 10초 cooldown을 사용한다. 개별 시장/묶음 실패는 성공한 다른 결과를 폐기하지 않는다. 누락·중복 종목, 역순/미래/오래된 가격과 빠진 분봉을 정상 데이터로 채우지 않는다. API 키 또는 Redis 조정 기능이 없으면 외부 호출을 수행하지 않는다.

## 로컬 검증

| 검사 | 결과 |
| --- | --- |
| 1단계 신규 HTTP/정규화/수집 테스트 | 53개 통과 후 다음 단계 진행 |
| 1단계 영향 회귀 검사 | 120개 통과 |
| 2단계 캔들/계약 회귀 검사 | 108개 통과 후 통합 단계 진행 |
| 최종 native 실시간·캐시·수집 영향 검사 | 248개 통과 |
| 최종 backend 전체 Jest | 260 suite, **4,234개 통과**, 62 suite/85개 opt-in 검사 미실행(신규 DB 보존 검사 포함), 실패 0 |
| backend `pnpm run typecheck` | 통과 |
| backend `pnpm run lint:candles:check` | 통과, warnings 0. 신규 코스콤 파일을 npm script 범위에 포함 |
| frontend `npm run typecheck` | 통과 |
| frontend `npm run check` | **최종 전체 재실행 통과**: lint:accounts:check, lint:guides:check, typecheck 및 2,176개 테스트 통과, 실패 0 |
| `git diff --check` | 통과 |

백엔드 전체 테스트는 제한 시간 180초, Node heap 2GB, 직렬 Jest로 실행했다. 샌드박스의 tsx 자식 IPC 소켓 제한으로 실패했던 2개 suite는 해당 제한이 없는 로컬 실행에서 통과했다. 운영 연결은 사용하지 않았다. 샘플 수치·임시 인증 문자열을 사용하며 실제 API 키를 fixture에 넣지 않았다.

프런트엔드 첫 전체 실행은 159/160 파일 통과, `FuturesScreen.test.ts` 1파일 실패였다. 세부 실행에서 수량 입력 직후 버튼 활성 상태의 타이밍 관련 실패를 확인했다. 같은 케이스 단독, 원래 HEAD의 해당 파일, 샌드박스 밖의 현재 해당 파일(46개)이 모두 통과했다. 테스트나 선물 UI 코드를 수정하지 않았다. 최종 전체 `npm run check` 재실행은 2,176개 테스트가 모두 통과했다. 초기 실패는 비재현으로 남으며 원인을 단정하지 않는다.

신규/변경 테스트는 금융 Decimal 문자열·boolean·작은 DTO 중심으로 검증했다. ReactTestInstance 같은 큰 참조 객체를 null/undefined와 직접 비교하지 않았다. 기존 테스트를 삭제·skip하거나 필요한 assertion을 줄이지 않았다.

### 커버한 주요 사례

- 1·20·21·43종목 분할, 시장 분리, 동시 호출 한도, 동일 요청 병합, KONEX 단일 요청, 일부 실패, timeout/503 재시도, 인증 오류·HTTP 200 오류·빈/비정상 payload.
- 등락 1/2/6/7 상승·4/5/8/9 하락·3 보합, 거래대금 정밀도, 10호가 잔량과 정렬, 누락/중복 심볼, 역순 체결시각, 오래된 제공자 시각, KIS 신규 fallback 차단.
- 실제 DB 메서드 입력 및 기존 Redis 이벤트 구조, dry-run 무쓰기, 최대 스냅샷 수, 쓰기 직전 분산 소유권 재검사, 장 종료 정확한 거래일/coverage 재조회.
- 역순 1분봉→5분봉→15분봉 정확한 OHLCV/대금, 누락 구간·충돌 중복, 현재 부분 봉과 완성 봉, 날짜·휴장·특수 장 시간, bounded 과거 조회, D/W 및 legacy/mixed 출처, cache round-trip·live overlay·finalization.
- 기존 미국 KIS/Binance, 국내 주문/지정가·포트폴리오·홈·지갑/원장·시즌/랭킹 회귀 suite.

## 미실행·제약

- 실제 코스콤 인증/연결/운영 응답·호출 한도·장 시간별 신선도는 **미검증**이다. 제공된 명세 및 공식 문서 예시로 구현했다.
- `inddTm`은 공식 첫 10분 예시 09:10을 근거로 구간 종료 시각으로 해석했다. 실제 1분 응답과 09:00/09:05/15:30 경계로 반드시 확인해야 한다. 실제 응답이 다른 경우 코드를 검증 결과에 맞춰 조정해야 한다.
- 당일 이전 공급자 분봉 복구 범위는 보장하지 않는다. DB에 있는 기존 봉은 그대로 조회한다. 분봉 실시간 갱신은 완성된 native 1분 데이터의 가용성에 따른다.
- KOSCOM 수정주가와 기존 KIS 수정주가의 기업행사 경계 연속성은 실데이터로 확인해야 한다. 기존 CLOSED KIS 행을 덮어쓰지 않는 정책 때문에 과거 수정 재산출은 별도 데이터 정책이 필요하다.
- PostgreSQL/Redis opt-in 통합 검사는 전용 로컬 환경이 없어 실행하지 않았다. CLOSED KIS 행 보존 SQL의 통합 테스트는 작성했지만 실제 DB에서 실행되지 않았다. 다중 서버 실제 failover, 기기 UI, 운영 배포도 미검증이다.
- 주문 execute의 기존 10초 freshness는 유지한다. 폴링 지연/마지막 체결 노후화로 이 한도를 넘으면 주문 가능 가격으로 취급하지 않는다. 무제한 요청이나 가짜 fallback을 사용하지 않는다.
- 금융 저장 스키마의 기존 Decimal(24,8) 범위를 넘는 값은 저장 대상으로 거절한다. 대형 원본 숫자는 정밀한 문자열로 보존하며 DB 스키마를 확대하지 않았다.

## 변경 파일

아래는 이 작업의 코드·계약·검증 파일 목록이다. 병행 soak 증거 파일은 제외했다.

- [backend/.env.example](../../../backend/.env.example)
- [backend/docs/README.md](../../../backend/docs/README.md)
- [backend/docs/assets-api-contract.md](../../../backend/docs/assets-api-contract.md)
- [backend/docs/koscom-market-data.md](../../../backend/docs/koscom-market-data.md)
- [backend/docs/operator-api-contract.md](../../../backend/docs/operator-api-contract.md)
- [backend/docs/policy-decisions.md](../../../backend/docs/policy-decisions.md)
- [backend/docs/provider-ingestion-foundation.md](../../../backend/docs/provider-ingestion-foundation.md)
- [backend/package.json](../../../backend/package.json)
- [backend/scripts/candle-baseline-sync.ts](../../../backend/scripts/candle-baseline-sync.ts)
- [backend/scripts/candle-live-smoke-report.ts](../../../backend/scripts/candle-live-smoke-report.ts)
- [backend/scripts/candle-live-smoke.ts](../../../backend/scripts/candle-live-smoke.ts)
- [backend/scripts/lib/candle-baseline-calendar.spec.ts](../../../backend/scripts/lib/candle-baseline-calendar.spec.ts)
- [backend/src/app.service.spec.ts](../../../backend/src/app.service.spec.ts)
- [backend/src/app.service.ts](../../../backend/src/app.service.ts)
- [backend/src/assets/asset-candles-cache.service.spec.ts](../../../backend/src/assets/asset-candles-cache.service.spec.ts)
- [backend/src/assets/asset-candles-cache.service.ts](../../../backend/src/assets/asset-candles-cache.service.ts)
- [backend/src/assets/asset-candles.service.spec.ts](../../../backend/src/assets/asset-candles.service.spec.ts)
- [backend/src/assets/asset-candles.service.ts](../../../backend/src/assets/asset-candles.service.ts)
- [backend/src/assets/asset-list-turnover.ts](../../../backend/src/assets/asset-list-turnover.ts)
- [backend/src/assets/assets.module.ts](../../../backend/src/assets/assets.module.ts)
- [backend/src/assets/assets.service.spec.ts](../../../backend/src/assets/assets.service.spec.ts)
- [backend/src/assets/candle-database.loader.ts](../../../backend/src/assets/candle-database.loader.ts)
- [backend/src/assets/candle-response.builder.spec.ts](../../../backend/src/assets/candle-response.builder.spec.ts)
- [backend/src/assets/candle-response.builder.ts](../../../backend/src/assets/candle-response.builder.ts)
- [backend/src/assets/candle-serving.service.ts](../../../backend/src/assets/candle-serving.service.ts)
- [backend/src/assets/daily-change-rate.service.ts](../../../backend/src/assets/daily-change-rate.service.ts)
- [backend/src/assets/koscom-candle-reader.service.ts](../../../backend/src/assets/koscom-candle-reader.service.ts)
- [backend/src/assets/live-candle-event-normalizer.service.ts](../../../backend/src/assets/live-candle-event-normalizer.service.ts)
- [backend/src/assets/live-candle-finalizer.service.spec.ts](../../../backend/src/assets/live-candle-finalizer.service.spec.ts)
- [backend/src/assets/live-candle-finalizer.service.ts](../../../backend/src/assets/live-candle-finalizer.service.ts)
- [backend/src/assets/live-candle-health.service.ts](../../../backend/src/assets/live-candle-health.service.ts)
- [backend/src/assets/live-candle-overlay.service.spec.ts](../../../backend/src/assets/live-candle-overlay.service.spec.ts)
- [backend/src/assets/live-candle-overlay.service.ts](../../../backend/src/assets/live-candle-overlay.service.ts)
- [backend/src/assets/live-candle-pipeline.service.ts](../../../backend/src/assets/live-candle-pipeline.service.ts)
- [backend/src/assets/live-candle-store.service.ts](../../../backend/src/assets/live-candle-store.service.ts)
- [backend/src/assets/live-candle.config.spec.ts](../../../backend/src/assets/live-candle.config.spec.ts)
- [backend/src/assets/live-candle.config.ts](../../../backend/src/assets/live-candle.config.ts)
- [backend/src/assets/live-candle.types.ts](../../../backend/src/assets/live-candle.types.ts)
- [backend/src/assets/market-candle-aggregation.service.ts](../../../backend/src/assets/market-candle-aggregation.service.ts)
- [backend/src/assets/market-candle-ingestion.service.spec.ts](../../../backend/src/assets/market-candle-ingestion.service.spec.ts)
- [backend/src/assets/market-candle-ingestion.service.ts](../../../backend/src/assets/market-candle-ingestion.service.ts)
- [backend/src/assets/market-candle-sync.service.spec.ts](../../../backend/src/assets/market-candle-sync.service.spec.ts)
- [backend/src/assets/market-candle-sync.service.ts](../../../backend/src/assets/market-candle-sync.service.ts)
- [backend/src/assets/market-candles.integration.spec.ts](../../../backend/src/assets/market-candles.integration.spec.ts)
- [backend/src/assets/market-candles.repository.ts](../../../backend/src/assets/market-candles.repository.ts)
- [backend/src/home/home.service.spec.ts](../../../backend/src/home/home.service.spec.ts)
- [backend/src/operator/operator-provider-ingestion.service.spec.ts](../../../backend/src/operator/operator-provider-ingestion.service.spec.ts)
- [backend/src/operator/operator-provider-ingestion.service.ts](../../../backend/src/operator/operator-provider-ingestion.service.ts)
- [backend/src/ops/ops-job-runner.service.spec.ts](../../../backend/src/ops/ops-job-runner.service.spec.ts)
- [backend/src/ops/ops-job-runner.service.ts](../../../backend/src/ops/ops-job-runner.service.ts)
- [backend/src/ops/ops-scheduler.service.ts](../../../backend/src/ops/ops-scheduler.service.ts)
- [backend/src/orders/limit-order-matching-diagnostics.spec.ts](../../../backend/src/orders/limit-order-matching-diagnostics.spec.ts)
- [backend/src/orders/orders.service.spec.ts](../../../backend/src/orders/orders.service.spec.ts)
- [backend/src/portfolio/portfolio-valuation.service.spec.ts](../../../backend/src/portfolio/portfolio-valuation.service.spec.ts)
- [backend/src/providers/kis/candles/kis-domestic-five-minute.builder.ts](../../../backend/src/providers/kis/candles/kis-domestic-five-minute.builder.ts)
- [backend/src/providers/kis/kis-krx-session-close.ingestion.service.spec.ts](../../../backend/src/providers/kis/kis-krx-session-close.ingestion.service.spec.ts)
- [backend/src/providers/kis/kis-krx-session-close.ingestion.service.ts](../../../backend/src/providers/kis/kis-krx-session-close.ingestion.service.ts)
- [backend/src/providers/kis/kis-quote.client.ts](../../../backend/src/providers/kis/kis-quote.client.ts)
- [backend/src/providers/kis/kis-websocket-streaming.service.ts](../../../backend/src/providers/kis/kis-websocket-streaming.service.ts)
- [backend/src/providers/kis/kis-websocket.ingestion.service.spec.ts](../../../backend/src/providers/kis/kis-websocket.ingestion.service.spec.ts)
- [backend/src/providers/kis/kis-websocket.ingestion.service.ts](../../../backend/src/providers/kis/kis-websocket.ingestion.service.ts)
- [backend/src/providers/kis/kis.types.ts](../../../backend/src/providers/kis/kis.types.ts)
- [backend/src/providers/koscom/koscom-candle.adapter.spec.ts](../../../backend/src/providers/koscom/koscom-candle.adapter.spec.ts)
- [backend/src/providers/koscom/koscom-candle.adapter.ts](../../../backend/src/providers/koscom/koscom-candle.adapter.ts)
- [backend/src/providers/koscom/koscom-ingestion.service.spec.ts](../../../backend/src/providers/koscom/koscom-ingestion.service.spec.ts)
- [backend/src/providers/koscom/koscom-ingestion.service.ts](../../../backend/src/providers/koscom/koscom-ingestion.service.ts)
- [backend/src/providers/koscom/koscom-market-map.service.ts](../../../backend/src/providers/koscom/koscom-market-map.service.ts)
- [backend/src/providers/koscom/koscom-normalizer.spec.ts](../../../backend/src/providers/koscom/koscom-normalizer.spec.ts)
- [backend/src/providers/koscom/koscom-normalizer.ts](../../../backend/src/providers/koscom/koscom-normalizer.ts)
- [backend/src/providers/koscom/koscom.client.spec.ts](../../../backend/src/providers/koscom/koscom.client.spec.ts)
- [backend/src/providers/koscom/koscom.client.ts](../../../backend/src/providers/koscom/koscom.client.ts)
- [backend/src/providers/koscom/koscom.config.ts](../../../backend/src/providers/koscom/koscom.config.ts)
- [backend/src/providers/market-price-event.service.ts](../../../backend/src/providers/market-price-event.service.ts)
- [backend/src/providers/provider-config.service.spec.ts](../../../backend/src/providers/provider-config.service.spec.ts)
- [backend/src/providers/provider-config.service.ts](../../../backend/src/providers/provider-config.service.ts)
- [backend/src/providers/provider-secret-redaction.ts](../../../backend/src/providers/provider-secret-redaction.ts)
- [backend/src/providers/providers.module.ts](../../../backend/src/providers/providers.module.ts)
- [backend/src/providers/source-eligibility.policy.ts](../../../backend/src/providers/source-eligibility.policy.ts)
- [backend/src/realtime/asset-ticker.gateway.spec.ts](../../../backend/src/realtime/asset-ticker.gateway.spec.ts)
- [backend/src/realtime/live-candle-stream-supervisor.service.spec.ts](../../../backend/src/realtime/live-candle-stream-supervisor.service.spec.ts)
- [backend/src/realtime/live-candle-stream-supervisor.service.ts](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts)
- [docs/investigations/2026-10-10-koscom-migration/validation.md](validation.md)
- [frontend/src/features/asset/api.ts](../../../frontend/src/features/asset/api.ts)
