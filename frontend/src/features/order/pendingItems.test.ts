import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPendingItems, formatPendingPrice, registeredLabel, type PendingItem } from './pendingItems.ts';
import { checkEdit } from './pendingEdit.ts';

const at = (minute: number) => `2026-11-05T01:${String(minute).padStart(2, '0')}:00.000Z`;
const asset = (symbol: string, name: string, market: string, assetType: string) => ({ id: `a-${symbol}`, symbol, name, market, assetType });
const instrument = (symbol: string) => ({ underlying: { symbol, name: symbol.replace(/USDT$/u, ''), displayPriceDecimals: 2 } }) as never;

const spotLimit = (patch: Record<string, unknown> = {}) => ({
  orderId: 'o-1', id: 'o-1', side: 'buy', orderType: 'limit', status: 'submitted', name: '삼성전자', symbol: '005930', market: 'KRX',
  quantity: '10.00000000', limitPrice: '70000.00000000', currencyCode: 'KRW', reservedAmount: '700105.00000000',
  submittedAt: at(5), createdAt: at(5), revision: 0, ...patch,
}) as never;
const watch = (patch: Record<string, unknown> = {}) => ({
  id: 'cb-1', assetId: 'a-BTC', asset: asset('BTCUSDT', 'Bitcoin', 'BINANCE', 'crypto'), side: 'buy', triggerCondition: 'at_or_below',
  triggerPrice: '95.00000000', executionType: 'market', limitPrice: null, quantity: null, amount: '100.00000000', currencyCode: 'USD',
  status: 'watching', state: 'watching', trigger: null, order: null, attemptCount: 0, lastAttemptAt: null, failureCode: null,
  terminalReason: null, createdAt: at(2), endedAt: null, updatedAt: at(2), revision: 1, ...patch,
}) as never;
const sell = (patch: Record<string, unknown> = {}) => ({
  id: 'cs-1', assetId: 'a-AAPL', asset: asset('AAPL', 'Apple Inc.', 'NAS', 'us_stock'), side: 'sell', kind: 'stop_loss', positionId: 'p',
  triggerCondition: 'at_or_below', triggerPrice: '180.00000000', executionType: 'market', limitPrice: null, quantity: '3.00000000',
  currencyCode: 'USD', status: 'watching', state: 'watching', position: null, executionAvailableQuantity: null, quantityLimited: false,
  trigger: null, order: null, attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null,
  createdAt: at(9), endedAt: null, updatedAt: at(9), ...patch,
}) as never;
const futuresLimit = (patch: Record<string, unknown> = {}) => ({
  id: 'fl-1', tradingAccountId: 'acc', instrumentId: 'i', direction: 'long', marginMode: 'isolated', leverage: 5, quantity: '2.00000000',
  limitPrice: '100.00000000', reservedAmount: '40.10000000', status: 'submitted', executionId: null, terminalReason: null,
  createdAt: at(1), endedAt: null, instrument: instrument('ETHUSDT'), ...patch,
}) as never;
const futuresWatch = (patch: Record<string, unknown> = {}) => ({
  id: 'fc-1', tradingAccountId: 'acc', instrumentId: 'i', instrument: instrument('SOLUSDT'), direction: 'short', marginMode: 'cross',
  leverage: 3, quantity: '4.00000000', triggerCondition: 'at_or_above', triggerPrice: '150.00000000', executionType: 'limit',
  limitPrice: '149.00000000', status: 'watching', state: 'watching', trigger: null, execution: null, limitOrder: null,
  attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null, createdAt: at(7), endedAt: null, updatedAt: at(7), ...patch,
}) as never;
const tpSl = (patch: Record<string, unknown> = {}) => ({
  id: 'ft-1', tradingAccountId: 'acc', instrumentId: 'i', instrument: instrument('BTCUSDT'), positionId: 'pos', direction: 'long',
  kind: 'take_profit', triggerCondition: 'at_or_above', triggerPrice: '70000.00000000', quantity: '0.01000000', status: 'watching',
  state: 'watching', position: null, execution: null, quantityLimited: false, trigger: null, entryPlanId: null, attemptCount: 0,
  lastAttemptAt: null, failureCode: null, terminalReason: null, createdAt: at(3), endedAt: null, updatedAt: at(3), ...patch,
}) as never;
const plan = (patch: Record<string, unknown> = {}) => ({
  id: 'ep-1', entryType: 'spot_limit_order', entryId: 'o-1', childOrderId: null, domain: 'spot', assetId: 'a-005930',
  asset: { id: 'a', symbol: '005930', name: '삼성전자', market: 'KRX' }, currencyCode: 'KRW', direction: 'long', kind: 'stop_loss',
  triggerCondition: 'at_or_below', triggerPrice: '65000.00000000', ratioPercent: 50, status: 'pending', basisQuantity: null,
  activatedQuantity: null, fillOrderId: null, fillExecutionId: null, settingId: null, failureCode: null, terminalReason: null,
  createdAt: at(6), endedAt: null, updatedAt: at(6), ...patch,
}) as never;

