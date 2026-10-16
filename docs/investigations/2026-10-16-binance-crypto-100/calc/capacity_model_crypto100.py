#!/usr/bin/env python3
"""Capacity model for the Binance Spot 100 + USDⓈ-M 100 catalog with the
display-only 60 s order-book history (2026-10-16). Standard library only.

Run: python3 -I capacity_model_crypto100.py > capacity_model_crypto100_output.md

It reuses the P1 model's production-measured constants (M) and adds what this
work measured locally on PostgreSQL 17 with real Binance books (L). Tags:
  M = production read-only measurement (P1/audit), L = local measurement (this
  work), G = assumption. Sizes are decimal GB (10^9).
"""
import runpy
from pathlib import Path

P1 = runpy.run_path(str(Path(__file__).resolve().parents[2]
                        / '2026-10-16-p1-db-optimization/calc/capacity_model_p1.py'))
U = dict(P1['U'])
GB, MONTH = P1['GB'], P1['MONTH']
KRX_SESSIONS = P1['KRX_SESSIONS']
WAL_HEADROOM_GB = P1['WAL_HEADROOM_GB']

# L: 100 + 100 soak, real Binance, 2026-10-16 (evidence/soak/)
MEASURED = {
    'spot_price_rows_per_asset_s': 0.155,   # L: 930 rows/min for 100 assets (5 s throttle)
    'mark_rows_per_contract_s': 1.00,       # L: 6,000 rows/min for 100 contracts
    'last_rows_per_contract_s': 0.537,      # L: 3,222 rows/min (thinner new contracts)
}
# L: bytes per stored history row incl. its primary key, real books (filled from the soak)
BOOK = {
    'spot_row': 870.0,      # L: soak end, pg_total_relation_size / rows (5,857 real rows)
    'futures_row': 673.0,   # L: soak end (6,070 real rows)
    'spot_wal': 947.5,      # L: format bench, json pairs + (minute, product) key
    'futures_wal': 737.7,
}
HISTORY_ROWS_DAY = 200 * 1440   # 100 + 100 products, one row a minute (upper bound)
HISTORY_DAYS = 14

PHASES = [
    # name, krx, crypto spot, futures
    ('Before (KRX 15 / Spot 25 / USDⓈ-M 25)', 15, 25, 25),
    ('This change (KRX 15 / Spot 100 / USDⓈ-M 100)', 15, 100, 100),
]


def rows_day(krx, spot, fut, measured):
    crypto = spot * (MEASURED['spot_price_rows_per_asset_s'] * 86_400 if measured else U['crypto_rows_day'])
    mark = fut * (MEASURED['mark_rows_per_contract_s'] * 86_400 if measured else U['fut_mark_rows_day'])
    last = fut * (MEASURED['last_rows_per_contract_s'] * 86_400 if measured else U['fut_last_rows_day'])
    krx_price = krx * U['krx_price_rows_session'] * KRX_SESSIONS
    book = krx * U['krx_book_rows_session'] * KRX_SESSIONS
    return dict(crypto=crypto, mark=mark, last=last, krx=krx_price, koscom_book=book)


def steady_gb(phase, measured, slim, history):
    _, krx, spot, fut = phase
    r = rows_day(krx, spot, fut, measured)
    crypto_row = U['crypto_row_full'] + (U['crypto_slim_delta'] if slim else 0)
    krx_row = U['krx_price_row_full'] + (U['krx_slim_delta'] if slim else 0)
    prices = (r['crypto'] * crypto_row + r['krx'] * krx_row) * 14 * U['retained_overhead'] / GB
    futures = (r['mark'] * U['fut_mark_row'] + r['last'] * U['fut_last_row']) / GB
    candles = (spot * (288 * 45 + 6 * 180) + krx * (76 * 45 + 2 * 180) * KRX_SESSIONS) * U['candle_row'] / GB
    book_history = 0.0
    if history and spot == 100:
        per_row = (BOOK['spot_row'] + BOOK['futures_row']) / 2
        book_history = HISTORY_ROWS_DAY * HISTORY_DAYS * per_row * U['retained_overhead'] / GB
    return dict(prices=prices, futures=futures, candles=candles, book_history=book_history,
                total=prices + futures + candles + book_history + 0.15)


