**작업 A — 마켓 종목 상세/거래 화면 개편 결과**

> 후속 작업 B에서 하단 단일 포지션을 계좌별 보유종목/필터로 교체하고 주식 상태 badge를 pair 옆으로 이동했다. 현재 구현과 검증은 [작업 B 보고](trading-screen-task-b.md)를 참고한다. 아래는 작업 A 당시 기록이다.

2026-09-19. 구현과 검증은 frontend 범위에서 수행했다. Web 화면 검증은 실제 React Native Web 컴포넌트와 React Navigation을 Chromium에서 실행하되, API·시세 입력을 테스트 데이터로 대체했다. 운영 서버 주문이나 실제 Binance/KIS 연결 성공을 의미하지 않는다.

1. **기존 구조 조사**: AssetDetailScreen이 상세 REST, ticker, 계좌별 position, candle REST/live, timeframe, chart, orderbook과 주문 진입 버튼을 함께 소유했다. OrderScreen에는 수량·지정가 검증, 잔액/보유량, 매수 quote→create, 매도 견적 확인→create, 만료/재견적, 멱등키, 계좌 바인딩과 성공 sheet가 있었다. 기존 displayPricePolicy, ticker/depth/candle hook, 정규화, mapper, account binding, quotedAction, successState, invalidation, 검색/navigation 및 테스트를 확인했다.

2. **최종 컴포넌트 구조**: AssetDetailScreen → 종목별로 새로 마운트하는 AssetTradingScreen → 상단 pair/상태/등락률/도구 + 왼쪽 OrderPanel/OrderForm + 오른쪽 AssetOrderLadder 또는 주식 현재가 + 기존 내 포지션. 전용 AssetChartScreen은 RootNavigator의 별도 화면이다.

3. **주문 로직 재사용**: 기존 OrderScreen의 주문 구현을 OrderPanel.tsx로 이동했다. OrderPanel은 매수/매도 선택을, OrderForm은 기존 주문 상태와 처리를 소유한다. OrderScreen은 키보드/스크롤과 route accountId를 전달하는 wrapper다. AssetDetail에서도 같은 OrderPanel을 사용한다. 수량·지정가 검증, BUY_FEE_BUFFER, 잔액과 수량 비율 계산, API wrapper, quotedAction, 성공 sheet 및 invalidation은 동일한 구현을 사용한다. LIMIT_ORDER_ENABLED를 유지한다.

4. **계좌 안전성**: 선택 계좌 변경 시 inline panel을 새로 마운트하고, 종목/계좌/side 변경 시 OrderForm을 새로 마운트한다. 입력, quote, 멱등키, pending UI, 성공 상태가 이전 form과 공유되지 않는다. resolveAccountBinding/shouldResetBoundFlow와 기존 epoch 검사를 유지했다. 매도 응답에도 epoch/마운트 여부 검사를 추가했고, 입력 변경 후 원래 값으로 돌아와도 이전 견적을 무시하도록 revision을 검사한다. 이미 전송된 create가 완료되면 원래 계좌의 cache를 갱신하되 새 form에는 성공을 표시하지 않는다. 빠른 연속 create도 동기 lock으로 차단한다. 매도 수량이 실제 보유량을 초과하는 경우 실행을 막는다. 기존 단독 OrderScreen은 route 계좌를 고정하고 계좌 변경 시 돌아가기를 안내한다.

5. **헤더**: Binance 종목은 BNB / USD처럼 표시하고 provider raw symbol을 별도 줄로 노출하지 않는다. 주식은 기존 이름 표시 정책과 / KRW를 사용한다. 국내주식 상태는 장중/장마감/상태 확인 불가 badge로 표시한다. crypto의 always_open badge, raw 상태·거래 상태·결제 통화 설명·Wallet 설명 줄을 제거했다. 등락률은 기존 canonical 값과 formatter를 사용하며 null은 ‘등락률 -’로 표시한다.