const byKey = (items: PendingItem[], key: string) => items.find((item) => item.key === key)!;
const row = (item: PendingItem, key: string) => item.rows.find((entry) => entry.key === key);

describe('통합 대기목록', () => {
  it('lists every kind once, oldest registration first, ties stable by kind and id', () => {
    const items = buildPendingItems({
      spotOrders: [spotLimit(), spotLimit({ orderId: 'o-0', id: 'o-0', createdAt: at(1), submittedAt: at(1) })],
      conditionalBuys: [watch()], conditionalSells: [sell()], futuresLimits: [futuresLimit()],
      futuresConditionals: [futuresWatch()], futuresTpSl: [tpSl()], entryPlans: [plan()],
    });
    assert.deepEqual(items.map((item) => item.key), [
      'spot_limit:o-0', 'futures_limit:fl-1', 'conditional_buy:cb-1', 'futures_take_profit:ft-1', 'spot_limit:o-1',
      'entry_plan:ep-1', 'futures_conditional:fc-1', 'spot_stop_loss:cs-1',
    ]);
    assert.equal(new Set(items.map((item) => item.key)).size, items.length);
  });

  it('an order a condition placed is shown on the condition only; ended rows and filled plans are not pending', () => {
    const child = spotLimit({ orderId: 'child', id: 'child', conditionalBuyId: 'cb-1' });
    const childBySell = spotLimit({ orderId: 'child-2', id: 'child-2', conditionalSellId: 'cs-1', side: 'sell' });
    const linkedOnlyFromWatch = spotLimit({ orderId: 'child-3', id: 'child-3' });
    const oco = spotLimit({ orderId: 'oco', id: 'oco', conditionalChildId: 'pc-1', side: 'sell' });
    const items = buildPendingItems({
      spotOrders: [child, childBySell, linkedOnlyFromWatch, oco],
      conditionalBuys: [
        watch({ state: 'order_pending', status: 'ordered', executionType: 'limit', limitPrice: '94.00000000', order: { orderId: 'child-3' } }),
        watch({ id: 'done', state: 'filled', status: 'ordered' }),
      ],
      futuresLimits: [futuresLimit({ id: 'fchild' })],
      futuresConditionals: [futuresWatch({ state: 'order_pending', status: 'ordered', limitOrder: { orderId: 'fchild', status: 'submitted', reservedAmount: '50.00000000' } })],
      entryPlans: [plan({ status: 'activated' })],
    });
    assert.deepEqual(items.map((item) => item.key).sort(), ['conditional_buy:cb-1', 'futures_conditional:fc-1']);
    const pending = byKey(items, 'conditional_buy:cb-1');
    assert.deepEqual(pending.notes, ['조건 충족 · 지정가 주문 체결 대기']);
    assert.deepEqual(pending.cancel, { kind: 'order', id: 'child-3', confirm: '조건주문으로 접수된 지정가 매수를 취소할까요? 예약된 금액은 다시 사용할 수 있게 됩니다.' });
    assert.equal(pending.edit.editable, false);
    assert.match((pending.edit as { reason: string }).reason, /접수된 지정가 주문은 변경할 수 없어요/);
    assert.deepEqual(byKey(items, 'futures_conditional:fc-1').cancel?.id, 'fchild');
  });

  it('cards read 금액 (수량), 실행 유형, 주문 조건 in the side context, with the registration time', () => {
    const items = buildPendingItems({ spotOrders: [spotLimit(), spotLimit({ orderId: 's', id: 's', side: 'sell', reservedAmount: null })], conditionalBuys: [watch()] });
    const buy = byKey(items, 'spot_limit:o-1');
    assert.deepEqual([buy.assetName, buy.typeLabel, buy.sideLabel, buy.tone], ['삼성전자', '지정가', '매수', 'buy']);
    assert.deepEqual(buy.rows.map((entry) => [entry.label, entry.value]), [
      ['금액', '700,000원 (10주)'], ['매수 유형', '지정가'], ['주문 조건', '지정가 70,000원'],
    ]);
    assert.deepEqual(buy.notes, ['예약 금액 700,105원 (수수료 포함)']);
    assert.equal(registeredLabel(buy), '등록 2026-11-05 10:05');
    assert.equal(row(byKey(items, 'spot_limit:s'), 'execution')?.label, '매도 유형');
    // A crypto BUY watch by amount: the quantity is decided when it fills, never invented.
    const amountWatch = byKey(items, 'conditional_buy:cb-1');
    assert.deepEqual(amountWatch.rows.map((entry) => [entry.label, entry.value]), [
      ['금액', '$100 (수량은 체결 시 결정)'], ['매수 유형', '시장가'], ['주문 조건', '감시가격 $95 이하'],
    ]);
  });

  it('amounts from a condition price are estimates; SELL targets show their quantity; Futures keep notional apart from margin', () => {
    const items = buildPendingItems({
      conditionalBuys: [watch({ id: 'q', asset: asset('005930', '삼성전자', 'KRX', 'domestic_stock'), currencyCode: 'KRW', amount: null, quantity: '3.00000000', triggerPrice: '68000.00000000' })],
      conditionalSells: [sell()], futuresLimits: [futuresLimit()], futuresConditionals: [futuresWatch({ executionType: 'market', limitPrice: null })],
      futuresTpSl: [tpSl()], entryPlans: [plan()],
    });
    assert.deepEqual([row(byKey(items, 'conditional_buy:q'), 'amount')?.label, row(byKey(items, 'conditional_buy:q'), 'amount')?.value], ['예상 금액', '≈ 204,000원 (3주)']);
    assert.deepEqual(row(byKey(items, 'spot_stop_loss:cs-1'), 'amount')?.value, '≈ $540 (3주)');
    assert.equal(byKey(items, 'spot_stop_loss:cs-1').sideLabel, '매도 · 손절가');
    const limit = byKey(items, 'futures_limit:fl-1');
    assert.deepEqual([row(limit, 'amount')?.label, row(limit, 'amount')?.value, limit.notes[0]], ['명목금액', '$200 (2 ETH)', '예약 증거금 $40.1 (수수료 포함)']);
    assert.equal(row(limit, 'execution')?.label, '진입 유형');
    assert.deepEqual([row(byKey(items, 'futures_conditional:fc-1'), 'amount')?.label, row(byKey(items, 'futures_conditional:fc-1'), 'condition')?.value],
      ['예상 명목금액', '선물 Last $150 이상']);
    assert.deepEqual(row(byKey(items, 'futures_take_profit:ft-1'), 'execution'), { key: 'execution', label: '청산 유형', value: '시장가' });
    // Futures are unchanged: their own "up to" quantity and the 선물 Last trigger.
    assert.deepEqual(row(byKey(items, 'futures_take_profit:ft-1'), 'amount')?.value, '≈ $700 (최대 0.01 BTC)');
    const planItem = byKey(items, 'entry_plan:ep-1');
    assert.deepEqual(planItem.rows.map((entry) => entry.value), ['체결 수량의 50%', '시장가', '감시가격 65,000원 이하']);
    assert.equal(planItem.typeLabel, '체결 후 손절가');
  });

  it('Spot SELL settings: the badge names 익절가/손절가, the side line and kindLabel keep the kind, the trigger reads 매도 기준가', () => {
    const samsung = asset('005930', '삼성전자', 'KRX', 'domestic_stock');
    const krw = { asset: samsung, assetId: 'a-005930', currencyCode: 'KRW', quantity: '3.16412600' };
    const items = buildPendingItems({
      conditionalSells: [
        sell({ ...krw, id: 'sl', triggerPrice: '199000.00000000' }),
        sell({ ...krw, id: 'tp', kind: 'take_profit', triggerCondition: 'at_or_above', triggerPrice: '220000.00000000' }),
        sell({ ...krw, id: 'c', kind: 'condition', triggerCondition: 'at_or_above', triggerPrice: '210000.00000000', executionType: 'limit', limitPrice: '209000.00000000' }),
      ],
      conditionalBuys: [watch()], futuresTpSl: [tpSl({ kind: 'stop_loss', triggerCondition: 'at_or_below' })],
    });
    const stop = byKey(items, 'spot_stop_loss:sl');
    const take = byKey(items, 'spot_take_profit:tp');
    assert.deepEqual([stop.typeLabel, stop.sideLabel, stop.kindLabel], ['익절가/손절가', '매도 · 손절가', '손절가']);
    assert.deepEqual([take.typeLabel, take.sideLabel, take.kindLabel], ['익절가/손절가', '매도 · 익절가', '익절가']);
    // 199,000 × 3.164126 = 629,661.07: an estimate with the quantity as registered, no 최대.
    assert.deepEqual(stop.rows.map((entry) => [entry.label, entry.value]), [
      ['예상 금액', '≈ 629,661원 (3.164126주)'], ['매도 유형', '시장가'], ['주문 조건', '매도 기준가 199,000원 이하'],
    ]);
    assert.equal(row(take, 'condition')?.value, '매도 기준가 220,000원 이상');
    const condition = byKey(items, 'conditional_sell:c');
    assert.deepEqual([condition.typeLabel, condition.kindLabel, condition.sideLabel], ['조건주문', '조건주문', '매도']);
    assert.deepEqual([row(condition, 'amount')?.value, row(condition, 'condition')?.value],
      ['≈ 661,302원 (3.164126주)', '매도 기준가 210,000원 이상 · 지정가 209,000원']);
    // The kind is structured, never read back from a label.
    const fixed = (item: PendingItem) => (item.edit as Extract<PendingItem['edit'], { editable: true }>).trigger;
    assert.deepEqual(fixed(stop), { choose: false, condition: 'at_or_below', kind: 'stop_loss', label: '매도 기준가',
      hint: '매도 기준가는 자동 매도 여부를 판단하는 가격이에요. 실제 체결가격은 다를 수 있어요.' });
    const takeTrigger = fixed(take);
    assert.equal(takeTrigger && 'kind' in takeTrigger ? takeTrigger.kind : null, 'take_profit');
    assert.deepEqual([fixed(condition)?.choose, fixed(condition)?.label], [true, '매도 기준가']);
    // BUY watches, Futures and entry plans keep 감시가격 and their labels.
    assert.equal(row(byKey(items, 'conditional_buy:cb-1'), 'condition')?.value, '감시가격 $95 이하');
    assert.deepEqual(fixed(byKey(items, 'conditional_buy:cb-1')), { choose: true, label: '감시가격' });
    const futuresStop = byKey(items, 'futures_stop_loss:ft-1');
    assert.deepEqual([futuresStop.typeLabel, futuresStop.kindLabel], ['선물 손절가', '선물 손절가']);
    assert.deepEqual(fixed(futuresStop), { choose: false, condition: 'at_or_below', kind: 'stop_loss', label: '감시가격' });
    assert.equal(fixed(byKey(buildPendingItems({ entryPlans: [plan()] }), 'entry_plan:ep-1'))?.label, '감시가격');
  });

  it('only a Spot stop-loss/take-profit offers a share of its holding; conditions and every other kind do not', () => {
    const items = buildPendingItems({
      conditionalSells: [sell(), sell({ id: 'c', kind: 'condition', triggerCondition: 'at_or_above' })],
      spotOrders: [spotLimit()], futuresTpSl: [tpSl()], entryPlans: [plan()],
    });
    const share = (key: string) => (byKey(items, key).edit as Extract<PendingItem['edit'], { editable: true }>).holdingShare ?? null;
    assert.deepEqual(share('spot_stop_loss:cs-1'), { assetId: 'a-AAPL' });
    for (const key of ['conditional_sell:c', 'spot_limit:o-1', 'futures_take_profit:ft-1', 'entry_plan:ep-1']) assert.equal(share(key), null, key);
  });

  it('change rules per kind: LOC and in-flight rows give their reason; market-only kinds offer no execution choice', () => {
    const items = buildPendingItems({
      spotOrders: [spotLimit({ limitOnClose: { status: 'pending', sessionDate: '2026-11-05', decisionReason: null } })],
      conditionalSells: [sell(), sell({ id: 'c', kind: 'condition', executionType: 'limit', limitPrice: '190.00000000', triggerCondition: 'at_or_above' })],
      conditionalSellLimitAvailable: false,
      futuresTpSl: [tpSl({ id: 'busy', state: 'triggered', status: 'triggered' })],
      entryPlans: [plan()],
    });
    const loc = byKey(items, 'spot_limit:o-1');
    assert.deepEqual([loc.typeLabel, loc.edit.editable], ['LOC', false]);
    assert.match((loc.edit as { reason: string }).reason, /LOC/);
    const stop = byKey(items, 'spot_stop_loss:cs-1').edit as Extract<PendingItem['edit'], { editable: true }>;
    assert.deepEqual([stop.executions, stop.trigger && 'kind' in stop.trigger ? [stop.trigger.choose, stop.trigger.condition, stop.trigger.kind] : null],
      [['market'], [false, 'at_or_below', 'stop_loss']]);
    // A condition registered with limit keeps limit as a choice even while new limit registrations are off.
    assert.deepEqual((byKey(items, 'conditional_sell:c').edit as typeof stop).executions, ['market', 'limit']);
    assert.equal(byKey(items, 'futures_take_profit:busy').edit.editable, false);
    const planEdit = byKey(items, 'entry_plan:ep-1').edit as typeof stop;
    assert.deepEqual([planEdit.size, planEdit.initial.ratio, planEdit.target], ['ratio', '50', { kind: 'entry_tp_sl_plan', id: 'ep-1' }]);
  });

  it('an entry a live legacy OCO protects keeps its card and cancel, but says why it cannot change', () => {
    const items = buildPendingItems({
      spotOrders: [spotLimit(), spotLimit({ orderId: 'o-2', id: 'o-2', submittedAt: at(8), createdAt: at(8) })],
      futuresLimits: [futuresLimit()],
      ocoProtectedOrderIds: new Set(['o-1', 'fl-1']),
    });
    for (const key of ['spot_limit:o-1', 'futures_limit:fl-1']) {
      const item = byKey(items, key);
      assert.equal(item.edit.editable, false, key);
      assert.match((item.edit as { reason: string }).reason, /OCO/);
      assert.equal(item.cancel !== null, true, 'still cancelable');
    }
    assert.equal(byKey(items, 'spot_limit:o-2').edit.editable, true, 'only the protected entry');
  });

  it('prices keep every given decimal with separators; nothing is rounded for display', () => {
    assert.equal(formatPendingPrice('0.00001234', 'USD'), '$0.00001234');
    assert.equal(formatPendingPrice('1234567.50000000', 'USD'), '$1,234,567.5');
    assert.equal(formatPendingPrice('70000.00000000', 'KRW'), '70,000원');
    assert.equal(formatPendingPrice(null, 'KRW'), '-');
  });
});

