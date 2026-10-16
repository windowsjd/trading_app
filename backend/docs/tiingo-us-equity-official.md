# Tiingo 미국주식 정식 공급자 (2026-10-17)

정책 근거: [policy-decisions.md](policy-decisions.md) "Tiingo 미국주식 정식 공급자·미국 LOC". 체험 모드는
[tiingo-us-equity-trial.md](tiingo-us-equity-trial.md). 미국 LOC 계약은
[conditional-buy-and-loc-contract.md](conditional-buy-and-loc-contract.md) §미국 LOC.

## 1. 범위와 현재 상태

- 대상: 고정 미국 25종목(`kis-fixed-asset-universe.ts`, NAS 20 · NYS 5). Asset ID·주문·보유·가격 이력은 그대로다.
  ETF·지수·100종목 확대는 후속이다.
- 코드 기본값은 모두 꺼져 있다(`TIINGO_ENABLED=false`, `TIINGO_TRIAL_MODE=true`, `US_STOCK_PRICE_PROVIDER=kis`,
  `LOC_US_*=false`). 이 상태로 배포하면 동작이 바뀌지 않는다.
- 운영 활성화(정식 모드, 금융 원천 전환, LOC 플래그, 운영 DB 백필)는 **별도 승인 후** §5 순서로만 한다.

## 2. 구성

### 2.1 실시간 수집 (정식 모드 `TIINGO_TRIAL_MODE=false`)

| 단계 | 구성 요소 | 내용 |
|---|---|---|
| 소유권 | `TiingoCollectorLeaseService` | Redis `tiingo:collector:v1:owner`(TTL 30초, 10초 갱신). lease를 가진 서버 한 곳만 WebSocket을 연다. lease·Redis를 잃으면 즉시 소켓을 닫는다(중복 수집 없음). |
| 수신 | `TiingoStreamService` | `wss://api.tiingo.com/equity/intraday`, thresholdLevel 6(참조가격 `tngoLast`). heartbeat 120초 간격, 300초 무응답이면 재연결. heartbeat는 연결 생존일 뿐 가격 신선도가 아니다. |
| 저장 | `TiingoSnapshotWriterService` | 정규장 tick만, 종목당 `TIINGO_SNAPSHOT_THROTTLE_MS`(기본 5초)마다 1행 + 창 끝의 마지막 tick. `asset_price_snapshots(provider_api, tiingo_us_reference_price)`. `effectiveAt`=Tiingo 시각(앞당기지 않음), `capturedAt`=수신 시각. 같거나 오래된 값은 저장하지 않는다(재시작 후 DB 확인 포함). |
| 전파 | Redis `PROVIDER_PRICE_PUBSUB_CHANNEL` | 저장 성공 후 `market_price` 이벤트. Redis 실패 시에만 프로세스 내 버스. |
| 보충 | writer `topUp()` 30초 | 소켓이 60초 넘게 조용할 때만 REST 스냅샷으로 오래된 종목을 보충한다. |

- 저장 이름 `tiingo_us_reference_price`는 체험 모드의 메모리 전용 표시값 `tiingo_equity_reference_price`와 다르다.
  앱의 체험 표시(`isTrialPriceSource`)와 자격 판정이 둘을 섞지 않는다.
- 진단: `GET /readiness` → `data.tiingo`(`persistence: official`, `collector`, `snapshots`, `stream`, REST 예산).

### 2.2 금융 원천 전환 `US_STOCK_PRICE_PROVIDER`

- `kis`(기본): 기존 `kis_us_delayed_trade` 경로 그대로.
- `tiingo`: 미국주식의 표시·견적·체결·평가·랭킹·정산·조건 감시가 `tiingo_us_reference_price` 저장 스냅샷만 쓴다.
  없거나 오래되면 기존 unavailable/stale로 실패하고, KIS·`admin_manual`로 대체하지 않는다
  (`adminManualAssetPriceScope`). 신선도(표시 300·견적 60·체결 10초), Quote TTL, 가격 변동 허용폭은 그대로다.
- 시작 검증: `tiingo`이면 Tiingo 정식 모드가 켜져 있어야 하고, `LOC_US_*=true`이면 `tiingo`여야 한다.

