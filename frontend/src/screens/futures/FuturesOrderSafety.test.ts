import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { futuresHarness, deferred } = require('../../../test/futuresHarness.cjs');
const { COLLATERAL_SHORT, MAINTENANCE_SHORT } = require('../../features/futures/orderFeedback.ts');
const text = (h: any, id: string) => [h.node(id)?.props.children].flat().join('');
const slider = (h: any) => h.renderer.root.findAll((n: any) => n.type === 'input' && n.props['data-testid'] === 'futures-amount-slider')[0];
const refresh = async (h: any) => { await h.client.invalidateQueries(); await h.flush(); };
const refused = (code = 'INSUFFICIENT_FUTURES_FREE_COLLATERAL') => ({ response: { status: 409, data: { success: false, error: { code } } } });

for (const method of ['market', 'limit']) for (const free of ['0', '70'])
  test(`${method}: certain collateral shortage gives feedback below an enabled button with zero requests (${free})`, async t => {
    const h = futuresHarness({ freeCollateral: free, crossBase: free, liquidationBuffer: free });
    await h.start(); t.after(h.close);
    if (method === 'limit') { await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); }
    const submit = method === 'market' ? 'futures-submit' : 'futures-limit-submit';
    const notice = method === 'market' ? 'futures-order-notice' : 'futures-limit-notice';
    await h.amount('100');
    assert.equal(h.node(submit).props.state, 'enabled');
    assert.equal(h.node(notice) === undefined, true, 'the error appears on attempt');
    await h.press(submit); await h.press(submit);
    assert.equal(h.requests.length, 0);
    assert.equal(text(h, notice), COLLATERAL_SHORT);
    assert.equal(h.text().indexOf(`"testID":"${submit}"`) < h.text().indexOf(`"testID":"${notice}"`), true);
    assert.equal(h.node(submit).props.state, 'enabled');
    assert.equal(h.node('futures-amount').props.editable, true);
    if (free === '70') {
      await h.setLeverage(2);
      assert.equal(h.node(notice) === undefined, true, 'leverage clears the refusal');
      await h.press(submit);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].body.leverage, 2);
    } else {
      h.options.freeCollateral = h.options.crossBase = h.options.liquidationBuffer = '200';
      await refresh(h);
      assert.equal(h.node(notice) === undefined, true, 'a recovered balance invalidates the local refusal');
      await h.amount('50'); await h.press(submit);
      assert.equal(h.requests.length, 1);
    }
  });

test('increase refuses a known shortage; Mark risk takes precedence over zero collateral', async t => {
  const h = futuresHarness({ position: true, leverage: 10, freeCollateral: '0' });
  await h.start(); t.after(h.close); await h.amount('102'); await h.press('futures-submit');
  assert.equal(text(h, 'futures-order-notice'), COLLATERAL_SHORT);
  assert.equal(h.requests.length, 0);
  const unsafe = futuresHarness({ freeCollateral: '0' });
  await unsafe.start(); t.after(unsafe.close); await unsafe.setLeverage(100); await unsafe.amount('102');
  assert.equal(unsafe.node('futures-submit').props.state, 'disabled');
  assert.equal(text(unsafe, 'futures-collateral-insufficient'), MAINTENANCE_SHORT);
  await unsafe.press('futures-submit');
  assert.equal(unsafe.requests.length, 0);
  assert.equal(unsafe.node('futures-order-notice') === undefined, true);
});

for (const method of ['market', 'limit'])
  test(`${method}: a definitive 409 ends loading, never retries automatically, and the next attempt gets a new key`, async t => {
    const h = futuresHarness(); await h.start(); t.after(h.close);
    if (method === 'limit') { await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); }
    await h.amount('51');
    const submit = method === 'market' ? 'futures-submit' : 'futures-limit-submit';
    const notice = method === 'market' ? 'futures-order-notice' : 'futures-limit-notice';
    h.gate = deferred(); h.failure = refused();
    await h.press(submit); await h.press(submit);
    assert.equal(h.requests.length, 1);
    assert.equal(h.node(submit).props.state, 'loading');
    h.gate.resolve(); await h.flush(); h.gate = null;
    assert.equal(text(h, notice), COLLATERAL_SHORT);
    assert.equal(h.node(submit).props.state, 'enabled');
    assert.equal(h.node('futures-amount').props.editable, true);
    await h.flush(); assert.equal(h.requests.length, 1, 'no automatic resubmission');
    h.failure = null; await h.press(submit);
    assert.equal(h.requests.length, 2);
    assert.notEqual(h.requests[0].body.idempotencyKey, h.requests[1].body.idempotencyKey, 'clear refusal permits a new intent even without edits');
  });

