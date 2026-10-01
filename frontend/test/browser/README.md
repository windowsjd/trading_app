# Trading UI browser regression

`tradingBrowser.cjs` bundles the current chart-first detail and separate Order route, React Query cache,
account-bound API wrappers, quote/create flow, shared SVG renderer and web
pointer adapter. Only transport, authentication/account inputs and navigation
are fixture boundaries. Outbound requests are blocked except the local server.
No credentials, production requests or real financial orders are used.

Run from `frontend/` with **esbuild and Playwright installed externally** and a
Chromium browser available to Playwright:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/tradingBrowser.cjs
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/orderLayoutBrowser.cjs
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

The focused `orderLayoutBrowser.cjs` checks 320/360/390px in light and dark mode: two simultaneous columns, visible native value/placeholder/caret colors, long-decimal caret scrolling, buy amount, limit price, sell quantity, ratios, and a quote/create action. Screenshots go to `/tmp/trading-order-browser` (override with `ORDER_BROWSER_OUTPUT`).

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


Friend screens use the same external tools and `nativeWeb.jsx` font-scale
adapter. Run `NODE_PATH=/path/to/browser-tools/node_modules node
test/browser/friendsBrowser.cjs` from frontend. It checks 320/390/768px × font
scale 1/2, long nicknames/holdings, overall/friends/notices/settings/portfolio,
server-returned toggle state, and private/non-friend sections. Reports and
screenshots go to `/tmp/trading-friends-browser` (override with
`FRIENDS_BROWSER_OUTPUT`). Fixtures are test-only and all external requests are
blocked. Native Android text measurement, keyboard and screen-reader checks
remain manual.

The focused runner also verifies the actual computed light/dark canvas, card,
and inset backgrounds on Home, Market, AssetDetail and the timeframe sheet.
It rejects unresolved semantic sentinels in CSS/SVG and saves comparison screenshots.
The friends runner checks both modes (60 layouts), Settings persistence after reload,
and system theme changes. Install a Korean font in the browser environment (or set
`FONTCONFIG_FILE` to a local fontconfig file) so Korean text widths are meaningful.

Home uses the same browser tools and font-scale adapter:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/homeBrowser.cjs
```

The Home runner executes the actual General/Season screens, AccountSwitcher,
TradingAccountProvider, React Query, selection storage and appearance provider.
Only transport and navigation are fixture boundaries; external requests are
blocked. It checks 320/360/390/430/1280px × light/dark × font scale 1/1.5/2 ×
both modes × normal/long content (120 layouts), plus 28 exception states. Text
range measurements detect clipping of Korean, long nicknames/tier names, large
rank numbers and 16-digit assets. It also checks the context's padding/height,
asset hierarchy, delayed outgoing responses, account/appearance restoration,
system theme changes and ledger/orders/FX/reward navigation. Reports and
screenshots go to `/tmp/trading-home-browser` (override `HOME_BROWSER_OUTPUT`).
This validates RN Web rendering; Android/iOS font measurement, safe areas,
touch and screen-reader behavior still require device verification.
