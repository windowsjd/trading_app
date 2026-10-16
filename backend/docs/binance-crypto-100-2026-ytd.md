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
none was removed or replaced. The only later edit is a fallback precision: the
ASTERUSDT Spot fallback tick moved from `0.001` (2026-09 research) to the
`0.0001` Binance lists since then (re-checked 2026-10-16; the other 99 Spot
fallbacks match `exchangeInfo`). The fallback is display-only and used only
while live metadata is unavailable; order and fill arithmetic never read it.

## Registration and activation (production — performed 2026-10-16)

Run against the Render service `srv-da84cg8u01pc73cjasa0` and its PostgreSQL 17
(100 GB disk) on 2026-10-16 UTC; the code was `27c74787`. Report:
[2026-10-16-crypto-100-production-rollout](../../docs/investigations/2026-10-16-crypto-100-production-rollout/report.md).
Order and results, for a later re-run or audit:

1. Deploy (migration `20261016200000` was applied with `3b4a7685` at 09:49Z;
   additive). `BINANCE_CRYPTO_SYMBOLS` is unset. At that deploy the Spot ticker
   socket subscribed all 100 and PUMP/AAVE/BCH/FIL became Spot-visible.
2. Service variables: `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE=1200`,
   `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`,
   `DATABASE_STORAGE_MONITOR_ENABLED=true`, `DATABASE_STORAGE_CAPACITY_GB=100`.
3. Spot: `node --import tsx scripts/seed-binance-fixed-asset-universe.ts`
   (dry-run 71 create / 29 unchanged), then `--apply` (100/100 validated against
   exchangeInfo, 71 created, verification 100/100). **Restart once** (a deploy):
   depth10 targets are read when the Spot socket connects (29 → 100).
4. Spot candles for the 75 additions (71 new + PUMP/AAVE/BCH/FIL):
   `scripts/candle-baseline-sync.ts --apply --days 365 --target 1d --target 1w
   --asset-id …` (150 feeds) and `--days 35 --target 5m` in batches of 15,
   re-running only feeds that did not complete (initial mode re-fetches complete
   feeds, so one invocation with all 75 IDs never finishes). Run the script with
   `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE=480 MARKET_CANDLE_SYNC_ASSET_CONCURRENCY=1`
   while the server runs at 1200: refused requests (`PROVIDER_CALL_FAILED`) are
   the backfill yielding to the server; Futures Last kept a maximum gap of
   7.1 s during the 12-minute 5m backfill
   ([binance-rest-limits.md](binance-rest-limits.md)). No Spot 4h backfill:
   long-range Spot/KRX 4h upkeep (`SCHEDULER_MARKET_CANDLE_LONG_SYNC_ENABLED`) is
   off in production, so the existing 25 have no native 4h rows either. Regular
   5m/1d/1w upkeep of every active Spot coin is the crypto reconciliation (300 s);
   `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS` was left unchanged. A checkpoint left
   `running` by an interrupted run fails later runs with `ACTIVE_SYNC_EXISTS`;
   re-run those asset IDs with `--no-resume`.
5. Futures: `FUTURES_PROVISION_DRY_RUN_REDIS_URL=<loopback> pnpm
   futures:provision-instruments --dry-run` (assets create 20 / maintain 80;
   instruments create 75 / maintain 25; blockers 0), then `--apply` with
   `FUTURES_PROVISION_EXPECTED_TARGET` (Spot assets and financial rows modified:
   0). Last, Mark and book/ticker sockets re-read the targets within 30 s
   (`futuresMark.targets` 25 → 100, stale 0).
6. Futures candles: before this rollout no contract had any
   `futures_market_candles` row (the futures chart showed its empty state).
   `scripts/candle-long-backfill.ts --market futures --apply` with the backfill
   budget (twice; the second run fetched only what the first left) stored the
   96-day 4h history of all 100 contracts (57,394 rows), then
   `SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED=true` keeps the last two days and the
   open bucket current (1 call per contract a minute, weight 1).
7. Order-book history: `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=true` and
   `CRYPTO_ORDER_BOOK_RETENTION_ENABLED=true` (one deploy). First 21 minutes:
   100 + 100 products tracked, 97.4 % of closed product-minutes stored, no
   duplicate, rejected or failed write; the retention job runs every 5 minutes.
