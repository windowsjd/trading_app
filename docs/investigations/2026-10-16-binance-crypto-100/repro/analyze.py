"""Summarize soak phases: python3 -I analyze.py <dir> A B ..."""
import json, sys, statistics as st
d = sys.argv[1]
def load(name):
    try:
        return [json.loads(l) for l in open(f'{d}/{name}')]
    except FileNotFoundError:
        return []
out = {}
for phase in sys.argv[2:]:
    mon = load(f'monitor-{phase}.jsonl')[1:]  # first sample covers a partial minute
    probe = load(f'probe-{phase}.jsonl')
    if not mon:
        continue
    f = [m['fanout'] for m in mon]
    def q(key):
        vals = [x[key] for x in f if x[key] is not None]
        return {'median': st.median(vals), 'max': max(vals)} if vals else None
    out[phase] = {
        'minutes': len(mon),
        'spotBooksPerMin': round(st.mean(x['spotMsgs'] for x in f)),
        'futuresBooksPerMin': round(st.mean(x['futuresMsgs'] for x in f)),
        'spotProducts': min(x['spotProducts'] for x in f),
        'futuresProducts': min(x['futuresProducts'] for x in f),
        'spotLagMs': {k: q(f'spotLag{k}') for k in ('P50', 'P95', 'P99', 'Max')},
        'futuresLagMs': {k: q(f'futuresLag{k}') for k in ('P50', 'P95', 'P99', 'Max')},
        'markStaleSamples': sum(1 for m in mon if (m['futuresMark'] or {}).get('stale')),
        'spotReconnects': mon[-1]['spotWs']['reconnects'],
        'walMbPerMin': round(st.mean(m['db']['walBytes'] for m in mon if m['db']['walBytes']) / 1e6, 2),
        'cpuPercent': {'mean': round(st.mean(p['cpuPercent'] for p in probe), 1), 'p95': sorted(p['cpuPercent'] for p in probe)[int(0.95 * len(probe)) - 1], 'max': max(p['cpuPercent'] for p in probe)},
        'rssMb': {'first': probe[0]['rssMb'], 'last': probe[-1]['rssMb'], 'max': max(p['rssMb'] for p in probe)},
        'eventLoopOver10msTimerMs': {'p99Max': round(max(p['loopP99Ms'] for p in probe) - 10, 2), 'maxMax': round(max(p['loopMaxMs'] for p in probe) - 10, 2)},
        'history': mon[-1].get('history'),
        'rows': {k: mon[-1]['db'][k] for k in ('spot', 'futures')},
        'bytes': {k: mon[-1]['db'][k] for k in ('spot_bytes', 'futures_bytes')},
    }
print(json.dumps(out, indent=1))
