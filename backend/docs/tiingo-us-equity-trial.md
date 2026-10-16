# Tiingo 미국주식 데이터 — 1차 통합 (체험 모드, 2026-10-14, current)

KIS 미국주식 데이터 공급자를 Tiingo로 교체하기 위한 1차 통합이다. **정식 공급자
전환이 아니다.** 7일 체험 권한 기간의 개발·내부 평가 목적이며, 기본값은 비활성화다.

> 2026-10-17: 정식 모드(`TIINGO_TRIAL_MODE=false`, 저장·lease·25종목)와 금융 원천 전환
> (`US_STOCK_PRICE_PROVIDER=tiingo`)은 [tiingo-us-equity-official.md](tiingo-us-equity-official.md)를 따른다.
> 이 문서는 체험 모드(`TIINGO_TRIAL_MODE=true`)에만 적용된다.

- 범위: 허용 목록(기본 없음, 테스트는 `AAPL`)의 기존 미국주식 Asset 표시 시세·캔들·추정 호가.
- 체험 데이터는 **표시 전용·메모리 전용**이다. PostgreSQL 행, Redis key/Pub/Sub, 파일,
  로그 원문, 큐에 남기지 않는다 (Tiingo ToS §1.6(a) 저장 제한).
- 주문 견적·체결·평가·랭킹·정산·시즌 정책은 바뀌지 않는다. 이 경로들은 계속
  `kis_us_delayed_trade` 저장 스냅샷을 쓴다. Tiingo 가격은 금융 입력이 아니다.
- KIS 미국주식 코드는 삭제하지 않았다 (아래 "KIS 제거 시 주의사항").

## 1. 조사 결과 — 기존 KIS 미국주식 흐름

| 데이터 | 경로 | 저장/전달 |
| --- | --- | --- |
| REST 현재가 | `KisRestCurrentPriceIngestionService` (ops job `provider_kis_ingest`, mode `rest_current_price`, 미국 정규장만) | `asset_price_snapshots` (`kis_us_delayed_trade`), 이벤트 발행 없음 → gateway 3초 poll |
| WS 지연 체결 (HDFSCNT0) | `KisWebSocketStreamingService` (상시) / `KisWebSocketClient` (ops batch) | 메모리 cache + in-process `KisRealtimePriceEventBus` → `MarketPriceEventService`(delayed) + 5초 throttle DB snapshot |
| Live 5m | `LiveCandleStreamSupervisorService` KIS 소켓 (`CANDLE_LIVE_KIS_US_DELAYED_ENABLED`) | Redis `candles:live:v1:provider-price-fanout` + live candle store. 이 모드에서는 KIS snapshot을 쓰지 않음 |
| 5m/1d/1w 캔들 | `MarketCandleSyncService` (`kis_overseas_minute`, `kis_overseas_period` MODP=1 수정주가) | `market_candles` (5m 45일, 1d/1w) |
| 4h | 15m–4h는 5m 읽기 시점 집계. 미국 장기 4h 저장 없음, `range=96d`는 400 | — |
| 호가 | `KisRestHogaIngestionService` (operator `rest_hoga`만) | `asset_orderbook_snapshots`에 쓰지만 **읽는 코드 없음** |

- 가격 선택: `resolveAssetProviderEligibility`가 미국주식의 **모든 workflow**(표시·주문·평가·정산)를
  `kis_us_delayed_trade` 한 소스로 제한한다. 장중에는 현재 세션 + freshness(표시 300s, quote 60s,
  execute 10s), 장마감 후에는 직전 완료 세션 가격만 carry-forward.
- 앱 실시간: `/api/v1/ws`의 `asset_ticker`(gateway가 세션 open + eligibility로 gate), `asset_candle`,
  `asset_order_book`(Binance 고정 universe만, 10단계), `fx_rate`.
- 진단: 공개 `GET /readiness`(KIS/Binance streaming 상태 등, 하드코딩 조합)와 요청 단위 관리자
  진단(`buildAdminPartialFailureDiagnostic`, `setAdminDiagnosticContext`, 앱 `AdminDiagnosticPanel`).
- 미국주식 일간 등락률은 저장 1d 기준선이 국내/암호화폐만 있어 원래 `null`이다.

