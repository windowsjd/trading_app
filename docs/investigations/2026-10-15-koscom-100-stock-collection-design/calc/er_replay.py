"""Execute-eligibility (ER) of KOSCOM price rows, and the 6-second replay
ESTIMATE of a 3-second polling session (report §6.2, §6.5). Analysis only:
no network, no DB, no KOSCOM.

v2.1 (2026-10-15, second cross-review): v2 divided by (close - first row) and
defaulted the session to the first/last row, so a late first row left the
denominator and ER was overstated. ER now always uses the calendar session,
and the 6 s replay is reported as an estimate with its assumptions.

ER (report §6.2)
  ER = |{t in [open, close) : a market order at t passes the execute rule}|
       / (close - open)
  * open/close: the KRX calendar regular session (required arguments). Time
    without an eligible price stays in the denominator: before the first
    eligible row, collection gaps, after the last row expires, and the closing
    single-price auction (no prints while market orders are still accepted).
  * At t the evaluated row is the newest stored row with captured <= t (rows
    are stored only when effectiveAt advances). It passes iff effective <= t,
    t - effective <= 10 s (KRX effective_at_stale) and
    floor(t - captured) <= 10 s, i.e. t - captured < 11 s (captured_at_stale),
    source-eligibility.policy.ts. Row i is therefore eligible on
    [max(c_i, e_i), min(c_{i+1}, e_i + 10, c_i + 11)), clipped to the session.
  * Carry-in: rows captured before open are the state at open (export the
    newest pre-open row per symbol, report Q2''). They count only for
    t >= open and only while fresh; computed, never assumed.
  * Rows captured at or after close are ignored.
  * --symbols lists the measured universe. A listed symbol without any row is
    reported with ER 0 and flag NO_ROWS instead of disappearing.

Evidence levels (report §6.5)
  observed  ER_3 from the stored rows of that session.
  estimate  rows-only 6 s replay: every other 3 s cycle, state = newest stored
            row by then. Assumes
            (A1) the provider never returns an older trade than an earlier
                 poll did (a regression stores no row, so rows cannot show it),
            (A2) a 6 s poll at that instant would get the same answer,
            (A3) a cycle in which no batch member stored a row was polled
                 (an outage and "nothing new" look the same in rows).
  estimate  poll-log replay (--polls, stage-1 instrumentation: one line per
            symbol per poll, failures included): A1 and A3 become measured;
            only A2 remains, and the self-test sizes it.
  final     ER measured while actually polling at T (report §6.5).
  ER_5 cannot be replayed from 3 s polls at all.

Usage:
  python3 -I er_replay.py rows.csv --open EPOCH --close EPOCH [--period 3]
                          [--symbols A,B,...] [--polls polls.csv]
  python3 -I er_replay.py --selftest
  rows.csv   symbol,captured_s,effective_s    (report Q2'')
  polls.csv  symbol,received_s,effective_s    (effective_s empty = no usable
                                               quote in that poll)
"""
import argparse
import bisect
import csv
import math
import random
import statistics
import sys

EXEC_WINDOW_S = 10.0      # KRX: now - effectiveAt <= 10 s
CAPTURED_LIMIT_S = 11.0   # floor(now - capturedAt) <= 10 s  <=>  now - capturedAt < 11 s
AUCTION_S = 600.0         # closing single-price auction = last 10 min of the regular session
GAP_POLLS = 3             # no row from ANY symbol for > 3 polls = suspected collection gap
DEGRADED_SHARE = 0.005    # more suspected gap than this: session not used for cadence decisions


# ------------------------------------------------------------------ ER ----

def spans(series, open_s, close_s):
    """Eligible intervals. series: stored rows [(captured, effective)] sorted by
    captured with effective rising; carry-in rows (captured < open) included."""
    rows = [r for r in series if r[0] < close_s]
    out = []
    for i, (c, e) in enumerate(rows):
        nxt = rows[i + 1][0] if i + 1 < len(rows) else close_s
        start = max(c, e, open_s)
        end = min(nxt, e + EXEC_WINDOW_S, c + CAPTURED_LIMIT_S, close_s)
        if end > start:
            out.append((start, end))
    return out


