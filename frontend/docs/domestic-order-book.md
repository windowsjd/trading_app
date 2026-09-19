# 한국주식 호가창 기반

실제 호가 API를 호출하지 않는 개발용 UI이다. KIS/코스콤 연결, 주문 가격 결정,
체결·평가 로직, DB·Redis 변경은 포함하지 않는다.

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

## 데이터 계약과 연결 지점

`features/asset/orderBook.ts`의 `AssetOrderBook`:

```ts
{
  assetId: string;
  currency: CurrencyCode;
  asks: readonly { price: MoneyString; quantity: QuantityString }[];
  bids: readonly { price: MoneyString; quantity: QuantityString }[];
  totalAskQuantity?: QuantityString | null;
  totalBidQuantity?: QuantityString | null;
  capturedAt: IsoDateTimeString;
  effectiveAt?: IsoDateTimeString | null;
}
```

금액·잔량은 기존 DTO처럼 십진 문자열이며, 한국주식 잔량은 0 이상의 정수 주식 수다.
원본 시각은 timezone을 포함한 ISO 문자열로 전달한다. 수집시각은 필수,
거래소 기준시각과 거래소 총 잔량은 선택이다. 수신 시각을 매 렌더링 때 갱신하거나
보이는 10개 잔량의 합계를 거래소 총 잔량으로 만들지 않는다.

`normalizeOrderBook`은 양수 가격과 정수 잔량을 가진 행을 취하고, Decimal 비교로
매도 오름차순·매수 내림차순 정렬 후 각 최대 10개를 반환한다. 입력은 변경하지
않는다. 0 가격 슬롯은 제외하고, 유효 가격의 0 잔량은 유지한다. 없는 단계를
가짜 가격·잔량으로 채우지 않는다. 동일 가격의 중복 제거·집계는 수행하지 않으며,
향후 adapter는 가격당 하나의 레벨로 구성된 snapshot을 공급해야 한다.

코스콤 연결 시 Provider 응답을 이 계약으로 변환하는 adapter를 데이터 계층에 두고,
종목 상세의 `getOrderBookPreview(asset)` 호출 지점에서 실제 snapshot을 전달한다.
API가 정해진 뒤 기존 React Query/공용 실시간 패턴에 맞게 연결하며 `/api/v1`을 유지한다.
현재는 endpoint, query key, 구독, provider registry를 미리 만들지 않는다.
`AssetOrderBookCard`에는 정규화 가능한 `book`만 전달하고 실데이터에서는 `isPreview`를
생략한다. 실패·최신성 정책은 실제 전달 계약이 정해질 때 연결하고 fixture로
fallback하지 않는다. UI에 Provider 필드나 주문 엔진 의존성은 없다.

## 화면과 fixture 사용

`frontend/`에서 개발 서버를 실행한다.

```bash
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true npx expo start --web
# 긴 숫자 스트레스 테스트
EXPO_PUBLIC_ORDER_BOOK_PREVIEW=true EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG=true npx expo start --web
```

한국주식(KRW) 종목 상세의 차트 아래, 매수/매도 버튼 위에 호가 카드가 나타난다.
기존 앱에 로그인하고 종목 상세에 접근하는 절차는 동일하다. 이 플래그는 호가만
fixture로 표시하며, 기존 종목 정보·현재가·차트 API를 대체하지 않는다.
환경변수 변경 시 개발 서버를 재시작하고 앱을 새로고침한다.

호가는 정적인 레이아웃 예시이며 현재 선택 종목의 실제 시세와 무관하다.
카드에 항상 **개발용 예시 · 실제 시세가 아닙니다.**가 표시된다.
표 위에는 통화·수량 단위와 기준/수집시각(한국시간)이 표시된다.
매도는 10 → 1호가, 매수는 1 → 10호가 순서다. 최우선 행은 테두리로 구분한다.
부분/빈 호가는 실제 개수와 빈 상태를 표시한다. 행은 읽기 전용이며 주문 입력으로
연결되지 않는다.

기존 정확한 문자열 포맷터 `formatKrwDecimal`로 원화 가격과 주식 수를 표시한다.
`formatKstDateTime`의 기존 분 단위 시각 표시를 사용하며, 원본 초·밀리초는 데이터에
유지한다. 숫자를 축약하거나 말줄임하지 않는다. 작은 화면·큰 글씨·긴 숫자가
표의 가용 폭을 넘으면 안내와 함께 **호가 표 내부만 가로 스크롤**한다.
전체 페이지의 세로 스크롤과 기존 차트 제스처는 유지된다.

fixture 위치: `features/asset/orderBook.fixture.ts`. 기본 예제는 매도/매수 10단계,
서로 다른 가격·잔량과 최대 10자리 잔량을 가진다. LONG 예제는 24자리 가격·총 잔량을
포함한다. 새 snapshot 객체를 반환해 테스트 사이에 변경이 공유되지 않는다.

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
한국주식 범위, 기존 가격/차트/쿼리/계정 바인딩/매수·매도 경로를 검증한다.
Node 렌더 테스트는 native 실측 검증을 대체하지 않는다.

이번 변경 검증 결과:

- TypeScript, 계정 lint gate, 새 소스의 check-only lint, 전체 프론트엔드 테스트
  75개 파일 통과. 추가 테스트는 normalization/화면 통합 16개, 카드 렌더 3개다.
- Headless Chromium에서 실제 종목 상세·차트·호가 컴포넌트에 테스트 조회 결과를
  주입해 8개 시나리오를 검증했다. 기본 280/320/390px, 긴 숫자 320px,
  280px/글자 3배, production, 미국주식, 암호화폐를 포함한다.
- 20개 호가의 셀 내부 잘림·겹침, 카드가 화면 밖으로 나가지 않는지,
  가로 스크롤 끝에서 마지막 숫자 접근, 실제 캔들 도형, 매수/매도 경로를 확인했다.
  외부/API 요청은 없었다. 실계정/실제 API/Android·iOS 기기 검증은 수행하지 않았다.
- preview와 LONG 플래그를 모두 true로 한 Expo production 웹 export 통과.
  생성된 JS에서 fixture 시각·생성 함수가 없고 preview 조회 함수가 null을
  반환하는 것을 확인했다.

## 변경 파일

| 파일 (frontend 기준) | 변경 |
| --- | --- |
| `src/features/asset/orderBook.ts` | Provider 독립 계약과 정렬·표시 정규화 |
| `src/features/asset/AssetOrderBookCard.tsx` | 읽기 전용 호가 카드 |
| `src/features/asset/orderBook.fixture.ts` | 기본/긴 숫자 10단계 fixture |
| `src/features/asset/orderBookPreview.ts` | 한국주식 개발 모드 전용 진입점 |
| `src/features/asset/orderBook.test.ts` | 정규화·개발 조건·화면 회귀 테스트 |
| `src/features/asset/AssetOrderBookCard.test.ts` | 실제 카드 렌더 테스트 |
| `src/screens/asset/AssetDetailScreen.tsx` | 차트 아래에 독립 카드 연결 |
| `test/tradingUiHarness.cjs` | 새 카드 경계 mock과 실제 preview 모듈 로딩 |
| `.env.example` | 개발 플래그 예제 |
| `README.md` | 상세 문서 링크 |
| `docs/domestic-order-book.md` | 조사 결과·계약·실행법·검증 기록 |

Backend 코드는 읽기 조사만 수행한다. Provider, Prisma/schema/migration,
현재가·캔들·시장 상태·KRX Calendar·등락률·주문·Position·Wallet·Portfolio·
시즌 정책·환율·Binance의 구현과 Backend 금융 테스트는 변경하지 않는다.
