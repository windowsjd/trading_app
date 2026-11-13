# 앱 업데이트 안내 (app release manifest) contract

Added 2026-11-05. The app tells a user when the **store** offers a newer version than the one installed. Nothing in the repository knows that: the version in `app.json`, an EAS build number, a TestFlight upload or a version in review are not what users can install.

**Since 2026-11-13 the stores are asked directly** — no operator enters a version any more:

| Platform | Source of "a newer version exists" | Where |
| --- | --- | --- |
| Android | Google Play In-App Updates API on the device (`AppUpdateManager.getAppUpdateInfo`): Play's own answer for this install, so staged rollouts, device targeting and installs not from Play are handled by Play. | `frontend/modules/play-app-update` (local Expo module, Android only), `frontend/src/features/appRelease/playUpdate.ts` |
| iOS | Apple's iTunes Lookup API (`https://itunes.apple.com/lookup?bundleId=com.leagueoftrading&country=kr`), read by this server and cached. The App Store lists released versions only (never TestFlight or in-review builds). | `src/app-release/app-store-lookup.service.ts` |

## Route

`GET /api/v1/app-release` — public (the app may ask before sign-in), read-only, `Cache-Control: public, max-age=300`.

```
{ success: true, data: {
  android: { packageName, latestVersion, notes } | null,   // app builds from before 2026-11-13 only
  ios: { bundleId, appStoreId, latestVersion, notes: null } | null } }
```

### `ios` (App Store lookup)

- Bundle id `APP_STORE_BUNDLE_ID` = `com.leagueoftrading` (= `frontend/app.json` `ios.bundleIdentifier`; a frontend test pins them), Korean storefront `kr`.
- Only the result whose `bundleId` is exactly that id counts; `version` must be numeric dotted with 2 or 3 parts (App Store Connect allows `1.03`), `trackId` (the real App Store id, used for the store link) a 6–12 digit integer. Anything else — no result (not released yet), another app, malformed fields, HTTP error, timeout (5 s), bad JSON — is `null`: no iOS notice, never a wrong one.
- One read at a time per server instance (concurrent requests share it), cached 15 minutes; a failed read is cached 5 minutes, so Apple is never hammered and a slow Apple never slows the app (the app reads this route in the background).
- `APP_RELEASE_IOS_BUNDLE_ID`, `APP_RELEASE_IOS_APP_STORE_ID`, `APP_RELEASE_IOS_LATEST_VERSION` are **no longer read** (a stale manual value can no longer override the store). `notes` is always null for iOS.

### `android` (legacy, env)

Kept only because Android builds from before 2026-11-13 read this route and have no Play module. Unchanged rules:

| Variable | Rule |
| --- | --- |
| `APP_RELEASE_ANDROID_PACKAGE` | the Play application id, `com.nanghwa.tradingclass` |
| `APP_RELEASE_ANDROID_LATEST_VERSION` | `x.y.z` exactly as the live Play listing shows |
| `APP_RELEASE_NOTES` | optional, ≤ 300 characters (shown by those old builds) |

A field missing or malformed is `null`. Builds from 2026-11-13 on ignore this entry entirely and ask Google Play.

**Removal plan.** When Play Console shows (almost) no installs of versionCodes from before the Play-module build, unset the three `APP_RELEASE_ANDROID_*`/`APP_RELEASE_NOTES` variables and remove `readLegacyAndroidRelease` and the `android` key (the frontend no longer parses it for decisions). Until then an operator may keep recording the live Play version for those old installs; doing so has no effect on new builds.

## App rules (frontend `features/appRelease/appUpdate.ts`)

- Only an EAS `production` release build asks (not `__DEV__`, preview APKs, development clients, Metro or web). On iOS the build must also be App Store-signed (`expo-application` release type `APP_STORE`; simulator, development, ad-hoc and enterprise builds never qualify). A TestFlight install is App Store-signed too and cannot be told apart on the device; it only hears of a version strictly newer than its own.
- **Android:** a notice only when Play answers `UPDATE_AVAILABLE` (2) with a whole `availableVersionCode` above the installed versionCode (when readable). Other answers (unknown, not available, an in-app update in progress), a failure (not installed from Play, no Play Store, offline) or a missing native module show nothing. Play gives no version **name**, so the sheet shows the current version only — none is guessed. Once per Play versionCode per app run.
- **iOS:** the manifest must name this bundle id, and its version must be strictly newer than the installed one, **compared only between versions written alike** (same number of parts). The live listing is `1.03` (2026-11-12, `currentVersionReleaseDate` 2026-11-11T21:37:43Z) while `app.json` says `1.0.3`: read loosely `1.03` would be 1.3 > 1.0.3 and ask every member to update forever, so differently written versions show nothing. **Keep the App Store Connect version and `app.json` `version` written the same way (x.y.z).** Once per version per app run.
- Read when the app starts, and again when it returns to the foreground if the last read is at least 30 minutes old, or failed at least 5 minutes ago — so a version published while the app sat in the background is still heard of in that run, without a request on every switch. The iOS read is sent without the session's credentials (`skipSessionAuth`), so guests read it too.
- Shown after normal entry (inside the main tabs), not while a beginner guide is on screen, and never together with the 공지 팝업 (one entry overlay at a time: whichever is ready first, the other after it closes). 나중에 always closes it; nothing is ever forced.
- 업데이트하기 opens the store app (`market://details?id=…` / `itms-apps://apps.apple.com/app/id…`) and falls back to the store's web page; if neither opens, the sheet says so and stays dismissible. No in-app update flow is started.

## Installed version source

The app compares with the version the installed build reports (expo-application). iOS takes `app.json` `version` through prebuild. Android does **not**: this project keeps its own `android/` directory, so EAS never copies `app.json` `version` into it; every Android build reports `android/app/build.gradle` `versionName` (a frontend test requires the two to match — bump both for every release). The Play module is native code: it ships only with a new native (EAS) build.

No OTA update, in-app update flow or store submission is part of this.
