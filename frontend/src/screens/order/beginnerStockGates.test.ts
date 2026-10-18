import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { questProgress } from '../../../test/questFixtures.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

const submit = TEST_IDS.order.executeSubmit;
const sell = TEST_IDS.assetDetail.sellButton;
const ALL = '모든 퀘스트를 완료하면 사용할 수 있어요.';

/** A beginner on a Korean stock, the market open, every method gate open on the server. */
function beginner(completed: number) {
  const h = inlineTradingHarness();
  h.accounts.push({ id: 'beginner-1', mode: 'beginner', status: 'active', season: null });
  h.accountId = 'beginner-1';
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = 'open';
  h.assets.samsung.tradable = true;
  h.positions['beginner-1'] = '3';
  h.questProgress = questProgress(completed);
  h.orderCapabilities = { tradingAccountId: 'beginner-1', limitOrder: { enabled: true, autoExecutionEnabled: true },
    limitOnClose: { enabled: true, markets: ['KRX'], sides: ['buy'], attachedProtection: false } };
  return h;
}
const learningLocked = (h: any, method: string) =>
  String(h.node(`order-method-${method}`)?.props.accessibilityLabel ?? '').includes('학습 제한');

describe('beginner staged access on a Korean stock (B차)', () => {
  it('after QUEST 06 the market BUY is the QUEST 07 practice; limit and LOC wait for every quest', async (t) => {
    const h = beginner(6);
    await h.mount(); t.after(h.close);
    assert.equal(h.node(submit).props.learningHint ?? null, null);
    await h.press('order-type-select');
    assert.deepEqual([learningLocked(h, 'market'), learningLocked(h, 'limit'), learningLocked(h, 'loc')], [false, true, true]);
    await h.press('order-method-limit');
    assert.equal(h.orderType(), '시장가', 'a locked method is not selected');
    assert.deepEqual(h.alerts.map((alert: unknown[]) => alert[1]), [ALL]);
  });

  it('a SELL: market stays risk reduction, a user limit SELL waits for every quest', async (t) => {
    const h = beginner(6);
    await h.mount(); t.after(h.close);
    await h.press(sell);
    assert.equal(h.node(submit).props.learningHint ?? null, null);
    await h.press('order-type-select');
    assert.deepEqual([learningLocked(h, 'market'), learningLocked(h, 'limit')], [false, true]);
  });

  it('QUEST 07 done: the Korean market BUY waits for every quest; all ten done opens it again', async (t) => {
    const done = beginner(7);
    await done.mount(); t.after(done.close);
    assert.equal(done.node(submit).props.learningHint, ALL);
    await done.input(TEST_IDS.order.quantityInput, '1');
    await done.press(submit); await done.flush();
    assert.equal(done.requests.length, 0, 'nothing is quoted or sent');
    const all = beginner(10);
    await all.mount(); t.after(all.close);
    assert.equal(all.node(submit).props.learningHint ?? null, null);
    await all.press('order-type-select');
    assert.deepEqual([learningLocked(all, 'limit'), learningLocked(all, 'loc')], [false, false]);
  });
});