describe('설정 변경 입력 확인', () => {
  const spec = (items: PendingItem[], key: string) => byKey(items, key).edit as Extract<PendingItem['edit'], { editable: true }>;

  it('a spot limit order sends its new price and size; a crypto BUY by amount, a stock by whole shares', () => {
    const stock = spec(buildPendingItems({ spotOrders: [spotLimit()] }), 'spot_limit:o-1');
    assert.deepEqual(checkEdit(stock, { ...stock.initial, limitPrice: '69500' }), {
      ok: true, body: { limitPrice: '69500', quantity: '10' }, changes: [{ label: '지정가', before: '70,000원', after: '69,500원' }],
    });
    assert.deepEqual(checkEdit(stock, { ...stock.initial, quantity: '1.5' }), { ok: false, message: '수량은 1 이상의 정수로 입력해 주세요.' });
    assert.deepEqual(checkEdit(stock, stock.initial), { ok: false, message: '변경된 내용이 없어요.' });
    const crypto = spec(buildPendingItems({ spotOrders: [spotLimit({ market: 'BINANCE', symbol: 'BTCUSDT', name: 'Bitcoin', currencyCode: 'USD', quantity: '0.00150000', limitPrice: '60000.00000000' })] }), 'spot_limit:o-1');
    assert.deepEqual([crypto.size, crypto.initial.amount], ['amount', '90']);
    const result = checkEdit(crypto, { ...crypto.initial, amount: '120' });
    assert.deepEqual(result.ok && result.body, { limitPrice: '60000', amount: '120' });
  });

  it('a watch sends its condition, execution and size; switching to limit needs a limit price', () => {
    const buy = spec(buildPendingItems({ conditionalBuys: [watch()], conditionalBuyLimitAvailable: true }), 'conditional_buy:cb-1');
    assert.deepEqual(checkEdit(buy, { ...buy.initial, executionType: 'limit' }), { ok: false, message: '지정가는 0보다 큰 숫자로, 소수점 8자리까지 입력해 주세요.' });
    const result = checkEdit(buy, { ...buy.initial, executionType: 'limit', limitPrice: '94', triggerCondition: 'at_or_above', triggerPrice: '105' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.body, { triggerPrice: '105', triggerCondition: 'at_or_above', executionType: 'limit', limitPrice: '94', amount: '100' });
    assert.deepEqual(result.ok && result.changes.map((change) => change.label), ['감시 방향', '감시가격', '매수 유형', '지정가']);
  });

  it('a Spot stock stop-loss keeps its fractional quantity (6 decimals at market): a price-only change sends it unchanged', () => {
    const stop = spec(buildPendingItems({ conditionalSells: [sell({ asset: asset('005930', '삼성전자', 'KRX', 'domestic_stock'),
      currencyCode: 'KRW', quantity: '3.16412600', triggerPrice: '199000.00000000' })] }), 'spot_stop_loss:cs-1');
    assert.deepEqual([stop.quantityScale, stop.limitQuantityScale, stop.initial.quantity], [6, 0, '3.164126']);
    const priced = checkEdit(stop, { ...stop.initial, triggerPrice: '198000' });
    assert.deepEqual(priced, { ok: true, body: { triggerPrice: '198000', executionType: 'market', quantity: '3.164126' },
      changes: [{ label: '매도 기준가', before: '199,000원', after: '198,000원' }] });
    const resized = checkEdit(stop, { ...stop.initial, quantity: '1.582063' });
    assert.deepEqual(resized.ok && resized.changes, [{ label: '수량', before: '3.164126 주', after: '1.582063 주' }]);
    assert.deepEqual(checkEdit(stop, { ...stop.initial, quantity: '1.5820631' }), { ok: false, message: '수량은 0보다 큰 숫자로, 소수점 6자리까지 입력해 주세요.' });
    for (const quantity of ['', '0', '0.000000'])
      assert.deepEqual(checkEdit(stop, { ...stop.initial, quantity }), { ok: false, message: '수량은 0보다 큰 숫자로, 소수점 6자리까지 입력해 주세요.' }, quantity);
    assert.deepEqual(checkEdit(stop, { ...stop.initial, triggerPrice: '' }), { ok: false, message: '매도 기준가는 0보다 큰 숫자로, 소수점 8자리까지 입력해 주세요.' });
  });

  it('a Spot stock SELL condition takes fractional shares at market and whole shares once switched to limit', () => {
    const condition = spec(buildPendingItems({
      conditionalSells: [sell({ id: 'c', kind: 'condition', triggerCondition: 'at_or_above', quantity: '2.50000000' })],
      conditionalSellLimitAvailable: true,
    }), 'conditional_sell:c');
    const market = checkEdit(condition, { ...condition.initial, triggerPrice: '185' });
    assert.deepEqual(market.ok && market.body, { triggerPrice: '185', triggerCondition: 'at_or_above', executionType: 'market', quantity: '2.5' });
    assert.deepEqual(checkEdit(condition, { ...condition.initial, executionType: 'limit', limitPrice: '186' }),
      { ok: false, message: '주식을 지정가로 실행할 때는 수량을 1 이상의 정수로 입력해 주세요.' });
    const limit = checkEdit(condition, { ...condition.initial, executionType: 'limit', limitPrice: '186', quantity: '2' });
    assert.deepEqual(limit.ok && limit.changes.map((change) => change.label), ['매도 유형', '지정가', '수량']);
    // Crypto keeps 6 decimals under either execution.
    const crypto = spec(buildPendingItems({ conditionalSells: [sell({ id: 'c', kind: 'condition', triggerCondition: 'at_or_above',
      asset: asset('BTCUSDT', 'Bitcoin', 'BINANCE', 'crypto'), quantity: '0.12345600' })], conditionalSellLimitAvailable: true }), 'conditional_sell:c');
    assert.equal(checkEdit(crypto, { ...crypto.initial, executionType: 'limit', limitPrice: '186' }).ok, true);
  });

  it('stop-loss/take-profit and entry plans send no direction or execution choice; ratio is a whole percent', () => {
    const items = buildPendingItems({ conditionalSells: [sell()], futuresTpSl: [tpSl()], entryPlans: [plan()] });
    const stop = checkEdit(spec(items, 'spot_stop_loss:cs-1'), { ...spec(items, 'spot_stop_loss:cs-1').initial, triggerPrice: '175' });
    assert.deepEqual(stop.ok && stop.body, { triggerPrice: '175', executionType: 'market', quantity: '3' });
    const futures = checkEdit(spec(items, 'futures_take_profit:ft-1'), { ...spec(items, 'futures_take_profit:ft-1').initial, quantity: '0.005' });
    assert.deepEqual(futures.ok && futures.body, { triggerPrice: '70000', quantity: '0.005' });
    const planSpec = spec(items, 'entry_plan:ep-1');
    assert.deepEqual(checkEdit(planSpec, { ...planSpec.initial, ratio: '101' }), { ok: false, message: '비율은 1부터 100까지 정수로 입력해 주세요.' });
    const planned = checkEdit(planSpec, { ...planSpec.initial, ratio: '70' });
    assert.deepEqual(planned.ok && planned.body, { triggerPrice: '65000', ratio: 70 });
  });
});
