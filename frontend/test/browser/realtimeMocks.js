// Local-only REST/auth boundaries; all runtime hooks and the shared manager are real.
export { useTradingAccount, useRootNavigation, useIsFocused, useHeaderHeight, navigation, state } from './tradingMocks';
import { apiClient as existingApi, state } from './tradingMocks';
export const buildWsUrl = () => 'ws://fixture/api/v1/ws';
export const getAccessToken = async () => 'fixture-private-token';
export const apiClient = {
  ...existingApi,
  async get(path, options) {
    if (path === '/fx/rates/current') {
      state.reads.push(path);
      return { data: { success: true, data: { state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1350',
        capturedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 300000).toISOString() } } };
    }
    return existingApi.get(path, options);
  },
};
