"""KOSCOM call-volume / freshness / throughput / DB-growth model for Trading
Class domestic stocks. Analysis only: no network, no DB, no KOSCOM.

Conservative unit assumptions (unchanged since v1):
  * ONE shared pool: 50,000 calls per quota day (resets 09:00 KST) and
    1,000,000 per month, for every endpoint and every gateway node;
  * month = the worst calendar month in the repo KRX calendars 2026-2027:
    22 sessions + 9 non-trading days. If the monthly cap turns out to be a
    rolling window, a 31-day window can hold 23 sessions (krx_sessions.py §5);
  * every attempt that reaches the provider is billed (a retry = a call).

v2 (cross-review, 2026-10-15): final design F replaces v1's R. F = price-only
fixed-rate cluster slot with no in-cycle retry; one checkpointed intraday 1m
call per stock per completed 5m bucket; post-close 1d (+ bounded retry), 4h
long sync with held back-off; 1w only weekly and only until the app drops the
tab; no user-driven KOSCOM calls. Each day is split into a NORMAL day and a
BOUNDED WORST day (every cap hit, 20% of non-price calls retried), and calls
carry the cross-review priority (P1 price .. P4 optional) used by the budget
governor. v1 scenarios (S0/S1/S2/R) are kept unchanged for comparison.
"""
from __future__ import annotations

import bisect
import math
import random
from dataclasses import dataclass, field

DAILY_CAP = 50_000
MONTHLY_CAP = 1_000_000
SESSIONS_MONTH = 22              # worst calendar month 2026-2027 (krx_sessions.py §1)
NON_TRADING_MONTH = 9
SESSIONS_ROLLING_31 = 23         # worst rolling 31-day window (krx_sessions.py §5)
SESSION_S = 390 * 60
SESSION_MIN = 390
BATCH = 20
SPACING_PER_S = 1 / 0.2          # KOSCOM_MIN_REQUEST_INTERVAL_MS 200 -> 5 starts/s
CONCURRENCY = 2                  # KOSCOM_MAX_CONCURRENCY
EXECUTE_WINDOW_S = 10            # source-eligibility.policy.ts assetPriceExecute
TICKS = 79                       # completed-5m-bucket ticks 09:05..15:30 (78) + 1
HEADROOM_GB = 10.0 - 7.40        # GPT observation: 10 GB disk, ~7.40 GB used


def batches(kospi: int, kosdaq: int, konex: int = 0) -> int:
    return math.ceil(kospi / BATCH) + math.ceil(kosdaq / BATCH) + konex


def batch_range(n: int) -> tuple[int, int]:
    vals = [batches(k, n - k) for k in range(n + 1)]
    return min(vals), max(vals)


@dataclass
class Day:
    parts: dict = field(default_factory=dict)

    def add(self, name, trading, non_trading=0.0, prio=0):
        self.parts[name] = (trading, non_trading, prio)
        return self

    @property
    def trading(self):
        return sum(t for t, _, _ in self.parts.values())

    @property
    def non_trading(self):
        return sum(n for _, n, _ in self.parts.values())

    def monthly(self, sessions=SESSIONS_MONTH, non_trading=NON_TRADING_MONTH):
        return sessions * self.trading + non_trading * self.non_trading

    def by_priority(self):
        out = {}
        for t, _, p in self.parts.values():
            out[p] = out.get(p, 0) + t
        return out


def cycles(period_s):
    return SESSION_S / period_s


# ------------------------------------------------- v1 scenarios (kept) ----

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
    """v1 recommendation R (superseded by final_design, kept for comparison)."""
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


# ------------------------------------------------- v2 final design F ------

def final_design(n, b, price_s=5.0, worst=False, weekly=True, minute_every=5):
    """F. Priorities: P1 price (+ market lists it cannot run without),
    P2 financial evidence (confirmed 1d, LOC, close recovery), P3 regular
    candles (intraday 1m, same-day gap repair), P4 optional (4h long, 1w).
    Price is never retried inside a cycle (the next slot is the retry), so
    retries apply to non-price calls only: 1% normal, 20% worst."""
    r = 0.20 if worst else 0.01
    ticks = TICKS if minute_every == 5 else math.ceil(SESSION_MIN / minute_every) + 1
    d = Day()
    d.add(f'P1 price {price_s:g}s', b * cycles(price_s), 0, 1)
    lists = 144 if worst else 12                # worst: failed list, 30-min back-off
    d.add('P1 market lists', lists * (1 + r), lists * (1 + r), 1)
    d.add('P2 1d post-close', n * (3 if worst else 1.1) * (1 + r), 0, 2)
    d.add('P2 LOC evidence', n * (33 if worst else 2) * (1 + r), 0, 2)
    d.add('P2 recoverClose (cap 3/stock)', (n * 3 if worst else 0) * (1 + r), 0, 2)
    d.add(f'P3 1m per completed {minute_every}m bucket', n * ticks * (1 + r), 0, 3)
    d.add('P3 same-day gap repair (cap 300)',
          (min(300, n * 3) if worst else n * 0.05) * (1 + r), 0, 3)
    d.add('P4 4h long sync', n * (2 if worst else 1) * (1 + r), 0, 4)
    if weekly:
        d.add('P4 1w weekly (until app drops tab)', n / 5 * (1 + r), 0, 4)
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


