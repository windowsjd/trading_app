import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

const { act } = createRequire(import.meta.url)('react-test-renderer');
const children = (node: any) => [node?.props.children].flat(Infinity).join('');

// Fixture: contract btc, Futures Last 102, flat unless `position`. 이상/이하 is
// never chosen: a watch price above Last waits for a rise, below for a fall.
async function conditional(h: any, direction: 'long' | 'short', marginMode: 'cross' | 'isolated', execution: 'market' | 'limit') {
  await h.selectMethod('conditional');
  await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
  await h.choose(marginMode === 'cross' ? '교차(Cross)' : '격리(Isolated)');
  await h.setLeverage(20);
  await h.change('futures-conditional-trigger-price', direction === 'long' ? '110' : '90');
  if (execution === 'limit') {
    await h.choose('발동 후 지정가 진입');
    await h.change('futures-conditional-limit-price', direction === 'long' ? '111' : '89');
  }
  // 0.5 contracts at the basis: the watch price (시장가 after the trigger) or the limit.
  await h.amount(execution === 'limit' ? (direction === 'long' ? '55.5' : '44.5') : (direction === 'long' ? '55' : '45'));
}

for (const accountId of ['A', 'B'])
  for (const direction of ['long', 'short'] as const)
    for (const marginMode of ['cross', 'isolated'] as const)
      for (const execution of ['market', 'limit'] as const)
        test(`조건주문 ${accountId}/${direction}/${marginMode}/${execution} registers the watch with the trade card's terms`, async t => {
          const h = futuresHarness({ accountId }); await h.start(); t.after(h.close);
          await conditional(h, direction, marginMode, execution);
          assert.equal(children(h.node('futures-conditional-trigger-direction')),
            direction === 'long' ? '감시 조건 · 선물 Last 110 USD 이상 도달 시' : '감시 조건 · 선물 Last 90 USD 이하 도달 시');
          assert.equal(h.node('futures-conditional-submit').props.state, 'enabled');
          assert.match(h.node('futures-conditional-summary').props.children, direction === 'long' ? /\$110 이상가 되면 롱\(Long\)/ : /\$90 이하가 되면 숏\(Short\)/);
          await h.press('futures-conditional-submit');
          assert.equal(h.requests.length, 1);
          assert.equal(h.requests[0].path, `/trading-accounts/${accountId}/futures/conditional-entries`);
          assert.deepEqual({ ...h.requests[0].body, idempotencyKey: '<key>' }, {
            instrumentId: 'btc', direction, marginMode, leverage: 20, quantity: '0.5',
            triggerCondition: direction === 'long' ? 'at_or_above' : 'at_or_below',
            triggerPrice: direction === 'long' ? '110' : '90', executionType: execution,
            ...(execution === 'limit' ? { limitPrice: direction === 'long' ? '111' : '89' } : {}),
            idempotencyKey: '<key>',
          });
          assert.equal(typeof h.requests[0].body.idempotencyKey === 'string' && h.requests[0].body.idempotencyKey.length > 8, true);
          assert.match(h.text(), /조건주문이 등록되었습니다/);
          assert.match(h.text(), /담보를 예약하지 않습니다/);
          assert.equal(h.invalidations.some((key: string[]) => key.join('/') === `tradingAccount/futures/${accountId}`), true);
          // No market execution and no limit-entry request happened.
          assert.equal(h.requests.some((r: { path: string }) => r.path.endsWith('/execute') || r.path.includes('limit-orders')), false);
        });

