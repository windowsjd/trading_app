# 프로젝트 인수인계서

이 문서는 두 영역으로 구성한다.

1. **작업 단위 기록** — 작업 단위별 목적/변경/검증/주의사항.
2. **최신 작업 시간순 기록** — 최신 작업이 위에 오는 시간순 로그.

세부 계약·정책의 기준 문서는 `backend/docs/*.md`와 `backend/README.md`이며,
이 문서는 "무엇을 왜 바꿨고 다음 사람이 무엇을 알아야 하는가"만 기록한다.

---

## 1. 작업 단위 기록

### 작업 단위: 실시간 fanout 경량화·표시 결함 보완 + 캔들 차트 viewport 인터랙션 (2026-07-25)

**목적**

직전 "암호화폐 시세 실시간성·표시 정밀도 개선" 작업에서 남은 결함 8건을 보완하고,
캔들 차트를 모바일 중심의 확대·축소·좌우 이동(viewport) 차트로 개선한다.
가상 트레이딩 앱 수준 유지: 거래소급 차트 엔진·무한 과거 로딩·지표 시스템 없음.

**A. 실시간 보완 변경 요약**

- (백엔드) 실시간 ticker 한 건마다 돌던 DB 조회 제거.
  `AssetTickerGateway`가 `buildSnapshotTickerMessage()`(구독 ack + 3초 poll 전용,
  기존 `buildTickerMessage` 개명)와 분리된 `buildRealtimeTickerMessageFromEvent()`로
  event + 캐시만으로 payload를 만든다.
  - `RealtimeAssetMetadataCacheService`(신규, realtime/): assetId→자산 identity,
    5분 TTL, unknown/inactive 30초 negative cache, DB 실패 시 마지막 값 유지.
    `displayPriceDecimals`는 읽기 시점마다 Binance tickSize 메모리 캐시에서 해석.
  - `AssetsService.convertRealtimePriceToKrw` 내부 2초 TTL USD/KRW selection
    캐시(가용/불가 결과 모두 캐시, 동시 miss 1회 조회 병합). REST 경로는 불변.
  - 실시간 event는 `assetPriceSnapshotId: null`로 나간다(저장 스냅샷을 주장하지
    않음). 정렬/dedup은 `priceCapturedAt`/`priceEffectiveAt` 기준. 3초 poller가
    같은 가격의 스냅샷 메시지를 한 번 더 보낼 수 있으나 프런트 수락 정책이 걸러낸다.
- (백엔드) ticker backpressure + 최신값 coalescing: 클라이언트 소켓 buffered
  bytes가 임계값(캔들과 동일 knob, 기본 1MB) 초과 시 자산별 최신 1건만 보관,
  100ms flush 타이머가 소켓이 비면 전송. 해제된 구독의 잔여 큐는 폐기.
- (프런트) 상세 화면 KRW fallback 결함 수정: `displayPricePolicy.ts`의
  `selectDisplayPriceKrw/State/Source` — 최신 ticker가 있으면 local price·KRW
  상태·priceSource를 한 세트로 사용, ticker KRW unavailable이면 과거 REST KRW를
  절대 조합하지 않음. 가격 소스 표기도 실제 표시 가격의 소스를 따라간다.
- (프런트) 목록 리렌더 격리: `mergeMarketAssetTickersCached`(자산별 identity
  캐시)로 틱이 온 행만 새 객체가 되어 `React.memo` 행이 그 행만 리렌더.
- (프런트) 시간 경과 stale: `isTickerStaleAt(state, nowMs)` + 10초 재판정
  (`useAssetTicker` interval, `MarketTickerStore` 타이머·`recomputeStaleness`).
  ticker가 끊겨도 60초 지나면 stale로 전환된다.
- (프런트) ticker의 `displayPriceDecimals`가 목록 행 병합에 반영된다.

**B. 캔들 차트 viewport 변경 요약**

- `frontend/src/components/charts/chartViewport.ts`(신규, 순수 모듈): offset/size
  viewport, 기본 최신 60개(모든 타임프레임 동일 밀도, 데이터가 적으면 오른쪽
  정렬 + 왼쪽 여백), pan/zoom 클램프(12~240개, 로드된 범위 내), 보이는 구간 +
  버퍼 4개만 렌더, y축은 보이는 캔들 기준, 우측 끝 고정 시 신규 캔들 follow,
  wheel/pinch/수평 의도 판정 등 gesture 수학 포함. `node --test` 25케이스.
- `CandlestickChart.tsx` 재작성: PanResponder 기반 —
  두 손가락 pinch 확대·축소(손가락 중점 anchor), 한 손가락 수평 드래그 pan,
  세로 드래그는 클레임하지 않아 부모 ScrollView가 스크롤, ~300ms 길게 누르면
  크로스헤어(이동 추적, 뗄 때 해제). 웹(react-native-web): 마우스 드래그 pan
  (동일 responder), non-passive DOM wheel 리스너로 커서 anchor 줌, hover
  크로스헤어. 현재가 라인은 최신 캔들이 보일 때만. 타임프레임 전환 시
  `viewportResetKey`(assetId:interval)로 최신 60개로 초기화.
