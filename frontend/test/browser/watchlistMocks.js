// Local REST/navigation/account boundaries for the watchlist browser check.
// The screens, rows, stars, watchlist hook and React Query are all real.
import React from 'react';
export const NavigationContext = React.createContext(undefined);
const params = new URLSearchParams(location.search);
const long = params.get('longName') === '1';
const now = new Date().toISOString();

const asset = (id, assetType, market, name, symbol, price, currency, extra = {}) => ({
  id, assetType, symbol, name, market, priceCurrency: currency, settlementCurrency: currency,
  displayPriceDecimals: currency === 'KRW' ? 0 : 2, isActive: true,
  marketStatus: assetType === 'crypto' ? 'always_open' : 'open', tradable: true,
  price: { state: 'available', currentPrice: price, priceCurrency: currency, priceKrwState: 'available',
    priceKrw: price, changeRate: '1.25', priceCapturedAt: now, priceEffectiveAt: now },
  ...extra,
});
const kr = Array.from({ length: 20 }, (_, index) => asset(`KR${index + 1}`, 'domestic_stock', 'KRX',
  index === 0 && long ? '아주 긴 이름을 가진 국내 상장 주식회사 제일우선주 Example Holdings' : `국내종목 ${index + 1}`,
  `00${index + 1}`.slice(-6), String(70000 + index * 100), 'KRW'));
// Not on the first market page: only search and the watchlist view reach it.
const deep = asset('KR-DEEP', 'domestic_stock', 'KRX', '첫 페이지 밖 종목', '009999', '12300', 'KRW');
const inactive = asset('KR-OFF', 'domestic_stock', 'KRX', '거래정지 예시 종목', '008888', '0', 'KRW', {
  isActive: false, tradable: false, tradeBlockedReason: 'ASSET_INACTIVE',
  price: { state: 'unavailable', currentPrice: null, priceCurrency: 'KRW' },
});
const us = [asset('AAPL', 'us_stock', 'NASDAQ', long ? 'Extraordinarily Long American Depositary Receipt Holdings Incorporated' : 'Apple', 'AAPL', '231.12', 'USD')];
const crypto = [asset('BTC', 'crypto', 'BINANCE', 'Bitcoin', 'BTCUSDT', '98765.12', 'USD')];
const all = [...kr, deep, inactive, ...us, ...crypto];

export const state = {
  requests: [],
  // Seeded server state; the newest item first.
  watched: (params.get('watched') ?? 'KR-DEEP,KR-OFF,KR1').split(',').filter(Boolean),
  fail: params.get('fail') ?? '',
  listFail: params.get('listFail') === '1',
  viewFail: params.get('viewFail') === '1',
  navigations: [],
};
const ok = (data) => ({ data: { success: true, data } });
const failure = (status, code) => Object.assign(new Error(code), {
  isAxiosError: true, response: { status, data: { success: false, error: { code, message: code } } },
});
const item = (id, index) => {
  const row = all.find((entry) => entry.id === id);
  return { assetId: id, symbol: row.symbol, name: row.name, market: row.market, assetType: row.assetType,
    isActive: row.isActive, addedAt: new Date(Date.now() - index * 1000).toISOString() };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const apiClient = {
  async get(path) {
    state.requests.push(`GET ${path}`);
    const url = new URL(path, 'http://fixture');
    if (url.pathname === '/me')
      return ok({ id: 'watch-user', role: 'user', nickname: '관심', email: 'w@example.test', profileImageUrl: null,
        portfolioPublic: true, status: 'active', createdAt: now });
    if (url.pathname === '/assets') {
      const type = url.searchParams.get('assetType');
      const search = url.searchParams.get('search');
      const rows = search
        ? all.filter((row) => row.isActive && (!type || row.assetType === type) && (row.name + row.symbol + row.id).includes(search))
        : { domestic_stock: kr, us_stock: us, crypto }[type] ?? [];
      return ok({ assets: rows, priceErrors: [], sortSnapshot: 'fixture',
        pagination: { offset: 0, limit: 20, total: rows.length, returned: rows.length, nextOffset: null } });
    }
    if (url.pathname === '/watchlist') {
      if (state.listFail) throw failure(503, 'INTERNAL_SERVER_ERROR');
      return ok({ items: state.watched.map(item), limit: 50 });
    }
    if (url.pathname === '/watchlist/assets') {
      await delay(120);
      if (state.viewFail) throw failure(503, 'INTERNAL_SERVER_ERROR');
      const type = url.searchParams.get('assetType');
      const rows = state.watched.map((id) => all.find((row) => row.id === id)).filter((row) => row.assetType === type);
      return ok({ state: 'available', assets: rows, priceErrors: [] });
    }
    throw failure(404, 'NOT_FOUND');
  },
  async put(path) {
    state.requests.push(`PUT ${path}`);
    await delay(150);
    const id = decodeURIComponent(path.split('/')[2]);
    if (state.fail === 'limit') throw failure(409, 'WATCHLIST_LIMIT_EXCEEDED');
    const created = !state.watched.includes(id);
    if (created) state.watched.unshift(id);
    return ok({ item: item(id, 0), created });
  },
  async delete(path) {
    state.requests.push(`DELETE ${path}`);
    await delay(150);
    const id = decodeURIComponent(path.split('/')[2]);
    const removed = state.watched.includes(id);
    state.watched = state.watched.filter((entry) => entry !== id);
    return ok({ assetId: id, removed });
  },
};

const account = { id: 'account-fixture', mode: 'general', status: 'active', season: null };
export const useTradingAccount = () => ({ accounts: [account], selectedAccountId: account.id, selectedAccount: account, isLoading: false });
export const navigation = {
  navigate: (...args) => state.navigations.push(args),
  popTo: (...args) => state.navigations.push(args),
  goBack() {}, reset() {}, setParams() {},
};
export const useRootNavigation = () => navigation;
export const useIsFocused = () => true;
export const useHeaderHeight = () => 0;
export const createNavigationContainerRef = () => ({ isReady: () => false, navigate() {}, reset() {}, dispatch() {},
  getCurrentRoute: () => undefined, getRootState: () => undefined, addListener: () => () => {} });
export const StackActions = { push: (...payload) => ({ type: 'PUSH', payload }), pop: (count) => ({ type: 'POP', payload: { count } }) };
// No socket in this check: rows show their REST price; the realtime path has its own checks.
export const buildWsUrl = () => '';
export const API_BASE_URL = 'http://fixture/api/v1';
export const WS_BASE_URL = '';
export const getAccessToken = async () => 'fixture-token';
