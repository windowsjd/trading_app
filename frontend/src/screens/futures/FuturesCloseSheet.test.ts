import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { futuresHarness, deferred } = require('../../../test/futuresHarness.cjs');
const { getQuestGuideFacts } = require('../../features/quest/questGuideBridge.ts');

// Fixture position: long 2 BTC isolated 100x, entry 100, Mark 101, Futures Last 102,
// Mark notional 202, Mark PnL -2.12345678, estimated closing fee 0.2.
const card = 'futures-position-A:position';
const words = (node: any) => [node?.props.children].flat(Infinity)
  .filter((part: unknown) => typeof part === 'string' || typeof part === 'number').join('');
const text = (node: any) => node ? node.findAll((n: any) => n.type === 'Text').map(words).join(' ') : '';
// Open = the sheet takes touches; this harness's motion never ends, so a closing sheet stays drawn without them.
const sheetOpen = (h: any) => h.node('futures-close-sheet')?.props.pointerEvents === 'auto';
const submit = (h: any) => h.node('futures-close-submit');
// The ratio slider's browser input (the harness's stand-in for the native one).
const slider = (h: any) => h.renderer.root.findAll((n: any) => n.type === 'input' && n.props['data-testid'] === 'futures-close-amount-slider')[0];
const refused = (code: string) => ({ response: { status: 409, data: { success: false, error: { code } } } });

async function openSheet(options: Record<string, unknown> = {}, t: any) {
  const h = futuresHarness({ position: true, ...options });
  await h.start(); t.after(h.close);
  await h.press(`${card}-close`);
  assert.equal(sheetOpen(h), true);
  return h;
}

test('the sheet reads like the reference: the position, 시장가 on Futures Last, 100% of it, its size and estimates, in Korean', async (t) => {
  const h = await openSheet({}, t);
  const sheet = h.node('futures-close-sheet');
  assert.match(text(sheet), /^포지션 종료 닫기/u, 'title');
  // The position: contract with its side box and margin, 진입가, Mark Price.
  assert.equal(words(h.node('futures-close-position-name')), '비트코인');
  assert.equal(h.node('futures-close-position-direction').props.accessibilityLabel, '롱(Long)');
  assert.match(text(h.node('futures-close-position')), /종목 비트코인 무기한 L 격리 100x/u);
  assert.equal(words(h.node('futures-close-position-entry')), '$100');
  assert.equal(words(h.node('futures-close-position-mark')), '$101');
  // The price: market only, on Futures Last.
  assert.equal(text(h.node('futures-close-price')), '시장가 선물 Last $102');
  // 100% by default: the whole position at Futures Last 102.
  assert.equal(h.node('futures-close-amount').props.value, '204');
  assert.equal(words(h.node('futures-close-amount-ratio')), '100%');
  assert.equal(h.node('futures-close-amount-ratio-100').props['aria-pressed'], true);
  assert.match(text(h.node('futures-close-amount-estimate')), /종료 수량 2 BTC 포지션 전체 · 포지션 종료로 처리돼요\./u);
  assert.equal(words(h.node('futures-close-amount-available')), '보유 2 BTC · 약 204 USD');
  // Position size and the estimates from the server's own figures (Mark).
  assert.deepEqual(['notional', 'pnl', 'fee'].map((id) => words(h.node(`futures-close-${id}`))), ['$202', '-$2.12', '$0.2']);
  assert.deepEqual([submit(h).props.label, submit(h).props.state], ['포지션 종료', 'enabled']);
  // Korean only: no exchange English left in the sheet.
  assert.equal(/Confirm|Market Price|Amount|Estimated|Entry Price|Symbol/u.test(text(sheet)), false);
});

