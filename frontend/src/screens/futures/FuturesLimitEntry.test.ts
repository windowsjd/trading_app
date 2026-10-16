import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness, deferred } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

// 손절가/익절가 plans of a new Limit entry: market-only settings activated by
// the entry's actual fill for their share of it (sent as `entryTpSl`).
const OPEN_PLANS = { spot: { enabled: false, canCreate: false }, futures: { enabled: true, canCreate: true }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 };
const LABEL: Record<string, string> = { stop_loss: '손절', take_profit: '익절' };
const ID: Record<string, string> = { stop_loss: 'tp-sl-stop-loss', take_profit: 'tp-sl-take-profit' };
const words = (node: any) => [node?.props.children].flat(Infinity).filter((part: unknown) => typeof part === 'string').join('');
/** Below the entry for a Long stop-loss / Short take-profit, above otherwise. */
const protective = (direction: string, kind: string) => (direction === 'long') === (kind === 'stop_loss') ? '90' : '110';

async function planSheet(h: any, kinds: string[], price: (kind: string) => string, ratio = 50) {
  await h.press('futures-limit-tp-sl-button');
  for (const kind of kinds) {
    await h.press(`${ID[kind]}-toggle`);
    await h.change(`${ID[kind]}-trigger-price`, price(kind));
    await h.press(`${ID[kind]}-ratio-${ratio}`);
  }
}

for (const direction of ['long', 'short'])
  for (const kinds of [['stop_loss'], ['take_profit'], ['stop_loss', 'take_profit']])
    test(`${direction} valid ${kinds.join('/')} plans submit with the entry, market only`, async t => {
      const h = futuresHarness(); h.entryTpSlCapabilities = OPEN_PLANS; await h.start(); t.after(h.close); await draft(h);
      await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
      await planSheet(h, kinds, (kind) => protective(direction, kind));
      assert.equal(h.node('tp-sl-take-profit-execution') === undefined && h.node('tp-sl-stop-loss-limit-price') === undefined, true, 'no execution choice');
      await h.press('tp-sl-submit');
      await h.press('tp-sl-sheet-close');
      assert.equal(words(h.node('futures-limit-tp-sl-button-summary')).length > 0, true);
      await h.press('futures-limit-submit');
      assert.equal(h.requests.length, 1);
      assert.equal('attachedProtection' in h.requests[0].body, false, 'no new OCO attachment');
      // The sheet adds the kinds in its own order: 익절 then 손절.
      assert.deepEqual(h.requests[0].body.entryTpSl, ['take_profit', 'stop_loss'].filter((kind) => kinds.includes(kind))
        .map((kind) => ({ kind, triggerPrice: protective(direction, kind), ratio: 50 })));
      assert.match(h.text(), /손절가\/익절가는 체결 후 활성화됩니다/);
    });

for (const direction of ['long', 'short'])
  for (const kind of ['stop_loss', 'take_profit'])
    for (const trigger of ['100', (direction === 'long') === (kind === 'stop_loss') ? '110' : '90'])
      test(`${direction}/${kind} plan at ${trigger} is refused against the 100 entry before transport`, async t => {
        const h = futuresHarness(); h.entryTpSlCapabilities = OPEN_PLANS; await h.start(); t.after(h.close); await draft(h);
        await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
        await planSheet(h, [kind], () => trigger);
        const below = (direction === 'long') === (kind === 'stop_loss');
        assert.equal(words(h.node('tp-sl-draft-error')), `${LABEL[kind]}가는 진입 가격보다 ${below ? '낮게' : '높게'} 입력해주세요.`);
        assert.equal(h.node('tp-sl-submit').props.state, 'disabled');
        assert.equal(h.requests.length, 0);
      });

