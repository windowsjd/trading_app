// Production Futures screen, API, React Query, themed components and focus-scroll.
// Only public transport, account selection, navigation and font-scale are fixtures.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.FUTURES_BROWSER_OUTPUT ?? '/tmp/trading-f3-browser';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'futuresFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root,'node_modules')], resolveExtensions: ['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.jsx','.json'], mainFields: ['browser','module','main'], define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({filter:/^react-native$/},() => ({path:path.join(__dirname,'nativeWeb.jsx')}));
    b.onResolve({filter:/^@react-navigation\/(native|elements)$/},() => ({path:path.join(__dirname,'futuresMocks.js')}));
    b.onResolve({filter:/(services\/api\/client|TradingAccountContext)$/},() => ({path:path.join(__dirname,'futuresMocks.js')}));
  }}], logLevel:'warning' });
  fs.writeFileSync(path.join(out,'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req,res) => { const file=req.url.startsWith('/bundle.js')?'bundle.js':'index.html'; res.setHeader('Content-Type',file==='bundle.js'?'text/javascript':'text/html'); res.end(fs.readFileSync(path.join(out,file))); }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-sandbox']}).catch(error=>{server.close();throw error;}); const page=await browser.newPage(); const errors=[],results=[];
  page.on('pageerror', e=>errors.push(e.message)); const base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  try {
    for (const width of [320,360,390,430]) for (const theme of ['light','dark']) for (const fontScale of [1,2]) for (const kind of ['open','isolated','cross','stale','empty','loading','error']) {
      await page.setViewportSize({width,height:width===320?568:844}); await page.emulateMedia({colorScheme:theme});
      await page.goto(`${base}/?kind=${kind}&fontScale=${fontScale}&account=${theme==='dark'?'B':'A'}`);
      await page.getByText(kind==='loading'?'선물 정보를 불러오고 있습니다.':kind==='error'?'선물 정보를 불러오지 못했습니다.':'암호화폐 선물',{exact:true}).waitFor();
      await page.evaluate(value=>window.futuresAppearance.setPreference(value),theme);
      await page.waitForFunction(value=>window.futuresAppearance.mode===value,theme);
      await page.waitForTimeout(70);
      if(kind==='cross') { await page.getByRole('button',{name:'강제청산 기록',exact:true}).click(); await page.getByText('Mark 청산가',{exact:true}).waitFor(); }
      const overflow=await page.evaluate(()=>[...document.querySelectorAll('div,span')].flatMap(el=>{
        const r=el.getBoundingClientRect(),s=getComputedStyle(el); if (!r.width||!r.height) return [];
        if (r.left < -1 || r.right > innerWidth+1) return [{text:el.textContent.slice(0,80),reason:'box',rect:[r.left,r.right]}];
        if(el.childNodes.length===1 && el.firstChild.nodeType===Node.TEXT_NODE){const ranges=[...el.textContent.matchAll(/\S+/gu)].flatMap(m=>{const range=document.createRange();range.setStart(el.firstChild,m.index);range.setEnd(el.firstChild,m.index+m[0].length);return [...range.getClientRects()];});return ranges.filter(t=>t.left<r.left-1||t.right>r.right+1||(s.overflow==='hidden'&&(t.top<r.top-1||t.bottom>r.bottom+1))).map(t=>({text:el.textContent,reason:'glyph',rect:[t.left,t.right,r.left,r.right]}));}return [];
      }));
      assert.deepEqual(overflow,[],`${width}/${theme}/${fontScale}/${kind}`);
      if(kind==='cross') assert.equal(await page.getByText('예상 청산가',{exact:true}).count(),0);
      if(kind==='stale'){await page.getByRole('button',{name:'전량 종료(Close)',exact:true}).click();await page.getByTestId('futures-submit').scrollIntoViewIfNeeded();assert.notEqual(await page.getByTestId('futures-submit').getAttribute('aria-disabled'),'true');}
      if(kind==='open'){await page.getByTestId('futures-quantity').fill('0.25');await page.getByTestId('futures-leverage').fill('100');await page.getByTestId('futures-submit').click();await page.getByText(/체결 완료/).waitFor();assert.equal(await page.evaluate(()=>window.futuresFixture.requests.length),1);}
      const label=`${width}-${theme}-${fontScale}-${kind}`; results.push(label);
      if(width===320 && fontScale===2 && ['isolated','cross','stale','open'].includes(kind)) { await page.screenshot({path:path.join(out,label+'.png'),fullPage:true}); if(kind==='cross') { await page.getByText('Mark 청산가',{exact:true}).scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(out,label+'-history-viewport.png')}); } await page.getByText('암호화폐 선물',{exact:true}).scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(out,label+'-viewport.png')}); }
    }
    for(const mode of ['REDUCE_ONLY','DISABLED']) {
      await page.goto(`${base}/?kind=cross&mode=${mode}`); await page.getByTestId('futures-submit').waitFor();
      await page.getByRole('button',{name:'전량 종료(Close)',exact:true}).click();
      assert.equal((await page.getByTestId('futures-submit').getAttribute('aria-disabled'))==='true',mode==='DISABLED');
    }
    await page.setViewportSize({width:320,height:568});
    await page.goto(`${base}/?kind=open`); await page.getByTestId('futures-quantity').fill('0.25');
    await page.getByTestId('futures-quantity').focus(); await page.setViewportSize({width:320,height:300});
    await page.getByTestId('futures-quantity').scrollIntoViewIfNeeded();
    assert.ok(await page.getByTestId('futures-quantity').isVisible());
    await page.getByTestId('futures-submit').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,'320-keyboard-resize.png')});
    await page.getByTestId('futures-submit').click(); await page.getByText(/체결 완료/).waitFor();
    await page.setViewportSize({width:1280,height:900}); await page.goto(`${base}/?kind=cross`); await page.getByTestId('futures-screen').waitFor();
    await page.screenshot({path:path.join(out,'1280-cross.png')});
    await page.goto(`${base}/?kind=isolated`); await page.getByTestId('futures-screen').waitFor();await page.evaluate(()=>window.switchFuturesAccount('B'));await page.getByText('선택한 계정이 변경되었습니다.',{exact:true}).waitFor();
    assert.deepEqual(errors,[]); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({layouts:results.length,results,errors,keyboard:'Web focus/viewport resize passed; native keyboard not run'},null,2)); console.log(`Futures browser: ${results.length} layouts and mode/account/keyboard-resize flows passed`);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