def er(series, open_s, close_s):
    return sum(b - a for a, b in spans(series, open_s, close_s)) / (close_s - open_s)


def er_detail(series, open_s, close_s):
    sp = spans(series, open_s, close_s)
    auction_from = close_s - AUCTION_S
    edges = [open_s] + [x for s in sp for x in s] + [close_s]
    return {
        'er': sum(b - a for a, b in sp) / (close_s - open_s),
        'er_cont': sum(max(0.0, min(b, auction_from) - a) for a, b in sp) / (auction_from - open_s),
        'first_ok_s': sp[0][0] - open_s if sp else None,
        'longest_off_s': max(edges[i + 1] - edges[i] for i in range(0, len(edges), 2)),
    }


def store(polls, last=None):
    """koscom-ingestion dedupe: a poll stores a row only when its trade time is
    newer than the newest stored one. polls: [(received, effective or None)]."""
    out = []
    for c, e in polls:
        if e is not None and (last is None or e > last):
            out.append((c, e))
            last = e
    return out


def collection_gaps(times, open_s, close_s, period, auction=AUCTION_S):
    """Spans in which nothing was observed for more than GAP_POLLS polls. The
    closing auction is excluded: nothing prints there by market structure."""
    end = close_s - auction
    pts = [open_s] + sorted(t for t in times if open_s <= t < end) + [end]
    return [(a, b) for a, b in zip(pts, pts[1:]) if b - a > GAP_POLLS * period]


# -------------------------------------------------------------- replay ----

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
    return sorted(groups.values(), key=lambda m: sorted(m))


def reconstruct(cycles, period):
    """Cycle grid of one batch from its visible cycles. A cycle in which no
    member stored a row left no timestamp; the poll is fixed-rate (period from
    configuration, not from the rows: a thin batch has few visible cycles), so
    it is re-inserted at an interpolated time (error <= the poll jitter)."""
    grid, inserted = cycles[:1], 0
    for a, b in zip(cycles, cycles[1:]):
        steps = max(1, round((b - a) / period))
        inserted += steps - 1
        grid.extend(a + (b - a) * m / steps for m in range(1, steps + 1))
    return grid, inserted


def replay_rows(per_sym, open_s, close_s, period):
    """Rows-only 6 s estimate for both phases (both are valid 6 s schedules)."""
    rows = [(s, c, e) for s, rs in per_sym.items() for c, e in rs if open_s <= c < close_s]
    out = {}
    for gid, members in enumerate(batches(rows)):
        cycles = sorted({c for s in members for c, _ in per_sym[s] if open_s <= c < close_s})
        grid, inserted = reconstruct(cycles, period)
        for s in members:
            rs = per_sym[s]
            caps = [c for c, _ in rs]
            carry = [r for r in rs if r[0] < open_s]
            er6 = []
            for phase in (0, 1):
                series, last = list(carry), (carry[-1][1] if carry else None)
                for g in grid[phase::2]:
                    i = bisect.bisect_right(caps, g) - 1
                    if i >= 0 and (last is None or rs[i][1] > last):
                        series.append((g, rs[i][1]))
                        last = rs[i][1]
                er6.append(er(series, open_s, close_s))
            out[s] = {'batch': gid, 'batch_size': len(members), 'inserted': inserted,
                      'grid0': grid[0] if grid else None, 'er6': tuple(er6)}
    return out


def replay_polls(polls_by_sym, carry_by_sym, open_s, close_s):
    """Poll-log 6 s estimate: every other poll of the symbol's own poll list
    (one line per poll incl. failures, so parity is shared by the batch)."""
    out = {}
    for s, polls in polls_by_sym.items():
        polls = sorted(p for p in polls if open_s <= p[0] < close_s)
        carry = carry_by_sym.get(s, [])
        last0 = carry[-1][1] if carry else None
        seen, regress, failed = last0, 0, 0
        for _, e in polls:
            if e is None:
                failed += 1
            elif seen is not None and e < seen:
                regress += 1
            if e is not None:
                seen = e if seen is None else max(seen, e)
        out[s] = {
            'er3': er(carry + store(polls, last0), open_s, close_s),
            'er6': tuple(er(carry + store(polls[ph::2], last0), open_s, close_s) for ph in (0, 1)),
            'polls': len(polls), 'failed': failed, 'regressions': regress,
        }
    return out


