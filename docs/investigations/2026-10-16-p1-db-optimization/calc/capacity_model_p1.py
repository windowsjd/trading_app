#!/usr/bin/env python3
"""Trading Class DB capacity model after P1 (2026-10-16). Standard library only.

Run: python3 -I capacity_model_p1.py > capacity_model_p1_output.md

Source tags in comments:
  M = production read-only measurement (audit 2026-10-15, P1 sample 2026-10-15 20:40Z)
  L = local isolated PostgreSQL 17 measurement (this P1 work, evidence/)
  G = assumption (not operated yet, or a policy not approved yet)
Only optimizations that are implemented AND verified enter the numbers:
  - asset_price_snapshots 14-day retention (implemented, verified at production scale; activation pending)
  - Binance WS ticker slim raw profile (implemented, -343 B/row measured; activation pending)
  - KOSCOM price slim raw profile (existing switch, -65 B/row measured; activation pending)
  - UUID v7 ids on the four snapshot tables (implemented; WAL effect measured on Mark only)
Not counted: index removal, partitioning, orderbook slimming (measured counterproductive),
orderbook retention (needs approval; shown as a separate case).
"""

MB = 1_000_000
GB = 1_000_000_000
MONTH = 30.4
KRX_SESSIONS = 249 / 365  # G: KRX trading days per calendar day
US_SESSIONS = 251 / 365   # G: NYSE trading days per calendar day

U = {
    # rows per asset
    'crypto_rows_day': 14_368,         # M: audit, 5 s heartbeat (stored every ~6 s)
    'krx_price_rows_session': 5_843,   # M: audit TABLESAMPLE, KOSCOM 3 s poll
    'krx_book_rows_session': 7_720,    # M: audit, every price cycle
    'us_rows_session': 4_680,          # G: regular session 6.5 h at the 5 s heartbeat
    'fut_mark_rows_day': 0.97 * 86_400,  # M: audit
    'fut_last_rows_day': 0.84 * 86_400,  # M: audit
    # stored bytes per row, heap + indexes
    'crypto_row_full': 1_381,          # M: audit incremental growth per Binance row
    'crypto_slim_delta': -343,         # L: raw-profile-row-bytes-pg17.json (1,229 -> 886)
    'krx_price_row_full': 1_088,       # M: audit (695 row + 45 page + 348 index)
    'krx_slim_delta': -65,             # L: (948 -> 883)
    'us_row_full': 1_100,              # G: KIS/Tiingo raw unknown; close to KOSCOM
    'book_row': 611.1 * MB / 352_366,  # M: P1 sample, asset_orderbook_snapshots total / rows
    'fut_mark_row': 1_572.8 * MB / 2_105_974,  # M: P1 sample (with 24 h churn bloat)
    'fut_last_row': 1_278.5 * MB / 1_660_019,  # M: P1 sample
    'candle_row': 646,                 # M: audit
    'sync_row': 473,                   # M: audit
    'ops_row': 1_720,                  # M: audit
    # rows per day of the small growth tables
    'sync_rows_day_now': 9_500,        # M: P1 sample, sync states written per day (25 crypto + 15 KRX)
    'ops_rows_day_now': 3_300 + 288,   # M: P1 sample + G: the new 5-minute retention runs
    # retention steady-state overhead: dead tuples between autovacuums, page slack
    'retained_overhead': 1.15,         # G: autovacuum at 20 % dead -> ~10 % mean, plus slack
}
DB_NOW_GB = 8_554_272_435 / GB  # M: pg_database_size 2026-10-15 20:40Z
DISK_GB = 50
WAL_HEADROOM_GB = 1.3            # M: max_wal_size 1,280 MB
RETENTION_DAYS = 14

PHASES = [
    # name, krx, us, crypto, futures, krx_etf, us_etf, index
    ('Current (15/0/25/25)', 15, 0, 25, 25, 0, 0, 0),
    ('KRX 70', 70, 0, 25, 25, 0, 0, 0),
    ('KRX 100', 100, 0, 25, 25, 0, 0, 0),
    ('Full target (100/100/100/100 + ETF 30 + index 10)', 100, 100, 100, 100, 15, 15, 10),
]