### 2.3 캔들 (`tiingo`일 때)

| 주기 | 원천 | 저장 `sourceProvider` |
|---|---|---|
| 5m | Tiingo equity intraday `resampleFreq=5min`, `afterHours=false`, `forceFill=false`. 정규장 안 + 창 종료 후 2분 지난 봉만 | `tiingo_equity_intraday` |
| 15m/30m/1h | 저장 5m 읽기 시점 세션 집계(누락 bucket 제외) | — |
| 4h | 빠짐없는 저장 5m에서 합성: 09:30–13:30 / 13:30–16:00 NY, 조기 폐장일은 09:30–13:00 한 개 | `tiingo_equity_intraday_4h` |
| 1d | Tiingo EOD **원시** OHLCV(조정가 미사용), 일봉 창 = NY 자정 → 다음 자정 | `tiingo_eod` |
| 1w | Tiingo EOD 원시 일봉을 받아 주 단위로 합성, 모든 세션 일봉이 있는 끝난 주만(구버전 앱용) | `tiingo_eod` |

- 수집: `MarketCandleSyncService`의 `tiingo_us` feed(같은 체크포인트·잠금·coverage). 5m는 오래된 쪽부터 요청당 최대 10세션이다.
  끝난 세션에 봉이 하나도 없으면 coverage를 주장하지 않는다(다음 실행이 다시 받음).
- 제공: DB 전용(KRX 중앙 수집과 같은 계약). 요청이 공급자를 부르지 않고, KIS legacy·on-demand sync로 대체하지 않는다.
  저장 행과 coverage 증거는 현재 공급자 것만 쓴다. Tiingo 모드는 `tiingo_*`만 읽고, KIS로 되돌리면 `tiingo_*`를 읽지 않는다.
- 응답 `source`: `{ provider:'tiingo', persisted:true, priceAdjustment:'raw', sourceProviders, marketCode, … }`
  (체험 `persisted:false`와 구분).
- 범위: 국내와 같다. 직전 3/6/12/24/96/576 세션 + 당일이고, 미국 달력은 2024년 데이터를 추가했다(NYSE 공식 휴장표).
  576세션 일봉도 저장 경로로 제공한다.
- 진행 중 일봉: 그날 저장된 Tiingo 5m의 앞부분(개장부터 가장 최근 저장 봉까지 빠진 슬롯이 없을 때)으로 만든다(EOD 도착 전, 약 17:30 ET).
  5m는 10분 주기 sync로 들어오므로 최근 봉은 시계보다 늦다. 중간 슬롯이 하나라도 없으면 보이지 않는다(보간 없음).
- 진행 중 5분봉: **없다.** 참조가격 틱에는 거래량이 없어 기존 live candle 경로(거래량 필수)에 넣지 않는다.
  차트는 마지막 정산 봉까지 보이고, 현재가는 ticker로 갱신된다. KIS 지연 체결 live candle은 이 모드에서 비활성이다.
- 지정가 Path B(5m 터치)는 현재 공급자의 저장 5m만 쓴다. 전환 전후 남은 다른 공급자 행은 `provider_mismatch`로 제외한다.
- 저장 구조: `market_candles`는 (종목, 주기, 시작 시각)당 한 행이고, 나중에 쓴 공급자가 `source_provider`를 덮는다.
  sync의 증분 시작점·이어받기(checkpoint)는 현재 공급자의 행·체크포인트만 본다(다른 공급자 것은 이어받지 않고 SUPERSEDED).

### 2.4 일간 등락률

현재 원시 가격 ÷ 직전 정규장 `tiingo_eod` 원시 종가 − 1. KIS 모드의 미국주식은 기존대로 `null`이다(KIS 일봉은 수정주가).

### 2.5 미국 LOC

계약은 [conditional-buy-and-loc-contract.md](conditional-buy-and-loc-contract.md) §미국 LOC를 따른다. 요약:

- 등록: 정규장 중, `LOC_US_ORDERS_ENABLED` / `LOC_US_SELL_ORDERS_ENABLED`(국내 플래그와 독립), USD 예약.
- 증거: 해당 NY 거래일 Tiingo EOD 원시 `close` 1행이다. 메타데이터 ticker·거래소(NAS↔NASDAQ, NYS↔NYSE)가 일치해야 하고,
  거래량이 0보다 커야 하며, 수신 시각이 장 마감 뒤여야 한다.
