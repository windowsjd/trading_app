"""Execute-eligibility (ER) from exported KOSCOM price rows, and the exact
6-second replay of a 3-second polling session (report §6.5). Analysis only.

Input CSV (header required), one session, rows of
asset_price_snapshots WHERE source_name = 'koscom_krx_realtime_price':
    symbol,captured_s,effective_s
captured_s / effective_s are epoch seconds (the columns are UTC-naive
timestamps, so `extract(epoch FROM ...)` is consistent). Export SQL: report Q2''.

Method
  * ER = share of session time in which the latest stored row passes the KRX
    10 s execute rule (now - effectiveAt <= 10 s; it binds before the
    capturedAt rule because effectiveAt <= capturedAt).
  * Rows of one multiquote batch share the exact receivedAt, so symbols whose
    captured_s values coincide are one batch and the batch's distinct
    captured_s values are its cycle times.
  * A 6 s poll would see, at every other 3 s cycle, the latest trade the 3 s
    poll had seen by then. Replaying even (or odd) cycles therefore gives the
    6 s series exactly. Cycles in which no symbol of the batch stored a row
    leave no timestamp; they are re-inserted at interpolated times (the poll
    is fixed-rate), which keeps the result within the poll jitter.
  * Self-test: on a synthetic session the replay matches a directly
    simulated 6 s poll within 0.01%p for every symbol (er_replay.out.txt).

Usage:
  python3 -I er_replay.py rows.csv [--open EPOCH --close EPOCH]
  python3 -I er_replay.py --selftest
"""
import bisect
import csv
import math
import random
import sys

WINDOW = 10.0


def er(series, open_s, close_s):
    """series: [(captured, effective)] sorted by captured, effective rising."""
    if not series:
        return 0.0
    ok = 0.0
    for i, (c, e) in enumerate(series):
        nxt = series[i + 1][0] if i + 1 < len(series) else close_s
        ok += max(0.0, min(nxt, e + WINDOW) - max(c, open_s))
    return ok / (close_s - max(open_s, series[0][0]))