def final_table(price_s, weekly=True):
    print(f'\n### F, price {price_s:g}s, 1w weekly {"on" if weekly else "off"}: normal and bounded-worst day (6 batches = conservative)')
    print('| N | batches | normal day | of 50k | worst day (b=hi) | of 50k | month normal (b=hi) | of 1M | rolling 31d (23 sessions) | of 1M |')
    print('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for n in (15, 25, 50, 100):
        lo, hi = batch_range(n)
        a = final_design(n, lo, price_s, weekly=weekly)
        z = final_design(n, hi, price_s, weekly=weekly)
        w = final_design(n, hi, price_s, worst=True, weekly=weekly)
        roll = z.monthly(SESSIONS_ROLLING_31, 31 - SESSIONS_ROLLING_31)
        print(f'| {n} | {lo}–{hi} | {fmt(a.trading)}–{fmt(z.trading)} | '
              f'{a.trading / DAILY_CAP:.0%}–{z.trading / DAILY_CAP:.0%} | {fmt(w.trading)} | '
              f'{w.trading / DAILY_CAP:.0%} | {fmt(z.monthly())} | {z.monthly() / MONTHLY_CAP:.0%} | '
              f'{fmt(roll)} | {roll / MONTHLY_CAP:.0%} |')


def breakdown(title, day):
    print(f'\n#### {title}')
    for k, (t, nt, p) in day.parts.items():
        print(f'  {k:40s} {fmt(t):>9s} / non-trading {fmt(nt):>5s}')
    print(f'  {"TOTAL":40s} {fmt(day.trading):>9s} / non-trading {fmt(day.non_trading):>5s}'
          f'  month {fmt(day.monthly())}')


def governor_demo(day, backfill=0, soft=0.90, hard=0.98):
    """Daily shedding order of the budget governor. P1/P2 may run up to the
    hard cap; P3/P4 (and backfill) only up to the soft cap AFTER the rest of
    the day's P1+P2 is reserved. Lower priorities are shed first."""
    pr = day.by_priority()
    reserve = pr.get(1, 0) + pr.get(2, 0)
    room = soft * DAILY_CAP - reserve
    p3 = min(pr.get(3, 0), max(0.0, room))
    p4 = min(pr.get(4, 0) + backfill, max(0.0, room - p3))
    total = reserve + p3 + p4
    print(f'  demand P1 {fmt(pr.get(1, 0))}, P2 {fmt(pr.get(2, 0))}, P3 {fmt(pr.get(3, 0))}, '
          f'P4 {fmt(pr.get(4, 0))} + backfill {fmt(backfill)} = {fmt(day.trading + backfill)}')
    print(f'  admitted P1+P2 {fmt(reserve)} (hard cap {fmt(hard * DAILY_CAP)}), P3 {fmt(p3)}, P4 {fmt(p4)} '
          f'-> {fmt(total)} ({total / DAILY_CAP:.0%}); shed {fmt(day.trading + backfill - total)}')


def cycle_duration(b, latency_s, persist_per_batch_s=0.3, slots=CONCURRENCY):
    """Collect duration of one price cycle: batches are split over the price
    slots; request starts are additionally spaced 0.2 s."""
    rounds = math.ceil(b / slots)
    return max(rounds * (latency_s + persist_per_batch_s), (b - 1) * 0.2 + latency_s + persist_per_batch_s)


def max_latency_for(b, period_s, slots, margin_s=1.0, persist=0.3):
    lat = 0.0
    while cycle_duration(b, lat + 0.01, persist, slots) <= period_s - margin_s:
        lat += 0.01
    return lat


def throughput(n, b, scenario):
    """v1 helper: average provider request starts per second during the
    session and the share of the 5 starts/s spacing budget."""
    d = scenario(n, b)
    session_calls = d.trading - sum(
        t for k, (t, _, _) in d.parts.items()
        if k.startswith(('post_close', '1d_after', '1w_after', 'long_4h',
                         'loc_', 'lists', 'krx_recon', 'sync_1d', 'sync_1w')))
    per_s = session_calls / SESSION_S
    l_max = CONCURRENCY / per_s
    return per_s, per_s / SPACING_PER_S, l_max


# ------------------------------------------- execute-freshness simulation --

def lognormal_params(median, p99):
    mu = math.log(median)
    return mu, (math.log(p99) - mu) / 2.3263


def simulate_er(trades, period, lat, jitter=0.5, response=0.3, skip=0.0,
                horizon=SESSION_S, seed=11):
    """Share of session time in which a market order passes the 10 s KRX
    execute rule (now - effectiveAt <= 10 s; capturedAt is never older than
    effectiveAt, so this is the binding rule). Polls are fixed-rate with
    uniform jitter; a poll sees trades older than its feed latency; a row is
    stored only when the trade time advances (koscom-ingestion dedupe); a
    skipped cycle stores nothing. Also returns p99 of (capturedAt -
    effectiveAt) over stored rows, the statistic measurable in production."""
    rnd = random.Random(seed)
    mu, sigma = lat
    rows, last_e, k = [], -1e18, 0
    while True:
        t = k * period + rnd.uniform(0, jitter)
        k += 1
        if t >= horizon:
            break
        if skip and rnd.random() < skip:
            continue
        c = t + response
        i = bisect.bisect_right(trades, c - rnd.lognormvariate(mu, sigma)) - 1
        if i < 0:
            continue
        e = trades[i]
        if e > last_e:
            rows.append((c, e))
            last_e = e
    if not rows:
        return 0.0, float('nan')
    ok = 0.0
    for idx, (c, e) in enumerate(rows):
        nxt = rows[idx + 1][0] if idx + 1 < len(rows) else horizon
        ok += max(0.0, min(nxt, e + EXECUTE_WINDOW_S) - c)
    staleness = sorted(c - e for c, e in rows)
    return ok / (horizon - rows[0][0]), staleness[int(0.99 * (len(staleness) - 1))]


def poisson_trades(rate, seed, horizon=SESSION_S):
    rnd, t, out = random.Random(seed), 0.0, []
    while True:
        t += rnd.expovariate(rate)
        if t >= horizon:
            return out
        out.append(t)


def db_growth(n, period_s, book=False, adv=0.95, row_kb=(0.4, 2.0), book_kb=(0.9, 3.0)):
    cyc = cycles(period_s)
    price_rows = n * cyc * adv
    book_rows = n * cyc if book else 0
    lo = (price_rows * row_kb[0] + book_rows * book_kb[0]) / 1024
    hi = (price_rows * row_kb[1] + book_rows * book_kb[1]) / 1024
    return price_rows, book_rows, lo, hi


if __name__ == '__main__':
    print('N=100 batches by KOSPI/KOSDAQ split:',
          {f'{k}/{100 - k}': batches(k, 100 - k) for k in (100, 85, 80, 70, 61, 60, 50, 40)})
    print('current 15 (12 KOSPI/3 KOSDAQ, KIND):', batches(12, 3), 'batches')

    print('\n## 1. Calls — v1 reference scenarios (unchanged)')
    table('S0 production as recorded, 3s cycle (upper)', s0_production)
    table('S0 production as recorded, 6s effective cycle', s0_production, cycle_s=6.0)
    table('S1 existing code, all domestic features on', s1_existing_full)
    table('S2 GPT proposal (price 6s, 1m every 3m)', s2_gpt)
    table('R v1 recommendation (price 5s, 1m per 5m bucket)', r_recommended)
    table('S4 minimal (price 8s, candles after close only)', s4_minimal)

    print('\n## 2. Calls — v2 final design F')
    final_table(5.0)
    final_table(6.0)
    final_table(5.0, weekly=False)
    final_table(4.0)
    final_table(3.0)
    for every in (2.5, 10):
        z = final_design(100, 6, 5.0, minute_every=every)
        print(f'  1m cadence {every:g} min, N=100 b=6 5s: {fmt(z.trading)}/day ({z.trading / DAILY_CAP:.0%}), '
              f'month {fmt(z.monthly())} ({z.monthly() / MONTHLY_CAP:.0%})')
    for title, day in (('F N=100 b=6 5s normal', final_design(100, 6)),
                       ('F N=100 b=6 5s bounded worst', final_design(100, 6, worst=True)),
                       ('F N=100 b=5 5s normal', final_design(100, 5)),
                       ('F N=15 b=2 5s normal', final_design(15, 2))):
        breakdown(title, day)
    worst_month = 22 * final_design(100, 6, worst=True).trading + 9 * 144 * 1.2
    print(f'\n  upper bound: every session a worst day, N=100 b=6 5s: {fmt(worst_month)} '
          f'({worst_month / MONTHLY_CAP:.0%}) -> the governor must cap the month, not only the day')

    print('\n## 3. Budget governor (soft 90% for P3/P4 after reserving P1+P2, hard 98%)')
    print(' a) bounded worst day, N=100 b=6 5s, with a 10,000-call backfill requested:')
    governor_demo(final_design(100, 6, worst=True), backfill=10_000)
    print(' b) normal day, N=100 b=6 5s, same backfill:')
    governor_demo(final_design(100, 6), backfill=10_000)
    used, left = 600_000, 10
    allowance = (0.98 * MONTHLY_CAP - used) / left
    print(f' c) monthly pressure: {fmt(used)} used with {left} sessions left -> daily allowance '
          f'{fmt(allowance)} vs P1+P2 normal {fmt(sum(v for p, v in final_design(100, 6).by_priority().items() if p in (1, 2)))}')

    print('\n## 4. One-off backfill (15 -> 100: 85 new stocks; 1d extended to 576 sessions for all 100)')
    d1 = 100 * 7                     # 577 rows at reqCnt 100 = 6 pages + 1 boundary page
    h4_new, h4_all = 85 * 97, 100 * 97
    w1 = 85 * 1                      # one 60-row W page, only while the 1w tab is served
    m5 = 85 * 25 * 5                 # optional verified past-date 1m path (not in code)
    print(f'  1d 576 sessions: {fmt(d1)}; 4h 97 sessions: {fmt(h4_new)} (new) / {fmt(h4_all)} (all 100, if never run); '
          f'1w: {fmt(w1)}; total {fmt(d1 + h4_new + w1)}–{fmt(d1 + h4_all + w1)}')
    print(f'  optional 5m history for 25 sessions (needs a dated past 1m path): {fmt(m5)}')
    print(f'  weekend quota day room at 85% of the cap: {fmt(0.85 * DAILY_CAP - 12)}; '
          f'weekday room after F@100 b=6 normal: {fmt(0.85 * DAILY_CAP - final_design(100, 6).trading)}')

    print('\n## 5. Throughput and price-cycle duration')
    for n, b, t in ((100, 6, 5.0), (100, 6, 6.0), (100, 5, 5.0), (15, 2, 5.0)):
        peak = b / t + n / 60          # 1m ticks spread over 60 s after each bucket
        print(f'  F N={n} b={b} {t:g}s: price {b / t:.2f}/s + 1m burst {n / 60:.2f}/s = {peak:.2f}/s '
              f'({peak / SPACING_PER_S:.0%} of the 5 starts/s spacing)')
    for name, sc in (('S1', s1_existing_full), ('S2', s2_gpt), ('R', r_recommended)):
        per_s, share, lmax = throughput(100, 6, sc)
        print(f'  v1 {name} N=100 b=6: {per_s:.2f}/s = {share:.0%} of spacing; 2 slots saturate above {lmax:.2f}s mean latency')
    print('  D = one price cycle (0.3 s persist/batch); price slots c:')
    for lat in (0.15, 0.3, 0.6, 1.0, 1.5):
        print(f'    latency {lat}s: b=6 c=2 {cycle_duration(6, lat):.1f}s | b=6 c=3 {cycle_duration(6, lat, slots=3):.1f}s'
              f' | b=5 c=2 {cycle_duration(5, lat):.1f}s')
    for t in (5.0, 6.0):
        print(f'  keep D <= T-1s at T={t:g}s: mean latency <= {max_latency_for(6, t, 2):.2f}s (c=2) / '
              f'{max_latency_for(6, t, 3):.2f}s (c=3), 6 batches')
    for b in (2, 3, 4):
        print(f'  keep D <= T-1s at T=3s with {b} batches (N<=50 keeps 3 s): mean latency <= '
              f'{max_latency_for(b, 3.0, 2):.2f}s (c=2) / {max_latency_for(b, 3.0, 4):.2f}s (c=4)')

    print('\n## 6. Execute-freshness projection (Monte Carlo, one session per cell)')
    print('  trades ~ Poisson(rate); feed latency ~ lognormal; jitter U(0,0.5s); response 0.3s.')
    print('  S_p99 = p99(capturedAt - effectiveAt) of stored rows at 3s, the statistic GPT measured')
    print('  (2026-10-14: Samsung 1.66 s, Kia 3.54 s). ER = share of session time execute-eligible.')
    lat_fast, lat_slow = lognormal_params(0.3, 1.0), lognormal_params(0.6, 2.5)
    print('| trades/s | feed latency p50/p99 | S_p99 @3s | ER 3s | ER 4s | ER 5s | ER 6s | ER 5s, 2% skipped cycles |')
    print('|---:|---|---:|---:|---:|---:|---:|---:|')
    for rate in (5.0, 1.0, 0.5, 0.2):
        trades = poisson_trades(rate, seed=int(rate * 100) + 1)
        for label, lat in (('0.3/1.0 s', lat_fast), ('0.6/2.5 s', lat_slow)):
            er = {t: simulate_er(trades, t, lat) for t in (3.0, 4.0, 5.0, 6.0)}
            skipped, _ = simulate_er(trades, 5.0, lat, skip=0.02)
            print(f'| {rate:g} | {label} | {er[3.0][1]:.2f}s | ' + ' | '.join(f'{er[t][0]:.2%}' for t in (3.0, 4.0, 5.0, 6.0))
                  + f' | {skipped:.2%} |')

    print('\n## 7. DB growth (row sizes unmeasured: price 0.4-2.0 KB, slim 0.35-0.6 KB, book 0.9-3.0 KB incl. indexes)')
    print(f'  headroom used for "days": {HEADROOM_GB:.1f} GB (GPT: 10 GB disk, ~7.40 GB used; observation time not recorded)')
    print('| case | price rows/day | book rows/day | MB/trading day | trading days to fill headroom | GB per 22-session month |')
    print('|---|---:|---:|---:|---:|---:|')
    # rollout order: stage 1 (book off, slim raw) at 15, then 25 and 50 at 3 s,
    # then 100 at the cadence chosen by the ER rule (report §6.5)
    cases = (('S0 now: N=15, 3s, price+book, full raw', 15, 3.0, True, (0.4, 2.0)),
             ('stage 1: N=15, 3s, book off, slim raw', 15, 3.0, False, (0.35, 0.6)),
             ('F N=25, 3s, slim raw', 25, 3.0, False, (0.35, 0.6)),
             ('F N=50, 3s, slim raw', 50, 3.0, False, (0.35, 0.6)),
             ('F N=100, 5s, full raw (no slimming)', 100, 5.0, False, (0.4, 2.0)),
             ('F N=100, 5s, slim raw', 100, 5.0, False, (0.35, 0.6)),
             ('F N=100, 6s, slim raw', 100, 6.0, False, (0.35, 0.6)))
    for label, n, per, book, kb in cases:
        pr, br, lo, hi = db_growth(n, per, book, row_kb=kb)
        days_hi, days_lo = HEADROOM_GB * 1024 / hi, HEADROOM_GB * 1024 / lo
        print(f'| {label} | {fmt(pr)} | {fmt(br)} | {lo:,.0f}–{hi:,.0f} | {days_hi:.0f}–{days_lo:.0f} | '
              f'{22 * lo / 1024:.1f}–{22 * hi / 1024:.1f} |')
    for n in (15, 100):
        print(f'  sync-state rows/day N={n}: F before compaction ~{fmt(n * (TICKS + 2))}, after daily compaction ~{fmt(n * 2)}; '
              f'v1-style 10-min sync incl. KRX {fmt(n * 3 * 144)}')
    print(f'  5m candle rows/day N=100: {fmt(100 * 76)}; 45-day retention holds <= {fmt(100 * 34 * 76)}; 4h {fmt(100 * 2)}/day; 1d {fmt(100)}/day')

    print('\n## 8. Largest universe within 80% of the worst-month cap (F normal, 1w weekly on)')
    print('| price T | 1m cadence | N_max best split | N_max worst split | month at N=100 best/worst |')
    print('|---|---|---:|---:|---:|')
    for t in (4.0, 5.0, 6.0):
        for every in (5, 10):
            best = worst = 0
            for n in range(1, 201):
                lo_b, hi_b = batch_range(n)
                if final_design(n, lo_b, t, minute_every=every).monthly() <= 0.8 * MONTHLY_CAP:
                    best = n
                if final_design(n, hi_b, t, minute_every=every).monthly() <= 0.8 * MONTHLY_CAP:
                    worst = n
            lo_b, hi_b = batch_range(100)
            a = final_design(100, lo_b, t, minute_every=every).monthly()
            z = final_design(100, hi_b, t, minute_every=every).monthly()
            print(f'| {t:g}s | {every}m | {best} | {worst} | {a / MONTHLY_CAP:.0%} / {z / MONTHLY_CAP:.0%} |')