for (const [code, reason] of [['FUTURES_MARK_STALE', /Mark 정보를/], ['FUTURES_MAINTENANCE_UNSAFE', /유지 증거금/], ['FUTURES_PRICE_UNAVAILABLE', /거래 기준 시세/]] as const)
  test(`limit: a ${code} refusal keeps its exact reason`, async t => {
    const h = futuresHarness(); await h.start(); t.after(h.close);
    await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); await h.amount('51');
    h.failure = refused(code); await h.press('futures-limit-submit');
    assert.match(text(h, 'futures-limit-notice'), reason);
    await h.amount('50');
    assert.equal(h.node('futures-limit-notice') === undefined, true);
  });

for (const method of ['market', 'limit'])
  for (const options of [{}, { missingMark: true }, { expiredMark: true }, { markPrice: '0' }, { missingReference: true }, { missingReference: true, missingMark: true }])
    test(`${method}: price evidence ${JSON.stringify(options)}`, async t => {
      const h = futuresHarness(options); await h.start(); t.after(h.close);
      if (method === 'limit') { await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); }
      await h.amount('51');
      const markMissing = options.missingMark || options.expiredMark || options.markPrice === '0';
      // Limits are quantity-priced at the user's limit, so their registration
      // still does not acquire a new Last requirement.
      const disabled = !!markMissing || (method === 'market' && !!options.missingReference);
      assert.equal(slider(h).props.disabled, disabled);
      for (const ratio of [25, 50, 75, 100]) assert.equal(h.node(`futures-ratio-${ratio}`).props.disabled, disabled);
      assert.equal(h.node(method === 'market' ? 'futures-submit' : 'futures-limit-submit').props.state, disabled ? 'disabled' : 'enabled');
      // A member's screen calls a just-missing Mark 확인 중; the technical wording waits for a lasting gap
      // (FuturesScreen.test). The restriction itself is immediate either way.
      if (markMissing) assert.equal(text(h, 'futures-ratio-reason'), '가격을 확인하는 중입니다.');
      assert.equal(h.node('futures-amount').props.value, '51', 'manual amount is preserved');
      if (disabled) {
        await h.press(method === 'market' ? 'futures-submit' : 'futures-limit-submit');
        assert.equal(h.requests.length, 0);
        assert.equal(text(h, 'futures-amount-ratio'), '0%');
      }
    });

test('expiry discards old capacity; recovery recomputes using current balance and leverage without clearing manual amount', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  await h.press('futures-ratio-50'); await h.amount('51');
  h.options.expiredMark = true; await refresh(h);
  assert.equal(slider(h).props.disabled, true);
  assert.equal(text(h, 'futures-amount-ratio'), '0%');
  await h.press('futures-ratio-100');
  assert.equal(h.node('futures-amount').props.value, '51');
  h.options.expiredMark = false;
  h.options.freeCollateral = h.options.crossBase = h.options.liquidationBuffer = '70';
  await h.setLeverage(2); await refresh(h);
  assert.equal(slider(h).props.disabled, false);
  assert.equal(h.node('futures-amount').props.value, '51');
  await h.press('futures-ratio-100');
  assert.equal(h.node('futures-amount').props.value, '139.02');
});

test('position and contract changes during Mark recovery use the selected position and instrument', async t => {
  const h = futuresHarness({ missingMark: true, futuresOnly: true }); await h.start(); t.after(h.close);
  await h.amount('51');
  h.options.position = true; h.options.leverage = 10; await refresh(h);
  assert.equal(h.node('futures-amount').props.accessibilityLabel, '추가 금액 (USD)');
  assert.equal(slider(h).props.disabled, true);
  await h.choose('수량 감소(Reduce)');
  assert.equal(slider(h).props.disabled, false, 'reduce still uses the held quantity');
  await h.press('futures-ratio-50'); assert.equal(h.node('futures-amount').props.value, '102');
  await h.selectInstrument('hype');
  assert.equal(h.node('futures-amount').props.value, '');
  assert.equal(slider(h).props.disabled, true);
  h.options.missingMark = false; await refresh(h);
  await h.amount('51'); await h.press('futures-submit');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.instrumentId, 'hype');
  assert.equal(h.requests[0].body.operation, 'open');
  assert.equal(h.requests[0].body.positionId === undefined, true);
});

