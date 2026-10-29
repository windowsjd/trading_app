import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getCompletedTradeDisplay } from './completedTradeDisplay.ts';

it('a completed trade reads like a holding: Korean name over its code, own currency, server figures only', () => {
  assert.deepEqual(getCompletedTradeDisplay({ kind: 'spot', assetId: 'a', symbol: '005930', name: 'Samsung Electronics', market: 'KRX',
    assetType: 'domestic_stock', currencyCode: 'KRW', buyAmount: '1061060.00000000', realizedPnl: '62815.00000005', returnRate: '5.92002337' }), {
    name: '삼성전자', subline: '(005930)', kind: '현물', direction: null, basisLabel: '매수 금액', basis: '1,061,060원',
    pnl: '+62,815원', returnRate: '+5.92%', pnlDirection: 'rise',
  });
  assert.deepEqual(getCompletedTradeDisplay({ kind: 'futures', assetId: 'b', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE', direction: 'short',
    currencyCode: 'USD', entryMargin: '10.00000000', realizedPnl: '-9.69050000', returnRate: null }), {
    name: 'Bitcoin', subline: null, kind: '선물', direction: 'short', basisLabel: '진입 증거금', basis: '$10',
    pnl: '-$9.69', returnRate: '-', pnlDirection: 'fall',
  });
});
