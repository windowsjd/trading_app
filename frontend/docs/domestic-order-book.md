# 한국주식·암호화폐 공통 호가창

`AssetOrderBook`은 Provider와 주문 처리에 독립된 표시 계약이다.
현재 AssetDetail 거래 화면은 좌측 `OrderPanel`, 우측 `AssetOrderLadder`의 Binance 10+10호가 또는 주식 현재가, 하단 `AccountHoldings`를 표시한다. 차트는 별도 `AssetChartScreen`에 있다.
`AssetOrderBookCard`는 공통 카드의 개발 harness/렌더 테스트용으로 남아 있다.
Backend 계약과 검증 기록은 [order-book-api-contract.md](../../backend/docs/order-book-api-contract.md)를 참고한다.

## 현재 데이터 흐름

```text
기존 Binance owner → 공통 depth parser/processor → Redis Pub/Sub
→ /api/v1/ws asset_order_book → RealtimeSocketManager
→ useAssetOrderBook → AssetOrderLadder (AssetDetail 우측)
```

- 기존 React Query의 종목 상세·차트·계정별 포지션 키와 현재가 선택은 그대로다.
- 활성 BINANCE/USD crypto 화면이 focus 상태일 때만 기존 shared socket으로 해당
  assetId를 구독한다. 화면 blur·종목 변경·unmount 시 reference count를 해제한다.
- transport 재연결 및 재구독은 기존 manager가 처리한다. 새 Frontend WebSocket은 없다.
- 호가는 Query cache나 주문·체결·평가 상태에 쓰지 않는다.
- stale은 마지막 정상 snapshot의 **클라이언트 수신 시각**부터 5초 초과 시 판정한다.
  서버 `capturedAt`은 표시·snapshot 순서 보호에 유지하되 클라이언트 현재 시각과 비교하지
  않는다. 서버 시계가 과거/미래여도 방금 정상 수신한 데이터는 fresh다.
- 첫 snapshot 전에는 로딩을 표시한다. 해당 구독 ACK부터 10초간 정상 snapshot이 없으면
  `호가 정보를 현재 수신할 수 없습니다.`로 바뀌며 이후 정상 수신 시 즉시 복구한다.
  중복 ACK나 잘못된/다른 종목 snapshot은 대기 시작 시각을 갱신하지 않는다.
- 상태 문구 우선순위는 인증 오류 → 구독 오류 → 연결 복구 → 최초 수신 timeout → stale
  → 로딩 → 정상이다. 한 번 수신한 book은 reconnect 중 유지하고, 복구 후 새 데이터가
  없으면 stale로 표시한다. 이 상태들은 주문 버튼·견적·체결 가능 여부와 무관하다.
- 기존 foreground 재검사 helper를 250ms 간격으로 재사용한다. 별도 timeout 타이머는 없다.
  최초 수신 대기는 ACK 이후에만 켜고, timeout·오류·연결 끊김·blur/unmount 시 종료한다.
  asset/URL 변경은 기존 대기 시각을 버리고 구독을 해제한다. background에서는 타이머를
  멈추고 foreground 복귀 시 즉시 재검사한다. 이미 book이 있으면 stale 재검사를 계속한다.
- 종목이 바뀐 첫 렌더부터 이전 종목 호가를 숨긴다. 잘못된 snapshot은 부분 정상 데이터로
  위장하지 않고 전체 거부한다. 실제 snapshot이 빈 배열이면 빈 호가로 표시한다.

## 공통 계약

`features/asset/orderBook.ts`:

```ts
interface AssetOrderBook {
  assetId: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel?: string;
  asks: readonly { price: string; quantity: string }[];
  bids: readonly { price: string; quantity: string }[];
  totalAskQuantity?: string | null;
  totalBidQuantity?: string | null;
  capturedAt: string;
  effectiveAt?: string | null;
}
```

한국주식은 `원 / 주`, BTC는 `USDT / BTC`, ETH는 `USDT / ETH`를 표시한다.
금융 CurrencyCode(KRW/USD), USD equivalent 결제, Wallet/FX/Portfolio 정책은 변경하지 않는다.
실시간 UI에는 Binance payload나 update id가 노출되지 않는다.