for (const marginMode of ['isolated', 'cross']) for (const missing of [{ missingMark: true }, { expiredMark: true }])
  test(`${marginMode}: Reduce/Close remain available without fresh Mark (${JSON.stringify(missing)})`, async t => {
    const h = futuresHarness({ position: true, marginMode, freeCollateral: '0', ...missing }); await h.start(); t.after(h.close);
    assert.equal(slider(h).props.disabled, true, 'increase requires Mark');
    await h.choose('수량 감소(Reduce)');
    assert.equal(slider(h).props.disabled, false);
    await h.press('futures-ratio-25'); await h.press('futures-submit');
    assert.equal(h.requests[0].body.quantity, '0.5');
    assert.equal(h.requests[0].body.operation, 'reduce');
    await h.choose('전량 종료(Close)'); await h.press('futures-submit');
    assert.equal(h.requests[1].body.quantity, '2');
    assert.equal(h.requests[1].body.operation, 'close');
  });

for (const execution of ['market', 'limit'])
  test(`conditional ${execution}: registration needs neither fresh Mark nor collateral reservation`, async t => {
    const h = futuresHarness({ missingMark: true, freeCollateral: '0' }); await h.start(); t.after(h.close);
    await h.selectMethod('conditional');
    await h.change('futures-conditional-trigger-price', '110');
    if (execution === 'limit') { await h.press('futures-conditional-execution-limit'); await h.change('futures-conditional-limit-price', '100'); }
    await h.amount('100000');
    assert.equal(h.node('futures-conditional-submit').props.state, 'enabled');
    await h.press('futures-conditional-submit');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].path, '/trading-accounts/A/futures/conditional-entries');
    assert.equal(h.requests[0].body.executionType, execution);
  });

for (const mode of ['REDUCE_ONLY', 'DISABLED']) for (const method of ['market', 'limit'])
  test(`${mode}/${method}: collateral shortage never bypasses capabilities`, async t => {
    const h = futuresHarness({ mode, freeCollateral: '0' }); await h.start(); t.after(h.close);
    if (method === 'limit') { await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); }
    await h.amount('51');
    const submit = method === 'market' ? 'futures-submit' : 'futures-limit-submit';
    assert.equal(h.node(submit).props.state, 'disabled');
    await h.press(submit);
    assert.equal(h.requests.length, 0);
    assert.equal(h.node(method === 'market' ? 'futures-order-notice' : 'futures-limit-notice') === undefined, true);
  });


test('limit amount edits clear a refusal even when contract rounding leaves the quantity unchanged', async t => {
  const h = futuresHarness({ freeCollateral: '70', crossBase: '70', liquidationBuffer: '70' });
  await h.start(); t.after(h.close); await h.selectMethod('limit');
  await h.change('futures-limit-price', '1000000000'); await h.amount('100.01');
  await h.press('futures-limit-submit');
  assert.equal(text(h, 'futures-limit-notice'), COLLATERAL_SHORT);
  await h.amount('100.02');
  assert.equal(h.node('futures-limit-notice') === undefined, true);
  assert.equal(h.requests.length, 0);
});

for (const method of ['market', 'limit'])
  test(`${method}: a missing Mark and zero collateral never turn an uncertain replay into a new preflight refusal`, async t => {
    const h = futuresHarness(); await h.start(); t.after(h.close);
    if (method === 'limit') { await h.selectMethod('limit'); await h.change('futures-limit-price', '100'); }
    await h.amount('51'); h.failure = new Error('lost response');
    await h.press(method === 'market' ? 'futures-submit' : 'futures-limit-submit');
    h.options.missingMark = true; h.options.freeCollateral = '0'; await refresh(h);
    h.failure = null;
    await h.press(method === 'market' ? 'futures-retry' : 'futures-limit-submit');
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1], h.requests[0], 'reconfirm the original request and key');
  });

test('a beginner learning lock from the server reads as a learning step, not a rejected input', () => {
  const { futuresErrorMessage } = require('../../features/futures/orderFeedback.ts');
  assert.equal(futuresErrorMessage('BEGINNER_FEATURE_LOCKED', false), '학습을 더 진행하면 이용할 수 있는 기능입니다.');
  // A lost response is still the same-request check, whatever its code.
  assert.match(futuresErrorMessage('BEGINNER_FEATURE_LOCKED', true), /체결을 확인하지 못했습니다/);
});
