# Frontend (Expo React Native)

App code for the virtual trading app. Package manager is **npm**
(`package-lock.json` is the lockfile). API base path stays `/api/v1`.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test over src/**/*.test.ts (no Jest)
npx expo export --platform web       # bundle check
npx expo export --platform android   # bundle check
```

Tests run under Node's type-stripping test runner, so test-reachable modules
must be free of React Native imports and their relative imports need explicit
`.ts` extensions.

## Realtime prices

- One shared authenticated WebSocket per app session
  (`services/ws/realtimeSocketManager.ts`). Screens register reference-counted
  `asset_ticker` / `asset_candle` subscriptions; nobody opens a second socket.
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

Timeframe windows (`features/asset/chartTimeframes.ts`): `5m`/`15m` use
`prev_open`, `30m` and `1h` use `14d` (limit 672 / 336), `4h` uses `30d`
(limit 200), `1d`/`1w` use `1y`. The backend aggregates 15m–4h from its stored
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