def daily_rows(ph):
    _, krx, us, crypto, fut, ketf, uetf, idx = ph
    return {
        'crypto': crypto * U['crypto_rows_day'],
        'krx': (krx + ketf) * U['krx_price_rows_session'] * KRX_SESSIONS,
        'us': (us + uetf) * U['us_rows_session'] * US_SESSIONS,
        'book': (krx + ketf) * U['krx_book_rows_session'] * KRX_SESSIONS,
        'mark': fut * U['fut_mark_rows_day'],
        'last': fut * U['fut_last_rows_day'],
    }


def snapshot_steady_gb(ph, slim):
    r = daily_rows(ph)
    crypto = U['crypto_row_full'] + (U['crypto_slim_delta'] if slim else 0)
    krx = U['krx_price_row_full'] + (U['krx_slim_delta'] if slim else 0)
    per_day = r['crypto'] * crypto + r['krx'] * krx + r['us'] * U['us_row_full']
    return per_day * RETENTION_DAYS * U['retained_overhead'] / GB


def futures_steady_gb(ph):
    r = daily_rows(ph)
    return (r['mark'] * U['fut_mark_row'] + r['last'] * U['fut_last_row']) / GB


def candle_steady_gb(ph):
    """5m 45 days, 4h 180 days, 1d/1w kept (retention job enabled)."""
    _, krx, us, crypto, _f, ketf, uetf, idx = ph
    rows = (crypto * (288 * 45 + 6 * 180)
            + (krx + ketf) * (76 * 45 * KRX_SESSIONS + 2 * 180 * KRX_SESSIONS)
            + (us + uetf + idx) * 78 * 45 * US_SESSIONS)
    return rows * U['candle_row'] / GB


def unbounded_daily_gb(ph, book_retained):
    """Tables that keep growing without a retention: 1d/1w candles, sync states,
    Ops runs and (case 1) the KOSCOM order book."""
    _, krx, us, crypto, _f, ketf, uetf, idx = ph
    scale = (crypto + krx + ketf + us + uetf) / 40  # G: sync/ops grow with the asset count
    r = daily_rows(ph)
    daily = ((crypto + (krx + ketf + us + uetf + idx) * KRX_SESSIONS) * 1.2 * U['candle_row']
             + U['sync_rows_day_now'] * scale * U['sync_row']
             + U['ops_rows_day_now'] * max(1, scale ** 0.5) * U['ops_row'])
    if not book_retained:
        daily += r['book'] * U['book_row']
    return daily / GB


def book_steady_gb(ph, days):
    return daily_rows(ph)['book'] * U['book_row'] * days * U['retained_overhead'] / GB


def other_now_gb():
    # M: everything outside the modelled tables today (users, finance, FX, small tables)
    return 0.15


def size_after(ph, months, slim, book_case):
    steady = snapshot_steady_gb(ph, slim) + futures_steady_gb(ph) + candle_steady_gb(ph) + other_now_gb()
    if book_case == 'keep_all':
        existing_book = 611.1 * MB / GB  # M: today's rows stay (no approved deletion)
        return steady + existing_book + unbounded_daily_gb(ph, False) * MONTH * months
    # Case 2 prunes today's order-book rows too once they pass the window.
    return steady + book_steady_gb(ph, int(book_case)) + unbounded_daily_gb(ph, True) * MONTH * months


def verdict(gb):
    use = (gb + WAL_HEADROOM_GB) / DISK_GB
    return 'over' if use >= 1 else ('critical' if use >= 0.9 else ('action' if use >= 0.8 else ('warning' if use >= 0.6 else 'ok')))


def f(x, d=1):
    return f'{x:,.{d}f}'


