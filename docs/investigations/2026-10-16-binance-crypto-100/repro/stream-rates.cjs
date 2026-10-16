// Count public USDⓈ-M frames per stream type for the 100 catalog symbols (read-only WS).
const WebSocket = require(process.env.WS_MODULE);
const symbols = process.argv[2].split(',');
const seconds = Number(process.argv[3]);
const routes = [
  ['aggTrade', 'wss://fstream.binance.com/market/stream', '@aggTrade'],
  ['markPrice', 'wss://fstream.binance.com/market/stream', '@markPrice@1s'],
  ['ticker', 'wss://fstream.binance.com/market/stream', '@ticker'],
  ['depth10', 'wss://fstream.binance.com/public/stream', '@depth10@500ms'],
];
const counts = {}, bytes = {}, seen = {};
const sockets = routes.map(([name, url, suffix]) => {
  counts[name] = 0; bytes[name] = 0; seen[name] = new Set();
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: symbols.map((s) => s.toLowerCase() + suffix), id: 1 })));
  ws.on('message', (d) => { const t = d.toString(); if (!t.includes('"stream"')) return; counts[name]++; bytes[name] += t.length; const m = /"stream":"([^@"]+)@/.exec(t); if (m) seen[name].add(m[1]); });
  ws.on('error', (e) => console.error(name, e.message));
  return ws;
});
setTimeout(() => {
  sockets.forEach((s) => s.terminate());
  const out = {};
  for (const [name] of routes) out[name] = { perSecond: +(counts[name] / seconds).toFixed(1), kbPerSecond: +(bytes[name] / seconds / 1000).toFixed(1), symbols: seen[name].size };
  console.log(JSON.stringify(out));
}, seconds * 1000);
