#!/usr/bin/env python3
"""ESTIMATE pass: 2026 YTD sum(close x volume) from Naver fchart + shortlist.

    python3 -I estimate_shortlist.py RAW_DIR WORK_DIR REPO_ROOT [TOP_N]

Writes WORK_DIR/estimates.json, WORK_DIR/shortlist.tsv, WORK_DIR/expected_sessions.json.
The values computed here are ESTIMATES (Naver close x Naver volume, KRX-only);
they are used only to build the KIS shortlist, never as the ranking basis.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
import sys

WINDOW_START = "20260102"
WINDOW_END = "20261016"
PRELIM_55 = """009150 402340 036930 006400 353200 105560 240810 012450 042700 096770 000150
373220 011070 055550 403870 028260 012330 007660 222800 329180 278470 267260 086790 010120
009830 047040 316140 032830 067310 000990 028050 272210 058470 196170 108490 000720 034730
005490 079550 001440 003670 003490 017670 062040 009540 128940 010950 066970 010060 000810
033780 064350 015760 352820 071050""".split()
EXISTING_15 = """005930 000660 034020 010140 042660 005380 000270 035420 035720 068270
051910 066570 086520 247540 028300""".split()


def expected_sessions(repo_root: str) -> list[str]:
    path = os.path.join(repo_root, "backend/src/orders/market-calendar/data/krx-2026.ts")
    text = open(path, encoding="utf-8").read()
    closed = set()
    for m in re.finditer(r"\{\s*date:\s*'(\d{4}-\d{2}-\d{2})'[^}]*?isFullDayClosed:\s*(true|false)", text, re.S):
        if m.group(2) == "true":
            closed.add(m.group(1).replace("-", ""))
    day = dt.date(2026, 1, 2)
    end = dt.date(2026, 10, 16)
    out = []
    while day <= end:
        ymd = day.strftime("%Y%m%d")
        if day.weekday() < 5 and ymd not in closed:
            out.append(ymd)
        day += dt.timedelta(days=1)
    return out


def parse_fchart(path: str) -> list[tuple[str, int, int, int, int, int]]:
    raw = open(path, "rb").read().decode("cp949", errors="replace")
    rows = []
    for m in re.finditer(r'<item data="([^"]+)"', raw):
        parts = m.group(1).split("|")
        if len(parts) != 6:
            continue
        d, o, h, l, c, v = parts
        try:
            rows.append((d, int(o), int(h), int(l), int(c), int(v)))
        except ValueError:
            continue
    return rows


def main(raw_dir: str, work_dir: str, repo_root: str, top_n: int) -> None:
    sessions = expected_sessions(repo_root)
    with open(os.path.join(work_dir, "expected_sessions.json"), "w") as fh:
        json.dump({"count": len(sessions), "first": sessions[0], "last": sessions[-1],
                   "sessions": sessions}, fh)
    uni = json.load(open(os.path.join(work_dir, "universe.json"), encoding="utf-8"))
    est: dict[str, dict] = {}
    missing = []
    for code, u in uni.items():
        path = os.path.join(raw_dir, "naver_fchart", f"{code}.xml")
        if not os.path.exists(path):
            missing.append(code)
            continue
        rows = [r for r in parse_fchart(path) if WINDOW_START <= r[0] <= WINDOW_END]
        total = sum(r[4] * r[5] for r in rows)
        zero_vol = sum(1 for r in rows if r[5] == 0)
        last = rows[-1] if rows else None
        # largest day-over-day close jump (KRX daily limit is +/-30%): flags
        # unadjusted corporate actions or relisting gaps in the Naver series
        max_jump = 0.0
        for a, b in zip(rows, rows[1:]):
            if a[4] > 0 and b[4] > 0:
                max_jump = max(max_jump, abs(b[4] / a[4] - 1))
        est[code] = {
            "est_ytd_close_x_vol": total, "rows_2026": len(rows), "zero_volume_rows": zero_vol,
            "first_date": rows[0][0] if rows else None, "last_date": last[0] if last else None,
            "last_close": last[4] if last else None, "last_volume": last[5] if last else None,
            "max_abs_close_jump": round(max_jump, 4),
            "missing_sessions": [d for d in sessions if d >= (rows[0][0] if rows else "9")
                                 and d not in {r[0] for r in rows}],
        }
    ranked = sorted(est, key=lambda c: -est[c]["est_ytd_close_x_vol"])
    for i, code in enumerate(ranked, 1):
        est[code]["est_rank_all"] = i
    # rank among stocks that are not flagged SPAC/REIT/fund (informational)
    with open(os.path.join(work_dir, "estimates.json"), "w", encoding="utf-8") as fh:
        json.dump(est, fh, ensure_ascii=False)

    alt_path = os.path.join(repo_root, "docs/investigations/2026-10-15-koscom-100-stock-collection-design/expansion-70/alternates_10.csv")
    alternates = [r["code"] for r in csv.DictReader(open(alt_path, encoding="utf-8"))]
    top = ranked[:top_n]
    union = list(dict.fromkeys(top + PRELIM_55 + alternates + EXISTING_15))
    not_in_kind = [c for c in union if c not in uni]
    with open(os.path.join(work_dir, "shortlist.tsv"), "w", encoding="utf-8") as fh:
        for code in union:
            fh.write(code + "\t" + (uni[code]["listing_date"] if code in uni else "") + "\n")
    print("union codes missing from the KIND corp list:", not_in_kind)
    print(f"expected sessions {len(sessions)} ({sessions[0]}..{sessions[-1]}); fchart missing {len(missing)} {missing[:10]}")
    print(f"shortlist: top{top_n}={len(top)} + prelim/alternates/existing -> {len(union)} codes")
    outside = [c for c in union if c not in top]
    print("union members outside top-N:", [(c, uni.get(c, {}).get('name_ko'), est.get(c, {}).get('est_rank_all')) for c in outside])
    for k in (55, 70, 75, 100, 150, 200):
        if k <= len(ranked):
            c = ranked[k - 1]
            print(f"est rank {k}: {c} {uni[c]['name_ko']} {est[c]['est_ytd_close_x_vol']/1e12:.3f} tn")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 150)