def main():
    print('# Capacity model after P1 (calc/capacity_model_p1.py)\n')
    print('All values are model values in decimal GB (10^9). Inputs are tagged M/L/G in the script.')
    print(f'Price snapshots kept {RETENTION_DAYS} days, futures Mark/Last 24 h, candles 5m 45 d / 4h 180 d,')
    print('KOSCOM order book collected (case 1: all history kept; case 2: a 14-day order-book retention,')
    print('which is NOT approved). Disk verdict: (size + 1.3 GB WAL headroom) / 50 GB.\n')
    print('## 1. Daily rows and retained (steady-state) sizes\n')
    print('| Phase | Price rows/day | Order-book rows/day | Futures rows/day | Price snapshots 14 d (full / slim) | Futures 24 h | Candles |')
    print('|---|---:|---:|---:|---:|---:|---:|')
    for ph in PHASES:
        r = daily_rows(ph)
        print(f'| {ph[0]} | {f(r["crypto"] + r["krx"] + r["us"], 0)} | {f(r["book"], 0)} | {f(r["mark"] + r["last"], 0)} '
              f'| {f(snapshot_steady_gb(ph, False))} / {f(snapshot_steady_gb(ph, True))} GB | {f(futures_steady_gb(ph))} GB | {f(candle_steady_gb(ph), 2)} GB |')
    print()
    print('## 2. Growth that no retention bounds (GB per day)\n')
    print('| Phase | Case 1: order book kept forever | of which order book | Case 2: order book 14 d |')
    print('|---|---:|---:|---:|')
    for ph in PHASES:
        print(f'| {ph[0]} | {f(unbounded_daily_gb(ph, False), 3)} | {f(daily_rows(ph)["book"] * U["book_row"] / GB, 3)} | {f(unbounded_daily_gb(ph, True), 3)} |')
    print()
    for slim in (False, True):
        print(f'## {3 if not slim else 4}. Database size after N months, raw slim {"OFF (as deployed)" if not slim else "ON (after approval)"}\n')
        print('| Phase | Case | Month 0 (steady) | 3 months | 6 months | 12 months | 50 GB at 12 months |')
        print('|---|---|---:|---:|---:|---:|---|')
        for ph in PHASES:
            for case, label in (('keep_all', 'order book kept'), ('14', 'order book 14 d')):
                sizes = [size_after(ph, m, slim, case) for m in (0, 3, 6, 12)]
                print(f'| {ph[0]} | {label} | ' + ' | '.join(f(s) for s in sizes) + f' | {verdict(sizes[-1])} |')
        print()
    print('## 5. WAL and delete workload (steady state)\n')
    print('WAL per inserted snapshot row: random v4 ids 5,377 B, time-ordered v7 ids 1,251 B (L: Mark steady state,')
    print('25 contracts, 6 checkpoints, retention running; evidence/uuid-v4-v7-wal-mark25.jsonl). Production today is')
    print('29.6 GB/day for ~4.4 M inserted rows/day (M: pg_stat_wal since 10-13). The v7 column applies the measured')
    print('ratio to all four snapshot tables (G: only Mark was measured).\n')
    print('| Phase | Snapshot rows inserted/day | Rows deleted/day (retention) | WAL/day v4 (model) | WAL/day v7 (model) |')
    print('|---|---:|---:|---:|---:|')
    per_row_now = 29.6 * GB / 4.4e6  # M: all WAL per inserted snapshot row today
    for ph in PHASES:
        r = daily_rows(ph)
        ins = r['crypto'] + r['krx'] + r['us'] + r['book'] + r['mark'] + r['last']
        dele = r['crypto'] + r['krx'] + r['us'] + r['mark'] + r['last']
        print(f'| {ph[0]} | {f(ins / 1e6, 2)} M | {f(dele / 1e6, 2)} M | {f(ins * per_row_now / GB)} GB | {f(ins * per_row_now * 1_251 / 5_377 / GB)} GB |')
    print()
    print('## 6. Today, before activation (no price retention): days to 80 % of 50 GB\n')
    ph = PHASES[0]
    r = daily_rows(ph)
    today_daily = (r['crypto'] * U['crypto_row_full'] + r['krx'] * U['krx_price_row_full']) / GB + unbounded_daily_gb(ph, False)
    print(f'- growth {f(today_daily, 2)} GB/day from {f(DB_NOW_GB, 2)} GB: 80 % (40 GB) in about {f((40 - WAL_HEADROOM_GB - DB_NOW_GB) / today_daily, 0)} days')


if __name__ == '__main__':
    main()
