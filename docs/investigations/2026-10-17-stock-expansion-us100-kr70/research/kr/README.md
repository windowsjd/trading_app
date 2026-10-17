# KR 70 — 2026 YTD KRX trading-value ranking (KOSPI + KOSDAQ)

Research output, 2026-10-17 (Sat). Read-only study: no application code, database or Redis was touched.

- **Basis (ACTUAL):** per stock, the sum of daily KRX trading value (거래대금, KRW) over every KRX session from
  **2026-01-02 to 2026-10-16** (192 sessions per the app calendar `backend/src/orders/market-calendar/data/krx-2026.ts`).
  Daily values are `acml_tr_pbmn` from KIS Open API 국내주식기간별시세 (`FHKST03010100`) with
  `FID_COND_MRKT_DIV_CODE=J` (KRX only). No NXT (Nextrade) value is included; this was verified (§3.1).
- **Estimate (prefilter only):** Σ Naver close × Naver volume over the same window. Estimates appear only in
  the columns named `*estimate*` and were never used for the ranking.
- **Universe:** KOSPI and KOSDAQ common stocks in the KRX KIND listed-company lists (829 + 1,819 = 2,648 companies).
  ETF/ETN, preferred shares and leveraged products are not in these lists. Halted or non-tradable stocks were
  excluded, and SPAC/REIT/listed funds as well (§4). No adjustment for sector, recognition or recent liquidity.

## 1. Result

