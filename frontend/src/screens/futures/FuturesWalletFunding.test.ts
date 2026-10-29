import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { questProgress } from '../../../test/questFixtures.ts';
const require = createRequire(import.meta.url);
const { futuresHarness, act } = { ...require('../../../test/futuresHarness.cjs'), act: require('react-test-renderer').act };

const EMPTY = '암호화폐 선물 지갑이 비어 있습니다.';
const COMMITTED = '암호화폐 선물 지갑의 금액이 모두 포지션 증거금이나 주문에 쓰이고 있어 지금 주문할 수 있는 금액이 없습니다.';
const notice = (h: any) => {
  const message = h.node('futures-wallet-funding-message');
  return message ? [message.props.children].flat().join('') : null;
};
const actions = (h: any, id = 'futures-wallet-funding') => ['transfer', 'fx'].filter((kind) => h.node(`${id}-${kind}`) !== undefined);
const panels = (h: any) => h.renderer.root.findAll((node: any) => node.type === 'WalletTransferPanel');
// Open = the sheet takes touches; this harness's motion never ends, so a closing sheet stays drawn without them.
const sheetOpen = (h: any) => h.node('futures-transfer-sheet')?.props.pointerEvents === 'auto';

test('a new entry from an empty Futures wallet says so, with 이체하기 › only (a USD transfer is its route)', async (t) => {
  const h = futuresHarness({ balanceAmount: '0.00000000', freeCollateral: '0' });
  await h.start(); t.after(h.close);
  assert.equal(notice(h), EMPTY);
  assert.deepEqual(actions(h), ['transfer']);
});

test('money held as margin or by orders is its own notice; usable money says nothing', async (t) => {
  const held = futuresHarness({ freeCollateral: '0' });
  await held.start(); t.after(held.close);
  assert.equal(notice(held), COMMITTED);
  const usable = futuresHarness();
  await usable.start(); t.after(usable.close);
  assert.equal(notice(usable), null);
  assert.deepEqual(actions(usable), []);
});

test('an unknown free collateral (Cross Mark not fresh) is never called empty or held', async (t) => {
  const h = futuresHarness({ position: true, marginMode: 'cross', stale: true });
  await h.start(); t.after(h.close);
  assert.equal(notice(h), null);
});

test('Reduce and Close need no money: only Open and Increase show the wallet', async (t) => {
  const h = futuresHarness({ position: true, balanceAmount: '0', freeCollateral: '0' });
  await h.start(); t.after(h.close);
  assert.equal(notice(h), EMPTY, 'Increase (the default with a position)');
  for (const op of ['reduce', 'close']) {
    await h.choose(op === 'reduce' ? '수량 감소(Reduce)' : '전량 종료(Close)');
    assert.equal(notice(h), null, op);
    assert.deepEqual(actions(h, 'futures-funding-actions'), [], op);
  }
});

test('이체하기 › opens the transfer sheet over the futures order, into the Futures wallet, and closes on success', async (t) => {
  const h = futuresHarness({ balanceAmount: '0', freeCollateral: '0' });
  await h.start(); t.after(h.close);
  await h.amount('50');
  await h.press('futures-wallet-funding-transfer');
  assert.equal(sheetOpen(h), true);
  assert.deepEqual(h.navigation, [], 'no page change');
  const [panel] = panels(h);
  assert.deepEqual(panel.props.initial, { source: undefined, destination: 'crypto_futures' });
  assert.equal(panel.props.onGoMarket, undefined);
  await act(async () => panel.props.onSucceeded());
  await h.flush();
  assert.equal(sheetOpen(h), false);
  assert.equal(panels(h).length, 0, 'the transfer panel is gone with its request');
  assert.equal(h.node('futures-amount').props.value, '50', 'the order amount is kept');
  assert.equal(h.requests.length, 0, 'no order was sent');
});

test('an amount beyond the free collateral offers the same route under the collateral error', async (t) => {
  const h = futuresHarness({ freeCollateral: '10' });
  await h.start(); t.after(h.close);
  assert.equal(notice(h), null);
  await h.amount('5000');
  await h.press('futures-submit');
  assert.equal(h.requests.length, 0);
  assert.deepEqual(actions(h, 'futures-funding-actions'), ['transfer']);
  await h.press('futures-funding-actions-transfer');
  assert.equal(panels(h)[0].props.initial.destination, 'crypto_futures');
});

test('leaving the screen closes the sheet; a beginner before QUEST 02 gets the lock explained instead', async (t) => {
  const h = futuresHarness({ balanceAmount: '0', freeCollateral: '0' });
  await h.start(); t.after(h.close);
  await h.press('futures-wallet-funding-transfer');
  h.focused = false; await h.update();
  assert.equal(sheetOpen(h), false);
  h.focused = true; await h.update();
  assert.equal(sheetOpen(h), false, 'not reopened on return');
  const beginner = futuresHarness({ balanceAmount: '0', freeCollateral: '0' });
  beginner.questProgress = questProgress(0);
  beginner.accountState = { selectedAccount: { id: 'A', mode: 'beginner', status: 'active', season: null } };
  await beginner.start(); t.after(beginner.close);
  await beginner.press('futures-wallet-funding-transfer');
  assert.equal(sheetOpen(beginner), false);
  assert.deepEqual(beginner.alerts.map((alert: unknown[]) => alert[1]), ['환전하기 퀘스트를 완료하면 사용할 수 있어요.']);
});
