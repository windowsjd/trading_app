import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
export async function step(limit = 40000) {
 const deadline=performance.now()+limit;
 let previousWall=Date.now(), previousMono=performance.now();
 while(performance.now()<deadline) {
  await delay(1);
  const wall=Date.now(), mono=performance.now();
  if(wall-previousWall < -100) {
   const event={beforeWall:new Date(previousWall).toISOString(),afterWall:new Date(wall).toISOString(),wallDeltaMs:wall-previousWall,monotonicDeltaMs:mono-previousMono,mono};
   console.error('REAL_CLOCK_STEP '+JSON.stringify(event)); return event;
  }
  previousWall=wall;previousMono=mono;
 }
 throw new Error('No actual host clock step within bounded reproduction window');
}
export async function beforeStep() {
 const a=await step(), b=await step();
 const period=b.mono-a.mono;
 if(period<20000 || period>40000) throw new Error('Unexpected clock step period: '+period);
 await delay(Math.max(0,period-150));
 return {period};
}