- 시점: 21:10 ET 이후 첫 관측, 300초 이상 뒤 같은 값이면 final, 값이 바뀌면 재확인, 23:00 ET까지 final이 없으면 만료·해제.
  종목·거래일당 한 번 관측해 모든 주문이 공유한다.
- 체결 직전 USD/KRW(60초)를 준비하고(`UsdKrwRefreshService`), 실패하면 다음 cycle에 재시도하며 기한이 지나면 해제한다.
- final 후 6–72시간 사이에 1회 재조회하고, 값이 다르면 `LOC_US_CLOSE_CORRECTED_AFTER_FINAL`와 run 요약에만 남긴다. 증거·체결·원장은 바꾸지 않는다.
  재조회는 정산 cycle 안에서 cycle당 최대 25건·10초까지만 한다(국내 LOC 시간대와 겹쳐도 정산을 늦추지 않음).
- 시점 하한 21:10은 코드 하한이다(`LOC_US_CLOSE_EVIDENCE_EARLIEST_ET` 21:10–22:50). 앞당기려면 실데이터 근거와 승인이 필요하다.

### 2.6 조건주문·손절가/익절가

`US_STOCK_PRICE_PROVIDER=tiingo`이면 capability `markets`에 `US`가 들어가 국내와 같은 규칙으로 열린다
(전역 플래그 `CONDITIONAL_BUY_ORDERS_ENABLED`, `CONDITIONAL_SELL_ORDERS_ENABLED`, `INDEPENDENT_TP_SL_ORDERS_ENABLED`를 따른다).

### 2.7 기업행위

분할·배당으로 보유수량·평균단가·원장을 자동 조정하지 않는다. 일봉 sync가 EOD `splitFactor≠1`을 보면
`TIINGO_US_SPLIT_OBSERVED`(symbol, date, splitFactor)를 남긴다. 처리 방안은 별도 승인 사항이다.

## 3. 설정값

| 변수 | 기본 | 의미 |
|---|---|---|
| `TIINGO_ENABLED` | false | Tiingo 사용 |
| `TIINGO_TRIAL_MODE` | true | false = 정식 모드(저장·lease·25종목) |
| `TIINGO_ALLOWED_SYMBOLS` | (빈 값) | 정식: 비우면 고정 25, 최대 100 |
| `TIINGO_SNAPSHOT_THROTTLE_MS` | 5000 | 종목별 저장 간격(1000–60000) |
| `TIINGO_REST_REQUESTS_PER_MINUTE` / `_PER_HOUR` | 정식 120 / 3000 | 자체 제한(계약 30,000/시간) |
| `TIINGO_WS_HEARTBEAT_TIMEOUT_MS` | 300000 | 120초 heartbeat의 2.5배 |
| `US_STOCK_PRICE_PROVIDER` | kis | `tiingo` = 미국 금융 원천 전환 |
| `LOC_US_ORDERS_ENABLED` / `LOC_US_SELL_ORDERS_ENABLED` | false | 미국 LOC 등록 |
| `LOC_US_CLOSE_EVIDENCE_EARLIEST_ET` | 21:10 | 21:10–22:50(정책 하한, 앞당기려면 실데이터 근거·승인) |
| `LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS` | 300 | 300–3600 |
| `LOC_US_CLOSE_EVIDENCE_DEADLINE_ET` | 23:00 | 21:10–23:59, 두 번 확인 시간 이상 |
| `SCHEDULER_MARKET_CANDLE_LONG_SYNC_MARKETS` | spot,krx | `us` 추가 시 미국 4h 합성 |

앱 공지(주문방식 안내)의 21:10·5분·23:00 문구는 기본값이다. 값을 바꾸면 공지도 함께 고친다.

## 4. 호출량·DB 부하 추정 (25종목)

- WebSocket 1개(정식 모드 lease 소유 서버). 2026-10-16 체험 AAPL 실측: 초당 약 1.6 tick, 최신 tick 나이 p99 5.7초,
  heartbeat 120.0초.