test('이상/이하 follows the watch price against Futures Last; no manual choice, equal or unknown Last cannot register', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  await h.selectMethod('conditional');
  assert.equal(h.renderer.root.findAll((n: any) => n.props?.testID === 'futures-conditional-trigger').length === 0, true, 'no 이상/이하 selector');
  await h.amount('100');
  assert.equal(h.node('futures-conditional-submit').props.state, 'disabled', 'a trigger price is required');
  assert.match(h.text(), /감시가격을 입력하면 계약 수량을 계산합니다/);
  await h.change('futures-conditional-trigger-price', '102');
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '선물 Last와 같은 가격은 감시가격으로 쓸 수 없어요.', 'equal to Last 102');
  assert.equal(h.node('futures-conditional-submit').props.state, 'disabled');
  await h.change('futures-conditional-trigger-price', '100');
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '감시 조건 · 선물 Last 100 USD 이하 도달 시', 'below Last 102');
  assert.match(children(h.node('futures-conditional-summary')), /\$100 이하가 되면 롱\(Long\)/);
  assert.equal(h.node('futures-conditional-already-met') === undefined, true);
  assert.equal(h.node('futures-conditional-submit').props.state, 'enabled');
  await h.change('futures-conditional-trigger-price', '102.5');
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '감시 조건 · 선물 Last 102.5 USD 이상 도달 시', 'above Last 102');
  await h.change('futures-conditional-trigger-price', '1.123456789');
  assert.equal(h.node('futures-conditional-submit').props.state, 'disabled', 'more than 8 decimals');
  assert.equal(h.node('futures-conditional-trigger-direction') === undefined, true);
  await h.change('futures-conditional-trigger-price', '95');
  await h.choose('발동 후 지정가 진입');
  assert.equal(h.node('futures-conditional-submit').props.state, 'disabled', 'limit execution needs its price');
  await h.change('futures-conditional-limit-price', '94');
  assert.equal(h.node('futures-conditional-submit').props.state, 'enabled');
  assert.equal(h.requests.length, 0);
});

test('without a fresh Futures Last no direction is decided and nothing registers', async t => {
  const h = futuresHarness({ missingReference: true }); await h.start(); t.after(h.close);
  await h.selectMethod('conditional');
  await h.amount('100');
  await h.change('futures-conditional-trigger-price', '110');
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '선물 Last를 확인할 수 없어 감시 방향을 정할 수 없어요.');
  assert.equal(h.node('futures-conditional-submit').props.state, 'disabled');
  await h.press('futures-conditional-submit');
  assert.equal(h.requests.length, 0);
});

test('a Last move never flips the decided direction silently; sending re-decides and asks again', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  await h.selectMethod('conditional');
  await h.amount('100');
  await h.change('futures-conditional-trigger-price', '105');
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '감시 조건 · 선물 Last 105 USD 이상 도달 시');
  // Futures Last rises past the watch price after the direction was decided.
  h.options.referencePrice = '107';
  await act(async () => { await h.client.refetchQueries(); });
  await h.flush();
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '감시 조건 · 선물 Last 105 USD 이상 도달 시', 'kept, not flipped');
  assert.equal(h.node('futures-conditional-already-met') !== undefined, true, 'the crossing is shown');
  await h.press('futures-conditional-submit');
  assert.equal(h.requests.length, 0, 'the stale direction is never sent');
  assert.match(children(h.node('futures-conditional-direction-changed')), /선물 Last가 바뀌어 감시 방향이 달라졌어요/);
  assert.equal(children(h.node('futures-conditional-trigger-direction')), '감시 조건 · 선물 Last 105 USD 이하 도달 시', 're-decided from the latest Last');
  await h.press('futures-conditional-submit');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.triggerCondition, 'at_or_below');
  assert.equal(h.requests[0].body.triggerPrice, '105');
  assert.equal(h.node('futures-conditional-direction-changed') === undefined, true);
});

test('the server capability gates a new 조건주문; existing rows stay readable', async t => {
  const h = futuresHarness();
  h.conditionalCapabilities = { enabled: false, canCreate: false, maxLivePerAccount: 20 };
  await h.start(); t.after(h.close);
  await h.press('order-type-select');
  assert.equal(h.node('order-method-conditional').props.disabled, true);
  assert.equal(h.node('order-method-conditional-badge').props.children, '이용 불가');
  await h.press('order-method-conditional');
  assert.equal(h.orderType(), '시장가');
});

test('server refusals map to their reasons; a lost response replays the same key', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  await conditional(h, 'long', 'isolated', 'market');
  h.failure = { response: { status: 409, data: { success: false, error: { code: 'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET', message: 'met' } } } };
  await h.press('futures-conditional-submit');
  assert.match(h.text(), /이미 감시가격을 지나 접수하지 않았습니다/);
  assert.equal(h.requests[0].body.triggerCondition, 'at_or_above');
  h.failure = new Error('network');
  await h.press('futures-conditional-submit');
  assert.equal(h.node('futures-conditional-submit').props.label, '동일 조건주문 요청 확인');
  // The uncertain request holds the contract and method.
  assert.equal(h.node('futures-instrument-select').props.disabled, true);
  h.failure = null;
  await h.press('futures-conditional-submit');
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].body.idempotencyKey, h.requests[1].body.idempotencyKey);
  assert.notEqual(h.requests[1].body.idempotencyKey, h.requests[0].body.idempotencyKey);
  assert.match(h.text(), /조건주문이 등록되었습니다/);
});

