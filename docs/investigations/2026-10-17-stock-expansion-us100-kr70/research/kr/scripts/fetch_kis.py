#!/usr/bin/env python3
"""ACTUAL daily KRX trading value from KIS Open API (FHKST03010100), KR-70 study.

    python3 -I fetch_kis.py ENV_FILE RAW_DIR WORK_DIR SHORTLIST_FILE [CHECKS_JSON]

* Credentials (KIS_APP_KEY, KIS_APP_SECRET, KIS_REST_BASE_URL) are read from
  ENV_FILE at runtime (last occurrence wins, as with dotenv/shell sourcing).
  They and the access token are kept in memory only: never printed, logged or
  written to disk. Raw response bodies are cached only after checking that
  they contain none of those strings.
* Exactly ONE access token is issued (POST /oauth2/tokenP) and reused.
* Requests are paced to <= ~3.3/s; on rate-limit responses (EGW00201 etc.)
  the script backs off and slows down; it aborts after repeated failures.
* Market division code is always given explicitly. The ranking uses J
  (KRX only). NX/UN are used only by the optional CHECKS_JSON comparison.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PATH = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
TR_ID = "FHKST03010100"
# Two windows of <= 97 KRX sessions each (the API returns at most 100 rows).
RANGES = (("20260101", "20260522"), ("20260523", "20261016"))
MIN_INTERVAL_S = 0.30
MAX_INTERVAL_S = 1.50
RATE_LIMIT_CODES = {"EGW00201", "EGW00133"}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_env(path: str) -> dict[str, str]:
    wanted = {"KIS_APP_KEY", "KIS_APP_SECRET", "KIS_REST_BASE_URL"}
    out: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) in wanted:
                val = m.group(2)
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                out[m.group(1)] = val  # last occurrence wins
    missing = wanted - out.keys()
    if missing:
        raise SystemExit(f"missing env keys: {sorted(missing)}")
    return out


class Kis:
    def __init__(self, env: dict[str, str]) -> None:
        self._key = env["KIS_APP_KEY"]
        self._secret = env["KIS_APP_SECRET"]
        self.base = env["KIS_REST_BASE_URL"].rstrip("/")
        self._token: str | None = None
        self.interval = MIN_INTERVAL_S
        self._last = 0.0
        self.calls = 0
        self.rate_limited = 0

    # -- secrets hygiene ---------------------------------------------------
    def body_is_clean(self, body: bytes) -> bool:
        needles = [self._key, self._secret] + ([self._token] if self._token else [])
        return not any(n and n.encode() in body for n in needles)

    def issue_token(self) -> str:
        if self._token is not None:
            raise RuntimeError("token already issued for this run")
        payload = json.dumps({"grant_type": "client_credentials", "appkey": self._key,
                              "appsecret": self._secret}).encode()
        req = urllib.request.Request(self.base + "/oauth2/tokenP", data=payload, method="POST",
                                     headers={"content-type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                status, body = resp.status, resp.read()
        except urllib.error.HTTPError as err:
            status, body = err.code, err.read() or b""
        try:
            data = json.loads(body)
        except ValueError:
            data = {}
        token = data.get("access_token")
        if status != 200 or not token:
            # error_code / error_description carry no credentials
            raise SystemExit(f"token request failed: HTTP {status} "
                             f"{data.get('error_code', '')} {data.get('error_description', '')}")
        self._token = token
        return f"HTTP {status}; token_type={data.get('token_type')}; expires_in={data.get('expires_in')}; " \
               f"expires_at={data.get('access_token_token_expired')}"

    def _pace(self) -> None:
        wait = self._last + self.interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def daily(self, code: str, d1: str, d2: str, mrkt: str = "J", adj: str = "0"
              ) -> tuple[int, bytes, dict]:
        assert self._token is not None
        query = urllib.parse.urlencode({
            "FID_COND_MRKT_DIV_CODE": mrkt, "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": d1, "FID_INPUT_DATE_2": d2,
            "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": adj,
        })
        headers = {
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {self._token}",
            "appkey": self._key, "appsecret": self._secret,
            "tr_id": TR_ID, "custtype": "P",
        }
        self._pace()
        self.calls += 1
        req = urllib.request.Request(f"{self.base}{PATH}?{query}", headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                status, body = resp.status, resp.read()
        except urllib.error.HTTPError as err:
            status, body = err.code, err.read() or b""
        except Exception as exc:  # network error; no secrets in the message
            return -1, b"", {"rt_cd": "net", "msg_cd": type(exc).__name__, "msg1": ""}
        try:
            data = json.loads(body)
        except ValueError:
            data = {"rt_cd": "json", "msg_cd": "", "msg1": f"<non-JSON body, {len(body)} bytes>"}
        return status, body, data


def is_blank(row: dict) -> bool:
    return all((v is None or str(v).strip() == "") for v in row.values())


def fetch_one(kis: Kis, code: str, d1: str, d2: str, mrkt: str, adj: str, raw_path: str | None,
              log: list[dict]) -> dict | None:
    for attempt in range(5):
        status, body, data = kis.daily(code, d1, d2, mrkt, adj)
        rt, msg_cd, msg = data.get("rt_cd"), data.get("msg_cd", ""), data.get("msg1", "")
        entry = {"code": code, "d1": d1, "d2": d2, "mrkt": mrkt, "adj": adj, "http": status,
                 "rt_cd": rt, "msg_cd": msg_cd, "msg1": (msg or "").strip()[:80],
                 "attempt": attempt + 1, "at": utc_now()}
        if status == 200 and rt == "0":
            rows = [r for r in (data.get("output2") or []) if isinstance(r, dict) and not is_blank(r)]
            entry["rows"] = len(rows)
            entry["blank_rows"] = len(data.get("output2") or []) - len(rows)
            log.append(entry)
            if raw_path:
                if kis.body_is_clean(body):
                    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
                    with open(raw_path, "wb") as fh:
                        fh.write(body)
                else:
                    entry["cache"] = "skipped: secret-like content"
            if kis.interval > MIN_INTERVAL_S:
                kis.interval = max(MIN_INTERVAL_S, kis.interval * 0.9)
            return {"output1": data.get("output1") or {}, "rows": rows}
        log.append(entry)
        if msg_cd in RATE_LIMIT_CODES or status in (429, 500, 502, 503, 504) or rt in ("net", "json"):
            kis.rate_limited += 1
            kis.interval = min(MAX_INTERVAL_S, kis.interval * 2)
            time.sleep(2.0 * (attempt + 1))
            continue
        return None  # non-retryable (e.g. invalid code)
    return None


def main(argv: list[str]) -> None:
    env_file, raw_dir, work_dir, shortlist_file = argv[1:5]
    checks_file = argv[5] if len(argv) > 5 else None
    # shortlist lines: "CODE" or "CODE<TAB>YYYY-MM-DD" (KIND listing date)
    entries = []
    for ln in open(shortlist_file, encoding="utf-8"):
        parts = ln.strip().split("\t")
        if parts and parts[0]:
            entries.append((parts[0], parts[1].replace("-", "") if len(parts) > 1 else "00000000"))
    kis = Kis(read_env(env_file))
    run = {"started": utc_now(), "token": kis.issue_token(), "codes": len(entries)}
    print("token issued", run["started"], flush=True)
    log: list[dict] = []
    result: dict[str, dict] = {}
    consecutive_fail = 0
    for i, (code, listed) in enumerate(entries):
        rows: list[dict] = []
        out1: dict = {}
        range_errors = []
        ranges_called = 0
        for d1, d2 in RANGES:
            if listed > d2:  # listed after this window: nothing to fetch
                continue
            ranges_called += 1
            res = fetch_one(kis, code, d1, d2, "J", "0",
                            os.path.join(raw_dir, "kis", f"{code}_J_{d1}_{d2}.json"), log)
            if res is not None and len(res["rows"]) >= 100:  # cap reached (never expected)
                mid = (dt.datetime.strptime(d1, "%Y%m%d") + (dt.datetime.strptime(d2, "%Y%m%d")
                       - dt.datetime.strptime(d1, "%Y%m%d")) / 2).strftime("%Y%m%d")
                res_a = fetch_one(kis, code, d1, mid, "J", "0", None, log)
                nxt = (dt.datetime.strptime(mid, "%Y%m%d") + dt.timedelta(days=1)).strftime("%Y%m%d")
                res_b = fetch_one(kis, code, nxt, d2, "J", "0", None, log)
                res = None if res_a is None or res_b is None else {
                    "output1": res["output1"], "rows": res_a["rows"] + res_b["rows"]}
            if res is None:
                range_errors.append({"d1": d1, "d2": d2, "last_log": log[-1] if log else None})
                continue
            rows.extend(res["rows"])
            out1 = out1 or res["output1"]
        if ranges_called and len(range_errors) == ranges_called:
            consecutive_fail += 1
        else:
            consecutive_fail = 0
        result[code] = {"output1": out1, "rows": rows, "range_errors": range_errors,
                        "ranges_called": ranges_called}
        if consecutive_fail >= 5:
            print("aborting: 5 consecutive failures", flush=True)
            break
        if (i + 1) % 25 == 0:
            print(f"{i + 1}/{len(entries)} calls={kis.calls} rate_limited={kis.rate_limited} "
                  f"interval={kis.interval:.2f}", flush=True)
    checks_out = []
    checks = json.load(open(checks_file)) if checks_file else []
    # Auto check: for up to 2 stocks whose J rows carry a price-adjustment marker
    # (mod_yn=Y or a non-zero split ratio), re-fetch that window with
    # FID_ORG_ADJ_PRC=1 (raw prices) to show acml_tr_pbmn does not depend on it.
    picked = 0
    for code, v in result.items():
        if picked >= 2 or not v.get("rows"):
            continue
        marked = [r for r in v["rows"] if r.get("mod_yn") == "Y"
                  or (r.get("prtt_rate") or "0").strip() not in ("", "0", "0.00", "0.0")]
        if marked:
            day = marked[0]["stck_bsop_date"]
            d1, d2 = next((a, b) for a, b in RANGES if a <= day <= b)
            checks.append({"code": code, "d1": d1, "d2": d2, "mrkt": "J", "adj": "1",
                           "why": f"adjustment marker on {day}"})
            picked += 1
    if checks:
        for chk in checks:
            res = fetch_one(kis, chk["code"], chk["d1"], chk["d2"], chk["mrkt"], chk.get("adj", "0"),
                            os.path.join(raw_dir, "kis_checks",
                                         f"{chk['code']}_{chk['mrkt']}_adj{chk.get('adj', '0')}_{chk['d1']}_{chk['d2']}.json"),
                            log)
            checks_out.append({"check": chk, "rows": res["rows"] if res else None,
                               "output1": res["output1"] if res else None})
    run.update({"finished": utc_now(), "calls": kis.calls, "rate_limited": kis.rate_limited,
                "ok_codes": sum(1 for v in result.values() if v.get("rows") and not v["range_errors"]),
                "codes_with_errors": [c for c, v in result.items() if v["range_errors"]]})
    with open(os.path.join(work_dir, "kis_daily.json"), "w", encoding="utf-8") as fh:
        json.dump({"run": run, "data": result, "checks": checks_out}, fh, ensure_ascii=False)
    with open(os.path.join(work_dir, "kis_call_log.jsonl"), "w", encoding="utf-8") as fh:
        for e in log:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(json.dumps(run, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
