# Binance Spot 100 + USDⓈ-M 100 — 2026 YTD selection (2026-10-16)

The fixed Spot universe (`BINANCE_FIXED_ASSET_UNIVERSE`) and the offered
USDⓈ-M catalog (`BINANCE_FUTURES_SYMBOLS`) are 100 entries each. The previous
25 of each are kept unchanged, in order; 75 are appended to each by 2026 YTD
cumulative quote volume. Full rankings, exclusions, evidence and verification:
[investigation report](../../docs/investigations/2026-10-16-binance-crypto-100/report.md).

## Rule

- Window: `2026-01-01T00:00:00Z <= openTime < 2026-10-16T00:00:00Z`, 288
  completed UTC daily bars, the last completed day before the research started
  (2026-10-16 06:36Z). **2026 YTD, not annualized**; late listings count only
  their real bars.
- Measure: `SUM(1d kline[7])`, the quote asset volume in USDT, from the
  official Spot `/api/v3/klines` and USDⓈ-M `/fapi/v1/klines`; Prisma Decimal
  precision 80 with an independent BigInt fixed-point check, then a second,
  independent Python Decimal recomputation of every series. No 24h ticker,
  Mark, open interest or USD/KRW conversion.
- Candidates: every currently tradable USDT Spot market (511) and every USDT
  perpetual with USDT margin (525). All series complete (no gaps, no
  duplicates); final `exchangeInfo` re-validated every candidate.
- Ties: symbol code-point order (none near either boundary).
- Product policy (unchanged from the 2026-09 Spot and 2026-10-11 Futures
  research): exclude stablecoins, fiat, wrapped/staked representations
  (WBTC, WBETH, BNSOL), commodity-pegged tokens, tokenized stocks/ETFs
  (`bStocks`), leveraged/derivative tokens; never exclude by category (meme,
  DeFi, L1/L2, AI). Spot symbols must be `BASE+USDT` in the app's charset (Han
  allowed). A Futures contract must pass the existing `parseFuturesContracts`
  identity (ASCII `BASE+USDT`, COIN, PERPETUAL, TRADING, USDT/USDT) and have
  an exact TRADING Spot pair with the same symbol and base asset; no
  `1000x` multiplier or alias mapping. Prices must fit `DECIMAL(24,8)`
  (tick ≤ 8 decimals).

## Result

Spot: 396 of 511 eligible; boundary MARSCOINUSDT (policy rank 100,
1,030,805,408.78 USDT) vs MUBARAKUSDT (1,020,570,897.25). The 75 additions,
in order:

`PUMPUSDT XPLUSDT AAVEUSDT BCHUSDT DASHUSDT REUSDT SENTUSDT ONDOUSDT FETUSDT
PENGUUSDT HBARUSDT FILUSDT ARBUSDT ZAMAUSDT WLFIUSDT FOGOUSDT ICPUSDT DOTUSDT
KITEUSDT OPNUSDT APTUSDT VIRTUALUSDT ALLOUSDT INJUSDT ZROUSDT RENDERUSDT
BONKUSDT SHIBUSDT BANKUSDT GIGGLEUSDT DEXEUSDT POLUSDT QNTUSDT BARDUSDT WIFUSDT
TUTUSDT AXSUSDT MEGAUSDT SEIUSDT ENSOUSDT BREVUSDT ORDIUSDT STRKUSDT STOUSDT
ZENUSDT SAHARAUSDT OPUSDT BABYUSDT BIOUSDT ROBOUSDT CHZUSDT TIAUSDT SPKUSDT
GRAMUSDT PYTHUSDT LUNCUSDT PENDLEUSDT CRVUSDT PROMUSDT PLUMEUSDT ETHFIUSDT
AEROUSDT SAGAUSDT ACEUSDT CAKEUSDT HOMEUSDT SYNUSDT ZKPUSDT LDOUSDT JTOUSDT
EIGENUSDT ALGOUSDT ARUSDT BERAUSDT MARSCOINUSDT`

PUMPUSDT, AAVEUSDT, BCHUSDT and FILUSDT were Futures-only underlyings; the
Spot ranking selected them, so they are now Spot assets with their existing
asset IDs (no new row, no change to their Futures contracts).

USDⓈ-M: 351 of 525 eligible; boundary SAGAUSDT (policy rank 100,
5,434,224,403.11 USDT) vs BICOUSDT (5,349,682,658.13). The 75 additions, in
order:

