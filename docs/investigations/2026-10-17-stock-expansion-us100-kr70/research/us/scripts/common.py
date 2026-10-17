"""Shared helpers for the US-100 YTD dollar-volume research (stdlib only).

All downloaded data is treated as untrusted: it is only parsed as JSON/CSV,
never executed. Run every script with `python3 -I`.
"""
import csv
import datetime as dt
import json
import os
import random
import subprocess
import sys
import time

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")

WINDOW_START = dt.date(2026, 1, 2)
WINDOW_END = dt.date(2026, 10, 16)

# 2026 NYSE full-day holidays (Jan 1 falls before the window).
NYSE_HOLIDAYS_2026 = [
    dt.date(2026, 1, 1),   # New Year's Day
    dt.date(2026, 1, 19),  # Martin Luther King Jr. Day
    dt.date(2026, 2, 16),  # Washington's Birthday
    dt.date(2026, 4, 3),   # Good Friday
    dt.date(2026, 5, 25),  # Memorial Day
    dt.date(2026, 6, 19),  # Juneteenth
    dt.date(2026, 7, 3),   # Independence Day (observed; Jul 4 is a Saturday)
    dt.date(2026, 9, 7),   # Labor Day
]

EXISTING_25 = ["NVDA", "TSLA", "AMD", "AAPL", "AMZN", "MSFT", "GOOGL", "META",
               "PLTR", "INTC", "SOFI", "RIVN", "MARA", "WBD", "CSCO", "MU",
               "QCOM", "PYPL", "MSTR", "SMCI", "F", "BAC", "PFE", "T", "UBER"]

PRELIMINARY_75 = ("SNDK SPCX AVGO CRWV NBIS DELL LITE MRVL GOOG AMAT MDT LLY WDC "
                  "ORCL BE UNH MRNA STX WMT LRCX GEV V CAT IREN COST NFLX JPM VRT "
                  "TMO RKLB CRWD NOW MA PG COHR CCC KLAC JNJ GS HOOD BRK.B ABBV CRM "
                  "PANW HD HPE MRK AMGN XOM ANET TXN SHOP SNOW ACN ETN ADI KO CRDO "
                  "SCHW NKE WFC ADBE IONQ MS COIN MCD PM GLW CVX TER PEP SBUX AAOI "
                  "SNPS INTU").split()

ALTERNATES = "NET SMTC C CRCL BLK WULF ABT CVS IBM".split()


def expected_sessions():
    out = []
    d = WINDOW_START
    hol = set(NYSE_HOLIDAYS_2026)
    while d <= WINDOW_END:
        if d.weekday() < 5 and d not in hol:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def num(s):
    if s is None:
        return None
    s = str(s).replace("$", "").replace(",", "").strip()
    if s in ("", "N/A", "NA", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def curl_get(url, out_path, headers=None, timeout=60):
    """Fetch url into out_path with curl. Returns (http_code, bytes)."""
    cmd = ["curl", "-sS", "-m", str(timeout), "-o", out_path,
           "-w", "%{http_code} %{size_download}", "-H", "User-Agent: " + UA]
    for h in (headers or []):
        cmd += ["-H", h]
    cmd.append(url)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
    except subprocess.TimeoutExpired:
        return 0, 0
    parts = (res.stdout or "").strip().split()
    try:
        return int(parts[0]), int(float(parts[1]))
    except (IndexError, ValueError):
        return 0, 0


def fetch_with_backoff(url, out_path, headers=None, ok=lambda code, path: code == 200,
                       max_tries=6, base_sleep=1.0):
    """Exponential backoff on 429/5xx/timeouts. Returns (code, tries)."""
    code = 0
    for attempt in range(1, max_tries + 1):
        code, _ = curl_get(url, out_path, headers=headers)
        if ok(code, out_path):
            return code, attempt
        if code in (400, 401, 403, 404) and attempt >= 2:
            return code, attempt
        sleep = base_sleep * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
        time.sleep(min(sleep, 60))
    return code, max_tries


def append_log(log_path, row):
    new = not os.path.exists(log_path)
    with open(log_path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["source", "url_pattern", "fetched_utc", "result", "used_for"])
        w.writerow(row)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)
