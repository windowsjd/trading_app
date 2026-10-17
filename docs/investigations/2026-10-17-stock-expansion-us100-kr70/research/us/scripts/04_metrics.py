"""Step 4: per-symbol 2026 YTD metrics from the cached Nasdaq daily history.

usage: python3 -I 04_metrics.py <work_dir/pool.csv> <raw_dir/nasdaq_hist> <work_dir/metrics.csv>

EST_close   = sum(close * volume)                  -- ESTIMATE of USD dollar volume
EST_typical = sum(((high + low + close) / 3) * volume)  -- sensitivity check only
Neither is an exchange-reported traded value.

Also flags: sessions vs expected NYSE calendar, missing sessions after the first
trade date, zero/NA rows, and one-day price discontinuities that look like an
unadjusted split (price ratio ~ 2/3/4/5/10 or the reciprocal with an inverse
volume jump).
"""
import csv
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WINDOW_END, WINDOW_START, expected_sessions, num  # noqa: E402

SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50]


def load_rows(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return None, "unreadable"
    data = d.get("data")
    if not data or not data.get("tradesTable"):
        msg = ""
        st = d.get("status") or {}
        if st.get("bCodeMessage"):
            msg = ";".join(str(x.get("errorMessage")) for x in st["bCodeMessage"])
        return None, "nodata:" + msg
    rows = data["tradesTable"].get("rows") or []
    out = []
    for r in rows:
        try:
            d0 = dt.datetime.strptime(r["date"], "%m/%d/%Y").date()
        except Exception:
            continue
        out.append({"date": d0, "close": num(r.get("close")), "volume": num(r.get("volume")),
                    "open": num(r.get("open")), "high": num(r.get("high")), "low": num(r.get("low"))})
    out.sort(key=lambda x: x["date"])
    return out, "ok"


def split_like(prev, cur):
    """Return a note if the close->open (or close->close) step looks like a split."""
    if not prev["close"] or not cur["close"]:
        return None
    ref = cur["open"] or cur["close"]
    r = prev["close"] / ref
    for k in SPLIT_RATIOS:
        for ratio, kind in ((k, "forward %d:1" % k), (1.0 / k, "reverse 1:%d" % k)):
            if abs(r / ratio - 1) < 0.12:
                vnote = ""
                if prev["volume"] and cur["volume"]:
                    vr = cur["volume"] / prev["volume"]
                    vnote = " vol x%.2f" % vr
                return "split-like step (heuristic, unconfirmed) %s on %s (prev close %.4g -> open %.4g%s)" % (kind, cur["date"], prev["close"], ref, vnote)
    return None


def main():
    pool_csv, histdir, out_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    exp = expected_sessions()
    exp_set = set(exp)
    pool = list(csv.DictReader(open(pool_csv, encoding="utf-8")))
    fields = ["symbol", "hist_status", "rows_total", "sessions_2026", "expected_sessions",
              "first_trade_date_2026", "last_trade_date", "missing_sessions_after_first",
              "missing_dates_sample", "extra_dates_not_in_calendar", "rows_null_or_zero_volume",
              "est_close_usd", "est_typical_usd", "typical_vs_close_pct", "last_close",
              "latest_day_volume", "latest_day_date", "avg_daily_est_close_usd",
              "max_abs_1d_move_pct", "max_move_date", "split_like_steps"]
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for p in pool:
            sym = p["symbol"]
            path = os.path.join(histdir, sym.replace("/", "_") + ".json")
            rec = {"symbol": sym, "expected_sessions": len(exp)}
            if "^" in sym:
                rec["hist_status"] = "not_fetched_preferred"
                w.writerow(rec)
                continue
            if not os.path.exists(path):
                rec["hist_status"] = "missing_file"
                w.writerow(rec)
                continue
            rows, st = load_rows(path)
            rec["hist_status"] = st
            if rows is None:
                w.writerow(rec)
                continue
            rec["rows_total"] = len(rows)
            win = [r for r in rows if WINDOW_START <= r["date"] <= WINDOW_END]
            rec["sessions_2026"] = len(win)
            if not win:
                w.writerow(rec)
                continue
            first, last = win[0]["date"], win[-1]["date"]
            rec["first_trade_date_2026"] = first.isoformat()
            rec["last_trade_date"] = last.isoformat()
            have = {r["date"] for r in win}
            missing = [d for d in exp if first <= d <= last and d not in have]
            rec["missing_sessions_after_first"] = len(missing)
            rec["missing_dates_sample"] = " ".join(d.isoformat() for d in missing[:8])
            extra = [d for d in have if d not in exp_set]
            rec["extra_dates_not_in_calendar"] = " ".join(sorted(d.isoformat() for d in extra))
            est_c = est_t = 0.0
            bad = 0
            for r in win:
                c, v = r["close"], r["volume"]
                if c is None or v is None or v == 0:
                    bad += 1
                    continue
                est_c += c * v
                if r["high"] is not None and r["low"] is not None:
                    est_t += ((r["high"] + r["low"] + c) / 3.0) * v
                else:
                    est_t += c * v
            rec["rows_null_or_zero_volume"] = bad
            rec["est_close_usd"] = round(est_c, 2)
            rec["est_typical_usd"] = round(est_t, 2)
            rec["typical_vs_close_pct"] = round((est_t / est_c - 1) * 100, 4) if est_c else ""
            rec["last_close"] = win[-1]["close"]
            rec["latest_day_volume"] = win[-1]["volume"]
            rec["latest_day_date"] = last.isoformat()
            rec["avg_daily_est_close_usd"] = round(est_c / len(win), 2)
            mx, mxd, splits = 0.0, "", []
            for a, b in zip(win, win[1:]):
                if a["close"] and b["close"]:
                    mv = abs(b["close"] / a["close"] - 1) * 100
                    if mv > mx:
                        mx, mxd = mv, b["date"].isoformat()
                    note = split_like(a, b) if mv > 30 else None
                    if note:
                        splits.append(note)
            rec["max_abs_1d_move_pct"] = round(mx, 2)
            rec["max_move_date"] = mxd
            rec["split_like_steps"] = " | ".join(splits)
            w.writerow(rec)
    print("wrote", out_csv)


if __name__ == "__main__":
    main()
