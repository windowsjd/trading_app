"""Step 5: compare Nasdaq daily history with Yahoo chart data (second source).

usage: python3 -I 05_crosscheck_yahoo.py <raw_dir/nasdaq_hist> <raw_dir/yahoo> <out_csv>

Per symbol: common dates, median / min / max of daily volume ratio (Nasdaq/Yahoo),
close ratio (detects different split adjustment), EST_close ratio, Yahoo split
events inside the window, and the Yahoo exchange code. The latest session
(2026-10-16) is reported separately because Yahoo's last bar can still be
provisional.
"""
import csv
import datetime as dt
import json
import os
import statistics
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WINDOW_END, WINDOW_START, num  # noqa: E402

NY = ZoneInfo("America/New_York")


def nasdaq(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    out = {}
    for r in (d.get("data") or {}).get("tradesTable", {}).get("rows", []) or []:
        day = dt.datetime.strptime(r["date"], "%m/%d/%Y").date()
        if WINDOW_START <= day <= WINDOW_END:
            out[day] = (num(r["close"]), num(r["volume"]))
    return out


def yahoo(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    res = d["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    out = {}
    for i, t in enumerate(res.get("timestamp") or []):
        day = dt.datetime.fromtimestamp(t, NY).date()
        if WINDOW_START <= day <= WINDOW_END and q["close"][i] is not None and q["volume"][i] is not None:
            out[day] = (q["close"][i], q["volume"][i])
    splits = []
    for s in ((res.get("events") or {}).get("splits") or {}).values():
        day = dt.datetime.fromtimestamp(s["date"], NY).date()
        if WINDOW_START <= day <= WINDOW_END:
            splits.append("%s %s" % (day.isoformat(), s.get("splitRatio")))
    meta = res.get("meta", {})
    return out, sorted(splits), meta.get("exchangeName", ""), meta.get("instrumentType", "")


def main():
    ndir, ydir, out_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = []
    for fn in sorted(os.listdir(ydir)):
        if not fn.endswith(".json"):
            continue
        sym = fn[:-5]
        npath = os.path.join(ndir, fn)
        if not os.path.exists(npath):
            continue
        try:
            n = nasdaq(npath)
            y, splits, yex, ytype = yahoo(os.path.join(ydir, fn))
        except Exception as e:  # noqa: BLE001
            rows.append({"symbol": sym, "note": "parse error %s" % e})
            continue
        common = sorted(set(n) & set(y))
        hist = [d for d in common if d < WINDOW_END]
        vr = [n[d][1] / y[d][1] for d in hist if y[d][1]]
        cr = [n[d][0] / y[d][0] for d in hist if y[d][0]]
        en = sum(n[d][0] * n[d][1] for d in common)
        ey = sum(y[d][0] * y[d][1] for d in common)
        en_h = sum(n[d][0] * n[d][1] for d in hist)
        ey_h = sum(y[d][0] * y[d][1] for d in hist)
        last = WINDOW_END if WINDOW_END in common else None
        rows.append({
            "symbol": sym, "yahoo_exchange": yex, "yahoo_type": ytype,
            "nasdaq_rows": len(n), "yahoo_rows": len(y), "common_rows": len(common),
            "nasdaq_only_dates": " ".join(d.isoformat() for d in sorted(set(n) - set(y))[:5]),
            "yahoo_only_dates": " ".join(d.isoformat() for d in sorted(set(y) - set(n))[:5]),
            "vol_ratio_median_excl_last": round(statistics.median(vr), 6) if vr else "",
            "vol_ratio_min_excl_last": round(min(vr), 6) if vr else "",
            "vol_ratio_max_excl_last": round(max(vr), 6) if vr else "",
            "days_vol_diff_gt_1pct_excl_last": sum(1 for x in vr if abs(x - 1) > 0.01),
            "close_ratio_min": round(min(cr), 6) if cr else "",
            "close_ratio_max": round(max(cr), 6) if cr else "",
            "est_close_ratio_all": round(en / ey, 6) if ey else "",
            "est_close_ratio_excl_last": round(en_h / ey_h, 6) if ey_h else "",
            "last_day_vol_ratio": round(n[last][1] / y[last][1], 6) if last and y[last][1] else "",
            "yahoo_splits_in_window": " ".join(splits),
        })
    fields = ["symbol", "yahoo_exchange", "yahoo_type", "nasdaq_rows", "yahoo_rows", "common_rows",
              "nasdaq_only_dates", "yahoo_only_dates", "vol_ratio_median_excl_last",
              "vol_ratio_min_excl_last", "vol_ratio_max_excl_last", "days_vol_diff_gt_1pct_excl_last",
              "close_ratio_min", "close_ratio_max", "est_close_ratio_all", "est_close_ratio_excl_last",
              "last_day_vol_ratio", "yahoo_splits_in_window", "note"]
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print("wrote", out_csv, len(rows))


if __name__ == "__main__":
    main()
