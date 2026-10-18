import React from 'react';
export const NavigationContext = React.createContext(undefined);
import { conditionalFixture } from '../conditionalFixtures.cjs';
import { futuresFixture, futuresCandlesFixture, futuresOrderBookFixture, futuresConditionalFixture } from '../futuresFixtures.cjs';
import { getTradingAccountCapabilities } from '../../src/features/tradingAccount/capabilities';
const params = new URLSearchParams(location.search);
const pendingSpot = params.has('pending') && !['futures-only', 'none'].includes(params.get('pendingKind'));
const pendingFutures = params.has('pending') && !['spot-only', 'none'].includes(params.get('pendingKind'));
export const state = {
  assetId: params.get('asset') ?? 'SUI',
  role: params.get('role') ?? 'user',
  accountId: 'account-fixture',
  balance: 10000,
  position: 4,
  requests: [],
  reads: [],
  stale: true,
};
const prices = {
  BTC: ['Bitcoin', '98765.12', 2],
  BNB: ['BNB', '763.79', 2],
  PEPE: ['Pepe', '0.00000381', 8],
  SUI: ['Sui', '0.8592', 4],
  币安人生: ['币安人生', '0.51', 4],
};
// `?krx=1` adds one open KRX stock (Conditional BUY / LOC screens);
// `?krxClosed=1` closes its market, `?krxPrice=<n>` sets its price.
const krxPrice = params.get('krxPrice') ?? '70000';
const krxStock = params.get('krx') === '1' ? [{
  id: 'SAMSUNG', assetType: 'domestic_stock', symbol: '005930', market: 'KRX',
  name: params.get('longName') === '1' ? '아주 긴 이름을 가진 국내 상장 주식회사 우선주 Example Holdings' : '삼성전자',
  priceCurrency: 'KRW', settlementCurrency: 'KRW', displayPriceDecimals: 0, isActive: true,
  marketStatus: params.get('krxClosed') === '1' ? 'closed' : 'open', tradable: params.get('krxClosed') !== '1',
  price: { state: 'available', currentPrice: krxPrice, priceCurrency: 'KRW', priceKrwState: 'available', priceKrw: krxPrice, changeRate: '0.43',
    priceCapturedAt: new Date().toISOString(), priceEffectiveAt: new Date().toISOString() },
}] : [];
// `?us=1` adds one open US equity served by the Tiingo trial path. Synthetic
// display values only (never provider data). `?usAsk=none` drops the ask side,
// `?usLong=1` uses long numbers, `?usClosed=1` closes the market.
const usLong = params.get('usLong') === '1';
// `?usOfficial=1` (2026-10-17): the same asset priced by the official stored
// Tiingo source, and every capability list naming US.
const usOfficial = params.get('usOfficial') === '1';
// `?usSymbol=&usMarket=&usName=` (2026-10-18): another listing under the same id, for its Korean name.
const usStock = params.get('us') === '1' || usOfficial ? [{
  id: 'AAPL', assetType: 'us_stock', symbol: params.get('usSymbol') ?? 'AAPL', market: params.get('usMarket') ?? 'NAS',
  name: params.get('usName') ?? 'Apple Inc.',
  priceCurrency: 'USD', settlementCurrency: 'USD', displayPriceDecimals: null, isActive: true,
  marketStatus: params.get('usClosed') === '1' ? 'closed' : 'open', tradable: true,
  price: { state: 'available', currentPrice: usLong ? '12345.12345600' : '247.61000000', priceCurrency: 'USD',
    priceKrwState: 'available', priceKrw: '346654.00000000', changeRate: null,
    priceCapturedAt: new Date().toISOString(), priceEffectiveAt: new Date().toISOString(), assetPriceSnapshotId: null,
    priceSource: { sourceType: 'provider_api', sourceName: usOfficial ? 'tiingo_us_reference_price' : 'tiingo_equity_reference_price', snapshotId: null,
      effectiveAt: new Date().toISOString(), capturedAt: new Date().toISOString(), fallbackUsed: false,
      fallbackReason: null, rejectedProviderReason: null, freshnessAgeSeconds: 1 } },
}] : [];
export function useAssetEstimatedQuote({ assetId, enabled }) {
  const supported = enabled && usStock.some((asset) => asset.id === assetId);
  if (!supported) return { latestEstimate: null, supported: false, statusMessage: null, runtime: {} };
  const now = new Date().toISOString();
  return {
    latestEstimate: {
      assetId, kind: 'estimated_liquidity', provider: 'tiingo', priceCurrency: 'USD', quantityUnit: 'share',
      bid: usLong ? { price: '12345.123456', size: '123456789' } : { price: '247.45', size: '300' },
      ask: params.get('usAsk') === 'none' ? { price: null, size: null }
        : usLong ? { price: '12345.987654', size: '987654321' } : { price: '247.55', size: '200' },
      spread: '0.0004', referencePrice: '247.5', effectiveAt: now, capturedAt: now,
    },
    supported: true, statusMessage: null, runtime: {},
  };
}
export const assets = Object.entries(prices).map(
  ([base, [name, price, decimals]]) => ({
    id: base,
    assetType: 'crypto',
    symbol: base + 'USDT',
    name: params.get('longName') === '1' && base === 'SUI'
      ? '아주 긴 이름을 가진 거래 대상 자산 Sui Extended Settlement Example' : name,
    market: 'BINANCE',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
    displayPriceDecimals: decimals,
    isActive: true,
    marketStatus: 'always_open',
    tradable: true,
    price: {
      state: 'available',
      currentPrice: price,
      priceCurrency: 'USD',
      priceKrwState: 'available',
      priceKrw: String(Number(price) * 1350),
      changeRate: '1.01',
      priceCapturedAt: new Date().toISOString(),
      priceEffectiveAt: new Date().toISOString(),
    },
  }),
).concat(krxStock).concat(usStock);
// `?stock=1` (A-2 stock order card): securities wallets and a stock holding
// valued in its own currency. `?otherHolding=1` adds a second KRX holding.
const stockAccount = params.get('stock') === '1';
const heldStock = () => assets.find((a) => a.id === state.assetId && a.assetType !== 'crypto');
function stockValuation(asset, quantity, averageCost) {
  const qty = Number(quantity), price = Number(asset.price.currentPrice), cost = qty * Number(averageCost);
  const value = qty * price, pnl = value - cost;
  const money = (n) => asset.settlementCurrency === 'KRW' ? String(Math.round(n)) : n.toFixed(2);
  return { state: 'available', currentPrice: asset.price.currentPrice, priceCurrency: asset.priceCurrency, assetPriceSnapshotId: 'snapshot',
    priceEffectiveAt: new Date().toISOString(), priceCapturedAt: new Date().toISOString(), priceSource: null,
    positionValue: money(value), positionValueKrw: String(Math.round(asset.settlementCurrency === 'KRW' ? value : value * 1400)),
    unrealizedPnl: money(pnl), unrealizedPnlKrw: String(Math.round(asset.settlementCurrency === 'KRW' ? pnl : pnl * 1400)),
    returnRate: cost ? (pnl / cost * 100).toFixed(2) : '0' };
}
function stockHolding(asset, quantity) {
  const averageCost = asset.assetType === 'us_stock' ? '201.3' : String(Math.round(Number(asset.price.currentPrice) * 0.94));
  return { averageCost, currencyCode: asset.settlementCurrency, valuation: stockValuation(asset, quantity, averageCost) };
}
function otherStockHolding() {
  // `?otherHolding=us`: a US listing with a Korean name (2026-10-18).
  if (params.get('otherHolding') === 'us') {
    const us = { settlementCurrency: 'USD', priceCurrency: 'USD', price: { currentPrice: '512.3' } };
    return { assetId: 'MSFT', positionId: 'other-position', symbol: 'MSFT', name: 'Microsoft Corporation', market: 'NAS', assetType: 'us_stock',
      currencyCode: 'USD', quantity: '2', averageCost: '480', realizedPnl: '0', realizedPnlKrw: '0', valuation: stockValuation(us, '2', '480') };
  }
  const asset = { settlementCurrency: 'KRW', priceCurrency: 'KRW', price: { currentPrice: '201000' } };
  return { assetId: 'HYNIX', positionId: 'other-position', symbol: '000660', name: 'SK하이닉스', market: 'KRX', assetType: 'domestic_stock',
    currencyCode: 'KRW', quantity: '3', averageCost: '180000', realizedPnl: '0', realizedPnlKrw: '0', valuation: stockValuation(asset, '3', '180000') };
}
const conditionalEnabled = params.get('conditional') === 'enabled';
// `offSession=1`: the server registers stock watches while the market is closed (2026-10-18).
const offSessionMarkets = params.get('offSession') === '1' ? { offSessionMarkets: ['KRX', ...(params.get('usOfficial') === '1' ? ['US'] : [])] } : {};
const marketClosed = params.get('krxClosed') === '1' || params.get('usClosed') === '1';
const locEnabled = params.get('loc') === 'enabled';
const conditionalRow = (id, state, extra = {}) => ({
  id, assetId: 'SUI', asset: { id: 'SUI', symbol: 'SUIUSDT', name: assets.find((a) => a.id === 'SUI').name, market: 'BINANCE', assetType: 'crypto' },
  side: 'buy', triggerCondition: 'at_or_below', triggerPrice: '0.81234567', executionType: 'limit', limitPrice: '0.80123456',
  quantity: null, amount: '1234567.12345678', currencyCode: 'USD', status: state === 'filled' || state.startsWith('order_') ? 'ordered' : state, state,
  trigger: state === 'watching' ? null : { triggeredAt: new Date().toISOString(), snapshotId: 's', evidence: null },
  order: state === 'filled' || state.startsWith('order_') ? { orderId: 'cond-order-' + id, orderType: 'limit',
    status: { filled: 'executed', order_pending: 'submitted', order_canceled: 'canceled', order_rejected: 'rejected' }[state],
    quantity: '1540000.00000000', executedQuantity: null, limitPrice: '0.80123456', executedPrice: state === 'filled' ? '0.80000000' : null, grossAmount: null,
    feeAmount: null, netAmount: null, reservedAmount: '1235801.23', cancelReason: null, submittedAt: new Date().toISOString(),
    executedAt: state === 'filled' ? new Date().toISOString() : null, canceledAt: null } : null,
  attemptCount: 1, lastAttemptAt: null, failureCode: state === 'failed' ? 'INSUFFICIENT_AVAILABLE_BALANCE' : null,
  terminalReason: state === 'failed' ? 'execution_failed' : state === 'canceled' ? 'user_canceled' : null,
  createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString(), ...extra,
});
// SELL settings: `sell=enabled` opens both families, `sellRows=1` lists one
// row per state for each family; `locSell=enabled` opens LOC SELL;
// `reserved=<n>` reports that much of the holding held by other orders.
const sellEnabled = params.get('sell') === 'enabled';
const sellAssetId = () => state.assetId;
const sellAsset = () => assets.find((a) => a.id === sellAssetId());
const sellRow = (id, kind, stateName, extra = {}) => ({
  id, assetId: sellAssetId(), asset: { id: sellAsset().id, symbol: sellAsset().symbol, name: sellAsset().name, market: sellAsset().market, assetType: sellAsset().assetType },
  side: 'sell', kind, positionId: 'spot-position', triggerCondition: kind === 'take_profit' ? 'at_or_above' : 'at_or_below',
  triggerPrice: sellAsset().assetType === 'crypto' ? '0.81234567' : '69000', executionType: stateName === 'order_pending' ? 'limit' : 'market',
  limitPrice: stateName === 'order_pending' ? (sellAsset().assetType === 'crypto' ? '0.90123456' : '71000') : null,
  quantity: '1234567.123456', currencyCode: sellAsset().settlementCurrency,
  status: stateName === 'filled' || stateName.startsWith('order_') ? 'ordered' : stateName, state: stateName,
  position: stateName === 'watching' || stateName === 'triggered'
    ? { holdingQuantity: '1234567.12345678', reservedQuantity: '1000000.00000000', availableQuantity: '234567.12345678', executableQuantity: '234567.12345600' } : null,
  executionAvailableQuantity: stateName === 'filled' ? '234567.12345678' : null,
  quantityLimited: stateName === 'filled',
  trigger: stateName === 'watching' ? null : { triggeredAt: new Date().toISOString(), snapshotId: 's', evidence: null },
  order: stateName === 'filled' || stateName.startsWith('order_') ? { orderId: 'sell-order-' + id, orderType: stateName === 'order_pending' ? 'limit' : 'market',
    status: { filled: 'executed', order_pending: 'submitted', order_canceled: 'canceled', order_rejected: 'rejected' }[stateName],
    quantity: '234567.123456', executedQuantity: stateName === 'filled' ? '234567.123456' : null, canceledQuantity: null,
    limitPrice: stateName === 'order_pending' ? '0.90123456' : null, executedPrice: stateName === 'filled' ? '0.80000000' : null,
    grossAmount: null, feeAmount: null, netAmount: null, reservedQuantity: stateName === 'order_pending' ? '234567.123456' : null,
    cancelReason: null, submittedAt: new Date().toISOString(), executedAt: stateName === 'filled' ? new Date().toISOString() : null, canceledAt: null } : null,
  attemptCount: 1, lastAttemptAt: null, failureCode: stateName === 'failed' ? 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE' : null,
  terminalReason: stateName === 'failed' ? 'quantity_unavailable' : stateName === 'canceled' ? 'position_closed' : null,
  createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString(), ...extra,
});
const sellStates = ['watching', 'triggered', 'order_pending', 'filled', 'failed', 'canceled', 'order_canceled'];
const account = {
  id: 'account-fixture',
  mode: 'general',
  status: 'active',
  season: null,
};
export const useTradingAccount = () => ({
  accounts: [account],
  selectedAccountId: state.accountId,
  selectedAccount: account,
  isLoading: false,
  capabilities: getTradingAccountCapabilities(account),
});
export const navigation = {
  navigate: (...args) => state.navigate(...args),
  popTo: (...args) => state.navigate(...args),
  goBack: () => state.navigate('AssetDetail'),
  reset: () => {},
  setParams: (params) => state.setParams(params),
};
export const useRootNavigation = () => navigation;
// Quest provider / root ref imports; inert in the isolated trading fixture.
export const createNavigationContainerRef = () => ({ isReady: () => false, navigate() {}, reset() {}, dispatch() {},
  getCurrentRoute: () => undefined, getRootState: () => undefined, addListener: () => () => {} });
