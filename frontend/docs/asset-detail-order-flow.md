# 종목 상세와 주문 화면

현재 마켓 흐름은 `Market` → `AssetDetail` → `Order`다. 마켓에서 종목을 선택하면 상세 화면에 기존 종목명/pair 정책의 제목, 기존 `selectDisplayPrice` 현재가와 전일대비, `CandlestickChart`, `ChartTimeframeSelector`가 표시된다. 하단 판매하기/구매하기는 각각 빨강/초록이고 선택된 계정이 있을 때만 주문 화면을 연다. 계정이 없으면 안내와 비활성 버튼을 표시한다.

`AssetDetailScreen`과 전체화면 `AssetChartScreen`은 `AssetMarketChart`의 같은 종목 상세 쿼리, candle REST/live 병합, timeframe, 오류/관리자 진단, viewport reset 경로를 사용한다. 종목별 key와 assetId/interval 검사로 이전 종목·시간봉의 ticker/live candle을 표시하지 않는다. 실시간 구독은 기존 앱의 shared WebSocket manager를 사용한다.

`OrderScreen`은 기존 상세 화면의 거래 구성인 `OrderPanel`, KRW 현재가 전환, 실시간 호가/주식 현재가, `AccountHoldings`(대기 주문 포함), 관리자 진단을 담는다. 상세 CTA는 `Order` route에 현재 `assetId`, 선택된 `accountId`, 초기 `side`를 명시한다. 주문 화면은 그 route의 계정 ID를 보유·주문에 사용하고 `OrderPanel`의 계정 binding이 선택 계정 변경을 검사한다. 검색에서 종목을 바꾸면 기존 `MarketSearch`의 `popTo('AssetDetail')` 흐름으로 돌아간다.

이 분리는 화면 역할만 바꾼다. 가격·캔들·호가의 source와 표시 정책, 시장가/지정가, Quote/Create, Crypto BUY amount, Stock CLOSED 지정가, 예약금·대기 주문 및 체결 정책은 기존 구현을 사용한다. Backend API/DB 계약은 변경하지 않는다.


## Terminal partial market result (B2-1)

The additive server `order.marketExecution` determines partial/full results.
The result sheet says “일부 체결되었습니다” and shows requested, executed and
immediately auto-canceled quantities, actual gross/fee/net and average price.
Crypto amount BUY shows requested principal and unused principal, not an
invented unfilled quantity. VWAP retains its fractional digits because an
average need not be on the display tick. History uses
“부분체결 · 잔량 자동취소”; it neither polls nor offers cancel for the remainder.
The machine reason is mapped to Korean text, never shown raw. Existing account
scope, invalidation and stored result replay are unchanged. Old/full results
and submitted/canceled limits keep their existing behavior.

The result body scrolls with a viewport height bound while actions remain
outside it. Browser verification is `test/browser/marketExecutionBrowser.cjs`:
320/360/390/430px, default/1.5 font scale, quantity/amount/large-number partials,
full fills, submitted limits and the real account history screen. This is RN
Web verification; device accessibility/gesture checks remain separate.

Production partial fills will not occur until a separately validated execution
adapter is activated on the server; the existing display book is not one.

## 2026-10-15 — detail bottom bar inset, SELL 손절가/익절가 설정

**Detail bottom bar.** `MainTabs` hides the tab bar while `AssetDetail` is
focused, so 판매하기/구매하기 is the only bottom-anchored bar in the app that
must clear the system navigation area itself (every other screen ends at the
tab bar, which pads itself with `useSafeAreaInsets().bottom`). It relied on
the native `SafeAreaView` bottom edge (Fabric state update inside an animated
native-stack push), which left the buttons under Android's navigation bar.
The bar now pads itself by `8 + insets.bottom` from the same insets context as
the tab bar; the screen's `SafeAreaView` keeps only the left/right edges, so
the inset is applied exactly once. Real-device checks (Android gesture /
3-button, iOS home indicator) are still to be done; harness and RN-Web checks
cannot reproduce a non-zero native inset.

**TP/SL.** The holdings card no longer has the TP/SL 설정·관리 button or its
inline OCO editor. New spot TP/SL is the SELL 주문방식 「손절가/익절가 설정」
(`SellProtectionForm`): 익절가 설정 then 손절가 설정, each optional (at least
one), a trigger price and a whole-percent share of today's holding (slider and
25/50/75/100%) shown as the fixed order quantity (6-decimal floor), market
execution only, and the 확인 button in the SELL color. Live settings of the
same family and their remaining room come from the order form's live
SELL-settings list; the server enforces the per-family total, duplicate price
and OCO exclusion again. Existing OCO groups stay listed/cancelable under
대기 목록 › TP/SL, with ended groups behind 종료된 TP/SL 이력 보기.
QUEST 04 guides through this method (order-type → `order-method-protection`
→ `protection-editor` → `protection-submit`) on the SELL order screen.
Browser checks: `test/browser/sellOrderBrowser.cjs` (224 screens at
320–430px, light/dark, 1x/2x) and `beginnerBrowser.cjs` with
`FULL_QUEST_BROWSER=1`.