test('a share is the existing reduce sized on Futures Last; back at 100% (or a typed whole amount) it is the close', async (t) => {
  const h = await openSheet({}, t);
  await h.press('futures-close-amount-ratio-50');
  assert.equal(h.node('futures-close-amount').props.value, '102');
  assert.match(text(h.node('futures-close-amount-estimate')), /^종료 수량 1 BTC$/u);
  assert.deepEqual(['pnl', 'fee'].map((id) => words(h.node(`futures-close-${id}`))), ['-$1.06', '$0.1'], 'half of each estimate');
  assert.equal(submit(h).props.label, '포지션 감소');
  await h.press('futures-close-submit');
  assert.deepEqual([h.requests[0].body.operation, h.requests[0].body.quantity, h.requests[0].body.positionId], ['reduce', '1', 'A:position']);
  assert.match(words(h.node('futures-close-notice')), /^포지션 감소 체결 완료/u);

  const typed = await openSheet({}, t);
  await typed.change('futures-close-amount', '204');
  assert.equal(submit(typed).props.label, '포지션 종료', 'the whole notional is the close');
  await typed.press('futures-close-submit');
  assert.deepEqual([typed.requests[0].body.operation, typed.requests[0].body.quantity], ['close', '2']);

  const back = await openSheet({}, t);
  await back.press('futures-close-amount-ratio-25');
  await back.press('futures-close-amount-ratio-100');
  assert.deepEqual([back.node('futures-close-amount').props.value, submit(back).props.label], ['204', '포지션 종료']);
});

test('more than the position, nothing or a malformed amount never sends', async (t) => {
  const h = await openSheet({}, t);
  await h.change('futures-close-amount', '300');
  assert.equal(words(h.node('futures-close-amount-error')), '보유 수량을 초과할 수 없습니다.');
  assert.deepEqual(['pnl', 'fee'].map((id) => words(h.node(`futures-close-${id}`))), ['-', '-'], 'no estimate for a refused amount');
  assert.equal(submit(h).props.state, 'disabled');
  await h.change('futures-close-amount', '');
  assert.equal(submit(h).props.state, 'disabled');
  await h.change('futures-close-amount', '1.234');
  assert.match(words(h.node('futures-close-amount-error')), /소수점 2자리/u);
  assert.equal(submit(h).props.state, 'disabled');
  await h.press('futures-close-submit');
  assert.equal(h.requests.length, 0);
});

test('without a fresh Mark the close still goes on Futures Last (estimates hidden); without a Last it cannot', async (t) => {
  const stale = await openSheet({ stale: true }, t);
  assert.equal(words(stale.node('futures-close-position-mark')), '-');
  assert.deepEqual(['notional', 'pnl', 'fee'].map((id) => words(stale.node(`futures-close-${id}`))), ['-', '-', '-']);
  assert.equal(submit(stale).props.state, 'enabled', 'risk reduction does not wait for Mark');
  await stale.press('futures-close-submit');
  assert.equal(stale.requests[0].body.operation, 'close');

  const expired = await openSheet({ stale: true, expiredReference: true }, t);
  assert.equal(text(expired.node('futures-close-price')), '시장가 선물 Last 확인 불가');
  assert.equal(words(expired.node('futures-close-blocked')), '현재 선물 Last를 확인할 수 없어 종료할 수 없어요. 잠시 후 다시 시도해 주세요.');
  assert.equal(slider(expired).props.disabled, true);
  assert.equal(submit(expired).props.state, 'disabled');
  await expired.press('futures-close-submit');
  assert.equal(expired.requests.length, 0);
});

test('REDUCE_ONLY closes; DISABLED keeps the card button off', async (t) => {
  const reduceOnly = await openSheet({ mode: 'REDUCE_ONLY' }, t);
  assert.equal(submit(reduceOnly).props.state, 'enabled');
  await reduceOnly.press('futures-close-submit');
  assert.equal(reduceOnly.requests[0].body.operation, 'close');
  const disabled = futuresHarness({ position: true, mode: 'DISABLED' });
  await disabled.start(); t.after(disabled.close);
  assert.equal(disabled.node(`${card}-close`).props.state, 'disabled');
});