export const StackActions = { push: (...payload) => ({ type: 'PUSH', payload }), pop: (count) => ({ type: 'POP', payload: { count } }),
  popToTop: () => ({ type: 'POP_TO_TOP' }), replace: (...payload) => ({ type: 'REPLACE', payload }) };
export const useIsFocused = () => true;
export const useHeaderHeight = () => 0;
export const useAssetTicker = () => ({
  latestTicker: null,
  isStale: state.stale,
  showReconnectBanner: state.stale,
});
export const useAssetCandle = () => ({
  latestCandle: null,
  isStale: state.stale,
  liveEnabled: true,
  resyncVersion: 0,
});
export const useMarketTickers = () => ({
  tickersByAssetId: new Map(),
  staleAssetIds: new Set(),
  showReconnectBanner: state.stale,
});
// USDⓈ-M ladder transport (`?futuresBook=loading|stale|large`).
export const useFuturesOrderBook = ({ instrumentId }) => futuresOrderBookFixture(instrumentId, params.get('futuresBook') ?? 'book');
export function useAssetOrderBook({ assetId }) {
  const price = Number(
    assets.find((a) => a.id === assetId)?.price.currentPrice ?? 1,
  );
  const level = (sign) =>
    Array.from({ length: 10 }, (_, i) => ({
      price: (price * (1 + sign * (i + 1) * 0.001)).toFixed(8),
      quantity: '123.456789',
    }));
  return {
    latestOrderBook: {
      assetId,
      priceUnit: 'USDT',
      quantityUnit: assetId,
      marketLabel: 'Binance Spot',
      asks: level(1),
      bids: level(-1),
      capturedAt: new Date().toISOString(),
    },
    statusMessage: null,
  };
}
const response = (data) => ({ data: { success: true, data } });
// `?plans=enabled`: 손절가/익절가 plans may be added to pending entries (Spot and Futures).
const plansEnabled = params.get('plans') === 'enabled';
const plansPage = (rows) => ({ limit: 100, offset: 0, total: rows.length, returned: rows.length, nextOffset: null });
const planCapabilities = () => ({ spot: { enabled: plansEnabled, canCreate: plansEnabled }, futures: { enabled: plansEnabled, canCreate: plansEnabled },
  canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 });
