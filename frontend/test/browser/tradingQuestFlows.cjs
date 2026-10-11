const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function({page,open,id,tab,out,errors}){
 const done=[];
 const next=async()=>{await id('quest-guide-next').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="quest-guide-next"]')].some(el=>el.checkVisibility()&&el.getAttribute('aria-disabled')!=='true'));await id('quest-guide-next').click();};
 const finish=async key=>{
  await id('quest-guide-celebration').waitFor();
  await page.screenshot({path:path.join(out,`${key}-complete.png`)});
  await page.waitForFunction(key=>[...document.querySelectorAll(`[data-testid="quest-card-${key}-status"]`)].some(el=>el.checkVisibility()&&el.textContent==='완료'),key);
  await page.waitForFunction(()=>!document.querySelector('[data-testid="quest-guide-celebration"]'));
  done.push(key);
 };
 const start=async key=>{await tab('퀘스트').click();await id(`quest-card-${key}-start`).click();};
 const buy=async(key,asset)=>{
  await start(key);await id(`market-item-${asset}`).click();await next();await id('asset-detail-open-buy-order').click();
  if(key==='limitBuy'){await id('order-type-select').click();await id('order-type-toggle-limit').click();await id('order-limit-price-input').fill('90');}
  await next();await id('order-quantity-input').fill(asset==='BTC'?'100':'1');await next();await next();
  await id('quest-guide-card').waitFor();
  await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="quest-guide-card"]'); return el && Number(getComputedStyle(el).opacity)===1;});
  const clipped = await id('quest-guide-card').evaluate(el=>{const r=el.getBoundingClientRect();return r.left<0 || r.right>innerWidth || r.top<0 || r.bottom>innerHeight || el.scrollHeight>el.clientHeight+2;});
  assert.equal(clipped,false,'guide card remains inside the viewport');
  await page.screenshot({path:path.join(out,`${key}-submit.png`)});
  await id('order-execute-submit').click();
  if(key==='limitBuy')await id('quest-limit-cancel').click();
  await next();await finish(key);
 };
 if (process.env.QUEST_COMPACT === '1') { await page.setViewportSize({ width: 320, height: 740 }); await page.emulateMedia({ reducedMotion: 'reduce' }); }
 await open('practice=1&fullQuests=1&quest=2&fxState=available'+(process.env.QUEST_COMPACT === '1'?'&fontScale=2&theme=dark':''));
 await tab('퀘스트').click();
 assert.equal(await page.getByTestId('quest-card-futuresShort-start').getAttribute('aria-disabled'),'true');
 await buy('marketBuy','BTC');
 await start('protection');await id('holding-protection-BTC').click();
 await id('protection-take_profit-toggle').click();await page.getByLabel('익절 (Take Profit) 조건 가격',{exact:true}).fill('120');
 await id('protection-stop_loss-toggle').click();await page.getByLabel('손절 (Stop Loss) 조건 가격',{exact:true}).fill('80');
 await next();await page.getByRole('button',{name:'보호 조건 등록',exact:true}).click();await finish('protection');
 await start('marketSell');await next();await id('asset-detail-open-sell-order').click();await next();
 await id('order-quantity-input').fill('1');await next();await next();await id('order-execute-submit').click();await finish('marketSell');
 await buy('limitBuy','BTC');
 for(const key of ['krStock','usStock','futuresLong','futuresShort'])assert.notEqual(await id(`quest-card-${key}-start`).getAttribute('aria-disabled'),'true');
 await buy('usStock','US');await buy('krStock','KR');
 for(const [key,direction] of [['futuresShort','숏(Short)'],['futuresLong','롱(Long)']]){
  await start(key);await next();await next();await page.getByRole('button',{name:direction,exact:true}).click();await next();
  await id('futures-leverage').fill('2');await next();await id('futures-quantity').fill('1');await id('futures-submit').click();
  await page.getByRole('button',{name:'전량 종료',exact:true}).filter({visible:true}).first().click();
  await id('futures-submit').click();await finish(key);
 }
 assert.equal((await id('quest-summary-progress').textContent()),'퀘스트 10/10 완료');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'full-quest-results.json'),JSON.stringify({done,errors,transport:'fixture; real screens and buttons',backend:'separate PostgreSQL integration'},null,2));
 console.log('full quest browser checks passed: '+done.join(', '));
};