for (const direction of ['long', 'short'])
  test(`${direction} plans that no longer fit a changed entry price stop the submit before transport`, async t => {
    const h = futuresHarness(); h.entryTpSlCapabilities = OPEN_PLANS; await h.start(); t.after(h.close); await draft(h);
    await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
    await planSheet(h, ['stop_loss'], () => protective(direction, 'stop_loss'));
    await h.press('tp-sl-submit'); await h.press('tp-sl-sheet-close');
    // The entry moves past the stop-loss: Long 90 → entry 80, Short 110 → entry 120.
    await h.change('futures-limit-price', direction === 'long' ? '80' : '120');
    await h.press('futures-limit-submit');
    assert.equal(h.requests.length, 0);
    assert.match(words(h.node('futures-limit-notice')), /^손절가\/익절가 설정을 확인해 주세요\. 손절가는 진입 가격보다/);
  });

for (const direction of ['long', 'short'])
  test(`${direction} plan prices compare the full 16+8 decimal entry without Number rounding`, async t => {
    // One 1e-8 contract at this price is a $12M notional: the account must carry it.
    const large = '100000000000';
    const h = futuresHarness({ freeCollateral: large, crossBase: large, liquidationBuffer: large }); h.entryTpSlCapabilities = OPEN_PLANS;
    await h.start(); t.after(h.close); await draft(h);
    await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
    await h.change('futures-limit-price', '1234567890123456.12345678');
    await h.amount('100000000');
    await planSheet(h, ['stop_loss'], () => direction === 'long' ? '1234567890123456.12345679' : '1234567890123456.12345677', 100);
    assert.equal(h.node('tp-sl-submit').props.state, 'disabled', 'one unit on the wrong side');
    await h.change('tp-sl-stop-loss-trigger-price', direction === 'long' ? '1234567890123456.12345677' : '1234567890123456.12345679');
    assert.equal(h.node('tp-sl-submit').props.state, 'enabled');
    await h.press('tp-sl-submit'); await h.press('tp-sl-sheet-close');
    await h.press('futures-limit-submit'); assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.entryTpSl[0].triggerPrice, direction === 'long' ? '1234567890123456.12345677' : '1234567890123456.12345679');
  });

test('a server plan refusal shows its mapped reason and keeps the authoritative failure', async t => {
  const h = futuresHarness(); h.entryTpSlCapabilities = OPEN_PLANS; await h.start(); t.after(h.close); await draft(h);
  await planSheet(h, ['stop_loss'], () => '90');
  await h.press('tp-sl-submit'); await h.press('tp-sl-sheet-close');
  h.failure = { response: { status: 409, data: { success: false, error: { code: 'ENTRY_TP_SL_INVALID_TRIGGER', message: 'raw server text' } } } };
  await h.press('futures-limit-submit');
  assert.equal(h.requests.length, 1);
  assert.match(h.text(), /익절가·손절가 방향이 주문 가격과 맞지 않습니다/);
  assert.doesNotMatch(h.text(), /raw server text/);
});

test('switched-off plans keep the drafts visible and stop a retained submit callback', async t => {
  const h = futuresHarness(); h.entryTpSlCapabilities = OPEN_PLANS; await h.start(); t.after(h.close); await draft(h);
  await planSheet(h, ['stop_loss'], () => '90');
  await h.press('tp-sl-submit'); await h.press('tp-sl-sheet-close');
  const submit = h.node('futures-limit-submit').props.onPress;
  h.entryTpSlCapabilities = { ...OPEN_PLANS, futures: { enabled: false, canCreate: false } };
  await h.client.invalidateQueries(); await h.flush();
  assert.equal(h.node('futures-limit-tp-sl-button') !== undefined, true);
  assert.match(h.text(), /현재 손절가\/익절가를 새로 등록할 수 없어요/);
  await submit(); await h.flush();
  assert.equal(h.requests.length, 0);
});

