"""KOSCOM call-volume / freshness / throughput / DB-growth model for Trading
Class domestic stocks. Analysis only: no network, no DB, no KOSCOM.

Conservative unit assumptions (task 7.6):
  * ONE shared pool: 50,000 calls per quota day (resets 09:00 KST) and
    1,000,000 per month, for every endpoint and every gateway node;
  * month = the worst KRX month in the repo calendars 2026-2027:
    22 sessions + 9 non-trading days (31-day month);
  * every attempt that reaches the provider is billed (a retry = a call).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

DAILY_CAP = 50_000
MONTHLY_CAP = 1_000_000
SESSIONS_MONTH = 22
NON_TRADING_MONTH = 9
SESSION_S = 390 * 60
SESSION_MIN = 390
BATCH = 20
SPACING_PER_S = 1 / 0.2          # KOSCOM_MIN_REQUEST_INTERVAL_MS 200 -> 5 starts/s
CONCURRENCY = 2                  # KOSCOM_MAX_CONCURRENCY
EXECUTE_WINDOW_S = 10            # source-eligibility.policy.ts assetPriceExecute


def batches(kospi: int, kosdaq: int, konex: int = 0) -> int:
    return math.ceil(kospi / BATCH) + math.ceil(kosdaq / BATCH) + konex


def batch_range(n: int) -> tuple[int, int]:
    vals = [batches(k, n - k) for k in range(n + 1)]
    return min(vals), max(vals)


@dataclass
class Day:
    parts: dict = field(default_factory=dict)

    def add(self, name, trading, non_trading=0.0):
        self.parts[name] = (trading, non_trading)
        return self

    @property
    def trading(self):
        return sum(t for t, _ in self.parts.values())

    @property
    def non_trading(self):
        return sum(n for _, n in self.parts.values())

    def monthly(self):
        return SESSIONS_MONTH * self.trading + NON_TRADING_MONTH * self.non_trading


def cycles(period_s):
    return SESSION_S / period_s


# ------------------------------------------------------------ scenarios ----

def s0_production(n, b, cycle_s=3.0, retry=0.01, on_demand=0.0):
    """Recorded production flags (10-10/10-12): scheduler 3s timer, price+book,
    live candles off, sync limited to 12 ids (>=10 crypto), no KRX
    reconciliation/long sync. on_demand = user-triggered chart refresh calls."""
    d = Day()
    d.add('price', b * cycles(cycle_s))
    d.add('orderbook', b * cycles(cycle_s))
    d.add('on_demand_chart_refresh', on_demand, on_demand * 0.3)
    d.add('loc_evidence', n * 2)
    d.add('lists', 12, 12)
    d.add('retry_1pct', retry * (d.trading), retry * d.non_trading)
    return d


def s1_existing_full(n, b, cycle_s=3.0, retry=0.01, sync_runs=144):
    """Existing code, every domestic feature on (supervisor + sync incl. KRX +
    KRX reconciliation + long 4h)."""
    d = Day()
    d.add('price', b * cycles(cycle_s))
    d.add('orderbook', b * cycles(cycle_s))
    d.add('minute_refresh_1/min', n * 400)          # open < now < close+10m
    rph = sync_runs / 24
    d.add('sync_5m(09:00-24:00)', n * (1.6 * 6.5 * rph + 2 * 8.5 * rph))
    d.add('sync_1d(24/7)', n * sync_runs, n * sync_runs)
    d.add('sync_1w(24/7)', n * sync_runs, n * sync_runs)
    d.add('krx_reconciliation', n * 6)
    d.add('long_4h', n * 1)
    d.add('loc_evidence', n * 2)
    d.add('lists', 12, 12)
    d.add('retry_1pct', retry * d.trading, retry * d.non_trading)
    return d


def s2_gpt(n, b, retry=0.01):
    d = Day()
    d.add('price_6s', b * cycles(6.0))
    d.add('1m_batch_every_3m', n * math.ceil(400 / 3))
    d.add('1d_after_close', n * 1)
    d.add('long_4h', n * 1)
    d.add('post_close_repair', n * 0.5)
    d.add('loc_evidence', n * 2)
    d.add('lists', 12, 12)
    d.add('retry_1pct', retry * d.trading, retry * d.non_trading)
    return d


def r_recommended(n, b, price_s=5.0, minute_every=5, intraday_1d_every=0,
                  repair_cap=300, retry_candles=0.02):
    """Recommended: price-only fixed-rate (no retry inside a cycle), no book,
    1 intraday call per stock per completed 5m bucket (window = 2 buckets),
    post-close: final sweep + targeted repair (capped) + 1d + 1w + 4h,
    optional hourly in-progress 1d, LOC unchanged, no user-driven calls."""
    d = Day()
    d.add(f'price_{price_s:g}s', b * cycles(price_s))
    minute = n * (math.ceil(SESSION_MIN / minute_every) + 1)
    d.add(f'1m_per_{minute_every}m_bucket', minute)
    d.add('post_close_repair_cap', min(repair_cap, n * 3))
    if intraday_1d_every:
        d.add(f'1d_in_progress_every_{intraday_1d_every}m',
              n * math.ceil(SESSION_MIN / intraday_1d_every))
    d.add('1d_after_close(+10% retry)', n * 1.1)
    d.add('1w_after_close', n * 1)
    d.add('long_4h', n * 1)
    d.add('loc_evidence(max 2/stock)', n * 2)
    d.add('lists', 12, 12)
    d.add('candle_retry', retry_candles * minute)
    return d


def s4_minimal(n, b, price_s=8.0):
    d = Day()
    d.add('price_8s', b * cycles(price_s))
    d.add('post_close_1m_sweep(5 windows)', n * 5)
    d.add('1d_after_close', n * 1.1)
    d.add('1w_after_close', n * 1)
    d.add('long_4h', n * 1)
    d.add('loc_evidence', n * 2)
    d.add('lists', 12, 12)
    return d


# -------------------------------------------------------------- outputs ----

def fmt(x):
    return f'{x:,.0f}'


def table(title, scenario, ns=(15, 25, 50, 100), **kw):
    print(f'\n### {title}')
    print('| N | batch | trading-day calls | of 50k/day | worst month | of 1M/month |')
    print('|---:|---:|---:|---:|---:|---:|')
    for n in ns:
        lo, hi = batch_range(n)
        a, z = scenario(n, lo, **kw), scenario(n, hi, **kw)
        print(f'| {n} | {lo}–{hi} | {fmt(a.trading)}–{fmt(z.trading)} | '
              f'{a.trading / DAILY_CAP:.0%}–{z.trading / DAILY_CAP:.0%} | '
              f'{fmt(z.monthly())} | {z.monthly() / MONTHLY_CAP:.0%} |')


def breakdown(title, day):
    print(f'\n#### {title}')
    for k, (t, nt) in day.parts.items():
        print(f'  {k:34s} {fmt(t):>9s} / non-trading {fmt(nt):>7s}')
    print(f'  {"TOTAL":34s} {fmt(day.trading):>9s} / non-trading {fmt(day.non_trading):>7s}'
          f'  month {fmt(day.monthly())}')


def freshness_table():
    """Share of session time a liquid stock's latest snapshot passes the 10 s
    execute rule (exchange trade time, strict >). The worst gap between two
    captures of the same batch is T + J (J = collect-duration jitter); with
    trade-to-receipt lag L the snapshot is fresh for (10 - L) of every T + J."""
    print('\n### Execute-freshness (liquid stock): share of time fresh')
    lags = (0.5, 1.0, 2.0, 3.0, 4.0, 5.0)
    print('| schedule (worst gap) | ' + ' | '.join(f'L={l:g}s' for l in lags) + ' |')
    print('|---|' + '---:|' * len(lags))
    for label, gap in (('fixed 3s, J=1s (4s)', 4), ('fixed 5s, J=1.5s (6.5s)', 6.5),
                       ('fixed 6s, J=1.5s (7.5s)', 7.5), ('sleep-after 6s, D=1.5+J=1.5 (9s)', 9),
                       ('fixed 8s, J=1.5s (9.5s)', 9.5), ('fixed 10s, J=1.5s (11.5s)', 11.5)):
        row = [f'{max(0.0, min(1.0, (EXECUTE_WINDOW_S - lag) / gap)):.0%}' for lag in lags]
        print(f'| {label} | ' + ' | '.join(row) + ' |')
    print('  max tolerable lag for 100% freshness: T + J + L <= 10 s ->',
          {k: round(10 - v, 1) for k, v in (('3s', 4), ('5s', 6.5), ('6s', 7.5), ('8s', 9.5))})


def cycle_duration(b, latency_s, persist_per_batch_s=0.3, slots=CONCURRENCY):
    """Collect duration of one price cycle: batches are split over the slots;
    request starts are additionally spaced 0.2 s."""
    rounds = math.ceil(b / slots)
    return max(rounds * (latency_s + persist_per_batch_s), (b - 1) * 0.2 + latency_s + persist_per_batch_s)


def throughput(n, b, scenario):
    """Average provider request starts per second during the session and the
    share of the 5 starts/s spacing budget, plus the latency at which the
    2-slot concurrency becomes the limit."""
    d = scenario(n, b)
    session_calls = d.trading - sum(
        t for k, (t, _) in d.parts.items()
        if k.startswith(('post_close', '1d_after', '1w_after', 'long_4h',
                         'loc_', 'lists', 'krx_recon', 'sync_1d', 'sync_1w')))
    per_s = session_calls / SESSION_S
    l_max = CONCURRENCY / per_s
    return per_s, per_s / SPACING_PER_S, l_max


def db_growth(n, b, period_s, book=True, price_change_share=0.95,
              price_row_kb=(0.4, 2.0), book_row_kb=(0.9, 3.0)):
    cyc = cycles(period_s)
    price_rows = n * cyc * price_change_share
    book_rows = n * cyc if book else 0
    lo = price_rows * price_row_kb[0] + book_rows * book_row_kb[0]
    hi = price_rows * price_row_kb[1] + book_rows * book_row_kb[1]
    return price_rows, book_rows, lo / 1024, hi / 1024


def backfill(new_stocks, include_5m_days=0):
    four_h = new_stocks * 97        # 96 sessions + today, 1 x 10m call/session
    daily = new_stocks * 3          # 1y of D at 100 rows/page
    weekly = new_stocks * 1
    five_m = new_stocks * include_5m_days * 5  # 95-min windows, verified past-date path
    return four_h, daily, weekly, five_m


if __name__ == '__main__':
    print('N=100 batches by KOSPI/KOSDAQ split:',
          {f'{k}/{100 - k}': batches(k, 100 - k) for k in (100, 85, 80, 70, 61, 60, 50, 40)})
    print('current 15 (12 KOSPI/3 KOSDAQ, KIND):', batches(12, 3), 'batches')

    print('\n## Calls')
    table('S0 production as recorded, 3s cycle (upper)', s0_production)
    table('S0 production as recorded, 6s effective cycle', s0_production, cycle_s=6.0)
    table('S1 existing code, all domestic features on', s1_existing_full)
    table('S2 GPT proposal (price 6s, 1m every 3m)', s2_gpt)
    table('R recommended (price 5s, 1m per 5m bucket, in-progress 1d/1w composed from 5m)', r_recommended)
    table('R variant price 6s', r_recommended, price_s=6.0)
    table('R variant price 4s + 1m per 10m', r_recommended, price_s=4.0, minute_every=10)
    table('R variant price 5s + hourly in-progress 1d call', r_recommended, intraday_1d_every=60)
    table('R variant price 5s + 1m every 3m', r_recommended, minute_every=3)
    table('S4 minimal (price 8s, candles after close only)', s4_minimal)

    for n in (15, 100):
        lo, hi = batch_range(n)
        breakdown(f'S1 N={n} batches={hi}', s1_existing_full(n, hi))
        breakdown(f'R  N={n} batches={hi}', r_recommended(n, hi))
        breakdown(f'R  N={n} batches={lo}', r_recommended(n, lo))

    # on-demand ceiling: one sync per asset/feed per 60 s
    print('\n## User-driven on-demand ceiling (current managed serving, 60 s freshness)')
    for n in (15, 100):
        five_m = n * SESSION_MIN * 1.5        # 1-2 windows per incremental 5m refresh
        period = n * 2 * 1440                 # 1d + 1w, 24 h, 1 call each
        print(f'  N={n}: 5m session ceiling {fmt(five_m)}/day, 1d+1w ceiling {fmt(period)}/day')

    freshness_table()

    print('\n## Throughput during the session (avg starts/s, share of 5/s, max mean latency for 2 slots)')
    for name, sc in (('S1', s1_existing_full), ('S2', s2_gpt), ('R', r_recommended)):
        for n in (15, 100):
            lo, hi = batch_range(n)
            per_s, share, lmax = throughput(n, hi, sc)
            print(f'  {name} N={n} b={hi}: {per_s:.2f}/s = {share:.0%} of spacing; '
                  f'2 slots saturate when mean latency > {lmax:.2f}s')
    # minute-boundary burst in S1: price+book at 3s plus 100 intraday calls
    print('  S1 N=100 1st 20 s after each minute: demand',
          f'{(12 / 3) + 100 / 20:.1f}/s vs 5/s cap')

    print('\n## Price-cycle duration D (6 batches, 2 slots, 0.3 s persist/batch)')
    for lat in (0.15, 0.3, 0.6, 1.0, 1.5):
        print(f'  mean latency {lat}s -> D = {cycle_duration(6, lat):.1f}s (5 batches: {cycle_duration(5, lat):.1f}s)')

    print('\n## Batches by split for N=25/50 (KONEX excluded)')
    for n in (25, 50):
        print(f'  N={n}:', {f'{k}/{n - k}': batches(k, n - k) for k in range(0, n + 1, 5)})

    print('\n## DB rows/day and size (price row 0.4-2.0 KB, book row 0.9-3.0 KB incl. indexes; unmeasured)')
    for label, n, b, per, book in (('S0 15@3s', 15, 2, 3, True), ('S0 100@3s', 100, 6, 3, True),
                                   ('S0 100@6s', 100, 6, 6, True), ('R 100@5s', 100, 6, 5, False),
                                   ('R 100@5s slim 0.35-0.6KB', 100, 6, 5, False)):
        if 'slim' in label:
            pr, br, lo, hi = db_growth(n, b, per, book, price_row_kb=(0.35, 0.6))
        else:
            pr, br, lo, hi = db_growth(n, b, per, book)
        print(f'  {label:26s} price rows {fmt(pr):>9s}  book rows {fmt(br):>9s}  '
              f'{lo:,.0f}-{hi:,.0f} MB/day')
    for n in (15, 100):
        sync_rows = n * 3 * 144
        print(f'  sync-state rows/day if KRX in 10-min sync (N={n}): {fmt(sync_rows)}')
    print(f'  5m candle rows/day N=100: {fmt(100 * 76)}; 4h rows/day: {fmt(100 * 2)}')

    print('\n## One-off backfill for 15 -> 100 (85 new stocks)')
    f4, fd, fw, f5 = backfill(85)
    print(f'  4h(97 sessions) {fmt(f4)}, 1d {fmt(fd)}, 1w {fmt(fw)}, total {fmt(f4 + fd + fw)}')
    f4, fd, fw, f5 = backfill(85, include_5m_days=10)
    print(f'  optional verified 5m 10 sessions: {fmt(f5)} (requires a past-date 1m path)')
    for label, day_use in (('weekday night (R@100 on that quota day)', r_recommended(100, 6).trading),
                           ('weekend quota day', 12)):
        headroom = DAILY_CAP * 0.85 - day_use
        print(f'  {label}: headroom at 85% of daily cap = {fmt(headroom)}')

    print('\n## Largest universe within 80% of the worst-month cap (recommended shape)')
    print('| price T | 1m cadence | N_max best split | N_max worst split | month at N=100 best/worst |')
    print('|---|---|---:|---:|---:|')
    for t in (4.0, 5.0, 6.0):
        for every in (5, 10):
            best = worst = 0
            for n in range(1, 201):
                lo_b, hi_b = batch_range(n)
                if r_recommended(n, lo_b, price_s=t, minute_every=every).monthly() <= 0.8 * MONTHLY_CAP:
                    best = n
                if r_recommended(n, hi_b, price_s=t, minute_every=every).monthly() <= 0.8 * MONTHLY_CAP:
                    worst = n
            lo_b, hi_b = batch_range(100)
            a = r_recommended(100, lo_b, price_s=t, minute_every=every).monthly()
            z = r_recommended(100, hi_b, price_s=t, minute_every=every).monthly()
            print(f'| {t:g}s | {every}m | {best} | {worst} | {a / MONTHLY_CAP:.0%} / {z / MONTHLY_CAP:.0%} |')