6. **종목 변경**: 기존 MarketSearch에 returnToAsset 인자를 전달한다. 선택 시 popTo('AssetDetail', { assetId })로 기존 상세 화면을 갱신하고 검색 화면을 닫는다. 검색 API를 추가하지 않았고, 반복 선택으로 AssetDetail이 누적되지 않는다. 종목별 key로 이전 ticker, 입력, quote, KRW 상태의 혼입을 방지한다.

7. **KRW toggle**: AssetTradingScreen의 로컬 상태만 변경한다. selectDisplayPrice가 반환한 같은 기준의 priceKrw를 오른쪽 현재가에 사용한다. 주문 패널, API body, 통화 enum, 호가, candle에는 toggle 상태를 전달하지 않는다. 환산 불가 시 버튼을 비활성화하며, 활성화 중 환산값이 사라지면 ‘환산 불가’를 표시하고 원래 통화로 돌아갈 수 있다. KRW 자산에는 버튼이 없다.

8. **암호화폐 호가**: 기존 useAssetOrderBook/shared socket 및 normalizeOrderBook/formatOrderBookDecimal을 재사용한다. AssetOrderLadder는 매도 10→1, canonical 현재가, 매수 1→10을 표시하는 읽기 전용 컴포넌트다. row 가격은 USDT, 수량은 provider의 기초자산 단위를 유지한다. 현재가를 midpoint로 계산하지 않는다. 긴 숫자·확대 글꼴은 호가 영역의 가로 스크롤로 전체 값을 확인할 수 있다. loading/stale/error 안내와 10+10 데이터 계약을 유지한다.

9. **국내주식 오른쪽 영역**: 2열 구조를 유지하고 현재가를 중앙에 표시한다. orderBookPreview를 거래 화면에서 사용하지 않으므로 개발 preview/long flag가 켜져도 가짜 호가가 나오지 않는다. 장마감 여부를 숨겨 주문 허용으로 간주하지 않으며, 기존 계좌/입력 검사와 서버 quote 최종 판정을 유지한다.

10. **차트 route**: RootNavigator에 AssetChart를 fullScreenModal로 등록했다. MarketStack 밖에 있어 하단 탭 없이 콘텐츠 영역을 사용한다. 뒤로가기, 종목 pair, 원래 통화의 현재가, 기존 ChartTimeframeSelector, CandlestickChart 및 최소 상태 안내만 표시한다. 사용 가능한 높이를 측정하여 기존 chart의 height prop에 전달한다.

11. **메인에서 제거한 candle 작업**: getAssetCandles query, useAssetCandle, selectedTimeframe, mergeAssetCandleSnapshot, inline CandlestickChart를 전용 차트 화면으로 이동했다. 차트의 REST/live는 화면 focus 시에만 활성화한다. 기존 query key, timeframe, precision, live overlay, stale fallback, reconnect/resync REST 재조회와 shared WebSocket을 유지한다. 다른 종목/interval의 snapshot은 overlay하지 않는다.

12. **변경 파일**: 아래 전체 목록 참조. 새 엔진/상태관리 라이브러리/의존성을 추가하지 않았다. package.json은 새 구현 파일을 기존 lint gate에 포함하도록 변경했고 package-lock.json은 변경하지 않았다. CTAButton에는 실행 버튼의 접근 가능한 label, button role, disabled/busy 상태를 추가했다. 기존 테스트의 검사 대상은 이동한 구현으로 옮기고 이전 UI 계약은 새 요구사항에 맞게 수정했다.

13. **BNB/BTC/XRP Web UI — PASS**: / USD, raw symbol/always_open/Wallet 설명 제거, USD↔KRW toggle, 호가 불변, 10+10 rows, 큰 USD 가격, 작은 crypto 가격과 수량을 확인했다. 가격/수량 입력 및 전체 숫자 표시도 검사했다. 표본에는 매우 큰 호가 수량과 0.000000000000000001 수량을 포함했다. 테스트 데이터 기반 UI 검증이다.

