import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questProgress, questPayload, questProgressInProgress } from '../../../test/questFixtures.ts';
import { BEGINNER_QUEST_KEYS, canStartQuest, parseBeginnerQuests } from './questProgress.ts';
import { startGuideSession, followGuideFocus, claimGuideCommand, settleGuideVerification, observeGuideProgress, resolveGuideView } from './questGuideModel.ts';
import { TRADING_GUIDE_STEPS } from './tradingGuideSteps.ts';
const account='beginner-1';
const spot={kind:'spot' as const,accountId:account,assetId:'crypto-1',assetType:'crypto',side:'buy',orderType:'market',orderId:'new-fill',summary:'실제 체결'};
for(let count=0;count<=6;count++)test(`foundation ${count}: next practice usable; later practice cannot start`,()=>{
  const progress=questProgress(count);
  BEGINNER_QUEST_KEYS.forEach((key,index)=>assert.equal(canStartQuest(key,progress),index<6?index<=count:count>=6));
});
test('advanced quests are independent, including Short before Long and US before KR',()=>{
  const payload=questPayload(6);const done=questPayload(10);
  payload.quests[7]=done.quests[7];payload.quests[9]=done.quests[9];
  const progress=parseBeginnerQuests(payload,account);
  for(const key of ['krStock','usStock','futuresLong','futuresShort'] as const)assert.equal(canStartQuest(key,progress),true);
  assert.equal(progress.learningAccess.allTrading,true);
});
test('a click/quote/old progress never replaces committed fill plus holdings review',()=>{
  const session=startGuideSession(1,account,'marketBuy',questProgress(2))!;
  assert.equal(session.phase,'guiding');
  assert.equal(claimGuideCommand(session,account,{...spot,accountId:'foreign'}).claimed,false);
  assert.equal(claimGuideCommand(session,account,{...spot,orderType:'limit'}).claimed,false);
  const fill=claimGuideCommand(session,account,spot).session!;
  assert.equal(fill.step,7);assert.equal(fill.phase,'guiding');assert.equal(fill.orderId,'new-fill');
  assert.equal(settleGuideVerification({...fill,phase:'verifying'},questProgress(2)).phase,'unconfirmed');
  assert.equal(settleGuideVerification({...fill,phase:'verifying'},questProgress(3)).phase,'celebrating');
});
// Holdings (with TP/SL and limit review) are listed under the order form only.
const orderForm=(patch={})=>({screen:'order' as const,accountId:account,assetId:'crypto-1',assetType:'crypto',side:'buy' as const,orderType:'market' as const,...patch});
test('holdings Next requires the matching account and asset valuation to be visible',()=>{
  const session=claimGuideCommand(startGuideSession(1,account,'marketBuy',questProgress(2)),account,spot).session!;
  for(const visible of [false,true]) {
    const view=resolveGuideView(session,'order',{wallet:null,fx:null,transfer:null,practice:{order:orderForm(),holdings:{screen:'holdings',accountId:account,assetId:'crypto-1',holdingsVisible:visible}}});
    assert.equal(view.kind,'spotlight');if(view.kind==='spotlight'){assert.equal(view.card.next,visible?'enabled':'disabled');assert.deepEqual(view.targets,['asset-holdings']);}
  }
  // The detail screen no longer has holdings: nothing is pointed at there.
  const detail=resolveGuideView(session,'asset',{wallet:null,fx:null,transfer:null,practice:{asset:{screen:'asset',accountId:account,assetId:'crypto-1',assetType:'crypto'},holdings:{screen:'holdings',accountId:account,assetId:'crypto-1',holdingsVisible:true}}});
  assert.equal(detail.kind,'none');
});
test('review steps below the order form ignore the form side/type check',()=>{
  const session=claimGuideCommand(startGuideSession(1,account,'marketBuy',questProgress(2)),account,spot).session!;
  const view=resolveGuideView(session,'order',{wallet:null,fx:null,transfer:null,practice:{order:orderForm({side:'sell',orderType:'limit'}),holdings:{screen:'holdings',accountId:account,assetId:'crypto-1',holdingsVisible:true}}});
  assert.equal(view.kind,'spotlight');if(view.kind==='spotlight')assert.deepEqual(view.targets,['asset-holdings']);
});
test('marketSell: 판매하기 on the detail, then holdings and the sell form on the order screen',()=>{
  const session=startGuideSession(5,account,'marketSell',questProgress(4))!;
  assert.equal(session.step,0);
  const sell=resolveGuideView(session,'asset',{wallet:null,fx:null,transfer:null,practice:{asset:{screen:'asset',accountId:account,assetId:'crypto-1',assetType:'crypto'}}});
  assert.equal(sell.kind,'spotlight');if(sell.kind==='spotlight')assert.deepEqual(sell.targets,['asset-sell']);
  const atOrder=followGuideFocus(session,'order');
  assert.equal(atOrder.step,1,'arriving at the order screen reviews holdings first');
  const facts=(visible:boolean)=>({wallet:null,fx:null,transfer:null,practice:{order:orderForm({side:'sell'}),holdings:{screen:'holdings' as const,accountId:account,assetId:session.assetId,holdingsVisible:visible}}});
  const prepare=resolveGuideView(atOrder,'order',facts(false));
  assert.equal(prepare.kind,'message');if(prepare.kind==='message')assert.equal(prepare.card.title,'실습 수량 준비');
  const holdings=resolveGuideView(atOrder,'order',facts(true));
  assert.equal(holdings.kind,'spotlight');if(holdings.kind==='spotlight')assert.deepEqual(holdings.targets,['asset-holdings']);
  assert.equal(followGuideFocus({...atOrder,step:3},'order').step,3);
});
test('protection: the SELL 주문방식 손절가/익절가 설정 of the practiced asset, then its editor and 확인',()=>{
  const session=startGuideSession(6,account,'protection',questProgress(3))!;
  assert.equal(followGuideFocus(session,'order').step,0);
  const holdings={screen:'holdings' as const,accountId:account,assetId:session.assetId,holdingsVisible:true};
  const facts=(order:Record<string,unknown>,protection:Record<string,unknown>|null=null)=>({wallet:null,fx:null,transfer:null,
    practice:{order:orderForm({assetId:session.assetId,side:'sell',...order}),holdings,...(protection?{protection:{screen:'protection' as const,accountId:account,assetId:session.assetId,...protection}}:{})}});
  // The sell form starts at 시장가: the field, then the sheet row.
  const field=resolveGuideView(session,'order',facts({orderType:'market'}));
  assert.equal(field.kind,'spotlight');
  if(field.kind==='spotlight'){assert.deepEqual(field.targets,['order-type']);assert.match(field.card.body,/주문방식 선택하기를 눌러 손절가\/익절가 설정을 선택/);}
  const sheet=resolveGuideView(session,'order',facts({orderType:'market',methodSheetOpen:true}));
  if(sheet.kind==='spotlight')assert.deepEqual(sheet.targets,['order-method-protection']);else assert.fail('the sheet row is pointed at');
  // The buy side is the wrong side for this practice.
  const buy=resolveGuideView(session,'order',facts({side:'buy',orderType:'market'}));
  if(buy.kind==='spotlight')assert.match(buy.card.body,/매도 · 손절가\/익절가 설정을 선택/);else assert.fail('side is explained');
  // The chosen method mounts the editor: its readiness gates 다음, then 확인.
  for(const ready of [false,true]){
    const editor=resolveGuideView(session,'order',facts({orderType:'protection'},{protectionEditing:true,tpSlReady:ready}));
    assert.equal(editor.kind,'spotlight');
    if(editor.kind==='spotlight'){assert.deepEqual(editor.targets,['protection-editor']);assert.equal(editor.card.next,ready?'enabled':'disabled');}
  }
  const submit=resolveGuideView({...session,step:2},'order',facts({orderType:'protection'},{protectionEditing:true,tpSlReady:true}));
  if(submit.kind==='spotlight')assert.deepEqual(submit.targets,['protection-submit']);else assert.fail('확인 is pointed at');
  // Without a holding the form is blocked: prepare the practice quantity first.
  const prepare=resolveGuideView(session,'order',{...facts({orderType:'market',blocked:true}),practice:{...facts({orderType:'market',blocked:true}).practice,holdings:{...holdings,holdingsVisible:false}}});
  assert.equal(prepare.kind,'message');if(prepare.kind==='message')assert.equal(prepare.card.title,'실습 수량 준비');
  // One stop-loss or take-profit is a registration; another asset is not this practice.
  const command={kind:'protection' as const,accountId:account,assetId:session.assetId!,summary:'등록'};
  assert.equal(claimGuideCommand(session,account,command).session?.phase,'verifying');
  assert.equal(claimGuideCommand(session,account,{...command,assetId:'other'}).claimed,false);
});
test('navigation updates preserve an already advanced order step',()=>{
  const session=startGuideSession(1,account,'marketBuy',questProgress(2))!;
  assert.equal(followGuideFocus({...session,step:5},'order').step,5);
  assert.equal(followGuideFocus(session,'order').step,3);
});
test('limit registration waits for terminal result review and survives reconnect',()=>{
  const payload=questPayload(5);payload.quests[5]=questPayload(6).quests[5];
  payload.quests[5].status='in_progress';payload.quests[5].completedStepCount=1;payload.quests[5].steps[1]={stepId:'limit_result_reviewed',completed:false,completedAt:null,referenceId:null};payload.practice.limitAssetId='crypto-1';
  const session=startGuideSession(2,account,'limitBuy',parseBeginnerQuests(payload,account))!;
  assert.equal(session.step,7);assert.equal(session.orderId,'limitBuy-ref');
  const view=resolveGuideView(session,'order',{wallet:null,fx:null,transfer:null,practice:{order:orderForm(),limitReview:{screen:'limitReview',accountId:account,orderResolved:false}}});
  assert.equal(view.kind,'spotlight');if(view.kind==='spotlight'){assert.equal(view.card.next,'disabled');assert.deepEqual(view.targets,['limit-review']);}
});
test('futures requires leverage, direction and manual full close of the same lifetime',()=>{
  const session=startGuideSession(3,account,'futuresShort',questProgress(6))!;
  const command={kind:'futures' as const,accountId:account,positionId:'lifetime-1',direction:'short',operation:'open',leverage:2,quantityAfter:'1.00000000',summary:'체결'};
  assert.equal(claimGuideCommand(session,account,{...command,leverage:1}).claimed,false);
  assert.equal(claimGuideCommand(session,account,{...command,direction:'long'}).claimed,false);
  const opened=claimGuideCommand(session,account,command).session!;
  for(const patch of [{operation:'reduce',quantityAfter:'0.5'},{operation:'close',quantityAfter:'0',positionId:'foreign'},{operation:'liquidation',quantityAfter:'0'}])assert.equal(claimGuideCommand(opened,account,{...command,...patch}).claimed,false);
  assert.equal(claimGuideCommand(opened,account,{...command,operation:'close',quantityAfter:'0'}).session?.phase,'verifying');
});
test('replay preserves completion and returns without fireworks only after new practice',()=>{
  const session=startGuideSession(4,account,'marketBuy',questProgress(6))!;
  assert.equal(observeGuideProgress(session,questProgress(6),false).phase,'guiding');
  const filled=claimGuideCommand(session,account,spot).session!;
  assert.equal(settleGuideVerification({...filled,phase:'verifying'},questProgress(6)).phase,'replaySucceeded');
});
test('the client rejects forged unlocks and out-of-order financial evidence',()=>{
  const forged=questPayload(2);forged.learningAccess.allTrading=true;
  assert.throws(()=>parseBeginnerQuests(forged,account));
  const unordered=questPayload(6);unordered.quests[4].steps[0].completedAt=unordered.quests[3].steps[0].completedAt;
  assert.throws(()=>parseBeginnerQuests(unordered,account));
});
test('a new guide resumes from the ledger, never from a remembered step: no repeated fill, order or position',()=>{
  // QUEST 03 filled, holdings not reviewed: review on that asset's order screen.
  const filled=startGuideSession(7,account,'marketBuy',questProgressInProgress(2,'fill-1',{spotAssetId:'crypto-1'}))!;
  assert.deepEqual([filled.step,filled.orderId,filled.assetId,filled.replay],[7,'fill-1','crypto-1',false]);
  assert.equal(TRADING_GUIDE_STEPS.marketBuy[filled.step].target,'asset-holdings');
  // QUEST 06 registered, result not reviewed: the open order (and its reservation) is reviewed.
  const limit=startGuideSession(8,account,'limitBuy',questProgressInProgress(5,'limit-1',{limitAssetId:'crypto-1'}))!;
  assert.deepEqual([limit.step,limit.orderId,limit.assetId],[7,'limit-1','crypto-1']);
  assert.equal(TRADING_GUIDE_STEPS.limitBuy[limit.step].target,'limit-review');
  // Futures opened, not closed: straight to closing that same position.
  const long=startGuideSession(9,account,'futuresLong',questProgressInProgress(8,'open-1',{longPositionId:'position-1'}))!;
  assert.deepEqual([long.step,long.positionId],[5,'position-1']);
  assert.equal(TRADING_GUIDE_STEPS.futuresLong[long.step].target,'futures-position');
  // Nothing proven yet: the practice starts at its first step.
  assert.equal(startGuideSession(10,account,'marketBuy',questProgress(2))!.step,0);
});
test('no guide copy offers a resume that no longer exists',()=>{
  assert.doesNotMatch(JSON.stringify(TRADING_GUIDE_STEPS),/이어하기/);
});
test('another practiced method: the guide opens 주문방식 선택하기 and then points at the practiced row', () => {
  const views = (quest: 'marketBuy' | 'limitBuy' | 'marketSell', form: Record<string, unknown>) => {
    const started = startGuideSession(1, account, quest, questProgress(6));
    assert.ok(started, quest);
    // The order-type step of each practice (marketSell starts on the order screen).
    const session = { ...started, step: quest === 'marketSell' ? 2 : 3 };
    return resolveGuideView(session, 'order', { wallet: null, fx: null, transfer: null,
      practice: { order: orderForm({ side: quest === 'marketSell' ? 'sell' : 'buy', ...form }) } });
  };
  for (const [quest, label, row] of [['marketBuy', '시장가', 'order-method-market'], ['limitBuy', '지정가', 'order-method-limit'], ['marketSell', '시장가', 'order-method-market']] as const) {
    const closed = views(quest, { orderType: undefined, methodSheetOpen: false });
    assert.equal(closed.kind, 'spotlight');
    if (closed.kind === 'spotlight') {
      assert.deepEqual(closed.targets, ['order-type']);
      assert.match(closed.card.body, new RegExp(`주문방식 선택하기를 눌러 ${label}`));
    }
    const open = views(quest, { orderType: undefined, methodSheetOpen: true });
    if (open.kind === 'spotlight') assert.deepEqual(open.targets, [row]);
    else assert.fail('the open sheet is spotlighted');
    // LOC and conditional are other methods, never the practiced one.
    for (const other of ['loc', 'conditional']) {
      const view = views(quest, { orderType: other });
      if (view.kind === 'spotlight') assert.deepEqual(view.targets, ['order-type']);
      else assert.fail(other);
    }
  }
  const chosen = views('marketBuy', { orderType: 'market' });
  if (chosen.kind === 'spotlight') assert.deepEqual(chosen.targets, ['order-type']);
  else assert.fail('the chosen method explains itself on the field');
  if (chosen.kind === 'spotlight') assert.equal(chosen.card.next, 'enabled');
  // Forms start at 시장가: a market practice reads its step at once, while the
  // limit practice is sent to 주문방식 선택하기 from that default.
  const fromDefault = views('limitBuy', { orderType: 'market', methodSheetOpen: false });
  if (fromDefault.kind === 'spotlight') {
    assert.deepEqual(fromDefault.targets, ['order-type']);
    assert.match(fromDefault.card.body, /주문방식 선택하기를 눌러 지정가/);
  } else assert.fail('the limit practice points at the field');
  const sellDefault = views('marketSell', { orderType: 'market' });
  if (sellDefault.kind === 'spotlight') assert.equal(sellDefault.card.next, 'enabled');
  else assert.fail('the market sell practice reads its step');
});