**가설과 실제의 차이**
- KIS REST 현재가는 이벤트를 발행하지 않는다(DB poll로만 앱 반영).
- Live candle 모드에서는 KIS 미국 snapshot이 쓰이지 않아, 주문 가능 여부가 별도 ops job에 의존한다.
- 미국 호가는 수집 코드가 있으나 화면·주문 어디서도 읽지 않는다.
- REST 현재가/호가 parser는 XYMD/XHMS fallback을 KST로, WS parser는 뉴욕 시각으로 해석한다(기존 차이, 미수정).
- 기본 target 병합에서 `NAS:AAPL`과 `AAPL`이 별개 문자열로 합쳐져 25종목이 50개로 세어질 위험(기존, 미수정).

### KIS 전용 코드와 공용 코드 (제거 시 주의)

| 구분 | 대상 |
| --- | --- |
| 미국주식 전용 KIS | REST 현재가/호가 ingestion·parser, HDFSCNT0 subscription·parser·streaming·client, `KisUsMinuteAdapter`, `KisOverseasPeriodAdapter`, `KIS_FIXED_US_SYMBOLS`/watchlist, ops `provider_kis_ingest`, live-candle KIS 루프, candle-response의 미국 PATH/TR_ID |
| 국내 레거시이지만 **아직 참조됨** | `KIS_DOMESTIC_PERIOD_SOURCE`(일간 등락률 기준선), `KisCandleNormalizerService`·`KisDomesticFiveMinuteBuilder`·`KisPeriodCandleNormalizerService`(KOSCOM 데이터 정규화에 재사용), `KIS_FIXED_DOMESTIC_SYMBOLS` |
| 공용 (삭제 금지) | `providers/kis/candles/kis-candle-time.ts`(시장 달력·집계·정규화 전반), `normalizeKisUsMarketCode`(gateway/candle 응답), KIS rate limiter·auth(아직 다른 KIS 경로 사용) |

제거는 (1) 정식 계약 후 Tiingo 저장 경로와 금융 eligibility 전환이 검증되고, (2) 국내
레거시 참조가 KOSCOM 쪽으로 옮겨진 뒤에만 진행한다. 파일명에 `kis`가 있다는 이유로 지우지 않는다.

## 2. Tiingo 프로토콜 — 공식 문서 확인 사항 (2026-10-14)

근거: tiingo.com 문서(Equity Realtime REST/WebSocket, IEX WebSocket "Connecting", End-of-Day)와
Changelog(2026-07-07, 2026-07-21, 2026-10-09). 문서 표기는 **Beta**다.

- 인증: REST `Authorization: Token <token>` 헤더(쿼리 `token=` 대신 헤더만 사용). WS는 subscribe 메시지의 `authorization`.
- REST
  - `GET /tiingo/equity/intraday/<ticker>` — `ticker, timestamp(ns, offset), tngoLast, lqRefPrice, prevClose(adjClose 기준), prevDate, open, high, low, volume, lqSpread, lqBidPrice, lqBidSize, lqAskPrice, lqAskSize`. 필드는 null일 수 있다.
  - `GET /tiingo/equity/intraday/<ticker>/prices?startDate&endDate&resampleFreq=5min&columns=open,high,low,close,volume&afterHours=false&forceFill=false` — `date`는 UTC ISO 봉 시작. volume은 `columns`로 요청해야 온다. `afterHours=true`는 장전·장후 포함, `forceFill=true`는 직전 OHLC 복사(사용 안 함).
  - `GET /tiingo/daily/<ticker>/prices?startDate&endDate` — 원주가 OHLCV와 `adjOpen..adjVolume, divCash, splitFactor`.
  - `GET /tiingo/daily/<ticker>` — `ticker, name, exchangeCode, startDate, endDate` (식별 확인만).
- WebSocket `wss://api.tiingo.com/equity/intraday`
  - 구독: `{"eventName":"subscribe","authorization":"…","eventData":{"thresholdLevel":6|4,"tickers":["aapl"]}}`.
  - 응답: `I`(`data.subscriptionId`), `H`(HeartBeat, 2026-10-16 실측 120초 간격), `A`(data, `service:"cons"`), `E`(오류).
  - thresholdLevel 6: `[timestamp, ticker, referencePrice]`. thresholdLevel 4: `[timestamp, ticker, lqSpread, lqBidSize, lqBidPrice, referencePrice, lqAskPrice, lqAskSize]`.
  - 구독 수정/해제는 `subscriptionId`를 넣은 subscribe/unsubscribe(IEX 문서). 문서 예시는 연결당 하나의
    thresholdLevel만 보여 주므로 **level 6/4를 별도 연결 2개**로 운용한다.
