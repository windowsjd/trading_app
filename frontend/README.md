# Frontend (Expo React Native)

App code for the virtual trading app. Package manager is **npm**
(`package-lock.json` is the lockfile). API base path stays `/api/v1`.

## Error presentation contract

New authenticated error surfaces pass the original error to
`ErrorState error={error}` (full page) or `ErrorNotice error={error}` (inline).
Both use the public error mapper and the `/me`-gated AdminDiagnosticPanel.
Layout remains owned by the screen. Optional `message` overrides must be fixed
reviewed product copy, never exception text. Keep each error on its own surface;
there is no global last-error store. Pre-auth screens only use safe public copy.
The dedicated CI source gate checks changed files against the PR/push base for
obvious bypasses: ErrorState/ErrorNotice missing the original error, direct raw
error/server fields in JSX, directly storing only getApiErrorDisplayMessage's
result, and pre-auth admin panels. Unit tests run small in-memory gate fixtures;
they do not repeat the repository source audit.

These standard components provide role-gated presentation when given the original
error. The gate does not prove that every React Query isError branch or arbitrary
helper/UI pattern uses them. Screen tests and review cover that gap. Existing P1
Home partial, Holdings/Equity, Wallet, Transfer, Cancel, History, Ranking/Records,
Friends/Season/Settings coverage remains separate migration work. Backend runtime
enrichment/triage policy is canonical in `backend/README.md`.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test, file concurrency 1 (no Jest)
npx expo export --platform web       # bundle check
npx expo export --platform android   # bundle check
```

Tests run under Node's type-stripping test runner, so test-reachable modules
must be free of React Native imports and their relative imports need explicit
`.ts` extensions.

Renderer assertions compare small values: use
`assert.equal(node === undefined, true)` for absence and booleans/lengths/props
for other checks. Do not give `ReactTestInstance`, Fiber or arrays of renderer
nodes directly to equality/deep-equality assertions: a failure can recursively
format the renderer graph and exhaust memory. Keep the actual condition and
failure visible; do not suppress assertion messages or skip the test. Primitive
and small DTO comparisons keep their normal assertions.

On shared WSL hosts, run tests/builds inside a verified cgroup v2/systemd unit:
bound total descendant memory, set swap to zero, bound tasks and runtime, kill
the whole unit on stop, and monitor it from outside that cgroup. Start with one
test file at a time. Node heap limits supplement this containment. Check actual
`memory.max`, `memory.swap.max`, `pids.max` and child membership before release;
watch memory/oom events and stop before the host is pressured. Do not overlap
heavy frontend/backend checks or rerun a memory failure without investigation.
Disable core files where supported and inspect `kernel.core_pattern`: a piped
WSL handler can ignore `ulimit -c 0`. A zero inherited `coredump_filter` prevents
large mapped-memory dumps; inspect disk headroom and the handler separately.
Use workload-specific budgets (a one-second renderer test and PostgreSQL plus
Jest need different limits). Unsafe environments leave validation incomplete.

Press feedback, native stack/root/tab policy, Reduced Motion, browser timing
evidence and remaining device checks are recorded in
[the motion handover](docs/pressed-feedback.md).

## Display preferences

`AppearanceProvider` stores appearance and financial colors separately on the device.
Financial colors default to **Red/Blue** (rise/buy/up candle red, fall/sell/down candle blue).
**Green/Red** uses green for rise/buy/up and red for fall/sell/down.
Settings applies a preset immediately; AsyncStorage restores it across reload and logout/login.
Use `financial` tokens with `theme/native`; SVG renderers use `useAppearance().financialColors`.
Order-book accents and performance/change text follow the same roles. Cashflow credit/debit,
error/warning/success, diagnostics, navigation and brand colors are independent.
No financial calculation, API preference or server synchronization is involved.

## Trading accounts

Every current financial screen and mutation is scoped to ONE trading account,
named in the request path. Which screen reads which account, how a mutation flow
is bound to the account it started on, what a logout clears and why, and the
targeted cache-invalidation rules are all in
`docs/trading-account-switching.md`. Read it before touching a financial screen:
"the selected account" and "the account this flow is about" are deliberately
different things, and conflating them is how a season account's quote ends up
creating an order in a general account.

Current implementation status:

- season + general accounts: portfolio, equity, wallets, ledger, positions,
  orders, order cancel, FX — all account-scoped;
- general-mode trading and FX use the shared account-scoped backend primitives;
- ad rewards have client wrappers and cache invalidation but no screen yet, and
  no provider adapter exists (disabled by default).

## Crypto trading and protection

Market → Crypto exposes Spot/Futures, defaulting to Spot so the existing Spot
detail/trading route remains the normal entry. A Futures instrument selection
pins account and instrument in MarketStack. Both Home modes remove the Futures
entry card; total assets, signed UPNL, returns and settlement still include
Futures. There is no new Futures root tab or substitute Home card.

Flat Futures positions offer Market/Limit entry, Long/Short, Cross/Isolated and
integer leverage 1–100. Limit creates a pending reservation, not a filled
Position. Optional attached TP/SL uses the existing editor; server capabilities
govern creation while disabled controls explain availability. Existing TP/SL
panels and history remain visible when paused. Uncertain requests reuse the
original idempotency key; account/session changes suppress old callbacks/results
and clear prior-session intent. See the backend
[entry contract](../backend/docs/futures-limit-entry-contract.md) for settlement.

Asset holdings start at **현재 종목**; **전체 보유** retains the full list. Each
Spot card opens the existing account/asset/Position-bound TP/SL panel; live
protection opens management instead of duplicate registration. **대기 목록**
separates **지정가** (Spot BUY/SELL and Futures Long/Short entries) from **TP/SL**
(active groups and attached HOLDING). Conditional Limit children are shown through
their protection group once; terminal history stays in the history view. Shared
account query keys ensure fills/cancels refresh the correct financial views.
Pending protection labels follow the per-domain server capability, including
Futures-only DISABLED mode; viewing existing protection and permitted cancellation
remain available.

## Realtime prices

Shared order book UI, Binance realtime depth, and domestic development preview are described
in [domestic-order-book.md](docs/domestic-order-book.md). Release builds exclude
the fixtures; crypto detail uses real Binance snapshots without fixture fallback.

- One shared authenticated WebSocket per app session
  (`services/ws/realtimeSocketManager.ts`). Screens register reference-counted
  `asset_ticker` / `asset_candle` / `asset_order_book` subscriptions; nobody opens a second socket.
- `features/asset/assetTickerPolicy.ts` is the single accept/stale policy for
  both the market list and the detail screen: duplicate snapshot ids are
  ignored, older event times never overwrite newer ones, and staleness is
  judged from the ticker's own event time (`isTickerStaleAt`, 60s threshold).
  `features/asset/useStaleRecheck.ts` re-judges it every 5s while a screen
  holds a ticker and the app is foregrounded, so a feed that simply stops still
  turns stale.
- `features/asset/displayPricePolicy.ts` picks ONE basis for the detail
  screen's whole price block (realtime ticker or REST snapshot). REST and
  realtime metadata are never mixed — a ticker whose KRW is unavailable shows
  KRW unavailable rather than borrowing the older REST KRW, and a ticker
  without a change rate shows none rather than the older REST one. The screen
  renders `displayPrice.changeRate` directly; there is no second selector.
- The market list passes `item` (REST baseline) and `ticker` as separate props
  to `MarketAssetRow`, which merges them itself; a tick therefore only changes
  that row's props identity and `React.memo` skips the others.
- Unit prices use `formatAssetPrice(value, currency, displayPriceDecimals)`
  with the backend-provided precision; wallet balances/order totals keep the
  currency's own formatting. Never hardcode per-symbol decimals here.

## Candlestick chart

`components/charts/` — pure viewport/layout/gesture-policy modules, one shared
SVG renderer, and thin per-platform gesture adapters
(`CandlestickGestures.native.tsx` / `.web.tsx`, resolved by platform
extension). Behaviour, constants and the reasoning are documented in
`backend/docs/candle-live-operations.md` ("Candlestick chart viewport").

Mobile: pinch to zoom, one-finger horizontal drag to pan, long press for the
crosshair (released by whichever recognizer sees the lift — including a hold
that never moved, or a finger that leaves the chart); vertical swipes still
scroll the detail screen. Web: drag to pan, hover for the crosshair, and the
mouse wheel over the chart zooms (shift/horizontal wheel pans instead). All
start/end events go through one gesture-lifecycle session, so a gesture reports
exactly one start and one end no matter how many recognizers finalize it.

There are NO zoom buttons and no candle-count UI — `visibleCount` is internal
viewport state that pinch/wheel drive. The only button is a small `최신`
overlay that returns to the latest 60 slots, and it appears only once the
viewport has moved. A wheel that arrives while a mouse drag is in progress is
swallowed (still `preventDefault`, but no zoom/pan) so only one gesture ever
writes the viewport; wheels work normally again after mouseup.

Chart height is responsive (`getCandlestickChartHeight`): ~52% of the window
(380–480) for phones and narrow web, ~60% (500–680) for tablets and wide web,
recomputed on rotation/resize. The layout class is not width alone — native
devices are judged by their SHORT side (`< 600` = phone, so a landscape 844×390
phone stays a phone), web by window width (`< 768` = narrow). Everything below
the chart is reached with the detail screen's existing vertical ScrollView.

The viewport counts SCREEN SLOTS (60 by default on every timeframe), not
candles: a timeframe with only 12 candles draws them at the normal width
against the right edge with empty slots on the left. Prices on the chart use
`displayPriceDecimals`, so pass it from the screen — see `formatChartPrice`.

Timeframe windows (`features/asset/chartTimeframes.ts`): `5m` uses
`prev_open`, `15m` uses `3d` (limit 288 — the market-open anchor gave stocks
barely a session and a half), `30m` and `1h` use `14d` (limit 672 / 336), `4h`
uses `30d` (limit 200), `1d`/`1w` use `1y`. The backend aggregates 15m–4h from its stored
5m feed (35-day retention); the limits are the crypto 24/7 upper bounds, so
stocks legitimately return fewer candles. While that stored baseline is still
being seeded the API answers `ASSET_CANDLES_BASELINE_NOT_READY` and the detail
screen shows "차트 데이터를 준비 중입니다." with the existing retry button.
Every OTHER candle failure now reads as a failure — `describeCandleError`
renders "차트를 불러오지 못했습니다." plus the backend error code (or the HTTP
status / a network hint), because rendering an outage as a loading skeleton
hid the reason from whoever was debugging it (`features/asset/candleErrors.ts`).

**Native rebuild required.** `react-native-gesture-handler` is a native module
(`npx expo install`) and `App.tsx` wraps the app in `GestureHandlerRootView`.
Rebuild the dev client (`npx expo run:android`, or a new EAS dev build) before
testing on a device; Expo web needs no extra setup. Reanimated/Worklets are NOT
used — all gesture callbacks run on the JS thread, and `babel.config.js` is the
plain Expo preset.