async function draft(h: any) {
  await h.selectMethod('limit');
  // $125 at the 100 entry price is 1.25 contracts.
  await h.amount('125');
  await h.change('futures-limit-price', '100');
}
for (const accountId of ['A', 'B'])
  for (const direction of ['long', 'short'])
    for (const marginMode of ['cross', 'isolated'])
      for (const leverage of [1, 37, 100])
        test(`Limit ${accountId}/${direction}/${marginMode}/${leverage} uses the account contract`, async t => {
          const h = futuresHarness({accountId}); await h.start(); t.after(h.close);
          await draft(h);
          await h.choose(direction === 'long' ? '롱(Long)' : '숏(Short)');
          await h.choose(marginMode === 'cross' ? '교차(Cross)' : '격리(Isolated)');
          await h.setLeverage(leverage);
          await h.press('futures-limit-submit');
          assert.equal(h.requests.length, 1);
          assert.equal(h.requests[0].path, `/trading-accounts/${accountId}/futures/limit-orders`);
          assert.deepEqual({...h.requests[0].body, idempotencyKey: '<key>'}, {instrumentId:'btc', direction, marginMode, leverage, quantity:'1.25', limitPrice:'100', idempotencyKey:'<key>'});
          assert.match(h.text(), /체결 전까지 담보가 예약/);
          assert.equal(h.invalidations.some((key: string[]) => key.join('/') === `tradingAccount/futures/${accountId}`), true);
          assert.equal(h.invalidations.some((key: string[]) => key.includes('protections') && key.includes(accountId)), true);
        });

for (const mode of ['REDUCE_ONLY', 'DISABLED'])
  test(`${mode} stops new Limit entry after capability refetch`, async t => {
    const h = futuresHarness(); await h.start(); t.after(h.close); await draft(h);
    const submit = h.node('futures-limit-submit').props.onPress;
    h.options.mode = mode; await h.client.invalidateQueries(); await h.flush();
    assert.equal(h.node('futures-limit-submit').props.state, 'disabled');
    await submit(); await h.flush(); assert.equal(h.requests.length, 0);
  });

test('uncertain Limit retry preserves the exact intent and idempotency key', async t => {
  const h = futuresHarness(); await h.start(); t.after(h.close); await draft(h);
  h.gate=deferred(); h.failure=new Error('network');
  await h.press('futures-limit-submit'); await h.press('futures-limit-submit');
  assert.equal(h.requests.length,1);
  h.gate.resolve(); await h.flush();
  assert.equal(h.node('futures-limit-price').props.editable,false);
  h.failure=null; await h.press('futures-limit-submit');
  assert.deepEqual(h.requests[1],h.requests[0]);
});

test('a new session clears an uncertain Limit request even for the same selected account', async t => {
  const h=futuresHarness(); await h.start(); t.after(h.close); await draft(h);
  h.failure=new Error('network'); await h.press('futures-limit-submit');
  assert.equal(h.node('futures-limit-submit').props.label,'동일 진입 요청 확인');
  h.session++; await h.update();
  assert.equal(h.node('futures-limit-submit') === undefined,true);
  await h.selectMethod('limit');
  assert.equal(h.node('futures-limit-price').props.value,'');
  assert.equal(h.node('futures-limit-submit').props.state,'disabled');
  assert.equal(h.requests.length,1);
});

for (const boundary of ['account','session'])
  test(`Limit callback cannot cross the ${boundary} boundary`, async t => {
    const h=futuresHarness(); await h.start(); t.after(h.close); await draft(h);
    const submit=h.node('futures-limit-submit').props.onPress;
    if (boundary==='account') h.accountId='B'; else h.session++;
    await h.update(); await submit(); await h.flush();
    assert.equal(h.requests.length,0);
  });

test('the Market Futures instrument list navigates with its account and rejects stale selection', async t => {
  const h=futuresHarness({screen:'market'}); await h.start(); t.after(h.close);
  const select=h.node('futures-market-btc').props.onPress;
  await h.press('futures-market-btc'); assert.deepEqual(h.navigation,[['A','btc']]);
  h.accountId='B'; await h.update(); await select(); await h.flush();
  assert.equal(h.navigation.length,1);
  await h.press('futures-market-btc'); assert.deepEqual(h.navigation[1],['B','btc']);
});
