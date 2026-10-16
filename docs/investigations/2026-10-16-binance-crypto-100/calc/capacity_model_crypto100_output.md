# Capacity model: Spot 100 + USDⓈ-M 100 with the 60 s order-book history

Decimal GB. Price snapshots kept 14 days (retention ON), Mark/Last 24 h, candles 5m 45 d / 4h 180 d,
order-book history 14 days. KOSCOM order books stay unbounded (no approved retention).
"P1" columns use the production-measured per-asset rates; "L" the 100 + 100 local soak rates.

## 1. Steady state (GB)

| Phase | Rates | Price snapshots (raw full / slim) | Mark + Last 24 h | Candles | Order-book history | Total (full / slim) |
|---|---|---:|---:|---:|---:|---:|
| Before (KRX 15 / Spot 25 / USDⓈ-M 25) | P1 | 9.0 / 7.0 | 3.0 | 0.25 | 0.00 | 12.4 / 10.4 |
| Before (KRX 15 / Spot 25 / USDⓈ-M 25) | L | 8.5 / 6.6 | 2.5 | 0.25 | 0.00 | 11.4 / 9.5 |
| This change (KRX 15 / Spot 100 / USDⓈ-M 100) | P1 | 33.0 / 25.0 | 11.8 | 0.93 | 3.58 | 49.5 / 41.5 |
| This change (KRX 15 / Spot 100 / USDⓈ-M 100) | L | 30.8 / 23.4 | 10.0 | 0.93 | 3.58 | 45.5 / 38.1 |

## 2. Daily inflow (GB/day) and history alone

- Order-book history: 288,000 rows/day, 0.222 GB/day, 3.58 GB at 14 days (incl. 1.15 dead-tuple/slack factor)
- Order-book history WAL: 0.243 GB/day of inserts (deletes add their own records)
- Spot price snapshots at 100 (L rate): 1.34 M rows/day, 1.85 GB/day before retention
- Mark + Last at 100 (L rate): 13.28 M rows/day (24 h window)
- Unbounded growth (KOSCOM book, 1d/1w candles, sync, Ops): 0.164 GB/day

## 3. Database size after N months (P1 rates, raw full / slim) and disk verdicts

| Phase | Month 0 | 6 months | 12 months | 50 GB (80 % = 40 GB) at 12 months | Disk for ≤ 60 % at 12 months |
|---|---:|---:|---:|---|---:|
| Before (KRX 15 / Spot 25 / USDⓈ-M 25) (full) | 12.4 | 40.2 | 67.9 | over | 115 GB |
| Before (KRX 15 / Spot 25 / USDⓈ-M 25) (slim) | 10.4 | 38.1 | 65.9 | over | 112 GB |
| This change (KRX 15 / Spot 100 / USDⓈ-M 100) (full) | 49.5 | 79.5 | 109.5 | over | 185 GB |
| This change (KRX 15 / Spot 100 / USDⓈ-M 100) (slim) | 41.5 | 71.5 | 101.5 | over | 171 GB |

Without the price retention (ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false) Spot 100 alone adds 1.98 GB/day of price rows.
