# 프로젝트 인수인계서

이 문서는 두 영역으로 구성한다.

1. **작업 단위 기록** — 작업 단위별 목적/변경/검증/주의사항.
2. **최신 작업 시간순 기록** — 최신 작업이 위에 오는 시간순 로그.

세부 계약·정책의 기준 문서는 `backend/docs/*.md`와 `backend/README.md`이며,
이 문서는 "무엇을 왜 바꿨고 다음 사람이 무엇을 알아야 하는가"만 기록한다.

---

## 1. 작업 단위 기록

### 작업 단위: 차트 표시 정밀도·슬롯 정렬·clip 보완 + Reanimated 제거 (2026-07-29)

**목적**

직전(2026-07-26) 작업의 잔여 결함 보완. 신규 기능 확장이 아니며 거래소급 차트
엔진·애니메이션 구조를 추가하지 않는다. viewport/pan/pinch/web drag/stale/
실시간 가격 보완 기능은 그대로 유지한다.

**A. 차트 가격 표시 정밀도**

- 문제: 상세 헤더 가격은 `displayPriceDecimals`를 쓰는데 차트는 USD 2자리
  포맷(`formatCurrency`/`formatMoney`)이라 DOGE 0.24560이 축·라벨에서 $0.25로
  잘렸다.
- `CandlestickChartProps`/`CandlestickChartRendererProps`에
  `displayPriceDecimals?: number | null` 추가. `AssetDetailScreen`이
  `displayPriceDecimals={displayPriceDecimals}`(= `displayPrice.displayPriceDecimals`,
  헤더 가격과 동일한 값)를 넘긴다.
- 차트 가격 표시는 전부 신규 `candlestickPriceFormat.ts`의 `formatChartPrice`
  (= `formatAssetPrice(value, currency, decimals)`) 한 곳을 통과한다:
  Y축 라벨, 현재가선 라벨, 크로스헤어 가격 라벨, 접근성 label의 현재가.
- 지갑 잔액·평가금액·주문 총액·수수료·KRW/USD 총액은 기존 `formatMoney`/
  `formatCurrency` 정책 유지. 포맷 문자열은 표시 전용이며 가격 계산·주문
  요청에 들어가지 않는다.

**B. 60개 미만 데이터의 기본 캔들 폭**

- `viewport.visibleCount`는 이제 **화면 슬롯 수**이며 실제 데이터 개수와
  무관하다. `clampVisibleCount`는 MIN 20 / MAX 180으로만 clamp하고 데이터
  개수로 줄이지 않는다(데이터 0개일 때만 0).
- `createDefaultViewport(600|60|40|12)` → `{visibleCount: 60, rightOffset: 0}`,
  `createDefaultViewport(0)` → `{0, 0}`.
- `getVisibleIndexRange()`는 실제 데이터 인덱스만 반환한다(40개면 0~40).
- `candlestickLayout.ts`에 `computeLeadingEmptySlots(visibleCount, actual)`
  추가 → 부족분은 **왼쪽 빈 슬롯**, 캔들은 오른쪽 정렬. x는
  `paddingLeft + (leadingEmptySlots + index - startIndex + 0.5) * slotWidth`,
  `slotWidth = innerWidth / viewport.visibleCount`.
- 결과: 12개든 600개든 기본 캔들 폭이 같고, 확대/축소도 빈 슬롯 포함 슬롯 수
  기준으로 동작한다(12개 데이터를 20슬롯까지 확대해도 오른쪽 정렬 유지).
- pan: `totalCount <= visibleCount`이면 rightOffset이 0으로 고정되어 좌우
  이동 불가. live append: 59→60→61에서 슬롯 수 60 불변, 61에서 최신 60개만
  표시, 과거 구간에서는 rightOffset이 append 수만큼 늙어 화면이 고정된다.

**C. 빈 슬롯 크로스헤어**

- `originalCandleIndexForX({x, paddingLeft, slotWidth, viewportVisibleCount,
  startIndex, endIndex, leadingEmptySlots})` 추가. 빈 슬롯 위 포인터는 **첫
  실제 캔들로 snap**하고, 결과는 항상 `[startIndex, endIndex-1]` 안이라
  음수·미존재 인덱스가 생기지 않는다. `CandlestickChart`가 크로스헤어 인덱스를
  이 함수로 계산한다(기존 `visibleOffsetForX`는 슬롯 계산용으로 남는다).

**D. render buffer SVG clipping**