`DASHUSDT ONDOUSDT DOTUSDT ARBUSDT BANKUSDT PENGUUSDT AXSUSDT XPLUSDT WLFIUSDT
TRXUSDT QNTUSDT INJUSDT WIFUSDT FETUSDT HBARUSDT ENSOUSDT CHIPUSDT APTUSDT
ALLOUSDT VIRTUALUSDT STOUSDT ICPUSDT LSKUSDT OPUSDT DEXEUSDT CRVUSDT ORDIUSDT
ZROUSDT TUTUSDT BERAUSDT REUSDT SYNUSDT STRKUSDT TIAUSDT ETCUSDT SANDUSDT ACEUSDT
RENDERUSDT JTOUSDT DUSKUSDT ORCAUSDT NOMUSDT KITEUSDT GIGGLEUSDT BIOUSDT
SAHARAUSDT MOVRUSDT SENTUSDT POLUSDT SEIUSDT HOMEUSDT HEIUSDT GALAUSDT ATOMUSDT
OPNUSDT ZENUSDT ENJUSDT CHZUSDT LDOUSDT ZAMAUSDT KAITOUSDT ESPUSDT PROMUSDT
EDENUSDT NILUSDT PIXELUSDT ONGUSDT MARSCOINUSDT ALGOUSDT 0GUSDT ETHFIUSDT
PENDLEUSDT ZBTUSDT ONTUSDT SAGAUSDT`

Futures-only underlyings (`BINANCE_FUTURES_ONLY_ASSETS`, never Spot): HYPE
(since 2026-10-11) and LSK, ETC, SAND, DUSK, ORCA, NOM, MOVR, HEI, GALA, ATOM,
ENJ, KAITO, ESP, EDEN, NIL, PIXEL, ONG, 0G, ZBT, ONT. Display decimals come from
the FAPI `PRICE_FILTER` in `FUTURES_DISPLAY_DECIMALS` (fresh exchangeInfo stays
preferred). All 25 + 25 existing entries are still TRADING and policy-eligible;
none was removed or edited. Observation, not changed: the ASTERUSDT Spot
fallback tick is `0.001` while Binance now lists `0.0001` (live metadata wins
at runtime; only a metadata outage shows 3 decimals).

## Registration and activation (production — not performed)

Deploying the code alone adds no product rows. Order:

1. Deploy (migration `20261016200000` is additive: two empty tables, one Ops
   job name). Check `BINANCE_CRYPTO_SYMBOLS` is unset or blank on every
   instance: a pinned list keeps the ticker socket on that list. At deploy, the
   Spot ticker socket already subscribes all 100, and PUMP/AAVE/BCH/FIL become
   Spot-visible (their rows exist); run their Spot candle backfill (step 3)
   right away.
2. Spot: `node --import tsx scripts/seed-binance-fixed-asset-universe.ts`
   (dry-run: 71 create, 29 unchanged), then `--apply` (one transaction, live
   exchangeInfo validation of all 100 first). Ticker snapshots start within
   30 s (asset mapping TTL). **Restart the service once**: depth10 targets are
   read when the Spot socket connects.
3. Spot candles for the new assets: `scripts/candle-baseline-sync.ts --apply
   --days 365 --target 1d --target 1w --asset-id …` and `--days 35 --target 5m`,
   then the long-range 4h backfill ([long-range-4h-candles.md](long-range-4h-candles.md)).
   Cold seeding ≈ 2,600 REST weight, paced by the shared coordinator; run it
   outside busy periods. The 5m baseline costs about 22 weight per asset and
   initial mode re-fetches feeds that are already complete, so one invocation
   with all 75 IDs spends every minute's budget on the same leading assets
   (verified locally at 600/min: no progress after 8 runs). Pass only the
   assets without complete 5m coverage, and keep each minute's backfill to at
   most half of the budget so Futures Last/Mark REST recovery keeps working
   (at 1200: about 25 assets a minute; at 600 the local run starved Last
   re-confirmation, gaps up to 90 s). 1d/1w for all 75 fits one run. A checkpoint left `running`
   by an interrupted run fails later runs with `ACTIVE_SYNC_EXISTS`; re-run
   those asset IDs with `--no-resume`.
4. Futures: `FUTURES_PROVISION_DRY_RUN_REDIS_URL=<loopback> pnpm
   futures:provision-instruments --dry-run` (expected: assets create 20,
   maintain 80; instruments create 75, maintain 25), then `--apply` with
   `FUTURES_PROVISION_EXPECTED_TARGET`. Last, Mark and book/ticker sockets pick
   up the new targets within 30 s and resubscribe by themselves.
5. Futures candles for the new contracts (futures candle sync / long-range 4h).
6. Verify: Spot list 100, Futures catalog 100, prices/books for a sample of new
   symbols, `/readiness` (`futuresMark.targets = 100`, no stale), REST budget.

Rollback: before the first user trade in a new product, revert the catalog
code (new contracts leave the Futures catalog and entry; open lifetimes keep
their Last/Mark) and deactivate the new Spot assets. After trades exist, Spot
deactivation blocks the holders' sells (no Spot sell-only mode) — a product
decision. The existing 25 + 25 rows, IDs, evidence and positions are never
touched by any of these steps.
