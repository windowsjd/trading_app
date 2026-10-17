"""Step 7: classify, attach Tiingo identity, rank by EST_close, write the output CSVs.

usage: python3 -I 07_rank_report.py <work_dir> <raw_dir> <out_dir>

Inputs (work_dir): pool.csv, metrics.csv, crosscheck_yahoo.csv (optional),
                   corporate_actions_manual.csv (optional, hand-verified notes)
Inputs (raw_dir):  nasdaq_info/*.json, tiingo/unz/supported_tickers.csv, yahoo/*.json
Outputs (out_dir): us_ranked_pool.csv, us_new75.csv, us_preliminary_diff.csv,
                   summary.json (numbers quoted in README)

Ranking metric: EST_close = sum(close * volume) over 2026-01-02..2026-10-16 from
Nasdaq daily history (consolidated volume). It is an ESTIMATE of dollar volume.
EST_typical is used only as a sensitivity check and is never mixed with EST_close.
"""
import csv
import datetime as dt
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (ALTERNATES, EXISTING_25, PRELIMINARY_75, WINDOW_END,  # noqa: E402
                    WINDOW_START)

NY = ZoneInfo("America/New_York")
N_NEW = 75
TIINGO_EXCH = {"NASDAQ": {"NASDAQ"}, "NYSE": {"NYSE"}, "NYSE American": {"AMEX", "NYSE MKT"},
               "NYSE Arca": {"NYSE ARCA"}, "Cboe BZX": {"BATS"}}


def norm_exchange(s):
    s = (s or "").upper()
    if s.startswith("NASDAQ"):
        return "NASDAQ"
    if s in ("NYSE", "NEW YORK STOCK EXCHANGE"):
        return "NYSE"
    if "AMERICAN" in s or s in ("AMEX", "NYSE MKT", "NYSEAMERICAN"):
        return "NYSE American"
    if "ARCA" in s:
        return "NYSE Arca"
    if "BZX" in s or "BATS" in s or "CBOE" in s:
        return "Cboe BZX"
    return s


def classify(sym, name, stock_type, tiingo_types):
    """Return (security_class, source, note)."""
    n = (name or "").lower()
    st = (stock_type or "").lower()
    if "^" in sym or "preferred" in n or "preferred" in st:
        return "preferred", "symbol/name", ""
    if re.search(r"\bwarrants?\b", n) or "warrant" in st:
        return "warrant", "name", ""
    if re.search(r"\bunits?\b", n) and "common units" not in n and "partnership" not in n:
        return "unit", "name", ""
    if re.search(r"\brights?\b", n) and "rights" in n.split()[-2:]:
        return "right", "name", ""
    if "ETF" in (tiingo_types or set()) or re.search(r"\b(etf|etn|exchange traded)\b", n):
        return "etf_etn_fund", "tiingo/name", ""
    if "Mutual Fund" in (tiingo_types or set()) and not st:
        return "etf_etn_fund", "tiingo", ""
    if "depositary" in st or "american depositary" in n or re.search(r"\b(ads|adr)\b", n) \
            or "depositary shares" in n or "depository" in n:
        return "adr_ads", ("nasdaq_info.stockType" if "depositary" in st else "name"), ""
    if "registry" in st or "new york registry" in n:
        return "ny_registry", ("nasdaq_info.stockType" if "registry" in st else "name"), ""
    if "partnership" in n or "common units" in n or "unit" in st:
        return "lp_units", "name", ""
    if "ordinary" in st or "ordinary share" in n:
        return "ordinary", ("nasdaq_info.stockType" if "ordinary" in st else "name"), ""
    if "common" in st or "capital stock" in st:
        return "common", "nasdaq_info.stockType", ""
    if re.search(r"common (stock|shares)|capital stock|subordinate voting|class [abc]\b|"
                 r"shares of beneficial interest", n):
        return "common", "name", ""
    if st:
        return "other:" + st, "nasdaq_info.stockType", ""
    return "unverified", "", "no stockType and name text not decisive"


def load_tiingo(path):
    rows = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for r in csv.DictReader(f):
            rows.setdefault((r["ticker"] or "").upper(), []).append(r)
    return rows


