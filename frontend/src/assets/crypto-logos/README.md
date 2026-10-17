# Crypto logos (bundled)

24 coin icons for the market rows' circular logo (`src/features/market/AssetLogo.tsx`).

- Source: npm `cryptocurrency-icons@0.18.1`, files `128/color/<symbol>.png`
  (https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/), unmodified.
- License: CC0-1.0 (the package's `LICENSE.md`, "CC0 1.0 Universal"): public
  domain dedication, no attribution or other condition for use and
  redistribution.
- Selection (2026-10-18): a Binance base asset of our fixed Spot universe is
  included only when the package's `manifest.json` has the same symbol with the
  same project name as our asset (`BNB` = "Binance Coin" and `FIL` =
  "Filecoin [IOU]" are the same projects under older names), and the artwork
  was checked by eye against the project's own mark. `CRV` has a manifest
  entry but its artwork is not Curve's mark, so it is left out. Every other
  coin falls back to a monogram until a verified source exists.

The list of bundled symbols lives in `BUNDLED_CRYPTO_LOGOS`
(`src/features/market/assetLogoSource.ts`); a test keeps it and these files in step.