- `CandlestickChartRenderer`에 `<Defs><ClipPath>` + plot `<Rect>`
  (x=padding.left, y=padding.top, w=innerWidth, h=innerHeight)를 추가하고
  캔들 layer(wick+body)를 `<G clipPath="url(#…)">`로 감쌌다. 좌우 buffer
  캔들이 가격축·차트 바깥으로 새지 않는다.
- clip id는 `useId()`를 id-safe 문자로 정리해 인스턴스별로 만든다(고정 id 금지
  — 한 화면에 차트가 여럿이어도 충돌하지 않는다).
- 가격축 텍스트·현재가 라벨·크로스헤어 라벨·시간 라벨은 clip 바깥이라 그대로
  보인다.

**E. 상세 등락률 basis 통일**

- `AssetDetailScreen`의 `getDisplayChangeRate()`(ticker → REST fallback) 제거.
  다른 화면 사용처 없음을 검색으로 확인 후 삭제.
- `const displayChangeRate = displayPrice.changeRate;` — realtime ticker가
  있으면 ticker의 changeRate만 쓰고, 그것이 null이면 등락률도 표시하지 않는다
  (과거 REST 값으로 채우지 않음). ticker가 없을 때만 REST changeRate 사용.

**F. Reanimated·Worklets 제거**

- 저장소 전체 검색 결과 `react-native-reanimated`/`react-native-worklets`를
  실제로 import하는 코드 없음(문서·package.json·babel.config.js·proguard
  주석뿐). gesture callback은 전부 `runOnJS(true)`라 worklet이 없다.
- `frontend/package.json`에서 두 패키지 제거 + `npm install`로
  `package-lock.json` 갱신(11 packages removed). 남은 lock 언급은
  `expo-modules-core`의 **optional** peerDependency 한 줄뿐이다.
- `babel.config.js`는 `react-native-worklets/plugin`을 빼고 Expo 기본
  preset만 남겼다(파일 자체는 유지 — Expo 기본 설정 지점).
- `react-native-gesture-handler`와 `App.tsx`의 `GestureHandlerRootView`는
  **유지**. Reanimated 기반 차트 애니메이션은 새로 만들지 않았다.
- 남은 흔적 1건: `frontend/android/app/proguard-rules.pro`의
  `# react-native-reanimated` keep 규칙(존재하지 않는 클래스 keep이라 무해).
  네이티브 빌드 파일이라 이번 표시 보완 작업에서는 건드리지 않았다. 다음
  `expo prebuild`/release 정리 때 함께 제거하면 된다.

**G. long press 종료 보강**

- 크로스헤어 상태를 `candlestickGesturePolicy.ts`의
  `createCrosshairSession()`(순수 상태 머신, 단위 테스트 가능)으로 옮기고
  `longPress.onFinalize(endCrosshair)`를 추가했다. 움직이지 않고 손을 뗀 경우
  `crosshairPan`은 activate된 적이 없어 종료 이벤트가 없었는데, 이제 long
  press finalize가 반드시 정리한다(취소/실패/차트 바깥 이동 포함).
- `end()`는 idempotent라 long press + crosshair pan이 함께 finalize돼도
  `onCrosshair(null)`/`onGestureEnd`는 각각 1회만 발생하고 viewport snapshot이
  어긋나지 않는다. pinch `onBegin`은 기존대로 크로스헤어를 먼저 정리한다.
  일반 가로 pan·세로 scroll은 `start()`를 부르지 않으므로 크로스헤어가 뜨지
  않는다(gesture composition 자체는 그대로).

**검증**

- frontend `npm run typecheck` 통과, `npm test` **224 pass / 0 fail**
  (viewport·layout·crosshair·gesture policy·차트 가격 포맷·displayPrice basis).
- `npx expo export --platform web` / `--platform android` 모두 성공
  (reanimated/worklets 없이, babel plugin 없이 번들됨). 웹 번들에 clipPath와
  `candle-plot-` id 생성 코드 포함 확인.
- **Android 실기기/에뮬레이터 수동 검증 NOT_RUN**, **웹 브라우저 수동 검증
  NOT_RUN** — 이 환경에 adb·emulator·JDK·브라우저가 없다(설치된 것 없음 확인).
  대체 검증은 순수 모듈 단위 테스트 + 두 플랫폼 번들 export + 번들 내 코드
  포함 확인뿐이다. 제스처·clip 렌더 결과는 다음 담당자가 실기기/브라우저에서
  확인해야 한다.
- 백엔드 코드 변경 없음(문서만 수정) → backend 테스트 미실행.
- DB migration 없음. 주문·체결·포지션·지갑·원장·캔들 API/스키마 불변.

### 작업 단위: 실시간 표시 일관성 마무리 + 캔들 차트 gesture/viewport 재구성 (2026-07-26)

