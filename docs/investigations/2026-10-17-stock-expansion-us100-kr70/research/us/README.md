# US expansion research: 75 new US stocks by 2026 YTD dollar volume

- Researched 2026-10-17. Window: first 2026 session **2026-01-02** through the last confirmed session **2026-10-16 (Fri)**, which is **199 NYSE sessions**.
- No application code, database, or `.env` file was touched. Every downloaded file is in `raw-cache.tar.xz`, and the scripts are in `scripts/`.
- **Every dollar figure here is an estimate.** `EST_close = Σ(daily close × daily consolidated volume)`. No source used here gave an exchange-reported traded value (Σ price × quantity per trade).

## 1. Result: the new 75 under rule R1

The final universe is the existing 25 plus the 75 names below, for exactly 100.

R1 admits US-listed common and ordinary shares, including foreign issuers' directly listed ordinary shares (NBIS, STX, IREN, CRDO, SHOP and ACN here). It excludes ADR/ADS and other depositary receipts, ETF/ETN/leveraged products, preferred shares, warrants/units/rights, and delisted or non-tradable securities.

| # | Symbol | EST_close $bn | # | Symbol | EST_close $bn | # | Symbol | EST_close $bn |
|---:|---|---:|---:|---|---:|---:|---|---:|
| 1 | SNDK | 3321.5 | 26 | APP | 479.3 | 51 | ABBV | 296.2 |
| 2 | AVGO | 1828.1 | 27 | NOW | 475.9 | 52 | ADI | 296.0 |
| 3 | SPCX* | 1396.5 | 28 | BRK.B | 465.2 | 53 | SNOW | 289.1 |
| 4 | GOOG | 1366.5 | 29 | CAT | 458.1 | 54 | BKNG | 286.8 |
| 5 | MRVL | 1105.7 | 30 | GS | 422.8 | 55 | PG | 286.3 |
| 6 | ORCL | 926.7 | 31 | COST | 421.0 | 56 | ADBE | 284.5 |
| 7 | LITE | 854.1 | 32 | KLAC | 406.7 | 57 | ASTS | 274.9 |
| 8 | AMAT | 710.0 | 33 | PANW | 395.9 | 58 | CRDO | 272.8 |
| 9 | WDC | 701.0 | 34 | IREN | 394.0 | 59 | KO | 272.0 |
| 10 | NFLX | 698.7 | 35 | CVX | 392.4 | 60 | WFC | 269.8 |
| 11 | NBIS | 646.9 | 36 | RKLB | 387.5 | 61 | MRK | 264.0 |
| 12 | LLY | 631.1 | 37 | JNJ | 386.7 | 62 | SHOP | 262.0 |
| 13 | STX | 603.0 | 38 | COHR | 386.0 | 63 | CRCL | 258.9 |
| 14 | LRCX | 599.0 | 39 | TXN | 385.9 | 64 | ALAB | 257.2 |
| 15 | WMT | 588.6 | 40 | CRWD | 381.4 | 65 | ACN | 257.0 |
| 16 | JPM | 585.3 | 41 | GLW | 379.6 | 66 | MRNA | 256.4 |
| 17 | BE | 567.8 | 42 | IBM | 373.3 | 67 | AAOI | 255.0 |
| 18 | CRWV | 547.5 | 43 | MA | 370.6 | 68 | APH | 253.2 |
| 19 | XOM | 540.5 | 44 | COIN | 368.7 | 69 | VZ | 251.1 |
| 20 | CRM | 530.0 | 45 | VRT | 339.1 | 70 | ANET | 249.9 |
| 21 | DELL | 526.0 | 46 | GE | 322.7 | 71 | TMO | 245.5 |
| 22 | UNH | 510.1 | 47 | C | 310.2 | 72 | TER | 244.6 |
| 23 | V | 507.3 | 48 | INTU | 305.0 | 73 | MCD | 237.6 |
| 24 | HOOD | 491.7 | 49 | HD | 298.0 | 74 | MS | 236.5 |
| 25 | GEV | 487.0 | 50 | BA | 297.5 | 75 | PEP | 235.4 |

\* SPCX had its IPO on 2026-06-12, so its total covers only 88 of the 199 sessions. Every other name traded all 199 sessions.

