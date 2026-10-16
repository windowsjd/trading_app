// Public Binance depth capture (read-only WS, no REST). Usage:
// node capture-depth.cjs <spotSymbolsCsv> <futuresSymbolsCsv> <seconds> <outDir>
const WebSocket = require(process.env.WS_MODULE);
const fs = require('fs');
const [spotCsv, futCsv, seconds, out] = process.argv.slice(2);
const spot = spotCsv.split(',').filter(Boolean);
const fut = futCsv.split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });
const files = { spot: fs.createWriteStream(out + '/spot.ndjson'), fut: fs.createWriteStream(out + '/futures.ndjson') };
const counts = { spot: 0, fut: 0 };
function open(kind, url, params) {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 })));
  ws.on('message', (data) => {
    const text = data.toString('utf8');
    if (!text.includes('"stream"')) return;
    counts[kind]++;
    files[kind].write(JSON.stringify({ receivedAt: Date.now(), frame: text }) + '\n');
  });
  ws.on('error', (e) => console.error(kind, 'error', e.message));
  return ws;
}
const sockets = [
  open('spot', 'wss://data-stream.binance.vision/stream', spot.map((s) => s.toLowerCase() + '@depth10')),
  open('fut', 'wss://fstream.binance.com/public/stream', fut.map((s) => s.toLowerCase() + '@depth10@500ms')),
];
setTimeout(() => {
  for (const s of sockets) s.terminate();
  files.spot.end(); files.fut.end();
  console.log(JSON.stringify(counts));
}, Number(seconds) * 1000);
