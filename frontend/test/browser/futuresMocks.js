import { futuresFixture, accounts } from '../futuresFixtures.cjs';
const params = new URLSearchParams(location.search);
export const state = { accountId: params.get('account') ?? 'A', requests: [], kind: params.get('kind') ?? 'isolated', mode: params.get('mode') ?? 'ENABLED' };
export const useIsFocused = () => true;
export const useHeaderHeight = () => 64;
export const useTradingAccount = () => ({ accounts, selectedAccountId: state.accountId, isLoading: false });
export const apiClient = {
  async get(path) {
    if (state.kind === 'loading') return new Promise(() => {});
    if (state.kind === 'error') throw new Error('fixture unavailable');
    const id = path.split('/')[2];
    const fixture = futuresFixture(id, { position: !['open','empty'].includes(state.kind), marginMode: state.kind === 'cross' ? 'cross' : 'isolated', mode: state.mode, stale: state.kind === 'stale', large: true, empty: state.kind === 'empty', direction: 'short' });
    return { data: { success: true, data: path.includes('instruments') ? fixture.catalog : path.includes('positions') ? fixture.positions : path.includes('liquidations') ? fixture.liquidations : path.includes('executions') ? fixture.executions : fixture.final } };
  },
  async post(path, body) { state.requests.push({ path, body }); return { data: { success: true, data: { tradingAccountId: path.split('/')[2], commandId: 'fixture', execution: { operation: body.operation, feeAmount: '0.2' } } } }; },
};
window.futuresFixture = state;