- 기존 `candlestickLayout.ts`(+test)는 viewport 모듈이 대체하여 삭제
  (오른쪽 정렬·밀도 정책은 chartViewport 테스트가 커버).

**주의사항**

- 실시간 payload 계약 변화: `assetPriceSnapshotId`가 실시간 event에서 항상 null.
  스냅샷 기반 메시지(구독 ack·poll)는 기존 그대로. 클라이언트는 timestamp로 정렬.
- gateway 생성자에 `RealtimeAssetMetadataCacheService`가 필수 param으로 추가됨
  (spec/스크립트에서 직접 생성 시 mock 필요 — candle-release-fixture-smoke 포함 수정).
- 차트는 로드된 캔들 범위 안에서만 이동한다. 과거 무한 로딩은 의도적으로 제외.
- DB migration 없음. 주문·체결·지정가·지갑·원장 불변.

**검증**

- backend: typecheck/build/test 2045 pass (신규: metadata cache 8, FX 캐시 3,
  gateway 이벤트 빌더·backpressure 15, 기타).
- frontend: typecheck/test 168 pass (신규: displayPricePolicy 5, 정책 stale 2,
  store stale 1, merge decimals·identity 4, chartViewport 25), expo export
  android/web 성공.
- 실기기 pinch/long-press 제스처는 에뮬레이터 부재로 미실행(NOT_RUN) — gesture
  수학은 순수 모듈 테스트로 검증, 컴포넌트는 typecheck + 번들로 확인.

### 작업 단위: 암호화폐 시세 실시간성·표시 정밀도 개선 (2026-07-25)

**목적**

거래소(Binance) 화면과 앱 화면의 가격 차이를 줄인다. 세 가지 원인을 해결한다.

1. 시장 목록 화면(MarketScreen)이 REST 조회 시점 가격만 표시하고 실시간 ticker를 구독하지 않음.
2. live candle 모드에서 Binance `@ticker`가 DB 저장(종목별 5초 throttle)을 거쳐
   gateway의 3초 DB polling으로만 앱에 도달 → 최대 수초 지연.
3. 프런트엔드가 모든 USD 가격을 소수점 2자리로 반올림 → XRP/TRX/DOGE 등 저가 코인의
   표시값이 거래소와 달라짐.

**가격 기준(고정)**

- `Binance Spot USDT 마켓 최근 체결가` = `24hrTicker` 이벤트의 `c`.
- `b`(최우선 매수호가)/`a`(최우선 매도호가)는 이벤트에 포함되지만 화면에 쓰지 않는다.
- Futures / Mark Price / Index Price / bid·ask 중간값 / 타 거래소·평균가는 사용하지 않는다.
- 신규 stream(`@trade`, `@aggTrade`, `@bookTicker`) 없음. `@ticker`만 사용.
- USDT는 MVP 정책상 USD 등가로 취급한다(`CurrencyCode.USDT` 없음).

**변경 요약**

- 백엔드
  - `LiveCandleStreamSupervisorService.handleBinanceTickerFrame`이 ticker 수신 즉시
    공용 `ProviderPricePubSubService`로 fanout하고, DB snapshot 저장은 **별개의**
    background 작업으로 수행. DB 저장 실패는 fanout을 막지 않고 provider health의
    `lastErrorCode`에 기록된다. 기존 종목별 snapshot throttle
    (`BINANCE_WS_SNAPSHOT_THROTTLE_MS`, 기본 5000)과 dedup은 그대로다.
  - `AssetTickerGateway`가 실시간 이벤트의 KRW 환산을 스냅샷 값 재사용 대신
    `AssetsService.convertRealtimePriceToKrw`로 재계산한다. FX가 없거나 stale이면
    local price는 유지하고 `priceKrwState=unavailable`로 보낸다.
  - `BinanceSymbolMetadataService`(신규)가 공개 `GET /api/v3/exchangeInfo`의
    `PRICE_FILTER.tickSize`에서 종목별 표시 자릿수를 뽑아 메모리 캐시(6h TTL,
    백그라운드 갱신, 실패 시 마지막 성공값 유지)로 제공한다. 캐시가 없으면
    `binance-fixed-asset-universe.ts`의 검토된 상수를 fallback으로 쓴다.
  - 자산 목록/상세/`:assetId/price` 응답과 `asset_ticker` WebSocket payload에
    `displayPriceDecimals`(additive, nullable) 추가. `/api/v1` 유지.
