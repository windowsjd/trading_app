"""Step 2: fetch 2026 daily history from api.nasdaq.com for every pool symbol.

usage: python3 -I 02_fetch_nasdaq_history.py <work_dir/pool.csv> <raw_dir/nasdaq_hist> <log_csv>

Cached: an existing non-empty JSON with data is not re-fetched.
Rate limit: global <= ~3 requests/s, 6 workers (server TTFB ~2 s), exponential backoff on 429/5xx.
Preferred shares ('^' in the symbol) are not fetched (flagged later as excluded class).
"""
import csv
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import append_log, fetch_with_backoff, utc_now  # noqa: E402

URL = ("https://api.nasdaq.com/api/quote/{sym}/historical?assetclass=stocks"
       "&fromdate=2026-01-01&todate=2026-10-16&limit=9999")
HEADERS = ["Accept: application/json, text/plain, */*", "Accept-Language: en-US,en;q=0.9",
           "Origin: https://www.nasdaq.com", "Referer: https://www.nasdaq.com/"]

_lock = threading.Lock()
_last = [0.0]
MIN_GAP = 0.34  # seconds between request starts (~3 req/s)


def throttle():
    with _lock:
        now = time.monotonic()
        wait = _last[0] + MIN_GAP - now
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()


def good(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d.get("data") is not None and d["data"].get("tradesTable") is not None
    except Exception:
        return False


def ok(code, path):
    if code != 200:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            json.load(f)
        return True
    except Exception:
        return False


def fetch(sym, outdir):
    out = os.path.join(outdir, sym.replace("/", "_") + ".json")
    if os.path.exists(out) and good(out):
        return sym, "cached", 0
    throttle()
    code, tries = fetch_with_backoff(URL.format(sym=sym), out, headers=HEADERS, ok=ok)
    status = "ok" if (code == 200 and good(out)) else ("http%d" % code if code != 200 else "nodata")
    return sym, status, tries


def main():
    pool_csv, outdir, log_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    syms = [r["symbol"] for r in csv.DictReader(open(pool_csv, encoding="utf-8"))]
    todo = [s for s in syms if "^" not in s]
    t0 = utc_now()
    results = {}
    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, status, tries in ex.map(lambda s: fetch(s, outdir), todo):
            results[sym] = status
            done += 1
            if done % 50 == 0:
                print(done, len(todo), sym, status, flush=True)
    with open(os.path.join(outdir, "_fetch_status.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "status"])
        for s in syms:
            w.writerow([s, results.get(s, "skipped_preferred")])
    counts = {}
    for v in results.values():
        counts[v] = counts.get(v, 0) + 1
    append_log(log_csv, ["api.nasdaq.com historical",
                         "https://api.nasdaq.com/api/quote/{SYMBOL}/historical?assetclass=stocks&fromdate=2026-01-01&todate=2026-10-16&limit=9999",
                         t0 + ".." + utc_now(),
                         "%d symbols: %s" % (len(todo), json.dumps(counts, sort_keys=True)),
                         "daily OHLCV for EST_close / EST_typical, sessions, first trade date"])
    print("done", counts)


if __name__ == "__main__":
    main()
