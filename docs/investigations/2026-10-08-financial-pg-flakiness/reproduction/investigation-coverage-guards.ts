import assert from 'node:assert/strict';
import { db, app, fixture, now, price, openBody, cleanup, fxEvidence, fxEvidenceIds, code, state } from './futures-integration';
(async()=>{
 await db.$connect(); const s=await fixture('season'); const instrument=s.instruments[0].instrument;
 const valid=instrument.markContractJson!;
 try {
  const tick=new Date(+(await now())-1000);await price(s);await fxEvidence();
  await db.futuresMarkSnapshot.create({data:{instrumentId:instrument.id,symbol:s.instruments[0].asset.symbol,source:'binance_usdm_mark_ws',price:'100',effectiveAt:tick,capturedAt:tick}});
  const cases=[['missing',{markVerifiedAt:null}],['future',{markVerifiedAt:new Date(+tick+61000)}],['stale',{markVerifiedAt:new Date(+tick-86400000-60000)}],['paused',{markVerifiedAt:tick,markContractJson:{...valid as object,status:'BREAK'}}],['wrong identity',{markVerifiedAt:tick,markContractJson:{...valid as object,symbol:'BTCUSDT',pair:'BTCUSDT',baseAsset:'BTC'}}]] as const;
  for(const [label,patch] of cases){
   await db.futuresInstrument.update({where:{id:instrument.id},data:patch}); const before=await state(s);
   try {await app.futures.execute(s.userId,s.accountId,openBody(s));throw new Error('unexpected acceptance');}
   catch(e){assert.equal(code(e),'FUTURES_INSTRUMENT_UNVERIFIED');}
   assert.deepEqual(await state(s),before);console.log('PASS actual PG coverage reject + rollback: '+label);
  }
  await db.futuresInstrument.update({where:{id:instrument.id},data:{markVerifiedAt:tick,markContractJson:valid}});
  const result=await app.futures.execute(s.userId,s.accountId,openBody(s)); assert.equal(result.data.execution.operation,'open');
  console.log('PASS actual PG valid coverage accepted');
 }finally{await cleanup(s);await db.fxRateSnapshot.deleteMany({where:{id:{in:fxEvidenceIds}}});await db.$disconnect();}
})().catch(e=>{console.error(e);process.exitCode=1;});
