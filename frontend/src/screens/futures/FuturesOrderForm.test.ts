import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { futuresHarness, deferred } = require('../../../test/futuresHarness.cjs');
const { getQuestGuideFacts } = require('../../features/quest/questGuideBridge.ts');

// Fixture: contract btc, Futures Last 102, Mark 101, fee 0.1%, flat unless
// `position` (2 BTC long, 100x isolated); free collateral 9995, Cross base
// 10000, liquidation buffer 9996.79. The form opens at 1x isolated long.
const COLLATERAL_SHORT = '사용 가능한 담보가 부족합니다. 주문 금액이나 레버리지를 조정해주세요.';
type H = ReturnType<typeof futuresHarness>;
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) || {};
const text = (h: H, id: string) => [h.node(id)?.props.children].flat().join('');
const slider = (h: H, id = 'futures-amount-slider') =>
  h.renderer.root.findAll((n: any) => n.type === 'input' && n.props['data-testid'] === id)[0];
const ids = (node: any) => node.children.filter((child: any) => typeof child !== 'string').map((child: any) => child.props.testID);
const contains = (h: H, parent: string, child: string) =>
  h.node(parent).findAll((n: any) => typeof n.type === 'string' && n.props.testID === child).length;

test('the form and the book sit side by side on every phone width; wallet and lists stay full width', async t => {
  for (const dimensions of [{ width: 320, height: 640, fontScale: 2 }, { width: 360, height: 760, fontScale: 1.5 }, { width: 430, height: 932, fontScale: 1 }]) {
    const h = futuresHarness({ dimensions });
    await h.start(); t.after(h.close);
    const row = h.node('futures-trading-columns');
    assert.equal(flat(row.props.style).flexDirection, 'row', `${dimensions.width}/${dimensions.fontScale}`);
    assert.deepEqual(ids(row), ['futures-trade', 'futures-price-column']);
    assert.equal(contains(h, 'futures-price-column', 'futures-order-book-card'), 1, 'the book is the right column');
    assert.equal(contains(h, 'futures-trade', 'futures-order-book-card'), 0);
    for (const full of ['futures-wallet', 'futures-lists']) assert.equal(contains(h, 'futures-trading-columns', full), 0, full);
    // The book keeps its collapse toggle and Futures Last row.
    assert.equal(h.node('futures-order-book-toggle').props.accessibilityState.expanded, true);
    assert.equal(h.node('futures-order-book-last') !== undefined, true);
  }
});

test('removed copy: the book note and the 시장가 price box; 주문가능 shows the free collateral in USD', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  assert.doesNotMatch(h.text(), /바이낸스 USDⓈ-M 실제 호가입니다/);
  assert.doesNotMatch(h.text(), /시장가 · 선물 Last 기준 체결/);
  assert.doesNotMatch(h.text(), /가격 \(USD\)/);
  assert.equal(text(h, 'futures-available-collateral'), '주문가능 9,995 USD');
  assert.equal(h.node('futures-amount').props.placeholder, 'USD 금액');
  assert.match(h.text(), /주문 금액 \(USD\)/);
  // The wallet card keeps its own terms; Last and Mark stay distinct.
  assert.match(h.text(), /사용 가능 담보/);
  assert.match(text(h, 'futures-last-price'), /102/);
  assert.match(text(h, 'futures-mark-price'), /101/);
  const unknown = futuresHarness({ freeCollateral: null });
  await unknown.start(); t.after(unknown.close);
  assert.equal(text(unknown, 'futures-available-collateral'), '주문가능 평가 대기');
});

test('50 means $50 of BTC: the quantity is the amount over Futures Last, rounded down to 8 decimals', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  await h.amount('50');
  assert.deepEqual(h.node('futures-amount-estimate').children.map((n: any) => n.props.children),
    ['예상 수량 0.49019607 BTC', '예상 증거금 $50', '예상 수수료 $0.05']);
  await h.press('futures-submit');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.quantity, '0.49019607', 'never 50 BTC');
  assert.equal(h.requests[0].body.operation, 'open');
  assert.equal(h.requests[0].body.leverage, 1);
});

