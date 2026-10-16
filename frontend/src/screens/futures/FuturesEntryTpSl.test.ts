import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { futuresHarness } = require('../../../test/futuresHarness.cjs');
const { futuresFixture } = require('../../../test/futuresFixtures.cjs');

// 손절가/익절가 plans of PENDING Futures entries: a share of whatever the entry
// actually fills, activated by that fill. Fixture contract: btc, Last 102.
const OPEN = { spot: { enabled: false, canCreate: false }, futures: { enabled: true, canCreate: true }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 };
const at = '2026-10-16T00:00:00.000Z';
const words = (node: any) => [node?.props.children].flat(Infinity).filter((part: unknown) => typeof part === 'string').join('');
const limitEntry = (id: string) => ({ id, instrument: futuresFixture('A').catalog.instruments[0], direction: 'short', marginMode: 'cross',
  leverage: 37, limitPrice: '100', quantity: '1', reservedAmount: '3' });
const entryDto = (entryId: string, patch: Record<string, unknown> = {}) => ({
  entryType: 'futures_limit_order', entryId, domain: 'futures', state: 'open', supported: true, assetId: 'asset-btc',
  asset: { id: 'asset-btc', symbol: 'BTCUSDT', name: '비트코인', market: 'BINANCE', assetType: 'crypto' },
  instrumentId: 'btc', direction: 'short', executionType: 'limit', entryPrice: '100', triggerPrice: null, limitPrice: '100',
  expectedQuantity: '1', amount: null, currencyCode: 'USD', leverage: 37, legacyProtection: false, childOrderId: null, ...patch,
});
const plan = (id: string, patch: Record<string, unknown>) => ({
  id, entryType: 'futures_limit_order', entryId: 'entry', childOrderId: null, domain: 'futures', assetId: 'asset-btc', direction: 'short',
  kind: 'stop_loss', triggerCondition: 'at_or_above', triggerPrice: '105', ratioPercent: 50, status: 'pending', basisQuantity: null,
  activatedQuantity: null, fillOrderId: null, fillExecutionId: null, settingId: null, failureCode: null, terminalReason: null,
  createdAt: at, endedAt: null, updatedAt: at, ...patch,
});

test('a pending Short limit entry takes plans by share of its fill: take-profit below, stop-loss above the entry', async t => {
  const h = futuresHarness();
  h.pendingEntries = [limitEntry('entry')];
  h.entryTpSlCapabilities = OPEN;
  h.entryTpSlEntry = (id: string) => entryDto(id);
  await h.start(); t.after(h.close);
  await h.view('pending');
  assert.equal(h.node('pending-futures-entry-tp-sl').props.label, '손절가/익절가 설정');
  await h.press('pending-futures-entry-tp-sl');
  assert.equal(words(h.node('tp-sl-entry-summary')), '선물 지정가 Short 37x · 100 USD');
  assert.equal(words(h.node('tp-sl-entry-quantity')), '체결 예정 수량 1 BTC');
  await h.press('tp-sl-take-profit-toggle');
  await h.change('tp-sl-take-profit-trigger-price', '110');
  await h.press('tp-sl-take-profit-ratio-25');
  assert.equal(words(h.node('tp-sl-take-profit-error')), '익절가는 진입 가격보다 낮게 입력해주세요.');
  await h.change('tp-sl-take-profit-trigger-price', '90');
  assert.equal(h.node('tp-sl-take-profit-error') === undefined, true);
  assert.equal(words(h.node('tp-sl-take-profit-quantity')), '체결 수량의 25% · 전량 체결 시 0.25 BTC');
  await h.press('tp-sl-stop-loss-toggle');
  await h.change('tp-sl-stop-loss-trigger-price', '105');
  await h.press('tp-sl-stop-loss-ratio-100');
  assert.equal(h.node('tp-sl-submit').props.state, 'enabled');
  await h.press('tp-sl-submit');
  const created = h.requests.filter((r: { path: string }) => r.path === '/trading-accounts/A/entry-tp-sl-plans');
  assert.equal(created.length, 1);
  assert.deepEqual({ ...created[0].body, idempotencyKey: '<key>' }, {
    entryType: 'futures_limit_order', entryId: 'entry',
    takeProfit: { triggerPrice: '90', ratio: 25 }, stopLoss: { triggerPrice: '105', ratio: 100 },
    idempotencyKey: '<key>',
  });
  assert.match(created[0].body.idempotencyKey, /^entry_tp_sl_/);
  assert.equal(words(h.node('tp-sl-registered')), '익절가와 손절가를 등록했어요. 체결되면 활성화돼요.');
  // Registering plans never touched the entry itself.
  assert.equal(h.requests.some((r: { path: string }) => r.path.includes('limit-orders')), false);
});

