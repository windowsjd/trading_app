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

## 2026-10-17 — 주식 주문 카드 (A-2), Android 키보드

**Stock order card.** Domestic and US stocks show one card with two columns
at every width (no single-column fallback): the inputs on the left
(매수/매도, 주문방식, 가격, 수량 with 주, 수량 비율 in the side color, 25–100%,
주문 가능/최대 수량 or 매도 가능, 매수 주문/매도 주문) and 시세 (접기 folds the
price only), 내 보유 and 예상 주문 on the right. Crypto keeps its form beside the
live order book. 내 보유 and 예상 주문 belong to other components: AccountHoldings
(its read, 손절가/익절가 sheet and guide target) and the keyed order form (its
inputs and preview) draw them into named slots (`OrderAside`); the list under
the card then holds only the account's other holdings, so nothing shows twice.
A slot is emptied whenever its owner unmounts (side, method, asset, account).

예상 주문 reuses the existing preview/quote amounts. Its badge is the expected
handling under the known session, never a fill: 정규장 대기 (limit while
closed), 주문 불가 (market/LOC while closed), 체결 대기 (limit), 종가 대기 (LOC),
즉시 체결 (market); unknown market status shows none. A limit BUY total is 예상
예약금액; 주문 후 사용 가능 is the available cash minus that total (매도: 주문 후
매도 가능 in shares). Entered prices and quantities are shown exactly as sent.
The price contract carries only the change rate, so the card shows 전일대비
▲/▼ with the rate; no change amount or day low/high is derived.

**Keyboard on Android.** The app is edge to edge (`edgeToEdgeEnabled=true`,
`setDecorFitsSystemWindows(false)`), so `adjustResize` no longer shrinks the
window: the keyboard covers the screen. Screens pad with KeyboardAvoidingView on
both platforms (`behavior="padding"`, header height offset): order, FX, inquiry,
futures and market search. Login and sign-up scroll inside one that runs on
Android only while the keyboard is up (Android's hide event reports the visible
area's height, which would leave status/navigation bar padding behind on a
full-window screen). Bottom sheets and the order asset sheet rise by
`useKeyboardCover`: the event's height plus, on Android, the navigation bar
inset it leaves out. Nothing is measured against the keyboard's `screenY`:
Fabric's `measureInWindow` is offset by the status bar on Android, `screenY` is
not. Device checks (3-button/gesture navigation, iOS) remain to be done.

**Beginner guide targets (stock quests).** 금액과 수수료 points at the card's fee
and total rows (`order-summary-amounts`), 보유종목과 수익률 at the 내 보유
figures (`order-holding-figures`): small enough for the guide card to sit beside
them at 320px with 2x text.

## 2026-10-20 — device check for the bottom bar

The bar's code is unchanged: no defect was found in `8 + insets.bottom` (the
root provider's `navigationBars()` inset under edge-to-edge), and `content`
(`flex: 1`, `minHeight: 0`) cannot push the bar down. What was missing is a way
to tell which build a device runs (every preview APK is 1.0 / 1) and to measure
the bar against the system navigation bar on the device:

- EAS builds are stamped (`app.config.js` → `extra.build`): MY › 설정 › 앱 정보
  shows `빌드 <commit> · <profile>`; anything else shows `개발 빌드`.
- With the screen open on a USB-debugging device:
  `node scripts/android-layout-check.cjs --adb <adb or adb.exe> --screenshot out.png`
  prints the navigation bar frame (`dumpsys window`), each action's clickable
  bounds (`uiautomator`), the gap in px/dp, and — from the bar's padding under
  the actions — the bottom inset the app applied, with a diagnosis (clear /
  no inset / inset smaller than the bar / screen past the display). Exit 0
  clear, 1 overlap, 2 nothing to compare. Run it in 3-button and gesture mode.

Android native verification is still NOT_RUN (no device or emulator here).
