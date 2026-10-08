import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness, deferred } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

async function draft(h: any) {
  await h.choose('지정가 진입');
  await h.change('futures-quantity', '1.25');
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
          await h.change('futures-leverage', String(leverage));
          await h.press('futures-limit-submit');
          assert.equal(h.requests.length, 1);
          assert.equal(h.requests[0].path, `/trading-accounts/${accountId}/futures/limit-orders`);
          assert.deepEqual({...h.requests[0].body, idempotencyKey: '<key>'}, {instrumentId:'btc', direction, marginMode, leverage, quantity:'1.25', limitPrice:'100', idempotencyKey:'<key>'});
          assert.match(h.text(), /체결 전까지 담보가 예약/);
          assert.equal(h.invalidations.some((key: string[]) => key.join('/') === `tradingAccount/futures/${accountId}`), true);
          assert.equal(h.invalidations.some((key: string[]) => key.includes('protections') && key.includes(accountId)), true);
        });

for (const kinds of [['stop_loss'], ['take_profit'], ['stop_loss', 'take_profit']])
  test(`Limit attaches ${kinds.join('/')} through the existing Protection editor`, async t => {
    const h = futuresHarness({protectionEnabled:true}); await h.start(); t.after(h.close); await draft(h);
    const legs = [];
    for (const kind of kinds) {
      const sl = kind === 'stop_loss';
      await h.press(`protection-${kind}-toggle`);
      await h.input(`${sl ? '손절 (Stop Loss)' : '익절 (Take Profit)'} 조건 가격`, sl ? '90' : '110');
      if (sl) { await h.press('protection-stop_loss-limit'); await h.input('손절 (Stop Loss) 실행 지정가', '89'); }
      legs.push({kind, triggerPrice:sl ? '90' : '110', childOrderType:sl ? 'limit' : 'market', ...(sl ? {childLimitPrice:'89'} : {})});
    }
    await h.press('futures-limit-submit');
    assert.deepEqual(h.requests[0].body.attachedProtection, legs);
  });

test('disabled capabilities keep TP/SL visible and stop a retained attached submit callback', async t => {
  const h = futuresHarness({protectionEnabled:true}); await h.start(); t.after(h.close); await draft(h);
  await h.press('protection-stop_loss-toggle'); await h.input('손절 (Stop Loss) 조건 가격', '90');
  const submit = h.node('futures-limit-submit').props.onPress;
  h.protectionOptions = {enabled:false}; await h.client.invalidateQueries(); await h.flush();
  assert.equal(h.node('protection-stop_loss-toggle') !== undefined, true);
  assert.match(h.text(), /새 보호 조건을 등록할 수 없습니다/);
  await submit(); await h.flush();
  assert.equal(h.requests.length, 0);
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
  await h.choose('지정가 진입');
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