- 운영 시간: Equity Realtime은 **04:00–20:00 ET**. 20:00–03:59 ET는 별도 상품 **BOATS Overnight**
  (`/boats`, `wss://api.tiingo.com/boats`, 추가 entitlement)이다. 영업 안내의 "24×5"와 공개 문서가 다르다 → 제공사 확인 필요.

## 3. 구현 구조

```
providers/tiingo/
  tiingo.config.ts           설정·검증(기본 비활성, 허용 ≤5종목, trial 강제, 운영 환경 차단, Tiingo 호스트만)
  tiingo.errors.ts           고정 오류 코드 (401/403/404/429/5xx/timeout/abort/budget/size/JSON/symbol mismatch…)
  tiingo.parser.ts           REST·WS 검증/정규화 (ns timestamp, null 유지, 교차 호가 거부, 다른 종목 거부)
  tiingo-rest.client.ts      timeout·제한 재시도(Retry-After)·in-flight 공유·호출자 취소·전역/종목별 예산·응답 크기 제한
  tiingo-stream.service.ts   level 6/4 연결, ACK timeout, heartbeat watchdog, 지수 backoff+jitter, auth 실패 대기, 해제 시 unsubscribe
  tiingo-market-data.store.ts 메모리 최신값(중복·역행 거부), 세션 구간별 카운터, 종료 시 삭제
  tiingo-asset-map.service.ts  NAS:AAPL ↔ aapl (기존 Asset ID 유지, 중복 매핑 거부)
  tiingo-quote.service.ts    표시 가격·추정 호가, in-process 이벤트 발행
  tiingo-candle.service.ts   세션 단위 5m/EOD 조회·메모리 TTL 캐시·coverage
  tiingo-diagnostics.service.ts /readiness 상태(코드·카운터·시각만)
providers/market-display-price.service.ts   표시 전용 라우팅 facade (gateway/assets는 Tiingo를 직접 알지 않음)
providers/market-estimated-quote.service.ts 추정 호가 facade + 앱 계약
assets/tiingo-candle-reader.service.ts      캔들 응답 (기존 read plan·집계·응답 형식 재사용)
```

### 3.1 표시 가격
- 장중: 최신 참조가격(WS 우선). 없거나 오래되면(스트림 비정상 30s / 표시 freshness 300s) REST
  snapshot 1회(종목당 10초 간격, 예산 적용). 선택은 기존 `selectMarketAwareAssetPriceSnapshotBySourcePriority`
  (현재 세션 + freshness)를 그대로 쓴다.
- 장마감: 직전 완료 세션 종가 = EOD 공식 종가(원주가 close, 발행 약 17:30 ET) → 없으면 이 프로세스가
  받은 정규장 마지막 값 → 없으면 정규장 마지막 5m 봉 종가(효력 시각은 세션 종료로 상한).
- **KIS·admin_manual fallback 없음.** 실패하면 `ASSET_PRICE_UNAVAILABLE` + 관리자 진단
  (`failureStage: tiingo_reference_price|tiingo_session_close`, `fallback: none`).
- `assetPriceSnapshotId`는 `null`(저장 행 없음), `priceSource.sourceName = tiingo_equity_reference_price`.
- 실시간: WS 틱 → `MarketPriceEventService.publish`(in-process, Redis 미사용). gateway는 관리 대상
  종목에 Tiingo 소스만 허용하고 KIS 틱을 거부한다(반대도 동일). 정규장 gate는 기존 그대로.
- 정렬 목록 snapshot에 Tiingo 가격이 있으면 Redis에 저장하지 않는다(해당 인스턴스 메모리만).
- 일간 등락률은 기존 미국주식 정책대로 `null`(Tiingo `prevClose`는 수정주가 기준이라 별도 결정 필요).

### 3.2 캔들
- 5m 봉(`afterHours=false`, `forceFill=false`)만 원천으로 받고 15m/30m/1h/4h는 기존
  `MarketCandleAggregationService`로 세션 기준 집계: 미국 4h = 09:30–13:30, 13:30–16:00,
  조기 종료일은 13:00 상한. 누락 봉은 보간하지 않고, 구성 봉이 빠진 과거 bucket은 버린다.
- 세션 목록은 공용 미국 달력(휴장·조기 종료·DST). 최근 세션부터 연속 구간별 ≤16세션 요청.
  중간에 실패하면 이미 받은 최근 구간을 반환하고 나머지는 `partial`로 표시한다.
