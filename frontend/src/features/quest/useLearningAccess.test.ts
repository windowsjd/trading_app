import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {questProgress} from '../../../test/questFixtures.ts';
const {load}=createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');
function harness(mode='beginner',data:ReturnType<typeof questProgress>|undefined=undefined,isError=false){
 const h={alerts:[] as unknown[][],queries:[] as any[],runs:0,refresh:0};
 const {useLearningAccess}=load(resolve('src/features/quest/useLearningAccess.ts'),{
  'react-native':{Alert:{alert:(...args:unknown[])=>h.alerts.push(args)}},
  '../tradingAccount/TradingAccountContext':{useTradingAccount:()=>({selectedAccount:{id:'A',mode}})},
  '../tradingAccount/api':{getBeginnerQuestProgress:async()=>data},
  '@tanstack/react-query':{useQuery:(options:unknown)=>{h.queries.push(options);return{data,isError,refetch:async()=>{h.refresh++;}};}},
 });
 return {...h,access:useLearningAccess('A'),state:h};
}
for(const mode of ['general','season'])test(`${mode}: no learning query or lock even when progress is unavailable`,()=>{
 const h=harness(mode);assert.equal(h.queries[0].enabled,false);assert.deepEqual(h.queries[0].queryKey,['tradingAccount','quests','A']);
 for(const action of ['transfer','cryptoMarketBuy','spotProtection','cryptoLimitBuy','allTrading','riskReduction'])assert.equal(h.access.gate(action).allowed,true);
});
test('fresh server progress keeps locked functions visible and explains why on press',()=>{
 const h=harness('beginner',questProgress(2));const gate=h.access.gate('cryptoLimitBuy');
 assert.equal(gate.allowed,false);assert.equal(gate.locked,true);gate.guard(()=>{h.state.runs++;});
 // The visible line under the control: the quest lock's own copy; open or exempt actions have none.
 assert.equal(gate.caption,'퀘스트 완료 후 이용 가능합니다.');
 assert.equal(h.access.gate('cryptoMarketBuy').caption,null);assert.equal(h.access.gate('riskReduction').caption,null);
 assert.equal(h.state.runs,0);assert.equal(h.alerts.length,1);assert.match(h.alerts[0][1] as string,/지정가 매수/);
 assert.equal(h.access.gate('cryptoMarketBuy').allowed,true);assert.equal(h.access.gate('riskReduction').allowed,true);
});
test('unknown/error progress is a refresh failure, never a fabricated learning lock or unlock',()=>{
 for(const [data,isError] of [[undefined,false],[questProgress(2),true]] as const){
  const h=harness('beginner',data,isError);const gate=h.access.gate('allTrading');
  assert.equal(gate.allowed,false);assert.equal(gate.locked,false);gate.guard(()=>{h.state.runs++;});
  assert.equal(gate.caption,null,'an unknown state is never shown as a quest lock');
  assert.equal(h.state.runs,0);assert.equal(h.state.refresh,1);
 }
});
test('QUEST 06 opens only the four market practices; every quest opens everything, even with operational flags off',()=>{
 const p=questProgress(6);p.operations={limitOrdersEnabled:false,conditionalOrdersEnabled:false,futuresTradingMode:'DISABLED'};
 const h=harness('beginner',p);
 for(const action of ['krStockMarketBuy','usStockMarketBuy','futuresLongOpen','futuresShortOpen','transfer','exchange','riskReduction'])
  assert.equal(h.access.gate(action).allowed,true,action);
 for(const action of ['cryptoMarketBuy','cryptoLimitBuy','spotProtection','allTrading']){
  const gate=h.access.gate(action);assert.equal(gate.allowed,false,action);assert.equal(gate.locked,true);
  assert.equal(gate.message,'모든 퀘스트를 완료하면 사용할 수 있어요.');
 }
 const all=questProgress(10);all.operations=p.operations;
 const done=harness('beginner',all);
 for(const action of Object.keys(all.learningPermissions)){assert.equal(done.access.gate(action).allowed,true);assert.equal(done.access.gate(action).locked,false);}
});
test('a passed practice waits for every quest; a pending Futures position must close first; messages name the step',()=>{
 const p=questProgress(7);p.learningPermissions={...p.learningPermissions,futuresLongOpen:false};
 const h=harness('beginner',p);
 assert.equal(h.access.gate('krStockMarketBuy').message,'모든 퀘스트를 완료하면 사용할 수 있어요.');
 assert.equal(h.access.gate('usStockMarketBuy').allowed,true);
 assert.equal(h.access.gate('futuresLongOpen').message,'진행 중인 롱 포지션을 전량 종료하면 새로 진입할 수 있어요.');
 const early=harness('beginner',questProgress(1));
 assert.equal(early.access.gate('krStockMarketBuy').message,'공통 기초 퀘스트를 모두 완료하면 한국주식 매수 퀘스트에서 사용할 수 있어요.');
 assert.equal(early.access.gate('cryptoMarketBuy').message,'암호화폐 시장가 매수 퀘스트에서 사용할 수 있어요.');
});
test('an entry gate opens while any of its actions is open (구매하기 at QUEST 06 leads to the limit BUY)',()=>{
 const h=harness('beginner',questProgress(5));
 assert.equal(h.access.gate('cryptoMarketBuy').allowed,false);
 assert.equal(h.access.gate(['cryptoMarketBuy','cryptoLimitBuy']).allowed,true);
 const later=harness('beginner',questProgress(6)).access.gate(['cryptoMarketBuy','cryptoLimitBuy']);
 assert.equal(later.allowed,false);assert.equal(later.message,'모든 퀘스트를 완료하면 사용할 수 있어요.');
});
test('a screen-derived lock (1x Futures practice) explains itself and never runs the work',()=>{
 const h=harness('beginner',questProgress(6));const gate=h.access.lock('선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.');
 assert.deepEqual([gate.allowed,gate.locked],[false,true]);gate.guard();
 assert.equal(h.alerts.length,1);assert.match(h.alerts[0][1] as string,/레버리지/);
});

test('a screen-derived lock (1x Futures practice) carries its own reason as the visible line',()=>{
 const lock=harness('beginner',questProgress(7)).access.lock('선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.');
 assert.deepEqual([lock.locked,lock.caption],[true,'선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.']);
});