# -------------------------------------------------------------- report ----

def pct(x):
    return '—' if x is None else f'{x:.2%}'


def analyse(per_sym, open_s, close_s, period, symbols=None, polls=None):
    universe = sorted(set(per_sym) | set(symbols or []) | set(polls or {}))
    session = close_s - open_s
    times = [c for rs in per_sym.values() for c, _ in rs]
    if polls:
        times = [c for ps in polls.values() for c, e in ps if e is not None]
    gaps = collection_gaps(times, open_s, close_s, period)
    gap_s = sum(b - a for a, b in gaps)
    rep = replay_rows(per_sym, open_s, close_s, period)
    carry = {s: [r for r in rs if r[0] < open_s] for s, rs in per_sym.items()}
    prep = replay_polls(polls, carry, open_s, close_s) if polls else {}
    print(f'session {session:,.0f} s; suspected collection gaps (> {GAP_POLLS} polls, auction excluded, '
          f'from {"poll log" if polls else "rows"}): {len(gaps)} spans, {gap_s:,.1f} s = {gap_s / session:.2%} '
          f'-> {"DEGRADED: not a cadence-decision session" if gap_s > DEGRADED_SHARE * session else "usable"}')
    for a, b in sorted(gaps, key=lambda g: g[0] - g[1])[:5]:
        print(f'  gap {a - open_s:,.1f}..{b - open_s:,.1f} s after open ({b - a:,.1f} s)')
    head = ('| symbol | batch | rows | ER 3s observed | continuous part | first eligible | longest ineligible '
            '| ER 6s rows-only est. ph0 / ph1 | ΔER worst |')
    if polls:
        head += ' ER 6s poll-log est. ph0 / ph1 | failed / regressed polls |'
    print(head + ' flags |')
    print('|' + '---|' * (head.count('|') - 1 + 1))
    for s in universe:
        rs = per_sym.get(s, [])
        in_session = [r for r in rs if open_s <= r[0] < close_s]
        d = er_detail(rs, open_s, close_s)
        flags = []
        if not in_session and not carry.get(s):
            flags.append('NO_ROWS')
        elif d['er'] == 0:
            flags.append('NO_ELIGIBLE')
        r = rep.get(s)
        er6 = r['er6'] if r else (d['er'], d['er'])
        first = '—' if d['first_ok_s'] is None else f"{d['first_ok_s']:.1f} s"
        line = (f'| {s} | {r["batch"] if r else "—"} | {len(in_session)} | {pct(d["er"])} | {pct(d["er_cont"])} | '
                f'{first} | {d["longest_off_s"]:,.1f} s | '
                f'{pct(er6[0])} / {pct(er6[1])} | {100 * (d["er"] - min(er6)):.2f}%p |')
        if polls:
            p = prep.get(s)
            if p:
                if abs(p['er3'] - d['er']) > 1e-9:
                    flags.append('ROWS_POLLS_MISMATCH')
                line += f' {pct(p["er6"][0])} / {pct(p["er6"][1])} | {p["failed"]} / {p["regressions"]} |'
            else:
                line += ' — | — |'
        print(line + f' {" ".join(flags) or "—"} |')
    for gid in sorted({r['batch'] for r in rep.values()}):
        r = next(v for v in rep.values() if v['batch'] == gid)
        print(f'  batch {gid}: {r["batch_size"]} symbols, {r["inserted"]} cycles re-inserted (no member stored a row)')
    return rep, prep


# ------------------------------------------------------------ selftest ----

FAILURES = []