- 가격 스냅샷: 정규장 6.5시간 × 5초 간격이면 종목당 최대 4,680행/일, 25종목 최대 약 11.7만 행/일이다.
  기존 가격 보관(14일) 정리 대상이다. Binance Spot 100종목 저장량보다 한 자릿수 작다.
- 캔들 행: 5m 1,950행/일, 4h 약 50행/일, 1d 25행/일.
- REST:
  - 캔들 sync(10분마다 5m·1d·1w × 25 = 75회) 최대 약 1.1만 회/일;
  - 소켓이 끊긴 동안의 보충은 정규장에만, 종목당 최대 분당 1회(최대 약 1,500회/시간). 장외에는 하지 않는다(소켓이 원래
    조용하고 결과도 저장하지 않으므로, 밤의 LOC 종가 조회 예산을 지킨다);
  - LOC는 종목·거래일당 21:10–23:00 사이 최대 22회, 재조회는 final 1건당 1회;
  - 계약(일 400,000·시간 30,000) 대비 작다.
- 백필: 5m 45일 25종목은 약 125회, 1d·1w 50회다. 자체 분당 제한 120을 넘으면 `TIINGO_BUDGET_EXHAUSTED`로 그 feed가
  멈추고 재실행하면 체크포인트부터 이어간다(필요하면 백필 프로세스에만 제한을 올린다).

## 5. 운영 활성화 런북 (승인 후에만)

각 단계는 별도 승인 대상이다. 운영 DB·환경변수를 이 문서만 보고 바꾸지 않는다.

1. **사전 확인**
   - Render 비밀 환경변수에 토큰을 넣는다(저장소·로그 금지).
   - 운영 밖 호스트에서 `TIINGO_LIVE_SMOKE=1 TIINGO_API_TOKEN=… pnpm smoke:tiingo-official`를 실행한다.
     `identity`·`eodLatestSession`·`intraday5mLatestSession`·`stream`이 PASS여야 한다(가격·토큰은 출력되지 않음).
   - 25종목 등록 상태는 `DATABASE_URL=<대상> pnpm dev:seed-kis-universe --dry-run --us-only`로 계획만 출력해 확인한다.
     기대 결과는 `unchanged=25`이다. create/update가 나오면 적용 여부를 따로 승인받는다.
   - Render에 체험 단계 값이 남았는지 본다. `TIINGO_REST_REQUESTS_PER_MINUTE`/`_PER_HOUR`(체험 30/600)가 명시돼 있으면
     3단계에서 지운다(정식 기본 120/3000). 남기면 캔들 sync와 밤의 LOC 종가 조회가 예산 소진(`TIINGO_BUDGET_EXHAUSTED`)으로 멈춘다.
2. **코드 배포**(환경변수 변경 없음): 동작 불변을 확인한다. **앱 업데이트는 이 백엔드가 배포된 뒤에** 낸다.
   새 앱은 미국 차트를 세션 창(576세션 일봉 포함)으로 요청하는데, 이전 백엔드에는 미국 2024 달력이 없어 503이 된다.
   KIS 모드에서도 새 창을 쓴다. 저장된 범위만큼 `database_partial`로 보이므로 미국 일봉이 이전(1년)보다 짧아 보일 수 있다.
   전환이 늦어지면 KIS로 1d를 미리 채운다: CLI에 `US_STOCK_PRICE_PROVIDER=kis`를 주고
   `candle-baseline-sync.ts --apply --asset-type us_stock --mode repair --days 875 --target 1d`.
