#!/usr/bin/env python3
"""Public-source fetcher for the KR-70 YTD trading-value study (2026-10-17).

Run with an isolated interpreter and explicit directories, e.g.

    python3 -I fetch_public.py kind       RAW_DIR WORK_DIR
    python3 -I fetch_public.py krx-probe  RAW_DIR WORK_DIR
    python3 -I fetch_public.py naver-snap RAW_DIR WORK_DIR
    python3 -I fetch_public.py fchart     RAW_DIR WORK_DIR CODES_FILE
    python3 -I fetch_public.py engkind    RAW_DIR WORK_DIR CODES_FILE
    python3 -I fetch_public.py engkind-list RAW_DIR WORK_DIR

RAW_DIR receives the untrusted downloads (one sub-directory per source);
WORK_DIR receives fetch_log.jsonl. No credentials are used by this script.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_fetch(work_dir: str, **row: object) -> None:
    row.setdefault("fetched_utc", utc_now())
    with open(os.path.join(work_dir, "fetch_log.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def http(url: str, data: dict | None = None, referer: str | None = None,
         timeout: float = 30.0) -> tuple[int, bytes, str]:
    """Return (status, body, final_url). Non-2xx statuses are returned, not raised."""
    headers = {"User-Agent": UA, "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode("ascii")
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.geturl()
    except urllib.error.HTTPError as err:
        return err.code, err.read() or b"", url


def write_bytes(path: str, payload: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(payload)


def euckr_to_utf8_file(src_bytes: bytes, dst: str) -> None:
    text = src_bytes.decode("cp949", errors="replace")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write(text)


# --------------------------------------------------------------------------
# KIND
# --------------------------------------------------------------------------
KIND_LISTS = [
    # (label, url, form, used_for)
    ("kind_tradinghalt_down", "https://kind.krx.co.kr/investwarn/tradinghaltissue.do",
     {"method": "searchTradingHaltIssueSub", "forward": "tradinghaltissue_down",
      "currentPageSize": "3000", "marketType": "0"},
     "status: current trading halts (매매거래정지)"),
    ("kind_adminissue_down", "https://kind.krx.co.kr/investwarn/adminissue.do",
     {"method": "searchAdminIssueSub", "forward": "adminissue_down",
      "currentPageSize": "3000", "orderMode": "1", "orderStat": "D"},
     "status: current administrative issues (관리종목)"),
] + [
    (f"kind_invest_m1_caution_{a[5:7]}{a[8:10]}_{b[5:7]}{b[8:10]}",
     "https://kind.krx.co.kr/investwarn/investattentwarnrisky.do",
     {"method": "investattentwarnriskySub", "menuIndex": "1", "forward": "invstcautnisu_down",
      "currentPageSize": "3000", "pageIndex": "1", "startDate": a, "endDate": b},
     f"status: investment caution designations {a}..{b} (투자주의; max 3000 rows per download)")
    for a, b in (("2026-01-01", "2026-03-31"), ("2026-04-01", "2026-06-30"),
                 ("2026-07-01", "2026-09-30"), ("2026-10-01", "2026-10-17"))
] + [
    ("kind_invest_m2_warning_2026", "https://kind.krx.co.kr/investwarn/investattentwarnrisky.do",
     {"method": "investattentwarnriskySub", "menuIndex": "2", "forward": "invstwarnisu_down",
      "currentPageSize": "3000", "pageIndex": "1",
      "startDate": "2026-01-01", "endDate": "2026-10-17"},
     "status: investment warning designations 2026 (투자경고)"),
    ("kind_invest_m3_risk_2026", "https://kind.krx.co.kr/investwarn/investattentwarnrisky.do",
     {"method": "investattentwarnriskySub", "menuIndex": "3", "forward": "invstriskisu_down",
      "currentPageSize": "3000", "pageIndex": "1",
      "startDate": "2026-01-01", "endDate": "2026-10-17"},
     "status: investment risk designations 2026 (투자위험)"),
    ("kind_delistRealInvstg_down", "https://kind.krx.co.kr/corpgeneral/delistRealInvstg.do",
     {"method": "searchDelistRealInvstg", "forward": "delistRealInvstg_down",
      "currentPageSize": "3000", "pageIndex": "1",
      "fromDate": "2025-01-01", "toDate": "2026-10-17"},
     "status: delisting substantive reviews 2025-01-01..2026-10-17 (상장적격성 실질심사)"),
] + [
    ("kind_hwangiissue_sub", "https://kind.krx.co.kr/investwarn/hwangiissue.do",
     {"method": "searchHwangiIssueSub", "forward": "hwangiissue_sub",
      "currentPageSize": "3000"},
     "status: KOSDAQ investment-attention issuers (투자주의환기종목, HTML fragment)"),
]


def cmd_kind(raw_dir: str, work_dir: str) -> None:
    out = os.path.join(raw_dir, "kind")
    for mkt in ("stockMkt", "kosdaqMkt"):
        url = ("https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType="
               + mkt)
        status, body, _ = http(url)
        raw_path = os.path.join(out, f"kind_corplist_{mkt}.euckr.html")
        write_bytes(raw_path, body)
        euckr_to_utf8_file(body, os.path.join(out, f"kind_corplist_{mkt}.utf8.html"))
        n_rows = body.count(b"<tr>") - 1
        log_fetch(work_dir, source=f"KRX KIND listed companies ({mkt})", url=url,
                  method_and_params="GET (EUC-KR; decoded as cp949 to UTF-8)",
                  http_result=f"{status} - ~{n_rows} rows", used_for=
                  "market membership / listing date / KIND industry / company universe",
                  local_files=f"raw/kind/kind_corplist_{mkt}.*")
        time.sleep(1.0)
    for label, url, form, used_for in KIND_LISTS:
        status, body, final = http(url, data=form,
                                   referer="https://kind.krx.co.kr/")
        write_bytes(os.path.join(out, f"{label}.euckr.html"), body)
        euckr_to_utf8_file(body, os.path.join(out, f"{label}.utf8.html"))
        n_rows = body.count(b"<tr") - 1
        res = f"{status} - {len(body)} bytes, ~{n_rows} table rows"
        if final != url:
            res += f" (redirected to {final})"
        log_fetch(work_dir, source=f"KRX KIND {label}", url=url,
                  method_and_params="POST " + " ".join(f"{k}={v}" for k, v in form.items()),
                  http_result=res, used_for=used_for, local_files=f"raw/kind/{label}.*")
        time.sleep(1.0)


# --------------------------------------------------------------------------
# KRX data portal probe (login gate check)
# --------------------------------------------------------------------------

def cmd_krx_probe(raw_dir: str, work_dir: str) -> None:
    url = "http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
    form = {"bld": "dbms/MDC/STAT/standard/MDCSTAT01501", "locale": "ko_KR",
            "mktId": "STK", "trdDd": "20261016", "share": "1", "money": "1",
            "csvxls_isNo": "false"}
    referer = ("http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?"
               "menuId=MDC0201020101")
    status, body, final = http(url, data=form, referer=referer)
    write_bytes(os.path.join(raw_dir, "krx_portal", "krx_mdcstat01501_STK_20261016.body"), body)
    snippet = body[:80].decode("utf-8", errors="replace").replace("\n", " ")
    log_fetch(work_dir, source="KRX data portal all-stock quotes (probe once)", url=url,
              method_and_params="POST " + " ".join(f"{k}={v}" for k, v in form.items())
              + " (Referer mdiLoader)",
              http_result=f"{status} - body starts '{snippet}'",
              used_for="login-gate check only",
              local_files="raw/krx_portal/krx_mdcstat01501_STK_20261016.body")
    print(status, snippet)


# --------------------------------------------------------------------------
# Naver mobile marketValue snapshot
# --------------------------------------------------------------------------

def cmd_naver_snap(raw_dir: str, work_dir: str) -> None:
    out = os.path.join(raw_dir, "naver_marketvalue")
    for mkt in ("KOSPI", "KOSDAQ"):
        page, total, got = 1, None, 0
        first_ts = utc_now()
        while True:
            url = (f"https://m.stock.naver.com/api/stocks/marketValue/{mkt}"
                   f"?page={page}&pageSize=50")
            status, body, _ = http(url)
            if status != 200:
                raise SystemExit(f"naver snapshot {mkt} page {page}: HTTP {status}")
            write_bytes(os.path.join(out, f"{mkt}_p{page:03d}.json"), body)
            data = json.loads(body)
            total = data.get("totalCount", 0)
            got += len(data.get("stocks", []))
            if got >= total or not data.get("stocks"):
                break
            page += 1
            time.sleep(0.3)
        log_fetch(work_dir, source=f"Naver mobile stock list API ({mkt})",
                  url=f"https://m.stock.naver.com/api/stocks/marketValue/{mkt}?page=N&pageSize=50",
                  method_and_params=f"GET {page} pages (started {first_ts})",
                  http_result=f"200 OK - {got} instruments (totalCount {total})",
                  used_for="instrument typing / tradable status / 2026-10-16 KRX volume & value",
                  local_files=f"raw/naver_marketvalue/{mkt}_p*.json")
        print(mkt, page, got, total)


# --------------------------------------------------------------------------
# Naver fchart daily OHLCV
# --------------------------------------------------------------------------

def read_codes(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]


def cmd_fchart(raw_dir: str, work_dir: str, codes_file: str) -> None:
    out = os.path.join(raw_dir, "naver_fchart")
    os.makedirs(out, exist_ok=True)
    codes = read_codes(codes_file)
    started = utc_now()
    ok = fail = skipped = 0
    failures: list[str] = []
    for i, code in enumerate(codes):
        dst = os.path.join(out, f"{code}.xml")
        if os.path.exists(dst) and os.path.getsize(dst) > 200:
            skipped += 1
            continue
        url = ("https://fchart.stock.naver.com/sise.nhn?symbol="
               f"{urllib.parse.quote(code)}&timeframe=day&count=250&requestType=0")
        for attempt in range(3):
            try:
                status, body, _ = http(url, timeout=20)
            except Exception as exc:  # network hiccup
                status, body = -1, str(exc).encode()
            if status == 200 and b"<chartdata" in body:
                write_bytes(dst, body)
                ok += 1
                break
            time.sleep(2.0 * (attempt + 1))
        else:
            fail += 1
            failures.append(f"{code}:{status}")
        time.sleep(0.2)
        if (i + 1) % 200 == 0:
            print(f"{i + 1}/{len(codes)} ok={ok} fail={fail} skipped={skipped}", flush=True)
    log_fetch(work_dir, source="Naver chart API daily OHLCV (KRX-only)",
              url="https://fchart.stock.naver.com/sise.nhn?symbol=CODE&timeframe=day&count=250&requestType=0",
              method_and_params=f"GET for {len(codes)} codes (started {started})",
              http_result=f"200 OK {ok}, failed {fail}, cached {skipped}"
              + (f"; failures {' '.join(failures[:20])}" if failures else ""),
              used_for="ESTIMATE only: 2026 YTD sum close x volume (prefilter) and KIS cross-check",
              local_files="raw/naver_fchart/<code>.xml")
    print("done", ok, fail, skipped, failures[:20])


# --------------------------------------------------------------------------
# engkind company summary (official English names)
# --------------------------------------------------------------------------

def cmd_engkind(raw_dir: str, work_dir: str, codes_file: str) -> None:
    out = os.path.join(raw_dir, "engkind_summary")
    os.makedirs(out, exist_ok=True)
    codes = read_codes(codes_file)
    started = utc_now()
    ok = fail = 0
    for code in codes:
        url = ("https://engkind.krx.co.kr/common/companysummary.do?method="
               f"searchCompanySummary&strIsurCd={urllib.parse.quote(code[:5])}")
        status, body, _ = http(url)
        write_bytes(os.path.join(out, f"{code}.html"), body)
        if status == 200:
            ok += 1
        else:
            fail += 1
        time.sleep(0.5)
    log_fetch(work_dir, source="KRX English KIND company summary",
              url="https://engkind.krx.co.kr/common/companysummary.do?method=searchCompanySummary&strIsurCd=<first 5 chars of code>",
              method_and_params=f"GET for {len(codes)} codes (started {started})",
              http_result=f"200 OK {ok}, other {fail}",
              used_for="official English names / ISIN for names not in the 2026-10-15 CSVs",
              local_files="raw/engkind_summary/<code>.html")
    print("engkind", ok, fail)


def cmd_engkind_list(raw_dir: str, work_dir: str) -> None:
    url = "https://engkind.krx.co.kr/corpgeneral/corplist.do"
    form = {"method": "searchCorp", "forward": "searchCorp", "currentPageSize": "3000",
            "pageIndex": "1"}
    status, body, _ = http(url, data=form, referer="https://engkind.krx.co.kr/")
    write_bytes(os.path.join(raw_dir, "engkind_list", "engkind_searchcorp_all.html"), body)
    log_fetch(work_dir, source="KRX English KIND company list search", url=url,
              method_and_params="POST " + " ".join(f"{k}={v}" for k, v in form.items()),
              http_result=f"{status} - {len(body)} bytes",
              used_for="official English name for codes the summary endpoint cannot resolve (foreign issuers)",
              local_files="raw/engkind_list/engkind_searchcorp_all.html")
    print("engkind-list", status, len(body))


def main(argv: list[str]) -> None:
    if len(argv) < 4:
        raise SystemExit(__doc__)
    cmd, raw_dir, work_dir = argv[1], argv[2], argv[3]
    os.makedirs(work_dir, exist_ok=True)
    if cmd == "kind":
        cmd_kind(raw_dir, work_dir)
    elif cmd == "krx-probe":
        cmd_krx_probe(raw_dir, work_dir)
    elif cmd == "naver-snap":
        cmd_naver_snap(raw_dir, work_dir)
    elif cmd == "fchart":
        cmd_fchart(raw_dir, work_dir, argv[4])
    elif cmd == "engkind":
        cmd_engkind(raw_dir, work_dir, argv[4])
    elif cmd == "engkind-list":
        cmd_engkind_list(raw_dir, work_dir)
    else:
        raise SystemExit(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    main(sys.argv)
