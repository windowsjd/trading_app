"""Step 9: does the second source (Yahoo chart API) produce the same new-75 set?

usage: python3 -I 09_second_source_rank_check.py <out_dir/us_ranked_pool.csv> <raw_dir/yahoo> <work_dir/second_source_check.json>

For every R1-eligible, non-existing symbol with Nasdaq EST_close >= COVER x cutoff we
require a Yahoo file, compute YEST_close = sum(Yahoo close * Yahoo volume) over the same
window, and compare the top-75 sets. Yahoo's split-adjusted close x split-adjusted
volume is invariant to splits, like Nasdaq's. Both are ESTIMATES; they are compared
with each other only, never added.
"""
import csv
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WINDOW_END, WINDOW_START  # noqa: E402

NY = ZoneInfo("America/New_York")
COVER = 0.70
N_NEW = 75


def yest(path):
    with open(path, encoding="utf-8") as f:
        res = json.load(f)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    tot, n = 0.0, 0
    for i, t in enumerate(res.get("timestamp") or []):
        day = dt.datetime.fromtimestamp(t, NY).date()
        c, v = q["close"][i], q["volume"][i]
        if WINDOW_START <= day <= WINDOW_END and c is not None and v:
            tot += c * v
            n += 1
    return tot, n


def main():
    pool_csv, ydir, out = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = [r for r in csv.DictReader(open(pool_csv, encoding="utf-8"))]
    elig = [r for r in rows if r["r1_eligible"] == "1" and r["in_existing25"] == "0" and r["est_close_usd"]]
    elig.sort(key=lambda r: float(r["est_close_usd"]), reverse=True)
    cutoff = float(elig[N_NEW - 1]["est_close_usd"])
    need = [r for r in elig if float(r["est_close_usd"]) >= COVER * cutoff]
    missing, recs = [], []
    for r in need:
        p = os.path.join(ydir, r["symbol"].replace("/", "_") + ".json")
        if not os.path.exists(p):
            missing.append(r["symbol"])
            continue
        y, n = yest(p)
        recs.append({"symbol": r["symbol"], "nasdaq_est": float(r["est_close_usd"]), "yahoo_est": y,
                     "yahoo_sessions": n, "ratio": y / float(r["est_close_usd"])})
    nas_top = [r["symbol"] for r in elig[:N_NEW]]
    ys = sorted(recs, key=lambda r: r["yahoo_est"], reverse=True)
    y_top = [r["symbol"] for r in ys[:N_NEW]]
    yrank = {r["symbol"]: i + 1 for i, r in enumerate(ys)}
    result = {
        "coverage_rule": "all R1-eligible new names with Nasdaq EST_close >= %.0f%% of the #75 cutoff" % (COVER * 100),
        "symbols_required": len(need), "symbols_missing_yahoo": missing,
        "same_set": set(nas_top) == set(y_top) and not missing,
        "yahoo_top75_not_in_nasdaq_top75": [s for s in y_top if s not in nas_top],
        "nasdaq_top75_not_in_yahoo_top75": [s for s in nas_top if s not in y_top],
        "yahoo_cutoff_symbol": y_top[-1] if len(y_top) >= N_NEW else None,
        "rank_moves_gt_2": [{"symbol": s, "nasdaq_new_rank": i + 1, "yahoo_new_rank": yrank.get(s)}
                            for i, s in enumerate(nas_top) if yrank.get(s) and abs(yrank[s] - (i + 1)) > 2],
        "ratio_min": min(r["ratio"] for r in recs), "ratio_max": max(r["ratio"] for r in recs),
        "largest_ratio_deviations": sorted(({"symbol": r["symbol"], "yahoo_over_nasdaq": round(r["ratio"], 5)}
                                            for r in recs), key=lambda x: -abs(x["yahoo_over_nasdaq"] - 1))[:6],
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