def brute_er(series, open_s, close_s, step=0.005):
    """Independent check: sample the eligibility rule directly."""
    caps = [c for c, _ in series]
    ok, n = 0, int(round((close_s - open_s) / step))
    for k in range(n):
        t = open_s + (k + 0.5) * step
        i = bisect.bisect_right(caps, t) - 1
        if i < 0:
            continue
        c, e = series[i]
        if e <= t and t - e <= EXEC_WINDOW_S and math.floor(t - c) <= 10:
            ok += 1
    return ok / n


def check(name, got, want, tol=1e-9):
    good = abs(got - want) <= tol
    if not good:
        FAILURES.append(name)
    return good


def edge_cases():
    O, C = 0.0, 1000.0
    liquid = lambda start, stop, lag=0.4: [(round(c, 3), round(c - lag, 3))
                                         for c in (start + 3 * k for k in range(int((stop - start) / 3) + 1)) if c < stop]
    cases = []
    # 1. collector starts 60 s late; the first row is the first eligible instant
    s = liquid(60.2, C)
    cases.append(('late first collection (first row 60.2 s after open)', s, (C - 60.2) / C,
                  f'v2 formula (denominator from first row) = {sum(b - a for a, b in spans(s, O, C)) / (C - s[0][0]):.2%}'))
    # 2. no row between 300 and 420 s: the last row (c 297.5, e 297.2) stays fresh
    #    until 307.2 s, then nothing is eligible until the next row at 420.5 s
    s = [r for r in liquid(0.5, C, 0.3) if not 300 <= r[0] < 420]
    gaps = collection_gaps([c for c, _ in s], O, C, 3.0, auction=0.0)
    cases.append(('long collection gap mid-session (no row 300..420 s)', s, (C - 0.5 - (420.5 - 307.2)) / C,
                  f'gap flagged: {[(round(a, 1), round(b, 1)) for a, b in gaps]}'))
    # 3. one trade every 30 s (1, 31, .., 991 s) seen at the next 3 s poll (0.3 s
    #    feed delay): each fresh for 7.5 s, the last one cut by the close (6.5 s)
    trades = [30 * k + 1.0 for k in range(34)]
    polls = [(3 * j + 0.5, max([t for t in trades if t <= 3 * j + 0.5 - 0.3], default=None)) for j in range(334)]
    s = store(polls)
    cases.append(('very thin symbol (1 trade / 30 s)', s, (33 * 7.5 + 6.5) / C,
                  f'{len(polls) - len(s)} of {len(polls)} polls stored no row'))
    # 4. last trade at 699.2 s (halt or last print): fresh until 709.2 s
    s = [r for r in liquid(0.5, C, 0.3) if r[0] <= 699.5]
    cases.append(('last price expires (no trade after 699.2 s)', s, (699.2 + 10 - 0.5) / C, ''))
    # 5. whole session without an eligible price
    cases.append(('only a previous-day carry-in row', [(-80_000.0, -80_010.0)], 0.0, 'flag NO_ELIGIBLE'))
    cases.append(('listed symbol without any row', [], 0.0, 'flag NO_ROWS'))
    # 6. carry-in (captured 1 s before open, trade 2 s before open) still fresh at
    #    open: counts on [0, 8); then one in-session row fresh on [20, 29.6)
    s = [(-1.0, -2.0), (20.0, 19.6)]
    cases.append(('fresh pre-open carry-in + one row', s, (8.0 + 9.6) / C, ''))
    # 7. provider clock ahead: effective after captured -> eligible from e, and
    #    the captured rule (c + 11 s) ends it before e + 10 s
    s = [(10.0, 12.0)]
    cases.append(('effective 2 s after captured (captured rule binds)', s, 9.0 / C, ''))
    # 8. a row captured at close does not count; the row before it is clipped
    s = [(995.0, 994.8), (1000.0, 999.9)]
    cases.append(('row at close ignored, last span clipped at close', s, 5.0 / C, ''))
    print('## A. ER boundary cases (session 0..1000 s; exact value vs formula vs direct sampling at 5 ms)')
    print('| case | expected | er() | sampled | result | note |')
    print('|---|---:|---:|---:|---|---|')
    for name, series, want, note in cases:
        got = er(series, O, C) if series else 0.0
        sampled = brute_er(series, O, C) if series else 0.0
        good = check(name, got, want, 1e-9) and check(name + ' (sampled)', sampled, got, 2 * 0.005 * (len(series) + 1) / C)
        print(f'| {name} | {want:.4%} | {got:.4%} | {sampled:.4%} | {"ok" if good else "FAIL"} | {note} |')


