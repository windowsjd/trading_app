# Crypto USD Settlement Policy Update

## 1. Purpose

This document records the 2026-05-14 policy update that fixes MVP crypto as Binance-based, USD-settled crypto. Crypto orders use the USD Wallet like US stocks. Crypto KRW valuation remains required for `totalAssetKrw`, ranking, home summary, snapshots, and final evaluation by converting USD crypto value with the USD/KRW FX rate.

## 2. Previous Policy

- Crypto provider policy was still conditional and centered on Twelve Data fixture candidates such as `BTC/USD`.
- Provider evidence docs treated crypto endpoint choice as open: `/exchange_rate`, `/quote`, or future WebSocket.
- Crypto was documented as a conditional provider-ingestion target, not a fixed MVP provider stack.
- Repository audit did not find active Upbit/Bithumb implementation or `KRW-BTC` business fixtures, but the docs also did not yet state that Upbit/Bithumb are excluded from MVP.

## 3. New Final Policy

- MVP does not split crypto into domestic and overseas crypto.
- MVP crypto provider is Binance.
- MVP crypto trading and settlement currency is USD.
- Crypto orders use the USD Wallet.
- Crypto KRW valuation is `crypto USD price * quantity * USD/KRW rate`.
- Upbit and Bithumb are excluded from the MVP provider stack.
- KRW crypto trading is excluded from MVP.
- Binance symbol/pair is finalized in fixture/evidence work, with `BTCUSDT` and `ETHUSDT` as initial spot-market candidates.
- `CurrencyCode.USDT` must not be added. Internal currency remains USD only.
- MVP provider ingestion foundation treats Binance USDT quote pairs such as `BTCUSDT` and `ETHUSDT` as USD-equivalent for internal `asset_price_snapshots.currencyCode=USD` storage.
- USDT depeg risk is not modeled in this MVP foundation and must be handled by a later risk/source eligibility gate if product requires it.
- `cryptoValueKrw`, `totalAssetKrw`, and `returnRate` remain KRW-denominated fields.

## 4. Code Audit Summary

Search scope: `docs src test prisma scripts`, excluding generated Prisma output for readability. Keywords searched:

`crypto`, `cryptoValueKrw`, `AssetType.crypto`, `currencyCode: CurrencyCode.KRW`, `market: 'BINANCE'`, `market: 'UPBIT'`, `market: 'BITHUMB'`, `KRW-BTC`, `BTC/KRW`, `BTCUSDT`, `BTC/USD`, `Binance`, `Upbit`, `Bithumb`, `암호화폐`, `KRW 기준 거래`, `KRW 정산`, `USD 정산`.

Findings:

- `AssetType.crypto` exists in Prisma schema as `crypto`.
- `CurrencyCode` has only `KRW` and `USD`; no `USDT`.
- `cryptoValueKrw` exists in `EquitySnapshot` schema and older migration docs.
- No source code path was found that forces `assetType === crypto` to KRW.
- No `market: 'UPBIT'`, `market: 'BITHUMB'`, `KRW-BTC`, or `BTC/KRW` code/fixture usage was found.
- Existing order quote/create/execute logic uses `asset.currencyCode` / `order.currencyCode` for wallet selection and USD/KRW conversion.
- Existing portfolio valuation converts USD positions through USD/KRW, but asset-type breakdown needed a code/test update so USD crypto can be reflected in `cryptoValueKrw`.
- Existing docs referenced Twelve Data crypto and `BTC/USD` fixture candidates; these are now replaced by Binance USD-settled crypto fixture planning.

## 5. Schema Impact

Current schema satisfies the policy:

- `AssetType.crypto` exists.
- `Asset.currencyCode` accepts `USD`.
- `Asset.market` is a free string and can store `BINANCE`.
- `AssetPriceSnapshot.currencyCode` accepts `USD`.
- `Order.currencyCode` accepts `USD`.
- `Position.currencyCode` accepts `USD`.
- `CashWallet` already supports a USD wallet per season participant.
- `FxRateSnapshot` supports USD/KRW conversion.

Decision: schema migration is **NOT NEEDED**.

Forbidden schema changes remain forbidden:

- Do not add `CurrencyCode.USDT`.
- Do not split `AssetType`.
- Do not add `CryptoDomestic`, `CryptoOverseas`, `domestic_crypto`, or `overseas_crypto`.

## 6. Order Engine Impact

Order quote/create/execute is already currency-driven:

- Buy resource checks use the cash wallet matching `asset.currencyCode` or `order.currencyCode`.
- Sell resource checks use position quantity for the asset.
- USD assets require fresh approved USD/KRW FX for KRW audit/response conversion.
- USD order execution stores `fxRateSnapshotId` for audit consistency.
- Wallet transactions use the order currency.
- Positions are created/updated in the order currency.