def unbounded_gb_day(phase):
    """KOSCOM order book (no retention), 1d/1w candles, sync states, Ops runs."""
    _, krx, spot, fut = phase
    r = rows_day(krx, spot, fut, False)
    scale = (spot + krx + 25) / 40
    return (r['koscom_book'] * U['book_row']
            + (spot + krx * KRX_SESSIONS) * 1.2 * U['candle_row']
            + U['sync_rows_day_now'] * scale * U['sync_row']
            + U['ops_rows_day_now'] * max(1, scale ** 0.5) * U['ops_row']) / GB


def f(x, d=1):
    return f'{x:,.{d}f}'


def main():
    assert BOOK['spot_row'] and BOOK['futures_row'], 'fill the measured history row sizes'
    print('# Capacity model: Spot 100 + USDⓈ-M 100 with the 60 s order-book history\n')
    print('Decimal GB. Price snapshots kept 14 days (retention ON), Mark/Last 24 h, candles 5m 45 d / 4h 180 d,')
    print('order-book history 14 days. KOSCOM order books stay unbounded (no approved retention).')
    print('"P1" columns use the production-measured per-asset rates; "L" the 100 + 100 local soak rates.\n')
    print('## 1. Steady state (GB)\n')
    print('| Phase | Rates | Price snapshots (raw full / slim) | Mark + Last 24 h | Candles | Order-book history | Total (full / slim) |')
    print('|---|---|---:|---:|---:|---:|---:|')
    for ph in PHASES:
        for measured in (False, True):
            full = steady_gb(ph, measured, False, True)
            slim = steady_gb(ph, measured, True, True)
            print(f'| {ph[0]} | {"L" if measured else "P1"} | {f(full["prices"])} / {f(slim["prices"])} | {f(full["futures"])} '
                  f'| {f(full["candles"], 2)} | {f(full["book_history"], 2)} | {f(full["total"])} / {f(slim["total"])} |')
    print()
    print('## 2. Daily inflow (GB/day) and history alone\n')
    ph = PHASES[1]
    r = rows_day(15, 100, 100, True)
    hist_day = HISTORY_ROWS_DAY * (BOOK['spot_row'] + BOOK['futures_row']) / 2 / GB
    print(f'- Order-book history: {HISTORY_ROWS_DAY:,} rows/day, {f(hist_day, 3)} GB/day, '
          f'{f(hist_day * HISTORY_DAYS * U["retained_overhead"], 2)} GB at 14 days (incl. {U["retained_overhead"]:.2f} dead-tuple/slack factor)')
    print(f'- Order-book history WAL: {f(HISTORY_ROWS_DAY * (BOOK["spot_wal"] + BOOK["futures_wal"]) / 2 / GB, 3)} GB/day of inserts (deletes add their own records)')
    print(f'- Spot price snapshots at 100 (L rate): {f(r["crypto"] / 1e6, 2)} M rows/day, {f(r["crypto"] * U["crypto_row_full"] / GB, 2)} GB/day before retention')
    print(f'- Mark + Last at 100 (L rate): {f((r["mark"] + r["last"]) / 1e6, 2)} M rows/day (24 h window)')
    print(f'- Unbounded growth (KOSCOM book, 1d/1w candles, sync, Ops): {f(unbounded_gb_day(ph), 3)} GB/day\n')
    print('## 3. Database size after N months (P1 rates, raw full / slim) and disk verdicts\n')
    print('| Phase | Month 0 | 6 months | 12 months | 50 GB (80 % = 40 GB) at 12 months | Disk for ≤ 60 % at 12 months |')
    print('|---|---:|---:|---:|---|---:|')
    for ph in PHASES:
        for slim in (False, True):
            s0 = steady_gb(ph, False, slim, True)['total']
            sizes = [s0 + unbounded_gb_day(ph) * MONTH * m for m in (0, 6, 12)]
            use = (sizes[-1] + WAL_HEADROOM_GB) / 50
            verdict = 'over' if use >= 1 else 'critical' if use >= .9 else 'action' if use >= .8 else 'warning' if use >= .6 else 'ok'
            need = (sizes[-1] + WAL_HEADROOM_GB) / 0.6
            print(f'| {ph[0]} ({"slim" if slim else "full"}) | {f(sizes[0])} | {f(sizes[1])} | {f(sizes[2])} | {verdict} | {f(need, 0)} GB |')
    print()
    print('Without the price retention (ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false) Spot 100 alone adds '
          f'{f(rows_day(15, 100, 100, False)["crypto"] * U["crypto_row_full"] / GB, 2)} GB/day of price rows.')


if __name__ == '__main__':
    main()
