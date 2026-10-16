// Authenticated local end-to-end probe against the soak server (loopback only).
const WebSocket = require(process.env.WS_MODULE);
const base = 'http://127.0.0.1:3999';
async function call(method, path, body, token) {
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, ms: +(performance.now() - t0).toFixed(1), bytes: text.length, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
(async () => {
  const email = `soak-${Date.now()}@example.invalid`;
  const signup = await call('POST', '/api/v1/auth/signup', { email, password: 'Soak-pass-1234!', nickname: `soak${Date.now() % 100000}` });
  const login = await call('POST', '/api/v1/auth/login', { email, password: 'Soak-pass-1234!' });
  const token = login.json?.data?.tokens?.accessToken ?? signup.json?.data?.tokens?.accessToken;
  const out = { signup: signup.status, login: login.status };
  const assets = await call('GET', '/api/v1/assets?assetType=crypto&market=BINANCE&limit=100&withPrice=true', null, token);
  const list = assets.json?.data?.assets ?? [];
  out.spotList = { status: assets.status, ms: assets.ms, bytes: assets.bytes, count: list.length, withPrice: list.filter((a) => a.price != null).length, decimals: list.filter((a) => a.displayPriceDecimals != null).length };
  const general = await call('POST', '/api/v1/trading-accounts/general', null, token);
  out.general = general.status;
  const accounts = await call('GET', '/api/v1/trading-accounts', null, token);
  const acct = (accounts.json?.data?.accounts ?? accounts.json?.data ?? []).find?.((a) => a.id) ?? null;
  out.accounts = { status: accounts.status, id: acct?.id ?? null, mode: acct?.mode ?? acct?.type ?? null };
  if (acct) {
    const times = [];
    let inst = null;
    for (let i = 0; i < 5; i++) { inst = await call('GET', `/api/v1/trading-accounts/${acct.id}/futures/instruments`, null, token); times.push(inst.ms); }
    const instruments = inst.json?.data?.instruments ?? [];
    out.futuresCatalog = { status: inst.status, msRuns: times, bytes: inst.bytes, count: instruments.length, withLast: instruments.filter((i) => i.referencePrice).length, withMark: instruments.filter((i) => i.markPrice).length, sample: instruments.slice(-2).map((i) => ({ symbol: i.underlying?.symbol, ref: i.referencePrice, mark: i.markPrice, dec: i.underlying?.displayPriceDecimals })) };
  }
  // WebSocket: a new Spot asset book and a new USDⓈ-M contract book.
  const spot = list.find((a) => a.symbol === 'MARSCOINUSDT') ?? list.at(-1);
  const futuresList = out.futuresCatalog ? (await call('GET', `/api/v1/trading-accounts/${acct.id}/futures/instruments`, null, token)).json.data.instruments : [];
  const contract = futuresList.find((i) => i.underlying?.symbol === '0GUSDT');
  const ws = new WebSocket(`ws://127.0.0.1:3999/api/v1/ws?token=${encodeURIComponent(token)}`);
  const frames = { asset_order_book: 0, futures_order_book: 0, acks: [], errors: [] };
  let sampleSpot = null, sampleFut = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'subscribed') frames.acks.push(m.channel);
    else if (m.type === 'subscription_error' || m.type === 'error') frames.errors.push(m);
    else if (m.type === 'asset_order_book') { frames.asset_order_book++; sampleSpot = { asks: m.asks?.length, bids: m.bids?.length, bestAsk: m.asks?.[0], bestBid: m.bids?.[0], capturedAt: m.capturedAt }; }
    else if (m.type === 'futures_order_book') { frames.futures_order_book++; sampleFut = { asks: m.asks?.length, bids: m.bids?.length, bestAsk: m.asks?.[0], bestBid: m.bids?.[0], effectiveAt: m.effectiveAt }; }
  });
  await new Promise((r) => ws.once('open', r));
  await new Promise((r) => setTimeout(r, 500));
  ws.send(JSON.stringify({ type: 'subscribe', channel: 'asset_order_book', assetId: spot?.assetId ?? spot?.id }));
  if (contract) ws.send(JSON.stringify({ type: 'subscribe', channel: 'futures_order_book', instrumentId: contract.id }));
  await new Promise((r) => setTimeout(r, 12000));
  ws.close();
  out.ws = { spotSymbol: spot?.symbol, contract: contract?.underlying?.symbol, ...frames, sampleSpot, sampleFut };
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