14. **Samsung Electronics/Kia Web UI — PASS**: 긴 이름의 pair, 큰 KRW 가격, 장마감 badge, KRW toggle 부재, 호가 부재, 중앙 현재가를 확인했다. 장중/unknown 상태 라벨은 코드의 표시 정책을 따른다. 실제 KRX 세션 전환과 KIS 연결은 이 작업에서 실서버로 검증하지 않았다.

15. **모바일 폭/텍스트 — PASS(Web)**: 320/360/390/430px × 글꼴 배율 1/1.5/2 × 5종목, 총 60개 조합. 두 column 분리, viewport 가로 넘침, 글자 영역 침범, KRW 전환과 긴 입력/preview를 검사했다. 글꼴 배율은 RN Web Text/TextInput 크기와 useWindowDimensions.fontScale을 함께 조정하는 시험 방식이다. 입력값은 native caret scrolling을 유지하며, 칸보다 긴 값은 아래에 raw value 전체를 줄바꿈해 표시한다. 숫자를 반올림하거나 입력 문자열을 잘라 저장하지 않는다. 캡처한 화면도 직접 확인했다.

16. **키보드**: SafeAreaView, header 높이를 반영한 KeyboardAvoidingView, keyboardShouldPersistTaps='handled' 및 세로 ScrollView를 사용한다. Web에서 360×400으로 viewport를 줄인 상태의 입력/주문 버튼 접근과 column 분리를 확인했다 — PASS. 실제 Android/iOS 소프트 키보드, 기기 회전, IME 조합 — NOT_RUN. 작은 viewport 시험을 실제 키보드 시험으로 간주하지 않는다.

17. **주문 회귀 — PASS(자동 테스트)**: 새 inlineTrading.test.ts의 31개 사례에서 일반/시즌 × 매수/매도 × 시장가/지정가, quote/create payload, KRW toggle과 주문 통화 분리, quote expiry/재견적/멱등 충돌, 불확실한 응답 재시도의 동일 quote/key, 연속 클릭, 늦은 quote/create, 계좌 A→B→A, 입력 변경 후 복귀, 보유량 비율/초과, 정지 계좌, success sheet와 원래 계좌 invalidation을 검사했다. 기존 주문 mapper/limit/quotedAction/account binding/invalidation/Wallet/Position 테스트도 통과했다. 실서버 주문 생성은 NOT_RUN.

18. **차트/시세 회귀 — PASS(자동 테스트 및 Web UI)**: 기존 7개 timeframe의 query key/interval/viewport 연결, chart renderer·gesture·precision, live merge, stale와 resync, ticker/depth/shared socket 관련 테스트가 통과했다. Web에서 실제 navigation의 차트 진입/시간봉 선택/닫힘/뒤로가기를 확인했다. 844px viewport에서 차트가 600px 이상을 차지함을 검사했다. 실제 거래소 live feed/reconnect 종단 검증은 NOT_RUN.

19. **정적 검사/export**: 아래 명령 모두 PASS. 전체 npm test 결과는 79개 테스트 파일 통과, 실패 0으로 보고된다. 이 수치를 개별 assertion 수로 해석하지 않는다. Android export는 Hermes bundle 생성 수준이며 APK build/설치 검증은 아니다.

20. **실제 실행 여부**: Chromium에서 실제 화면과 navigation을 실행하고 캡처를 확인했다 — PASS(테스트 데이터). Android/iOS 실기기·에뮬레이터 실행 — NOT_RUN. production Web export와 Android export — PASS. 브라우저 fixture와 번들은 /tmp에만 두어 앱의 실제 데이터 경로에 포함하지 않았다.

