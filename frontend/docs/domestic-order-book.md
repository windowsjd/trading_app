# 한국주식·암호화폐 공통 호가창 기반

실제 호가 API를 호출하지 않는 개발용 UI이다. 한국주식과 암호화폐가 하나의
`AssetOrderBook` 계약과 `AssetOrderBookCard`를 사용한다. KIS/코스콤/Binance 호가 연결,
주문 가격 결정, 체결·평가 로직, DB·Redis 변경은 포함하지 않는다.

## 현재 구조와 구현 선택

- `screens/asset/AssetDetailScreen.tsx`는 React Query로 종목 상세, 캔들,
  선택 계정의 포지션을 읽는다. 가격·캔들 쿼리는 계정과 무관한 공용 키이다.
- `useAssetTicker`와 `useAssetCandle`은 공용 WebSocket manager에 구독한다.
  기존 현재가 선택·시장 상태·캔들 병합 정책은 그대로 둔다.
- Backend `AssetOrderbookSnapshot` 및 `kis-rest-hoga.parser.ts`는 가격·잔량을
  매수/매도 각 1개씩 보관한다. 한국주식 파서는 `bidp1`/`askp1`을 읽는다.
  현재 종목 상세 API/프론트엔드에는 호가 연결이 없다.
- 별도로 가이드 화면에 교육용 호가창이 있다. 이 컴포넌트는 교육용 체결 상태와
  숫자형 가상 자산에 묶여 있어 재사용하지 않는다. 색상은 기존 가이드와 같은
  매도 파랑(`#315f9b`), 매수 빨강(`#a13e3b`)을 사용한다.
- 종목 상세의 흰 배경·밝은 카드, 16px 여백, 14px 모서리를 따른다.
  현재 해당 화면에는 다크 모드 테마 전환이 없다. 새 테마 체계는 추가하지 않았다.
- 기존 fixture는 테스트 또는 교육 콘텐츠용이며 서비스 호가용 mock 전환 패턴은
  없다. 기존 `__DEV__` 관례와 공개 boolean flag 파서를 조합해 별도 개발 경로를 만든다.

일반화 전에는 공통 normalization이 잔량·총 잔량을 정수로 제한했고, 카드가
수량에 `formatKrwDecimal`을 적용해 정수로 반올림했다. 단위·접근성 문구는 `주`로
고정되어 있었으며 Preview는 국내주식/KRW만 허용했다. 소수 잔량 지원에는 검증과
표시 양쪽 변경이 필요했다.

암호화폐 계약 조사 결과:

- Backend `binance-fixed-asset-universe.ts`와 종목 상세/시장 DTO의 `symbol`은
  `BTCUSDT`, `ETHUSDT` 형태이며 `market`은 `BINANCE`이다. `baseAsset`은 Backend의
  고정 종목 정의에는 있지만 Frontend 종목 DTO 필드로 제공되지는 않는다.
- 기존 Binance Spot `<BASE>USDT` 계약에서 base asset을 얻을 수 있으므로 별도의
  asset DTO 필드나 프론트엔드 종목별 매핑 테이블을 만들지 않는다. bare `BTC`,
  `BTCUSD`, 다른 market 등 모호한 입력으로 USDT를 추정하지 않는다.
- 현재 Binance USDT는 금융 시스템에서 USD equivalent다. `CurrencyCode`는
  KRW/USD 그대로이며 Wallet·FX·주문 결제·Portfolio·DB enum은 바뀌지 않는다.
- `displayPriceDecimals`는 Backend `PRICE_FILTER.tickSize`에서 얻어 기존
  `formatAssetPrice`에 전달된다. 이 helper는 금융 통화별 표시와 소수 자릿수 반올림을
  담당하므로 원시 호가 가격·잔량 표시에는 사용하지 않는다.
- 주문·Position·거래내역·Wallet ledger 수량은 `formatDisplayDecimal`로 끝의
  불필요한 0만 제거한다. 공통 호가도 이 정책을 재사용하며 정수부 구분자만 더한다.

## 데이터 계약과 연결 지점

`features/asset/orderBook.ts`의 `AssetOrderBook`:

```ts
{
  assetId: string;
  priceUnit: string;       // 원, USDT 등 시장의 가격 표시 단위
  quantityUnit: string;    // 주, BTC, ETH 등 수량 표시 단위
  marketLabel?: string;    // 선택적 제목: BTC / USDT
  asks: readonly { price: MoneyString; quantity: QuantityString }[];
  bids: readonly { price: MoneyString; quantity: QuantityString }[];
  totalAskQuantity?: QuantityString | null;
  totalBidQuantity?: QuantityString | null;
  capturedAt: IsoDateTimeString;
  effectiveAt?: IsoDateTimeString | null;
}
```