test('a refusal stays in the sheet with its reason; a new press is a new request', async (t) => {
  const h = await openSheet({}, t);
  h.failure = refused('FUTURES_POSITION_NOT_FOUND');
  await h.press('futures-close-submit');
  assert.equal(sheetOpen(h), true);
  assert.equal(words(h.node('futures-close-error')), '포지션이 이미 종료되었거나 변경되었습니다. 최신 상태를 확인해주세요.');
  assert.equal(h.node('futures-order-notice') === undefined, true, 'the trade form says nothing');
  assert.equal(submit(h).props.state, 'enabled');
  h.failure = null;
  await h.press('futures-close-submit');
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[0].body.idempotencyKey, h.requests[1].body.idempotencyKey, 'a clear refusal did not fill');
  assert.equal(sheetOpen(h), false);
});

test('a lost answer is confirmed with the same request (same key) from the sheet or the form, never sent twice', async (t) => {
  const h = await openSheet({}, t);
  h.failure = new Error('network');
  h.gate = deferred();
  await h.press('futures-close-submit');
  // In flight: one request, the sheet cannot be dismissed, nothing else is sent.
  assert.equal(submit(h).props.state, 'loading');
  await h.press('futures-close-sheet-backdrop');
  assert.equal(sheetOpen(h), true, 'not dismissible while the command is in flight');
  h.gate.resolve(); await h.flush(); h.gate = null;
  assert.equal(h.requests.length, 1);
  assert.equal(submit(h).props.label, '이전 체결 결과 확인');
  assert.match(text(h.node('futures-close-uncertain')), /같은 요청으로 결과를 확인/u);
  assert.equal(h.node('futures-retry') !== undefined, true, 'the form holds the same pending result');
  assert.equal(h.node('futures-close-amount').props.editable, false, 'the request keeps its amount');
  h.failure = null;
  await h.press('futures-close-submit');
  assert.deepEqual(h.requests[1], h.requests[0]);
  assert.equal(sheetOpen(h), false);
  assert.match(words(h.node('futures-close-notice')), /체결 완료/u);
});

test('a position gone while the sheet is open (closed elsewhere) only says so', async (t) => {
  const h = await openSheet({}, t);
  h.options.position = false;
  await h.client.invalidateQueries();
  await h.flush();
  assert.equal(words(h.node('futures-close-gone')), '이 포지션은 이미 종료됐어요.');
  assert.equal(submit(h) === undefined, true);
  await h.press('futures-close-sheet-close');
  assert.equal(sheetOpen(h), false);
  assert.equal(h.requests.length, 0);
});

test('the beginner guide is told while a position sheet is open (it steps aside there)', async (t) => {
  const h = futuresHarness({ position: true });
  await h.start(); t.after(h.close);
  assert.equal(getQuestGuideFacts('futures')?.positionSheetOpen, false);
  await h.press(`${card}-close`);
  assert.equal(getQuestGuideFacts('futures')?.positionSheetOpen, true);
  await h.press('futures-close-sheet-close');
  assert.equal(getQuestGuideFacts('futures')?.positionSheetOpen, false);
  await h.press(`${card}-protection`);
  assert.equal(getQuestGuideFacts('futures')?.positionSheetOpen, true, '손절가/익절가 too');
});

test('the sheet leaves with the screen and starts at 100% again for each opening', async (t) => {
  const h = await openSheet({}, t);
  await h.press('futures-close-amount-ratio-50');
  await h.press('futures-close-sheet-close');
  assert.equal(sheetOpen(h), false);
  await h.press(`${card}-close`);
  assert.deepEqual([h.node('futures-close-amount').props.value, submit(h).props.label], ['204', '포지션 종료']);
  h.focused = false;
  await h.update();
  assert.equal(sheetOpen(h), false, 'another screen in front closes it');
});
