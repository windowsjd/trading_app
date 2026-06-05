# Fixed 40-Stock KIS Watchlist Asset Universe

Work date: 2026-05-30 KST.

## Purpose

This document records the fixed stock universe selected by project decision for the KIS WebSocket market-data watchlist.

Selection basis: 2026 trading-volume/liquidity oriented fixed high-liquidity stock universe.

Important boundary:

- This is a fixed high-liquidity watchlist candidate selected by project decision.
- Codex did not perform a new stock investigation in this gate.
- The 40 symbols below are used as-is, with no replacement, no extra stock symbols, and no fake assets.
- If exact official YTD rank verification is needed later, it must be handled by a separate data-verification gate.
- This document does not claim that an official YTD cumulative volume rank was verified.

## Fixed Domestic Stocks

| # | Symbol | English name | Korean name | Market | Asset type | Currency |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 005930 | Samsung Electronics | 삼성전자 | KRX | domestic_stock | KRW |
| 2 | 000660 | SK Hynix | SK하이닉스 | KRX | domestic_stock | KRW |
| 3 | 034020 | Doosan Enerbility | 두산에너빌리티 | KRX | domestic_stock | KRW |
| 4 | 010140 | Samsung Heavy Industries | 삼성중공업 | KRX | domestic_stock | KRW |
| 5 | 042660 | Hanwha Ocean | 한화오션 | KRX | domestic_stock | KRW |
| 6 | 005380 | Hyundai Motor | 현대차 | KRX | domestic_stock | KRW |
| 7 | 000270 | Kia | 기아 | KRX | domestic_stock | KRW |
| 8 | 035420 | NAVER | 네이버 | KRX | domestic_stock | KRW |
| 9 | 035720 | Kakao | 카카오 | KRX | domestic_stock | KRW |
| 10 | 068270 | Celltrion | 셀트리온 | KRX | domestic_stock | KRW |
| 11 | 051910 | LG Chem | LG화학 | KRX | domestic_stock | KRW |
| 12 | 066570 | LG Electronics | LG전자 | KRX | domestic_stock | KRW |
| 13 | 086520 | Ecopro | 에코프로 | KRX | domestic_stock | KRW |
| 14 | 247540 | Ecopro BM | 에코프로비엠 | KRX | domestic_stock | KRW |
| 15 | 028300 | HLB | 에이치엘비 | KRX | domestic_stock | KRW |

## Fixed US Stocks

| # | KIS symbol | Asset symbol | English name | Market | Asset type | Currency |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | NAS:NVDA | NVDA | NVIDIA Corp. | NAS | us_stock | USD |
| 2 | NAS:TSLA | TSLA | Tesla Inc. | NAS | us_stock | USD |
| 3 | NAS:AMD | AMD | Advanced Micro Devices Inc. | NAS | us_stock | USD |
| 4 | NAS:AAPL | AAPL | Apple Inc. | NAS | us_stock | USD |
| 5 | NAS:AMZN | AMZN | Amazon.com Inc. | NAS | us_stock | USD |
| 6 | NAS:MSFT | MSFT | Microsoft Corp. | NAS | us_stock | USD |
| 7 | NAS:GOOGL | GOOGL | Alphabet Inc. Class A | NAS | us_stock | USD |
| 8 | NAS:META | META | Meta Platforms Inc. | NAS | us_stock | USD |
| 9 | NAS:PLTR | PLTR | Palantir Technologies Inc. | NAS | us_stock | USD |
| 10 | NAS:INTC | INTC | Intel Corp. | NAS | us_stock | USD |
| 11 | NAS:SOFI | SOFI | SoFi Technologies Inc. | NAS | us_stock | USD |
| 12 | NAS:RIVN | RIVN | Rivian Automotive Inc. | NAS | us_stock | USD |
| 13 | NAS:MARA | MARA | MARA Holdings Inc. | NAS | us_stock | USD |
| 14 | NAS:WBD | WBD | Warner Bros. Discovery Inc. | NAS | us_stock | USD |
| 15 | NAS:CSCO | CSCO | Cisco Systems Inc. | NAS | us_stock | USD |
| 16 | NAS:MU | MU | Micron Technology Inc. | NAS | us_stock | USD |
| 17 | NAS:QCOM | QCOM | Qualcomm Inc. | NAS | us_stock | USD |
| 18 | NAS:PYPL | PYPL | PayPal Holdings Inc. | NAS | us_stock | USD |
| 19 | NAS:MSTR | MSTR | MicroStrategy Inc. | NAS | us_stock | USD |
| 20 | NAS:SMCI | SMCI | Super Micro Computer Inc. | NAS | us_stock | USD |
| 21 | NYS:F | F | Ford Motor Co. | NYS | us_stock | USD |
| 22 | NYS:BAC | BAC | Bank of America Corp. | NYS | us_stock | USD |
| 23 | NYS:PFE | PFE | Pfizer Inc. | NYS | us_stock | USD |
| 24 | NYS:T | T | AT&T Inc. | NYS | us_stock | USD |
| 25 | NYS:UBER | UBER | Uber Technologies Inc. | NYS | us_stock | USD |