금액·잔량은 기존 DTO처럼 십진 문자열이다. 기존 호가의 `currency: CurrencyCode`를
호가 내부 표시 단위로 바꿨으며 금융용 `CurrencyCode`는 변경하지 않았다.
`marketLabel`은 선택적 표시 제목으로, UI가 종목 symbol이나 Provider 규칙을 해석하지
않도록 데이터 공급 측에서 기존 pair 정보로 구성한다. 별도 Provider 필드는 없다.
한국주식 fixture는 `원/주`, crypto fixture는 `USDT/<BASE>`를 전달한다.
원본 시각은 timezone을 포함한 ISO 문자열로 전달한다. 수집시각은 필수,
거래소 기준시각과 거래소 총 잔량은 선택이다. 수신 시각을 매 렌더링 때 갱신하거나
보이는 10개 잔량의 합계를 거래소 총 잔량으로 만들지 않는다.

`normalizeOrderBook`은 양수 가격과 0 이상의 소수 잔량을 가진 행을 취하고, Decimal 비교로
매도 오름차순·매수 내림차순 정렬 후 각 최대 10개를 반환한다. 입력은 변경하지
않는다. 0 가격 슬롯은 제외하고, 유효 가격의 0 잔량은 유지한다. 없는 단계를
가짜 가격·잔량으로 채우지 않는다. 동일 가격의 중복 제거·집계는 수행하지 않으며,
향후 adapter는 가격당 하나의 레벨로 구성된 snapshot을 공급해야 한다.
문자열 문법은 부호·지수·쉼표 없는 `digits[.digits]`이며 숫자형 입력은 받지 않는다.
한국주식의 정수 주식 수량 검증은 향후 한국주식 adapter 경계에서 수행할 수 있다.
총 잔량 역시 소수를 허용하며 원본 문자열의 정밀도를 그대로 유지한다.

코스콤 또는 Binance 연결 시 Provider 응답을 이 계약으로 변환하는 adapter를 데이터 계층에 두고,
종목 상세의 `getOrderBookPreview(asset)` 호출 지점에서 실제 snapshot을 전달한다.
API가 정해진 뒤 기존 React Query/공용 실시간 패턴에 맞게 연결하며 `/api/v1`을 유지한다.
현재는 endpoint, query key, 구독, provider registry를 미리 만들지 않는다.
`AssetOrderBookCard`에는 정규화 가능한 `book`만 전달하고 실데이터에서는 `isPreview`를
생략한다. 실패·최신성 정책은 실제 전달 계약이 정해질 때 연결하고 fixture로
fallback하지 않는다. UI에 Provider 필드나 주문 엔진 의존성은 없다.
향후 Binance `@depth10` 연결도 **Provider 응답 → 공통 `AssetOrderBook` snapshot →
종목 상세의 `AssetOrderBookCard book` prop** 경계에서 끝난다. 공급 측에서 assetId,
실제 base/quote 표시 단위, 가격·잔량 문자열, 수집/기준시각을 지정하면 된다.
이번 작업은 parser, 구독, WebSocket channel, 실시간 hook을 추가하지 않는다.

## 화면과 fixture 사용

`frontend/`에서 개발 서버를 실행한다.

```bash
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true npx expo start --web
# 긴 숫자 스트레스 테스트
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG=true npx expo start --web
```

한국주식(KRW) 또는 Binance Spot USDT pair 종목 상세의 차트 아래,
매수/매도 버튼 위에 같은 호가 카드가 나타난다. BTCUSDT는 `BTC / USDT`,
`가격 (USDT) · 잔량 (BTC)`, ETHUSDT는 `ETH / USDT`, `잔량 (ETH)`로 표시한다.
한국주식의 `가격 (원) · 잔량 (주)`는 유지한다. 새 Preview 플래그는 없다.
기존 앱에 로그인하고 종목 상세에 접근하는 절차는 동일하다. 이 플래그는 호가만
fixture로 표시하며, 기존 종목 정보·현재가·차트 API를 대체하지 않는다.
환경변수 변경 시 개발 서버를 재시작하고 앱을 새로고침한다.

호가는 정적인 레이아웃 예시이며 현재 선택 종목의 실제 시세와 무관하다.
카드에 항상 **개발용 예시 · 실제 시세가 아닙니다.**가 표시된다.
표 위에는 통화·수량 단위와 기준/수집시각(한국시간)이 표시된다.
매도는 10 → 1호가, 매수는 1 → 10호가 순서다. 최우선 행은 테두리로 구분한다.
부분/빈 호가는 실제 개수와 빈 상태를 표시한다. 행은 읽기 전용이며 주문 입력으로
연결되지 않는다.

`formatOrderBookDecimal`은 기존 `formatDisplayDecimal`로 소수 끝의 0을 정리하고,
정수부에 쉼표를 붙인다. 예: `0.00125000 → 0.00125`, `68420.10 → 68,420.1`.
유효한 소수 자리에는 제한·반올림이 없으며 Number/parseFloat를 사용하지 않는다.
가격도 공급된 호가의 모든 유효 자릿수를 유지한다. tick size 정합성은 실제
adapter 책임이며 기존 현재가/차트의 `displayPriceDecimals` 정책은 그대로다.
`formatKstDateTime`의 기존 분 단위 시각 표시를 사용하며, 원본 초·밀리초는 데이터에
유지한다. 숫자를 축약하거나 말줄임하지 않는다. 작은 화면·큰 글씨·긴 숫자가
표의 가용 폭을 넘으면 안내와 함께 **호가 표 내부만 가로 스크롤**한다.
전체 페이지의 세로 스크롤과 기존 차트 제스처는 유지된다.

