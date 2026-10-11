import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questProgress, questPayload } from '../../../test/questFixtures.ts';
import { BEGINNER_QUEST_KEYS, canStartQuest, parseBeginnerQuests } from './questProgress.ts';
import { startGuideSession, followGuideFocus, claimGuideCommand, settleGuideVerification, observeGuideProgress, resolveGuideView } from './questGuideModel.ts';
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
test('holdings Next requires the matching account and asset valuation to be visible',()=>{
  const session=claimGuideCommand(startGuideSession(1,account,'marketBuy',questProgress(2)),account,spot).session!;
  for(const visible of [false,true]) {
    const view=resolveGuideView(session,'asset',{wallet:null,fx:null,transfer:null,practice:{asset:{screen:'asset',accountId:account,assetId:'crypto-1',assetType:'crypto'},holdings:{screen:'holdings',accountId:account,assetId:'crypto-1',holdingsVisible:visible}}});
    assert.equal(view.kind,'spotlight');if(view.kind==='spotlight')assert.equal(view.card.next,visible?'enabled':'disabled');
  }
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
  const view=resolveGuideView(session,'asset',{wallet:null,fx:null,transfer:null,practice:{asset:{screen:'asset',accountId:account},limitReview:{screen:'limitReview',accountId:account,orderResolved:false}}});
  assert.equal(view.kind,'spotlight');if(view.kind==='spotlight')assert.equal(view.card.next,'disabled');
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