test('a contract change starts the 조건주문 draft over', async t => {
  const h = futuresHarness({ futuresOnly: true }); await h.start(); t.after(h.close);
  await h.selectMethod('conditional');
  await h.change('futures-conditional-trigger-price', '110');
  await h.selectInstrument('hype');
  assert.equal(h.orderType(), '시장가');
  await h.selectMethod('conditional');
  assert.equal(h.node('futures-conditional-trigger-price').props.value, '');
});

const at = '2026-10-14T00:00:00.000Z';
function entry(id: string, patch: Record<string, unknown>) {
  return {
    id, tradingAccountId: 'A', instrumentId: 'btc',
    instrument: { id: 'btc', isActive: true, productType: 'synthetic_perpetual', settlementCurrency: 'USD',
      underlying: { assetId: 'asset-btc', symbol: 'BTCUSDT', name: '비트코인', market: 'BINANCE', displayPriceDecimals: 2 } },
    direction: 'long', marginMode: 'isolated', leverage: 10, quantity: '0.50000000',
    triggerCondition: 'at_or_above', triggerPrice: '110.00000000', executionType: 'market', limitPrice: null,
    status: 'watching', state: 'watching', trigger: null, execution: null, limitOrder: null,
    attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null,
    createdAt: at, endedAt: null, updatedAt: at, ...patch,
  };
}

test('대기 주문 › 조건주문 lists entries with their state and cancels the watch or its created limit entry', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  h.conditionalEntries = {
    open: [
      entry('w', {}),
      entry('p', { status: 'ordered', state: 'order_pending', executionType: 'limit', limitPrice: '111.00000000',
        trigger: { triggeredAt: at, snapshotId: 's', evidence: null },
        limitOrder: { orderId: 'limit-1', status: 'submitted', limitPrice: '111.00000000', reservedAmount: '5.60000000', executionId: null, terminalReason: null, createdAt: at, endedAt: null } }),
    ],
    ended: [
      entry('f', { status: 'failed', state: 'failed', direction: 'short', triggerCondition: 'at_or_below', triggerPrice: '90.00000000',
        trigger: { triggeredAt: at, snapshotId: 's', evidence: null }, failureCode: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', terminalReason: 'execution_failed' }),
      entry('s', { status: 'canceled', state: 'canceled', terminalReason: 'season_ended', endedAt: at }),
    ],
  };
  await h.view('pending');
  await h.press('pending-kind-conditional');
  const state = (id: string) => [h.node(`futures-conditional-${id}-state`)?.props.children].flat().join('');
  assert.equal(state('w'), '감시 중');
  assert.equal(state('p'), '발동 · 지정가 주문 대기');
  assert.equal(state('f'), '발동 후 주문 실패');
  assert.equal(state('s'), '정책에 따라 종료');
  assert.match(h.text(), /사용 가능한 선물 담보가 부족했습니다/);
  assert.match(h.text(), /시즌이 종료되어 감시를 끝냈습니다/);
  assert.equal(h.node('futures-conditional-f-cancel') === undefined, true, 'ended rows cannot be canceled');
  await h.press('futures-conditional-w-cancel');
  assert.equal(h.requests.at(-1).path, '/trading-accounts/A/futures/conditional-entries/w/cancel');
  await h.press('futures-conditional-p-cancel');
  assert.equal(h.requests.at(-1).path, '/trading-accounts/A/futures/limit-orders/limit-1/cancel');
});

test('rows of another account are never shown', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close);
  h.conditionalEntries = { open: [entry('w', {})], ended: [] };
  h.wrongScope = 'B';
  await h.view('pending');
  await h.press('pending-kind-conditional');
  assert.equal(h.node('futures-conditional-w') === undefined, true);
});