test('amount validation: a bad amount or a missing Futures Last never becomes a quantity', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  for (const amount of ['0', '1.234', 'abc']) {
    await h.amount(amount);
    assert.match(text(h, 'futures-amount-error'), /주문 금액은 0보다 큰 USD 금액으로/, amount);
    assert.equal(h.node('futures-submit').props.state, 'disabled');
  }
  const stale = futuresHarness({ expiredReference: true });
  await stale.start(); t.after(stale.close);
  await stale.amount('102');
  assert.equal(text(stale, 'futures-amount-error'), '현재 선물 Last를 확인할 수 없어 계약 수량을 계산할 수 없습니다.');
  assert.equal(stale.node('futures-amount-estimate') === undefined, true);
  assert.equal(stale.node('futures-submit').props.state, 'disabled');
  await stale.press('futures-ratio-50');
  assert.equal(text(stale, 'futures-ratio-message'), '현재 선물 Last를 확인할 수 없어 계약 수량을 계산할 수 없습니다.');
  assert.equal(stale.requests.length + h.requests.length, 0);
});

test('ratios: 25–100% of what the collateral carries after margin and fee, synced both ways, recomputed with leverage', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  // 1x isolated: 9995 / (1 + 0.001) = 9985.01…, less 0.5% headroom → 9935.08.
  for (const [ratio, amount] of [['25', '2483.77'], ['50', '4967.54'], ['75', '7451.31'], ['100', '9935.08']] as const) {
    await h.press(`futures-ratio-${ratio}`);
    assert.equal(h.node('futures-amount').props.value, amount, ratio);
    assert.equal(text(h, 'futures-amount-ratio'), `${ratio}%`);
    assert.equal(h.node(`futures-ratio-${ratio}`).props['aria-pressed'], true);
    assert.equal(slider(h).props.value, Number(ratio));
  }
  assert.equal(h.node('futures-collateral-insufficient') === undefined, true, '100% fits');
  assert.equal(h.node('futures-submit').props.state, 'enabled');
  // The slider writes the amount; a typed amount moves the ratio.
  await (async () => { const { act } = require('react-test-renderer'); await act(async () => slider(h).props.onChange({ currentTarget: { valueAsNumber: 40 } })); })();
  assert.equal(h.node('futures-amount').props.value, '3974.03');
  await h.amount('4967.54');
  assert.equal(text(h, 'futures-amount-ratio'), '50%');
  assert.equal(h.node('futures-ratio-50').props['aria-pressed'], false, 'a typed amount is not a quick ratio');
  // 10x: 9995 / 0.101 = 98960.39…, less headroom → 98465.59; the amount stays.
  await h.setLeverage(10);
  assert.equal(h.node('futures-amount').props.value, '4967.54');
  assert.equal(text(h, 'futures-amount-ratio'), '5%');
  await h.press('futures-ratio-100');
  assert.equal(h.node('futures-amount').props.value, '98465.59');
  await h.press('futures-submit');
  // 98465.59 / 102, rounded down.
  assert.equal(h.requests[0].body.quantity, '965.34892156');
  assert.equal(h.requests[0].body.leverage, 10);
});

test('isolated and cross carry different amounts: a Cross entry counts its Mark loss', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  await h.press('futures-ratio-100');
  const isolated = Number(h.node('futures-amount').props.value);
  await h.choose('교차(Cross)');
  await h.press('futures-ratio-100');
  const cross = Number(h.node('futures-amount').props.value);
  // Long with Mark 1% under Last: the Cross requirement includes that loss.
  assert.equal(cross < isolated, true);
  assert.equal(h.node('futures-collateral-insufficient') === undefined, true);
});

