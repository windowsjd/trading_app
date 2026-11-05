# 앱 업데이트 안내 (app release manifest) contract

Added 2026-11-05. The app tells a user when the **store** publishes a newer version than the one installed. Nothing in the repository knows that: the version in `app.json`, an EAS build number, a TestFlight upload or a version in review are not what users can install. Google Play has no supported public API for "the live version of this app" (scraping its HTML is fragile and against its terms), so an operator records the version after seeing it live.

## Route

`GET /api/v1/app-release` — public (the app may ask before sign-in), read-only, `Cache-Control: public, max-age=300`.

```
{ success: true, data: {
  android: { packageName, latestVersion, notes } | null,
  ios: { bundleId, appStoreId, latestVersion, notes } | null } }
```

## Configuration (Render environment; nothing is set by default)

| Variable | Rule |
| --- | --- |
| `APP_RELEASE_ANDROID_PACKAGE` | the Play application id, e.g. `com.nanghwa.tradingclass` (current `android/app/build.gradle` `applicationId`) |
| `APP_RELEASE_ANDROID_LATEST_VERSION` | `x.y.z` exactly as the live Play listing shows |
| `APP_RELEASE_IOS_BUNDLE_ID` | e.g. `com.leagueoftrading` (`app.json` `ios.bundleIdentifier`) |
| `APP_RELEASE_IOS_APP_STORE_ID` | the numeric App Store id (6–12 digits). None exists yet; never guess it |
| `APP_RELEASE_IOS_LATEST_VERSION` | `x.y.z` as the live App Store page shows |
| `APP_RELEASE_NOTES` | optional, ≤ 300 characters, shown under the versions |

A platform with any field missing or malformed is `null`, and the app then shows nothing for it. Set a version **only after** the release is live and installable on that store (not when it is submitted, in review, on an internal/closed track or in TestFlight). Removing the variables stops the notice.

## App rules (frontend `features/appRelease/appUpdate.ts`)

- Only an EAS `production` release build asks (not `__DEV__`, preview APKs, development clients, Metro or web). On iOS the build must also be App Store-signed (`expo-application` release type `APP_STORE`; simulator, development, ad-hoc and enterprise builds never qualify). A TestFlight install is App Store-signed too and cannot be told apart on the device; it only hears of a version strictly newer than its own.
- The manifest must name the installed app id; the store version must be strictly newer (numeric `x.y.z`).
- Shown after normal entry (inside the main tabs, below the beginner guide, and not while a guide is on screen), once per platform and version per app run. 나중에 always closes it; nothing is ever forced.
- 업데이트하기 opens the store app (`market://details?id=…` / `itms-apps://apps.apple.com/app/id…`) and falls back to the store's web page; if neither opens, the sheet says so and stays dismissible.
- A failed read shows nothing and blocks nothing.

No OTA update, in-app update framework or store submission is part of this.