def synth_session(seed, lat, horizon=23_400.0, jitter=0.5, response=0.3,
                  first_poll=15.0, outage=(10_000.0, 10_060.0), period=3.0, rates=None, batch_of=None):
    """Synthetic KRX session: Poisson trades until the closing auction, fixed-rate
    polls from `first_poll` with uniform jitter, lognormal feed delay drawn per
    poll and symbol, all polls inside `outage` fail."""
    rnd = random.Random(seed)
    mu, sigma = math.log(lat[0]), (math.log(lat[1]) - math.log(lat[0])) / 2.3263
    trades = {}
    for s, lam in rates.items():
        t, xs = 0.0, []
        while True:
            t += rnd.expovariate(lam)
            if t >= horizon - AUCTION_S:
                break
            xs.append(t)
        trades[s] = xs
    polls = {}
    for b in sorted(set(batch_of.values())):
        k = 0
        while True:
            t = first_poll + k * period + rnd.uniform(0, jitter) + 0.2 * b
            if t >= horizon:
                break
            c = round(t + response, 3)
            failed = outage[0] <= c < outage[1]
            for s in (x for x in rates if batch_of[x] == b):
                d = rnd.lognormvariate(mu, sigma)
                i = bisect.bisect_right(trades[s], c - d) - 1
                polls.setdefault(s, []).append((c, None if failed or i < 0 else trades[s][i], k))
            k += 1
    return trades, polls


def independent_6s(trades, seed, lat, rates, batch_of, horizon=23_400.0, jitter=0.5, response=0.3,
                   first_poll=15.0, outage=(10_000.0, 10_060.0)):
    """A real 6 s poller on the same trades: its own phase, jitter and delays (A2 not assumed)."""
    rnd = random.Random(seed)
    mu, sigma = math.log(lat[0]), (math.log(lat[1]) - math.log(lat[0])) / 2.3263
    out = {}
    for b in sorted(set(batch_of.values())):
        phase = rnd.uniform(0, 6.0)
        k = 0
        while True:
            t = first_poll + phase + k * 6.0 + rnd.uniform(0, jitter) + 0.2 * b
            if t >= horizon:
                break
            c = round(t + response, 3)
            for s in (x for x in rates if batch_of[x] == b):
                d = rnd.lognormvariate(mu, sigma)
                i = bisect.bisect_right(trades[s], c - d) - 1
                ok = not (outage[0] <= c < outage[1]) and i >= 0
                out.setdefault(s, []).append((c, trades[s][i] if ok else None))
            k += 1
    return {s: er(store(p), 0.0, horizon) for s, p in out.items()}