const planRows = () => params.get('planRows') === '1' ? [
  { id: 'plan-tp', entryType: 'spot_limit_order', entryId: 'buy', childOrderId: null, domain: 'spot', assetId: 'SUI', direction: 'long', kind: 'take_profit',
    triggerCondition: 'at_or_above', triggerPrice: '1234567890123457.12345678', ratioPercent: 30, status: 'pending', basisQuantity: null, activatedQuantity: null,
    fillOrderId: null, fillExecutionId: null, settingId: null, failureCode: null, terminalReason: null, createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString() },
  { id: 'plan-failed', entryType: 'spot_limit_order', entryId: 'old', childOrderId: null, domain: 'spot', assetId: 'SUI', direction: 'long', kind: 'stop_loss',
    triggerCondition: 'at_or_below', triggerPrice: '0.5', ratioPercent: 100, status: 'failed', basisQuantity: '123456789.123456', activatedQuantity: null,
    fillOrderId: 'old', fillExecutionId: null, settingId: null, failureCode: 'ENTRY_TP_SL_TOTAL_EXCEEDS_HOLDING', terminalReason: 'activation_failed',
    createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
] : [];
const spotEntry = (entryId) => ({ entryType: 'spot_limit_order', entryId, domain: 'spot', state: 'open', supported: true, assetId: 'SUI',
  asset: { id: 'SUI', symbol: 'SUIUSDT', name: assets.find((a) => a.id === 'SUI').name, market: 'BINANCE', assetType: 'crypto' }, instrumentId: null,
  direction: 'long', executionType: 'limit', entryPrice: '1234567890123456.12345678', triggerPrice: null, limitPrice: '1234567890123456.12345678',
  expectedQuantity: '123456789.12345678', amount: null, currencyCode: 'USD', leverage: null, legacyProtection: false, childOrderId: null });
export const apiClient = {
  async get(path, options = {}) {
    if (path.endsWith('/entry-tp-sl-plans')) {
      const query = options.params ?? {};
      const rows = planRows();
      if (query.entryId) return response({ tradingAccountId: state.accountId, capabilities: planCapabilities(), entry: spotEntry(query.entryId),
        plans: rows.filter((row) => row.entryId === query.entryId), pagination: plansPage([]) });
      const listed = rows.filter((row) => (query.state === 'ended') === (row.status !== 'pending'));
      return response({ tradingAccountId: state.accountId, capabilities: planCapabilities(), entry: null, plans: listed, pagination: plansPage(listed) });
    }
    if (path.includes('/futures/tp-sl-settings')) {
      // `?futuresTpSlRows=1`: live and ended settings on the fixture position (Long).
      const f = futuresFixture(state.accountId, { large: true, position: true });
      const instrument = f.catalog.instruments[0];
      const setting = (id, kind, triggerPrice, quantity, stateName, extra = {}) => ({ id, tradingAccountId: state.accountId, instrumentId: instrument.id, instrument,
        positionId: state.accountId + ':position', direction: 'long', kind, triggerCondition: kind === 'take_profit' ? 'at_or_above' : 'at_or_below',
        triggerPrice, quantity, status: stateName === 'filled' ? 'ordered' : stateName, state: stateName,
        position: { quantity: '2.00000000', executableQuantity: quantity }, execution: null, quantityLimited: false, trigger: null, entryPlanId: null,
        attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null, createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString(), ...extra });
      const rows = params.get('futuresTpSlRows') === '1' ? [
        setting('tp-1', 'take_profit', '110.12345678', '0.50000000', 'watching'),
        setting('tp-2', 'take_profit', '125.5', '1.00000000', 'watching'),
        setting('sl-1', 'stop_loss', '95.87654321', '1.00000000', 'triggered'),
      ] : [];
      return response({ tradingAccountId: state.accountId, capabilities: { enabled: plansEnabled, canCreate: plansEnabled, canCancel: true, maxLivePerAccount: 30 },
        settings: (options.params ?? {}).state === 'ended' ? [] : rows, pagination: plansPage(rows) });
    }
    if (path === '/fx/rates/current')
      return response({ state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1400', validUntil: new Date(Date.now() + 60000).toISOString() });
    // Contract 4h chart (market data, not account-scoped).
    if (path.startsWith('/futures/instruments/') && path.includes('/candles')) return { data: { success: true, data: futuresCandlesFixture(decodeURIComponent(path.split('/')[3])) } };
    if(path.endsWith('/protections')) {
      const protection = params.get('protection');
      if(protection==='error') throw new Error('protection fixture unavailable');
      if(protection==='loading') return new Promise(()=>{});
      const id=path.split('/')[2], data=conditionalFixture(id,{enabled:!!protection,active:protection==='active',holding:protection==='holding',mode:state.mode,domain:'spot'});
      return {data:{success:true,data}};
    }
    if (path.endsWith('/conditional-buy-orders')) {
      const id = path.split('/')[2];
      // `conditionalRows=1`: one row per state; `many`: old open rows behind 35 newer ended rows.
      const kind = params.get('conditionalRows');
      const all = kind === '1'
        ? ['watching', 'triggered', 'order_pending', 'filled', 'failed', 'canceled', 'order_canceled', 'order_rejected'].map((s) => conditionalRow('cb-' + s, s))
        : kind === 'many'
          ? [...Array.from({ length: 35 }, (_, i) => conditionalRow('end-' + i, ['filled', 'canceled', 'failed', 'order_canceled'][i % 4])),
            ...['order_pending', 'triggered', 'watching'].map((s) => conditionalRow('old-' + s, s))]
          : [];
      const open = new Set(['watching', 'triggered', 'order_pending']);
      const query = options.params ?? {};
      const rows = query.state === 'open' ? all.filter((r) => open.has(r.state))
        : query.state === 'ended' ? all.filter((r) => !open.has(r.state))
        : query.history === 'true' ? all : all.filter((r) => r.state === 'watching' || r.state === 'triggered');
      const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 30);
      const page = rows.slice(offset, offset + limit);
      // `usOfficial=1`: the server lists US (US_STOCK_PRICE_PROVIDER=tiingo, 2026-10-17).
      return response({ tradingAccountId: id, capabilities: { enabled: conditionalEnabled, canCreate: conditionalEnabled, canCancel: true,
        canUseLimit: conditionalEnabled && params.get('conditionalLimit') !== 'off', markets: ['KRX', 'CRYPTO_SPOT', ...(usOfficial ? ['US'] : [])], ...offSessionMarkets, maxLivePerAccount: 20 },
        conditionalOrders: page, pagination: { limit, offset, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null } });
    }
    if (path.endsWith('/order-capabilities')) {
      const id = path.split('/')[2];
      // `limitSell=enabled`: limits are registered AND matched, so a SELL limit is offered (2026-10-18).
      return response({ tradingAccountId: id, limitOrder: { enabled: true, autoExecutionEnabled: params.get('limitSell') === 'enabled' },
        limitOnClose: { enabled: locEnabled, markets: ['KRX', ...(usOfficial ? ['US'] : [])], sides: ['buy'], attachedProtection: false },
        limitOnCloseSell: { enabled: params.get('locSell') === 'enabled', markets: ['KRX', ...(usOfficial ? ['US'] : [])] } });
    }
    if (path.endsWith('/conditional-sell-orders')) {
      const id = path.split('/')[2];
      const all = params.get('sellRows') === '1'
        ? ['condition', 'stop_loss', 'take_profit'].flatMap((kind) => sellStates.map((s) => sellRow(`${kind}-${s}`, kind, s)))
        : [];
      const open = new Set(['watching', 'triggered', 'order_pending']);
      const query = options.params ?? {};
      const kindRows = all.filter((r) => !query.kind || (query.kind === 'condition' ? r.kind === 'condition' : r.kind !== 'condition'));
      const rows = query.state === 'open' ? kindRows.filter((r) => open.has(r.state))
        : query.state === 'ended' ? kindRows.filter((r) => !open.has(r.state))
        : query.history === 'true' ? kindRows : kindRows.filter((r) => r.state === 'watching' || r.state === 'triggered');
      const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 30);
      const page = rows.slice(offset, offset + limit);
      const family = { enabled: sellEnabled, canCreate: sellEnabled, canUseLimit: sellEnabled };
      return response({ tradingAccountId: id, capabilities: { enabled: sellEnabled, condition: { ...family, ...offSessionMarkets }, protection: family, canCancel: true,
        markets: ['KRX', 'CRYPTO_SPOT', ...(usOfficial ? ['US'] : [])], maxLivePerAccount: 30 },
        conditionalOrders: page, pagination: { limit, offset, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null } });
    }
    state.reads.push(path);
    const u = new URL(path, 'http://fixture'),
      parts = u.pathname.split('/'),
      asset = assets.find((a) => a.id === decodeURIComponent(parts[2] ?? ''));
    if (path === '/me' && state.role === 'error')
      throw Error('role unavailable');
    if (path === '/me')
      return response({ id: 'fixture-user', role: state.role, nickname: '투자자', email: 'fixture@example.test', profileImageUrl: null, portfolioPublic: true });
    if (parts[1] === 'assets') {
      if (!parts[2]) {
        const filtered = assets.filter(
          (a) =>
            !u.searchParams.get('search') ||
            a.symbol.includes(u.searchParams.get('search')),
        );
        return response({
          assets: filtered,
          pagination: {
            offset: 0,
            limit: 20,
            total: filtered.length,
            returned: filtered.length,
            nextOffset: null,
          },
        });
      }
      if (parts[3] === 'candles') {
        const base = Number(asset.price.currentPrice);
        return response({
          range: u.searchParams.get('range'),
          interval: u.searchParams.get('interval'),
          ...(asset.assetType === 'us_stock' ? { source: {
            provider: 'tiingo', dataset: 'equity_intraday', marketCode: 'NAS', persisted: false,
            priceAdjustment: 'raw', coverage: 'partial', requestedSessions: 96, coveredSessions: 30,
            currentCandleTime: new Date(Date.UTC(2026, 8, 1, 0, 239 * 5)).toISOString(),
          } } : {}),
          candles: Array.from({ length: params.has('emptyCandles') ? 0 : 240 }, (_, i) => ({
            time: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
            open: String(base * (0.9 + i * 0.0005)),
            high: String(base * (0.915 + i * 0.0005)),
            low: String(base * (0.885 + i * 0.0005)),
            close: String(base * ((params.has('mixedCandles') && i % 2 ? 0.895 : 0.905) + i * 0.0005)),
            volume: '100',
          })),
        });
      }
      return response({ asset });
    }
    const scoped = { state: 'available', tradingAccountId: state.accountId };
    const pagination = {limit:100,offset:0,total:0,returned:0,nextOffset:null};
    if (path.includes('/futures/conditional-entries'))
      return response(futuresConditionalFixture(state.accountId, path.includes('state=ended') ? 'ended' : 'open', params.get('conditional')));
    if(path.includes('/futures/')) {
      // `?futuresPosition=1`: one open (large) position with its card and 손절가/익절가 sheet.
      const f=futuresFixture(state.accountId,{large:true,position:params.get('futuresPosition')==='1'});
      if(path.includes('limit-orders')) return response({...scoped,orders:pendingFutures ? ['long','short'].map((direction,i)=>({id:'entry-'+direction,direction,marginMode:i?'cross':'isolated',leverage:100,quantity:'123456789.12345678',limitPrice:'1234567890123456.12345678',reservedAmount:'12345678901234.12345678',instrument:f.catalog.instruments[0]})) : [],pagination});
      return response(path.includes('/instruments')?f.catalog:path.includes('/positions')?f.positions:path.includes('/executions')?f.executions:path.includes('/liquidations')?f.liquidations:f.final);
    }
    if(path.endsWith('/orders')) return response({...scoped,orders:pendingSpot ? ['buy','sell','child'].map((id)=>({id,orderId:id,asset:{id:'SUI',symbol:'SUIUSDT',name:assets.find(a=>a.id==='SUI').name,market:'BINANCE'},side:id==='buy'?'buy':'sell',orderType:'limit',status:'submitted',quantity:'123456789.12345678',limitPrice:'1234567890123456.12345678',currencyCode:'USD',conditionalChildId:id==='child'?'child':null})) : [],pagination:{...pagination,total:pendingSpot?3:0,returned:pendingSpot?3:0}});
    if (path.endsWith('/portfolio')) return response({
      ...scoped, mode: account.mode, sectionErrors: [],
      summary: {
        totalAssetKrw: '10001000', krwCash: '1000', usdCashKrw: '9000', assetValueKrw: '9991000',
        returnRate: '1.25', returnRateMethod: 'cumulative_principal', initialFundingKrw: '10000000',
        cumulativeExternalFundingKrw: '10001000', cumulativeAdRewardKrw: '1000', investmentPnlKrw: '125000',
      },
      allocation: { state: 'available', cashKrwValue: '10000', domesticStockValueKrw: '1000', usStockValueKrw: '9900000', cryptoValueKrw: '90000' },
    });
    if (path.endsWith('/portfolio/equity')) return response({
      ...scoped, state: 'empty', mode: account.mode, granularity: 'daily', range: '30d',
      returnRateMethod: 'cumulative_principal', points: [],
    });
    if (path.endsWith('/wallets'))
      return response({
        ...scoped,
        wallets: [
          {
            // Spot crypto orders read the crypto_spot wallet.
            walletScope: 'crypto_spot',
            currencyCode: 'USD',
            balanceAmount: String(state.balance),
            reservedAmount: '0',
          },
          // `?stock=1`: the securities wallets stock orders read (A-2 card).
          ...(stockAccount ? [
            { walletScope: 'securities', currencyCode: 'KRW', balanceAmount: params.get('krwBalance') ?? '7300074', reservedAmount: '0' },
            { walletScope: 'securities', currencyCode: 'USD', balanceAmount: params.get('usdBalance') ?? '9876.54', reservedAmount: '0' },
          ] : []),
        ],
      });
    if (path.endsWith('/positions')) {
      const positions = (state.position
          ? [
              {
                ...assets.find((a) => a.id === state.assetId),
                assetId: state.assetId,
                positionId: 'spot-position',
                quantity: params.get('holding') ?? String(state.position),
                ...(params.has('reserved') ? {
                  reservedQuantity: params.get('reserved'),
                  availableQuantity: String(Math.max(0, Number(params.get('holding') ?? state.position) - Number(params.get('reserved')))),
                } : {}),
                averageCost: '0.5',
                currencyCode: 'USD',
                // `?stock=1`: a stock holding in its own currency with a live
                // valuation (fixture figures, computed here, for the 내 보유 card).
                ...(stockAccount && heldStock() ? stockHolding(heldStock(), params.get('holding') ?? String(state.position)) : {}),
                // `?valuation=1`: a live valuation (the sheet's 매도 가능 금액).
                ...(stockAccount && heldStock() ? {} : { valuation: params.get('valuation') === '1' ? (() => {
                  const held = assets.find((a) => a.id === state.assetId);
                  return { state: 'available', currentPrice: held.price.currentPrice, priceCurrency: held.priceCurrency ?? 'USD',
                    assetPriceSnapshotId: 'snapshot', priceEffectiveAt: new Date().toISOString(), priceCapturedAt: new Date().toISOString(),
                    priceSource: null, positionValue: '1', positionValueKrw: '1400', unrealizedPnl: '0', unrealizedPnlKrw: '0', returnRate: '0' };
                })() : { state: 'unavailable', reason: 'fixture', message: 'fixture' } }),
              },
            ]
          : []).concat(params.get('otherHolding') === '1' || params.get('otherHolding') === 'us' ? [otherStockHolding()] : []);
      return response({
        ...scoped,
        positions,
        pagination: {
          offset: 0,
          limit: 20,
          returned: positions.length,
          total: positions.length,
          nextOffset: null,
        },
      });
    }
    if (parts[1] === 'trading-accounts')
      return response({ ...account, feePolicy: { tradeFeeRate: '0.001' } });
    throw Error('Unexpected fixture read ' + path);
  },
  async post(path, body) {
    state.requests.push({ path, body });
    // `conditionalResult=<state>`: the create answers as a same-key replay of a watch that moved on.
    const result = params.get('conditionalResult');
    if (path.endsWith('/conditional-buy-orders'))
      return response({ tradingAccountId: state.accountId, duplicate: !!result, conditionalOrder: { ...conditionalRow('cb-new', result ?? 'watching'), ...body,
        assetId: body.assetId, limitPrice: body.limitPrice ?? null, quantity: body.quantity ?? null, amount: body.amount ?? null,
        ...(offSessionMarkets.offSessionMarkets && marketClosed ? { registeredOffSession: true } : {}) } });
    // `conditionalCancel=fail`: the cancel lost the race (the watch already ordered).
    const conditionalCancel = path.includes('/conditional-buy-orders/') && path.endsWith('/cancel');
    if (conditionalCancel && params.get('conditionalCancel') === 'fail')
      throw Object.assign(new Error('Request failed with status code 409'), { isAxiosError: true,
        response: { status: 409, data: { success: false, error: { code: 'CONDITIONAL_BUY_ALREADY_ORDERED', message: 'raw server text' } } } });
    if (conditionalCancel) return response({ tradingAccountId: state.accountId, duplicate: false, conditionalOrder: null });
    if (path.endsWith('/conditional-sell-orders')) {
      const legs = body.kind === 'condition' ? [['condition', body]]
        : [['stop_loss', body.stopLoss], ['take_profit', body.takeProfit]].filter((leg) => leg[1]);
      return response({ tradingAccountId: state.accountId, duplicate: false, conditionalOrders: legs.map(([kind, leg], i) => ({
        ...sellRow(`new-${kind}-${i}`, kind, 'watching'), triggerPrice: leg.triggerPrice, executionType: leg.executionType,
        limitPrice: leg.limitPrice ?? null, quantity: leg.quantity, position: null,
        ...(kind === 'condition' && offSessionMarkets.offSessionMarkets && marketClosed ? { registeredOffSession: true } : {}) })) });
    }
    if (path.endsWith('/entry-tp-sl-plans'))
      return response({ tradingAccountId: state.accountId, duplicate: false, entry: spotEntry(body.entryId),
        plans: [['stop_loss', body.stopLoss], ['take_profit', body.takeProfit]].filter((leg) => leg[1]).map(([kind, leg]) => ({
          id: `new-${kind}`, entryType: body.entryType, entryId: body.entryId, childOrderId: null, domain: 'spot', assetId: 'SUI', direction: 'long', kind,
          triggerCondition: kind === 'stop_loss' ? 'at_or_below' : 'at_or_above', triggerPrice: leg.triggerPrice, ratioPercent: leg.ratio, status: 'pending' })) });
    if (path.includes('/conditional-sell-orders/') && path.endsWith('/cancel'))
      return response({ tradingAccountId: state.accountId, duplicate: false, conditionalOrder: null });
    // Futures conditional entries: registration and cancel answer the watch.
    if (path.includes('/futures/conditional-entries'))
      return response({ tradingAccountId: state.accountId, duplicate: false, entry: { id: 'entry', state: path.endsWith('/cancel') ? 'canceled' : 'watching', ...body } });
    const asset = assets.find((a) => a.id === body.assetId);
    // A US LOC binds the New York session; its deadline is 23:00 New York.
    const loc = body.limitOnClose ? (asset?.assetType === 'us_stock'
      ? { market: 'US', sessionDate: '2026-10-13', sessionOpenAt: '2026-10-13T13:30:00.000Z',
        sessionCloseAt: '2026-10-13T20:00:00.000Z', evidenceDeadlineAt: '2026-10-14T03:00:00.000Z', executionPricePolicy: 'final_regular_session_close' }
      : { market: 'KRX', sessionDate: '2026-10-13', sessionOpenAt: '2026-10-13T00:00:00.000Z',
        sessionCloseAt: '2026-10-13T06:30:00.000Z', evidenceDeadlineAt: '2026-10-13T09:30:00.000Z', executionPricePolicy: 'final_regular_session_close' }) : null;
    if (path.endsWith('/quote'))
      return response({
        state: 'available',
        tradingAccountId: state.accountId,
        asset,
        side: body.side,
        orderType: body.orderType ?? 'market',
        quantity: body.quantity ?? String(Number(body.amount) / Number(body.limitPrice ?? asset.price.currentPrice)),
        amount: body.amount,
        limitPrice: body.limitPrice,
        quoteId: 'fixture-q-' + state.requests.length,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        price: asset.price.currentPrice,
        currencyCode: 'USD',
        grossAmount: '1',
        feeAmount: '.001',
        netAmount: '.999',
        reservedQuantity: body.quantity,
        ...(loc ? { limitOnClose: loc } : {}),
        // `reserved=<n>`: a LOC SELL above the unreserved part is accepted for less.
        ...(loc && body.side === 'sell' && params.has('reserved')
          && Number(body.quantity) > Number(params.get('holding') ?? state.position) - Number(params.get('reserved'))
          ? (() => {
              const accepted = String(Math.floor(Number(params.get('holding') ?? state.position) - Number(params.get('reserved'))));
              return { quantity: accepted, quantityAdjustment: { reason: 'available_quantity', requestedQuantity: body.quantity,
                acceptedQuantity: accepted, availableQuantity: accepted } };
            })()
          : {}),
      });
    return response({
      order: {
        ...body,
        orderId: 'fixture-order',
        asset,
        currencyCode: asset.settlementCurrency ?? 'USD',
        status: body.orderType === 'limit' ? 'submitted' : 'executed',
        ...(loc ? { limitOnClose: { ...loc, status: 'pending', decisionReason: null, decidedAt: null, closePrice: null,
          requestedQuantity: body.requestedQuantity ?? null } } : {}),
      },
      execution: {
        state: body.orderType === 'limit' ? 'submitted' : 'executed',
      },
      executionPolicy: {
        autoExecutionEnabled: false,
        mode: 'reservation_only',
      },
    });
  },
};