def tiingo_identity(sym, exch, tmap):
    t = sym.replace(".", "-").replace("/", "-").upper()
    rows = tmap.get(t, [])
    cur = [r for r in rows if r["assetType"] == "Stock" and r["priceCurrency"] == "USD"
           and (r["endDate"] or "") >= "2026-10-15"]
    want = TIINGO_EXCH.get(exch, set())
    cur_ex = [r for r in cur if r["exchange"] in want] if want else cur
    flags = []
    if not rows:
        flags.append("tiingo_missing")
    elif not cur:
        flags.append("tiingo_no_current_usd_stock_row")
    elif not cur_ex:
        flags.append("tiingo_exchange_mismatch(%s vs %s)" % (exch, "/".join(sorted({r['exchange'] for r in cur}))))
    if len(cur) > 1:
        flags.append("tiingo_multiple_current_rows")
    reuse = ""
    if len(rows) > 1:
        reuse = "ticker reused / multiple rows: " + "; ".join(
            "%s %s %s %s..%s" % (r["exchange"], r["assetType"], r["priceCurrency"], r["startDate"], r["endDate"])
            for r in sorted(rows, key=lambda r: r["startDate"] or ""))
    summary = "; ".join("%s|%s|%s|%s..%s" % (r["exchange"], r["assetType"], r["priceCurrency"],
                                              r["startDate"], r["endDate"]) for r in rows)
    start = min((r["startDate"] for r in cur_ex or cur), default="")
    return t.lower(), summary, reuse, flags, {r["assetType"] for r in rows}, start