test('an amount above what the collateral carries is refused before the server; zero collateral too', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  // 1x: the estimated limit is 9985.01 (margin + fee use all 9995).
  await h.amount('9990');
  assert.equal(h.node('futures-collateral-insufficient') === undefined, true);
  assert.equal(h.node('futures-submit').props.state, 'enabled');
  await h.press('futures-submit');
  assert.equal(text(h, 'futures-order-notice'), COLLATERAL_SHORT);
  assert.equal(h.requests.length, 0);
  await h.amount('9985');
  assert.equal(h.node('futures-collateral-insufficient') === undefined, true);
  assert.equal(h.node('futures-submit').props.state, 'enabled');
  // The reported order: 50 BTC at 1x is about $5,100 here — far above $70 of collateral.
  const small = futuresHarness({ freeCollateral: '70', crossBase: '70', liquidationBuffer: '70' });
  await small.start(); t.after(small.close);
  await small.amount('5100');
  await small.press('futures-submit');
  assert.equal(text(small, 'futures-order-notice'), COLLATERAL_SHORT);
  assert.equal(small.requests.length, 0);
  await small.amount('50');
  assert.equal(small.node('futures-collateral-insufficient') === undefined, true, '$50 fits in $70');
  assert.equal(small.node('futures-submit').props.state, 'enabled');
});

test('a new 100x isolated long that would start under maintenance on Mark is refused with its reason', async t => {
  // Mark 101 is 1% under Last 102: 1% margin cannot cover that loss + maintenance.
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  await h.setLeverage(100);
  await h.amount('100');
  assert.equal(text(h, 'futures-collateral-insufficient'), '현재 Mark 기준으로 유지 증거금을 충족하지 못합니다. 레버리지를 낮춰주세요.');
  assert.equal(h.node('futures-submit').props.state, 'disabled');
  await h.choose('숏(Short)');
  assert.equal(h.node('futures-collateral-insufficient') === undefined, true, 'for a short that Mark is a gain');
  assert.equal(h.node('futures-submit').props.state, 'enabled');
});

test('an unknown fee rate leaves the slider unavailable with its reason; a typed amount still goes to the server', async t => {
  const h = futuresHarness();
  h.feeFailure = new Error('fee policy unavailable');
  await h.start(); t.after(h.close);
  assert.equal(slider(h).props.disabled, true);
  await h.press('futures-ratio-25');
  assert.equal(text(h, 'futures-ratio-message'), '수수료 정보를 확인할 수 없어 비율을 계산할 수 없습니다.');
  assert.equal(h.node('futures-amount').props.value, '');
  await h.amount('102');
  assert.equal(h.node('futures-ratio-message') === undefined, true);
  assert.equal(h.node('futures-submit').props.state, 'enabled');
});

test('reduce: the ratio is of the position (never the collateral); 100% is the existing 전량 종료', async t => {
  const h = futuresHarness({ position: true });
  await h.start(); t.after(h.close);
  await h.choose('수량 감소(Reduce)');
  // 2 BTC at Futures Last 102 = $204.
  assert.equal(text(h, 'futures-available-collateral'), '보유 2 BTC · 약 204 USD');
  await h.press('futures-ratio-25');
  assert.equal(h.node('futures-amount').props.value, '51');
  await h.press('futures-ratio-75');
  assert.equal(h.node('futures-amount').props.value, '153');
  await h.press('futures-submit');
  assert.equal(h.requests[0].body.operation, 'reduce');
  assert.equal(h.requests[0].body.quantity, '1.5');
  await h.choose('수량 감소(Reduce)');
  await h.press('futures-ratio-100');
  assert.equal(h.node('futures-amount') === undefined, true, '전량 종료 takes no amount');
  assert.match(text(h, 'futures-close-quantity'), /보유 수량 2 BTC 전체/);
  assert.equal(h.node('futures-operation-close') !== undefined, true);
  assert.equal(h.node('futures-submit').props.label, '롱(Long) 전량 종료');
  await h.press('futures-submit');
  assert.equal(h.requests[1].body.operation, 'close');
  assert.equal(h.requests[1].body.quantity, '2');
});

