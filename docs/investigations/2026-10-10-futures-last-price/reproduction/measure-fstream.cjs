// Read-only measurement of Binance USDⓈ-M public streams (no auth, no DB).
// node measure-fstream.cjs BTCUSDT,ETHUSDT,... 90
// Compares <symbol>@aggTrade with <symbol>@ticker: rates, trade/ticker gaps,
// receipt offsets, aggregate-id ordering and ticker `c` vs last aggTrade price.
const WebSocket = require('../../../../backend/node_modules/ws');
const syms = process.argv[2].split(',');
const seconds = Number(process.argv[3] || 90);
const streams = syms.flatMap((s) => [
  `${s.toLowerCase()}@aggTrade`,
  `${s.toLowerCase()}@ticker`,
]);
const ws = new WebSocket('wss://fstream.binance.com/market/stream');
const stat = new Map(
  syms.map((s) => [
    s,
    { agg: 0, tick: 0, lastT: 0, maxGapMs: 0, lastE: 0, maxEGap: 0, outOfOrder: 0, dup: 0, lastA: -1, offsets: [], tickOffsets: [], priceDiffs: 0 },
  ]),
);
let total = 0;
let bytes = 0;
let start = 0;
const perSecond = new Map();
ws.on('open', () => {
  start = Date.now();
  ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: 1 }));
  setTimeout(() => ws.close(), seconds * 1000);
});
ws.on('message', (buf) => {
  const now = Date.now();
  const raw = buf.toString();
  const frame = JSON.parse(raw);
  if (!frame.data) return;
  const d = frame.data;
  const st = stat.get(d.s);
  if (!st) return;
  total++;
  bytes += raw.length;
  const sec = Math.floor((now - start) / 1000);
  perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
  if (d.e === 'aggTrade') {
    st.agg++;
    if (st.lastA >= 0 && d.a <= st.lastA) d.a === st.lastA ? st.dup++ : st.outOfOrder++;
    st.lastA = Math.max(st.lastA, d.a);
    if (st.lastT) st.maxGapMs = Math.max(st.maxGapMs, d.T - st.lastT);
    st.lastT = Math.max(st.lastT, d.T);
    st.offsets.push(now - d.T);
    st.lastAggPrice = d.p;
  } else if (d.e === '24hrTicker') {
    st.tick++;
    st.tickOffsets.push(now - d.E);
    if (st.lastE) st.maxEGap = Math.max(st.maxEGap, d.E - st.lastE);
    st.lastE = d.E;
    if (st.lastAggPrice && st.lastAggPrice !== d.c) st.priceDiffs++;
  }
});
ws.on('close', () => {
  const dur = (Date.now() - start) / 1000;
  const q = (a, p) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const rows = [...stat].map(([s, v]) => ({
    s,
    aggPerSec: +(v.agg / dur).toFixed(2),
    tickPerSec: +(v.tick / dur).toFixed(2),
    maxTradeGapMs: v.maxGapMs,
    maxTickerGapMs: v.maxEGap,
    aggOffsetP50: q(v.offsets, 0.5),
    aggOffsetP99: q(v.offsets, 0.99),
    tickOffsetP50: q(v.tickOffsets, 0.5),
    outOfOrder: v.outOfOrder,
    dup: v.dup,
    tickerPriceNeLastAgg: v.priceDiffs,
  }));
  console.table(rows);
  console.log(
    JSON.stringify({
      durationSec: dur,
      totalMsgs: total,
      msgsPerSec: +(total / dur).toFixed(1),
      peakMsgsPerSec: Math.max(...perSecond.values()),
      kbPerSec: +(bytes / 1024 / dur).toFixed(1),
      aggTotal: rows.reduce((a, r) => a + r.aggPerSec, 0).toFixed(1),
      tickTotal: rows.reduce((a, r) => a + r.tickPerSec, 0).toFixed(1),
    }),
  );
});
ws.on('error', (e) => {
  console.error('WS error', e.message);
  process.exit(1);
});
