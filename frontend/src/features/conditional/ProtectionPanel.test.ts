import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const {conditionalHarness,deferred}=createRequire(import.meta.url)('../../../test/conditionalHarness.cjs');
for(const domain of ['spot','futures']) for(const kind of ['stop_loss','take_profit']) for(const type of ['market','limit'])
test(`${domain} ${kind} ${type} uses scoped API and separates trigger/limit`,async t=>{
  const h=conditionalHarness({domain});await h.start();t.after(h.close);
  await h.press(`protection-${kind}-toggle`);
  const label=kind==='stop_loss'?'손절 (Stop Loss)':'익절 (Take Profit)';
  await h.input(`${label} 조건 가격`,'100.00000001');
  if(type==='limit'){await h.press(`protection-${kind}-limit`);await h.input(`${label} 실행 지정가`,'99.5');}
  await h.button('보호 조건 등록');
  assert.equal(h.requests[0].path,'/trading-accounts/A/protections');
  assert.deepEqual(h.requests[0].body.legs,[{kind,triggerPrice:'100.00000001',childOrderType:type,...(type==='limit'?{childLimitPrice:'99.5'}:{})}]);
  assert.match(h.text(),/등록했습니다/);
  for(const resource of ['wallets','positions','portfolio','protections','futures'])assert.ok(h.invalidations.some(k=>k.includes(resource)&&k.includes('A')),resource);
});
test('OCO pending Limit retains sibling; cancel stays available in DISABLED',async t=>{
 const h=conditionalHarness({active:true,mode:'DISABLED'});await h.start();t.after(h.close);
 assert.match(h.text(),/실행\/체결 대기/);assert.match(h.text(),/조건 실행 일시 중지/);assert.match(h.text(),/반대 조건도 유지/);
 await h.button('보호 조건 취소');assert.equal(h.requests[0].path,'/trading-accounts/A/protections/group/cancel');
});
test('attached holding shows no pre-fill monitoring',async t=>{const h=conditionalHarness({domain:'spot',holding:true});await h.start();t.after(h.close);assert.match(h.text(),/진입 주문 체결 대기/);assert.doesNotMatch(h.text(),/계속 감시 중/);});
test('REDUCE_ONLY allows protection; feature OFF hides an empty panel',async t=>{const h=conditionalHarness({mode:'REDUCE_ONLY'});await h.start();t.after(h.close);assert.ok(h.node('protection-stop_loss-toggle'));h.options.enabled=false;await h.client.invalidateQueries();await h.flush();assert.equal(h.node('protection-panel'),undefined);});
test('ambiguous network retry preserves exact command and prevents duplicate clicks',async t=>{
 const h=conditionalHarness();await h.start();t.after(h.close);await h.press('protection-stop_loss-toggle');await h.input('손절 (Stop Loss) 조건 가격','90');h.gate=deferred();h.failure=new Error('network');
 await h.button('보호 조건 등록');await h.button('보호 조건 등록');assert.equal(h.requests.length,1);h.gate.resolve();await h.flush();h.gate=null;h.failure=null;await h.button('동일 요청 결과 다시 확인');assert.deepEqual(h.requests[0],h.requests[1]);
});
test('account A→B→A suppresses old success and resets editor',async t=>{
 const h=conditionalHarness();await h.start();t.after(h.close);await h.press('protection-stop_loss-toggle');await h.input('손절 (Stop Loss) 조건 가격','90');h.gate=deferred();await h.button('보호 조건 등록');h.accountId='B';await h.update();assert.equal(h.node('protection-panel'),undefined);h.accountId='A';await h.update();h.gate.resolve();await h.flush();assert.doesNotMatch(h.text(),/등록했습니다/);assert.ok(h.node('protection-stop_loss-toggle'));assert.ok(h.invalidations.every(k=>!k.includes('B')));
});
test('logout/login suppresses old mutation result and invalidation',async t=>{
 const h=conditionalHarness();await h.start();t.after(h.close);await h.press('protection-stop_loss-toggle');await h.input('손절 (Stop Loss) 조건 가격','90');h.gate=deferred();await h.button('보호 조건 등록');h.session++;await h.update();h.gate.resolve();await h.flush();assert.doesNotMatch(h.text(),/등록했습니다/);assert.equal(h.invalidations.length,0);
});
test('wrong account response is rejected; refresh error never shows old protection',async t=>{
 const h=conditionalHarness({active:true});await h.start();t.after(h.close);h.wrongScope='B';await assert.rejects(h.api.getProtections('A','futures','asset'));h.wrongScope=null;h.readFailure=new Error('network');await h.client.invalidateQueries();await h.flush();assert.match(h.text(),/불러오지 못했습니다/);assert.doesNotMatch(h.text(),/남은 수량/);
});
test('invalid prices make no mutation',async t=>{const h=conditionalHarness();await h.start();t.after(h.close);await h.press('protection-stop_loss-toggle');await h.input('손절 (Stop Loss) 조건 가격','0');await h.button('보호 조건 등록');assert.equal(h.requests.length,0);assert.match(h.text(),/올바르게 입력/);});
test('flat position retains historical protection reads after feature disable',async t=>{
 const h=conditionalHarness({complete:true,flat:true,enabled:false});await h.start();t.after(h.close);
 assert.equal(h.reads[0].config.params.history,'true');assert.ok(h.node('protection-panel'));
 assert.equal(h.node('protection-stop_loss-toggle'),undefined);
 await h.press('protection-history-toggle');assert.match(h.text(),/보호 완료/);assert.match(h.text(),/최대 20건/);assert.equal(h.requests.length,0);
});
