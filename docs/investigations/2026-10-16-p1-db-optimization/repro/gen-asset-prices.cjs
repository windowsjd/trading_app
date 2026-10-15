// Production-like asset_price_snapshots at the 14-day activation moment, in an
// ISOLATED local PostgreSQL (*_test only). Composition after the 2026-10-16
// audit: 25 Binance spot assets (old part at the pre-10-10 rate, last 6 days at
// the 6 s heartbeat), 15 KOSCOM stocks (4 sessions), legacy KIS rows that
// stopped writing, 1 US stock with no rows, raw payloads of production size,
// v4 ids, an active Season ending in 30 days and one that ended 21 days ago.
// Usage: node gen-asset-prices.cjs <databaseUrl>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname.endsWith('_test'));
const DAY = 86400000;
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows: [{ end }] } = await c.query(
    "SELECT to_char(date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS end");
  const E = Date.parse(end + 'Z');
  const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
  console.log('end', end);
  await c.query(`INSERT INTO seasons (id, name, status, start_at, end_at, initial_capital_krw, trade_fee_rate, fx_fee_rate, updated_at) VALUES
    (gen_random_uuid()::text, 'bench active', 'active', $1, $2, 10000000, 0.001, 0.001, now()),
    (gen_random_uuid()::text, 'bench ended', 'ended', $3, $4, 10000000, 0.001, 0.001, now())`,
    [iso(E - 20 * DAY), iso(E + 30 * DAY), iso(E - 50 * DAY), iso(E - 21 * DAY)]);
  const asset = async (symbol, market, type, ccy) => (await c.query(
    `INSERT INTO assets (id, symbol, name, market, currency_code, price_currency, settlement_currency, asset_type, updated_at)
     VALUES (gen_random_uuid()::text, $1, $1, $2, $3, $3, $3, $4, now()) RETURNING id`, [symbol, market, ccy, type])).rows[0].id;
  const crypto = [], krx = [];
  for (let i = 0; i < 25; i++) crypto.push(await asset(`BENCH${i}USDT`, 'BINANCE', 'crypto', 'USD'));
  for (let i = 0; i < 15; i++) krx.push(await asset(String(900100 + i), 'KOSPI', 'domestic_stock', 'KRW'));
  await asset('BENCHUS', 'NASDAQ', 'us_stock', 'USD');
  const binanceRaw = `jsonb_build_object('truncated', false, 'payload', jsonb_build_object('provider','binance','messageType','spot_ws_ticker','streamName','benchusdt@ticker','payload', jsonb_build_object('stream','benchusdt@ticker','data', jsonb_build_object(
      'e','24hrTicker','E',(extract(epoch FROM t)*1000)::bigint,'s','BENCHUSDT','p','-12.34000000','P','-0.123','w','64123.12345678','x','64000.01000000','c',(100 + n % 97)::text || '.12000000','Q','0.01234000',
      'b','64110.00000000','B','1.23400000','a','64110.01000000','A','0.98700000','o','64000.00000000','h','65000.00000000','l','63000.00000000','v','12345.67800000','q','791234567.12345678',
      'O',(extract(epoch FROM t)*1000)::bigint - 86400000,'C',(extract(epoch FROM t)*1000)::bigint,'F',123456789,'L',123999999,'n',543210))))`;
  const series = async (assetId, source, ccy, fromMs, stepS, count, raw, note) => c.query(
    `INSERT INTO asset_price_snapshots (id, asset_id, price, price_krw, currency_code, source_type, source_name, source_timestamp, effective_at, captured_at, created_at, raw_payload_json, note)
     SELECT gen_random_uuid()::text, $1, 100 + n % 97, (100 + n % 97) * 1400, $3::"CurrencyCode", 'provider_api', $2, t, t, t + interval '70 milliseconds', t + interval '70 milliseconds', ${raw}, $6
     FROM (SELECT n, $4::timestamp + n * make_interval(secs => $5) AS t FROM generate_series(0, $7::int - 1) n) s`,
    [assetId, source, ccy, iso(fromMs), stepS, note, count]);
  const t0 = performance.now();
  const note = 'provider_api Binance WebSocket ticker ingestion requested by binance-websocket-streaming';
  for (const [k, id] of crypto.entries()) {
    await series(id, 'binance_spot_ws_ticker', 'USD', E - 38 * DAY + k * 37, 25, (24 * DAY) / 25000, binanceRaw, note);
    await series(id, 'binance_spot_ws_ticker', 'USD', E - 14 * DAY + k * 37, 25, (8 * DAY) / 25000, binanceRaw, note);
    await series(id, 'binance_spot_ws_ticker', 'USD', E - 6 * DAY + k * 37, 6, (6 * DAY) / 6000, binanceRaw, note);
    if (k % 5 === 4) console.log(`crypto ${k + 1}/25 ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const koscomRaw = `jsonb_build_object('truncated', false, 'payload', jsonb_build_object('provider','koscom','messageType','rest_current_price','row', jsonb_build_object(
      'isuSrtCd','900100','trdPrc',(70000 + n % 300)::text,'cmpprevddPrc','1000','cmpprevddTpCd','2','trdTm','10000000','accTrdvol','1234567','accTrdval','86419123456',
      'opnprc','69000','hgprc','71000','lwprc','68500','trdvol','12','lstAskbidTpCd','1','bidordPrc_1','69900','askordPrc_1','70000'),'market','kospi','dateBasis','receipt_session','changeRate','1.45'))`;
  // Four recent weekday sessions, 09:00-15:30 KST (00:00-06:30 UTC), one row per 4 s.
  const sessions = [];
  for (let d = 1; sessions.length < 4 && d < 10; d++) {
    const day = new Date(Math.floor((E - d * DAY) / DAY) * DAY);
    if ([0, 6].includes(day.getUTCDay())) continue;
    sessions.push(+day);
  }
  for (const id of krx) {
    for (const s of sessions) await series(id, 'koscom_krx_realtime_price', 'KRW', s, 4, 5850, koscomRaw, null);
    // Legacy KIS rows (stopped writing 8 days ago): 50 a day from 49 days ago.
    const kisRaw = `jsonb_build_object('truncated', false, 'payload', jsonb_build_object('provider','kis','messageType','websocket_trade','rawFrame', repeat('0|H0STCNT0|001|', 40), 'rawFields', jsonb_build_object('ACML_TR_PBMN','86419123456','STCK_PRPR','70000')))`;
    await series(id, 'kis_krx_realtime_trade', 'KRW', E - 49 * DAY, 1728, 41 * 50, kisRaw, 'provider_api KIS WebSocket trade ingestion requested by kis-websocket-streaming');
  }
  console.log(`rows inserted ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  await c.query('VACUUM ANALYZE asset_price_snapshots');
  const { rows: [stat] } = await c.query(`SELECT (SELECT count(*) FROM asset_price_snapshots)::bigint AS rows,
      pg_relation_size('asset_price_snapshots') AS heap, pg_indexes_size('asset_price_snapshots') AS idx,
      pg_total_relation_size('asset_price_snapshots') AS total,
      (SELECT count(*) FROM asset_price_snapshots WHERE effective_at < $1)::bigint AS older_than_14d`, [iso(E - 14 * DAY)]);
  console.log(JSON.stringify({ end, ...stat }));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
