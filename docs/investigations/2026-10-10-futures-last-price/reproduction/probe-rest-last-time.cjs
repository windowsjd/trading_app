// Read-only: what the REST last-price timestamps mean (no auth, no DB).
// node probe-rest-last-time.cjs
// For a quiet and a liquid symbol, compares /fapi/v2/ticker/price `time`,
// /fapi/v1/ticker/24hr closeTime/lastId and the newest /fapi/v1/trades row
// against /fapi/v1/time. Result 2026-10-10: v2 `time` is the last trade time
// (it does not advance without trades); 24hr is a lagging cache.
const get = async (u) => (await fetch(u)).json();
(async () => {
  for (let i = 0; i < 12; i++) {
    for (const s of ['CHIPUSDT', 'LTCUSDT', 'BTCUSDT']) {
      const t = await get('https://fapi.binance.com/fapi/v1/time');
      const v2 = await get(`https://fapi.binance.com/fapi/v2/ticker/price?symbol=${s}`);
      const h = await get(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${s}`);
      const tr = await get(`https://fapi.binance.com/fapi/v1/trades?symbol=${s}&limit=1`);
      const st = t.serverTime;
      console.log(
        JSON.stringify({
          s,
          v2price: v2.price,
          v2AgeMs: st - v2.time,
          h24last: h.lastPrice,
          h24closeAgeMs: st - h.closeTime,
          h24lastId: h.lastId,
          tradeId: tr[0]?.id,
          tradeAgeMs: st - tr[0]?.time,
          tradePrice: tr[0]?.price,
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
})();