test('a typed reduce of the whole notional is shown and sent as 전량 종료; more than the position is refused', async t => {
  const h = futuresHarness({ position: true });
  await h.start(); t.after(h.close);
  await h.choose('수량 감소(Reduce)');
  await h.amount('205');
  assert.equal(text(h, 'futures-amount-error'), '보유 수량을 초과할 수 없습니다.');
  assert.equal(h.node('futures-submit').props.state, 'disabled');
  await h.amount('204');
  assert.match(h.text(), /보유 수량 전체 · 전량 종료로 처리됩니다/);
  assert.equal(h.node('futures-submit').props.label, '롱(Long) 전량 종료');
  await h.press('futures-submit');
  assert.equal(h.requests[0].body.operation, 'close');
  assert.equal(h.requests[0].body.quantity, '2');
});

test('increase uses the collateral like an entry; the position keeps direction, leverage and margin mode', async t => {
  const h = futuresHarness({ position: true, direction: 'short', marginMode: 'cross', leverage: 37 });
  await h.start(); t.after(h.close);
  assert.equal(h.node('futures-leverage-select') === undefined, true);
  assert.equal(text(h, 'futures-available-collateral'), '주문가능 9,995 USD');
  assert.equal(h.node('futures-amount').props.accessibilityLabel, '추가 금액 (USD)');
  await h.press('futures-ratio-25');
  assert.notEqual(h.node('futures-amount').props.value, '');
  await h.press('futures-submit');
  assert.deepEqual([h.requests[0].body.operation, h.requests[0].body.direction, h.requests[0].body.leverage, h.requests[0].body.marginMode],
    ['increase', 'short', 37, 'cross']);
});

test('leverage: presets, 직접 설정하기 for any integer 1–100, cancel keeps the previous value', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  assert.equal(h.leverage(), '1x');
  await h.press('futures-leverage-select');
  for (const value of [1, 2, 3, 5, 10, 25, 50, 100]) assert.equal(h.node(`futures-leverage-option-${value}`) !== undefined, true, String(value));
  assert.equal(h.node('futures-leverage-option-1').props['aria-selected'], true);
  assert.equal(getQuestGuideFacts('futures')?.leverageSheet, 'list', 'the beginner guide can follow the sheet');
  await h.press('futures-leverage-option-10');
  assert.equal(h.leverage(), '10x');
  assert.equal(h.node('futures-leverage-sheet').props.pointerEvents, 'none', 'a choice closes the list');
  assert.equal(getQuestGuideFacts('futures')?.leverageSheet === undefined, true);
  await h.press('futures-leverage-select');
  await h.press('futures-leverage-custom');
  assert.equal(h.node('futures-leverage-sheet').props.pointerEvents, 'none');
  assert.equal(h.node('futures-leverage-input').props.value, '10', 'starts from the current leverage');
  for (const invalid of ['0', '101', '', '2.5']) {
    await h.change('futures-leverage-input', invalid);
    assert.equal(h.node('futures-leverage-error') !== undefined, true, invalid);
    assert.equal(h.node('futures-leverage-apply').props.state, 'disabled', invalid);
  }
  await h.change('futures-leverage-input', '37');
  await h.press('futures-leverage-increase');
  assert.equal(h.node('futures-leverage-input').props.value, '38');
  await h.press('futures-leverage-decrease');
  const { act } = require('react-test-renderer');
  await act(async () => slider(h, 'futures-leverage-slider').props.onChange({ currentTarget: { valueAsNumber: 49 } }));
  assert.equal(h.node('futures-leverage-input').props.value, '50', 'the slider sets whole multiples');
  await h.change('futures-leverage-input', '37');
  assert.equal(h.leverage(), '10x', 'nothing applies before 설정하기');
  await h.press('futures-leverage-apply');
  assert.equal(h.leverage(), '37x');
  assert.equal(h.node('futures-leverage-custom-sheet').props.pointerEvents, 'none');
  // Closing without 설정하기 keeps 37x, and the next opening starts from it.
  await h.press('futures-leverage-select');
  await h.press('futures-leverage-custom');
  await h.change('futures-leverage-input', '80');
  await h.press('futures-leverage-custom-sheet-close');
  assert.equal(h.leverage(), '37x');
  await h.press('futures-leverage-select');
  await h.press('futures-leverage-custom');
  assert.equal(h.node('futures-leverage-input').props.value, '37');
  await h.amount('102');
  await h.press('futures-leverage-apply');
  await h.press('futures-submit');
  assert.equal(h.requests[0].body.leverage, 37);
});