- 프런트엔드
  - `useMarketTickers` + `MarketTickerStore`가 현재 로드된 assetId를 **기존 공용
    소켓**(`getRealtimeSocketManager`, `/api/v1/ws`, `asset_ticker` 채널)에 구독한다.
    종목별 새 연결 없음, 신규 채널 없음.
  - `mergeMarketAssetTicker`가 REST baseline 위에 실시간 가격만 overlay한다.
  - `MarketAssetRow`(React.memo)로 행 분리 → 틱이 온 종목만 리렌더.
  - `assetTickerPolicy`가 목록/상세 공통 수락 규칙(스냅샷 중복, timestamp 역행,
    timestamp 없는 이벤트, unavailable, stale)을 담당한다.
  - `formatAssetPrice(value, currencyCode, displayPriceDecimals)`가 자산 **단가** 표시를
    담당한다. 지갑 잔액·주문 총액·수수료는 기존 `formatMoney`/`formatCurrency`
    (USD 2자리) 정책 그대로다.

**주의사항 / 다음 사람이 알아야 할 것**

- DB migration 없음. 스키마 변경 없음. 주문·체결·지정가 matcher·지갑·포지션·원장
  계산은 건드리지 않았다. 화면 표시 최신성 개선일 뿐이며, 주문 체결 가격은 여전히
  서버 quote/execute가 최종 결정한다.
- 일반 ticker 모드와 live candle 모드는 상호 배타적이다.
  `BinanceWebSocketStreamingService.start()`가 live candle Binance 모드에서 스스로
  `state=disabled`가 되므로 같은 ticker가 두 번 fanout되지 않는다. 모드 전환 후에는
  backend를 재시작해야 한다.
- 고정 universe의 `priceTickSize`/`displayPriceDecimals` 상수는 fallback이다. 실제
  값은 런타임에 exchangeInfo에서 갱신되고, `pnpm smoke:binance-fixed-universe`가
  상수와 실제 tickSize 일치를 검증한다(현재 10/10 일치).
- 자릿수를 프런트엔드에 하드코딩하지 말 것. 백엔드 `displayPriceDecimals`만 쓴다.

**운영 환경변수 / 실행 명령**

```env
# 일반 ticker 모드
BINANCE_WEBSOCKET_STREAMING_ENABLED=true
CANDLE_LIVE_STREAMING_ENABLED=false
CANDLE_LIVE_BINANCE_ENABLED=false
BINANCE_WS_SNAPSHOT_THROTTLE_MS=5000

# live candle 모드(ticker 즉시 fanout + kline)
CANDLE_LIVE_STREAMING_ENABLED=true
CANDLE_LIVE_BINANCE_ENABLED=true
BINANCE_WS_SNAPSHOT_THROTTLE_MS=5000
```

```bash
cd backend && pnpm install && pnpm exec prisma generate
pnpm exec prisma migrate status      # 새 migration 없음
pnpm run typecheck && pnpm run build && pnpm test
BINANCE_MARKET_DATA_SMOKE=1 pnpm smoke:binance-fixed-universe   # 실제 provider, opt-in

cd frontend && npm run typecheck && npm test
```

---

## 2. 최신 작업 시간순 기록

### 2026-07-25 (2차) — 실시간 fanout 경량화·표시 결함 보완 + 캔들 차트 viewport

- 실시간 ticker fanout에서 이벤트당 DB 조회 제거(자산 metadata 5분 캐시 + FX 2초
  캐시), snapshot 기반 빌더와 분리, `assetPriceSnapshotId: null` 계약.
- WebSocket ticker backpressure(자산별 최신값 coalescing) 추가.
- 상세 화면 최신 ticker local price ↔ 과거 REST KRW 혼합 차단, 가격 소스 일치.
- 목록 행 identity 캐시로 틱이 온 행만 리렌더, ticker displayPriceDecimals 반영.
- 시간 경과 기반 stale 재판정(10초 주기, 상세+목록).
- 캔들 차트: viewport 기반 pinch 줌 / 수평 드래그 pan / 길게 눌러 크로스헤어 /
  웹 wheel·드래그, 기본 최신 60개 동일 밀도, 보이는 캔들 기준 y축, 보이는
  구간+버퍼만 SVG 렌더, 타임프레임 전환 시 초기화, 로드된 범위 내 이동만.
- 검증: backend 2045 pass, frontend 168 pass, expo export android/web 성공.
- DB migration 없음, 기존 금융 데이터 변경 없음.

### 2026-07-25 — 암호화폐 시세 실시간성·표시 정밀도 개선

- MarketScreen 실시간 구독(기존 공용 WebSocket 재사용, REST baseline + live overlay).
- live candle `@ticker` 즉시 fanout / DB snapshot 저장 분리(throttle 유지).
- 실시간 KRW 환산 일관성(과거 snapshot KRW 재사용 금지).
- exchangeInfo `PRICE_FILTER.tickSize` 기반 `displayPriceDecimals` 도입 및 목록·상세·
  주문 화면 자산 단가 포맷 통일.
- 검증: backend typecheck/build/test(2027 pass), frontend typecheck/test(142 pass 이후 추가),
  `BINANCE_MARKET_DATA_SMOKE=1 pnpm smoke:binance-fixed-universe` PASS(10/10, tickSize 10/10).
- DB migration 없음, 기존 금융 데이터 변경 없음.

### 그 이전 작업

이 문서 도입(2026-07-25) 이전 이력은 `git log`와 `backend/docs/*.md`를 참고한다.
