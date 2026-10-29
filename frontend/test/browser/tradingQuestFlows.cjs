const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function({page,open,id,tab,out,errors,expectSteady}){
 const done=[];
 // On screen = drawn on top: inactive tabs stay laid out on Web (opacity 0, or covered under Reduced Motion).
 const drawn=(testId,heading)=>page.evaluate(([testId,heading])=>[...document.querySelectorAll(heading?'[role="heading"]':`[data-testid="${testId}"]`)]
  .filter(el=>!heading||el.textContent===heading).some(el=>{if(!el.checkVisibility({opacityProperty:true,visibilityProperty:true}))return false;
   const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),[testId,heading]);
 const onScreen=testId=>drawn(testId);
 // Forms start at 시장가: the guide points at 주문방식 선택하기, then at the practiced row in the sheet.
 const pick=async(method)=>{await id('quest-guide-card').waitFor();await id('order-type-select').click();await id(`order-method-${method}`).waitFor();await page.waitForTimeout(350);
  await page.screenshot({path:path.join(out,`method-${method}-spotlight.png`)});
  await id(`order-method-${method}`).click();await page.waitForFunction(()=>!document.querySelector('[data-testid="order-method-sheet"]'));};
 // A market practice needs no pick: the form is already at 시장가 and the guide explains it.
 const marketDefault=async()=>{await id('quest-guide-card').waitFor();
  assert.equal(await id('order-type-select-value').textContent(),'시장가');
  await page.screenshot({path:path.join(out,'method-market-default.png')});};
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
  await start(key);
  if(key==='marketBuy'){
   // The market list: a steady spotlight on the rows below the list header, then a re-entry starts anew.
   await page.getByTestId('quest-guide-ring').waitFor();
   await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="quest-guide-card"]');return el&&Number(getComputedStyle(el).opacity)===1;});
   // The header ends with the session/sort toolbar; the 6px ring padding may overlap it.
   const ringTop=await page.getByTestId('quest-guide-ring').evaluate(el=>el.getBoundingClientRect().top);
   const toolbar=await page.getByTestId('market-session-summary').filter({visible:true}).first().evaluate(el=>el.getBoundingClientRect().bottom);
   const row=await page.getByTestId('market-item-BTC').filter({visible:true}).first().evaluate(el=>el.getBoundingClientRect().top);
   assert.ok(ringTop>=toolbar-8&&ringTop<=row,`the ring frames the rows, not the list header ${JSON.stringify({ringTop,toolbar,row})}`);
   await expectSteady('market list',1500);
   await page.screenshot({path:path.join(out,'market-list-spotlight.png')});
   // Held with one notice: Home and the futures practice inside the same tab; the guide stays.
   await tab('홈').click();await id('quest-guide-notice').waitFor();
   assert.equal(await onScreen('home-account-title'),false);
   // The step card sits over the list header here: a keyboard user reaches the 선물 rows.
   const press=async locator=>{await locator.focus();await page.keyboard.press('Enter');};
   await press(id('crypto-product-futures'));await id('futures-market-list').waitFor();
   await page.waitForFunction(()=>!document.querySelector('[data-testid="quest-guide-notice"]'),undefined,{timeout:6000});
   await press(page.locator('[data-testid^="futures-market-"]:not([data-testid="futures-market-list"])').filter({visible:true}).first());
   await id('quest-guide-notice').waitFor();
   assert.equal(await onScreen('futures-screen'),false,'futures is another practice');
   assert.equal(await page.getByTestId('quest-guide-notice').count(),1);
   await press(id('crypto-product-spot'));await page.waitForFunction(()=>!document.querySelector('[data-testid="futures-market-list"]'));
   // The list is held too; 안내 종료 lifts it, and the card starts anew.
   await tab('퀘스트').click();
   assert.equal(await onScreen('beginner-quest-list'),false);
   await id('quest-guide-notice-exit').click();
   await tab('퀘스트').click();
   assert.equal(await id('quest-card-marketBuy-start').getAttribute('aria-label'),'퀘스트 시작하기');
   assert.equal(await page.getByTestId('quest-guide-card').count(),0);
   await id('quest-card-marketBuy-start').click();
   await page.getByTestId('quest-guide-ring').waitFor();
  }
  await id(`market-item-${asset}`).click();await next();await id('asset-detail-open-buy-order').click();
  if(key==='limitBuy')await pick('limit');else await marketDefault();
  if(key==='limitBuy'){await id('order-limit-price-input').fill('90');}
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
 // TP/SL is set from the practiced holding's card under the order form, in its sheet (since 2026-10-16,
 // no 주문방식): one take-profit with a share of the holding, then 등록하기 (one setting is enough).
 await start('protection');
 const holdingTpSl=page.locator('[data-testid^="holding-"][data-testid$="-tp-sl"]').filter({visible:true}).first();
 await holdingTpSl.waitFor();await holdingTpSl.scrollIntoViewIfNeeded();await holdingTpSl.click();await id('tp-sl-spot-holding').waitFor();
 await id('tp-sl-take-profit-toggle').click();await id('tp-sl-take-profit-trigger-price').fill('120');await id('tp-sl-take-profit-ratio-50').click();
 await next();await id('tp-sl-submit').click();await finish('protection');
 // 매도하기 on the detail, then holdings below the sell form, then the form steps.
 await start('marketSell');await id('asset-detail-open-sell-order').click();await next();await marketDefault();await next();
 await id('order-quantity-input').fill('1');await next();await next();await id('order-execute-submit').click();await finish('marketSell');
 await buy('limitBuy','BTC');
 for(const key of ['krStock','usStock','futuresLong','futuresShort'])assert.notEqual(await id(`quest-card-${key}-start`).getAttribute('aria-disabled'),'true');
 await buy('usStock','US');await buy('krStock','KR');
 for(const [key,direction] of [['futuresShort','숏(Short)'],['futuresLong','롱(Long)']]){
  await start(key);
  if(key==='futuresShort'){
   // Funding may use the Wallet tab; its unrelated screens and Home stay held; the guide waits on Futures.
   await id('futures-screen').waitFor();await tab('지갑').click();await id('wallet-screen').waitFor();
   await id('wallet-ledger').click();await id('quest-guide-notice').waitFor();
   assert.equal(await drawn(null,'지갑 원장'),false);
   await tab('홈').click();assert.equal(await onScreen('home-account-title'),false);
   await tab('마켓').click();await id('futures-screen').waitFor();
  }
  await next();await next();await page.getByRole('tab',{name:direction,exact:true}).click();await next();
  // 2x from the leverage sheet (the guide points into it), then $102 = 1 contract at Last 102.
  await id('futures-leverage-select').click();await id('futures-leverage-option-2').waitFor();await page.waitForTimeout(450);
  await page.screenshot({path:path.join(out,`${key}-leverage-spotlight.png`)});await id('futures-leverage-option-2').click();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="futures-leverage-sheet"]'));
  await next();await id('futures-amount').fill('102');await id('futures-submit').click();
  // 포지션 종료 on the card opens its sheet at 100% (the guide steps aside there); its confirm closes the lifetime.
  await page.getByRole('button',{name:'포지션 종료',exact:true}).filter({visible:true}).first().click();
  await id('futures-close-submit').waitFor();await page.waitForTimeout(450);
  assert.equal(await page.locator('[data-testid="quest-guide-overlay"]').count(),0,'no guide card over the sheet');
  await id('futures-close-submit').click();await finish(key);
 }
 assert.equal((await id('quest-summary-progress').textContent()),'퀘스트 10/10 완료');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'full-quest-results.json'),JSON.stringify({done,errors,transport:'fixture; real screens and buttons',backend:'separate PostgreSQL integration'},null,2));
 console.log('full quest browser checks passed: '+done.join(', '));
};
