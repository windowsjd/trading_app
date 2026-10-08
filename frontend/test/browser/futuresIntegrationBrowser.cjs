// Production Market -> Futures navigation, entry form, holdings and pending
// views. Only transport/account/font-scale/native navigation are fixture inputs.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const esbuild=require('esbuild'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),out=process.env.FUTURES_INTEGRATION_BROWSER_OUTPUT??'/tmp/trading-futures-integration-browser';
async function overflow(page){return page.evaluate(()=>[...document.querySelectorAll('div,span,input')].flatMap(el=>{
 const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height)return[];
 // The existing order ladder explicitly scrolls horizontally inside its clipped
 // viewport. Check that viewport, not its deliberately wider scroll content.
 const ladder=el.closest('[data-testid="asset-order-book-asks-scroll"], [data-testid="asset-order-book-bids-scroll"]');
 if(ladder && ladder!==el)return[];
 if(r.left < -1 || r.right > innerWidth+1)return[{text:el.textContent.slice(0,100),reason:'box',rect:[r.left,r.right]}];
 if(el.childNodes.length===1&&el.firstChild.nodeType===Node.TEXT_NODE)return [...el.textContent.matchAll(/\S+/gu)].flatMap(m=>{const range=document.createRange();range.setStart(el.firstChild,m.index);range.setEnd(el.firstChild,m.index+m[0].length);return [...range.getClientRects()].filter(t=>t.left<r.left-1||t.right>r.right+1||(s.overflow==='hidden'&&(t.top<r.top-1||t.bottom>r.bottom+1))).map(()=>({text:el.textContent,reason:'glyph'}));});
 return[];
}));}
async function main(){
 fs.mkdirSync(out,{recursive:true});const mocks=path.join(__dirname,'tradingMocks.js');
 await esbuild.build({entryPoints:[path.join(__dirname,'tradingFixture.jsx')],outfile:path.join(out,'bundle.js'),bundle:true,minify:true,platform:'browser',format:'iife',nodePaths:[path.join(root,'node_modules')],resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.jsx','.json'],mainFields:['browser','module','main'],define:{global:'globalThis','process.env.NODE_ENV':'"production"',__DEV__:'false'},loader:{'.png':'dataurl'},plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^react-native$/},()=>({path:path.join(__dirname,'nativeWeb.jsx')}));
 b.onResolve({filter:/^@react-navigation\/(native|elements)$/},()=>({path:mocks}));
 b.onResolve({filter:/(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/},()=>({path:mocks}));
 }}],logLevel:'warning'});
 const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>';
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url.startsWith('/bundle.js')?'text/javascript':'text/html');res.end(req.url.startsWith('/bundle.js')?fs.readFileSync(path.join(out,'bundle.js')):html);}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-sandbox']}).catch(error=>{server.close();throw error;});const page=await browser.newPage();page.setDefaultTimeout(10000);
 const base=`http://127.0.0.1:${server.address().port}`,errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 try{
 for(const width of [320,360,390,430]) for(const theme of ['light','dark']) for(const fontScale of [1,2]) for(const scenario of ['market','limit-long','limit-short','holdings','pending-limit','pending-protection']){
  const screen=scenario==='market'?'market':scenario.startsWith('limit-')?'futures':'order';
  await page.setViewportSize({width,height:width===320?568:844});await page.emulateMedia({colorScheme:theme});
  await page.goto(`${base}/?screen=${screen}&asset=SUI&longName=1&pending=1&fontScale=${fontScale}&protection=${scenario==='pending-protection'?'holding':'editor'}`);
  await page.waitForFunction(()=>window.tradingAppearance);await page.evaluate(v=>window.tradingAppearance.setPreference(v),theme);
  if(scenario==='market'){
   await page.getByRole('tab',{name:'암호화폐',exact:true}).click();
   assert.equal(await page.getByTestId('crypto-product-spot').getAttribute('aria-selected'),'true');
   await page.getByTestId('crypto-product-futures').click();await page.getByTestId('futures-market-btc').waitFor();
   assert.deepEqual(await overflow(page),[],`${width}/${theme}/${fontScale}/market-selector`);
   await page.getByTestId('futures-market-btc').click();await page.getByTestId('futures-screen').waitFor();
   assert.equal(await page.evaluate(()=>window.fixture.state.instrumentId),'btc');
  }else if(scenario.startsWith('limit-')){
   await page.getByRole('button',{name:'지정가 진입',exact:true}).click();
   await page.getByRole('button',{name:scenario==='limit-long'?'롱(Long)':'숏(Short)',exact:true}).click();
   await page.getByRole('button',{name:scenario==='limit-long'?'교차(Cross)':'격리(Isolated)',exact:true}).click();
   await page.getByTestId('futures-leverage').fill('100');await page.getByTestId('futures-quantity').fill('0.12345678');
   await page.getByTestId('futures-limit-price').fill('1234567890123456.12345678');
   for(const kind of ['stop_loss','take_profit']){
    const label=kind==='stop_loss'?'손절 (Stop Loss)':'익절 (Take Profit)';
    await page.getByTestId(`protection-${kind}-toggle`).click();await page.getByLabel(label+' 조건 가격',{exact:true}).fill(kind==='stop_loss'?'90000.00000001':'123456789.12345678');
    await page.getByTestId(`protection-${kind}-limit`).click();await page.getByLabel(label+' 실행 지정가',{exact:true}).fill('1234567890123456.12345678');
   }
  }else if(scenario==='holdings'){
   await page.getByTestId('holding-protection-SUI').click();await page.getByTestId('protection-panel').waitFor();
   assert.equal(await page.getByTestId('holdings-filter-current').getAttribute('aria-pressed'),'true');
  }else{
   await page.getByTestId('holdings-filter-pending').click();await page.getByTestId('pending-futures').waitFor();
   if(scenario==='pending-protection'){await page.getByTestId('pending-kind-protection').click();await page.getByTestId('pending-protections').waitFor();assert.equal(await page.getByTestId('pending-futures').count(),0);}
   else {await page.getByTestId('pending-order-buy').waitFor();assert.equal(await page.getByTestId('pending-order-child').count(),0);assert.equal(await page.getByTestId('pending-order-buy').count(),1);assert.equal(await page.getByTestId('pending-order-sell').count(),1);}
  }
  await page.waitForTimeout(60);assert.deepEqual(await overflow(page),[],`${width}/${theme}/${fontScale}/${scenario}`);
  const label=`${width}-${theme}-${fontScale}-${scenario}`;results.push(label);
  if(width===320&&fontScale===2){const target=scenario.startsWith('limit-')?'futures-limit-submit':scenario==='market'?'futures-screen':scenario==='holdings'?'holding-protection-SUI':scenario==='pending-limit'?'pending-futures':'pending-protections';await page.getByTestId(target).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,label+'.png')});}
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({layouts:results.length,results,errors,scope:'RN Web real screens; native IME/device not exercised'},null,2));console.log(`Futures integration browser PASS ${results.length} layouts and Market navigation`);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
