import { getTradingAccountCapabilities } from '../../src/features/tradingAccount/capabilities';
const params = new URLSearchParams(location.search);
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
export const assets = Object.entries(prices).map(
  ([base, [name, price, decimals]]) => ({
    id: base,
    assetType: 'crypto',
    symbol: base + 'USDT',
    name,
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
);
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
};
export const useRootNavigation = () => navigation;
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
export const apiClient = {
  async get(path, options = {}) {
    state.reads.push(path);
    const u = new URL(path, 'http://fixture'),
      parts = u.pathname.split('/'),
      asset = assets.find((a) => a.id === decodeURIComponent(parts[2] ?? ''));
    if (path === '/me' && state.role === 'error')
      throw Error('role unavailable');
    if (path === '/me')
      return response({ id: 'fixture-user', role: state.role });
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
          candles: Array.from({ length: 240 }, (_, i) => ({
            time: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
            open: String(base * (0.9 + i * 0.0005)),
            high: String(base * (0.915 + i * 0.0005)),
            low: String(base * (0.885 + i * 0.0005)),
            close: String(base * (0.905 + i * 0.0005)),
            volume: '100',
          })),
        });
      }
      return response({ asset });
    }
    const scoped = { state: 'available', tradingAccountId: state.accountId };
    if (path.endsWith('/wallets'))
      return response({
        ...scoped,
        wallets: [
          {
            currencyCode: 'USD',
            balanceAmount: String(state.balance),
            reservedAmount: '0',
          },
        ],
      });
    if (path.endsWith('/positions'))
      return response({
        ...scoped,
        positions: state.position
          ? [
              {
                ...assets.find((a) => a.id === state.assetId),
                assetId: state.assetId,
                quantity: String(state.position),
                averageCost: '0.5',
                currencyCode: 'USD',
                valuation: { state: 'unavailable' },
              },
            ]
          : [],
        pagination: {
          offset: 0,
          limit: 20,
          returned: 1,
          total: 1,
          nextOffset: null,
        },
      });
    if (parts[1] === 'trading-accounts')
      return response({ ...account, feePolicy: { tradeFeeRate: '0.001' } });
    throw Error('Unexpected fixture read ' + path);
  },
  async post(path, body) {
    state.requests.push({ path, body });
    const asset = assets.find((a) => a.id === body.assetId);
    if (path.endsWith('/quote'))
      return response({
        state: 'available',
        tradingAccountId: state.accountId,
        asset,
        side: body.side,
        orderType: body.orderType ?? 'market',
        quantity: body.quantity,
        limitPrice: body.limitPrice,
        quoteId: 'fixture-q-' + state.requests.length,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        price: asset.price.currentPrice,
        currencyCode: 'USD',
        grossAmount: '1',
        feeAmount: '.001',
        netAmount: '.999',
        reservedQuantity: body.quantity,
      });
    return response({
      order: {
        ...body,
        orderId: 'fixture-order',
        asset,
        currencyCode: 'USD',
        status: body.orderType === 'limit' ? 'submitted' : 'executed',
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
