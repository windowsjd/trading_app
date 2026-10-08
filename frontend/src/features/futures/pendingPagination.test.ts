import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { resolve } from 'node:path';
const { load } = createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');
for (const kind of ['futures','protections']) {
  function api(pages: any[]) {
    let calls=0;
    const value=load(resolve(process.cwd(), `src/features/${kind==='futures' ? 'futures' : 'conditional'}/api.ts`), {'../../services/api/client': {apiClient:{get:async () => { assert.ok(calls<pages.length,'pagination must terminate'); return {data:{data:pages[calls++]}}; }}}});
    return {read:()=> kind==='futures' ? value.getFuturesLimitOrders('A') : value.getPendingProtections('A'), calls:()=>calls};
  }
  const field=kind==='futures' ? 'orders' : 'groups';
  const page=(nextOffset: unknown, id='A')=>({tradingAccountId:id,[field]:[{id:'one'}],pagination:{limit:100,offset:0,total:2,returned:1,nextOffset}});
  for (const offset of [undefined,0,-1,0.5,100001,'100'])
    test(`${kind} malformed nextOffset ${String(offset)} rejects after one page`, async () => {
      const h=api([page(offset)]); await assert.rejects(h.read()); assert.equal(h.calls(),1);
    });
  test(`${kind} accumulates pages and verifies account scope on every page`, async () => {
    const h=api([page(100),{...page(null),[field]:[{id:'two'}]}]);
    assert.deepEqual((await h.read())[field].map((item: any)=>item.id),['one','two']);
    const wrong=api([page(100),page(null,'B')]); await assert.rejects(wrong.read()); assert.equal(wrong.calls(),2);
  });
}
