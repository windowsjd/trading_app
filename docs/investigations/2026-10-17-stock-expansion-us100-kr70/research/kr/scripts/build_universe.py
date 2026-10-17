#!/usr/bin/env python3
"""Build the KOSPI/KOSDAQ company universe with status flags (KR-70 study).

    python3 -I build_universe.py RAW_DIR WORK_DIR

Inputs (RAW_DIR): kind/*.utf8.html, naver_marketvalue/*.json
Outputs (WORK_DIR): universe.json, fchart_codes.txt, universe_summary.txt
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from html_tables import read_dicts, read_rows  # noqa: E402

AS_OF = "2026-10-17"


def norm_name(s: str) -> str:
    return re.sub(r"[\s().,㈜]|주식회사", "", s or "").upper()


def main(raw_dir: str, work_dir: str) -> None:
    kind_dir = os.path.join(raw_dir, "kind")
    uni: dict[str, dict] = {}
    for mkt_file, market in (("kind_corplist_stockMkt", "KOSPI"),
                             ("kind_corplist_kosdaqMkt", "KOSDAQ")):
        for r in read_dicts(os.path.join(kind_dir, mkt_file + ".utf8.html"), "종목코드"):
            code = r["종목코드"].strip()
            mk = r["시장구분"].strip()
            expect = "유가" if market == "KOSPI" else "코스닥"
            if mk != expect:
                raise SystemExit(f"unexpected market {mk} for {code} in {mkt_file}")
            if code in uni:
                raise SystemExit(f"duplicate code {code}")
            uni[code] = {
                "code": code, "name_ko": r["회사명"].strip(), "market": market,
                "kind_industry": r["업종"].strip(), "kind_products": r["주요제품"].strip(),
                "listing_date": r["상장일"].strip(), "flags": [],
            }

    # ---- Naver snapshot (latest session = 2026-10-16) ----
    naver: dict[str, dict] = {}
    for path in sorted(glob.glob(os.path.join(raw_dir, "naver_marketvalue", "*.json"))):
        mkt = os.path.basename(path).split("_")[0]
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for s in data.get("stocks", []):
            code = s.get("itemCode")
            naver[code] = {
                "naver_market": mkt,
                "naver_name": s.get("stockName"),
                "stockEndType": s.get("stockEndType"),
                "close": int(s.get("closePriceRaw") or 0),
                "volume": int(s.get("accumulatedTradingVolumeRaw") or 0),
                "value": int(s.get("accumulatedTradingValueRaw") or 0),
                "mcap": int(s.get("marketValueRaw") or 0),
                "tradableStatus": s.get("tradableStatus"),
                "tradableStatusCode": s.get("tradableStatusCode"),
                "tradeStopType": (s.get("tradeStopType") or {}).get("name"),
                "localTradedAt": s.get("localTradedAt"),
                "exchange": (s.get("stockExchangeType") or {}).get("name"),
            }
    end_types = Counter(v["stockEndType"] for v in naver.values())

    # ---- KIND status lists ----
    halts = {r["종목코드"].strip(): r["사유"].strip()
             for r in read_dicts(os.path.join(kind_dir, "kind_tradinghalt_down.utf8.html"), "종목코드")}
    admin = {r["종목코드"].strip(): f'{r["지정일"].strip()} {r["지정사유"].strip()}'
             for r in read_dicts(os.path.join(kind_dir, "kind_adminissue_down.utf8.html"), "종목코드")}
    warn_cur: dict[str, list[str]] = {}
    warn_hist: dict[str, list[str]] = {}
    for label, fname in (("투자경고", "kind_invest_m2_warning_2026"),
                         ("투자위험", "kind_invest_m3_risk_2026")):
        for r in read_dicts(os.path.join(kind_dir, fname + ".utf8.html"), "종목코드"):
            code = r["종목코드"].strip()
            span = f'{label} {r["지정일"].strip()}~{r["해제일"].strip()}'
            warn_hist.setdefault(code, []).append(span)
            if r["해제일"].strip() in ("-", ""):
                warn_cur.setdefault(code, []).append(span)
    caution: dict[str, list[str]] = {}
    for path in sorted(glob.glob(os.path.join(kind_dir, "kind_invest_m1_caution_*.utf8.html"))):
        for r in read_dicts(path, "종목코드"):
            caution.setdefault(r["종목코드"].strip(), []).append(
                f'{r["지정일"].strip()} {r["유형"].strip()}')
    delist: dict[str, list[str]] = {}
    for r in read_dicts(os.path.join(kind_dir, "kind_delistRealInvstg_down.utf8.html"), "종목코드"):
        code = r["종목코드"].strip()
        decision = " / ".join(x for x in (r.get("기업심사위원회심의/거래소결정", ""),
                                         r.get("상장공시위원회(코스닥시장위원회)심의/거래소결정", ""),
                                         r.get("기타", "")) if x)
        delist.setdefault(code, []).append(
            f'{r["사유발생일"].strip()} {r["실질심사사유"].strip()} [{decision or "no decision listed"}]')
    hwangi_names = {norm_name(r[0]): f"{r[1]} {r[2]}"
                    for r in read_rows(os.path.join(kind_dir, "kind_hwangiissue_sub.utf8.html"))
                    if len(r) >= 3 and re.match(r"\d{4}-\d{2}-\d{2}", r[1] or "")}

    # ---- assemble ----
    for code, u in uni.items():
        n = naver.get(code)
        u["naver"] = n
        name = u["name_ko"]
        fl = u["flags"]
        if not re.fullmatch(r"[0-9A-Z]{5}0", code):
            fl.append("code_not_common_pattern")
        if re.search(r"스팩|기업인수목적", name):
            fl.append("SPAC")
        # REIT: '리츠' in the name, but not inside 메리츠 (Meritz) / 블리츠
        if re.search(r"(?<!메)(?<!블)리츠", name):
            fl.append("REIT")
        # listed funds / investment companies that are not REIT-named
        # (checked by hand against KIND industry 신탁업 및 집합투자업)
        if name in ("맥쿼리인프라", "KB발해인프라", "맵스리얼티") or (
                u["kind_industry"] == "신탁업 및 집합투자업" and "증권투자회사" in u["kind_products"]):
            fl.append("fund_like")
        if code.startswith("9"):
            fl.append("foreign_issuer")
        if u["listing_date"] >= "2026-01-02":
            fl.append("listed_2026")
        if code in halts:
            fl.append("halted_now")
        if code in admin:
            fl.append("admin_issue_now")
        if code in warn_cur:
            fl.append("warning_or_risk_now")
        if code in delist:
            fl.append("delisting_review_record")
        if u["market"] == "KOSDAQ" and norm_name(name) in hwangi_names:
            fl.append("kosdaq_hwangi_now")
        if n is None:
            fl.append("missing_in_naver_snapshot")
        else:
            if n["tradableStatus"] != "tradable":
                fl.append(f"naver_not_tradable:{n['tradableStatus']}/{n['tradableStatusCode']}")
            if n["stockEndType"] != "stock":
                fl.append(f"naver_type:{n['stockEndType']}")
            if n["tradeStopType"] not in (None, "TRADING"):
                fl.append(f"naver_tradeStop:{n['tradeStopType']}")
            if n["exchange"] not in ("KOSPI", "KOSDAQ"):
                fl.append(f"naver_exchange:{n['exchange']}")
            if n["naver_market"] != u["market"]:
                fl.append(f"naver_market_mismatch:{n['naver_market']}")
        u["status"] = {
            "halt": halts.get(code),
            "admin": admin.get(code),
            "warning_or_risk_current": warn_cur.get(code, []),
            "warning_or_risk_2026": warn_hist.get(code, []),
            "caution_2026_count": len(caution.get(code, [])),
            "caution_2026_last": sorted(caution.get(code, []))[-3:],
            "delisting_review": delist.get(code, []),
            "kosdaq_hwangi": hwangi_names.get(norm_name(name)) if u["market"] == "KOSDAQ" else None,
        }

    with open(os.path.join(work_dir, "universe.json"), "w", encoding="utf-8") as fh:
        json.dump(uni, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(work_dir, "fchart_codes.txt"), "w", encoding="utf-8") as fh:
        for code in sorted(uni):
            fh.write(code + "\n")

    flag_counts = Counter(f.split(":")[0] for u in uni.values() for f in u["flags"])
    non_kind_naver = Counter(v["stockEndType"] for c, v in naver.items() if c not in uni)
    lines = [
        f"KIND companies: {len(uni)} (KOSPI {sum(u['market']=='KOSPI' for u in uni.values())}, "
        f"KOSDAQ {sum(u['market']=='KOSDAQ' for u in uni.values())})",
        f"Naver instruments: {len(naver)}; stockEndType counts: {dict(end_types)}",
        f"Naver instruments not in KIND corp list by type: {dict(non_kind_naver)}",
        f"Flag counts: {dict(flag_counts)}",
        f"halts {len(halts)} admin {len(admin)} warn/risk current {len(warn_cur)} "
        f"caution codes {len(caution)} delist-review codes {len(delist)} hwangi names {len(hwangi_names)}",
        "2026 listings: " + "; ".join(f"{u['code']} {u['name_ko']} {u['market']} {u['listing_date']}"
                                      for u in sorted(uni.values(), key=lambda x: x["listing_date"])
                                      if "listed_2026" in u["flags"]),
    ]
    with open(os.path.join(work_dir, "universe_summary.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
