import assert from 'node:assert/strict';
import { db, app, fixture, now, price, openBody, cleanup, fxEvidence, fxEvidenceIds, code } from './futures-integration';
import { beforeStep, step } from './investigation-step-barrier';
import { verifiedFuturesInstrument } from '../src/futures/futures-instrument-coverage';
(async()=>{
 await db.$connect();const s=await fixture('season');
 try {
  await beforeStep();const tick=await now();
  await db.futuresInstrument.update({where:{id:s.instruments[0].instrument.id},data:{markVerifiedAt:tick}});
  await price(s);await fxEvidence();
  await db.futuresMarkSnapshot.create({data:{instrumentId:s.instruments[0].instrument.id,symbol:s.instruments[0].asset.symbol,source:'binance_usdm_mark_ws',price:'100',effectiveAt:tick,capturedAt:tick}});
  const before=await db.futuresInstrument.findUniqueOrThrow({where:{id:s.instruments[0].instrument.id},include:{underlyingAsset:true}});
  assert.equal(verifiedFuturesInstrument(before,tick),true);
  console.error('FUTURES_EVIDENCE_BEFORE_STEP '+JSON.stringify({tick,nodeNow:new Date(),instrument:before}));
  await step(5000);
  try {await app.futures.execute(s.userId,s.accountId,openBody(s));throw new Error('Expected real future evidence rejection');}
  catch(e){assert.equal(code(e),'FUTURES_INSTRUMENT_UNVERIFIED');}
  assert.equal(await db.futuresExecution.count({where:{tradingAccountId:s.accountId}}),0);
  console.log('actual host clock step reproduced FUTURES_INSTRUMENT_UNVERIFIED');
 } finally {await cleanup(s);await db.fxRateSnapshot.deleteMany({where:{id:{in:fxEvidenceIds}}});await db.$disconnect();}
})().catch(e=>{console.error(e);process.exitCode=1;});