test('a pending plan can be canceled; a filled entry sends the user to the position', async t => {
  const h = futuresHarness();
  h.pendingEntries = [limitEntry('entry')];
  h.entryTpSlCapabilities = OPEN;
  h.entryTpSlPlans = [plan('plan-1', {})];
  h.entryTpSlEntry = (id: string) => entryDto(id);
  await h.start(); t.after(h.close);
  await h.view('pending');
  assert.equal(words(h.node('pending-futures-entry-tp-sl-summary')), '손절 1건');
  await h.press('pending-futures-entry-tp-sl');
  assert.equal(words(h.node('tp-sl-plan-plan-1-state')), '체결 후 활성화');
  await h.press('tp-sl-plan-plan-1-cancel');
  if (h.node('tp-sl-plan-plan-1-confirm-cancel')) await h.press('tp-sl-plan-plan-1-confirm-cancel');
  assert.equal(h.requests.at(-1).path, '/trading-accounts/A/entry-tp-sl-plans/plan-1/cancel');
  // The same sheet over an entry that filled meanwhile: no new plan, the position takes it.
  h.entryTpSlEntry = (id: string) => entryDto(id, { state: 'filled' });
  await h.client.invalidateQueries(); await h.flush();
  assert.match(words(h.node('tp-sl-blocked')), /이미 체결된 주문이에요/);
});

test('a conditional entry and the limit entry it created share one plan set', async t => {
  const h = futuresHarness();
  h.entryTpSlCapabilities = OPEN;
  h.conditionalEntries = { open: [{
    id: 'p', tradingAccountId: 'A', instrumentId: 'btc', instrument: futuresFixture('A').catalog.instruments[0],
    direction: 'long', marginMode: 'isolated', leverage: 10, quantity: '0.50000000', triggerCondition: 'at_or_above', triggerPrice: '110.00000000',
    executionType: 'limit', limitPrice: '111.00000000', status: 'ordered', state: 'order_pending',
    trigger: { triggeredAt: at, snapshotId: 's', evidence: null },
    limitOrder: { orderId: 'limit-1', status: 'submitted', limitPrice: '111.00000000', reservedAmount: '5.60000000', executionId: null, terminalReason: null, createdAt: at, endedAt: null },
    execution: null, attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null, createdAt: at, endedAt: null, updatedAt: at,
  }], ended: [] };
  h.pendingEntries = [{ ...limitEntry('limit-1'), direction: 'long', limitPrice: '111' }];
  h.entryTpSlPlans = [plan('plan-1', { entryType: 'futures_conditional_entry', entryId: 'p', childOrderId: 'limit-1', direction: 'long',
    triggerCondition: 'at_or_below', triggerPrice: '100' })];
  await h.start(); t.after(h.close);
  await h.view('pending');
  assert.equal(words(h.node('pending-futures-limit-1-tp-sl-summary')), '손절 1건', 'the created order shows the conditional entry’s plans');
  await h.press('pending-kind-conditional');
  assert.equal(words(h.node('futures-conditional-p-tp-sl-summary')), '손절 1건');
});

test('an activation the holding rules refused stays visible as 활성화 실패 with its reason', async t => {
  const h = futuresHarness();
  h.entryTpSlCapabilities = OPEN;
  h.entryTpSlPlans = [plan('failed-1', { status: 'failed', terminalReason: 'activation_failed', failureCode: 'FUTURES_TP_SL_LIMIT_EXCEEDED',
    basisQuantity: '0.4', endedAt: at })];
  await h.start(); t.after(h.close);
  await h.view('pending');
  await h.press('pending-kind-protection');
  await h.press('entry-tp-sl-history-toggle');
  assert.equal(words(h.node('entry-tp-sl-failed-1-state')), '활성화 실패');
  assert.equal(words(h.node('entry-tp-sl-failed-1-note')), '감시 중인 설정이 너무 많아 활성화하지 못했어요.');
  assert.equal(h.node('entry-tp-sl-failed-1-cancel') === undefined, true, 'an ended plan cannot be canceled');
});