3. **정식 수집**: `TIINGO_ENABLED=true`, `TIINGO_TRIAL_MODE=false`, `TIINGO_ALLOWED_SYMBOLS=`(빈 값 = 고정 25),
   `TIINGO_ALLOW_PRODUCTION_TRIAL` 제거, 체험 예산 값 제거, `US_STOCK_PRICE_PROVIDER=kis` 유지.
   - `/readiness` `data.tiingo`: collector owner 1곳, 정규장 스냅샷 쓰기, symbols 25, heartbeat 간격.
   - 아직 금융 원천이 아니고, **캔들은 받지 않는다**(4단계 전에 Tiingo 캔들을 쓰면 KIS 모드 차트가 비게 된다, 아래).
   - 두 원천이 같은 미국 종목에 함께 쓰는 동안(3–4단계, 또는 KIS 구독을 끄기 전) `TIINGO_SNAPSHOT_THROTTLE_MS`와
     `KIS_WS_SNAPSHOT_THROTTLE_MS`를 기본 5000ms로 둔다. 2000ms 미만으로 내리지 않는다(코드 하한은 1000ms).
     - 주문 견적·실행 가격 조회는 원천 이름으로 거른다. 표시·평가용 공용 조회(`findMarketAwareAssetPriceCandidates`)는
       최신 10행에 자격 원천이 없으면 원천별 최근 15분 1행을 따로 읽는다. 둘 다 다른 원천에 밀리지 않는다.
     - 정기 지정가 매칭(Path A)은 최신 10행만 본다. 실행 신선도 10초 안에 다른 원천이 10행 이상 쓰면 밀린다.
       2000ms 이상이면 10초에 최대 5행이라 생기지 않는다. KIS 미국 체결 시각은 0분 지연이라(`provider-ingestion-foundation.md`)
       두 원천 행이 시각순으로 섞인다.
4. **금융 원천 전환 + 캔들 백필**: 한 점검 창에서, **미국 정규장 밖**(예: 뉴욕 16:30–20:00 또는 주말)에 한다.
   1. `US_STOCK_PRICE_PROVIDER=tiingo`, `SCHEDULER_MARKET_CANDLE_LONG_SYNC_MARKETS=spot,krx,us`(서버 재시작).
   2. 바로 Tiingo 캔들을 채운다. 운영 DB 쓰기이므로 `DATABASE_URL`을 명시하고 먼저 `--dry-run`을 한다.
      CLI 프로세스에도 `US_STOCK_PRICE_PROVIDER=tiingo`를 준다.
      - 5m: `pnpm exec tsx scripts/candle-baseline-sync.ts --apply --asset-type us_stock --target 5m --days 45`
      - 1d·1w: `… --mode repair --days 875 --target 1d --target 1w`
      - 4h: `pnpm candle:long-backfill --market us --apply --sessions 97`. CLI에 `tiingo`가 없으면 종료 코드 2로 멈춘다.
        저장 5m가 빠짐없는 세션만 합성되고 나머지는 pending이다.
   3. 백필이 끝날 때까지(수 분) 미국 차트는 일부만 보이거나 비어 있고, 등락률은 1d 백필 뒤에 나온다. 점검 공지를 권장한다.
   4. 확인: 미국 견적 `assetPriceSource.sourceName=tiingo_us_reference_price`, 차트 `source.provider=tiingo`, 등락률, readiness.

   순서의 이유:
   - 캔들은 (종목, 주기, 시작 시각)당 한 행이라 나중에 쓴 공급자가 덮는다. 읽기는 현재 공급자 행만 쓴다.
     전환 전에 Tiingo로 백필하면 KIS 모드 차트에서 그 구간(5m 45일, 1d·1w 875일)이 전환 때까지 빈다.
   - 정규장 밖이면 새 5m 봉이 생기지 않아 전환 순간 지정가 Path B·진행 중 일봉이 섞일 일이 없다
     (Path B는 코드에서도 현재 공급자 행만 쓴다).
   - 그 밖: 미국 조건주문·손절가/익절가가 전역 플래그에 따라 열린다. 기존 미국 지정가 대기 주문은 Tiingo 가격으로 체결된다.
   - 선택: 안정화 뒤 `KIS_WS_ALLOW_US_DELAYED=false`로 KIS 미국 지연 시세 구독을 끈다. KIS 미국 행 쓰기가 멈춰 미국 가격
     행이 절반으로 준다(국내는 KOSCOM이라 KIS WebSocket 대상이 0이 된다).
5. **미국 LOC**(별도 승인): `LOC_US_ORDERS_ENABLED=true`, `LOC_US_SELL_ORDERS_ENABLED=true`.
   - 국내 LOC(`LOC_ORDERS_ENABLED`)가 켜져 있을 때 켠다. 국내가 꺼져 있으면 이전 버전 앱 사용자가 거의 없어진 뒤에 켠다.
     이전 앱은 `limitOnClose.enabled`만 보고 한국주식에 LOC를 보여 준다(서버는 `LOC_MARKET_NOT_SUPPORTED`로 거부).
   - capability `limitOnClose.markets`에 `US`가 있는지 확인한다.
   - 첫 거래일 21:10–23:00 ET의 `ops_job_runs(limit_on_close_settlement)` 관측·final·체결을 확인한다.

