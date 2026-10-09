# Trading UI browser regression

Admin diagnostics uses `NODE_PATH=/path/to/browser-tools/node_modules node
test/browser/adminDiagnosticBrowser.cjs` with the same external esbuild/Playwright
setup. Production ErrorState/ErrorNotice/AdminDiagnosticPanel and React Query
cover 21 scenarios: 320/390px, font scales 1/2, Light/Dark, long text and module
paths, scrolling, expand/collapse, retry, role lookup failure, cache removal and
another admin login. Output defaults to `/tmp/trading-admin-diagnostic-browser`;
`ADMIN_DIAGNOSTIC_BROWSER_OUTPUT` and `ADMIN_DIAGNOSTIC_CHROMIUM` override the
artifact directory and browser executable. These are Web checks; physical
Android/iOS rendering remains a separate check.

Futures uses `NODE_PATH=/path/to/browser-tools/node_modules node
test/browser/futuresBrowser.cjs`. It mounts the production Futures screen/API/query
and themed components with fixture transport only. It checks 112 layouts across
320/360/390/430px, font scale 1/2, actual Light/Dark preference, open/isolated/cross/
stale/empty/loading/error states, server trading modes, account binding, 100x,
long prices/signed PnL and glyph bounds. Additional checks cover a 320×300 focused
input/submit viewport and a desktop capture. Output defaults to
`/tmp/trading-f3-browser` (`FUTURES_BROWSER_OUTPUT` overrides). The viewport resize
is Web evidence, not a physical Android/iOS keyboard test.

Login/Home recovery uses `NODE_PATH=/path/to/browser-tools/node_modules node
test/browser/portfolioRecoveryBrowser.cjs`. Production AppProviders, login,
token storage, Axios interceptors, session ownership, mode selection, account
provider and navigators run unchanged; only Axios transport uses local fixtures.
It checks bounded timeout/network/gateway retries, persistent failures and
manual retry without navigation, structural/ownership/generic-500 exclusions,
retained Home focus versus Wallet observer recovery, cache reuse, and safe admin
diagnostics. User error layouts cover Light/Dark, 320/360/390/430px and font
scales 1/2. Artifacts default to `/tmp/trading-portfolio-recovery`.
This is controlled Web evidence, not a production incident or native reproduction.

`uiPolishBrowser.cjs` additionally checks actual screenshot pixels for 25%
pressed darkening on Primary/Secondary/Buy/Sell/Logout/Home-more surfaces,
stable hit targets/layout, release/cancel and Reduced Motion. Its artifacts
default to `/tmp/trading-ui-polish` (`UI_POLISH_OUTPUT` overrides).

Home tier cards use the same external esbuild/Playwright runtime:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/homeTierBrowser.cjs
```

This renders production Home, AccountSwitcher and the six complete PNG emblems
with fixture HTTP. It covers six tiers plus neutral at 320/360/390/430/768/1280px,
font scales 1/1.5/2, normal/long names and Light/Dark (504 layouts), followed by
ranking loading/error/unavailable, unknown tier and active → past settled →
general → active switching. It checks text bounds, emblem overlap, text contrast,
44px targets, title/nickname emphasis, the selected season's request, and actual
PNG alpha area / intrinsic ratio against rendered dimensions. The area-equivalent
size increases about 1% per tier and remains uniform across appearances.
`HOME_TIER_BASELINE_RESULTS=/path/to/baseline/results.json` optionally checks that
normal mobile card heights are at least 10% lower under the same browser/font.
Reports and contact sheets default to `/tmp/trading-home-tiers`
(`HOME_TIER_BROWSER_OUTPUT` overrides). Native rendering and device screen readers
require separate device verification.

Reproduce the provided-source preparation with:

```sh
node scripts/prepare-home-tier-assets.cjs /path/to/provided-images
```

This uses Expo's installed pngjs, preserves the six original files, measures the
main inner rim, and applies the user-approved small ratio correction before
cropping/resampling. `scripts/home-tier-geometry.cjs` measures the same rim again
in the prepared PNG. The script rejects >2% correction on either axis or a fitted
rim diameter difference >=0.1 display px. It records source/output hashes, alpha
bounds/area/centroid, correction and measurements in
`src/assets/home-tiers/preparation.json`. This is raster measurement with a
subpixel tolerance, not proof that every decorative curve has mathematical e=0.
No application dependency is added. See `docs/home-tier-card.md` for evidence and
remaining physical-device checks.

Primary button colors and role exclusions use the same external browser tools:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/primaryButtonBrowser.cjs
```

