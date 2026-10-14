"""Count KRX regular sessions per month from the repo calendar datasets (read-only)."""
import re, sys, datetime as dt, json
paths = sys.argv[1:]
closed, special = set(), {}
for p in paths:
    t = open(p, encoding='utf-8').read()
    for m in re.finditer(r"\{\s*date:\s*'(\d{4}-\d{2}-\d{2})'(.*?)\}", t, re.S):
        d, body = m.group(1), m.group(2)
        if 'isFullDayClosed: true' in body:
            closed.add(d)
        else:
            o = re.search(r"openTimeOverride:\s*'(\d{6})'", body)
            c = re.search(r"closeTimeOverride:\s*'(\d{6})'", body)
            special[d] = (o.group(1) if o else '090000', c.group(1) if c else '153000')
out = {}
for year in (2026, 2027):
    for month in range(1, 13):
        day = dt.date(year, month, 1); n = 0; minutes = 0
        while day.month == month:
            s = day.isoformat()
            if day.weekday() < 5 and s not in closed:
                n += 1
                o, c = special.get(s, ('090000', '153000'))
                minutes += (int(c[:2])*60+int(c[2:4])) - (int(o[:2])*60+int(o[2:4]))
            day += dt.timedelta(days=1)
        out[f"{year}-{month:02d}"] = (n, minutes)
for k, (n, m) in out.items():
    print(k, n, m)
print('max sessions/month', max(v[0] for v in out.values()), 'min', min(v[0] for v in out.values()))
print('special', special)
