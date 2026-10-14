"""KRX regular sessions from the repo calendar datasets (read-only).

Usage (from the repo root):
  python3 -I docs/investigations/2026-10-15-koscom-100-stock-collection-design/calc/krx_sessions.py \
      backend/src/orders/market-calendar/data/krx-2025.ts \
      backend/src/orders/market-calendar/data/krx-2026.ts \
      backend/src/orders/market-calendar/data/krx-2027.ts

Sections:
  1. sessions and session minutes per month (2026-2027);
  2. source span of the confirmed chart policy windows (5m 3, 15m 6, 30m 12,
     1h 24, 4h 96, 1d 576 sessions back + today) with the app's own anchor
     rule, evaluated for every calendar day the datasets cover;
  3. minimum 5m retention / managed 5m range that keeps the 1h window whole;
  4. how far back the 1d 576-session window reaches and which years it needs;
  5. most sessions in any rolling 30/31-day window (monthly-cap assumption).
Only the datasets passed on the command line are used. A year without a dataset
is never assumed to be a regular year (same fail-closed rule as the app).
"""
import datetime as dt
import math
import re
import sys

paths = sys.argv[1:]
closed, special, years = set(), {}, set()
for p in paths:
    t = open(p, encoding='utf-8').read()
    years.add(int(re.search(r"year:\s*(\d{4})", t).group(1)))
    for m in re.finditer(r"\{\s*date:\s*'(\d{4}-\d{2}-\d{2})'(.*?)\}", t, re.S):
        d, body = m.group(1), m.group(2)
        if 'isFullDayClosed: true' in body:
            closed.add(d)
        else:
            o = re.search(r"openTimeOverride:\s*'(\d{6})'", body)
            c = re.search(r"closeTimeOverride:\s*'(\d{6})'", body)
            special[d] = (o.group(1) if o else '090000', c.group(1) if c else '153000')

first_day = dt.date(min(years), 1, 1)
last_day = dt.date(max(years), 12, 31)
sessions = []  # ordered trading dates covered by the datasets
day = first_day
while day <= last_day:
    if day.weekday() < 5 and day.isoformat() not in closed:
        sessions.append(day)
    day += dt.timedelta(days=1)

# ---------------------------------------------------------------- 1 -------
print('## 1. Sessions per month')
out = {}
for year in sorted(y for y in years if y >= 2026):
    for month in range(1, 13):
        ms = [s for s in sessions if s.year == year and s.month == month]
        minutes = 0
        for s in ms:
            o, c = special.get(s.isoformat(), ('090000', '153000'))
            minutes += (int(c[:2]) * 60 + int(c[2:4])) - (int(o[:2]) * 60 + int(o[2:4]))
        out[f"{year}-{month:02d}"] = (len(ms), minutes)
for k, (n, m) in out.items():
    print(k, n, m)
print('max sessions/month', max(v[0] for v in out.values()), 'min', min(v[0] for v in out.values()))
print('special', special)
print('sessions per year', {y: sum(1 for s in sessions if s.year == y) for y in sorted(years)})

# ---------------------------------------------------------------- 2 -------
# Same anchor as the app's session ranges (asset-candles.service.ts
# resolveMarketOpenAnchor -> findPreviousMarketSession): the window starts at
# the OPEN of the Nth real session strictly before the viewing day's KST date
# and ends now (today's session, if any, is included). Aggregated intervals
# (15m/30m/1h/4h) read 5m with 4h of padding before the window
# (candle-read-plan.builder.ts). Span = viewing day 24:00 KST - source start,
# i.e. the worst instant of that day for a "now - R days" retention cutoff.
POLICY = (('5m', 3, 0), ('15m', 6, 4), ('30m', 12, 4), ('1h', 24, 4), ('4h', 96, 4), ('1d', 576, 0))


def open_hour(s):
    o = special.get(s.isoformat(), ('090000', '153000'))[0]
    return int(o[:2]) + int(o[2:4]) / 60


def previous_index(view_day):
    """Index of the latest session strictly before view_day (None if none)."""
    lo, hi, best = 0, len(sessions) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if sessions[mid] < view_day:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


print('\n## 2. Source span of the session-counted chart windows (prevN_open semantics)')
print('| interval | N | 4h padding | span min (days) | span max (days, viewing day) | trading days in 2026 with span > 35d |')
print('|---|---:|---|---:|---|---:|')
span_max = {}
for interval, n, pad_h in POLICY:
    spans, over35 = [], 0
    view = first_day
    while view <= last_day:
        i = previous_index(view)
        if i is not None and i - (n - 1) >= 0:
            oldest = sessions[i - (n - 1)]
            start_h = (oldest - first_day).days * 24 + open_hour(oldest) - pad_h
            end_h = (view - first_day).days * 24 + 24
            span = (end_h - start_h) / 24
            spans.append((round(span, 2), view))
            if view.year == 2026 and view in set(sessions) and span > 35:
                over35 += 1
        view += dt.timedelta(days=1)
    if not spans:
        print(f'| {interval} | {n} | {pad_h}h | — | needs sessions before {first_day} (no dataset) | — |')
        continue
    worst = max(spans)
    span_max[interval] = worst[0]
    print(f'| {interval} | {n} | {pad_h}h | {min(spans)[0]} | {worst[0]} ({worst[1]}) | {over35} |')

# ---------------------------------------------------------------- 3 -------
print('\n## 3. 5m retention / managed range needed for the 1h (24) window')
need = math.ceil(span_max['1h'])
print(f'  worst source span {span_max["1h"]} days -> retention and maxManagedFiveMinuteRangeMs >= {need} days')
for r in (35, 40, 45, 50):
    print(f'  {r}d: {"OK" if r >= need else "INSUFFICIENT"}')
for r in (35, 45):
    kept = max(sum(1 for s in sessions if v - dt.timedelta(days=r) <= s <= v) for v in sessions[40:])
    print(f'  retention {r}d keeps at most {kept} sessions -> {kept * 76} required 5m rows/stock (76 per regular session)')

# ---------------------------------------------------------------- 4 -------
print('\n## 4. 1d window (prev576_open) reach-back and calendar years it needs')
for view in (dt.date(2026, 10, 15), dt.date(2027, 1, 4), dt.date(2027, 6, 30), dt.date(2027, 12, 30)):
    i = previous_index(view)
    if i is not None and i - 575 >= 0:
        oldest = sessions[i - 575]
        print(f'  {view}: oldest session {oldest} ({(view - oldest).days} calendar days back, inside datasets)')
    else:
        have = 0 if i is None else i + 1
        print(f'  {view}: datasets give {have} previous sessions; {576 - have} more must come from years '
              f'before {first_day.year} (no dataset in repo -> app fails closed)')

if len(sessions) > 576:
    print(f'  first viewing day whose 576 previous sessions all lie inside the datasets: '
          f'{sessions[575] + dt.timedelta(days=1)} (until then years before {first_day.year} are required)')

# ---------------------------------------------------------------- 5 -------
print('\n## 5. Sessions in any rolling window (if the monthly cap were rolling, not calendar-month)')
for width in (30, 31):
    best = (0, None)
    view = first_day
    while view + dt.timedelta(days=width - 1) <= last_day:
        cnt = sum(1 for s in sessions if view <= s < view + dt.timedelta(days=width))
        best = max(best, (cnt, view))
        view += dt.timedelta(days=1)
    print(f'  {width}-day window: max {best[0]} sessions (from {best[1]})')
