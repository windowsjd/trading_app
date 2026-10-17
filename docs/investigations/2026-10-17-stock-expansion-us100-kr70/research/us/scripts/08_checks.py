"""Step 8: sanity checks quoted in the README.

usage: python3 -I 08_checks.py <work_dir> <raw_dir> [out_dir/us_ranked_pool.csv]

1. Calendar: the weekdays in 2026-01-02..2026-10-16 on which no pool symbol has a row
   must equal the assumed NYSE holiday list, and no symbol may have a row on a holiday.
2. gainbot ordering: is the 'Most active / Year to Date' page ordered by YTD dollar
   volume or by the latest session's price x volume?  (Spearman correlation of the
   page order against both, using our EST_close for the YTD side.)
3. (needs us_ranked_pool.csv) Is the preliminary 75 + alternates list identical to the
   single-session 2026-10-15 ranking (screener lastsale x volume) after removing the
   existing 25 and non common/ordinary classes?
"""
import csv
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (ALTERNATES, EXISTING_25, NYSE_HOLIDAYS_2026, PRELIMINARY_75,  # noqa: E402
                    WINDOW_END, WINDOW_START)


def spearman(a, b):
    n = len(a)
    if n < 3:
        return None

    def ranks(x):
        order = sorted(range(n), key=lambda i: x[i])
        r = [0] * n
        for k, i in enumerate(order):
            r[i] = k + 1
        return r
    ra, rb = ranks(a), ranks(b)
    d2 = sum((x - y) ** 2 for x, y in zip(ra, rb))
    return 1 - 6 * d2 / (n * (n * n - 1))


def main():
    work, raw = sys.argv[1], sys.argv[2]
    hdir = os.path.join(raw, "nasdaq_hist")
    seen = {}
    nsym = 0
    for fn in os.listdir(hdir):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(hdir, fn), encoding="utf-8") as f:
                d = json.load(f)
            rows = d["data"]["tradesTable"]["rows"]
        except Exception:
            continue
        nsym += 1
        for r in rows:
            day = dt.datetime.strptime(r["date"], "%m/%d/%Y").date()
            if WINDOW_START <= day <= WINDOW_END:
                seen[day] = seen.get(day, 0) + 1
    weekdays = []
    x = WINDOW_START
    while x <= WINDOW_END:
        if x.weekday() < 5:
            weekdays.append(x)
        x += dt.timedelta(days=1)
    no_data = [d.isoformat() for d in weekdays if d not in seen]
    hol_in_window = [d.isoformat() for d in NYSE_HOLIDAYS_2026 if WINDOW_START <= d <= WINDOW_END]
    hol_with_data = {d.isoformat(): seen[d] for d in NYSE_HOLIDAYS_2026 if d in seen}
    thin = {d.isoformat(): c for d, c in seen.items() if c < 0.5 * nsym}
    cal = {"symbols_scanned": nsym, "weekdays_in_window": len(weekdays),
           "weekdays_without_any_row": no_data, "assumed_holidays_in_window": hol_in_window,
           "match": sorted(no_data) == sorted(hol_in_window),
           "holidays_with_rows": hol_with_data, "dates_with_rows_for_lt_half_of_symbols": thin,
           "trading_days_observed": len(seen)}

    met = {r["symbol"]: r for r in csv.DictReader(open(os.path.join(work, "metrics.csv"), encoding="utf-8"))}
    gb = list(csv.DictReader(open(os.path.join(work, "gainbot_current.csv"), encoding="utf-8")))
    pos, one_day, ytd, missing = [], [], [], []
    for g in gb:
        m = met.get(g["symbol"])
        if not m or not m.get("est_close_usd"):
            missing.append(g["symbol"])
            continue
        pos.append(-int(g["gb_rank"]))
        one_day.append(float(g["gb_price"]) * float(g["gb_volume"]))
        ytd.append(float(m["est_close_usd"]))
    gbres = {"rows": len(gb), "matched": len(pos), "missing": missing,
             "spearman_page_order_vs_latest_session_price_x_volume": round(spearman(pos, one_day), 4),
             "spearman_page_order_vs_our_ytd_est_close": round(spearman(pos, ytd), 4)}
    out = {"calendar": cal, "gainbot_order": gbres}
    if len(sys.argv) > 3:
        cls = {r["symbol"]: r["security_class"] for r in csv.DictReader(open(sys.argv[3], encoding="utf-8"))}
        pool = list(csv.DictReader(open(os.path.join(work, "pool.csv"), encoding="utf-8")))
        order = sorted([r for r in pool if r["snap_dollar_volume"]],
                       key=lambda r: float(r["snap_dollar_volume"]), reverse=True)
        seq = [r["symbol"] for r in order if r["symbol"] not in EXISTING_25
               and cls.get(r["symbol"]) in ("common", "ordinary")]
        target = PRELIMINARY_75 + ALTERNATES
        removed = [r["symbol"] for r in order[:120] if r["symbol"] not in EXISTING_25
                   and cls.get(r["symbol"]) not in ("common", "ordinary")]
        out["preliminary_vs_1015_single_session"] = {
            "positions_compared": len(target),
            "identical_order": seq[:len(target)] == target,
            "first_mismatch": next(({"pos": i + 1, "ours": a, "preliminary": b}
                                    for i, (a, b) in enumerate(zip(seq, target)) if a != b), None),
            "non_common_names_removed_from_top120": removed,
        }
    with open(os.path.join(work, "checks.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