`PRIMARY_BROWSER_OUTPUT` selects the artifacts (default `/tmp/trading-primary-browser`).
The suite checks the actual SVG rendering and screenshot pixels, two appearance
modes, both financial palettes, 320/360/390/430/768px widths and font scales 1/1.5/2,
resize without remounting, white text, clipping, exclusions, loading/duplicate
clicks, keyboard input and Reduced Motion. It also visits the real SeasonJoin,
FX, Record, Login and Signup screens with local transport fixtures. External
requests are blocked; no financial mutations are submitted.
Secondary probes verify exact Light/Dark solid colors, disabled/blocked/loading
states and the actual OrderSuccessBottomSheet for submitted limit, partial and
legacy full execution. History stays secondary, home stays primary and the
fallback asset action stays neutral; callback destinations and label bounds are checked.
Wallet's three compact surfaces, the HOT market action and the existing Portfolio
market CTA also have exact horizontal stops and raster checks. White foreground
pixels must be visible above the gradient, including Wallet SVG icons.

Use a host font with Korean coverage for visual checks. If the host needs local
Chromium libraries or fonts, pass `LD_LIBRARY_PATH`/`FONTCONFIG_FILE`; these are
test-environment inputs and do not change app typography. Our temporary font came
from [Noto CJK's Korean fonts](https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/Korean).
An optional `PRIMARY_BASELINE_SOURCE` points to the **frontend directory** of
a read-only extracted baseline (`git archive HEAD frontend/src` from the repo
root). With `PRIMARY_BASELINE_HEAD`, this records provenance and compares sizes
and excluded colors against that source. Without it, baseline checks are omitted.
These are web observations; Android/iOS execution remains separate. The current
handover records the existing AssetDetail arrival shift reproduced under the
same Korean font on the baseline as well as the changed source.

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
It checks the secondary history CTAs and primary profit CTA at font scales 1/1.5/2
in both appearances and financial palettes.
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
system theme changes, no Home FX entry or empty CTA space, and reward navigation.
Reports and screenshots go to `/tmp/trading-home-browser` (override `HOME_BROWSER_OUTPUT`).
This validates RN Web rendering; Android/iOS font measurement, safe areas,
touch and screen-reader behavior still require device verification.

Run `NODE_PATH=/path/to/browser-tools/node_modules node test/browser/rootTabsBrowser.cjs`
to compare Home, Market, MarketSearch, Ranking, RecordSeasonList, Overall and Guide.
The 756 layouts use the same widths, appearances, font scales and normal/long
strings. Ranking tabs also check selected/neutral palettes and tab semantics.
An additional 96 Ranking flows cover 320/360/390/430px, font scales 1/1.5/2,
Light/Dark and both financial palettes, for Active/Settled publications. Keyboard
and touch selection preserve canonical overall TOP3, friends/top10 scope and
pagination publication tokens. Each root must share a centered 1120px content cap with 16px horizontal
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
compact Wallet icon geometry and whole-item touch targets.
Each 52x52 surface must contain one horizontal brand gradient and a white icon;
the outer target and neutral caption stay transparent.
Names wrap fully with the complete accessible label; all numeric values remain
untruncated. It also checks known quantities in stale/unavailable rows, live palette changes, all 207 positions
across three API pages, and delayed outgoing responses on account switching.
The navigation fixture uses installed React Navigation and production MainTabs,
WalletStack, MyStack and RecordStack to exercise both five-tab modes, no Home
exchange entry, Wallet FX entry, ledger, Wallet orders, back paths, Overall → Record
and every Record detail destination. Only transport and the root-navigation adapter are mocked.
Icon, label and the intervening gap each navigate through the same target;
history receives the Wallet accountId after switching, and disabled exchange cannot
navigate from any area. Held label presses verify that
the static wash covers only the icon surface, including under Reduced Motion.
Use `--navigation-only` to debug those routes without repeating layouts.
Artifacts go to `/tmp/trading-wallet-browser` (override `WALLET_BROWSER_OUTPUT`).
All external requests are blocked; Android/iOS device checks remain separate.

`homeDiscoveryBrowser.cjs` verifies Home HOT selected/unselected palettes and tab
semantics at 320/360/390/430px and font scales 1/1.5/2, alongside unchanged TOP 5
queries and real Home → Market category intent. The HOT market button stays in
its original geometry with a horizontal Primary gradient and white text.
`homeMarketBrowser.cjs --market-only`
checks the same Market selection policy with server sorting and pagination.

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

Runtime diagnostics use the actual shared socket manager, channel hooks, screens
and `/me` cache with local REST/auth and WebSocket fixtures:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/realtimeBrowser.cjs
```

`REALTIME_BROWSER_OUTPUT` defaults to `/tmp/trading-realtime-browser`. The 72 cases
cover Market, Chart, Order and FX; admin/user/operator/unresolved/failed role
lookups; Light/Dark, 320/390/768px and font scales 1/2. Text range measurements
check expanded diagnostic glyph bounds, and frame assertions reject duplicate
subscriptions or extra sockets. Four clock-driven flows also cover OrderBook
ACK/timeout/recovery/stale, candle server control and delayed receipt freshness,
FX ACK/update REST resync, and a different market row’s subscription error.
External requests are blocked. Optional
`LD_LIBRARY_PATH`/`FONTCONFIG_FILE` supply local Chromium libraries/Korean fonts.
iOS/Android component tests cover the role gate, unrestricted line wrapping and
font scaling; physical-device text measurement is a separate check.

`profileImageBrowser.cjs` runs the actual Expo Web image picker/manipulator,
Settings, multipart FormData and ProfileAvatar against a local HTTP fixture.
Run with esbuild/Playwright on NODE_PATH as above. It verifies file chooser and
cancel, nonsquare PNG → 512px JPEG, small-image no-upscale, add/replace/delete,
failed-upload preservation, reload persistence, Home/My/Ranking propagation,
and Settings button glyph bounds at 320/360/390/430px × font scale 1/1.5/2 ×
Light/Dark. Separate held HTTP responses verify upload/delete pending labels and
disabled neighboring buttons at 320px/font scale 2 in both themes. EXIF rotation
and metadata removal are checked with an oriented JPEG. The backend JPEG validator
also checks the actual uploaded bytes.
Reports, normalized images and screenshots default to `/tmp/profile-image-browser`
(`PROFILE_IMAGE_BROWSER_OUTPUT` overrides). Real S3/R2, native permission/crop,
and physical-device checks are separate; no external request is permitted.

UI appearance, button motion and logout presentation regression:

```sh
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/uiPolishBrowser.cjs
```

This reuses production components and the existing root-tabs/friends/motion
transport fixtures. It checks 144 layouts at 320/360/390/430px, font scales
1/1.5/2 and Light/Dark: Home holdings disclosure, MY/Settings logout,
Market/Ranking/Friends selected Secondary. It compares both logout buttons,
checks text bounds and gradient stops, measures stationary hit targets and
neighbors separately from scaled visual surfaces, and exercises cancellation,
keyboard activation, loading guards and live Reduced Motion. Appearance cases
include missing/empty/invalid storage, failed reads, stored light/dark/system,
reload persistence and OS changes. `UI_POLISH_OUTPUT` selects artifacts
(default `/tmp/trading-ui-polish`); `UI_POLISH_FEEDBACK_ONLY=1` narrows debugging.
The harness makes `Date.now` advance with `performance.now` because RN Web
Animated uses the wall clock, which can be corrected backwards on the test VM.
Production scale/overlay interpolation is clamped to the intended bounds.
These are RN Web observations; native frame pacing and back gestures require devices.

The motion runner also covers Overall → MY → Back and Overall → Settings → Back.
MY and Settings are sibling routes in the current navigator. For a reproducible
before comparison, `MOTION_BASELINE_SOURCE=/path/to/extracted/frontend` builds
production source from an extracted Git revision while retaining the same test
instrumentation, dependencies and fonts. The output folder should be separate
from the current-source run; the existing geometry assertions are kept active.


Futures integration uses `futuresIntegrationBrowser.cjs`, alongside the existing
`futuresBrowser.cjs` and `conditionalBrowser.cjs`. Use the memory containment
policy in the frontend README; esbuild/Playwright remain external test tools on
`NODE_PATH`. `BROWSER_EXECUTABLE_PATH` may select an existing Chromium, and
`LD_LIBRARY_PATH`/`FONTCONFIG_FILE` may point to temporary libraries/Korean fonts.
The integration runner checks 96 actual RN Web layouts: 320/360/390/430px ×
Light/Dark × font scales 1/2 × Market selection/navigation, Long and Short Limit
entry with attached prices, holding-card protection, mixed pending entries and
pending protection. It checks box/glyph bounds, large prices, long names and
Conditional-child deduplication; external HTTP requests are blocked.
`FUTURES_INTEGRATION_BROWSER_OUTPUT` selects screenshots/report.json (default
`/tmp/trading-futures-integration-browser`). Native iOS/Android keyboard, device
text rendering and full live-server execution are separate acceptance checks.

Beginner foundation uses `beginnerBrowser.cjs` and `beginnerMocks.js`, reusing
the production account provider, root/tab/guide navigation and financial
screens. Run with external esbuild/Playwright on `NODE_PATH` under the same
memory containment policy. `BEGINNER_CHROMIUM` optionally selects Chromium;
`BEGINNER_BROWSER_OUTPUT` defaults to `/tmp/trading-beginner-browser`.
It checks 16 layouts (320/360/390/430px, font scale 1/2, light/dark), Korean
segment/tab glyph bounds and hit areas, guide round trips, three-mode
selection, explicit creation, hidden disabled entry and delayed portfolio/
holdings responses during account switching. All external HTTP is blocked.
These RN Web checks do not replace Android/iOS device acceptance.
