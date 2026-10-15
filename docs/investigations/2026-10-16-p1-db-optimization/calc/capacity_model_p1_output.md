# Capacity model after P1 (calc/capacity_model_p1.py)

All values are model values in decimal GB (10^9). Inputs are tagged M/L/G in the script.
Price snapshots kept 14 days, futures Mark/Last 24 h, candles 5m 45 d / 4h 180 d,
KOSCOM order book collected (case 1: all history kept; case 2: a 14-day order-book retention,
which is NOT approved). Disk verdict: (size + 1.3 GB WAL headroom) / 50 GB.

## 1. Daily rows and retained (steady-state) sizes

| Phase | Price rows/day | Order-book rows/day | Futures rows/day | Price snapshots 14 d (full / slim) | Futures 24 h | Candles |
|---|---:|---:|---:|---:|---:|---:|
| Current (15/0/25/25) | 418,991 | 78,998 | 3,909,600 | 9.0 / 7.0 GB | 3.0 GB | 0.25 GB |
| KRX 70 | 638,223 | 368,656 | 3,909,600 | 12.9 / 10.6 GB | 3.0 GB | 0.34 GB |
| KRX 100 | 757,805 | 526,652 | 3,909,600 | 15.0 / 12.6 GB | 3.0 GB | 0.39 GB |
| Full target (100/100/100/100 + ETF 30 + index 10) | 2,265,300 | 605,650 | 15,638,400 | 46.5 / 38.1 GB | 11.8 GB | 1.29 GB |

## 2. Growth that no retention bounds (GB per day)

| Phase | Case 1: order book kept forever | of which order book | Case 2: order book 14 d |
|---|---:|---:|---:|
| Current (15/0/25/25) | 0.148 | 0.137 | 0.011 |
| KRX 70 | 0.660 | 0.639 | 0.020 |
| KRX 100 | 0.938 | 0.913 | 0.025 |
| Full target (100/100/100/100 + ETF 30 + index 10) | 1.105 | 1.050 | 0.055 |

## 3. Database size after N months, raw slim OFF (as deployed)

| Phase | Case | Month 0 (steady) | 3 months | 6 months | 12 months | 50 GB at 12 months |
|---|---|---:|---:|---:|---:|---|
| Current (15/0/25/25) | order book kept | 13.0 | 26.5 | 39.9 | 66.9 | over |
| Current (15/0/25/25) | order book 14 d | 14.6 | 15.6 | 16.6 | 18.5 | ok |
| KRX 70 | order book kept | 16.9 | 77.1 | 137.3 | 257.6 | over |
| KRX 70 | order book 14 d | 26.6 | 28.5 | 30.3 | 34.0 | warning |
| KRX 100 | order book kept | 19.1 | 104.7 | 190.2 | 361.4 | over |
| KRX 100 | order book 14 d | 33.2 | 35.5 | 37.7 | 42.3 | action |
| Full target (100/100/100/100 + ETF 30 + index 10) | order book kept | 60.4 | 161.2 | 262.1 | 463.7 | over |
| Full target (100/100/100/100 + ETF 30 + index 10) | order book 14 d | 76.7 | 81.7 | 86.8 | 96.8 | over |

## 4. Database size after N months, raw slim ON (after approval)

| Phase | Case | Month 0 (steady) | 3 months | 6 months | 12 months | 50 GB at 12 months |
|---|---|---:|---:|---:|---:|---|
| Current (15/0/25/25) | order book kept | 11.0 | 24.4 | 37.9 | 64.8 | over |
| Current (15/0/25/25) | order book 14 d | 12.6 | 13.5 | 14.5 | 16.5 | ok |
| KRX 70 | order book kept | 14.7 | 74.8 | 135.0 | 255.3 | over |
| KRX 70 | order book 14 d | 24.3 | 26.2 | 28.0 | 31.7 | warning |
| KRX 100 | order book kept | 16.7 | 102.3 | 187.8 | 359.0 | over |
| KRX 100 | order book 14 d | 30.8 | 33.1 | 35.3 | 39.9 | action |
| Full target (100/100/100/100 + ETF 30 + index 10) | order book kept | 52.0 | 152.8 | 253.6 | 455.3 | over |
| Full target (100/100/100/100 + ETF 30 + index 10) | order book 14 d | 68.3 | 73.3 | 78.4 | 88.4 | over |

## 5. WAL and delete workload (steady state)

WAL per inserted snapshot row: random v4 ids 5,377 B, time-ordered v7 ids 1,251 B (L: Mark steady state,
25 contracts, 6 checkpoints, retention running; evidence/uuid-v4-v7-wal-mark25.jsonl). Production today is
29.6 GB/day for ~4.4 M inserted rows/day (M: pg_stat_wal since 10-13). The v7 column applies the measured
ratio to all four snapshot tables (G: only Mark was measured).

| Phase | Snapshot rows inserted/day | Rows deleted/day (retention) | WAL/day v4 (model) | WAL/day v7 (model) |
|---|---:|---:|---:|---:|
| Current (15/0/25/25) | 4.41 M | 4.33 M | 29.7 GB | 6.9 GB |
| KRX 70 | 4.92 M | 4.55 M | 33.1 GB | 7.7 GB |
| KRX 100 | 5.19 M | 4.67 M | 34.9 GB | 8.1 GB |
| Full target (100/100/100/100 + ETF 30 + index 10) | 18.51 M | 17.90 M | 124.5 GB | 29.0 GB |

## 6. Today, before activation (no price retention): days to 80 % of 50 GB

- growth 0.71 GB/day from 8.55 GB: 80 % (40 GB) in about 43 days
