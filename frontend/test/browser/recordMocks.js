import { apiClient as rootClient, transport } from './rootTabsMocks';
import { futuresFixture } from '../futuresFixtures.cjs';
import ledger from '../../../backend/docs/fixtures/wallet-ledger.json';
export { transport };
const params = new URLSearchParams(location.search), long = params.get('long') === '1';

// 거래내역 > 선물 reads the existing executions/liquidations API (20 a page) and,
// for liquidation closes, the contract catalog; 지갑 원장 reads the ledger.
const at = '2026-09-01T00:00:00Z';
function futuresHistory(accountId, kind, offset) {
  const base = futuresFixture(accountId).catalog.instruments[0];
  const contract = (symbol, decimals) => ({ ...base, underlying: { ...base.underlying, symbol, displayPriceDecimals: decimals } });
  const page = (rows, nextOffset) => ({ tradingAccountId: accountId, pagination: { limit: 20, offset, total: offset + rows.length + (nextOffset ? 1 : 0), returned: rows.length, nextOffset }, [kind]: rows });
  if (params.get('futuresHistory') === 'empty') return page([], null);
  if (kind === 'executions') {
    if (offset > 0) return page([{ id: 'execution-old', instrument: contract('SOLUSDT', 3), operation: 'increase', direction: 'long', quantity: '1', executionPrice: '99.123', realizedPnl: '0', feeAmount: '0.1', executedAt: at }], null);
    return page([
      { id: 'execution-1', instrument: contract(long ? '1000000MOGUSDT' : 'BTCUSDT', long ? 7 : 2), operation: 'open', direction: 'long',
        quantity: long ? '123456789.12345678' : '2', executionPrice: long ? '1234567890123456.12345678' : '100', realizedPnl: '0',
        feeAmount: long ? '12345678901.12345678' : '0.2', executedAt: at, priceEvidence: { priceBasis: 'futures_last' } },
      { id: 'execution-2', instrument: contract(long ? '1000000MOGUSDT' : 'ETHUSDT', long ? 7 : 2), operation: 'close', direction: 'short',
        quantity: long ? '123456789.12345678' : '0.5', executionPrice: long ? '1234567890123456.12345678' : '2500.5',
        realizedPnl: long ? '-9876543210123.12345678' : '-2.5', feeAmount: long ? '12345678901.12345678' : '0.62', executedAt: at, priceEvidence: { priceBasis: 'spot_last' } },
    ], 20);
  }
  return page([{ id: 'liquidation-1', marginMode: 'cross', realizedPnl: long ? '-9876543210123456.12345678' : '-200', feeAmount: long ? '12345678901.12345678' : '0.2',
    settledFee: long ? '12345678901.12345678' : '0.1', settledCash: long ? '-1234567890123.12345678' : '-2', bankruptcyShortfall: long ? '9876543210123.12345678' : '198.2', executedAt: at,
    closes: [
      { positionId: 'old-1', instrumentId: 'btc', direction: 'long', quantity: long ? '123456789.12345678' : '2', executionPrice: long ? '1234567890123456.12' : '0.1', markSnapshot: { symbol: 'BTCUSDT' } },
      { positionId: 'old-2', instrumentId: 'unknown', direction: 'short', quantity: '1', executionPrice: '0.12345678', markSnapshot: { symbol: long ? '1000000MOGUSDT' : 'ETHUSDT' } },
    ] }], null);
}
function ledgerPage(accountId, query = {}) {
  const data = structuredClone(ledger[query.currency === 'USD' ? 'usd' : 'krw'].data);
  data.tradingAccountId = accountId;
  data.filters = { currency: query.currency ?? null, direction: query.direction ?? null, txType: query.txType ?? null };
  if (query.direction) data.transactions = data.transactions.filter((row) => row.direction === query.direction);
  data.pagination = { ...data.pagination, total: data.transactions.length, returned: data.transactions.length };
  if (long) for (const row of data.transactions) {
    row.amount = '1234567890123456.12345678'; row.balanceAfter = '9876543210123456.12345678';
    if (row.asset) row.asset = { ...row.asset, name: '대한민국 미래산업 우량주 투자기업 특별 우선주 ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
    if (row.trade) row.trade = { quantity: '123456789.12345678' };
  }
  return data;
}
export const apiClient = {
  ...rootClient,
  async get(path, config) {
    const futures = /^\/trading-accounts\/([^/]+)\/futures\/(executions|liquidations|instruments)(?:\?limit=20&offset=(\d+))?$/.exec(path);
    if (futures) {
      transport.requests.push(path);
      const [, accountId, kind, offset] = futures;
      if (params.get('futuresHistory') === 'error' && kind !== 'instruments') throw { response: { status: 503, data: { error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture' } } } };
      return { data: { success: true, data: kind === 'instruments' ? futuresFixture(decodeURIComponent(accountId)).catalog : futuresHistory(decodeURIComponent(accountId), kind, Number(offset ?? 0)) } };
    }
    if (/^\/trading-accounts\/[^/]+\/wallet-transactions$/.test(path)) {
      transport.requests.push(path);
      return { data: { success: true, data: ledgerPage(path.split('/')[2], config?.params) } };
    }
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