Decision: order engine source code change is **NOT REQUIRED** for crypto USD settlement. Tests were required to lock the Binance crypto USD behavior.

## 7. Portfolio Valuation Impact

Portfolio valuation already converted USD positions by USD/KRW. The missing piece was explicit asset-type KRW breakdown for `cryptoValueKrw`.

Required code/test change:

- Include `asset.assetType` in valuation inputs.
- Add `domesticStockValueKrw`, `usStockValueKrw`, and `cryptoValueKrw` to internal valuation results.
- Classify USD crypto position value into `cryptoValueKrw` after USD/KRW conversion.

## 8. Provider Impact

- Binance is the MVP crypto provider.
- Twelve Data is no longer the MVP crypto provider target.
- Upbit/Bithumb are excluded from MVP provider stack.
- Provider ingestion foundation is implemented for Binance public REST crypto price snapshot insertion.
- `provider_api` rows are not opened for crypto quote/execute/valuation eligibility until a later source eligibility gate accepts timestamp/freshness/source priority behavior.

## 9. Fixture Impact

Next crypto fixture targets:

- `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`
  - Binance BTCUSDT ticker/price fixture.
  - Public market data.
  - No private key.
- `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json`
  - Binance BTCUSDT orderbook fixture.
  - Public market data.
  - No private key.

Provider ingestion foundation can fetch Binance public REST ticker data through explicit operator commands. WebSocket fixture capture remains deferred.

Open source eligibility blocker:

- Decide whether and when Binance USD-equivalent provider_api rows can power order quote, order execute, home live valuation, daily snapshot, and final settlement workflows.

## 10. Documentation Changes Required

Documents updated in this task:

- `docs/current-status.md`
- `docs/backend-gate-roadmap.md`
- `docs/provider-final-selection-readiness-recheck.md`
- `docs/asset-price-freshness-policy.md`
- `docs/provider-evidence-capture.md`
- `docs/provider-fixtures/provider-error-samples.md`
- `docs/fx-api-contract.md`
- `docs/orders-api-contract.md`
- `docs/home-api-contract.md`
- `docs/ranking-api-contract.md`
- `docs/wallets-api-contract.md`
- `docs/records-api-contract.md`
- `docs/backend-test-coverage-matrix.md`

## 11. Code Changes Required

- Order engine source: not required.
- Asset admin validation source: not required.
- Portfolio valuation source: required for asset-type KRW breakdown and `cryptoValueKrw`.
- Tests: required for Binance/USD crypto order, admin asset/price input, and valuation behavior.

## 12. Tests Required

Added or updated tests:

- Asset admin input:
  - Binance crypto USD asset upsert succeeds.
  - Binance crypto USD price snapshot input succeeds.
  - USD asset with KRW price mismatch remains rejected.
- Orders:
  - Binance crypto USD buy quote uses USD Wallet and fresh USD/KRW FX.
  - Binance crypto USD sell quote computes USD net and KRW-converted response amounts.
  - Binance crypto USD create stores USD order currency and FX snapshot id.
  - Binance crypto USD buy execute debits USD Wallet, writes USD position/ledger, and stores `fxRateSnapshotId`.
  - Binance crypto USD sell execute credits USD Wallet and writes USD ledger currency.
- Portfolio valuation:
  - USD crypto position is converted with USD/KRW and reflected in `cryptoValueKrw`.
  - Missing/stale USD/KRW remains an unavailable/error condition.

## 13. STOP / GO Decision

| Area | Decision | Reason |
|---|---|---|
| Crypto USD settlement policy | GO | Current schema/order model supports Binance USD-settled crypto through existing USD currency paths |
| Schema migration | NOT NEEDED | Current enums/tables already support crypto + USD + BINANCE market string |
| Orders code change | NOT REQUIRED | Orders are already `currencyCode` driven |
| Portfolio valuation code change | REQUIRED | Needed explicit `cryptoValueKrw` asset-type breakdown |
| Binance fixture capture | CONDITIONAL GO | Public fixture capture may proceed in Gate C/D without private key, but no live call in this task |
| Binance provider ingestion foundation | GO | Public REST ticker can create provider_api USD-equivalent snapshot rows for existing mapped BINANCE crypto assets |
| Binance provider_api source eligibility | STOP | Quote/execute/valuation read paths still require a separate source eligibility gate |
| KRX provider implementation | STOP | Domestic stock provider remains blocked/unverified |
| Settlement implementation | STOP | Final evidence source remains Gate H/I |

## 14. Open Questions

- Which Binance ticker/orderbook timestamp maps to internal `effectiveAt`?
- What crypto quote/execute freshness threshold is accepted for Binance public market data after fixture capture?
- Can sanitized Binance raw payloads be stored in `rawPayloadJson`, and under what retention policy?
- Which owner explicitly approves the Binance crypto provider terms for MVP use?
