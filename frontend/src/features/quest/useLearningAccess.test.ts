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
 assert.equal(h.state.runs,0);assert.equal(h.alerts.length,1);assert.match(h.alerts[0][1] as string,/지정가 매수/);
 assert.equal(h.access.gate('cryptoMarketBuy').allowed,true);assert.equal(h.access.gate('riskReduction').allowed,true);
});
test('unknown/error progress is a refresh failure, never a fabricated learning lock or unlock',()=>{
 for(const [data,isError] of [[undefined,false],[questProgress(2),true]] as const){
  const h=harness('beginner',data,isError);const gate=h.access.gate('allTrading');
  assert.equal(gate.allowed,false);assert.equal(gate.locked,false);gate.guard(()=>{h.state.runs++;});
  assert.equal(h.state.runs,0);assert.equal(h.state.refresh,1);
 }
});
test('QUEST 06 server completion removes every learning restriction even with operational flags off',()=>{
 const p=questProgress(6);p.operations={limitOrdersEnabled:false,conditionalOrdersEnabled:false,futuresTradingMode:'DISABLED'};
 const h=harness('beginner',p);for(const action of Object.keys(p.learningAccess)){assert.equal(h.access.gate(action).allowed,true);assert.equal(h.access.gate(action).locked,false);}
});