**목적**

직전(2026-07-25 2차) 작업의 잔여 결함을 마무리하고, 캔들 차트를 요구된 구조
(순수 viewport 모듈 + 공통 renderer + 플랫폼별 얇은 gesture adapter)로 재구성한다.

**A. 실시간 표시 일관성**

- 상세 화면이 표시하는 가격 블록 전체가 **하나의 기준**을 쓴다
  (`features/asset/displayPricePolicy.ts`의 `selectDisplayPrice`). realtime
  ticker가 있으면 local price·`priceKrwState`·`priceKrwReason`·`priceKrwMessage`·
  `priceSource`·`fxRateSource`·capturedAt/effectiveAt·freshness·decimals를 모두
  그 ticker에서 가져오고, ticker가 없을 때만 REST 세트를 쓴다. REST/realtime
  metadata 혼합 불가. 화면에 `환율 소스` 행과 KRW 사용 불가 사유 표시를 추가.
- MarketScreen 행 리렌더: 병합 캐시를 걷어내고 요구된 구조로 변경 —
  `item`(REST baseline)과 `ticker`를 **별도 prop**으로 넘기고
  `MarketAssetRow` 내부에서 `mergeMarketAssetTicker`로 병합, `React.memo`
  comparator가 item/ticker/isStale/onPress identity를 비교한다.
- stale: `getTickerAgeMs(ticker, nowMs)` / `isTickerStaleAt(ticker, nowMs)`
  (임계값은 기존 60초 상수 재사용, 중복 상수 없음) + `useStaleRecheck` 훅이
  5초 주기로 재판정. ticker를 보유한 화면에서만 timer가 돌고, unmount·
  백그라운드 전환 시 정지하며 foreground 복귀 시 즉시 1회 재판정한다.
- ticker backpressure 보강: 클라이언트별 pending 큐를 자산 키 기준 + 64개
  상한(가장 오래된 자산부터 제거)으로 제한하고, unsubscribe/disconnect 시
  정리, 카운터를 `GET /readiness`의 `data.assetTicker`로 노출
  (`TICKER_FANOUT_METRICS` 토큰 주입 — readiness가 gateway 클래스를 직접
  import하지 않는다).

**B. 캔들 차트 재구성**

- viewport 모델을 요구 사양대로 `{visibleCount, rightOffset}`으로 변경하고
  `candlestickViewport.ts`(+test)로 이전: `createDefaultViewport`,
  `clampVisibleCount`, `clampRightOffset`, `getVisibleIndexRange`,
  `panViewportByPixels`, `zoomViewportAtFocalPoint`, `resetViewport`,
  `isViewingLatest` 등. 상수는 MIN 20 / DEFAULT 60 / MAX 180, buffer 2.
- `candlestickLayout.ts`(+test) 복원: slot/body 픽셀 폭과 x ↔ visible offset
  매핑만 담당(zoom은 visibleCount 변경이지 scaleX가 아님).
- `candlestickGesturePolicy.ts`(+test): 수평 pan 의도 판정, 웹 wheel 의도
  분류(zoom / pan / page-scroll), wheel·pinch scale 범위 — 양 플랫폼 공유.
- `CandlestickChartRenderer.tsx`: 공통 SVG renderer(모바일·웹 공용, 복제 없음).
- `CandlestickGestures.native.tsx`(RNGH pinch/pan/long-press) /
  `.web.tsx`(mouse drag/hover/ctrl+wheel). `CandlestickGestures.tsx`는 props
  계약 + gesture 없는 fallback이며 Metro가 플랫폼별로 해석한다.
- `CandlestickChart.tsx`는 viewport 상태·geometry·visible slice·컨트롤
  (`+`/`−`/`초기화`, 접근성 label)만 담당한다.
- 패키지: `npx expo install react-native-gesture-handler react-native-reanimated
  react-native-worklets`, `babel.config.js`에 `react-native-worklets/plugin`,
  `App.tsx`에 `GestureHandlerRootView` 1회 wrapping.
  → **2026-07-29 정정**: reanimated/worklets는 실제로 쓰이지 않아 제거했다.
  현재는 gesture-handler + `GestureHandlerRootView`만 남았고 babel plugin도 없다.

**주의사항**

- **네이티브 재빌드 필요**: gesture-handler는 네이티브 모듈이라 기존 dev
  client로는 실행되지 않는다(`npx expo run:android` 또는 새 EAS dev build).
  Expo web은 추가 설정 없이 동작한다.
  (2026-07-29에 reanimated/worklets를 제거했으므로 네이티브 모듈은
  gesture-handler뿐이다.)
