import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {TEST_IDS} from '../../constants/testIds.ts';
const {inlineTradingHarness,act,deferred}=createRequire(import.meta.url)('../../../test/inlineTradingHarness.cjs');
for(const account of ['general','season'])test(`${account} BUY Limit attaches legs only to create; quote remains unchanged`,async t=>{
 const h=inlineTradingHarness();h.accountId=account;h.positions[account]='0';h.protections={tradingAccountId:account,capabilities:{enabled:true,canCreateSpot:true,canUseSpotLimit:true},groups:[]};
 await h.mount();t.after(h.close);await h.press(TEST_IDS.order.typeToggleLimit);await h.input(TEST_IDS.order.limitPriceInput,'700');await h.input(TEST_IDS.order.quantityInput,'100');
 await h.press('protection-stop_loss-toggle');
 await act(async()=>h.renderer.root.findAll((n:any)=>n.type==='TextInput'&&n.props.accessibilityLabel==='손절 (Stop Loss) 조건 가격')[0].props.onChangeText('600'));
 await h.press('protection-take_profit-toggle');await h.press('protection-take_profit-limit');
 for(const [label,value] of [['익절 (Take Profit) 조건 가격','800'],['익절 (Take Profit) 실행 지정가','810']]) await act(async()=>h.renderer.root.findAll((n:any)=>n.type==='TextInput'&&n.props.accessibilityLabel===label)[0].props.onChangeText(value));
 await h.press(TEST_IDS.order.executeSubmit);await h.flush();assert.equal(h.requests.length,2);
 assert.equal(h.requests[0].body.attachedProtection,undefined);
 assert.deepEqual(h.requests[1].body.attachedProtection,[{kind:'stop_loss',triggerPrice:'600',childOrderType:'market'},{kind:'take_profit',triggerPrice:'800',childOrderType:'limit',childLimitPrice:'810'}]);
 assert.equal(h.requests[1].body.orderType,'limit');assert.equal(h.requests[1].body.side,'buy');
});
test('attached inputs are optional and never shown for Market or Sell',async t=>{
 const h=inlineTradingHarness();h.protections={tradingAccountId:'general',capabilities:{enabled:true,canCreateSpot:true,canUseSpotLimit:true},groups:[]};await h.mount();t.after(h.close);assert.equal(h.node('protection-stop_loss-toggle'),undefined);await h.press(TEST_IDS.assetDetail.sellButton);await h.press(TEST_IDS.order.typeToggleLimit);assert.equal(h.node('protection-stop_loss-toggle'),undefined);
});
