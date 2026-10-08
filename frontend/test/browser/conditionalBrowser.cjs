// Actual Futures, Asset detail and Spot Order screens. Only transport/account/native
// boundaries are fixtures, following the existing responsive browser harness.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const esbuild=require('esbuild'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),out=process.env.CONDITIONAL_BROWSER_OUTPUT??'/tmp/trading-conditional-browser';
async function build(kind){
 const mocks=path.join(__dirname,`${kind}Mocks.js`);
 await esbuild.build({entryPoints:[path.join(__dirname,`${kind}Fixture.jsx`)],outfile:path.join(out,`${kind}.js`),bundle:true,minify:true,platform:'browser',format:'iife',nodePaths:[path.join(root,'node_modules')],resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.jsx','.json'],mainFields:['browser','module','main'],define:{global:'globalThis','process.env.NODE_ENV':'"production"',__DEV__:'false'},loader:{'.png':'dataurl'},plugins:[{name:'isolated-boundaries',setup(b){
 b.onResolve({filter:/^react-native$/},()=>({path:path.join(__dirname,'nativeWeb.jsx')}));
 b.onResolve({filter:/^@react-navigation\/(native|elements)$/},()=>({path:mocks}));
 b.onResolve({filter:/(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/},()=>({path:mocks}));
 }}],logLevel:'warning'});
}
async function overflow(page){return page.evaluate(()=>[...document.querySelectorAll('[data-testid="protection-panel"], [data-testid="attached-entry-editor"]')].flatMap(panel=>[panel,...panel.querySelectorAll('div,span,input')]).flatMap(el=>{
 const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height)return[];
 if(r.left < -1 || r.right > innerWidth+1)return[{text:el.textContent.slice(0,100),reason:'box'}];
 if(el.childNodes.length===1&&el.firstChild.nodeType===Node.TEXT_NODE){return [...el.textContent.matchAll(/\S+/gu)].flatMap(m=>{const range=document.createRange();range.setStart(el.firstChild,m.index);range.setEnd(el.firstChild,m.index+m[0].length);return [...range.getClientRects()].filter(t=>t.left<r.left-1||t.right>r.right+1||(s.overflow==='hidden'&&(t.top<r.top-1||t.bottom>r.bottom+1))).map(()=>({text:el.textContent,reason:'glyph'}));});}return[];
}));}
async function main(){
 fs.mkdirSync(out,{recursive:true});await build('futures');await build('trading');
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/futures.js')||req.url.startsWith('/trading.js')){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(out,req.url.slice(1))));}else{const bundle=req.url.startsWith('/trading')?'trading':'futures';res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${bundle}.js"></script>`);}}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']}),page=await browser.newPage(),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 try{
 for(const width of [320,360,390,430])for(const theme of ['light','dark'])for(const fontScale of [1,2])for(const scenario of ['futures-editor','futures-oco','spot-oco','attached-holding','attached-entry']){
  const futures=scenario.startsWith('futures'),kind=futures?'futures':'trading',editor=scenario.endsWith('editor')||scenario==='attached-entry';
  await page.setViewportSize({width,height:width===320?568:844});await page.emulateMedia({colorScheme:theme});
  const protection=scenario==='attached-holding'?'holding':editor?'editor':'active';
  await page.goto(`${base}/${kind}?fontScale=${fontScale}&kind=cross&protection=${protection}&screen=${scenario==='attached-entry'?'order':'detail'}&asset=BTC`);
  if(scenario==='attached-entry'){
    await page.getByTestId('order-type-toggle-limit').click();
    await page.getByTestId('attached-entry-editor').waitFor();
  }else await page.getByTestId('protection-panel').waitFor();
  await page.evaluate(({futures,theme})=>(futures?window.futuresAppearance:window.tradingAppearance).setPreference(theme),{futures,theme});
  if(editor){
    await page.getByTestId('protection-stop_loss-toggle').click();await page.getByLabel('손절 (Stop Loss) 조건 가격',{exact:true}).fill('90000.00000001');
    await page.getByTestId('protection-stop_loss-limit').click();await page.getByLabel('손절 (Stop Loss) 실행 지정가',{exact:true}).fill('89999.99999999');
    await page.getByTestId('protection-take_profit-toggle').click();await page.getByLabel('익절 (Take Profit) 조건 가격',{exact:true}).fill('123456789.12345678');
    await page.getByTestId('protection-take_profit-limit').click();await page.getByLabel('익절 (Take Profit) 실행 지정가',{exact:true}).fill('123456799.12345678');
  }
  await page.waitForTimeout(60);assert.deepEqual(await overflow(page),[],`${width}/${theme}/${fontScale}/${scenario}`);
  if(scenario.endsWith('oco')){assert.ok(await page.getByText('계속 감시 중',{exact:true}).count());assert.ok(await page.getByText('조건 충족 · 실행/체결 대기',{exact:true}).count());}
  if(scenario==='attached-holding')assert.ok(await page.getByText('진입 체결 후 감시 시작',{exact:true}).count());
  const label=`${width}-${theme}-${fontScale}-${scenario}`;results.push(label);
  if(width===320&&fontScale===2){
   await page.getByText(/익절·손절 보호|체결 후 익절\/손절 \(선택\)/).first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,label+'.png')});
   const detail=editor?page.getByTestId('protection-take_profit-limit'):page.getByText('익절 (Take Profit)',{exact:true});
   await detail.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,label+'-detail.png')});
  }
 }
 for(const protection of ['loading','error']){await page.goto(`${base}/futures?kind=cross&protection=${protection}`);await page.getByText(protection==='loading'?'익절·손절 상태 확인 중…':'익절·손절 정보를 불러오지 못했습니다.',{exact:true}).waitFor();}
 for(const mode of ['REDUCE_ONLY','DISABLED']){await page.goto(`${base}/futures?kind=cross&protection=active&mode=${mode}`);await page.getByTestId('protection-panel').waitFor();assert.equal(await page.getByText('조건 실행 일시 중지',{exact:true}).count()>0,mode==='DISABLED');}
 await page.goto(`${base}/futures?kind=open&protection=complete&mode=DISABLED`);await page.getByTestId('protection-panel').waitFor();await page.getByTestId('protection-history-toggle').click();await page.getByText(/보호 완료/).waitFor();assert.equal(await page.getByTestId('protection-stop_loss-toggle').count(),0);
 await page.setViewportSize({width:320,height:568});await page.goto(`${base}/futures?kind=cross&protection=editor`);await page.getByTestId('protection-stop_loss-toggle').click();
 const input=page.getByLabel('손절 (Stop Loss) 조건 가격',{exact:true});await input.fill('99');await input.focus();await page.setViewportSize({width:320,height:300});await page.waitForTimeout(100);await input.scrollIntoViewIfNeeded();assert.ok(await input.isVisible());await page.screenshot({path:path.join(out,'320-keyboard-resize.png')});
 await page.getByRole('button',{name:'보호 조건 등록',exact:true}).click();await page.getByText('익절·손절 보호를 등록했습니다.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.futuresFixture.requests.filter(r=>r.path.endsWith('/protections')).length),1);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({layouts:results.length,results,errors,keyboard:'Web input focus + viewport resize; native IME not exercised'},null,2));console.log(`Conditional browser PASS ${results.length} layouts + stale/error/mode and keyboard-resize flows`);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
