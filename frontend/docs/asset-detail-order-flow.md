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
