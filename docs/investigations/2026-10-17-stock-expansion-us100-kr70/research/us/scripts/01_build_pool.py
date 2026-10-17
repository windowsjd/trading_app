"""Step 1: build the candidate pool from the Nasdaq screener snapshot.

usage: python3 -I 01_build_pool.py <raw_dir> <work_dir>

Pool = existing 25 + preliminary 75 + alternates + gainbot (current page) top 100
     + top N_MCAP screener rows by marketCap + top N_DV by lastsale*volume
     + safety sweep: every other screener row with marketCap >= $1B or
       10-15 lastsale*volume >= $10M (preferred '^' rows and names that say
       warrant/unit/right are skipped in the sweep only - they are ineligible by class).
Nothing is dropped: every row carries the reasons it entered the pool.
"""
import csv
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ALTERNATES, EXISTING_25, PRELIMINARY_75, load_json, num  # noqa: E402

N_MCAP = 1200
N_DV = 1000
SWEEP_MCAP = 1e9
SWEEP_DV = 1e7


def parse_gainbot(path):
    """Parse the server-rendered 'Most active YTD' table (rank, symbol, price, volume)."""
    if not os.path.exists(path):
        return []
    h = open(path, encoding="utf-8", errors="replace").read()
    txt = re.sub(r"<script[\s\S]*?</script>", " ", h)
    txt = re.sub(r"<style[\s\S]*?</style>", " ", txt)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = html.unescape(re.sub(r"\s+", " ", txt))
    asof = re.search(r"As of ([A-Za-z]+ \d+, \d{4}) close", txt)
    body = txt.split("Rel. vol Mkt cap", 1)[-1]
    pat = re.compile(r"(\d{1,3}) ([A-Z][A-Z.\-]{0,6}) (.*?) \$([\d,]+\.\d+) [▲▼] ([+−-][\d.,]+)% "
                     r"([+−-][\d.,]+)% ([\d.]+)([KMB]) ([\d.]+)× \$([\d.]+)([KMBT])")
    out = []
    mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
    for m in pat.finditer(body):
        rank, sym, name, price, ytd, today, vol, vu, rel, mc, mu = m.groups()
        out.append({
            "gb_rank": int(rank), "symbol": sym, "gb_name": name.strip(),
            "gb_price": float(price.replace(",", "")),
            "gb_volume": float(vol) * mult[vu],
            "gb_mcap": float(mc) * mult[mu],
            "gb_asof": asof.group(1) if asof else "",
        })
    return out


def main():
    raw, work = sys.argv[1], sys.argv[2]
    scr = os.path.join(raw, "screener")
    allrows = load_json(os.path.join(scr, "all.json"))["data"]["rows"]
    exch = {}
    for ex, label in (("nasdaq", "NASDAQ"), ("nyse", "NYSE"), ("amex", "NYSE American")):
        for r in load_json(os.path.join(scr, ex + ".json"))["data"]["rows"]:
            exch.setdefault(r["symbol"], []).append(label)

    by_sym = {}
    for r in allrows:
        by_sym[r["symbol"]] = r

    def key(sym):  # screener uses BRK/B; everyone else uses BRK.B
        return sym.replace("/", ".")

    reasons = {}

    def add(sym, why):
        reasons.setdefault(sym, [])
        if why not in reasons[sym]:
            reasons[sym].append(why)

    for s in EXISTING_25:
        add(s, "existing25")
    for s in PRELIMINARY_75:
        add(s, "preliminary75")
    for s in ALTERNATES:
        add(s, "alternate")
    gb = parse_gainbot(os.path.join(raw, "gainbot", "ytd_active.html"))
    for g in gb:
        add(g["symbol"], "gainbot_current_top100")

    mc_sorted = sorted(allrows, key=lambda r: num(r["marketCap"]) or 0, reverse=True)
    for i, r in enumerate(mc_sorted[:N_MCAP]):
        add(key(r["symbol"]), "screener_mcap_top%d" % N_MCAP)
    dv_sorted = sorted(allrows, key=lambda r: (num(r["lastsale"]) or 0) * (num(r["volume"]) or 0),
                       reverse=True)
    for i, r in enumerate(dv_sorted[:N_DV]):
        add(key(r["symbol"]), "screener_dv_top%d" % N_DV)

    for r in allrows:
        sym = key(r["symbol"])
        if sym in reasons or "^" in sym:
            continue
        if re.search(r"\b(warrants?|units?|rights?)\b", r["name"].lower()):
            continue
        if (num(r["marketCap"]) or 0) >= SWEEP_MCAP or \
                (num(r["lastsale"]) or 0) * (num(r["volume"]) or 0) >= SWEEP_DV:
            add(sym, "screener_sweep_mcap1B_or_dv10M")

    mc_rank = {key(r["symbol"]): i + 1 for i, r in enumerate(mc_sorted)}
    dv_rank = {key(r["symbol"]): i + 1 for i, r in enumerate(dv_sorted)}
    gb_by = {g["symbol"]: g for g in gb}

    os.makedirs(work, exist_ok=True)
    out = os.path.join(work, "pool.csv")
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "screener_symbol", "pool_reasons", "in_screener", "screener_exchanges",
                    "name", "country", "ipoyear", "sector", "industry", "snap_lastsale",
                    "snap_volume", "snap_dollar_volume", "snap_marketcap", "mcap_rank",
                    "snap_dv_rank", "gb_rank", "gb_price", "gb_volume"])
        for sym in sorted(reasons):
            ssym = sym.replace(".", "/") if sym.replace(".", "/") in by_sym else sym
            r = by_sym.get(ssym)
            g = gb_by.get(sym, {})
            if r:
                ls, vo = num(r["lastsale"]), num(r["volume"])
                w.writerow([sym, ssym, "|".join(reasons[sym]), 1, "|".join(exch.get(ssym, [])),
                            r["name"].strip(), r["country"], r["ipoyear"], r["sector"], r["industry"],
                            ls, vo, (ls or 0) * (vo or 0), num(r["marketCap"]),
                            mc_rank.get(sym), dv_rank.get(sym), g.get("gb_rank", ""),
                            g.get("gb_price", ""), g.get("gb_volume", "")])
            else:
                w.writerow([sym, "", "|".join(reasons[sym]), 0, "", "", "", "", "", "", "", "", "",
                            "", "", "", g.get("gb_rank", ""), g.get("gb_price", ""),
                            g.get("gb_volume", "")])
    with open(os.path.join(work, "gainbot_current.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["gb_rank", "symbol", "gb_name", "gb_price", "gb_volume",
                                          "gb_mcap", "gb_asof"])
        w.writeheader()
        for g in gb:
            w.writerow(g)
    print("pool size", len(reasons), "gainbot rows", len(gb))


if __name__ == "__main__":
    main()