8. Price retention on this database: the default 1000-row batches hit the fixed
   5 s statement timeout on cold pages, so production runs
   `ASSET_PRICE_SNAPSHOT_RETENTION_BATCH_SIZE=250` and
   `ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES=80` (the same 20,000 rows examined
   per run). Kept rows are re-checked after every restart and once a day (the
   cursors live in memory); until VACUUM removes the rows deleted before them,
   those checks walk dead index entries and can time out for a few runs. One
   plain `VACUUM (ANALYZE) asset_price_snapshots` (68 s, autovacuum cost delay)
   cleared the first backlog's dead entries on 2026-10-16.

Rollback: before the first user trade in a new product, revert the catalog
code (new contracts leave the Futures catalog and entry; open lifetimes keep
their Last/Mark) and deactivate the new Spot assets. After trades exist, Spot
deactivation blocks the holders' sells (no Spot sell-only mode) — a product
decision; there is no buy-only stop for one Spot asset either. The existing
25 + 25 rows, IDs, evidence and positions are never touched by any of these
steps. Each switch turned on above stops on its own, with a deploy:
`CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false` (keep the retention on for 14 days to
empty the tables; no financial path reads them),
`SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED=false` (chart display only),
`ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false` (rows already deleted are not
restored; every row a financial record or reader needs was kept).

## Operator check: Spot price freshness

Policy (unchanged): a Spot market order needs a provider price received at most
10 s earlier (whole seconds, so it is refused from 11 s); quotes need 60 s
(refused from 61 s). Thin pairs get no `@ticker` frame while nobody trades, so
their orders are refused (503 `PRICE_STALE`, shown as "최신 가격을 확인할 수
없어 주문할 수 없습니다.") until the next trade. No REST refresh marks an old
trade as new: REST ingestion is off while the Spot WebSocket is on.

To measure how often each symbol is refused, run this read-only query
(`BEGIN READ ONLY`, a `statement_timeout`; it reads index ranges of
`asset_price_snapshots (asset_id, captured_at)` only). Change `60` to the
window in minutes. `execute_refused_pct` is the share of the window in which a
market order would have been refused.

```sql
WITH p AS (
  SELECT (now() AT TIME ZONE 'UTC') - make_interval(mins => 60) AS t0,
         (now() AT TIME ZONE 'UTC') AS t1
), a AS (
  SELECT id, symbol FROM assets
  WHERE market = 'BINANCE' AND asset_type = 'crypto' AND is_active
), r AS (
  SELECT a.symbol, s.captured_at,
         lead(s.captured_at) OVER (PARTITION BY a.id ORDER BY s.captured_at) AS next_at
  FROM a CROSS JOIN p
  JOIN LATERAL (
    (SELECT captured_at FROM asset_price_snapshots
      WHERE asset_id = a.id AND captured_at < p.t0 AND source_type = 'provider_api'
        AND source_name IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker')
      ORDER BY captured_at DESC LIMIT 1)
    UNION ALL
    (SELECT captured_at FROM asset_price_snapshots
      WHERE asset_id = a.id AND captured_at >= p.t0 AND captured_at < p.t1 AND source_type = 'provider_api'
        AND source_name IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker'))
  ) s ON true
)
SELECT symbol,
  count(*) FILTER (WHERE captured_at >= p.t0) AS rows_in_window,
  round(100 * sum(greatest(0, extract(epoch FROM least(coalesce(next_at, p.t1), p.t1)
    - greatest(captured_at + interval '11 seconds', p.t0)))) / extract(epoch FROM p.t1 - p.t0), 2) AS execute_refused_pct,
  round(100 * sum(greatest(0, extract(epoch FROM least(coalesce(next_at, p.t1), p.t1)
    - greatest(captured_at + interval '61 seconds', p.t0)))) / extract(epoch FROM p.t1 - p.t0), 2) AS quote_refused_pct,
  round(extract(epoch FROM max(least(coalesce(next_at, p.t1), p.t1) - greatest(captured_at, p.t0)))::numeric, 1) AS longest_gap_s
FROM r CROSS JOIN p
GROUP BY symbol, p.t0, p.t1
ORDER BY execute_refused_pct DESC, symbol;
```

2026-10-16 11:00 UTC, last 60 minutes, before the 75 additions: 币安人生USDT
21.88 %, ASTERUSDT 6.58 %, NIGHTUSDT 2.64 %, AAVEUSDT 2.33 %, CHIPUSDT 1.75 %,
seven more under 0.3 %, the other 17 symbols 0 %; no symbol reached the quote
limit. The 2026-10-16 local 33-minute measurement of all 100 (49 above 1 %,
BANKUSDT 59 %) is in the investigation report §16-2.