## 6. 롤백

1. **LOC**: `LOC_US_*=false`. 새 미국 LOC만 막고, 접수분은 기존대로 체결·만료된다(worker는 플래그와 무관).
2. **금융 원천**(`LOC_US_*=false`인 상태에서만, 반대 조합은 시작 검증 실패):
   1. `KIS_WS_ALLOW_US_DELAYED=false`로 껐다면 먼저 true로 되돌린다. `kis_us_delayed_trade` 행이 다시 쓰이는지 확인한다.
      그 전에 전환하면 미국 가격이 `unavailable`이 된다.
   2. 이미 등록된 미국 조건주문·독립 손절/익절·진입 TP/SL은 롤백 뒤에도 남아 KIS 가격으로 감시·발동된다(신규 등록만 막힘).
      롤백 전에 건수를 세고, 유지(KIS 가격 감시)할지 사용자 공지 뒤 취소할지 정한다. 취소는 별도 승인이며 일괄 취소 도구는 없다.
   3. `US_STOCK_PRICE_PROVIDER=kis`, `SCHEDULER_MARKET_CANDLE_LONG_SYNC_MARKETS`에서 `us`를 뺀다.
      남은 미국 LOC는 Tiingo 정식 모드가 유지되는 동안 계속 판정된다.
   4. 차트: KIS 모드는 `tiingo_*` 행을 읽지 않는다. CLI 프로세스에 `US_STOCK_PRICE_PROVIDER=kis`를 주고 `DATABASE_URL`을 명시한다.
      - 1d·1w: `pnpm exec tsx scripts/candle-baseline-sync.ts --apply --asset-type us_stock --mode repair --days 875 --target 1d --target 1w`
      - 5m: `… --target 5m`. 단, KIS 미국 분봉은 대략 당일 세션만 주므로 Tiingo가 덮은 과거 5m(그리고 15m·30m·1h·4h)는
        복구되지 않고 비어 보인다(알려진 롤백 손실).
3. **수집 중단**: `TIINGO_ENABLED=false`. 남은 미국 LOC가 있으면 23:00 ET 기한 뒤에 한다(그 전에 끄면 Tiingo 증거를 못 받아 만료된다).

## 7. 감시

- `/readiness` `data.tiingo`: lease 상태(owner/standby/unavailable), 스냅샷 쓰기·throttle·skip 카운트, 스트림 상태, REST 예산.
  `queuedBehindWrite`가 계속 늘면 DB 쓰기가 5초 throttle보다 느린 것이다(같은 종목 쓰기는 한 번에 하나만 한다).
- `ops_job_runs`:
  - `limit_on_close_settlement` — observations, observationFailures(`TIINGO_CLOSE_*`), expired, postFinalCorrections;
  - `market_candle_sync`·`market_candle_long_sync` — US feed 결과.
- 로그: `LOC_US_CLOSE_CORRECTED_AFTER_FINAL`, `TIINGO_US_SPLIT_OBSERVED`, `Tiingo collector lease lost`.

## 8. 검증과 남은 확인

- 단위 테스트:
  - 설정·수집 lease·snapshot writer;
  - 자격 판정·admin_manual 차단;
  - LOC 정책(EDT·EST·조기 폐장·DST)·증거 원천;
  - 캔들 정규화·sync·제공·4h 합성·등락률·달력.
- PostgreSQL 통합 `scripts/limit-on-close-us-integration.ts`(CI `LIMIT_ON_CLOSE_US_DB_INTEGRATION`):
  - 26개 시나리오. BUY/SELL 경계, 공유 관측, 날짜 불일치, 재확인, 23:00 만료, FX 준비, 경쟁, 생명주기, 사후 정정 진단,
    Tiingo 모드 미국 시장가 BUY/SELL(새 KIS·admin_manual 가격 무시, 실행 신선도 10초 초과 거부)을 다룬다.
  - 기본 확인 간격은 축약(400ms)이다. `LOC_US_INTEGRATION_CONFIRM_MS=300000`로 운영 간격을 재현할 수 있다(2026-10-17 전체 창 2개 PASS, 1,888초).
