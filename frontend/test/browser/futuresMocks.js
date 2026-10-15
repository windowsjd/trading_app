import { conditionalFixture } from '../conditionalFixtures.cjs';
import { futuresFixture, accounts, futuresCandlesFixture, futuresOrderBookFixture, futuresConditionalFixture } from '../futuresFixtures.cjs';
const params = new URLSearchParams(location.search);
export const state = { accountId: params.get('account') ?? 'A', requests: [], kind: params.get('kind') ?? 'isolated', mode: params.get('mode') ?? 'ENABLED', options: { missingMark: params.get('mark') === 'missing', expiredMark: params.get('mark') === 'stale', missingReference: params.get('last') === 'missing', ...(params.has('free') ? { freeCollateral: params.get('free'), crossBase: params.get('free'), liquidationBuffer: params.get('free') } : {}) } };
export const useIsFocused = () => true;
export const useHeaderHeight = () => 64;
// Quest provider / root ref imports; inert in the isolated futures fixture.
export const createNavigationContainerRef = () => ({ isReady: () => false, navigate() {}, reset() {}, dispatch() {},
  getCurrentRoute: () => undefined, getRootState: () => undefined, addListener: () => () => {} });
export const StackActions = { push: (...payload) => ({ type: 'PUSH', payload }), pop: (count) => ({ type: 'POP', payload: { count } }),
  popToTop: () => ({ type: 'POP_TO_TOP' }), replace: (...payload) => ({ type: 'REPLACE', payload }) };
// USDⓈ-M ladder transport (`?futuresBook=loading|stale|large`).
export const useFuturesOrderBook = ({ instrumentId }) => futuresOrderBookFixture(instrumentId, params.get('futuresBook') ?? 'book');
export const useTradingAccount = () => ({ accounts, selectedAccountId: state.accountId, isLoading: false });
export const apiClient = {
  async get(path) {
    // Contract 4h chart (market data, not account-scoped).
    if (path.startsWith('/futures/instruments/') && path.includes('/candles')) return { data: { success: true, data: futuresCandlesFixture(decodeURIComponent(path.split('/')[3])) } };
    if(path.endsWith('/protections')) {
      const protection = params.get('protection');
      if(protection==='error') throw new Error('protection fixture unavailable');
      if(protection==='loading') return new Promise(()=>{});
      const id=path.split('/')[2], data=conditionalFixture(id,{enabled:!!protection&&protection!=='complete',active:protection==='active',holding:protection==='holding',complete:protection==='complete',mode:state.mode,domain:'futures'});
      return {data:{success:true,data}};
    }
    // 대기 주문 › 조건주문 also reads the Spot watches of the account (none here).
    if (path.includes('/conditional-buy-orders') || path.includes('/conditional-sell-orders'))
      return { data: { success: true, data: { tradingAccountId: path.split('/')[2], conditionalOrders: [],
        capabilities: { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20,
          condition: { enabled: true, canCreate: true, canUseLimit: true }, protection: { enabled: true, canCreate: true, canUseLimit: true } },
        pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } } } };
    if (path.includes('/conditional-entries'))
      return { data: { success: true, data: futuresConditionalFixture(path.split('/')[2], path.includes('state=ended') ? 'ended' : 'open', params.get('conditional')) } };
    // The account's fee policy (GET /trading-accounts/:id): the ratio slider keeps room for it.
    if (/^\/trading-accounts\/[^/]+$/u.test(path)) {
      const id = path.split('/')[2];
      return { data: { success: true, data: { id, mode: id === 'B' ? 'season' : 'general', status: 'active', initialCapitalKrw: '0', openedAt: '', closedAt: null,
        createdAt: '', updatedAt: '', season: null, feePolicy: { tradeFeeRate: params.get('fee') ?? '0.001000', fxFeeRate: '0.001000' } } } };
    }
    if (state.kind === 'loading') return new Promise(() => {});
    if (state.kind === 'error') throw new Error('fixture unavailable');
    const id = path.split('/')[2];
    const fixture = futuresFixture(id, { position: !['open','empty'].includes(state.kind), marginMode: state.kind === 'cross' ? 'cross' : 'isolated', mode: state.mode, stale: state.kind === 'stale', large: true, ...state.options, empty: state.kind === 'empty', direction: 'short' });
    if(path.includes('limit-orders')) return {data:{data:{tradingAccountId:id,orders:[],pagination:{limit:100,offset:0,total:0,returned:0,nextOffset:null}}}};
    if(path.endsWith('/orders')) return {data:{data:{tradingAccountId:id,orders:[],pagination:{limit:100,offset:0,total:0,returned:0,nextOffset:null}}}};
    return { data: { success: true, data: path.includes('instruments') ? fixture.catalog : path.includes('positions') ? fixture.positions : path.includes('liquidations') ? fixture.liquidations : path.includes('executions') ? fixture.executions : fixture.final } };
  },
  async post(path, body) { state.requests.push({ path, body });
    // `?execute=409|network` (+ `executeDelay` ms): a clear refusal or a lost response for 시장가 commands.
    if ((path.endsWith('/execute') || path.endsWith('/limit-orders')) && params.get('execute')) {
      await new Promise((resolve) => setTimeout(resolve, Number(params.get('executeDelay') ?? 0)));
      if (params.get('execute') === '409') throw { response: { status: 409, data: { success: false, error: { code: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', message: 'Available Futures collateral is insufficient for margin and fees.' } } } };
      if (params.get('execute') === 'network') throw new Error('Network Error');
    } if(path.includes('/conditional-entries')) return {data:{success:true,data:{tradingAccountId:path.split('/')[2],duplicate:false,entry:{id:'entry',state:path.endsWith('/cancel')?'canceled':'watching',...body}}}}; if(path.includes('/protections')) return {data:{success:true,data:{tradingAccountId:path.split('/')[2],groupId:'group',status:'active'}}}; return { data: { success: true, data: { tradingAccountId: path.split('/')[2], commandId: 'fixture',
    // The execution shape the screen reports (quest command included), as in test/futuresHarness.cjs.
    execution: { positionId: body.positionId ?? 'position', direction: body.direction ?? 'long', leverage: Number(body.leverage ?? 1),
      positionAfter: { quantity: body.operation === 'close' ? '0.00000000' : body.quantity ?? '1.00000000' }, operation: body.operation, feeAmount: '0.2' } } } }; },
};
window.futuresFixture = state;
