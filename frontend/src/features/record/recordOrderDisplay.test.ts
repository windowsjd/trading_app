import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { toRecordOrderItem } from './accountOrders.ts';
import { financial } from '../../theme/financialColors.ts';
const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');
const records = load(path.resolve('src/features/record/api.ts'), { '../../services/api/client': {} });

const display = (overrides: Record<string, unknown>) => records.getRecordOrderDisplay(toRecordOrderItem({
  orderId: 'o1', side: 'sell', orderType: 'market', status: 'executed', quantity: '2', executedPrice: '100',
  grossAmount: '200', feeAmount: '0.2', netAmount: '199.8', currencyCode: 'KRW', asset: { name: '삼성전자', symbol: '005930' },
  executedAt: '2026-11-06T00:00:00.000Z', submittedAt: '2026-11-06T00:00:00.000Z', ...overrides,
}));

describe('history row realized PnL (2026-11-06)', () => {
  it('a SELL fill shows its stored figure', () => {
    const pnl = display({ realizedPnl: '39.80000000' }).realizedPnl;
    assert.equal(pnl?.available === true && `${pnl.text}|${pnl.color}`, `+40원|${financial.rise}`);
    const limitFill = display({ orderType: 'limit', limitPrice: '90', realizedPnl: '-1.5' }).realizedPnl;
    assert.equal(limitFill?.available === true && limitFill.text, '-2원');
  });

  it('a SELL fill without a figure is unavailable (never 0)', () => {
    assert.equal(display({ realizedPnl: null }).realizedPnl?.available, false);
    assert.equal(display({}).realizedPnl?.available, false);
  });

  it('BUYs and unfilled limits have no realized PnL line', () => {
    assert.equal(display({ side: 'buy', realizedPnl: null }).realizedPnl === null, true);
    for (const status of ['submitted', 'canceled']) {
      assert.equal(display({ orderType: 'limit', status, realizedPnl: null }).realizedPnl === null, true, status);
    }
  });
});