- **Cutoff (#75):** PEP at $235.4bn (estimate).
- **Nearest names left out:** ABT $226.8bn (−3.65 %), LIN $226.5bn (−3.77 %), CIEN $225.6bn (−4.15 %), NKE $219.7bn (−6.66 %), IONQ $218.1bn (−7.38 %).
- **Separate share classes**, counted under the "identity verified" allowance:
  - GOOG is Alphabet Class C capital stock. GOOGL (Class A) is already in the existing 25.
  - BRK.B is Berkshire Class B. BRK.A ranks only #546 overall ($47.9bn).

## 2. Method

1. **Candidate pool: 2,931 symbols.** It combines:
   - the existing 25, the preliminary 75, the 9 alternates, and the gainbot 10-16 page (100 names);
   - from the Nasdaq stock screener (all 7,002 US-listed stock rows, a 2026-10-15 close snapshot): the top 1,200 by market cap and the top 1,000 by lastsale×volume;
   - a **safety sweep** of every remaining screener row with market cap ≥ $1bn or 10-15 lastsale×volume ≥ $10m (1,606 symbols). Preferred `^` rows and warrant/unit/right names were skipped in the sweep only, because they are ineligible anyway.

   The sweep found nothing near the cutoff: the best sweep-only symbol is CAR at overall #430 ($62.7bn). Among all 203 symbols with EST ≥ 50 % of the cutoff, the worst 10-15 dollar-volume rank is #446 (OKLO), well inside the top-1,000 criterion.
2. **Daily history.** Source: `api.nasdaq.com/api/quote/{SYM}/historical`, 2026-01-01..2026-10-16. 2,927 of the 2,930 fetched symbols returned data. WBD, BF.B and HEI.A returned "no data"; HPE^C is preferred and was not fetched.
3. **Calendar.** I assumed 7 NYSE holidays inside the window: Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3 and Sep 7 (Jan 1 falls before the window). That gives 199 expected sessions. The data confirms it:
   - the weekdays with no row in any of the 2,927 symbols are exactly those 7 dates;
   - no symbol has a row on a holiday;
   - 199 distinct trading days appear.
4. **Metrics per symbol** (`scripts/04_metrics.py`): sessions, first and last date, missing sessions, EST_close, EST_typical = Σ((H+L+C)/3 × V) (a sensitivity check only), last close, latest-day volume, largest one-day move, and a heuristic flag for split-like price steps.
5. **Security class.** The main source is Nasdaq `quote/{SYM}/info` → `stockType`, fetched for 1,137 symbols: the top 600 by EST, all named lists, and every non-US pool symbol. Where that is missing, screener name text and Tiingo `assetType` are used. The class of every symbol down to rank 300 rests on Nasdaq `stockType` or on unambiguous name text.
6. **Tiingo identity.** From the public `supported_tickers.zip` (file dated 2026-10-16 23:05): ticker format, the current row (Stock / USD / endDate ≥ 2026-10-15 / exchange consistent with the listing), and tickers with more than one row.
7. **Corporate actions.** Yahoo split events, the Nasdaq price-step heuristic, first-trade dates and Tiingo start dates. Hand notes and their sources are in `supporting/corporate_actions_manual.csv`, and the web searches are logged in `us_sources_fetch_log.csv`.
8. **Ranking.** Everything is ranked by EST_close. The "new" rank skips the existing 25.

## 3. Data caveats

### Estimate versus actual value

EST_close prices every day's whole volume at the closing price. The real traded value prices each trade at its own price.

The EST_typical cross-check (typical price instead of close) produces the **same 75**: nothing enters or leaves. The largest gap between the two measures among the 75 is MRNA at −1.69 %, caused by a +177 % gap day on 2026-08-19. Every other selected name is within 0.28 %.

### Volume coverage: consolidated, not Nasdaq-only

Nasdaq's historical daily volume equals Yahoo's consolidated-tape daily volume. Across 159 symbols and 31,039 symbol-days, the median ratio is 1.000, and this holds for NYSE listings (JPM, XOM, LLY, BRK.B, TSM, …) as well as Nasdaq listings. The volume therefore covers all US venues, not just Nasdaq.

Whether pre- and post-market prints are included is not documented by either source; the two sources are identical either way.

### Split and distribution adjustment

- **Splits.** Nasdaq adjusts price and volume consistently: closes and volumes match Yahoo through each split (KLAC 10:1 on 06-12, BKNG 25:1 on 04-06, CRWD 4:1 on 07-02, APH 2:1 on 09-03). So close×volume equals the unadjusted daily value.
- **Regular dividends** are not adjusted.
- **Distributions and spin-offs are handled inconsistently** between the two sources:

  | Symbol | What Nasdaq does | Nasdaq EST vs Yahoo |
  |---|---|---|
  | HON (spin-off step on 06-29) | Leaves the step raw | −1.0 % |
  | SPGI (event on 07-01) | Adjusts prices by about 1.9 % but not volumes | −1.3 % |
  | SKYD | Adjusts prices ×0.82 but not volumes | −17 % |

  All three names stay more than 19 % below the cutoff even after correcting for this.

### Agreement between the two sources

- For all 75 selected names, Nasdaq EST divided by Yahoo EST lies between 1.00001 and 1.00034.
- The one exception is **SPCX at 1.0178**, caused by a single day, 2026-06-16. Nasdaq shows close 201.80 on 322.1M shares; Yahoo shows 211.39 on 195.4M shares. A third source would be needed to settle it, but SPCX's rank does not change either way.
- Re-ranking all 121 R1 candidates with EST ≥ 70 % of the cutoff using the Yahoo-based estimate gives the **identical 75 and the same cutoff (PEP)**, and no name moves more than 2 places (`supporting/second_source_check.json`).

### Other source disagreements

- Isolated single days where the two sources differ by more than 1 %: ARM, CMCSA, DHR, HON (Nasdaq shows a round 5,000,000 on 06-26), HONA, IBM, MU, ON and TMUS. None affects selection.
- BRK.A differs on many days because Yahoo rounds its volume to hundreds.

### Snapshot timing

The screener snapshot is the 2026-10-15 close and was used only for the pool, names and country. All metrics come from the daily series through 10-16.

## 4. Rule R1 versus R2, and the NY-registry question

| Scenario | Names that enter (new rank, EST $bn) | R1 names pushed out |
|---|---|---|
| **R1 (selected)** | — | — |
| **R2** = R1 + ADR/ADS | TSM (#6, 1,022.7), ARM (#46, 359.1), SKHY (#48, 322.9; ADS listed 2026-07-10, so 70 sessions only), BABA (#52, 298.6) | TER, MCD, MS, PEP |
| R1 + NY Registry Shares | ASML (#18, 549.9) | PEP |
| R2 + NY Registry Shares | TSM, ASML, ARM, SKHY, BABA | TMO, TER, MCD, MS, PEP |

**Decision needed on ASML.** Nasdaq lists its class as "New York Registry Shares". These are ordinary shares held on a New York register, not depositary receipts. R1 as worded admits only common and ordinary listings and treats NY-registry shares as their own class, so ASML is **excluded here**. If NY-registry shares are counted as directly listed ordinary shares, ASML enters at new #18 and PEP drops out.

## 5. Boundary analysis (±5 % of the #75 cutoff)

| Status | Names (EST_close relative to cutoff) |
|---|---|
| In | TMO +4.3 %, TER +3.9 %, MCD +0.9 %, MS +0.4 %, PEP 0 |
| Out | ABT −3.65 %, LIN −3.8 %, CIEN −4.2 % |

The gap between PEP and ABT is 3.65 %. That is more than ten times the measured sensitivities:
- EST_typical versus EST_close is 0.005–0.20 % for these eight names, and their ranks are unchanged;
- Nasdaq versus Yahoo is at most 0.04 %.

So the set is stable under every check available here. It is still a set chosen by estimate: true exchange traded values were not available to confirm it.

## 6. Comparison with the preliminary list

**The preliminary list is a single-day ranking.** The preliminary 75 followed by the 9 alternates match, position for position, the **2026-10-15 single-session** ranking by screener lastsale×volume. To get that match you remove the existing 25 and the four non-common names TSM, SKHY, ASML and ARM; all 84 positions then line up (`supporting/checks.json`).

**The gainbot "Most active / Year to Date" page is also a one-day list, despite its subtitle.**
- Its ordering matches the latest session's price×volume (Spearman 0.9997), compared with 0.82 against the YTD estimate.
- Its displayed volumes are 41–83 % (median 59 %) of the consolidated 10-16 volume. The cause is not documented.
- It omits ADR and NY-registry names even when their one-day value is far above the page's #100 level of about $0.58bn. On 10-16 (close×volume, estimates): TSM $6.9bn, SKHY $4.0bn, ASML $3.1bn, ARM $1.1bn, SAP $1.1bn, BABA $0.74bn. That fits its "US common stocks" label and explains why TSM and ASML are missing.
- Directly listed foreign ordinary shares do appear (NBIS, SHOP, STX, IREN, ACN, SPOT, ETN).
- Its methodology page says data come from Massive/Polygon daily aggregates, closes are stored raw and split-adjusted only for returns, and sectors come from SEC industry codes (hence oddities such as KLAC shown as "Healthcare"). The page's footnote filters are $2+, 500K+ shares in the latest session, and $100M+ market cap.

**Differences** (detail in `us_preliminary_diff.csv`):
- **Kept: 64** of the preliminary 75.
- **Dropped: 11.** Every drop is on rank; none is for class or data reasons.

  | Symbol | New rank | Symbol | New rank |
  |---|---:|---|---:|
  | NKE | #79 | PM | #109 |
  | IONQ | #80 | HPE | #113 |
  | AMGN | #90 | SBUX | #126 |
  | MDT | #91 | CCC | #1,025 |
  | ETN | #93 | | |
  | SCHW | #94 | | |
  | SNPS | #107 | | |

- **Alternates promoted: 3.** IBM (#42), C (#47), CRCL (#63).
- **New, in neither list: 8.** APP (#26), GE (#46), BA (#50), BKNG (#54), ASTS (#57), ALAB (#64), APH (#68), VZ (#69).
- **Alternates still out:** ABT (#76, −3.65 %), NET (#100), BLK, CVS, WULF and SMTC (lower).

## 7. What SPCX and CCC are

**SPCX** is Space Exploration Technologies Corp. **Class A Common Stock**:
- listed on Nasdaq Global Select (`stockType` "Class A Common Stock"; already a Nasdaq-100 member);
- first session 2026-06-12: open $150.00, close $160.95, 522.1M shares;
- Tiingo row `spcx`: NASDAQ / Stock / USD, 2026-06-12..2026-10-16;
- 88 sessions, EST_close $1,396.5bn, new #3.

**CCC** is CCC Intelligent Solutions Holdings Inc. **Common Stock**:
- listed on Nasdaq Global Select;
- Tiingo current row: NASDAQ, 2021-08-02..present. The ticker was used before by a different issuer (NYSE row 1987-06-03..2018-03-09);
- 2026 YTD EST_close is only $17.1bn (overall #1,119).

CCC was on the preliminary list only because of a one-day spike on 2026-10-15: 324.0M shares, about 32× its 2026 median of 10.0M, with the price pinned near $7.6 from 10-12 to 10-16. The cause of the spike was not verified.

## 8. Tiingo identity

- **All 75 have exactly one current Tiingo row**: Stock, USD, endDate 2026-10-16, and an exchange matching the listing. No row is missing.
- **Tickers used before by a different issuer.** When pulling history, filter by the current row's startDate:

  | Ticker | Earlier row in Tiingo |
  |---|---|
  | SNDK | 1995–2016, the old SanDisk |
  | DELL | NASDAQ 1988–2015, the old Dell Inc. |
  | COHR | NASDAQ 1990–2022, the legacy Coherent Inc. The current issuer is on NYSE. |
  | SNOW | NYSE 2014–2017 |
  | CRCL | OTCBB 2016–2018 |
  | MRNA | 1993–2018 |

- **Long history carried under a new name:** NBIS's row starts 2011-05-24, carrying Yandex N.V. history.
- **Unusual ticker format:** only BRK.B. It appears as `BRK/B` in the Nasdaq screener, `BRK.B` in the Nasdaq API, `BRK-B` on Yahoo, and **`brk-b` on Tiingo**.
- **Relevant only if R2 is adopted:** SKHY has two Tiingo rows that both start 2026-07-10, one ending the same day. That duplicate must be resolved first.
- **Tiingo IEX, intraday 5-minute and WebSocket support is pending.** It cannot be checked without a token, and none was used.

## 9. Corporate actions affecting the selected names (flags only)

- **Splits,** all handled consistently in both sources: KLAC 10:1 (2026-06-12), BKNG 25:1 (04-06), CRWD 4:1 (07-02), APH 2:1 (09-03).
- **XOM redomiciliation, effective 2026-07-01.** ExxonMobil Holdings Corporation (Texas) became the listed parent through a 1:1 share exchange, and the ticker stayed XOM. Source: SEC 8-K12B, accession 0001193125-26-291990.
- **SPCX:** IPO on 2026-06-12.
- **MRNA:** the heuristic flagged a "split-like" step on 2026-08-19. It is not a split: Yahoo lists no split and the closes match. It was a +177 % close-to-close move on about 46× the previous day's volume.
- **SNDK and GEV:** Nasdaq's `stockType` still carries a stale "When-Issued" label from their spin-offs; both traded regular-way all year.

## 10. Notes on the existing 25

**WBD is no longer listed:**
- the Nasdaq API answers "Symbol not exists";
- it is absent from the 10-15 screener;
- Tiingo's endDate is 2026-10-07;
- Yahoo returns only a single bar, for 2026-10-05.

Web results report an acquisition closing around 2026-10-06, but the acquirer is not confirmed: SEC proxy filings describe a Netflix merger, while one article claims Skydance. Without WBD the universe has **99 tradable names**. If a replacement is wanted, the next R1 name is ABT (#76).

Overall ranks of the other 24, for information: NVDA 1, MU 2, TSLA 3, MSFT 5, AAPL 6, AMD 7, AMZN 8, META 9, GOOGL 10, INTC 11, PLTR 15, MSTR 29, QCOM 34, CSCO 45, BAC 48, SMCI 77, UBER 78, T 95, SOFI 99, PFE 108, PYPL 146, F 162, MARA 262, RIVN 277.

## 11. Files

| File | Content |
|---|---|
| `us_new75.csv` | The final 75 (new_rank, symbol, tiingo_ticker, name, exchange, security_class, sessions_2026, first_trade_date_2026, est_close_usd, est_typical_usd, tiingo_row_summary, ticker_reuse_flag, corporate_action_notes, plus overall_rank, typical rank, tiingo flags) |
| `us_ranked_pool.csv` | All 2,931 pool symbols with metrics, class, exchange, Tiingo rows and flags, and ranks under every scenario (overall, R1, R2, R1+NYRS, R2+NYRS, typical) |
| `us_preliminary_diff.csv` | Preliminary 75 + alternates + new names: kept, dropped, promoted or added, with reason and % vs cutoff |
| `us_sources_fetch_log.csv` | Every source, URL pattern, fetch time (UTC), result and use |
| `supporting/` | Two-source cross-check (`crosscheck_yahoo.csv`, `second_source_check.json`), calendar / gainbot / preliminary checks (`checks.json`), scenario summary (`summary.json`), parsed gainbot table, hand corporate-action notes |
| `scripts/` | Pipeline, stdlib Python 3.12, run with `python3 -I` |
| `raw-cache.tar.xz` | **Partial** raw cache (3.4 MB). Contains the screener snapshots, the Tiingo zip, gainbot HTML, Nasdaq info JSON, Yahoo JSON, and Nasdaq history for the 600 highest-EST symbols plus all named lists. The full cache is 9.7 MB, over the 5 MB limit; the omitted histories all rank below #600 (EST < $42.4bn) and can be fetched again with `02_fetch_nasdaq_history.py`. |

## 12. Reproduce

Run from a directory containing `raw/` (downloads) and `work/` (intermediates), kept separate from `scripts/`:

```
python3 -I scripts/01_build_pool.py raw work                  # needs raw/screener/*.json, raw/gainbot/ytd_active.html
python3 -I scripts/02_fetch_nasdaq_history.py work/pool.csv raw/nasdaq_hist work/us_sources_fetch_log.csv
python3 -I scripts/04_metrics.py work/pool.csv raw/nasdaq_hist work/metrics.csv
python3 -I scripts/06_fetch_nasdaq_info.py work/metrics.csv raw/nasdaq_info work/us_sources_fetch_log.csv 600 work/pool.csv
python3 -I scripts/03_fetch_yahoo.py raw/yahoo work/us_sources_fetch_log.csv <symbols…>   # second source
cp supporting/corporate_actions_manual.csv work/
python3 -I scripts/07_rank_report.py work raw out
python3 -I scripts/05_crosscheck_yahoo.py raw/nasdaq_hist raw/yahoo work/crosscheck_yahoo.csv
python3 -I scripts/08_checks.py work raw out/us_ranked_pool.csv
python3 -I scripts/09_second_source_rank_check.py out/us_ranked_pool.csv raw/yahoo work/second_source_check.json
```

The screener, Tiingo zip and gainbot pages were downloaded with curl and a browser User-Agent; the URLs are in the fetch log. Requests were paced at no more than about 3 per second, with exponential backoff on 429/5xx responses.