- 메모리 TTL: 완료 세션 20분, 진행 세션 30초, EOD 15분. 종료 시 삭제.
- 1d/1w: EOD **수정주가**(기존 KIS MODP=1 정책과 같은 기준). 오늘 EOD 전에는 정규장 5m로
  만든 잠정 일봉. 주봉은 월요일 00:00 ET 기준. 범위는 저장 경로·집계와 같은 `봉 시작 ∈ [from, to)`:
  `from`보다 먼저 시작한 일/주 bucket은 넣지 않고 `requestedSessions`도 같은 기준으로 센다.
- 응답 `source`(추가 variant): `provider:'tiingo', dataset, marketCode, persisted:false,
  priceAdjustment, coverage('complete'|'partial'|'empty'), requestedSessions, coveredSessions,
  currentCandleTime`. Redis 응답 캐시·DB loader·live overlay를 거치지 않는다.
- 공급자 실패로 반환할 봉이 하나도 없으면 503 `ASSET_CANDLES_PROVIDER_UNAVAILABLE`(KIS로 대체하지 않음).
- 앱 차트는 클라이언트별 REST polling을 하지 않는다(기존 정책). Tiingo에는 live candle 스트림이
  없으므로 진행 중 봉은 조회 시점 값이며 화면에 그렇게 표시한다. 현재가 선은 ticker로 갱신되고,
  당겨서 새로고침·주기 변경 시 다시 읽는다.

### 3.3 미국주식 `range=96d`
- 모든 미국주식에서 허용: 96번째 이전 실제 미국 세션 개장 → 지금(국내와 같은 세션 기준).
- Tiingo 대상: 실제 5m를 96세션 전체에 대해 집계(DB가 비어도 표시). 받은 만큼만 보여 준다.
- KIS 대상: 기존 저장 경로(장기 4h 저장 없음 → 저장된 5m 집계 ≈ 30일, `database_partial`).

### 3.4 추정 호가 (`asset_estimated_quote`, 별도 채널)

```json
{ "type": "subscribe", "channel": "asset_estimated_quote", "assetId": "<id>" }
```
- ACK `{type:'subscribed', channel:'asset_estimated_quote', assetId}` 후 현재 추정치(있으면).
- 데이터: `{type:'asset_estimated_quote', assetId, kind:'estimated_liquidity', provider:'tiingo',
  priceCurrency:'USD', quantityUnit:'share', bid:{price,size}, ask:{price,size}, spread, referencePrice,
  effectiveAt, capturedAt}` — 한 단계, 수량은 주, 각 값은 null 가능(합성 금지).
- 실패: `{type:'subscription_error', channel:'asset_estimated_quote', assetId, code}` —
  `UNSUPPORTED_ASSET` / `INVALID_SUBSCRIPTION` / `SUBSCRIPTION_LIMIT`(20) / `ESTIMATED_QUOTE_UNAVAILABLE`.
- 정규장 안의 60초 이내 추정치만 전달. 느린 소켓은 종목별 최신 1개만 대기, 해제·종료 시 정리.
- `asset_order_book`(Binance 10호가)와 `supportsLiveOrderBook()`은 바꾸지 않았다.
- 주문 체결·슬리피지·부분 체결·ERS 근거로 쓰지 않는다. 주문 화면에 "통계 추정, 주문 체결에 사용되지
  않음"을 표시한다.

### 3.5 진단
- `GET /readiness` → `data.tiingo` (정보용, readiness status/reasons에 영향 없음): 설정 오류 코드,
  매핑, REST(요청 수·코드별 실패·마지막 HTTP 상태·auth 상태·429 cooldown·예산), WS 채널별 상태
  (connected/subscribed/heartbeat/data 시각·재연결·close code·parse 오류·타 종목·중복·역행),
  종목별 마지막 참조가격/추정 호가 시각·경과·세션 구간별 수신 수·`referenceDataState`
  (`flowing|quiet|expected_quiet|unavailable`), 표시 실패 코드, 캔들 coverage, `lastFailure` 단계.
- 가격·수량·원문·URL·토큰은 넣지 않는다(공개 endpoint). heartbeat만 오는 상태는 `quiet`이다.
- 요청 단위 관리자 진단: 가격 불가와 캔들 실패에 Tiingo 단계·코드·coverage evidence.

