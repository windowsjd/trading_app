// P1-B2: stored bytes per row (heap + indexes, v4 ids) of each raw-payload
// profile, 100,000 rows per variant, in tables cloned from the production DDL
// (LIKE ... INCLUDING ALL) in an ISOLATED local PostgreSQL. Payload shapes and
// field lengths follow the 2026-10-16 audit evidence (payload-shapes.json);
// the slim profiles are built from the code's own field lists.
// Usage: tsx measure-row-bytes.ts <url of a migrated *_test DB>
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { BINANCE_TICKER_SLIM_FIELDS } from '../../../../backend/src/providers/binance/binance-websocket.ingestion.service';
import { KOSCOM_PRICE_SLIM_ROW_FIELDS } from '../../../../backend/src/providers/koscom/koscom-ingestion.service';

const [url] = process.argv.slice(2);
assert.ok(new URL(url).pathname.endsWith('_test'));
const N = 100_000;
const E = Date.parse('2026-10-15T15:42:10.123Z');
const ticker = {
  e: '24hrTicker', E, s: 'BTCUSDT', p: '-1234.56000000', P: '-1.902', w: '64123.12345678', x: '64900.01000000',
  c: '63665.45000000', Q: '0.00512000', b: '63665.44000000', B: '1.12345000', a: '63665.45000000', A: '0.98765000',
  o: '64900.01000000', h: '65120.00000000', l: '63010.00000000', v: '12345.67800000', q: '791234567.12345678',
  O: E - 86_400_000, C: E, F: 4123456789, L: 4123999999, n: 543210,
};
const binanceFull = { truncated: false, payload: { provider: 'binance', messageType: 'spot_ws_ticker', streamName: 'btcusdt@ticker', payload: { stream: 'btcusdt@ticker', data: ticker } } };
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const binanceSlim = { truncated: false, payload: { provider: 'binance', messageType: 'spot_ws_ticker', streamName: 'btcusdt@ticker', payloadProfile: 'binance_ticker_slim_v1', requestedBy: 'binance-websocket-streaming', payload: pick(ticker, BINANCE_TICKER_SLIM_FIELDS) } };
const koscomRow = { hgprc: '71200000', lwprc: '69800000', trdTm: '1532000000', opnprc: '70100000', trdPrc: '70500000', trdvol: '12345', isuSrtCd: '00593000', accTrdval: '864191234567891', accTrdvol: '1234567890', askordPrc_1: '70600000', bidordPrc_1: '70500000', cmpprevddPrc: '1200000', cmpprevddTpCd: '200', lstAskbidTpCd: '100' };
const koscomWrap = (row: Record<string, unknown>, slim: boolean) => ({ truncated: false, payload: { provider: 'koscom', messageType: 'rest_current_price', ...(slim ? { payloadProfile: 'koscom_price_slim_v1' } : {}), row, market: 'kospi', dateBasis: 'receipt_session', changeRate: '1.71568627450980' } });
const bookRow: Record<string, string> = { isuSrtCd: '00593000', accTrdvol: '1234567890', deemTrdPrc: '70500000', deemTrdvol: '1200', askordTotRqty: '98765432', bidordTotRqty: '87654321', deemAccTrdvol: '123456789', pstoffhrAskTotOrdRqty: '100', pstoffhrBidTotOrdRqty: '200' };
const levels = { asks: [] as { price: string; quantity: string }[], bids: [] as { price: string; quantity: string }[] };
for (let i = 1; i <= 10; i++) {
  bookRow[`askStep${i}BstordPrc`] = String(70500 + 100 * i); bookRow[`askStep${i}BstordRqty`] = String(1000 + 37 * i);
  bookRow[`bidStep${i}BstordPrc`] = String(70500 - 100 * (i - 1)); bookRow[`bidStep${i}BstordRqty`] = String(2000 + 41 * i);
  levels.asks.push({ price: (70500 + 100 * i).toFixed(8), quantity: (1000 + 37 * i).toFixed(8) });
  levels.bids.push({ price: (70500 - 100 * (i - 1)).toFixed(8), quantity: (2000 + 41 * i).toFixed(8) });
}
const book = { ...levels, spreadBps: '14.18439716', askTotal: '98765432.00000000', bidTotal: '87654321.00000000' };
const bookWrap = (slim: boolean) => ({ truncated: false, payload: { provider: 'koscom', messageType: 'rest_hoga', ...(slim ? { payloadProfile: 'koscom_orderbook_slim_v1' } : {}), row: slim ? Object.fromEntries(Object.entries(bookRow).filter(([k]) => !/^(ask|bid)Step\d+Bstord(Prc|Rqty)$/.test(k))) : bookRow, book, market: 'kospi', timestampBasis: 'receipt' } });
const NOTE = 'provider_api Binance WebSocket ticker ingestion requested by binance-websocket-streaming';

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();
  const out: Record<string, unknown> = {};
  const variants: Array<[string, 'price' | 'book', unknown, string | null]> = [
    ['binance_full', 'price', binanceFull, NOTE],
    ['binance_slim', 'price', binanceSlim, null],
    ['koscom_price_full', 'price', koscomWrap(koscomRow, false), null],
    ['koscom_price_slim', 'price', koscomWrap(pick(koscomRow, KOSCOM_PRICE_SLIM_ROW_FIELDS), true), null],
    ['koscom_book_full', 'book', bookWrap(false), null],
    ['koscom_book_slim', 'book', bookWrap(true), null],
  ];
  // Storage settings: as deployed, then pglz (production default_toast_compression)
  // compression of smaller tuples. lz4 needs a server built with it (local is not).
  const storages: Array<[string, string[]]> = [
    ['default', []],
    ['toast128_pglz', ['SET (toast_tuple_target = 128)']],
  ];
  for (const [storage, alters] of storages)
  for (const [variantName, kind, raw, note] of variants) {
    const name = `${variantName}__${storage}`;
    const t = `rowbytes_${variantName}`;
    await c.query(`DROP TABLE IF EXISTS ${t}`);
    await c.query(`CREATE TABLE ${t} (LIKE ${kind === 'price' ? 'asset_price_snapshots' : 'asset_orderbook_snapshots'} INCLUDING ALL)`);
    for (const alter of alters) await c.query(`ALTER TABLE ${t} ${alter}`);
    if (kind === 'price')
      await c.query(`INSERT INTO ${t} (id, asset_id, price, price_krw, currency_code, source_type, source_name, source_timestamp, effective_at, captured_at, raw_payload_json, note)
        SELECT gen_random_uuid()::text, 'a' || (n % 25), 63665.45, 89131630.00, 'USD', 'provider_api', 'binance_spot_ws_ticker', t, t, t, $1::jsonb, $2
        FROM (SELECT n, '2026-10-15'::timestamp + n * interval '6 seconds' AS t FROM generate_series(1, ${N}) n) s`, [JSON.stringify(raw), note]);
    else
      await c.query(`INSERT INTO ${t} (id, asset_id, source_type, source_name, bid_price, bid_quantity, ask_price, ask_quantity, spread_bps, currency_code, effective_at, captured_at, raw_payload_json)
        SELECT gen_random_uuid()::text, 'a' || (n % 15), 'provider_api', 'koscom_krx_orderbook', 70500, 2041, 70600, 1037, 14.18439716, 'KRW', t, t, $1::jsonb
        FROM (SELECT n, '2026-10-15'::timestamp + n * interval '3 seconds' AS t FROM generate_series(1, ${N}) n) s`, [JSON.stringify(raw)]);
    await c.query(`VACUUM ANALYZE ${t}`);
    const { rows: [r] } = await c.query(`SELECT pg_total_relation_size('${t}')::bigint AS total, pg_relation_size('${t}')::bigint AS heap,
        pg_indexes_size('${t}')::bigint AS idx, (SELECT avg(pg_column_size(raw_payload_json))::int FROM ${t}) AS raw_bytes,
        (SELECT avg(pg_column_size(${t}.*))::int FROM ${t}) AS row_bytes FROM (SELECT 1) x`);
    out[name] = { bytesPerRow: Math.round(Number(r.total) / N), heapPerRow: Math.round(Number(r.heap) / N), indexPerRow: Math.round(Number(r.idx) / N), rawJsonbBytes: r.raw_bytes, tupleBytes: r.row_bytes };
    await c.query(`DROP TABLE ${t}`);
  }
  console.log(JSON.stringify(out, null, 1));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
