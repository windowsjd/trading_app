function futuresFixture(accountId = 'A', options = {}) {
  // Model evidence captured before the HTTP response/render, rather than a
  // zero-age timestamp that can cross the screen clock during async query reads.
  // One second models feed/HTTP delay within the unchanged five-second policy.
  // The server evaluates the read when it is requested; options.serverClockOffsetMs
  // models a server clock behind (negative) or ahead of the device clock.
  const serverNow = Date.now() + (options.serverClockOffsetMs ?? 0);
  const evaluatedAt = new Date(serverNow).toISOString();
  const observedAt = serverNow - 1000;
  const at = new Date(observedAt - ((options.stale || options.expiredMark) ? 6000 : 0)).toISOString();
  const referenceAt = new Date(observedAt).toISOString();
  const mode = options.mode ?? 'ENABLED';
  const capabilities = { tradingMode: mode, canOpen: mode === 'ENABLED', canIncrease: mode === 'ENABLED', canReduce: mode !== 'DISABLED', canClose: mode !== 'DISABLED', reason: null };
  const instrument = { id: 'btc', isActive: true, productType: 'synthetic_perpetual', settlementCurrency: 'USD', underlying: { assetId: 'asset-btc', symbol: 'BTCUSDT', name: '비트코인', market: 'BINANCE', displayPriceDecimals: 2 }, markPrice: options.missingMark ? null : options.markPrice ?? (options.large ? '9876543210123456.12345678' : '101'), referencePrice: options.missingReference ? null : options.referencePrice ?? '102', markState: options.stale || options.missingMark ? 'unavailable_or_stale' : 'fresh', markEvidence: options.missingMark ? null : { snapshotId: 'mark', source: 'binance_usdm_mark_ws', effectiveAt: at, capturedAt: at }, referencePriceEvidence: options.missingReference ? null : { effectiveAt: options.expiredReference ? new Date(serverNow - 61000).toISOString() : options.oldReference ? new Date(serverNow - 30000).toISOString() : referenceAt, capturedAt: referenceAt } };
  const position = { id: accountId + ':position', tradingAccountId: accountId, instrumentId: 'btc', direction: options.direction ?? 'long', marginMode: options.marginMode ?? 'isolated', leverage: options.leverage ?? 100, quantity: '2', averageEntryPrice: '100', isolatedMargin: '2', realizedPnl: '0.12345678', initialMargin: '2', markNotional: options.stale ? null : options.large ? '9876543210123456.12345678' : '202', roi: options.stale ? null : '-106.172839', instrument, markPrice: instrument.markPrice, referencePrice: instrument.referencePrice, markUnrealizedPnl: options.large ? '-9876543210123456.12345678' : '-2.12345678', markState: instrument.markState, markEvidence: instrument.markEvidence, referencePriceEvidence: instrument.referencePriceEvidence, risk: options.stale ? null : { unrealizedPnl: '-2', initialRequirement: '2.02', maintenanceMargin: '1.01', estimatedCloseFee: '0.2', liquidationRequirement: '1.21', liquidationBuffer: '-1.21', liquidationPrice: '99.5' } };
  const cross = options.position && position.marginMode === 'cross';
  return {
    // options.futuresOnly adds HYPEUSDT: a futures-only contract whose
    // underlying has no Spot product (its own BINANCE asset row).
    catalog: { tradingAccountId: accountId, evaluatedAt, capabilities, instruments: options.empty ? [] : options.futuresOnly ? [instrument, { ...instrument, id: 'hype', underlying: { assetId: 'asset-hype', symbol: 'HYPEUSDT', name: 'Hyperliquid', market: 'BINANCE', displayPriceDecimals: 3 } }] : [instrument] },
    positions: { tradingAccountId: accountId, evaluatedAt, capabilities, positions: options.position ? [position] : [], collateral: { balanceAmount: options.balanceAmount ?? '10000', totalMarginUsed: cross ? '0' : options.position ? '2' : '0', freeCollateral: options.freeCollateral !== undefined ? options.freeCollateral : options.stale && cross ? null : '9995' }, cross: { positionIds: cross ? [position.id] : [], evaluatedAt, markState: instrument.markState, metrics: options.stale ? null : { crossBaseCollateral: options.crossBase ?? '10000', crossUnrealizedPnl: '-2', crossEquity: '9998', crossInitialMarginRequirement: '2.02', crossMaintenanceRequirement: '1.21', crossFreeCollateral: '9995.98', liquidationBuffer: options.liquidationBuffer ?? '9996.79' } } },
    executions: { tradingAccountId: accountId, pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null }, executions: [{ id: 'execution', instrument, operation: 'open', direction: position.direction, quantity: '2', executionPrice: '100', realizedPnl: '0', feeAmount: '0.2', executedAt: at }] },
    liquidations: { tradingAccountId: accountId, pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null }, liquidations: [{ id: 'liquidation', marginMode: position.marginMode, realizedPnl: '-200', feeAmount: '0.2', settledFee: '0.1', settledCash: '-2', bankruptcyShortfall: '198.2', executedAt: at, closes: [{ positionId: 'old-position', instrumentId: 'btc', direction: 'long', quantity: '2', executionPrice: '0.1', markSnapshot: { symbol: 'BTCUSDT' } }] }] },
    final: { tradingAccountId: accountId, settlement: null },
  };
}
const accounts = [
  { id: 'A', mode: 'general', status: 'active', season: null },
  { id: 'B', mode: 'season', status: 'active', season: { seasonId: 'season', seasonName: '테스트 시즌', seasonStatus: 'active', participantStatus: 'active', startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() } },
];
// Contract chart (GET /futures/instruments/:id/candles) at one 봉 시간: three
// closed buckets and the provisional current one.
const INTERVAL_MS = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const INTERVAL_RANGE = { '5m': '2d', '15m': '3d', '30m': '14d', '1h': '14d', '4h': '96d', '1d': '1y' };
function futuresCandlesFixture(instrumentId, now = Date.now(), interval = '4h') {
  const H4 = INTERVAL_MS[interval];
  const current = Math.floor(now / H4) * H4;
  const candles = [3, 2, 1, 0].map(back => ({
    time: new Date(current - back * H4).toISOString(),
    open: '100.00000000', high: '102.00000000', low: '99.00000000', close: '101.00000000',
    volume: '5.00000000', amount: '505.00000000', provisional: back === 0,
  }));
  return {
    state: 'available',
    instrument: { id: instrumentId, symbol: 'BTCUSDT', name: 'Bitcoin', productType: 'synthetic_perpetual', settlementCurrency: 'USD', isActive: true, displayPriceDecimals: 1 },
    priceBasis: 'contract_last_trade', range: INTERVAL_RANGE[interval], interval, candles,
    source: { provider: 'binance_usdm', endpoint: '/fapi/v1/klines', symbol: 'BTCUSDT', contractType: 'PERPETUAL', requestedCount: 600, returnedCount: candles.length, provisionalUpdatedAt: new Date(now).toISOString(),
      // As the server answers: the stored 4h history, or klines read on demand (received at `now`).
      delivery: interval === '4h' ? 'stored' : 'provider', fetchedAt: interval === '4h' ? null : new Date(now).toISOString(), stale: false },
  };
}
// What useFuturesOrderBook returns for one contract: its own USDⓈ-M ten-level
// ladder (display only). `variant`: 'book' | 'loading' | 'stale' | 'large'.
function futuresOrderBookFixture(instrumentId, variant = 'book') {
  if (variant === 'loading') return { latestOrderBook: null, statusMessage: '호가 정보를 불러오는 중입니다.' };
  const large = variant === 'large', base = instrumentId.toUpperCase(), at = new Date().toISOString();
  const level = (sign) => Array.from({ length: 10 }, (_, i) => ({
    price: ((large ? 98765432.12 : 102) + sign * (i + 1) * 0.1).toFixed(2),
    quantity: large ? '123456789.12345678' : (1.234 * (i + 1)).toFixed(3),
  }));
  return {
    latestOrderBook: { assetId: instrumentId, priceUnit: 'USDT', quantityUnit: base, marketLabel: `${base} / USDT 무기한`, asks: level(1), bids: level(-1), capturedAt: at, effectiveAt: at },
    statusMessage: variant === 'stale' ? '호가 정보가 지연되고 있습니다.' : null,
  };
}
// Futures conditional entries as the list API returns them (`?conditional=`:
// `off` → capability off, `rows` → one row per state, else none).
function futuresConditionalFixture(accountId, state, variant) {
  const at = new Date().toISOString();
  const instrument = futuresFixture(accountId).catalog.instruments[0];
  const row = (id, patch) => ({ id, tradingAccountId: accountId, instrumentId: instrument.id, instrument,
    direction: 'long', marginMode: 'isolated', leverage: 100, quantity: '123456789.12345678',
    triggerCondition: 'at_or_above', triggerPrice: '1234567890123456.12345678', executionType: 'market', limitPrice: null,
    status: 'watching', state: 'watching', trigger: null, execution: null, limitOrder: null, attemptCount: 0, lastAttemptAt: null,
    failureCode: null, terminalReason: null, createdAt: at, endedAt: null, updatedAt: at, ...patch });
  const triggered = { triggeredAt: at, snapshotId: 'snapshot', evidence: null };
  const rows = variant !== 'rows' ? [] : state === 'open' ? [
    row('watching', { instrument: { ...instrument, underlying: { ...instrument.underlying, name: '아주 긴 이름을 가진 무기한 선물 계약 Example Protocol Governance Token' } } }),
    row('pending', { status: 'ordered', state: 'order_pending', direction: 'short', triggerCondition: 'at_or_below', executionType: 'limit',
      limitPrice: '1234567890123456.12345678', trigger: triggered, limitOrder: { orderId: 'limit-entry', status: 'submitted',
        limitPrice: '1234567890123456.12345678', reservedAmount: '12345678901234.12345678', executionId: null, terminalReason: null, createdAt: at, endedAt: null } }),
  ] : [
    row('filled', { status: 'ordered', state: 'filled', trigger: triggered, execution: { executionId: 'execution', positionId: 'position',
      executionPrice: '1234567890123456.12345678', quantity: '123456789.12345678', feeAmount: '12345678901.12345678', executedAt: at } }),
    row('failed', { status: 'failed', state: 'failed', trigger: triggered, failureCode: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', terminalReason: 'execution_failed', endedAt: at }),
    row('ended', { status: 'canceled', state: 'canceled', terminalReason: 'season_ended', endedAt: at }),
  ];
  return { tradingAccountId: accountId, capabilities: { enabled: variant !== 'off', canCreate: variant !== 'off', maxLivePerAccount: 20 },
    entries: rows, pagination: { limit: 100, offset: 0, total: rows.length, returned: rows.length, nextOffset: null } };
}
module.exports = {
  futuresCandlesFixture, futuresFixture, futuresOrderBookFixture, futuresConditionalFixture, accounts };
