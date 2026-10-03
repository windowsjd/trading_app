# Trading UI browser regression

Interaction motion diagnostics use the same external tools:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/motionBrowser.cjs
```

`MOTION_BROWSER_OUTPUT` selects the artifact directory (default
`/tmp/trading-motion-browser`). It runs real navigators/screens/React Query with
immediate fixture responses, 600 ms delayed responses and a fresh cached revisit,
plus the season Ranking tab and live Reduced Motion changes. Mutations and
external network requests are blocked. Production React profiling and test-bundle
instrumentation record pointer-down, handler/click, route state, visible shell/data
markers, request start/response, commits, RAF intervals and layout-shift sources.
The 35 ms simulated hold is intentional; these are **web observations, not native
T1/T3/T4, physical touch latency or native FPS**. Order's input and Profit's summary
markers can appear before other section data; request timestamps remain separate.
`MOTION_CONDITIONS=delayed` narrows diagnosis. `MOTION_REUSE_BUNDLE=1` reruns a
previously preserved `motion.js` in the output directory for a before comparison;
omit it for current-source validation. Baseline bundle provenance must be recorded.
Run timing comparisons after builds and other browser suites finish; shared host
CPU contention changes the observed latency. These samples have no FPS pass gate.

`MOTION_WIDTH=320` and `MOTION_FONT_SCALE=2` use the existing RN Web scale
adapter for arrival checks (also run 360/390/430 and scale 1). Geometry snapshots
record the observed major section positions and heights on RAF, separately from
the layout-shift observer. The original AssetDetail/Profit reservation assertion
applies to its measured 390px/default-font case; large-font text/axis wrapping is
recorded, not hidden by an arbitrary fixed height. `MOTION_FX_STATE=available`
adds a valid read-only FX fixture and checks that delayed rate arrival retains
the direction/input/CTA positions. Default FX remains unavailable, history empty.
The probe also saves held-press screenshots and computed colors for light/dark,
red/blue and green/red palettes. Its ScrollView recognizer observation window
does not define a production animation duration. Immediate press/release behavior
is covered by the component tests. `MOTION_REUSE_BUNDLE` skips current-source
geometry assertions and is only for a documented baseline comparison.

The existing `recordBrowser.cjs` can target the changed chart screens with
`RECORD_BROWSER_SCREENS=detail,profit`; its default still checks history as well.
The motion handover records the pre-existing 320px/2×-font history amount overflow
found by that broader run, including reproduction against the starting HEAD.

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
blocked. It checks 320/360/390/430/768/1024/1280/1440/1920px × light/dark × font scale 1/1.5/2 ×
both modes × normal/long content (216 layouts), plus 28 exception states. Text
range measurements detect clipping of Korean, long nicknames/tier names, large
rank numbers and 16-digit assets. It also checks the context's padding/height,
asset hierarchy, delayed outgoing responses, account/appearance restoration,
system theme changes and ledger/orders/FX/reward navigation. Reports and
screenshots go to `/tmp/trading-home-browser` (override `HOME_BROWSER_OUTPUT`).
This validates RN Web rendering; Android/iOS font measurement, safe areas,
touch and screen-reader behavior still require device verification.

Run `NODE_PATH=/path/to/browser-tools/node_modules node test/browser/rootTabsBrowser.cjs`
to compare Home, Market, MarketSearch, Ranking, RecordSeasonList, Overall and Guide.
The 756 layouts use the same widths, appearances, font scales and normal/long
strings. Each root must share a centered 1120px content cap with 16px horizontal
padding and a full screen scroll viewport. The runner also exercises actual
Market/Ranking/Record pagination and navigation. Reports and screenshots go to
`/tmp/trading-root-tabs-browser` (override `ROOT_TABS_BROWSER_OUTPUT`).


Run `NODE_PATH=/path/to/browser-tools/node_modules node test/browser/profileFinancialBrowser.cjs`
for Home/Ranking/MY avatars, Market/Search presentation and the device financial preference.
It reuses the root-tab and trading fixtures, actual AppearanceProvider, Settings,
order/quote UI and SVG candle renderer. The 304 layouts cover 320/360/390/430px,
Light/Dark × Red/Blue/Green/Red, and font scales 1/1.5/2 for identity/market/settings.
It also checks image success/failure with a local image response, large ranks/prices,
closed/open/unknown/crypto sessions, missing change rates, Settings restore and OS changes,
and instant repaint of memoized rows/candles, order sides and bid/ask accents.
Artifacts go to `/tmp/trading-profile-financial-browser` (override
`PROFILE_FINANCIAL_BROWSER_OUTPUT`). External requests remain blocked.

Run `NODE_PATH=/path/to/browser-tools/node_modules node test/browser/walletBrowser.cjs`
for the Wallet tab and the shared Home holdings. It checks 384 layouts:
320/360/390/430px × Light/Dark × Red/Blue/Green/Red × font scale 1/1.5/2 ×
General/Season × normal/long text × Home/Wallet. Visible glyph measurements
cover long asset names, large local KRW/USD values, +123.45% and -99.12%.
Holdings fixtures include 삼성전자 / Berkshire Hathaway Class B / Bitcoin and
stock/crypto quantities rounded only for display to six decimal places, without
trailing zeros. Rendered boxes and glyph edges verify the left identity and the
right value → secondary quantity → return column, its typography, and equal
Wallet history button widths/heights/padding/touch targets. Names wrap fully with
the complete accessible label; all numeric values remain
untruncated. It also checks known quantities in stale/unavailable rows, live palette changes, all 207 positions
across three API pages, and delayed outgoing responses on account switching.
The navigation fixture uses installed React Navigation and production MainTabs,
WalletStack, MyStack and RecordStack to exercise both five-tab modes, Home/Wallet
FX entry, ledger, Wallet orders, back paths, Overall → Record and every Record
detail destination. Only transport and the root-navigation adapter are mocked.
Use `--navigation-only` to debug those routes without repeating layouts.
Artifacts go to `/tmp/trading-wallet-browser` (override `WALLET_BROWSER_OUTPUT`).
All external requests are blocked; Android/iOS device checks remain separate.

Run `NODE_PATH=/path/to/browser-tools/node_modules node test/browser/homeMarketBrowser.cjs`
for the Home disclosure and Market sorting. It checks 320/360/390/430px × Light/Dark,
Home at font scales 1/2 in both account modes, all five daily ranges, 16-digit KRW
tooltips at first/middle/last points, glyph clipping, delayed account switches,
Market turnover/changeRate criteria and ASC/DESC arrows, both financial palettes,
search and server snapshot pagination. Fixtures contain only
explicit actual-date test observations; they do not replace production data.
Artifacts go to `/tmp/trading-home-market-browser` (`HOME_MARKET_BROWSER_OUTPUT`).
Set `LD_LIBRARY_PATH` and `FONTCONFIG_FILE` when browser libraries/fonts live outside
the system paths. Native-device screen readers and touch recognition remain a
separate device check.


Market partial-fill result/history verification:
`NODE_PATH=/path/to/browser-tools/node_modules node test/browser/marketExecutionBrowser.cjs`.
The 48 cases cover 320/360/390/430px × font scale 1/1.5 × quantity, amount, long
numeric intent, legacy full fill, limit submitted, and history. It asserts
horizontal text bounds, visible/clickable CTA, authoritative partial labels,
and automatic-cancel copy. Artifacts default to `/tmp/b21-market-browser`.
