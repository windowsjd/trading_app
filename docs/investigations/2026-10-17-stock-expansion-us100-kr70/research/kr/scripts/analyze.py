#!/usr/bin/env python3
"""Rank the shortlist by ACTUAL 2026 YTD KRX trading value (KIS, market J) and
write the deliverables.

    python3 -I analyze.py RAW_DIR WORK_DIR REPO_ROOT OUT_DIR

ytd_actual_krw  = sum of KIS FHKST03010100 output2.acml_tr_pbmn (J = KRX only)
                  over 2026-01-02..2026-10-16  -> ACTUAL
ytd_estimate_*  = sum of Naver fchart close x volume over the same window
                  -> ESTIMATE (prefilter / sanity check only)
"""
from __future__ import annotations

import csv
import glob
import html
import json
import math
import os
import re
import statistics
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

W0, W1 = "20260102", "20261016"
EXISTING_15 = """005930 000660 034020 010140 042660 005380 000270 035420 035720 068270
051910 066570 086520 247540 028300""".split()
PRELIM_55 = """009150 402340 036930 006400 353200 105560 240810 012450 042700 096770 000150
373220 011070 055550 403870 028260 012330 007660 222800 329180 278470 267260 086790 010120
009830 047040 316140 032830 067310 000990 028050 272210 058470 196170 108490 000720 034730
005490 079550 001440 003670 003490 017670 062040 009540 128940 010950 066970 010060 000810
033780 064350 015760 352820 071050""".split()
EARLIER = "docs/investigations/2026-10-15-koscom-100-stock-collection-design/expansion-70"
N_NEW = 55

# App-style English names for codes not covered by the 2026-10-15 CSVs. Filled
# from the official KRX English name (engkind) with corporate suffixes removed;
# see README "English names".
NAME_EN_OVERRIDES: dict[str, str] = {
    "032820": "Woori Technology", "000250": "Sam Chun Dang Pharm", "090710": "Hyulim Robot",
    "006340": "Dawon Cable", "277810": "Rainbow Robotics", "047810": "Korea Aerospace Industries",
    "064400": "LG CNS", "322000": "HD Hyundai Energy Solutions", "307950": "Hyundai AutoEver",
    "454910": "Doosan Robotics", "298380": "ABL Bio", "100790": "Mirae Asset Venture Investment",
    "319400": "Hyundai Movex", "034220": "LG Display", "024060": "Heungu Oil",
    "003280": "Heung-A Shipping", "347850": "D&D Pharmatech", "027360": "AJU IB Investment",
    "018880": "Hanon Systems", "439960": "Cosmo Robotics", "038500": "Sampyo Cement",
    "001510": "SK Securities", "058610": "SPG", "141080": "LigaChem Biosciences",
    "047050": "POSCO International", "050890": "Solid", "016360": "Samsung Securities",
    "006910": "Bosung Power Technology", "347700": "Sphere", "450080": "Ecopro Materials",
    "214450": "PharmaResearch", "375500": "DL E&C", "267270": "HD Construction Equipment",
    "003550": "LG Corp.", "489790": "Hanwha Vision", "011790": "SKC", "095340": "ISC",
    "226950": "OliX Pharmaceuticals", "039490": "Kiwoom Securities", "087010": "Peptron",
    "017900": "AUK", "204320": "HL Mando", "001740": "SK Networks",
    "002990": "Kumho Engineering & Construction", "476830": "Rznomics", "417200": "LS Materials",
    "336260": "Doosan Fuel Cell", "187660": "Penetrium Bioscience", "011930": "Shinsung E&G",
    "443060": "HD Hyundai Marine Solution",
    # foreign issuer: engkind summary cannot resolve the code; name from the
    # engkind company list (issuer code USA12)
    "950160": "Kolon TissueGene",
}
NAME_EN_OFFICIAL_EXTRA = {"950160": "Kolon TissueGene (engkind company list, issuer USA12)"}


def load_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def tn(x: int | float | None) -> str:
    return "" if x is None else f"{x / 1e12:.3f}"


