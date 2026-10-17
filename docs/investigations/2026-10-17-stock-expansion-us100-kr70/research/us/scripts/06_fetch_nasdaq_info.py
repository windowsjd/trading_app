"""Step 6: fetch Nasdaq quote 'info' (stockType, listing exchange, company name) for the
top-K pool symbols by EST_close plus all named lists.

usage: python3 -I 06_fetch_nasdaq_info.py <work_dir/metrics.csv> <raw_dir/nasdaq_info> <log_csv> [K] [pool.csv]

If pool.csv is given, every pool symbol whose screener country is not
'United States' (or is blank) is added, so foreign issuers are classified by
stockType rather than by name text (the screener calls many ADRs "Common Stock").

stockType values seen: 'Common Stock', 'American Depositary Shares', 'Ordinary Shares', ...
Rate: <= ~3 req/s, 6 workers, backoff on 429/5xx, cached.
"""
import csv
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (ALTERNATES, EXISTING_25, PRELIMINARY_75, append_log,  # noqa: E402
                    fetch_with_backoff, utc_now)

URL = "https://api.nasdaq.com/api/quote/{sym}/info?assetclass=stocks"
HEADERS = ["Accept: application/json, text/plain, */*", "Accept-Language: en-US,en;q=0.9",
           "Origin: https://www.nasdaq.com", "Referer: https://www.nasdaq.com/"]
_lock = threading.Lock()
_last = [0.0]


def throttle():
    with _lock:
        wait = _last[0] + 0.34 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()


def ok(code, path):
    if code != 200:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            json.load(f)
        return True
    except Exception:
        return False


def good(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("data") is not None
    except Exception:
        return False


def fetch(sym, outdir):
    out = os.path.join(outdir, sym.replace("/", "_") + ".json")
    if os.path.exists(out) and good(out):
        return sym, "cached"
    throttle()
    code, _ = fetch_with_backoff(URL.format(sym=sym), out, headers=HEADERS, ok=ok)
    return sym, ("ok" if good(out) else "http%d/nodata" % code)


def main():
    metrics, outdir, log_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    k = int(sys.argv[4]) if len(sys.argv) > 4 else 350
    foreign = []
    if len(sys.argv) > 5:
        foreign = [r["symbol"] for r in csv.DictReader(open(sys.argv[5], encoding="utf-8"))
                   if (r.get("country") or "").strip() != "United States"]
    os.makedirs(outdir, exist_ok=True)
    rows = [r for r in csv.DictReader(open(metrics, encoding="utf-8"))]
    ranked = sorted([r for r in rows if r.get("est_close_usd")],
                    key=lambda r: float(r["est_close_usd"]), reverse=True)
    syms = []
    for s in [r["symbol"] for r in ranked[:k]] + EXISTING_25 + PRELIMINARY_75 + ALTERNATES + foreign:
        if s not in syms and "^" not in s:
            syms.append(s)
    t0 = utc_now()
    res = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, st in ex.map(lambda s: fetch(s, outdir), syms):
            res[sym] = st
    counts = {}
    for v in res.values():
        counts[v] = counts.get(v, 0) + 1
    append_log(log_csv, ["api.nasdaq.com quote info",
                         "https://api.nasdaq.com/api/quote/{SYMBOL}/info?assetclass=stocks",
                         t0 + ".." + utc_now(),
                         "%d symbols (top %d by EST_close + named lists + %d non-US pool symbols): %s" % (len(syms), k, len(foreign), json.dumps(counts, sort_keys=True)),
                         "security class (stockType) and listing exchange"])
    print(counts)


if __name__ == "__main__":
    main()
