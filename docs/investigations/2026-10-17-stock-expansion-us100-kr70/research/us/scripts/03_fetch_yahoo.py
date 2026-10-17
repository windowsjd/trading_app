"""Step 3: second daily source (Yahoo chart API) for cross-checking volume coverage
and split adjustment.

usage: python3 -I 03_fetch_yahoo.py <raw_dir/yahoo> <log_csv> SYM [SYM ...]

Symbols use the Nasdaq/dot form (BRK.B); converted to Yahoo's dash form (BRK-B).
Window: period1 = 2026-01-01T00:00Z (1767225600), period2 = 2026-10-17T00:00Z (1792195200).
~1 request/s, exponential backoff on 429/5xx, cached.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import append_log, fetch_with_backoff, utc_now  # noqa: E402

P1, P2 = 1767225600, 1792195200
URL = ("https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1=%d&period2=%d"
       "&interval=1d&events=split%%7Cdiv") % (P1, P2)


def ok(code, path):
    if code != 200:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return bool(d["chart"]["result"])
    except Exception:
        return False


def main():
    outdir, log_csv, syms = sys.argv[1], sys.argv[2], sys.argv[3:]
    os.makedirs(outdir, exist_ok=True)
    t0 = utc_now()
    res = {}
    for s in syms:
        ysym = s.replace(".", "-")
        out = os.path.join(outdir, s.replace("/", "_") + ".json")
        if os.path.exists(out) and ok(200, out):
            res[s] = "cached"
            continue
        code, tries = fetch_with_backoff(URL.format(sym=ysym), out, ok=ok, max_tries=4)
        res[s] = "ok" if ok(code, out) else "http%d" % code
        time.sleep(1.0)
    append_log(log_csv, ["Yahoo Finance chart API v8 (second source)",
                         "https://query1.finance.yahoo.com/v8/finance/chart/{SYM}?period1=1767225600&period2=1792195200&interval=1d&events=split|div",
                         t0 + ".." + utc_now(),
                         "%d symbols: %s" % (len(syms), json.dumps(
                             {k: sum(1 for v in res.values() if v == k) for k in sorted(set(res.values()))})),
                         "cross-check of daily volume coverage (consolidated?) and split adjustment"])
    print(res)


if __name__ == "__main__":
    main()
