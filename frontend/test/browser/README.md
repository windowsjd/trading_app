# Trading UI browser regression

`tradingBrowser.cjs` bundles the actual RN Web screens, React Query cache,
account-bound API wrappers, quote/create flow, shared SVG renderer and web
pointer adapter. Only transport, authentication/account inputs and navigation
are fixture boundaries. Outbound requests are blocked except the local server.
No credentials, production requests or real financial orders are used.

Run from `frontend/` with **esbuild and Playwright installed externally** and a
Chromium browser available to Playwright:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/tradingBrowser.cjs
```

Set `PLAYWRIGHT_BROWSERS_PATH` if Chromium uses a non-default installation path.
`TRADING_BROWSER_OUTPUT` overrides the default `/tmp/trading-ui-followup/browser`
artifact directory. System Chromium libraries/fonts must be installed separately.
No browser dependencies are added to the app's runtime bundle or lockfile.

Coverage: 320/360/390/430px × font scale 1/1.5 × BTC/BNB/PEPE/SUI/币安人生,
market/limit controls with the old flag explicitly false, ratio explanation and
valid fill, single quote/create CTA on both sides, admin/unknown/failed role
lookup, shared `/me` query, Han list/search/navigation/encoding, five asset
charts, pointer release/cancel/blur/capture/visibility/buttons=0, X pan/zoom,
Y range/center/clamp and shared candle/current-price/crosshair mapping,
latest/timeframe reset and active gesture unmount.

Quantity controls additionally cover 320/390/768px × font scale 1/1.5/2:
one-row presets at the default scale, selected styling, keyboard arrows/Home/End,
track clicks and dragging beyond both ends, immediate quantity updates, and
manual-input synchronization. The larger-font drag also checks that changing
percentage digits does not move the track. The unit suite exercises both order
screens, both account modes and the installed native gesture event receiver.

Font scaling is simulated in RN Web Text/TextInput and useWindowDimensions;
this is not an Android/iOS accessibility or physical gesture test. The normal
`npm run check` separately runs component tests and installed RNGH event-receiver
integration tests. Device testing remains a separate release check.
