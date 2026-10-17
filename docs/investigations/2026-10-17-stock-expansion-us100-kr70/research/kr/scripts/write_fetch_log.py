#!/usr/bin/env python3
"""Write kr_sources_fetch_log.csv from WORK_DIR/fetch_log.jsonl and the KIS run log.

    python3 -I write_fetch_log.py WORK_DIR OUT_DIR
"""
from __future__ import annotations

import csv
import json
import os
import sys
from collections import Counter


def main(work_dir: str, out_dir: str) -> None:
    rows = [json.loads(ln) for ln in open(os.path.join(work_dir, "fetch_log.jsonl"), encoding="utf-8")]
    # Manual curl probes made before the scripted runs (format checks only);
    # times are the local files' modification times.
    out = [
        {"source": "probe: KRX KIND listed companies (curl)", "url": "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=stockMkt|kosdaqMkt",
         "method_and_params": "GET with browser UA (curl); iconv EUC-KR", "fetched_utc": "2026-10-17T07:54:46Z",
         "http_result": "200 - 381176 / 814175 bytes", "used_for": "format check; files later overwritten by the scripted run",
         "local_files": "raw/kind/ (overwritten)"},
        {"source": "probe: Naver mobile stock list API page 1", "url": "https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=50",
         "method_and_params": "GET (curl)", "fetched_utc": "2026-10-17T07:54:51Z", "http_result": "200 - 101042 bytes",
         "used_for": "field check (accumulatedTradingValueRaw, tradableStatus, stockEndType)", "local_files": "raw/probe/naver_mv_kospi_p1.json"},
        {"source": "probe: Naver chart API 005930", "url": "https://fchart.stock.naver.com/sise.nhn?symbol=005930&timeframe=day&count=250&requestType=0",
         "method_and_params": "GET (curl)", "fetched_utc": "2026-10-17T07:56:23Z", "http_result": "200 - 17620 bytes, 250 items",
         "used_for": "format check", "local_files": "raw/probe/fchart_005930.xml"},
        {"source": "probe: KRX KIND investment caution with currentPageSize", "url": "https://kind.krx.co.kr/investwarn/investattentwarnrisky.do",
         "method_and_params": "POST method=investattentwarnriskySub menuIndex=1 forward=invstcautnisu_down currentPageSize=3000 pageIndex=1 startDate=2026-07-01 endDate=2026-09-30 (curl)",
         "fetched_utc": "2026-10-17T07:58:08Z", "http_result": "200 - 606759 bytes (2078 rows)",
         "used_for": "confirmed that currentPageSize is required (first scripted attempt got 15 rows)", "local_files": "raw/probe2/m1_q3.html"},
        {"source": "probe: KRX English KIND company summary 00593", "url": "https://engkind.krx.co.kr/common/companysummary.do?method=searchCompanySummary&strIsurCd=00593",
         "method_and_params": "GET (curl)", "fetched_utc": "2026-10-17T08:03:10Z", "http_result": "200 - 6996 bytes",
         "used_for": "format check", "local_files": "raw/probe/engkind_00593.html"},
    ]
    for r in rows:
        src = r["source"]
        res = r["http_result"]
        used_for = r["used_for"]
        if src.startswith("KRX KIND") and r["fetched_utc"] < "2026-10-17T07:58:00Z":
            # first scripted KIND run; everything was re-fetched at 07:58
            if "15 table rows" in res:
                res += (" - SUPERSEDED: request lacked currentPageSize and returned only page 1 (15 rows); "
                        "re-fetched at 07:58 with currentPageSize=3000 (first-attempt files kept in raw/kind_first_attempt/)")
            else:
                res += " - SUPERSEDED by the identical 07:58 re-run (files overwritten)"
        if src.startswith("Naver chart API"):
            src = "Naver chart API daily OHLCV (no NXT volume)"
            used_for = ("ESTIMATE only: 2026 YTD sum close x volume (prefilter) and KIS cross-check. Finding: volume = KRX daily "
                        "volume (equals KIS J except the latest day and adjusted-volume rounding); close of NXT-traded stocks = "
                        "integrated KRX+NXT last price (equals KIS UN close), not the KRX close")
        if src.startswith("Naver mobile stock list API"):
            used_for = ("instrument typing / tradable status / 2026-10-16 KRX volume & value. Finding: same-day snapshot; for 21 of "
                        "155 shortlist stocks it lacks late KRX trades that the KIS daily total includes")
        out.append({"source": src, "url": r["url"], "method_and_params": r["method_and_params"],
                    "fetched_utc": r["fetched_utc"], "http_result": res, "used_for": used_for,
                    "local_files": r["local_files"]})
    kis_path = os.path.join(work_dir, "kis_daily.json")
    if os.path.exists(kis_path):
        kis = json.load(open(kis_path, encoding="utf-8"))
        run = kis["run"]
        log = [json.loads(ln) for ln in open(os.path.join(work_dir, "kis_call_log.jsonl"), encoding="utf-8")]
        ok = sum(1 for e in log if e.get("rt_cd") == "0" and e.get("http") == 200)
        codes = Counter((e.get("msg_cd") or "") for e in log if not (e.get("rt_cd") == "0" and e.get("http") == 200))
        j_calls = sum(1 for e in log if e.get("mrkt") == "J" and e.get("adj") == "0")
        out.append({
            "source": "KIS Open API access token (one per run)",
            "url": "<KIS_REST_BASE_URL>/oauth2/tokenP",
            "method_and_params": "POST grant_type=client_credentials (appkey/appsecret read at runtime from backend/.env.local; never printed or stored)",
            "fetched_utc": run["started"], "http_result": run["token"].split(";")[0] + " - 1 token issued, reused for every call",
            "used_for": "authorization for the calls below", "local_files": "none (token kept in memory only)"})
        out.append({
            "source": "KIS Open API 국내주식기간별시세 FHKST03010100 (market J = KRX only)",
            "url": "<KIS_REST_BASE_URL>/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            "method_and_params": "GET FID_COND_MRKT_DIV_CODE=J FID_INPUT_ISCD=<code> FID_INPUT_DATE_1/2=20260101..20260522 and 20260523..20261016 FID_PERIOD_DIV_CODE=D FID_ORG_ADJ_PRC=0; headers tr_id/custtype=P/authorization/appkey/appsecret; paced <=3.3 req/s",
            "fetched_utc": f"{run['started']}..{run['finished']}",
            "http_result": f"{ok} successful responses of {len(log)} attempts ({j_calls} J/adj0 attempts); {run['ok_codes']} of {run['codes']} codes complete; non-success msg codes: {dict(codes) or 'none'}; rate-limit backoffs {run['rate_limited']}",
            "used_for": "ACTUAL daily KRX trading value (acml_tr_pbmn), close, volume -> YTD ranking",
            "local_files": "raw/kis/<code>_J_<d1>_<d2>.json (response bodies; checked for credential strings before writing)"})
        n_chk = sum(1 for e in log if e.get("mrkt") in ("UN", "NX") or e.get("adj") == "1")
        out.append({
            "source": "KIS Open API FHKST03010100 comparison calls (UN = KRX+NXT combined, NX = NXT only, adj=1 raw prices)",
            "url": "<KIS_REST_BASE_URL>/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            "method_and_params": "GET FID_COND_MRKT_DIV_CODE=UN|NX for 005930/000660/009150 20261013..20261016; FID_ORG_ADJ_PRC=1 for up to 2 stocks with adjustment markers",
            "fetched_utc": run["finished"], "http_result": f"{n_chk} attempts",
            "used_for": "verify J excludes NXT; verify acml_tr_pbmn does not depend on the price-adjustment flag",
            "local_files": "raw/kis_checks/*.json"})
    with open(os.path.join(out_dir, "kr_sources_fetch_log.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["source", "url", "method_and_params", "fetched_utc", "http_result",
                                           "used_for", "local_files"])
        w.writeheader()
        w.writerows(out)
    print(len(out), "rows")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