def batches(rows, min_share=0.05, min_count=30):
    """Symbols of one request share its exact receivedAt. Two concurrent
    requests can also land on the same millisecond by chance, so a pair is
    linked only when it co-occurs often: at least `min_count` shared
    timestamps and `min_share` of the less active symbol's rows."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    by_time, counts, pairs = {}, {}, {}
    for sym, c, _ in rows:
        by_time.setdefault(c, []).append(sym)
        counts[sym] = counts.get(sym, 0) + 1
        find(sym)
    for syms in by_time.values():
        for i, a in enumerate(syms):
            for b in syms[i + 1:]:
                key = (a, b) if a < b else (b, a)
                pairs[key] = pairs.get(key, 0) + 1
    for (a, b), n in pairs.items():
        if n >= max(min_count, min_share * min(counts[a], counts[b])):
            parent[find(a)] = find(b)
    groups = {}
    for sym in counts:
        groups.setdefault(find(sym), set()).add(sym)
    return groups, by_time


def replay(rows, open_s, close_s):
    groups, by_time = batches(rows)
    per_sym = {}
    for sym, c, e in rows:
        per_sym.setdefault(sym, []).append((c, e))
    out = []
    for members in groups.values():
        cycles = sorted({c for c, syms in by_time.items() if members & set(syms)})
        # Cycles in which no member stored a row leave no timestamp. The poll
        # is fixed-rate, so number cycles by elapsed periods to keep parity.
        # A 6 s poll at such a cycle still sees what the skipped 3 s poll saw
        # one cycle earlier, so the cycle is re-inserted at an interpolated
        # time (error <= the poll jitter) instead of being dropped.
        diffs = sorted(b - a for a, b in zip(cycles, cycles[1:]))
        period = diffs[len(diffs) // 2] if diffs else 3.0
        grid, gaps = cycles[:1], 0
        for a, b in zip(cycles, cycles[1:]):
            steps = max(1, round((b - a) / period))
            gaps += steps - 1
            grid.extend(a + (b - a) * m / steps for m in range(1, steps + 1))
        for sym in sorted(members):
            rs = sorted(per_sym[sym])
            caps = [c for c, _ in rs]
            er3 = er(rs, open_s, close_s)
            er6 = []
            for phase in (0, 1):
                series, last = [], None
                for c in grid[phase::2]:
                    i = bisect.bisect_right(caps, c) - 1
                    if i >= 0 and (last is None or rs[i][1] > last):
                        series.append((c, rs[i][1]))
                        last = rs[i][1]
                er6.append(er(series, open_s, close_s))
            out.append((sym, len(rs), er3, min(er6), max(er6), gaps))
    return out


def print_table(out):
    print('| symbol | rows | ER 3s | ER 6s (worse/better phase) | ΔER 6s | cycles with no row |')
    print('|---|---:|---:|---:|---:|---:|')
    for sym, n, er3, lo, hi, gaps in sorted(out, key=lambda r: r[2]):
        print(f'| {sym} | {n} | {er3:.2%} | {lo:.2%} / {hi:.2%} | {100 * (er3 - lo):.2f}%p | {gaps} |')


def selftest():
    """Synthetic session: two batches, Poisson trades, lognormal feed delay.
    The replayed 6 s ER must match a directly simulated 6 s poll on the same
    trades and delays (same draws per poll instant)."""
    horizon, jitter, response = 23_400.0, 0.5, 0.3
    mu, sigma = math.log(0.3), (math.log(1.0) - math.log(0.3)) / 2.3263
    rnd = random.Random(5)
    batch_of = {'LIQ5': 0, 'MID1': 0, 'THIN05': 1, 'THIN02': 1}
    rates = {'LIQ5': 5.0, 'MID1': 1.0, 'THIN05': 0.5, 'THIN02': 0.2}
    trades = {}
    for s, lam in rates.items():
        t, xs = 0.0, []
        while True:
            t += rnd.expovariate(lam)
            if t >= horizon:
                break
            xs.append(t)
        trades[s] = xs
    polls = {b: [] for b in (0, 1)}       # per batch: (capture time, delay per symbol)
    for b in (0, 1):
        k = 0
        while True:
            t = k * 3.0 + rnd.uniform(0, jitter) + 0.2 * b
            if t >= horizon:
                break
            polls[b].append((t + response, {s: rnd.lognormvariate(mu, sigma) for s in rates}))
            k += 1
    rows, direct6 = [], {}
    for s, b in batch_of.items():
        last, series6, last6 = None, [], None
        for k, (c, delay) in enumerate(polls[b]):
            i = bisect.bisect_right(trades[s], c - delay[s]) - 1
            if i < 0:
                continue
            e = trades[s][i]
            if last is None or e > last:
                rows.append((s, round(c, 3), e))
                last = e
        # direct 6 s poll = every other 3 s poll instant with its own draw
        for c, delay in polls[b][0::2]:
            i = bisect.bisect_right(trades[s], c - delay[s]) - 1
            if i >= 0:
                e = trades[s][i]
                # a 6 s poll keeps the newest trade it has ever seen
                e = max(e, last6) if last6 is not None else e
                if last6 is None or e > last6:
                    series6.append((c, e))
                    last6 = e
        direct6[s] = er(series6, 0.0, horizon)
    out = replay(rows, 0.0, horizon)
    print('## selftest (synthetic: LIQ5 5/s, MID1 1/s, THIN05 0.5/s, THIN02 0.2/s)')
    print_table(out)
    print('direct 6 s simulation (even polls):', {s: f'{v:.2%}' for s, v in sorted(direct6.items())})
    worst = max(min(abs(lo - direct6[s]), abs(hi - direct6[s])) for s, _, _, lo, hi, _ in out)
    print(f'max |replayed - direct| over symbols (matching phase): {100 * worst:.2f}%p. '
          'Residual comes only from cycles in which no symbol of the batch stored a row.')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        selftest()
        sys.exit(0)
    path = sys.argv[1]
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            rows.append((r['symbol'], float(r['captured_s']), float(r['effective_s'])))
    rows.sort(key=lambda r: r[1])
    args = dict(zip(sys.argv[2::2], sys.argv[3::2]))
    open_s = float(args.get('--open', rows[0][1]))
    close_s = float(args.get('--close', rows[-1][1]))
    print_table(replay(rows, open_s, close_s))
