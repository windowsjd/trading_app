import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');
const submit = TEST_IDS.order.executeSubmit;
const amount = TEST_IDS.order.quantityInput;
const shortage = (h: any) => h.node('order-balance-insufficient');

describe('spot buy: insufficient balance while typing (server still decides)', () => {
  it('a total including the fee above the available cash is shown at once and blocks submit', async (t) => {
    const h = inlineTradingHarness();
    h.usdAvailable = '100';
    h.feeRate = '0.001';
    await h.mount(); t.after(h.close);
    await h.input(amount, '100');
    assert.equal(shortage(h)?.props.children, '잔액이 부족합니다.', '100 + 0.1 fee > 100 available');
    assert.equal(h.node(submit).props.state, 'disabled');
    await h.press(submit);
    assert.equal(h.requests.length, 0, 'no quote or order is sent');
    await h.input(amount, '99');
    assert.equal(shortage(h) === undefined, true, 'correcting the amount clears it');
    assert.equal(h.node(submit).props.state, 'enabled');
  });

  it('exact fit is not insufficient; reserved cash is never spendable', async (t) => {
    const h = inlineTradingHarness();
    h.usdAvailable = '100.1';
    h.feeRate = '0.001';
    await h.mount(); t.after(h.close);
    await h.input(amount, '100');
    assert.equal(shortage(h) === undefined, true, '100.1 total fits 100.1 available');
    h.usdAvailable = '50';
    await h.update();
    assert.equal(shortage(h)?.props.children, '잔액이 부족합니다.');
  });

  it('an unknown balance never claims the order fits or fails', async (t) => {
    const h = inlineTradingHarness();
    h.usdAvailable = '1';
    h.walletState = { isError: true, error: new Error('offline') };
    await h.mount(); t.after(h.close);
    await h.input(amount, '100');
    assert.equal(shortage(h) === undefined, true);
  });
});
