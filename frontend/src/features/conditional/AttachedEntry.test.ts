import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {TEST_IDS} from '../../constants/testIds.ts';
const {inlineTradingHarness,act,deferred}=createRequire(import.meta.url)('../../../test/inlineTradingHarness.cjs');

/** Server gates of 손절가/익절가 plans on a new Spot BUY limit. */
const plans=(accountId:string,canCreate=true)=>({tradingAccountId:accountId,
 capabilities:{spot:{enabled:true,canCreate},futures:{enabled:false,canCreate:false},canCancel:true,maxPendingPerAccount:30,maxPerEntry:10},
 entry:null,plans:[],pagination:{limit:100,offset:0,total:0,returned:0,nextOffset:null}});

/** Opens the order's 손절가/익절가 sheet and adds a take-profit (800, 30%) and a stop-loss (600, 100%). */
async function addPlans(h:any){
 await h.press('order-tp-sl-button');
 assert.equal(h.node('tp-sl-draft')!==undefined,true,'the order sheet is open');
 await h.press('tp-sl-take-profit-toggle');await h.input('tp-sl-take-profit-trigger-price','800');await h.press('tp-sl-take-profit-ratio-25');
 await h.slide('tp-sl-take-profit-slider',30);
 await h.press('tp-sl-stop-loss-toggle');await h.input('tp-sl-stop-loss-trigger-price','600');await h.press('tp-sl-stop-loss-ratio-100');
 await h.press('tp-sl-submit');
 await h.press('tp-sl-sheet-close');
}

for(const account of ['general','season'])test(`${account} BUY Limit sends 손절가/익절가 plans only with create; the quote is unchanged`,async t=>{
 const h=inlineTradingHarness();h.accountId=account;h.positions[account]='0';h.entryTpSlList=plans(account);h.reduced=true;
 await h.mount();t.after(h.close);await h.selectOrderType('limit');await h.input(TEST_IDS.order.limitPriceInput,'700');await h.input(TEST_IDS.order.quantityInput,'100');
 assert.equal(h.node('order-tp-sl-button').props.label,'손절가/익절가 설정');
 await addPlans(h);
 assert.equal([h.node('order-tp-sl-button-summary')?.props.children].flat().join(''),'익절 1건 · 손절 1건');
 await h.press(TEST_IDS.order.executeSubmit);await h.flush();assert.equal(h.requests.length,2);
 assert.equal('entryTpSl' in h.requests[0].body,false,'the quote never carries plans');
 assert.equal('attachedProtection' in h.requests[1].body,false,'no new OCO attachment');
 assert.deepEqual(h.requests[1].body.entryTpSl,[{kind:'take_profit',triggerPrice:'800',ratio:30},{kind:'stop_loss',triggerPrice:'600',ratio:100}]);
 assert.equal(h.requests[1].body.orderType,'limit');assert.equal(h.requests[1].body.side,'buy');
});

test('plans are optional and never offered for Market, LOC or Sell',async t=>{
 const h=inlineTradingHarness();h.entryTpSlList=plans('general');await h.mount();t.after(h.close);
 assert.equal(h.node('order-tp-sl-button')===undefined,true,'시장가 has no entry to attach plans to');
 await h.press(TEST_IDS.assetDetail.sellButton);
 // Sell offers no new limit, so there is nothing to attach plans to.
 await h.press(TEST_IDS.order.typeSelect);assert.equal(h.node('order-method-limit')===undefined,true);assert.equal(h.node('order-tp-sl-button')===undefined,true);
});

test('plan prices must sit on the protective side of the limit price',async t=>{
 const h=inlineTradingHarness();h.entryTpSlList=plans('general');h.reduced=true;
 await h.mount();t.after(h.close);await h.selectOrderType('limit');await h.input(TEST_IDS.order.limitPriceInput,'700');await h.input(TEST_IDS.order.quantityInput,'100');
 await h.press('order-tp-sl-button');
 await h.press('tp-sl-stop-loss-toggle');await h.input('tp-sl-stop-loss-trigger-price','750');await h.press('tp-sl-stop-loss-ratio-100');
 assert.equal(h.node('tp-sl-submit').props.state,'disabled','a stop-loss above the entry is refused');
 await h.input('tp-sl-stop-loss-trigger-price','650');
 assert.equal(h.node('tp-sl-submit').props.state,'enabled');
});

for(const phase of ['before-submit','quote-pending']) test(`switched-off plans block ${phase} without hiding the drafts`,async t=>{
 const h=inlineTradingHarness();h.entryTpSlList=plans('general');h.reduced=true;
 await h.mount();t.after(h.close);await h.selectOrderType('limit');await h.input(TEST_IDS.order.limitPriceInput,'700');await h.input(TEST_IDS.order.quantityInput,'100');
 await addPlans(h);
 const submit=h.node(TEST_IDS.order.executeSubmit).props.onPress;
 if(phase==='quote-pending'){h.quoteGate=deferred();await act(async()=>submit());}
 h.entryTpSlList=plans('general',false);await h.update();
 assert.equal(h.node('order-tp-sl-button')!==undefined,true,'the drafts stay visible');
 if(phase==='before-submit') await act(async()=>submit());else h.quoteGate.resolve();
 await h.flush();assert.equal(h.requests.filter((r:any)=>!r.url.endsWith('/quote')).length,0);
});