## Final KIS Watchlist

```text
KIS_DOMESTIC_SYMBOLS=005930,000660,034020,010140,042660,005380,000270,035420,035720,068270,051910,066570,086520,247540,028300
```

```text
KIS_US_SYMBOLS=NAS:NVDA,NAS:TSLA,NAS:AMD,NAS:AAPL,NAS:AMZN,NAS:MSFT,NAS:GOOGL,NAS:META,NAS:PLTR,NAS:INTC,NAS:SOFI,NAS:RIVN,NAS:MARA,NAS:WBD,NAS:CSCO,NAS:MU,NAS:QCOM,NAS:PYPL,NAS:MSTR,NAS:SMCI,NYS:F,NYS:BAC,NYS:PFE,NYS:T,NYS:UBER
```

Watchlist count:

- Domestic stocks: 15
- US stocks: 25
- KIS stock watchlist total: 40
- KIS watchlist limit: 41
- Result: within the 41-symbol limit.

## Crypto Boundary

Binance `BTCUSDT` and `ETHUSDT` remain separate crypto assets under the Binance USD-settled crypto policy. They are not part of the 40-stock KIS watchlist.

## Provider Boundary

- At this historical universe gate, `provider_api` source eligibility was still closed for quote, execute, valuation, home, positions, assets, daily snapshot, ranking, settlement, and reward paths. Current eligibility is opened only for explicitly allowed read-only/quote workflows and operator-run daily portfolio snapshot valuation.
- This universe document does not open provider_api read eligibility.
- KIS market data is for external market-data collection verification only.
- KIS order, account, balance, fill, deposit, withdrawal, real-trading, and orderbook/hoga APIs are not implemented by this document.

## Secret Boundary

- No actual secret value is recorded here.
- `.env.local` contents are not recorded here.
- KIS app key, KIS app secret, approval key, `DATABASE_URL`, and raw WebSocket frames must not be copied into this document.

## 2026-05-30 Local Execution Status

- Security precheck passed: `.env.local` was ignored and untracked.
- KIS watchlist policy validation passed with domestic 15, US 25, total 40, max 41.
- After the local DB was started, all fixed 40 stock assets were upserted through `scripts/admin-upsert-asset.ts`.
- DB mapping verification passed:
  - Active domestic KRX/KRW `domestic_stock` mappings in the fixed list: 15/15.
  - Active US USD `us_stock` mappings in the fixed NAS/NYS list: 25/25.
  - KIS stock watchlist DB-backed total: 40, within the 41-symbol limit.
  - Binance `BTCUSDT` and `ETHUSDT` exist as separate active `BINANCE` USD crypto assets and are not included in the KIS stock watchlist.
- ExchangeRate dry-run succeeded for USD/KRW with `wouldCreate=1`.
- Binance dry-run succeeded for `BTCUSDT` and `ETHUSDT` with `wouldCreate=2`.
- KIS live smoke was not executed because the loaded env was still missing `KIS_REST_BASE_URL`, `KIS_WS_BASE_URL`, and explicit WebSocket policy values.
