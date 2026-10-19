import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { toRecordOrderItem } from './accountOrders.ts';
const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');
const records = load(path.resolve('src/features/record/api.ts'), { '../../services/api/client': {} });

/** An account order row as the server returns it (asset carries its listing). */
const row = (asset: Record<string, unknown>) => toRecordOrderItem({
  orderId: 'o1', side: 'buy', orderType: 'market', status: 'executed', quantity: '2', executedQuantity: '2',
  executedPrice: '200', grossAmount: '400', feeAmount: '0.4', netAmount: '400.4', currencyCode: 'USD',
  executedAt: '2026-10-17T14:00:00.000Z', submittedAt: '2026-10-17T14:00:00.000Z', assetId: 'a1', asset,
});

describe('trade history / pending order names (2026-10-18)', () => {
  it('a US listing reads by its Korean name with `(English) · SYMBOL` under it', () => {
    const display = records.getRecordOrderDisplay(row({ id: 'a1', name: 'Apple Inc.', symbol: 'AAPL', market: 'NAS', currencyCode: 'USD' }));
    assert.equal(display.name, '애플');
    assert.equal(display.symbol, '(Apple Inc.) · AAPL');
  });

  it('without its market the English name stays (never guessed from the symbol)', () => {
    const display = records.getRecordOrderDisplay(row({ id: 'a1', name: 'Apple Inc.', symbol: 'AAPL', currencyCode: 'USD' }));
    assert.equal(display.name, 'Apple Inc.');
    assert.equal(display.symbol, 'AAPL');
    const other = records.getRecordOrderDisplay(row({ id: 'a1', name: 'Apple Inc.', symbol: 'AAPL', market: 'NYS', currencyCode: 'USD' }));
    assert.equal(other.name, 'Apple Inc.', 'the same symbol on another market is another listing');
  });

  it('a domestic stock shows its KRX listing name over its code; coins keep their name and symbol lines', () => {
    const krx = records.getRecordOrderDisplay(row({ id: 'a2', name: 'Samsung Electronics', symbol: '005930', market: 'KRX', currencyCode: 'KRW' }));
    assert.deepEqual([krx.name, krx.symbol], ['삼성전자', '(005930)']);
    const coin = records.getRecordOrderDisplay(row({ id: 'a3', name: 'Bitcoin', symbol: 'BTCUSDT', market: 'BINANCE', currencyCode: 'USD' }));
    assert.deepEqual([coin.name, coin.symbol], ['Bitcoin', 'BTCUSDT']);
  });
});