- 차트는 로드된 캔들 범위 안에서만 이동한다(무한 과거 로딩·cursor pagination·
  candle API 변경 없음). 확장 지점은 `CandlestickChart`가 받는 candle 배열이며
  viewport 계산과 slice는 이미 분리되어 있다.
- 실시간 payload는 여전히 `assetPriceSnapshotId: null`(timestamp로 정렬).
- DB migration 없음. 주문·체결·지정가·지갑·원장 불변.

**검증**

- backend typecheck/build/test 2048 pass, frontend typecheck/test 218 pass,
  `expo export` web·android 성공(웹 번들에만 DOM adapter 포함 확인).
- 모바일 실기기/에뮬레이터 제스처 수동 검증과 웹 브라우저 수동 검증은
  환경 부재로 NOT_RUN(순수 모듈 테스트 + 번들 검증으로 대체).

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

### 2026-07-29 — 차트 표시 정밀도·슬롯 정렬·clip 보완 + Reanimated 제거

- 차트 가격축·현재가 라벨·크로스헤어·접근성 문구가 종목별
  `displayPriceDecimals`를 쓴다(`AssetDetailScreen` → `CandlestickChart` →
  renderer, 공통 `formatChartPrice`). DOGE 등 저가 코인이 더 이상 2자리로
  잘리지 않는다. 지갑·평가금액·주문 총액·수수료 포맷 정책은 불변.
- viewport의 `visibleCount`를 **화면 슬롯 수**로 재정의: 데이터가 60개보다
  적어도 기본 60슬롯을 유지하고 부족분은 왼쪽 빈 슬롯, 캔들은 오른쪽 정렬.
  40개·12개 차트의 캔들 폭이 600개와 같아졌다. 데이터 0개일 때만 빈 viewport.
- `originalCandleIndexForX()`로 빈 슬롯 위 크로스헤어를 첫 실제 캔들에 snap
  (미존재/음수 인덱스 불가).
- render buffer 캔들에 plot 영역 SVG clipPath 적용(`useId` 기반 인스턴스별
  id). 가격축·현재가/크로스헤어 라벨은 clip 바깥이라 그대로 표시된다.
- 상세 등락률을 `displayPrice.changeRate` 단일 basis로 통일하고
  `getDisplayChangeRate()` 제거 — realtime 가격 + 과거 REST 등락률 혼합 불가.
- 실사용처가 없던 `react-native-reanimated`/`react-native-worklets` 제거
  (package.json + lock 갱신, babel worklets plugin 제거). gesture-handler와
  `GestureHandlerRootView`는 유지.
- 모바일 long press 종료 보강: 크로스헤어를 `createCrosshairSession()`
  상태 머신으로 옮기고 `longPress.onFinalize`를 추가(움직이지 않고 손을 떼도
  종료, 중복 호출 안전).
- 검증: frontend typecheck 통과, 224 pass, expo export web/android 성공.
  Android 실기기·에뮬레이터와 웹 브라우저 수동 검증은 환경 부재로 NOT_RUN.
  백엔드 코드 변경 없음(문서만), DB migration 없음, 금융 데이터 불변.

### 2026-07-26 — 실시간 표시 일관성 마무리 + 캔들 차트 gesture/viewport 재구성

- 상세 화면 가격 블록을 단일 기준(selectDisplayPrice)으로 통일: KRW 상태·사유·
  메시지·가격 source·FX source·시각·정밀도가 모두 같은 데이터에서 나온다.
- MarketScreen을 item/ticker 별도 prop + 행 내부 병합 구조로 변경(리렌더 격리).
- stale 판정을 `getTickerAgeMs`/`isTickerStaleAt(ticker, now)` + 5초 재판정
  훅으로 정리(백그라운드에서는 timer 정지).
- ticker backpressure에 큐 상한·정리·readiness 메트릭(`data.assetTicker`) 추가.
- 캔들 차트를 `{visibleCount, rightOffset}` viewport + 공통 renderer + 플랫폼별
  gesture adapter 구조로 재구성(기본 60개, MIN 20/MAX 180, focal point zoom,
  visible 기준 Y축, 과거 구간 현재가선 숨김, visible+buffer만 렌더,
  timeframe reset, +/−/초기화 버튼).
- gesture-handler/reanimated/worklets 도입 → **네이티브 dev client 재빌드 필요**.
  (2026-07-29에 reanimated/worklets 제거 — 현재 네이티브 모듈은 gesture-handler뿐.)
- 검증: backend 2048 pass, frontend 218 pass, expo export web/android 성공.
  실기기·브라우저 수동 검증은 NOT_RUN.

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