- The cutoff (#55 new) is **298380 ABL Bio, 17.854 tn KRW**. #56 Koh Young Technology is **54.3 bn below it (0.30 %)**.
  This is the only close call; #57 is 331 bn below.
- **Final 70 = existing 15 + new 55 = KOSPI 54 / KOSDAQ 16.**
  KOSCOM price batches = ceil(54/20) + ceil(16/20) = 3 + 1 = **4** (same count as the 10-15 study's 59/11 split).
- In the overall YTD ranking, 14 of the existing 15 are in the top 69. HLB (028300) is #136 (9.474 tn). The final 70
  is therefore the overall top 69 plus HLB.
- **Compared with the preliminary 55:** 39 kept, 16 dropped, 16 added (§1.4, `kr_preliminary_diff.csv`).

### 1.1 New 55 (ranked by ACTUAL 2026 YTD KRX trading value)

| New # | Overall # | Code | Name (KO) | Name (EN, app-style) | Market | YTD actual (KRW tn) | Sessions | In 10-15 prelim |
|---:|---:|---|---|---|---|---:|---:|:---:|
| 1 | 3 | 009150 | 삼성전기 | Samsung Electro-Mechanics | KOSPI | 193.311 | 192/192 | yes |
| 2 | 5 | 402340 | SK스퀘어 | SK Square | KOSPI | 153.183 | 192/192 | yes |
| 3 | 7 | 006400 | 삼성SDI | Samsung SDI | KOSPI | 68.218 | 192/192 | yes |
| 4 | 9 | 042700 | 한미반도체 | Hanmi Semiconductor | KOSPI | 64.321 | 192/192 | yes |
| 5 | 10 | 047040 | 대우건설 | Daewoo Engineering & Construction | KOSPI | 63.172 | 192/192 | yes |
| 6 | 12 | 036930 | 주성엔지니어링 | Jusung Engineering | KOSDAQ | 57.975 | 192/192 | yes |
| 7 | 13 | 010170 | 대한광통신 | Taihan Fiberoptics | KOSDAQ | 55.336 | 192/192 | no |
| 8 | 14 | 012450 | 한화에어로스페이스 | Hanwha Aerospace | KOSPI | 55.237 | 192/192 | yes |
| 9 | 15 | 012330 | 현대모비스 | Hyundai Mobis | KOSPI | 46.830 | 192/192 | yes |
| 10 | 18 | 032820 | 우리기술 | Woori Technology | KOSDAQ | 41.421 | 192/192 | no |
| 11 | 19 | 011070 | LG이노텍 | LG Innotek | KOSPI | 40.973 | 192/192 | yes |
| 12 | 20 | 080220 | 제주반도체 | Jeju Semiconductor | KOSDAQ | 40.343 | 192/192 | no |
| 13 | 22 | 001440 | 대한전선 | Taihan Cable & Solution | KOSPI | 39.297 | 192/192 | yes |
| 14 | 23 | 105560 | KB금융 | KB Financial Group | KOSPI | 39.034 | 192/192 | yes |
| 15 | 24 | 006800 | 미래에셋증권 | Mirae Asset Securities | KOSPI | 38.299 | 192/192 | no |
| 16 | 25 | 079550 | LIG디펜스앤에어로스페이스 | LIG Defense & Aerospace | KOSPI | 38.140 | 192/192 | yes |
| 17 | 26 | 196170 | 알테오젠 | Alteogen | KOSDAQ | 38.130 | 192/192 | yes |
| 18 | 27 | 329180 | HD현대중공업 | HD Hyundai Heavy Industries | KOSPI | 37.364 | 192/192 | yes |
| 19 | 28 | 010120 | 엘에스일렉트릭 | LS ELECTRIC | KOSPI | 36.421 | 192/192 | yes |
| 20 | 29 | 028260 | 삼성물산 | Samsung C&T | KOSPI | 36.194 | 192/192 | yes |
| 21 | 30 | 403870 | HPSP | HPSP | KOSDAQ | 35.181 | 192/192 | yes |
| 22 | 31 | 272210 | 한화시스템 | Hanwha Systems | KOSPI | 33.513 | 192/192 | yes |
| 23 | 32 | 009830 | 한화솔루션 | Hanwha Solutions | KOSPI | 33.337 | 192/192 | yes |
| 24 | 33 | 005490 | POSCO홀딩스 | POSCO Holdings | KOSPI | 32.771 | 192/192 | yes |
| 25 | 34 | 373220 | LG에너지솔루션 | LG Energy Solution | KOSPI | 31.715 | 192/192 | yes |
| 26 | 35 | 000720 | 현대건설 | Hyundai Engineering & Construction | KOSPI | 31.446 | 192/192 | yes |
| 27 | 36 | 298040 | 효성중공업 | Hyosung Heavy Industries | KOSPI | 31.013 | 192/192 | no |
| 28 | 37 | 267260 | HD현대일렉트릭 | HD Hyundai Electric | KOSPI | 30.237 | 192/192 | yes |
| 29 | 38 | 475150 | SK이터닉스 | SK eternix | KOSPI | 28.767 | 192/192 | no |
| 30 | 40 | 064350 | 현대로템 | Hyundai Rotem | KOSPI | 26.882 | 192/192 | yes |
| 31 | 41 | 007660 | 이수페타시스 | ISU Petasys | KOSPI | 26.527 | 192/192 | yes |
| 32 | 42 | 055550 | 신한지주 | Shinhan Financial Group | KOSPI | 26.259 | 192/192 | yes |
| 33 | 43 | 240810 | 원익IPS | Wonik IPS | KOSDAQ | 26.080 | 192/192 | yes |
| 34 | 44 | 000150 | 두산 | Doosan Corp. | KOSPI | 24.535 | 192/192 | yes |
| 35 | 46 | 278470 | 에이피알 | APR | KOSPI | 24.317 | 192/192 | yes |
| 36 | 47 | 090710 | 휴림로봇 | Hyulim Robot | KOSDAQ | 24.123 | 192/192 | no |
| 37 | 48 | 032830 | 삼성생명 | Samsung Life Insurance | KOSPI | 23.992 | 192/192 | yes |
| 38 | 49 | 000250 | 삼천당제약 | Sam Chun Dang Pharm | KOSDAQ | 23.747 | 192/192 | no |
| 39 | 50 | 006340 | 대원전선 | Dawon Cable | KOSPI | 23.665 | 192/192 | no |
| 40 | 51 | 277810 | 레인보우로보틱스 | Rainbow Robotics | KOSDAQ | 23.266 | 192/192 | no |
| 41 | 52 | 353200 | 대덕전자 | Daeduck Electronics | KOSPI | 22.944 | 192/192 | yes |
| 42 | 53 | 017670 | SK텔레콤 | SK Telecom | KOSPI | 22.893 | 192/192 | yes |
| 43 | 54 | 034730 | SK | SK Inc. | KOSPI | 22.870 | 192/192 | yes |
| 44 | 55 | 015760 | 한국전력공사 | Korea Electric Power Corporation (KEPCO) | KOSPI | 22.755 | 192/192 | yes |
| 45 | 57 | 047810 | 한국항공우주 | Korea Aerospace Industries | KOSPI | 21.457 | 192/192 | no |
| 46 | 58 | 322000 | HD현대에너지솔루션 | HD Hyundai Energy Solutions | KOSPI | 20.965 | 192/192 | no |
| 47 | 59 | 064400 | LG씨엔에스 | LG CNS | KOSPI | 20.854 | 192/192 | no |
| 48 | 60 | 086790 | 하나금융지주 | Hana Financial Group | KOSPI | 20.490 | 192/192 | yes |
| 49 | 61 | 307950 | 현대오토에버 | Hyundai AutoEver | KOSPI | 20.418 | 192/192 | no |
| 50 | 63 | 028050 | 삼성E&A | Samsung E&A | KOSPI | 19.992 | 192/192 | yes |
| 51 | 65 | 454910 | 두산로보틱스 | Doosan Robotics | KOSPI | 18.687 | 192/192 | no |
| 52 | 66 | 096770 | SK이노베이션 | SK Innovation | KOSPI | 18.593 | 192/192 | yes |
| 53 | 67 | 108490 | 로보티즈 | ROBOTIS | KOSDAQ | 18.242 | 192/192 | yes |
| 54 | 68 | 058470 | 리노공업 | Leeno Industrial | KOSDAQ | 18.180 | 192/192 | yes |
| 55 | 69 | 298380 | 에이비엘바이오 | ABL Bio | KOSDAQ | 17.854 | 192/192 | no |

### 1.2 Next 5 below the cutoff

| New # | Overall # | Code | Name (KO) | Name (EN) | Market | YTD actual (KRW tn) | Gap to #55 (KRW bn) |
|---:|---:|---|---|---|---|---:|---:|
| 56 | 70 | 098460 | 고영 | Koh Young Technology | KOSDAQ | 17.799 | -54.3 |
| 57 | 71 | 009540 | HD한국조선해양 | HD Korea Shipbuilding & Offshore Engineering | KOSPI | 17.523 | -331.0 |
| 58 | 72 | 100790 | 미래에셋벤처투자 | Mirae Asset Venture Investment | KOSDAQ | 17.422 | -431.7 |
| 59 | 73 | 089030 | 테크윙 | Techwing | KOSDAQ | 17.217 | -636.7 |
| 60 | 74 | 207940 | 삼성바이오로직스 | Samsung Biologics | KOSPI | 17.149 | -704.6 |

### 1.3 Existing 15 (context, overall YTD rank)

| Overall # | Code | Name (KO) | Name (EN) | Market | YTD actual (KRW tn) |
|---:|---|---|---|---|---:|
| 1 | 000660 | SK하이닉스 | SK Hynix | KOSPI | 1,434.824 |
| 2 | 005930 | 삼성전자 | Samsung Electronics | KOSPI | 1,286.951 |
| 4 | 005380 | 현대자동차 | Hyundai Motor | KOSPI | 155.903 |
| 6 | 034020 | 두산에너빌리티 | Doosan Enerbility | KOSPI | 81.346 |
| 8 | 066570 | LG전자 | LG Electronics | KOSPI | 64.834 |
| 11 | 035420 | NAVER | NAVER | KOSPI | 62.755 |
| 16 | 086520 | 에코프로 | Ecopro | KOSDAQ | 45.967 |
| 17 | 042660 | 한화오션 | Hanwha Ocean | KOSPI | 41.450 |
| 21 | 000270 | 기아 | Kia | KOSPI | 39.900 |
| 39 | 010140 | 삼성중공업 | Samsung Heavy Industries | KOSPI | 26.925 |
| 45 | 068270 | 셀트리온 | Celltrion | KOSPI | 24.515 |
| 56 | 247540 | 에코프로비엠 | Ecopro BM | KOSDAQ | 21.740 |
| 62 | 035720 | 카카오 | Kakao | KOSPI | 20.025 |
| 64 | 051910 | LG화학 | LG Chem | KOSPI | 19.850 |
| 136 | 028300 | HLB | HLB | KOSDAQ | 9.474 |

### 1.4 Differences from the preliminary 55

The preliminary list ranked by a 20-session median and applied recognition, share-volume, warning and diversity
gates. This study ranks by YTD actual value only, so the differences follow from the method, not from data errors.
Each row in `kr_preliminary_diff.csv` gives the YTD rank, the gap to the cutoff, the 10-15 reason (where that study
listed the stock), the last-20-session median (KIS actual) and the Jan–Jun share of YTD value.

- **Dropped (16, all eligible, all below the cutoff on YTD value):** 009540 HD Korea Shipbuilding & Offshore
  Engineering (#57, 17.52 tn); 066970 L&F (#66, 16.40 tn); 222800 Simmtech (#68, 16.07 tn); 316140 Woori Financial
  Group (#69, 15.94 tn); 067310 Hana Micron (#70, 15.91 tn); 003670 POSCO Future M (#71, 15.77 tn); 352820 HYBE (#72,
  15.75 tn); 000810 Samsung Fire & Marine Insurance (#78, 14.74 tn); 062040 Sanil Electric (#80, 14.57 tn); 010060 OCI
  Holdings (#81, 14.47 tn); 000990 DB HiTek (#82, 14.00 tn); 010950 S-Oil (#85, 13.96 tn); 003490 Korean Air (#86,
  13.87 tn); 128940 Hanmi Pharmaceutical (#93, 12.42 tn); 071050 Korea Investment Holdings (#97, 11.92 tn);
  033780 KT&G (#113, 9.92 tn). HYBE, Korea Investment Holdings and KT&G were diversity picks in the 10-15 list.
  Hyundai Rotem and KEPCO were also diversity picks but rank #30 and #44 on YTD value, so they stay.
- **Added (16):** 010170 Taihan Fiberoptics (#7); 032820 Woori Technology (#10); 080220 Jeju Semiconductor (#12);
  006800 Mirae Asset Securities (#15); 298040 Hyosung Heavy Industries (#27); 475150 SK eternix (#29); 090710 Hyulim
  Robot (#36); 000250 Sam Chun Dang Pharm (#38); 006340 Dawon Cable (#39); 277810 Rainbow Robotics (#40); 047810 Korea
  Aerospace Industries (#45); 322000 HD Hyundai Energy Solutions (#46); 064400 LG CNS (#47); 307950 Hyundai AutoEver
  (#49); 454910 Doosan Robotics (#51); 298380 ABL Bio (#55). Five were excluded by a 10-15 gate:
  Taihan Fiberoptics (recognition/spike), Jeju Semiconductor (warning pre-notice), Mirae Asset Securities (median gate),
  Hyosung Heavy Industries (share-volume gate) and SK eternix (fading liquidity). The other 11 were not in any 10-15
  CSV. Most of them traded heavily in H1 (Jan–Jun share 65–97 %), and their recent 20-session medians rank #80–#131
  among new names.

## 2. Method

1. **Sessions.** I counted weekdays from 2026-01-02 to 2026-10-16 minus the full-day closures in `krx-2026.ts`,
   which gives 192 sessions. Every shortlist stock's KIS row dates were compared with this list.
2. **Membership and status (KRX KIND, fetched 2026-10-17 07:58Z).** Sources were the corp-list downloads
   (`marketType=stockMkt|kosdaqMkt`, EUC-KR) for market, listing date and industry, plus the status lists: current
   trading halts, administrative issues, investment caution (2026, in four chunks because of the 3,000-row cap),
   investment warning and risk (2026, current when 해제일 = "-"), delisting substantive reviews (2025-01-01..) and
   KOSDAQ 투자주의환기종목 (matched by name). The POST parameters are in `kr_sources_fetch_log.csv` and
   `scripts/fetch_public.py`.
3. **Instrument typing (Naver snapshot, 2026-10-16 close).** The snapshot has 4,308 instruments: 2,764 `stock`,
   1,176 `etf` and 368 `etn`. The 116 `stock` instruments that are not in KIND are 114 preferred shares and 2
   fund share classes. All 2,648 KIND codes are in the snapshot. Its `tradableStatus` and `tradeStopType` were
   used as a second halt check (both agree with KIND: 111 halted).
4. **Prefilter (ESTIMATE).** I took Naver `fchart` daily rows (`count=250`) for all 2,648 companies and summed close ×
   volume over the window. The shortlist is the top 150 by estimate plus the preliminary 55, the 10-15 alternates
   and the existing 15. That is 155 codes, because only 5 alternates fell outside the top 150.
5. **ACTUAL (KIS).** `GET /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`, tr_id `FHKST03010100`,
   `custtype P`, `FID_COND_MRKT_DIV_CODE=J`, `FID_PERIOD_DIV_CODE=D`, `FID_ORG_ADJ_PRC=0`. Each stock got two windows,
   20260101–20260522 (95 sessions) and 20260523–20261016 (97), each under the 100-row cap. Blank padding rows were
   dropped. One access token was issued at 08:12:20Z and reused. There were 318 calls in 92 s, paced at
   ≤ 3.3 req/s, with zero rate-limit responses and 155/155 stocks complete.
   `ytd_actual_krw = Σ acml_tr_pbmn` over rows dated 2026-01-02..2026-10-16.
6. **Ranking.** Eligible stocks were sorted by `ytd_actual_krw`. `rank` is the overall rank (existing 15 included);
   `new_rank` counts only non-existing stocks. The new 55 are `new_rank` 1–55.

## 3. Data-source status and cross-checks

### 3.1 KIS market J excludes NXT (checked)

For 005930, 000660 and 009150 on 2026-10-13..16 (12 stock-days) I also fetched `UN` (combined) and `NX` (NXT only).
In all 12 cases **J + NX = UN exactly**, to the won and to the share. NXT is large in 2026: NX/J value was 0.43–0.94
on those days (Samsung Electronics 10-16: J 4,084.9 bn, NX 2,918.4 bn, UN 7,003.3 bn). Mixing in NXT would therefore
inflate these names by 43–94 %, and the ranking uses J only.

### 3.2 Other checks

| Check | Result |
|---|---|
| KRX data portal (`data.krx.co.kr`, MDCSTAT01501, one probe) | **HTTP 400 `LOGOUT`**, login required; still gated, as on 10-15 |
| KIS 2026-10-16 value vs Naver snapshot value (155 stocks) | 134 equal within Naver's 1 M KRW rounding. 21 have KIS higher by 0.06–22.1 %, the same 21 whose 10-16 volume differs. The missing trades have implied prices within 2.9 % of the 10-16 KRX close, consistent with late KRX trades (off-hours / block) that Naver's same-day snapshot had not absorbed |
| KIS vs Naver fchart **volume**, every day, 155 stocks (29,675 stock-days) | 29,258 exact (98.6 %). The 21 differences on 2026-10-16 are the latest-day effect above. 396 differences are ≤ 14 shares, on pre-adjustment days of 12 stocks with corporate actions (adjusted-volume rounding). There are no other differences, so Naver's finalized history and KIS J are the same KRX daily totals |
| KIS vs Naver fchart **close** | 2,980 stock-days differ (10.0 %). For NXT-traded stocks Naver's close is the integrated KRX+NXT last price: it equals the KIS `UN` close on 10/12 check days and is within 1 tick on the other 2. Only the estimate uses it |
| `acml_tr_pbmn` vs price-adjustment flag | For 010170 and 006800, which have KIS adjustment markers, 95 days were re-fetched with `FID_ORG_ADJ_PRC=1`. Trading value was identical on all 190 days, although adjusted close differed on 4 and 47 days |
| Estimate / actual YTD (155 stocks) | median 0.9993, range 0.9733–1.0159 |
| Shortlist completeness | The highest estimate outside the shortlist is 8.194 tn (046970, estimate rank 151). Even ×1.0275, the largest actual/estimate ratio seen, it is < 8.5 tn, under half the 17.854 tn cutoff, so no omitted eligible stock can reach the cutoff |
| Session coverage | All 155 have KIS rows for every expected session (192; 107 for the 2026-05-11 listing) and none on non-calendar dates. 13 stocks have zero-volume (halt) days. In the new 55 these are LS ELECTRIC (2026-04-08..10, 3 days; adjusted series around it, consistent with a corporate-action re-registration halt, reason not verified) and Hyulim Robot (01-20 and 01-22, during its January 투자경고/투자위험 period) |
| Code changes | Every final-70 code has a full 192-session KIS series under its current code, KIS echoed the requested code for all 155, and all 10-15 study codes are unchanged in today's KIND lists. No code change affects the window |

## 4. Flagged categories: decisions

| Category (KIND/Naver, whole universe) | Decision | Effect on the result |
|---|---|---|
| SPAC (68) | Excluded: blank-check shells, not operating common stocks | None. Highest estimate is 0.85 tn (rank 712) |
| REIT (23) and listed funds (3: 맥쿼리인프라, KB발해인프라, 맵스리얼티) | Excluded: investment vehicles | None. Highest is 맥쿼리인프라 at 3.39 tn est. (rank 284) |
| Foreign issuers, codes 9xxxxx (22; DR/KDR or direct) | Kept eligible but flagged; a product decision would be needed if one made the cut | None. Highest is 950160 Kolon TissueGene, actual rank #128 (9.912 tn) |
| Listed during 2026 (55) | Eligible, with YTD counted since listing | None. Highest is 439960 Cosmo Robotics (listed 05-11): 13.997 tn over 107 sessions, rank #97 |
| Halted now (111), 관리종목 (175), 투자경고/위험 now (19), 환기종목 (86), 실질심사 record (72) | Halted/non-tradable excluded; the others flagged | None. No flagged stock ranks above #91. That is 440110 FADU (14.745 tn), with a delisting-review record (2025-12-19) and 22 zero-volume days in Jan 2026 |
| 2026 warning/caution history (no current designation) | Not an exclusion criterion; recorded in `status_checks` | 9 of the new 55 had a 2026 투자경고 period: Daewoo E&C, Jusung, Taihan Fiberoptics ×4, Woori Technology ×3, Jeju Semiconductor, Wonik IPS ×2, Hyulim Robot ×3 plus 투자위험, Dawon Cable, Daeduck Electronics. Jeju Semiconductor also got a 투자경고 **지정예고** (pre-notice) on 2026-10-07 |

## 5. Caveats and what could not be verified

1. **No official KRX file.** The KRX portal is login-gated, so the values come from the KIS feed, a licensed broker
   relay of KRX data. They are corroborated by Naver (§3.2) but were not reconciled against a KRX download.
2. **Narrow cutoff.** ABL Bio (#55) leads Koh Young (#56) by 54.3 bn KRW (0.30 %). The *estimate* ordering would swap
   them. The exact values put ABL Bio first; an official source would have to differ from KIS by more than 0.3 % on
   these two stocks to flip it.
3. **Recent liquidity of YTD qualifiers.** YTD rewards stocks that traded heavily earlier in the year. 10 of the new
   55 have a last-20-session median below 30 bn KRW/day (the 10-15 study's gate) and 6 are below 20 bn. The thinnest
   is Hyulim Robot: 7.0 bn, with 97 % of its YTD value in Jan–Jun. No adjustment was made, per the product rule.
   For these names the 10-15 study's per-second trade and ER assumptions for KOSCOM collection are unproven
   (`median20_actual_krw`, `h1_share_of_ytd` columns).
4. **Status is a snapshot** taken 2026-10-17 around 17:00 KST. Recheck halts and designations right before activation.
5. **English names.** The existing 15 use the app's names. 44 of the new 55 reuse the 10-15 CSVs' `name_en`. The
   other 11 were cleaned by hand from the official KRX English name (engkind company summary; `name_en_official`
   column). For 대원전선 the official KRX spelling, "Dawon Cable", is kept.
6. **Credentials.** The production KIS keys were read at runtime only. A scan of all 3,168 written files and the
   archive found none of the key, secret or token strings.

## 6. Reproduce

Scripts are in `scripts/`. Run them with `python3 -I -B`, with the raw downloads in their own directory, in this order:

```
fetch_public.py kind|krx-probe|naver-snap RAW WORK        # KIND lists, KRX probe, Naver snapshot
build_universe.py RAW WORK                                 # universe.json, flags
fetch_public.py fchart RAW WORK WORK/fchart_codes.txt      # Naver daily OHLCV (estimate input)
estimate_shortlist.py RAW WORK REPO_ROOT 150               # estimates.json, shortlist.tsv (ESTIMATE)
fetch_kis.py backend/.env.local RAW WORK WORK/shortlist.tsv scripts/kis_checks.json   # ACTUAL (1 token)
fetch_public.py engkind RAW WORK WORK/engkind_codes.txt    # English names for uncovered codes
fetch_public.py engkind-list RAW WORK
analyze.py RAW WORK REPO_ROOT OUT                          # CSVs
write_fetch_log.py WORK OUT
```

`scripts/kis_checks.json` lists the six J/UN/NX comparison calls (005930, 000660, 009150 × UN, NX for 20261013–20261016).

## 7. Files

| File | Content |
|---|---|
| `kr_new55.csv` | Final new 55 with status checks and notes |
| `kr_ranked_shortlist.csv` | All 155 shortlist stocks: ranks, actual and estimate, 10-16 cross-check, fchart mismatch counts, flags, status checks, last-20-session median, H1 share |
| `kr_preliminary_diff.csv` | Preliminary 55 vs final: kept / dropped / added, with reasons |
| `kr_sources_fetch_log.csv` | Every fetch, including probes, the superseded first KIND run, the KIS token/calls and the KRX portal probe |
| `kr_raw_cache.tar.xz` (2.7 MB) | Raw KIND (EUC-KR), Naver snapshot, KIS responses and checks, engkind, Naver fchart for the 155 shortlist codes, plus derived JSON (`universe.json`, `estimates.json` for all 2,648 companies, `kis_daily.json`, call logs, `analysis_summary.json`). The full fchart set (6.1 MB compressed) is not included |
| `scripts/` | The scripts above (no embedded credentials) |

Column notes for `kr_ranked_shortlist.csv`:

- `kis_vs_naver_1016_diff` is KIS J minus the Naver snapshot, in KRW; Naver rounds to 1 M KRW.
- `status_flags` holds only current-state flags. Each 2026 designation history is in `status_checks`.
- `fchart_close_mismatch_days` mostly reflects Naver's integrated close (§3.2) and is not an error in the KIS data.
