import React from 'react';
export const NavigationContext = React.createContext(undefined);
import { conditionalFixture } from '../conditionalFixtures.cjs';
import { futuresFixture } from '../futuresFixtures.cjs';
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
// `?krx=1` adds one open KRX stock (Conditional BUY / LOC screens).
const krxStock = params.get('krx') === '1' ? [{
  id: 'SAMSUNG', assetType: 'domestic_stock', symbol: '005930', market: 'KRX',
  name: params.get('longName') === '1' ? '아주 긴 이름을 가진 국내 상장 주식회사 우선주 Example Holdings' : '삼성전자',
  priceCurrency: 'KRW', settlementCurrency: 'KRW', displayPriceDecimals: 0, isActive: true, marketStatus: 'open', tradable: true,
  price: { state: 'available', currentPrice: '70000', priceCurrency: 'KRW', priceKrwState: 'available', priceKrw: '70000', changeRate: '0.43',
    priceCapturedAt: new Date().toISOString(), priceEffectiveAt: new Date().toISOString() },
}] : [];
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
).concat(krxStock);
const conditionalEnabled = params.get('conditional') === 'enabled';
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
      return response({ tradingAccountId: id, capabilities: { enabled: conditionalEnabled, canCreate: conditionalEnabled, canCancel: true,
        canUseLimit: conditionalEnabled && params.get('conditionalLimit') !== 'off', markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 },
        conditionalOrders: page, pagination: { limit, offset, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null } });
    }
    if (path.endsWith('/order-capabilities')) {
      const id = path.split('/')[2];
      return response({ tradingAccountId: id, limitOrder: { enabled: true, autoExecutionEnabled: false },
        limitOnClose: { enabled: locEnabled, markets: ['KRX'], sides: ['buy'], attachedProtection: false } });
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
    if(path.includes('/futures/')) {
      const f=futuresFixture(state.accountId,{large:true});
      if(path.includes('limit-orders')) return response({...scoped,orders:pendingFutures ? ['long','short'].map((direction,i)=>({id:'entry-'+direction,direction,marginMode:i?'cross':'isolated',leverage:100,quantity:'123456789.12345678',limitPrice:'1234567890123456.12345678',reservedAmount:'12345678901234.12345678',instrument:f.catalog.instruments[0]})) : [],pagination});
      return response(path.includes('/instruments')?f.catalog:path.includes('/positions')?f.positions:path.includes('/executions')?f.executions:path.includes('/liquidations')?f.liquidations:f.final);
    }
    if(path.endsWith('/orders')) return response({...scoped,orders:pendingSpot ? ['buy','sell','child'].map((id)=>({id,orderId:id,asset:{id:'SUI',symbol:'SUIUSDT',name:assets.find(a=>a.id==='SUI').name},side:id==='buy'?'buy':'sell',orderType:'limit',status:'submitted',quantity:'123456789.12345678',limitPrice:'1234567890123456.12345678',currencyCode:'USD',conditionalChildId:id==='child'?'child':null})) : [],pagination:{...pagination,total:pendingSpot?3:0,returned:pendingSpot?3:0}});
    if (path.endsWith('/portfolio')) return response({
      ...scoped, mode: account.mode, sectionErrors: [],
      summary: {
        totalAssetKrw: '10001000', krwCash: '1000', usdCashKrw: '9000', assetValueKrw: '9991000',
        returnRate: '1.25', returnRateMethod: 'time_weighted', initialFundingKrw: '10000000',
        cumulativeExternalFundingKrw: '10001000', cumulativeAdRewardKrw: '1000', investmentPnlKrw: '125000',
      },
      allocation: { state: 'available', cashKrwValue: '10000', domesticStockValueKrw: '1000', usStockValueKrw: '9900000', cryptoValueKrw: '90000' },
    });
    if (path.endsWith('/portfolio/equity')) return response({
      ...scoped, state: 'empty', mode: account.mode, granularity: 'daily', range: '30d',
      returnRateMethod: 'time_weighted', points: [],
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
                positionId: 'spot-position',
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
    // `conditionalResult=<state>`: the create answers as a same-key replay of a watch that moved on.
    const result = params.get('conditionalResult');
    if (path.endsWith('/conditional-buy-orders'))
      return response({ tradingAccountId: state.accountId, duplicate: !!result, conditionalOrder: { ...conditionalRow('cb-new', result ?? 'watching'), ...body,
        assetId: body.assetId, limitPrice: body.limitPrice ?? null, quantity: body.quantity ?? null, amount: body.amount ?? null } });
    // `conditionalCancel=fail`: the cancel lost the race (the watch already ordered).
    const conditionalCancel = path.includes('/conditional-buy-orders/') && path.endsWith('/cancel');
    if (conditionalCancel && params.get('conditionalCancel') === 'fail')
      throw Object.assign(new Error('Request failed with status code 409'), { isAxiosError: true,
        response: { status: 409, data: { success: false, error: { code: 'CONDITIONAL_BUY_ALREADY_ORDERED', message: 'raw server text' } } } });
    if (conditionalCancel) return response({ tradingAccountId: state.accountId, duplicate: false, conditionalOrder: null });
    const asset = assets.find((a) => a.id === body.assetId);
    const loc = body.limitOnClose ? { market: 'KRX', sessionDate: '2026-10-13', sessionOpenAt: '2026-10-13T00:00:00.000Z',
      sessionCloseAt: '2026-10-13T06:30:00.000Z', evidenceDeadlineAt: '2026-10-13T09:30:00.000Z', executionPricePolicy: 'final_regular_session_close' } : null;
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
      });
    return response({
      order: {
        ...body,
        orderId: 'fixture-order',
        asset,
        currencyCode: asset.settlementCurrency ?? 'USD',
        status: body.orderType === 'limit' ? 'submitted' : 'executed',
        ...(loc ? { limitOnClose: { ...loc, status: 'pending', decisionReason: null, decidedAt: null, closePrice: null } } : {}),
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