가격은 양수 decimal string, 잔량은 0 이상 decimal string이다. Decimal로 매도 오름차순,
매수 내림차순 비교 후 최대 10단계를 표시한다. 공통 normalization은 기존대로이며,
실시간 수신 경계에서는 배열·시각·중복 가격·문자열을 먼저 검증한다.
`formatDisplayDecimal`의 끝자리 0 제거 정책과 정수부 쉼표를 사용하며 Number 변환이나
반올림을 하지 않는다. 없는 호가·거래소 총 잔량은 만들지 않는다.

화면에서 매도는 10→1, 매수는 1→10 순서다. 기존 색상·카드·여백을 사용한다.
긴 문자열은 표 내부 가로 스크롤로 전체 숫자에 접근할 수 있다. 현재 종목 상세에는
별도의 다크 모드 테마가 없으며 새 테마 체계는 도입하지 않는다.

## Preview 정책과 사용

현재 AssetDetail은 국내주식 Preview나 inline chart를 표시하지 않는다. 국내·미국주식은
종목 옆 한글 시장상태 badge와 우측 현재가를 표시하고, 차트 아이콘으로 전체화면 차트에 진입한다.

`AssetOrderBookCard`, `getOrderBookPreview`와 crypto fixture는 공통 카드의 개발
harness/렌더 테스트에서 사용할 수 있다. `EXPO_PUBLIC_ORDER_BOOK_PREVIEW` 및
`EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG` 플래그를 켜도 현재 거래 화면에 가상 호가를 추가하지 않는다.
암호화폐 상세의 로딩·Provider 장애·구독 오류에는 fixture로 fallback하지 않는다.

## 검증

```bash
npm run typecheck
npm run lint:accounts:check
npx eslint --no-fix --max-warnings=0 src/features/asset/assetOrderBookPolicy.ts src/features/asset/useAssetOrderBook.ts src/features/asset/AssetOrderBookCard.tsx src/services/ws/realtimeSocketManager.ts
npm test
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG=true npm run export:web
npx expo export --platform android --output-dir /tmp/orderbook-android-export
```

정규화·fixture·카드 회귀에 더해 실제 channel 메시지, BTC/ETH/XRP 단위 및 소수,
빈/부분 snapshot, malformed data, 이전 종목 차단, loading/error/reconnect/stale,
foreground 복귀, shared socket 구독 복원·해제를 테스트한다.
Backend 실제 Binance/Redis 검증 명령과 결과는 Backend 계약 문서에 기록한다.

## 구독 DB 조회 조사 (2026-09-19 상태 보정)

`BinanceOrderBookService.loadTargets()`는 두 Provider owner의 연결/재연결 시 및 gateway의
새 호가 구독 검증 시 호출한다. 매 depth frame/fanout마다 조회하지 않는다. 동일 client의
이미 등록된/검증 중인 구독은 gateway가 중복 조회하지 않고, Frontend도 reference counting을
유지한다. 서로 다른 client의 새 구독은 각각 현재 active mapping을 DB로 확인한다.

현재 10종목 규모에서는 이 조회를 유지한다. `RealtimeAssetMetadataCacheService`는
positive 5분/negative 30초 TTL을 사용하고 DB 오류 시 과거 값을 반환한다. 이는 ticker
표시용 정책이며 호가 구독의 fail-closed 검증과 다르다. 또한 개별 자산 cache로는 BTC와
BTCUSDT가 동시에 등록된 ambiguous mapping을 확인할 수 없다. 현재 active/inactive 반영과
fixed-universe 검증을 유지하려면 별도 invalidation/검증 정책이 필요하므로 이번에는
cache를 추가하거나 Backend 동작을 바꾸지 않는다. 동시 접속 증가 시 측정 후 최적화 후보로 둔다.

## 상태 보정 검증 결과 (2026-09-19)