fixture 위치: `features/asset/orderBook.fixture.ts`. 한국주식의 기존 기본/LONG 값은
동일하다. `createCryptoOrderBookFixture`는 매도/매수 각 10단계, 서로 다른 가격·잔량,
`0.003521`, `0.00125000`, `12.23456789`, `0.00000001`, 큰 수량과 0잔량을 포함한다.
crypto LONG 예제는 24자리 정수부 가격, 18자리 소수, 20자리 정수부 수량을 포함한다.
crypto 예제는 exchange total을 가정하지 않는다. 모든 crypto 종목은 같은 고정
레이아웃 예제에 해당 pair 단위를 붙이며, 종목별 실제 가격을 뜻하지 않는다.
새 snapshot 객체를 반환해 테스트 사이에 변경이 공유되지 않는다.

`orderBookPreview.ts`는 `__DEV__`와 명시적 활성화 플래그를 모두 요구한다.
release 빌드에서는 플래그가 true여도 null을 반환하며 카드가 표시되지 않는다.
fixture의 `require`를 양의 `__DEV__` 분기 안에 두어 production Metro 번들에서
fixture 모듈 자체도 제거되게 한다. mock은 API 응답이나 Query cache에 저장하지 않는다.

## 검증

```bash
npm run typecheck
npm run lint:accounts:check
npx eslint --no-fix --max-warnings=0 src/features/asset/orderBook.ts src/features/asset/orderBookPreview.ts src/features/asset/orderBook.fixture.ts src/features/asset/AssetOrderBookCard.tsx
npm test
# 상세 테스트 결과를 보고 싶을 때
node src/features/asset/orderBook.test.ts
node src/features/asset/AssetOrderBookCard.test.ts
# production에서도 플래그가 무시되는지 확인하는 번들
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG=true npm run export:web
```

추가 테스트는 정렬·10단계 제한·원본 불변성·긴 숫자 정밀도·유효성·총량·시각,
20개 UI 행과 잔량 짝, 0잔량/부분/빈 상태, 개발/production 플래그,
한국주식/crypto 범위, 기존 가격/차트/쿼리/계정 바인딩/매수·매도 경로를 검증한다.
Node 렌더 테스트는 native 실측 검증을 대체하지 않는다.

이번 변경 검증 결과:

- TypeScript, 계정 lint gate, 호가 소스의 check-only lint, 전체 프론트엔드 테스트
  75개 파일 통과. 호가 normalization/화면 통합 53개, 카드 렌더 5개가 통과했다.
- Headless Chromium에서 실제 종목 상세·차트·호가 컴포넌트에 테스트 조회 결과를
  주입해 한국주식과 BTC 기본 280/320/390px, LONG 320px 및 280px/글자 3배,
  양쪽 production/flag 없음, ETH/XRP 단위, 미국주식 미노출 등 17개 시나리오를 검증했다.
  기본 호가는 320px에서 가격과 잔량이 함께 보이며 가로 스크롤이 필요하지 않다.
- 20개 호가의 셀 내부 잘림·겹침, 카드가 화면 밖으로 나가지 않는지,
  가로 스크롤 끝에서 마지막 숫자 접근, 실제 캔들 도형, 매수/매도 경로를 확인했다.
  외부/API 요청은 없었다. 실계정/실제 API/Android·iOS 기기 검증은 수행하지 않았다.
- preview와 LONG 플래그를 모두 true로 한 Expo production 웹 export 통과.
  생성된 JS에서 한국주식/crypto fixture 시각·생성 함수가 없고 preview 조회 함수가 null을
  반환하는 것을 확인했다.

## 변경 파일

| 파일 (frontend 기준) | 변경 |
| --- | --- |
| `src/features/asset/orderBook.ts` | 표시 단위, 소수 잔량 정규화, 정확한 숫자 포맷 |
| `src/features/asset/AssetOrderBookCard.tsx` | 공통 단위·소수 표시·접근성 문구 |
| `src/features/asset/orderBook.fixture.ts` | crypto 기본/LONG 10단계 fixture 추가 |
| `src/features/asset/orderBookPreview.ts` | 기존 Binance asset symbol 기반 crypto Preview |
| `src/features/asset/orderBook.test.ts` | 정규화·개발 조건·소수·단위 전환·화면 회귀 테스트 |
| `src/features/asset/AssetOrderBookCard.test.ts` | 한국주식/crypto 카드 렌더 테스트 |
| `.env.example` | 기존 플래그의 crypto 적용 범위 설명 |
| `README.md` | 공통 호가 문서 안내 |
| `docs/domestic-order-book.md` | 일반화 조사 결과·계약·실행법·검증 기록 |

Backend 코드는 읽기 조사만 수행한다. Provider, Prisma/schema/migration,
현재가·캔들·시장 상태·KRX Calendar·등락률·주문·Position·Wallet·Portfolio·
시즌 정책·환율·Binance의 구현과 Backend 금융 테스트는 변경하지 않는다.