test('증거금 모드 ⓘ explains 격리 and 교차 only in its help sheet; the switch is unchanged', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  assert.doesNotMatch(h.text(), /공동 담보를 교차 포지션들이 함께 사용합니다/);
  const info = h.node('futures-margin-info');
  assert.equal(info.props.accessibilityLabel, '증거금 모드 설명');
  assert.equal(info.props.hitSlop, 10, 'a small mark with a 44pt target');
  await h.press('futures-margin-info');
  assert.match(text(h, 'futures-margin-info-body') + h.text(), /해당 포지션에 배정된 증거금을 기준으로 위험을 관리합니다/);
  assert.match(h.text(), /선물 지갑의 공동 담보를 교차 포지션들이 함께 사용합니다/);
  await h.choose('교차(Cross)');
  await h.amount('102');
  await h.press('futures-submit');
  assert.equal(h.requests[0].body.marginMode, 'cross');
});

test('a clear 409 refusal shows its reason under the button, ends loading and allows an edited retry', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  await h.amount('102');
  h.gate = deferred();
  h.failure = { response: { status: 409, data: { success: false, error: { code: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', message: 'Available Futures collateral is insufficient.' } } } };
  await h.press('futures-submit');
  assert.equal(h.node('futures-submit').props.state, 'loading');
  await h.press('futures-submit');
  assert.equal(h.requests.length, 1, 'one request while in flight');
  h.gate.resolve(); await h.flush(); h.gate = null;
  assert.equal(h.node('futures-submit').props.state, 'enabled', 'the button is usable again');
  assert.equal(text(h, 'futures-order-notice'), COLLATERAL_SHORT);
  assert.equal(h.text().indexOf('"testID":"futures-submit"') < h.text().indexOf('"testID":"futures-order-notice"'), true, 'under the button');
  assert.equal(h.node('futures-retry') === undefined, true, 'a refusal is not an unknown result');
  assert.equal(h.node('futures-amount').props.editable, true);
  // Editing clears the refusal; the next order is a new request.
  await h.amount('51');
  assert.equal(h.node('futures-order-notice') === undefined, true);
  h.failure = null;
  await h.press('futures-submit');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.quantity, '0.5');
  assert.notEqual(h.requests[1].body.idempotencyKey, h.requests[0].body.idempotencyKey);
  assert.match(text(h, 'futures-order-notice'), /체결 완료/);
});

test('a lost response keeps its key for the same-request check, unlike a refusal', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  await h.amount('102');
  h.failure = new Error('network');
  await h.press('futures-submit');
  assert.equal(text(h, 'futures-order-notice'), '체결을 확인하지 못했습니다. 같은 요청을 다시 누르면 중복 체결 없이 결과를 확인합니다.');
  assert.equal(h.node('futures-retry') !== undefined, true);
  assert.equal(h.node('futures-amount').props.editable, false, 'the unknown request keeps its inputs');
  for (const unknown of [{ response: { status: 503, data: { success: false, error: { code: 'SERVICE_UNAVAILABLE' } } } }]) {
    h.failure = unknown;
    await h.press('futures-retry');
    assert.equal(h.node('futures-retry') !== undefined, true);
  }
  h.failure = null;
  await h.press('futures-retry');
  assert.equal(h.requests.length, 3);
  assert.equal(new Set(h.requests.map((r: any) => r.body.idempotencyKey)).size, 1);
});

test('other refusals say what failed instead of asking for a result check', async t => {
  for (const [code, message] of [
    ['FUTURES_MAINTENANCE_UNSAFE', '현재 Mark 기준으로 유지 증거금을 충족하지 못합니다. 레버리지를 낮춰주세요.'],
    ['FUTURES_VALUE_TOO_SMALL', '주문 금액이 너무 작습니다. 금액을 늘려주세요.'],
    ['SOMETHING_NEW', '주문이 접수되지 않았습니다. 입력값과 거래 가능 상태를 확인해주세요.'],
  ]) {
    const h = futuresHarness();
    await h.start(); t.after(h.close);
    await h.amount('102');
    h.failure = { response: { status: code === 'FUTURES_VALUE_TOO_SMALL' ? 400 : 409, data: { success: false, error: { code } } } };
    await h.press('futures-submit');
    assert.equal(text(h, 'futures-order-notice'), message, code);
    assert.equal(h.node('futures-retry') === undefined, true, code);
  }
});

test('another contract starts without the previous amount or ratio', async t => {
  const h = futuresHarness({ futuresOnly: true });
  await h.start(); t.after(h.close);
  await h.press('futures-ratio-50');
  assert.notEqual(h.node('futures-amount').props.value, '');
  await h.selectInstrument('hype');
  assert.equal(h.node('futures-amount').props.value, '');
  assert.equal(text(h, 'futures-amount-ratio'), '0%');
  assert.equal(h.node('futures-ratio-50').props['aria-pressed'], false);
});

test('large fonts in the narrow column: 롱/숏 segment labels keep Long/Short as spoken names', async t => {
  const narrow = futuresHarness({ dimensions: { width: 360, height: 760, fontScale: 1.5 } });
  await narrow.start(); t.after(narrow.close);
  const labels = (h: H) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && ['futures-direction-long', 'futures-direction-short'].includes(n.props.testID))
    .map((n: any) => [n.props.accessibilityLabel, n.findAll((c: any) => c.type === 'Text').map((c: any) => c.props.children)[0]]);
  assert.deepEqual(labels(narrow), [['롱(Long)', '롱'], ['숏(Short)', '숏']]);
  await narrow.choose('숏(Short)');
  await narrow.amount('102');
  await narrow.press('futures-submit');
  assert.equal(narrow.requests[0].body.direction, 'short');
  const wide = futuresHarness({ dimensions: { width: 390, height: 844, fontScale: 1 } });
  await wide.start(); t.after(wide.close);
  assert.deepEqual(labels(wide), [['롱(Long)', '롱(Long)'], ['숏(Short)', '숏(Short)']]);
});

test('large fonts in the narrow column list the three position operations vertically', async t => {
  const narrow = futuresHarness({ position: true, dimensions: { width: 320, height: 640, fontScale: 2 } });
  await narrow.start(); t.after(narrow.close);
  assert.equal(narrow.node('futures-operation').props.accessibilityRole, 'radiogroup');
  await narrow.choose('수량 감소(Reduce)');
  assert.equal(narrow.node('futures-operation-reduce').props['aria-selected'], true);
  assert.equal(narrow.node('futures-amount').props.accessibilityLabel, '감소 금액 (USD)');
  const wide = futuresHarness({ position: true, dimensions: { width: 430, height: 932, fontScale: 1 } });
  await wide.start(); t.after(wide.close);
  assert.equal(wide.node('futures-operation').props.accessibilityRole, 'tablist');
});