실제 원인은 `isOrderBookStale()`의 `Math.max(local age, server capturedAt age)` 비교와
첫 book이 있어야만 켜지는 재검사 타이머였다. 요청의 원인 가설과 일치했다. 별도 timeout
시스템 대신 기존 foreground 재검사에 ACK 시각만 추가했고, `capturedAt` 역행 거부는 유지했다.

| 검증 | 결과 |
| --- | --- |
| local stale 5,000ms 정상 / 5,001ms stale, 서버 과거·미래 시각 | PASS |
| ACK 전 무제한 연결 대기와 ACK 후 10초 timeout 구분 | PASS |
| 중복 ACK, malformed/다른 종목 frame이 timeout을 연장하지 않음 | PASS |
| timeout → 정상 수신 복구, 유효한 빈 snapshot | PASS |
| reconnect book 유지 / stale 복귀, asset·URL 변경, blur/unmount 정리 | PASS |
| 인증·구독 오류 우선순위, background 정지·foreground 즉시 재검사 | PASS |
| stale/unavailable/reconnect에도 매수·매도 버튼/진입 유지 | PASS |
| Frontend typecheck, accounts/guides lint, 변경 소스 check-only lint | PASS |
| Frontend 전체 테스트 | PASS: 77개 테스트 파일 |
| Backend typecheck/build, 전체 unit suite | PASS: 199 suites / 2,867 tests; 기존 opt-in 43 suites / 47 tests 제외 |
| 실제 Binance 공개 WS smoke + 실제 Redis/app WS smoke | PASS: opt-in 2 tests 별도 실행 |
| production web export, Preview 플래그 true에서도 fixture marker 제거 | PASS |
| Chromium 국내주식/crypto 단위·소수·긴 숫자·작은 화면·Preview 12 시나리오 | PASS |
| 실제 Binance → processor → Redis → app WS → shared manager → hook → 카드 | PASS: BTC 10+10, 최초 timeout 후 복구, stale/복구, 앱 WS 재연결·재구독 |
| Chromium 시각 +20초 / -20초 | PASS: 각각 정상 스트림 6초 이상 false stale 없음; 수신 중단 시 stale, 재수신 시 해제 |
| PostgreSQL KRX 통합 / candle release fixture clean-tree 검사 | NOT_RUN |

실시간 브라우저 smoke는 실제 Binance/Redis/gateway/shared manager/hook/카드를 사용하되,
인증·asset DB 조회와 상세/차트 데이터는 로컬 harness로 대체했다. 운영 전체 서버나
PostgreSQL을 사용한 E2E 검증은 아니다. 실행한 검사에는 신규 실패가 없었으며, 알려진
KRX `MARKET_CLOSED` 및 candle fixture clean-working-tree 문제는 이번에 재실행하지 않아
재현/해결을 주장하지 않는다. 테스트 삭제·skip 추가·금융 assertion 완화는 없다.

이번 변경 파일은 다음 7개뿐이다.

- [assetOrderBookPolicy.ts](../src/features/asset/assetOrderBookPolicy.ts): local freshness와 10초 상수.
- [useAssetOrderBook.ts](../src/features/asset/useAssetOrderBook.ts): ACK 대기·상태 우선순위·기존 타이머 재사용.
- [assetOrderBookPolicy.test.ts](../src/features/asset/assetOrderBookPolicy.test.ts): 5초 경계·clock skew.
- [useAssetOrderBook.test.ts](../src/features/asset/useAssetOrderBook.test.ts): timeout·복구·격리·정리·오류 테스트.
- [orderBook.test.ts](../src/features/asset/orderBook.test.ts): 주문 UI 비침범·production fallback 차단 회귀.
- [이 문서](domestic-order-book.md): 정책·DB 조사·검증 결과.
- [Backend 계약 문서](../../backend/docs/order-book-api-contract.md): Frontend freshness 설명 갱신.

전체 diff 검토 및 `git diff --check` 통과. Backend 실행 코드, Binance/KIS Provider,
Redis, shared socket, ticker/candle freshness helper, 주문/체결, DB/Prisma/migration,
CurrencyCode, 카드 레이아웃 및 한국주식 Preview 구현은 변경하지 않았다.
