# 한국주식·암호화폐 공통 호가창

`AssetOrderBook`과 `AssetOrderBookCard`는 Provider와 주문 처리에 독립된 표시 계층이다.
한국주식은 개발 Preview를 유지하며, Binance 암호화폐 상세 화면은 실제 10호가를 구독한다.
Backend 계약과 검증 기록은 [order-book-api-contract.md](../../backend/docs/order-book-api-contract.md)를 참고한다.

## 현재 데이터 흐름

```text
기존 Binance owner → 공통 depth parser/processor → Redis Pub/Sub
→ /api/v1/ws asset_order_book → RealtimeSocketManager
→ useAssetOrderBook → AssetOrderBookCard
```

- 기존 React Query의 종목 상세·차트·계정별 포지션 키와 현재가 선택은 그대로다.
- 활성 BINANCE/USD crypto 화면이 focus 상태일 때만 기존 shared socket으로 해당
  assetId를 구독한다. 화면 blur·종목 변경·unmount 시 reference count를 해제한다.
- transport 재연결 및 재구독은 기존 manager가 처리한다. 새 Frontend WebSocket은 없다.
- 호가는 Query cache나 주문·체결·평가 상태에 쓰지 않는다.
- 첫 snapshot 전에는 로딩, 이후 연결 복구·구독 오류·5초 초과 지연을 표시한다.
  서버 capturedAt과 클라이언트 수신 시각을 모두 고려해 오래 대기한 snapshot도 지연으로
  판정한다. 기존 foreground 재검사 helper를 250ms 간격으로 재사용한다.
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

```bash
# 한국주식 개발 Preview
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true npx expo start --web
# 긴 숫자 테스트
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG=true npx expo start --web
```

한국주식 상세의 차트 아래에 예시 카드가 나타나며 `개발용 예시 · 실제 시세가 아닙니다.`를
표시한다. 환경변수 변경 시 개발 서버를 재시작한다.

**암호화폐 상세는 이 플래그와 관계없이 실시간 경로를 사용한다.** 로딩·Provider 장애·
구독 오류 시 fixture로 fallback하지 않는다. crypto fixture와 `getOrderBookPreview`는
공통 카드의 개발 harness/렌더 테스트에서 계속 사용할 수 있다. 별도 플래그는 추가하지 않았다.
`__DEV__`의 양의 분기 안에 둔 require를 유지해 production bundle에서 fixture를 제거한다.

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