def clean_en(official: str) -> str:
    s = official.strip()
    s = re.sub(r"\s*\(.*?\)\s*$", "", s)
    pat = (r"[\s,.]*(CO\s*[.,]+\s*,?\s*LTD|CO\s*,\.\s*LTD|COMPANY\s*,?\s*LIMITED|CO\s*\.?\s*LTD|"
           r"CORPORATION|CORP|INCORPORATED|INC|LIMITED|LTD|CO|COMPANY)\s*\.?\s*$")
    for _ in range(3):
        s2 = re.sub(pat, "", s, flags=re.I).strip(" ,.")
        if s2 == s:
            break
        s = s2
    keep_upper = {"SK", "LG", "HD", "KB", "LS", "CJ", "GS", "HMM", "POSCO", "KT", "DB", "OCI", "LIG",
                  "BNK", "JB", "NH", "IBK", "HL", "HLB", "KG", "SM", "JYP", "YG", "S-OIL", "ISC",
                  "PCB", "ICT", "E&A", "C&T", "TKG", "HPSP", "SFA", "PSK", "TES", "RF", "VM", "DN",
                  "STX", "KCC", "KEPCO", "KRAFTON", "NAVER", "II-VI", "AI", "BH", "HJ", "HK", "SNT"}
    words = []
    for w in s.split():
        words.append(w if w.upper() in keep_upper or (w.isupper() and len(w) <= 3 and w.isalpha() is False)
                     else (w.upper() if w.upper() in keep_upper else w.capitalize() if w.isupper() else w))
    return " ".join(words)


