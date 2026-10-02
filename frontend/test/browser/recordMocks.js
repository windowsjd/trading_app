import { apiClient as rootClient, transport } from './rootTabsMocks';
export { transport };
const params = new URLSearchParams(location.search), long = params.get('long') === '1';
export const apiClient = {
  ...rootClient,
  async get(path, config) {
    if (/^\/trading-accounts\/[^/]+\/orders$/.test(path)) {
      transport.requests.push(path);
      const orders = [1, 2].map(i => ({
        id: `order-${i}`, assetId: `asset-${i}`, asset: { name: long ? '대한민국 미래산업 우량주 투자기업 특별 우선주 ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '삼성전자', symbol: '005930' },
        side: i === 1 ? 'buy' : 'sell', orderType: 'market', status: 'executed', currencyCode: 'KRW',
        quantity: long ? '123456789.123456' : '10', executedPrice: long ? '1234567890123456' : '50000',
        grossAmount: long ? '1234567890123456' : '500000', feeAmount: '500', netAmount: long ? '1234567890123456' : '500500', submittedAt: '2026-09-01T00:00:00Z',
      }));
      return { data: { success: true, data: { tradingAccountId: path.split('/')[2], orders, pagination: { limit: 20, offset: 0, total: 2, returned: 2, nextOffset: null } } } };
    }
    return rootClient.get(path, config);
  },
};