- 조건 SELL·조건 BUY·독립 TP/SL PostgreSQL suite에 Tiingo 모드 미국 시나리오가 하나씩 있다. 새 KIS 가격으로는 발동하지 않고,
  등록 뒤 Tiingo 가격으로 발동해 USD 지갑으로 체결한다. 진입 계획은 KIS 모드에서 거부된다.
- 지정가 매칭 PostgreSQL 통합(`scripts/limit-order-matching-integration.ts`)과 국내 LOC 통합 31개 시나리오로 회귀를 확인했다.
- 실제 Tiingo(정식 계약 토큰)로는 아직 검증하지 않았다(§5-1 smoke 필요). 확인할 것: EOD 공개·정정 시각, 25종목 메타데이터, 5m 과거 보관 깊이(96세션), 다중 종목 구독.

## 9. 알려진 제약

- 미국 진행 중 5분봉 실시간 표시가 없다(§2.3). 거래량 없는 표시 정책을 따로 결정해야 한다.
- 정기 지정가 매칭(Path A/B)은 기존 정책대로 DB만 본다. USD/KRW가 60초보다 오래되면 `fx_evidence_unavailable`로
  다음 cycle을 기다린다(암호화폐 USD 지정가와 같음). 기본 FX 수집 주기는 3600초다.
- Tiingo intraday 거래량이 통합 거래량인지는 공급자 확인 대상이다. 표시용이며 금융 계산에 쓰지 않는다.
- 장 마감 뒤 표시·평가 가격은 마지막 정규장 tick이다. 16:00 종가 경매 체결은 정규장 밖 시각이라 저장하지 않아 공식 종가와 다를 수 있다
  (LOC는 EOD 원시 종가를 쓴다).
- 원시 가격 정책이라 분할 당일 등락률은 원시 하락으로 보이고(예: 10:1이면 약 −90%), 분할을 걸친 1w 봉은 분할 전후 가격이 섞인다.
  4h는 합성 뒤 5m가 정정돼도 다시 만들지 않는다.
- 거래가 없던 5m 슬롯(정지·무거래)이 있으면 그 슬롯이 든 15m·30m·1h·4h 봉은 빠지고, 4h는 pending으로 남으며, 그날 진행 중 일봉도 보이지 않는다(보간 없음).
- 장중 Tiingo 5m sync는 정산 경계 때문에 coverage를 완료로 남기지 못한다(장 마감 뒤 run이 그날을 증명). 장중 차트는 기존 1일 tail 허용으로 제공된다.
- 사후 재조회 표시는 프로세스마다 기억한다. 서버가 여러 대면 같은 증거를 한 번 더 조회·기록할 수 있다(진단만, 체결 영향 없음).
- 미국 LOC는 `TIINGO_ALLOWED_SYMBOLS` 밖 종목이나 NAS/NYS 밖 시장이면 등록은 되지만 증거를 못 받아 23:00 ET에 만료된다.
  정식 운영은 빈 값(고정 25종목)으로 둔다.

### 미해결 결정 (제품 정책, 승인 필요)

- **장 마감 뒤 취소**: 기존 LOC 정책대로 미국 LOC도 final 전까지 사용자 취소가 된다. 미국은 16:00 마감부터 21:10 관측까지 5시간 넘게
  (조기 폐장일 8시간) 시간외 거래를 보고 취소할 수 있어 랭킹에서 무위험 선택권이 된다. 대안: 미국(또는 전체) LOC의 취소를 정규장
  마감 전까지로 제한. 이번 작업은 "기존 LOC 취소 정책 유지" 요구에 따라 바꾸지 않았다.
- **시즌 종료와 판정 시각**: 등록은 기존대로 시즌 종료가 세션 마감 뒤인지만 본다. 시즌 종료가 16:00과 21:10 ET 사이면 미국 LOC는 체결될 수 없고
  시즌 종료 정리로 취소된다(예약 해제, 금전 손실 없음). 현재 주간 시즌(일요일 23:59 KST 종료)에서는 생기지 않는다.