def parse_engkind(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    text = re.sub(r"<[^>]+>", " ", open(path, encoding="utf-8", errors="replace").read())
    text = re.sub(r"\s+", " ", html.unescape(text))
    out = {}
    m = re.search(r"Full Eng Name (.*?) Abbr Kor Name", text)
    if m:
        out["full_en"] = m.group(1).strip()
    m = re.search(r"ISIN (KR[0-9A-Z]{10})", text)
    if m:
        out["isin"] = m.group(1)
    m = re.search(r"Listing Date (\d{4}-\d{2}-\d{2})", text)
    if m:
        out["listing_date_en"] = m.group(1)
    m = re.search(r"Issue Code ([0-9A-Z]{6})", text)
    if m:
        out["issue_code"] = m.group(1)
    return out


def main(raw_dir: str, work_dir: str, repo: str, out_dir: str) -> None:
    uni = json.load(open(os.path.join(work_dir, "universe.json"), encoding="utf-8"))
    est = json.load(open(os.path.join(work_dir, "estimates.json"), encoding="utf-8"))
    sess = json.load(open(os.path.join(work_dir, "expected_sessions.json")))
    sessions: list[str] = sess["sessions"]
    kis = json.load(open(os.path.join(work_dir, "kis_daily.json"), encoding="utf-8"))
    shortlist = [ln.split("\t")[0] for ln in open(os.path.join(work_dir, "shortlist.tsv"), encoding="utf-8")
                 if ln.strip()]

    # ---- names / ISIN from the 2026-10-15 study and the app's fixed universe ----
    earlier: dict[str, dict] = {}
    for fn, kind in (("candidates_55.csv", "candidate"), ("alternates_10.csv", "alternate"),
                     ("excluded_notable.csv", "excluded")):
        for r in load_csv(os.path.join(repo, EARLIER, fn)):
            r["_kind"] = kind
            earlier[r["code"]] = r
    app_names = dict(re.findall(r"symbol: '(\d{6})', kisSymbol: '\d{6}', name: '([^']+)'",
                                open(os.path.join(repo, "backend/src/providers/kis/kis-fixed-asset-universe.ts"),
                                     encoding="utf-8").read()))

    # ---- per-stock facts ----
    recs: dict[str, dict] = {}
    for code in shortlist:
        u = uni.get(code)
        if u is None:
            recs[code] = {"code": code, "missing_from_kind": True}
            continue
        k = kis["data"].get(code, {})
        rows = {}
        for r in k.get("rows", []):
            d = r.get("stck_bsop_date", "")
            if W0 <= d <= W1:
                rows[d] = r
        listed = u["listing_date"].replace("-", "")
        first_kis = min(rows) if rows else None
        # expected sessions: from listing date (2026 listings) or window start;
        # if KIS has rows before the KIND listing date (market transfer /
        # re-listing under the same code) start from the first KIS row instead.
        start = max(W0, listed)
        if first_kis and first_kis < start:
            start = first_kis
        expected = [d for d in sessions if d >= start]
        missing = [d for d in expected if d not in rows]
        extra = sorted(d for d in rows if d not in set(sessions))
        zero_vol = sorted(d for d, r in rows.items() if int(r.get("acml_vol") or 0) == 0)
        ytd_actual = sum(int(r.get("acml_tr_pbmn") or 0) for r in rows.values()) if rows else None
        e = est.get(code, {})
        n = u.get("naver") or {}
        r1016 = rows.get("20261016")
        kis1016 = int(r1016["acml_tr_pbmn"]) if r1016 else None
        nav1016 = n.get("value") if (n.get("localTradedAt") or "").startswith("2026-10-16") else None
        adj_marks = sorted(d for d, r in rows.items() if r.get("mod_yn") == "Y"
                           or (r.get("prtt_rate") or "0").strip() not in ("", "0", "0.00", "0.0"))
        recs[code] = {
            "code": code, "name_ko": u["name_ko"], "market": u["market"],
            "listing_date": u["listing_date"], "kind_industry": u["kind_industry"],
            "flags": list(u["flags"]), "status": u["status"], "naver": n,
            "kis_rows": rows, "sessions_2026": len(rows), "expected_sessions": len(expected),
            "missing_sessions": missing, "extra_sessions": extra, "zero_volume_sessions": zero_vol,
            "first_kis_date": first_kis, "ytd_actual": ytd_actual,
            "ytd_est": e.get("est_ytd_close_x_vol"), "est_rank_all": e.get("est_rank_all"),
            "est_rows": e.get("rows_2026"), "kis1016": kis1016, "naver1016": nav1016,
            "kis_range_errors": k.get("range_errors", []), "adj_marks": adj_marks,
            "kis_name": (k.get("output1") or {}).get("hts_kor_isnm"),
            "kis_code_echo": (k.get("output1") or {}).get("stck_shrn_iscd"),
            "is_existing": code in EXISTING_15, "is_preliminary": code in PRELIM_55,
        }
        last20 = [int(rows[d]["acml_tr_pbmn"]) for d in sorted(rows)[-20:]] if rows else []
        recs[code]["median20_actual"] = int(statistics.median(last20)) if last20 else None
        recs[code]["last20_window"] = f"{sorted(rows)[-20]}..{sorted(rows)[-1]}" if len(rows) >= 20 else ""
        h1 = sum(int(r["acml_tr_pbmn"]) for d, r in rows.items() if d <= "20260630")
        recs[code]["h1_share"] = (h1 / ytd_actual) if ytd_actual else None
        pre = [x for x in u["status"]["caution_2026_last"] if "지정예고" in x and x[:10] >= "2026-10-02"]
        recs[code]["recent_prenotice"] = pre

    # ---- English names ----
    eng_needed = []
    for code, r in recs.items():
        if r.get("missing_from_kind"):
            continue
        ek = parse_engkind(os.path.join(raw_dir, "engkind_summary", f"{code}.html"))
        r["engkind"] = ek
        if code in app_names:
            r["name_en"], r["name_en_source"] = app_names[code], "app fixed universe"
        elif code in earlier and earlier[code].get("name_en"):
            r["name_en"], r["name_en_source"] = earlier[code]["name_en"], "2026-10-15 CSV"
        elif code in NAME_EN_OVERRIDES:
            r["name_en"], r["name_en_source"] = NAME_EN_OVERRIDES[code], "engkind official name, cleaned (manual)"
        elif ek.get("full_en"):
            r["name_en"], r["name_en_source"] = clean_en(ek["full_en"]), "engkind official name, cleaned (auto)"
        else:
            r["name_en"], r["name_en_source"] = "", "missing"
            eng_needed.append(code)
        r["name_en_official"] = (earlier.get(code, {}).get("name_en_krx_official") or ek.get("full_en")
                                 or NAME_EN_OFFICIAL_EXTRA.get(code, ""))
        r["isin"] = earlier.get(code, {}).get("isin") or ek.get("isin") or ""

    # ---- eligibility decision ----
    def decide(r: dict) -> tuple[bool, str]:
        f = r["flags"]
        if r.get("ytd_actual") is None:
            return False, "no KIS data"
        if "halted_now" in f or any(x.startswith("naver_not_tradable") for x in f):
            return False, "excluded: trading halted / not tradable now"
        if "SPAC" in f:
            return False, "excluded: SPAC (blank-check shell, not an operating common stock)"
        if "REIT" in f or "fund_like" in f:
            return False, "excluded: REIT / listed fund (investment vehicle, not an operating common stock)"
        return True, "eligible"

    for r in recs.values():
        if not r.get("missing_from_kind"):
            r["eligible"], r["eligibility"] = decide(r)
    elig = sorted((r for r in recs.values() if r.get("eligible")), key=lambda r: -r["ytd_actual"])
    for i, r in enumerate(elig, 1):
        r["rank"] = i
    new_rank = 0
    for r in elig:
        if not r["is_existing"]:
            new_rank += 1
            r["new_rank"] = new_rank
    for i, r in enumerate(sorted((r for r in elig if not r["is_existing"]),
                                 key=lambda r: -(r["median20_actual"] or 0)), 1):
        r["median20_rank_new"] = i
    final_new = [r for r in elig if r.get("new_rank", 10**9) <= N_NEW]
    cutoff = final_new[-1]["ytd_actual"]
    next5 = [r for r in elig if N_NEW < r.get("new_rank", 0) <= N_NEW + 5]

    # ---- cross-checks ----
    def rel(a, b):
        return (a - b) / b if b else None
    nav_diffs = [(c, r["kis1016"] - r["naver1016"]) for c, r in recs.items()
                 if r.get("kis1016") is not None and r.get("naver1016") is not None]
    within_round = sum(1 for _, d in nav_diffs if abs(d) < 1_000_000)
    rel_diffs = [abs(rel(recs[c]["kis1016"], recs[c]["naver1016"]) or 0) for c, _ in nav_diffs]
    # KIS vs Naver fchart close/volume, all shortlist stocks, all window days
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from estimate_shortlist import parse_fchart  # noqa: E402
    pairs = close_mis = vol_mis = 0
    mis_examples: list[str] = []
    stocks_with_mis = Counter()
    close_mis_by = Counter()
    vol_mis_by = Counter()
    for code, r in recs.items():
        if not r.get("kis_rows"):
            continue
        p = os.path.join(raw_dir, "naver_fchart", f"{code}.xml")
        if not os.path.exists(p):
            continue
        fc = {x[0]: x for x in parse_fchart(p) if W0 <= x[0] <= W1}
        for d, kr in r["kis_rows"].items():
            if d not in fc:
                continue
            pairs += 1
            c_ok = int(kr["stck_clpr"]) == fc[d][4]
            v_ok = int(kr["acml_vol"]) == fc[d][5]
            if not c_ok:
                close_mis += 1
                close_mis_by[code] += 1
            if not v_ok:
                vol_mis += 1
                vol_mis_by[code] += 1
            if not (c_ok and v_ok):
                stocks_with_mis[code] += 1
                if len(mis_examples) < 12:
                    mis_examples.append(f"{code} {d} KIS close {kr['stck_clpr']} vol {kr['acml_vol']} / "
                                        f"Naver close {fc[d][4]} vol {fc[d][5]}")
        r["fchart_close_mismatch_days"] = close_mis_by.get(code, 0)
        r["fchart_volume_mismatch_days"] = vol_mis_by.get(code, 0)
    est_ratio = [r["ytd_est"] / r["ytd_actual"] for r in recs.values()
                 if r.get("ytd_actual") and r.get("ytd_est")]
    # J vs UN / NX comparison
    jun = []
    for chk in kis.get("checks", []):
        c = chk["check"]
        if c.get("mrkt") in ("UN", "NX") and chk.get("rows"):
            for row in chk["rows"]:
                d = row["stck_bsop_date"]
                j = recs.get(c["code"], {}).get("kis_rows", {}).get(d)
                jun.append({"code": c["code"], "date": d, "mrkt": c["mrkt"],
                            "value": int(row["acml_tr_pbmn"]), "volume": int(row["acml_vol"]),
                            "J_value": int(j["acml_tr_pbmn"]) if j else None,
                            "J_volume": int(j["acml_vol"]) if j else None})
    adj_checks = []
    for chk in kis.get("checks", []):
        c = chk["check"]
        if c.get("adj") == "1" and chk.get("rows"):
            same = diff = 0
            for row in chk["rows"]:
                j = recs.get(c["code"], {}).get("kis_rows", {}).get(row["stck_bsop_date"])
                if j is None:
                    continue
                if int(j["acml_tr_pbmn"]) == int(row["acml_tr_pbmn"]):
                    same += 1
                else:
                    diff += 1
            adj_checks.append({"code": c["code"], "why": c.get("why"), "days_same_value": same,
                               "days_diff_value": diff})

    # ---- shortlist completeness argument ----
    outside = sorted(((c, e) for c, e in est.items() if c not in recs),
                     key=lambda x: -x[1]["est_ytd_close_x_vol"])
    max_outside = outside[0] if outside else None
    max_ratio_actual_over_est = max((1 / x for x in est_ratio if x > 0), default=None)

    # ---- outputs ----
    os.makedirs(out_dir, exist_ok=True)

    def status_text(r: dict) -> str:
        s = r["status"]
        parts = [f"halt: {s['halt'] or 'none'}", f"관리종목: {s['admin'] or 'none'}",
                 "투자경고/위험 current: " + (", ".join(s["warning_or_risk_current"]) or "none"),
                 "투자경고/위험 2026: " + (", ".join(s["warning_or_risk_2026"]) or "none"),
                 f"투자주의 2026: {s['caution_2026_count']}x"
                 + (f" (last {'; '.join(s['caution_2026_last'])})" if s["caution_2026_count"] else ""),
                 "실질심사 record: " + (" | ".join(s["delisting_review"]) or "none")]
        if r["market"] == "KOSDAQ":
            parts.append(f"투자주의환기: {s['kosdaq_hwangi'] or 'none'}")
        n = r["naver"] or {}
        parts.append(f"Naver tradable={n.get('tradableStatus')} tradeStop={n.get('tradeStopType')}")
        return " | ".join(parts)

    def notes(r: dict) -> str:
        out = []
        if "listed_2026" in r["flags"]:
            out.append(f"listed {r['listing_date']} (YTD since listing; KIS rows from {r['first_kis_date']})")
        if r["first_kis_date"] and r["first_kis_date"] < r["listing_date"].replace("-", ""):
            out.append(f"KIND listing date {r['listing_date']} but KRX rows since {r['first_kis_date']} "
                       "(same code before the KIND date: market transfer / re-listing)")
        if r["missing_sessions"]:
            out.append(f"{len(r['missing_sessions'])} expected session(s) without KIS rows: "
                       + ",".join(r["missing_sessions"][:8]))
        if r["zero_volume_sessions"]:
            out.append(f"{len(r['zero_volume_sessions'])} zero-volume session(s): "
                       + ",".join(r["zero_volume_sessions"][:8]))
        if r["extra_sessions"]:
            out.append("KIS rows on non-calendar dates: " + ",".join(r["extra_sessions"]))
        if r.get("recent_prenotice"):
            out.append("투자경고 지정예고 within the last 10 sessions: " + "; ".join(r["recent_prenotice"])
                       + " (pre-notice only; not designated as of 2026-10-17)")
        if r["adj_marks"]:
            out.append("KIS adjustment marker on " + ",".join(r["adj_marks"][:4]))
        if r["kis_code_echo"] and r["kis_code_echo"] != r["code"]:
            out.append(f"KIS echoed code {r['kis_code_echo']}")
        for f in r["flags"]:
            if f in ("foreign_issuer", "REIT", "SPAC", "fund_like", "admin_issue_now",
                     "warning_or_risk_now", "kosdaq_hwangi_now", "delisting_review_record"):
                out.append(f"flag {f}")
        return "; ".join(out)

    sl_fields = ["rank", "new_rank", "code", "name_ko", "name_en", "market", "listing_date",
                 "sessions_2026", "expected_sessions", "ytd_actual_krw", "ytd_actual_krw_tn",
                 "ytd_estimate_close_x_vol_krw", "estimate_over_actual", "est_rank_all_companies",
                 "kis_20261016_value_krw", "naver_snapshot_20261016_value_krw", "kis_vs_naver_1016_diff",
                 "fchart_close_mismatch_days", "fchart_volume_mismatch_days", "status_flags", "eligibility", "is_existing", "is_preliminary",
                 "selected_new55", "notes", "status_checks", "name_en_official", "isin", "kind_industry",
                 "median20_actual_krw", "median20_rank_among_new", "h1_share_of_ytd"]
    ordered = sorted((r for r in recs.values() if not r.get("missing_from_kind")),
                     key=lambda r: -(r.get("ytd_actual") or -1))
    with open(os.path.join(out_dir, "kr_ranked_shortlist.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=sl_fields)
        w.writeheader()
        for r in ordered:
            w.writerow({
                "rank": r.get("rank", ""), "new_rank": r.get("new_rank", ""), "code": r["code"],
                "name_ko": r["name_ko"], "name_en": r["name_en"], "market": r["market"],
                "listing_date": r["listing_date"], "sessions_2026": r["sessions_2026"],
                "expected_sessions": r["expected_sessions"], "ytd_actual_krw": r["ytd_actual"] or "",
                "ytd_actual_krw_tn": tn(r["ytd_actual"]), "ytd_estimate_close_x_vol_krw": r["ytd_est"] or "",
                "estimate_over_actual": f"{r['ytd_est'] / r['ytd_actual']:.4f}" if r.get("ytd_actual") and r.get("ytd_est") else "",
                "est_rank_all_companies": r["est_rank_all"] or "",
                "kis_20261016_value_krw": r["kis1016"] if r["kis1016"] is not None else "",
                "naver_snapshot_20261016_value_krw": r["naver1016"] if r["naver1016"] is not None else "",
                "kis_vs_naver_1016_diff": (r["kis1016"] - r["naver1016"]) if r["kis1016"] is not None and r["naver1016"] is not None else "",
                "fchart_close_mismatch_days": r.get("fchart_close_mismatch_days", ""),
                "fchart_volume_mismatch_days": r.get("fchart_volume_mismatch_days", ""),
                "status_flags": ";".join(r["flags"]) or "none", "eligibility": r["eligibility"],
                "is_existing": int(r["is_existing"]), "is_preliminary": int(r["is_preliminary"]),
                "selected_new55": int(r in final_new), "notes": notes(r), "status_checks": status_text(r),
                "name_en_official": r["name_en_official"], "isin": r["isin"],
                "kind_industry": r["kind_industry"],
                "median20_actual_krw": r.get("median20_actual") or "",
                "median20_rank_among_new": r.get("median20_rank_new", ""),
                "h1_share_of_ytd": f"{r['h1_share']:.3f}" if r.get("h1_share") is not None else "",
            })
    with open(os.path.join(out_dir, "kr_new55.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["new_rank", "code", "name_ko", "name_en", "market", "ytd_actual_krw",
                                           "sessions", "listing_date", "status_checks", "notes",
                                           "overall_rank", "ytd_actual_krw_tn", "expected_sessions",
                                           "is_preliminary", "name_en_source", "name_en_official", "isin",
                                           "kind_industry"])
        w.writeheader()
        for r in final_new:
            w.writerow({"new_rank": r["new_rank"], "code": r["code"], "name_ko": r["name_ko"],
                        "name_en": r["name_en"], "market": r["market"], "ytd_actual_krw": r["ytd_actual"],
                        "sessions": r["sessions_2026"], "listing_date": r["listing_date"],
                        "status_checks": status_text(r), "notes": notes(r), "overall_rank": r["rank"],
                        "ytd_actual_krw_tn": tn(r["ytd_actual"]), "expected_sessions": r["expected_sessions"],
                        "is_preliminary": int(r["is_preliminary"]), "name_en_source": r["name_en_source"],
                        "name_en_official": r["name_en_official"], "isin": r["isin"],
                        "kind_industry": r["kind_industry"]})
    # preliminary diff
    final_codes = {r["code"] for r in final_new}
    with open(os.path.join(out_dir, "kr_preliminary_diff.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["change", "code", "name_ko", "name_en", "market", "in_preliminary",
                                           "in_final_new55", "preliminary_liquidity_rank_median20",
                                           "ytd_new_rank", "ytd_overall_rank", "ytd_actual_krw",
                                           "ytd_actual_krw_tn", "gap_vs_cutoff_krw", "reason"])
        w.writeheader()
        for code in list(dict.fromkeys(PRELIM_55 + [r["code"] for r in final_new])):
            r = recs[code]
            inp, inf = code in PRELIM_55, code in final_codes
            change = "kept" if inp and inf else ("dropped" if inp else "added")
            prev = earlier.get(code, {})
            if change == "kept":
                reason = f"YTD new rank #{r['new_rank']} (within top {N_NEW})"
            elif change == "dropped":
                if not r.get("eligible"):
                    reason = r["eligibility"]
                else:
                    reason = (f"YTD new rank #{r['new_rank']} is below the cutoff (#{N_NEW}); "
                              f"YTD {tn(r['ytd_actual'])} tn vs cutoff {tn(cutoff)} tn"
                              + ("; it was a diversity pick in the 10-15 list" if code in
                                 ("033780", "064350", "015760", "352820", "071050") else ""))
            else:
                why_prev = prev.get("exclusion_reason") or prev.get("rationale") or ""
                why_prev = why_prev.split(". Facts:")[0][:160]
                reason = (f"YTD new rank #{r['new_rank']}"
                          + (f"; 10-15 study: {prev['_kind']} - {why_prev}" if prev else
                             "; not listed in the 10-15 study's candidate/alternate/excluded CSVs (that study ranked by a 20-session median and applied recognition/share-volume/warning/diversity gates)"))
            ctx = (f" [context: last-20-session median {r['median20_actual'] / 1e9:,.1f} bn KRW = "
                   f"#{r.get('median20_rank_new', '?')} among new names; Jan-Jun share of YTD "
                   f"{100 * r['h1_share']:.0f}%]") if r.get("median20_actual") else ""
            reason += ctx
            w.writerow({"change": change, "code": code, "name_ko": r["name_ko"], "name_en": r["name_en"],
                        "market": r["market"], "in_preliminary": int(inp), "in_final_new55": int(inf),
                        "preliminary_liquidity_rank_median20": prev.get("liquidity_rank_by_median20", ""),
                        "ytd_new_rank": r.get("new_rank", ""), "ytd_overall_rank": r.get("rank", ""),
                        "ytd_actual_krw": r.get("ytd_actual") or "", "ytd_actual_krw_tn": tn(r.get("ytd_actual")),
                        "gap_vs_cutoff_krw": (r["ytd_actual"] - cutoff) if r.get("ytd_actual") else "",
                        "reason": reason})

    # ---- 2026-10-16: trades in the KIS daily total but not in the Naver snapshot ----
    gaps = []
    for c, r in recs.items():
        if r.get("kis1016") is None or r.get("naver1016") is None:
            continue
        dv = r["kis1016"] - r["naver1016"]
        if abs(dv) < 1_000_000:
            continue
        k16 = r["kis_rows"]["20261016"]
        k15 = r["kis_rows"].get("20261015")
        dq = int(k16["acml_vol"]) - int((r["naver"] or {}).get("volume") or 0)
        gaps.append({"code": c, "name_ko": r["name_ko"], "value_gap_krw": dv,
                     "value_gap_pct": round(100 * dv / r["naver1016"], 3), "volume_gap": dq,
                     "implied_price": round(dv / dq) if dq else None,
                     "kis_close_1016": int(k16["stck_clpr"]),
                     "kis_close_1015": int(k15["stck_clpr"]) if k15 else None})
    # ---- sensitivity: which new names would the ESTIMATE ordering pick? ----
    est_order = [r for r in sorted((r for r in recs.values() if r.get("eligible") and r.get("ytd_est")),
                                   key=lambda r: -r["ytd_est"]) if not r["is_existing"]][:N_NEW]
    est_set = {r["code"] for r in est_order}
    act_set = {r["code"] for r in final_new}
    sensitivity = {"in_actual_not_estimate": sorted(act_set - est_set), "in_estimate_not_actual": sorted(est_set - act_set)}
    name_echo_diff = sum(1 for r in recs.values() if r.get("kis_name") and r["kis_name"] != r.get("name_ko"))
    code_echo_bad = [c for c, r in recs.items() if r.get("kis_code_echo") and r["kis_code_echo"] != c]

    # ---- summary for README / final report ----
    kospi = sum(1 for c in EXISTING_15 if recs[c]["market"] == "KOSPI") + sum(1 for r in final_new if r["market"] == "KOSPI")
    kosdaq = 70 - kospi
    summary = {
        "expected_sessions": len(sessions), "shortlist_size": len(recs),
        "kis_run": kis["run"], "eligible_ranked": len(elig),
        "final_new": [(r["new_rank"], r["code"], r["name_ko"], r["name_en"], r["market"], tn(r["ytd_actual"]),
                       r["sessions_2026"], r["rank"]) for r in final_new],
        "cutoff_krw": cutoff,
        "next5": [(r["new_rank"], r["code"], r["name_ko"], r["market"], tn(r["ytd_actual"]),
                   r["ytd_actual"] - cutoff) for r in next5],
        "existing_ranks": [(c, recs[c]["name_ko"], recs[c].get("rank"), tn(recs[c]["ytd_actual"]))
                           for c in EXISTING_15],
        "kospi_70": kospi, "kosdaq_70": kosdaq,
        "batches": math.ceil(kospi / 20) + math.ceil(kosdaq / 20),
        "naver1016_compared": len(nav_diffs), "naver1016_within_rounding": within_round,
        "naver1016_max_abs_rel": max(rel_diffs) if rel_diffs else None,
        "naver1016_nonmatching": [(c, d) for c, d in nav_diffs if abs(d) >= 1_000_000][:20],
        "fchart_pairs": pairs, "fchart_close_mismatch": close_mis, "fchart_volume_mismatch": vol_mis,
        "fchart_stocks_with_mismatch": len(stocks_with_mis), "fchart_mismatch_examples": mis_examples,
        "fchart_mismatch_by_stock": stocks_with_mis.most_common(15),
        "est_over_actual": {"n": len(est_ratio), "median": statistics.median(est_ratio) if est_ratio else None,
                            "min": min(est_ratio) if est_ratio else None, "max": max(est_ratio) if est_ratio else None},
        "j_vs_un": jun, "adj_checks": adj_checks, "gaps_1016": gaps, "sensitivity": sensitivity,
        "kis_name_differs_from_kind": name_echo_diff, "kis_code_echo_mismatch": code_echo_bad,
        "recent_prenotice_final": [(r["code"], r["name_ko"], r["recent_prenotice"]) for r in final_new if r.get("recent_prenotice")],
        "listed_2026_in_shortlist": [(r["code"], r["name_ko"], r.get("rank"), tn(r.get("ytd_actual")), r["first_kis_date"])
                                     for r in recs.values() if "listed_2026" in r.get("flags", [])],
        "foreign_in_shortlist": [(r["code"], r["name_ko"], r.get("rank"), tn(r.get("ytd_actual")))
                                 for r in recs.values() if "foreign_issuer" in r.get("flags", [])],
        "completeness": {"max_outside_code": max_outside[0] if max_outside else None,
                         "max_outside_est": max_outside[1]["est_ytd_close_x_vol"] if max_outside else None,
                         "max_actual_over_est_in_shortlist": max_ratio_actual_over_est,
                         "cutoff": cutoff},
        "eng_needed": eng_needed,
        "auto_names": [(c, r["name_en"], r.get("name_en_official")) for c, r in recs.items()
                       if r.get("name_en_source", "").endswith("(auto)")],
        "flagged_in_top": [(r["new_rank"] if not r["is_existing"] else "existing", r["code"], r["name_ko"], r["flags"])
                           for r in elig[: N_NEW + 25] if r["flags"]],
        "ineligible": [(r["code"], r["name_ko"], r["eligibility"], tn(r.get("ytd_actual")))
                       for r in recs.values() if not r.get("missing_from_kind") and not r.get("eligible")],
        "range_errors": {c: r["kis_range_errors"] for c, r in recs.items() if r.get("kis_range_errors")},
        "session_anomalies": [(r["code"], r["name_ko"], r["sessions_2026"], r["expected_sessions"],
                               r["missing_sessions"][:10], r["zero_volume_sessions"][:10], r["extra_sessions"])
                              for r in recs.values() if not r.get("missing_from_kind") and
                              (r["missing_sessions"] or r["zero_volume_sessions"] or r["extra_sessions"]
                               or r["sessions_2026"] != r["expected_sessions"])],
    }
    with open(os.path.join(work_dir, "analysis_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)
    print(json.dumps({k: summary[k] for k in ("cutoff_krw", "kospi_70", "kosdaq_70", "batches",
                                              "naver1016_compared", "naver1016_within_rounding",
                                              "fchart_pairs", "fchart_close_mismatch", "fchart_volume_mismatch",
                                              "est_over_actual", "completeness")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:5])
