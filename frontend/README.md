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
  KRW unavailable rather than borrowing the older REST KRW.
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
crosshair; vertical swipes still scroll the detail screen. Web: drag to pan,
hover for the crosshair, ctrl/cmd + wheel (or trackpad pinch) to zoom. `+`,
`−` and `초기화` buttons do the same without gestures.

**Native rebuild required.** `react-native-gesture-handler`,
`react-native-reanimated` and `react-native-worklets` are native modules added
via `npx expo install`, `babel.config.js` carries
`react-native-worklets/plugin`, and `App.tsx` wraps the app in
`GestureHandlerRootView`. Rebuild the dev client (`npx expo run:android`, or a
new EAS dev build) before testing on a device; Expo web needs no extra setup.