def yahoo_splits(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            res = json.load(f)["chart"]["result"][0]
    except Exception:
        return None
    out = []
    ev = res.get("events") or {}
    for s in (ev.get("splits") or {}).values():
        day = dt.datetime.fromtimestamp(s["date"], NY).date()
        if WINDOW_START <= day <= WINDOW_END:
            out.append("split %s on %s (Yahoo)" % (s.get("splitRatio"), day.isoformat()))
    return sorted(out)


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def main():
    work, raw, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    pool = {r["symbol"]: r for r in csv.DictReader(open(os.path.join(work, "pool.csv"), encoding="utf-8"))}
    met = {r["symbol"]: r for r in csv.DictReader(open(os.path.join(work, "metrics.csv"), encoding="utf-8"))}
    tmap = load_tiingo(os.path.join(raw, "tiingo", "unz", "supported_tickers.csv"))
    manual = {}
    mpath = os.path.join(work, "corporate_actions_manual.csv")
    if os.path.exists(mpath):
        for r in csv.DictReader(open(mpath, encoding="utf-8")):
            manual.setdefault(r["symbol"], []).append(r["note"])

    recs = []
    for sym, p in pool.items():
        m = met.get(sym, {})
        info = {}
        ipath = os.path.join(raw, "nasdaq_info", sym.replace("/", "_") + ".json")
        if os.path.exists(ipath):
            try:
                with open(ipath, encoding="utf-8") as f:
                    info = (json.load(f).get("data") or {})
            except Exception:
                info = {}
        exch = norm_exchange(info.get("exchange")) if info.get("exchange") else \
            (p.get("screener_exchanges") or "").split("|")[0]
        name = (info.get("companyName") or p.get("name") or "").strip()
        sname = (p.get("name") or "").strip()
        tt, tsum, reuse, tflags, ttypes, tstart = tiingo_identity(sym, exch, tmap)
        cls, csrc, cnote = classify(sym, sname or name, info.get("stockType"), ttypes)
        est = fnum(m.get("est_close_usd"))
        last = m.get("last_trade_date") or ""
        tradable = bool(est) and last == WINDOW_END.isoformat()
        r1_reason = ""
        if not est:
            r1_reason = "no 2026 history (%s)" % (m.get("hist_status") or "n/a")
        elif not tradable:
            r1_reason = "not trading at window end (last trade %s)" % last
        elif cls not in ("common", "ordinary"):
            r1_reason = "class:" + cls
        r1 = r1_reason == ""
        r2 = (tradable and cls in ("common", "ordinary", "adr_ads"))
        r1ny = (tradable and cls in ("common", "ordinary", "ny_registry"))
        r2ny = (tradable and cls in ("common", "ordinary", "adr_ads", "ny_registry"))
        notes = []
        if m.get("first_trade_date_2026") and m["first_trade_date_2026"] > WINDOW_START.isoformat():
            notes.append("first 2026 session %s (screener ipoyear %s; Tiingo current-row start %s)" % (
                m["first_trade_date_2026"], p.get("ipoyear") or "-", tstart or "-"))
        if m.get("missing_sessions_after_first") not in (None, "", "0"):
            notes.append("%s expected sessions missing after first trade (%s)" % (
                m["missing_sessions_after_first"], m.get("missing_dates_sample")))
        if m.get("split_like_steps"):
            notes.append("price step in Nasdaq series: " + m["split_like_steps"])
        ys = yahoo_splits(os.path.join(raw, "yahoo", sym.replace("/", "_") + ".json"))
        if ys:
            notes.extend(ys)
        if tstart and tstart >= "2026-01-01" and not (m.get("first_trade_date_2026") or "") > "2026-01-02":
            notes.append("Tiingo current row starts %s although Nasdaq history covers the full window" % tstart)
        notes.extend(manual.get(sym, []))
        recs.append({
            "symbol": sym, "tiingo_ticker": tt, "name": name, "screener_name": sname,
            "exchange": exch, "security_class": cls, "class_source": csrc,
            "nasdaq_stock_type": info.get("stockType", ""), "country": p.get("country", ""),
            "ipoyear": p.get("ipoyear", ""),
            "in_existing25": int(sym in EXISTING_25), "in_preliminary75": int(sym in PRELIMINARY_75),
            "in_alternates": int(sym in ALTERNATES), "pool_reasons": p.get("pool_reasons", ""),
            "hist_status": m.get("hist_status", ""), "sessions_2026": m.get("sessions_2026", ""),
            "expected_sessions": m.get("expected_sessions", ""),
            "first_trade_date_2026": m.get("first_trade_date_2026", ""),
            "last_trade_date": last,
            "missing_sessions_after_first": m.get("missing_sessions_after_first", ""),
            "rows_null_or_zero_volume": m.get("rows_null_or_zero_volume", ""),
            "est_close_usd": est, "est_typical_usd": fnum(m.get("est_typical_usd")),
            "typical_vs_close_pct": m.get("typical_vs_close_pct", ""),
            "avg_daily_est_close_usd": fnum(m.get("avg_daily_est_close_usd")),
            "last_close": m.get("last_close", ""), "latest_day_volume": m.get("latest_day_volume", ""),
            "snap_1015_dollar_volume": p.get("snap_dollar_volume", ""),
            "snap_1015_marketcap": p.get("snap_marketcap", ""),
            "gainbot_1016_rank": p.get("gb_rank", ""),
            "max_abs_1d_move_pct": m.get("max_abs_1d_move_pct", ""), "max_move_date": m.get("max_move_date", ""),
            "tiingo_row_summary": tsum, "ticker_reuse_flag": reuse, "tiingo_flags": " ".join(tflags),
            "tiingo_iex_intraday_ws": "pending (needs token)",
            "r1_eligible": int(r1), "r1_exclusion_reason": r1_reason, "r2_eligible": int(r2),
            "r1ny_eligible": int(r1ny), "r2ny_eligible": int(r2ny),
            "corporate_action_notes": " || ".join(notes) if notes else "",
        })

    ranked = sorted([r for r in recs if r["est_close_usd"]], key=lambda r: r["est_close_usd"], reverse=True)
    for i, r in enumerate(ranked, 1):
        r["overall_rank"] = i
    rt = sorted([r for r in recs if r["est_typical_usd"]], key=lambda r: r["est_typical_usd"], reverse=True)
    for i, r in enumerate(rt, 1):
        r["overall_rank_typical"] = i

    def assign(pred, key, metric="est_close_usd"):
        n = 0
        for r in sorted([x for x in recs if x[metric]], key=lambda x: x[metric], reverse=True):
            if pred(r):
                n += 1
                r[key] = n

    assign(lambda r: r["r1_eligible"], "r1_rank_incl_existing")
    assign(lambda r: r["r1_eligible"] and not r["in_existing25"], "r1_new_rank")
    assign(lambda r: r["r2_eligible"] and not r["in_existing25"], "r2_new_rank")
    assign(lambda r: r["r1_eligible"] and not r["in_existing25"], "r1_new_rank_typical", "est_typical_usd")
    assign(lambda r: r["r1ny_eligible"] and not r["in_existing25"], "r1ny_new_rank")
    assign(lambda r: r["r2ny_eligible"] and not r["in_existing25"], "r2ny_new_rank")

    fields = ["overall_rank", "r1_rank_incl_existing", "r1_new_rank", "r2_new_rank", "r1ny_new_rank",
              "r2ny_new_rank",
              "overall_rank_typical", "r1_new_rank_typical", "symbol", "tiingo_ticker", "name",
              "screener_name", "exchange", "security_class", "class_source", "nasdaq_stock_type", "country",
              "ipoyear", "in_existing25", "in_preliminary75", "in_alternates", "r1_eligible",
              "r1_exclusion_reason", "r2_eligible", "r1ny_eligible", "r2ny_eligible", "hist_status",
              "sessions_2026", "expected_sessions",
              "first_trade_date_2026", "last_trade_date", "missing_sessions_after_first",
              "rows_null_or_zero_volume", "est_close_usd", "est_typical_usd", "typical_vs_close_pct",
              "avg_daily_est_close_usd", "last_close", "latest_day_volume", "snap_1015_dollar_volume",
              "snap_1015_marketcap", "gainbot_1016_rank", "max_abs_1d_move_pct", "max_move_date",
              "tiingo_row_summary", "ticker_reuse_flag", "tiingo_flags", "tiingo_iex_intraday_ws",
              "corporate_action_notes", "pool_reasons"]
    order = sorted(recs, key=lambda r: (r.get("overall_rank") or 10 ** 9, r["symbol"]))
    with open(os.path.join(out, "us_ranked_pool.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in order:
            row = dict(r)
            for k in ("est_close_usd", "est_typical_usd", "avg_daily_est_close_usd"):
                if row.get(k) is not None:
                    row[k] = "%.0f" % row[k]
            w.writerow(row)

    new = sorted([r for r in recs if r.get("r1_new_rank") and r["r1_new_rank"] <= N_NEW],
                 key=lambda r: r["r1_new_rank"])
    nf = ["new_rank", "symbol", "tiingo_ticker", "name", "exchange", "security_class", "sessions_2026",
          "first_trade_date_2026", "est_close_usd", "est_typical_usd", "tiingo_row_summary",
          "ticker_reuse_flag", "corporate_action_notes", "overall_rank", "r1_new_rank_typical", "tiingo_flags"]
    with open(os.path.join(out, "us_new75.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=nf, extrasaction="ignore")
        w.writeheader()
        for r in new:
            row = dict(r)
            row["new_rank"] = r["r1_new_rank"]
            row["est_close_usd"] = "%.0f" % r["est_close_usd"]
            row["est_typical_usd"] = "%.0f" % r["est_typical_usd"]
            w.writerow(row)

    # preliminary diff
    newset = {r["symbol"] for r in new}
    by = {r["symbol"]: r for r in recs}
    cutoff = new[-1]["est_close_usd"] if new else None
    df = ["symbol", "in_preliminary75", "in_alternates", "in_final_new75", "change", "r1_new_rank",
          "overall_rank", "est_close_usd", "pct_vs_cutoff", "security_class", "reason"]
    with open(os.path.join(out, "us_preliminary_diff.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=df)
        w.writeheader()
        allsyms = list(dict.fromkeys(PRELIMINARY_75 + ALTERNATES + [r["symbol"] for r in new]))
        for s in allsyms:
            r = by.get(s)
            inp, ina, inf = int(s in PRELIMINARY_75), int(s in ALTERNATES), int(s in newset)
            if inp and inf:
                change = "kept"
            elif inp and not inf:
                change = "dropped"
            elif ina and inf:
                change = "alternate_promoted"
            elif ina:
                change = "alternate_not_selected"
            else:
                change = "added (not in preliminary/alternates)"
            reason = ""
            if r is None:
                reason = "not in pool"
            elif not inf:
                if not r["r1_eligible"]:
                    reason = r["r1_exclusion_reason"]
                else:
                    reason = "rank: R1 new-rank %s (EST_close below the #%d cutoff)" % (r.get("r1_new_rank"), N_NEW)
            elif change.startswith("added"):
                reason = "R1 new-rank %s by EST_close" % r.get("r1_new_rank")
            est = r["est_close_usd"] if r else None
            w.writerow({"symbol": s, "in_preliminary75": inp, "in_alternates": ina, "in_final_new75": inf,
                        "change": change, "r1_new_rank": (r or {}).get("r1_new_rank", ""),
                        "overall_rank": (r or {}).get("overall_rank", ""),
                        "est_close_usd": "%.0f" % est if est else "",
                        "pct_vs_cutoff": "%.2f" % ((est / cutoff - 1) * 100) if est and cutoff else "",
                        "security_class": (r or {}).get("security_class", ""), "reason": reason})

    # summary for README
    r1new = sorted([r for r in recs if r.get("r1_new_rank")], key=lambda r: r["r1_new_rank"])
    r2new = sorted([r for r in recs if r.get("r2_new_rank")], key=lambda r: r["r2_new_rank"])
    r2top = [r["symbol"] for r in r2new[:N_NEW]]
    r1top = [r["symbol"] for r in r1new[:N_NEW]]
    nytop = [r["symbol"] for r in sorted([r for r in recs if r.get("r1ny_new_rank")],
                                         key=lambda r: r["r1ny_new_rank"])[:N_NEW]]
    r2nytop = [r["symbol"] for r in sorted([r for r in recs if r.get("r2ny_new_rank")],
                                           key=lambda r: r["r2ny_new_rank"])[:N_NEW]]
    typ = [r["symbol"] for r in sorted([r for r in recs if r.get("r1_new_rank_typical")],
                                       key=lambda r: r["r1_new_rank_typical"])[:N_NEW]]
    band = [{"symbol": r["symbol"], "r1_new_rank": r["r1_new_rank"], "est_close_usd": round(r["est_close_usd"]),
             "pct_vs_cutoff": round((r["est_close_usd"] / cutoff - 1) * 100, 2)}
            for r in r1new if cutoff and abs(r["est_close_usd"] / cutoff - 1) <= 0.05]
    summary = {
        "cutoff_symbol": new[-1]["symbol"] if new else None, "cutoff_est_close_usd": cutoff,
        "r1_new75": r1top,
        "next_excluded": [{"symbol": r["symbol"], "r1_new_rank": r["r1_new_rank"], "est_close_usd": round(r["est_close_usd"]),
                           "pct_vs_cutoff": round((r["est_close_usd"] / cutoff - 1) * 100, 2)} for r in r1new[N_NEW:N_NEW + 10]],
        "band_pm5pct": band,
        "r2_entering": [s for s in r2top if s not in r1top],
        "r2_pushed_out": [s for s in r1top if s not in r2top],
        "r2_entering_detail": [{"symbol": r["symbol"], "r2_new_rank": r["r2_new_rank"],
                                "est_close_usd": round(r["est_close_usd"]), "class": r["security_class"]}
                               for r in r2new[:N_NEW] if r["symbol"] not in r1top],
        "nyrs_entering": [s for s in nytop if s not in r1top],
        "nyrs_pushed_out": [s for s in r1top if s not in nytop],
        "r2ny_entering": [s for s in r2nytop if s not in r1top],
        "r2ny_pushed_out": [s for s in r1top if s not in r2nytop],
        "typical_entering": [s for s in typ if s not in r1top],
        "typical_leaving": [s for s in r1top if s not in typ],
        "existing25": [{"symbol": by[s]["symbol"], "overall_rank": by[s].get("overall_rank"),
                        "r1_rank_incl_existing": by[s].get("r1_rank_incl_existing"),
                        "est_close_usd": round(by[s]["est_close_usd"]) if by[s]["est_close_usd"] else None,
                        "last_trade_date": by[s]["last_trade_date"], "r1_exclusion_reason": by[s]["r1_exclusion_reason"]}
                       for s in EXISTING_25 if s in by],
        "pool_size": len(recs), "ranked": len(ranked),
    }
    with open(os.path.join(work, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps({k: summary[k] for k in ("cutoff_symbol", "cutoff_est_close_usd", "r2_entering",
                                               "r2_pushed_out", "nyrs_entering", "nyrs_pushed_out",
                                               "r2ny_entering", "r2ny_pushed_out", "typical_entering",
                                               "typical_leaving")}, indent=1))


if __name__ == "__main__":
    main()