## 4. 저장 정책 검증
- `tiingo-trial-storage.spec.ts`: 스트림 틱, REST fallback, 자산 상세·정렬 목록, 96세션 4h·5m
  캔들까지 실행하며 Prisma write 계열(create/update/upsert/delete/`$executeRaw`…)과 Redis
  write(set/eval/setWithTtl/publish…)를 기록 → 0건. 종료 시 메모리 삭제 확인.
- 로그: 상태 코드 전환만 기록(`Tiingo reference stream status changed to <CODE>`).
- 실제 `AppModule` 런타임 점검(2026-10-14, 1회성·저장소 미포함): 로컬 전용 PG16(`*_test`)·Redis에
  합성 Tiingo transport(`TIINGO_REST_RUNTIME`·`TIINGO_SOCKET_FACTORY` 주입, 네트워크 차단)로
  정규장(10:30 ET)·장마감 후(18:30 ET)·비활성 3가지를 실행. `CANDLE_CACHE_ENABLED=true`에서도
  Tiingo 활성 시 DB write 0(`pg_stat_user_tables` 전후 동일), `pg_dump` 데이터·Redis 전체 key·로그에
  합성 가격/토큰 0건, Redis key 0개. 앱 차트 7개 탭 첫 조회에 REST 9–10회(5m 8회 + EOD 1–2회).
  같은 순간 화면은 Tiingo 값을 보여도 주문 견적은 저장된 KIS 스냅샷(합성 행)으로 가격을 정했다
  (`assetPriceSource = kis_us_delayed_trade`, Tiingo 값 미사용). 비활성 시 Tiingo REST·소켓 0회,
  저장된 KIS 가격·KIS 틱이 그대로 표시된다(`market_candle_sync_states` write는 기존 KIS 경로).

## 5. 설정

`.env.example`의 `TIINGO_*` 참고. 활성화 예(로컬):

```bash
TIINGO_ENABLED=true TIINGO_API_TOKEN=<backend only> TIINGO_ALLOWED_SYMBOLS=AAPL
```
- `TIINGO_TRIAL_MODE=false`는 2026-10-17부터 정식 모드다(이전의 `TIINGO_LICENSED_MODE_UNAVAILABLE` 거부는 없어졌다,
  [정식 문서](tiingo-us-equity-official.md)).
- `NODE_ENV=production` 또는 Render에서는 `TIINGO_ALLOW_PRODUCTION_TRIAL=true` 없이는 거부
  (`TIINGO_TRIAL_PRODUCTION_BLOCKED`) — 체험 데이터의 일반 사용자 재배포 방지.
- 다중 인스턴스: 인스턴스마다 Tiingo 소켓 2개를 연다(lease 없음). 체험은 단일 인스턴스 전제.

## 6. 실제 API 확인 (opt-in)

```bash
cd backend && TIINGO_LIVE_SMOKE=1 TIINGO_API_TOKEN=… pnpm smoke:tiingo-trial
```
REST ≤ 7회 + WS 2회(기본 30초). 가격·수량 없이 필드 유무, 봉 수, 세션 구간별 수신 수,
갱신 빈도, 30·96세션 전 커버리지만 출력한다. 데이터를 못 받으면 PASS가 아니다.

## 7. 정식 계약 후 (후속)
1. 저장: Tiingo 5m → `market_candles '5m'`, 완료 4h → `'4h'`(기존 보관 45일/180일, sync/backfill
   lock·coverage 재사용), 현재가 → `asset_price_snapshots`(새 source 이름). 이번 parser/정규화 재사용.
2. 금융 전환: eligibility의 미국주식 source를 Tiingo로 바꾸는 별도 결정(quote/execute freshness,
   `tngoLast`가 mid일 수 있음, 원주가/수정주가, 등락률 기준).
3. 확장: 25종목 → 전체. 앱 수요 기반 구독, 다중 인스턴스 owner lease.
4. KIS 미국주식 경로 제거(1절 표 기준).

## 8. 제공사 확인 필요
- 체험 계정의 실제 entitlement(Equity Realtime, BOATS overnight 포함 여부)와 호출 한도.
- "24×5" 안내 vs 04:00–20:00 ET 문서 차이.
- intraday 5m 과거 보관 기간(96세션 이상 가능 여부), 요청당 최대 행 수.
- 한 연결에 thresholdLevel 4·6을 함께 구독할 수 있는지, `E` 메시지 형식, 인증 실패 시 동작.
- 저장·재배포 범위(정식 Redistribution 조건).
