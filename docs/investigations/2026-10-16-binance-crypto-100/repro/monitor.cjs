// Soak monitor: readiness counters, Redis book fanout lag, DB rows/sizes/WAL.
const http = require('node:http');
const fs = require('node:fs');
const IORedis = require(process.env.IOREDIS);
const { Client } = require(process.env.PG_MODULE);
const out = process.env.OUT;
const port = process.env.PORT_APP;
const lag = { spot: [], futures: [] };
const msgs = { spot: 0, futures: 0 };
const perProduct = { spot: new Map(), futures: new Map() };
const sub = new IORedis(process.env.REDIS_URL);
sub.subscribe('market:order-book:v1', 'market:futures-order-book:v1');
sub.on('message', (channel, text) => {
  const now = Date.now();
  const kind = channel === 'market:order-book:v1' ? 'spot' : 'futures';
  try {
    const e = JSON.parse(text);
    msgs[kind]++;
    const id = kind === 'spot' ? e.book.assetId : e.book.instrumentId;
    perProduct[kind].set(id, (perProduct[kind].get(id) ?? 0) + 1);
    lag[kind].push(now - Date.parse(e.book.capturedAt));
  } catch {}
});
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
function readiness() {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/readiness', timeout: 5000 }, (res) => {
      let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
const db = new Client({ connectionString: process.env.DATABASE_URL });
let lastLsn = null;
(async () => {
  await db.connect();
  setInterval(async () => {
    const r = await readiness();
    const d = r?.data ?? {};
    const b = d.binanceWebSocketStreaming ?? {};
    const rows = (await db.query(`SELECT (SELECT count(*) FROM crypto_spot_order_book_snapshots)::int spot,
      (SELECT count(*) FROM futures_order_book_snapshots)::int futures,
      pg_total_relation_size('crypto_spot_order_book_snapshots')::bigint spot_bytes,
      pg_total_relation_size('futures_order_book_snapshots')::bigint futures_bytes,
      (SELECT count(*) FROM futures_mark_snapshots)::int mark, (SELECT count(*) FROM futures_last_price_snapshots)::int last,
      (SELECT count(*) FROM asset_price_snapshots)::int prices, pg_current_wal_insert_lsn()::text lsn`)).rows[0];
    let walBytes = null;
    if (lastLsn) walBytes = Number((await db.query('SELECT pg_wal_lsn_diff($1,$2)::bigint d', [rows.lsn, lastLsn])).rows[0].d);
    lastLsn = rows.lsn;
    const sample = {
      at: new Date().toISOString(),
      status: d.status, reasons: d.reasons,
      spotWs: { state: b.state, streams: (b.subscribedStreams ?? []).length, frames: b.receivedFrames, tickers: b.receivedTickers, created: b.created, failed: b.failed, reconnects: b.reconnectCount, lastError: b.lastErrorCode },
      futuresMark: d.futuresMark && { targets: d.futuresMark.targets, stale: d.futuresMark.staleTargets, missing: d.futuresMark.missingTargets, lastFrameAgeMs: d.futuresMark.lastFrameAgeMs, persistFailures: d.futuresMark.consecutivePersistFailures },
      history: d.cryptoOrderBookHistory?.recorder ?? null,
      fanout: {
        spotMsgs: msgs.spot, futuresMsgs: msgs.futures,
        spotProducts: perProduct.spot.size, futuresProducts: perProduct.futures.size,
        spotLagP50: pct(lag.spot, 50), spotLagP95: pct(lag.spot, 95), spotLagP99: pct(lag.spot, 99), spotLagMax: pct(lag.spot, 100),
        futuresLagP50: pct(lag.futures, 50), futuresLagP95: pct(lag.futures, 95), futuresLagP99: pct(lag.futures, 99), futuresLagMax: pct(lag.futures, 100),
      },
      db: { ...rows, walBytes },
    };
    fs.appendFileSync(out, JSON.stringify(sample) + '\n');
    msgs.spot = 0; msgs.futures = 0; lag.spot = []; lag.futures = [];
    perProduct.spot.clear(); perProduct.futures.clear();
  }, 60000);
})();