def replay_accuracy():
    rates = {'LIQ5': 5.0, 'MID1': 1.0, 'THIN05': 0.5, 'THIN02': 0.2, 'VTHIN005': 0.05}
    batch_of = {'LIQ5': 0, 'MID1': 0, 'THIN05': 1, 'THIN02': 1, 'VTHIN005': 1}
    horizon = 23_400.0
    print('\n## B. Replay accuracy on a synthetic session')
    print('  trades Poisson until the closing auction (last 600 s: none); first poll 15 s after open;')
    print('  all polls fail in 10,000..10,060 s; batch 1 has no liquid member (many cycles store no row).')
    for label, lat in (('feed delay p50/p99 0.3/1.0 s', (0.3, 1.0)), ('feed delay p50/p99 0.6/2.5 s', (0.6, 2.5))):
        trades, polls = synth_session(5, lat, rates=rates, batch_of=batch_of)
        per_sym = {s: store([(c, e) for c, e, _ in ps]) for s, ps in polls.items()}
        plog = {s: [(c, e) for c, e, _ in ps] for s, ps in polls.items()}
        print(f'\n### {label}')
        rep, prep = analyse(per_sym, 0.0, horizon, 3.0, symbols=list(rates), polls=plog)
        print('| symbol | direct 6 s, same draws ph0 / ph1 | rows-only est. (true phase) error | poll-log est. error | regressed polls |')
        print('|---|---:|---:|---:|---:|')
        for s in rates:
            ps = polls[s]
            direct = [er(store([(c, e) for c, e, _ in ps[ph::2]]), 0.0, horizon) for ph in (0, 1)]
            r = rep[s]
            # true phase of the rows-only grid: parity of the batch's first visible cycle
            k0 = next(k for c, _, k in ps if abs(c - r['grid0']) < 1e-9)
            rows_err = max(abs(r['er6'][ph] - direct[(ph + k0) % 2]) for ph in (0, 1))
            log_err = max(abs(prep[s]['er6'][ph] - direct[ph]) for ph in (0, 1))
            check(f'poll-log replay equals same-draw 6 s poll ({s}, {label})', log_err, 0.0, 1e-12)
            print(f'| {s} | {direct[0]:.2%} / {direct[1]:.2%} | {100 * rows_err:.3f}%p | {100 * log_err:.3f}%p '
                  f'| {prep[s]["regressions"]} |')
        # A2: what a real 6 s poller (own phase, jitter, delays) would have seen, 20 realizations
        print('\n  A2 size: a real 6 s poller on the same trades (own phase, jitter, delays), 20 realizations,')
        print('  vs the poll-log estimate. The rows-only estimate differs from it by the error column above.')
        print('| symbol | ER 3s observed | real 6 s: mean | real 6 s: sd | estimate ph0 / ph1 | two-phase mean - real mean '
              '| worse phase - real mean | max abs (one phase - one real) |')
        print('|---|---:|---:|---:|---:|---:|---:|---:|')
        real = [independent_6s(trades, 1000 + k, lat, rates, batch_of) for k in range(20)]
        for s in rates:
            xs = [r[s] for r in real]
            m, est = statistics.mean(xs), prep[s]['er6']
            worst = max(abs(e - x) for e in est for x in xs)
            print(f'| {s} | {prep[s]["er3"]:.2%} | {m:.2%} | {100 * statistics.pstdev(xs):.3f}%p | '
                  f'{est[0]:.2%} / {est[1]:.2%} | {100 * (sum(est) / 2 - m):+.3f}%p | {100 * (min(est) - m):+.3f}%p | '
                  f'{100 * worst:.3f}%p |')


def selftest():
    edge_cases()
    replay_accuracy()
    print()
    if FAILURES:
        print('SELFTEST FAILED:', '; '.join(FAILURES))
        sys.exit(1)
    print('selftest: all boundary cases and poll-log replay checks passed')


# ----------------------------------------------------------------- CLI ----

def read_csv(path, time_col):
    out = {}
    with open(path, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            e = r['effective_s'].strip()
            out.setdefault(r['symbol'], []).append((float(r[time_col]), float(e) if e else None))
    return {s: sorted(v, key=lambda x: x[0]) for s, v in out.items()}


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        selftest()
        sys.exit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument('rows')
    ap.add_argument('--open', type=float, required=True, help='session open, epoch s (KRX calendar)')
    ap.add_argument('--close', type=float, required=True, help='session close, epoch s (KRX calendar)')
    ap.add_argument('--period', type=float, default=3.0, help='configured poll period, s')
    ap.add_argument('--symbols', default='', help='measured universe, comma-separated')
    ap.add_argument('--polls', default=None, help='stage-1 poll log CSV')
    a = ap.parse_args()
    rows = {s: [(c, e) for c, e in v if e is not None] for s, v in read_csv(a.rows, 'captured_s').items()}
    polls = read_csv(a.polls, 'received_s') if a.polls else None
    analyse(rows, a.open, a.close, a.period, [s for s in a.symbols.split(',') if s], polls)