21. **diff 검토**: 전체 변경 및 이동 전후 주문 구현을 비교했다. 변경은 frontend 안에 한정된다. Backend/Prisma/schema/migration, API /api/v1 계약, CurrencyCode, Wallet ledger, 체결/예약/포지션·평가 정책은 변경하지 않았다. quote/create는 공통 OrderPanel에만 존재한다. 메인 화면에 candle fetch/subscription이나 주식 fixture 호출이 남지 않았고 KRW 상태가 주문/차트로 전달되지 않는다. git diff --check 통과. Backend CI는 실행하지 않았으며 기존 KRX 날짜/fixture 관련 실패를 이번 작업의 통과나 실패로 판정하지 않았다.

22. **작업 B로 남긴 항목**: 전체 보유종목/현재 종목 목록 재설계, 보유종목 필터, Open Orders 목록. 이번에는 기존 ‘내 포지션’의 내용과 DTO를 유지하고 거래 영역 아래로 배치했다.

| 검증 명령 (frontend 디렉터리) | 결과 |
| --- | --- |
| npm run check | PASS — gated lint, guide lint, typecheck, 전체 tests |
| npm run export:web | PASS — frontend/dist |
| npx expo export --platform android --output-dir /tmp/trading-task-a-android | PASS — Hermes bundle |
| git diff --check (repository root) | PASS |

브라우저 검증 스크립트: `/tmp/trading-task-a-browser/smoke.cjs`. DOM 검사 결과: `/tmp/trading-task-a-browser/results.json`. 실행 로그: `/tmp/trading-task-a-browser/smoke.log`. 재현 시 스크립트가 참조하는 해당 /tmp fixture·번들 및 기존 Playwright/Chromium 환경이 필요하다.

검토한 화면 예시: [BNB 기본 화면](/tmp/trading-task-a-browser/bnb-390-default.png), [좁은 화면의 긴 입력값](/tmp/trading-task-a-browser/bnb-320-1.png), [Kia 현재가](/tmp/trading-task-a-browser/kia-390-default.png), [전체화면 차트](/tmp/trading-task-a-browser/chart.png).

**전체 변경 파일**

- `frontend/docs/trading-screen-task-a.md`
- `frontend/package.json`
- `frontend/src/app/navigation/MarketStack.tsx`
- `frontend/src/app/navigation/RootNavigator.tsx`
- `frontend/src/app/navigation/types.ts`
- `frontend/src/components/charts/ChartTimeframeSelector.test.ts`
- `frontend/src/components/charts/candlestickChartControls.test.ts`
- `frontend/src/components/common/CTAButton.tsx`
- `frontend/src/components/common/pressFeedback.test.ts`
- `frontend/src/components/states/ScreenErrorBoundary.test.ts`
- `frontend/src/components/tradingAccount/accountLayout.test.ts`
- `frontend/src/features/asset/AssetOrderLadder.test.ts`
- `frontend/src/features/asset/AssetOrderLadder.tsx`
- `frontend/src/features/asset/assetDetailDisplay.test.ts`
- `frontend/src/features/asset/candleErrors.test.ts`
- `frontend/src/features/asset/orderBook.test.ts`
- `frontend/src/features/asset/tradingHeader.ts`
- `frontend/src/features/asset/tradingUiDisplay.test.ts`
- `frontend/src/features/auth/adminDiagnostics.test.ts`
- `frontend/src/features/order/orderDisplayContract.test.ts`
- `frontend/src/features/tradingAccount/legacyFinancialCalls.test.ts`
- `frontend/src/screens/asset/AssetChartScreen.tsx`
- `frontend/src/screens/asset/AssetDetailScreen.tsx`
- `frontend/src/screens/asset/inlineTrading.test.ts`
- `frontend/src/screens/market/MarketScreen.test.ts`
- `frontend/src/screens/market/MarketSearchScreen.tsx`
- `frontend/src/screens/order/OrderPanel.tsx`
- `frontend/src/screens/order/OrderScreen.tsx`
- `frontend/src/utils/displayPolicyContract.test.ts`
- `frontend/test/inlineTradingHarness.cjs`
- `frontend/test/tradingUiHarness.cjs`
