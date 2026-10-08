import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { setup, account, flush } = require('../../../test/homeDiscoveryHarness.cjs');
const finalResult = {
  state: 'available', resultSource: 'season_rankings', totalAssetKrw: '25400000', returnRate: '154',
  returnRateMethod: 'initial_capital', rank: 2, tier: 'diamond', maxDrawdown: '40', totalFillCount: 4,
  reachedReturnAt: null, endAt: '2026-10-08T03:00:00.000Z', capturedAt: '2026-10-08T03:07:00.000Z',
};
const finalPortfolio = {
  tradingAccountId: 'season', mode: 'season', status: 'closed', state: 'available', summary: null,
  finalResult, sectionErrors: [], allocation: { state: 'available', cashKrwValue: '25120000', domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '280000' },
};
const text = renderer => renderer.root.findAllByType('Text').flatMap(n => n.props.children).filter(v => typeof v === 'string' || typeof v === 'number').join(' ');

it('settled Home hero uses final totals and never labels current UPNL as final', t => {
  const h = interactionHarness();
  const Hero = h.load('src/screens/home/HomeAssetHero.tsx').default;
  const r = h.render(React.createElement(Hero, { settled: true, finalResult, summary: { totalAssetKrw: '999999', returnRate: '900', unrealizedPnlKrw: '123456' } }));
  t.after(() => act(() => r.unmount()));
  assert.match(text(r), /25,400,000/); assert.match(text(r), /154/);
  assert.doesNotMatch(text(r), /999,999|평가 손익|123,456/);
});
it('missing settled evidence does not fall back to a live summary', t => {
  const h = interactionHarness();
  const Hero = h.load('src/screens/home/HomeAssetHero.tsx').default;
  const r = h.render(React.createElement(Hero, { settled: true, summary: { totalAssetKrw: '999999' } }));
  t.after(() => act(() => r.unmount()));
  assert.doesNotMatch(text(r), /999,999/);
});
it('account-scoped Season Home passes the authoritative final result to the hero', async t => {
  const h = setup('season', 0, 'home', { portfolios: { season: finalPortfolio } });
  t.after(h.close); await flush();
  const hero = h.renderer.root.findByType('Hero');
  assert.deepEqual(hero.props.finalResult, finalResult);
  assert.equal(hero.props.settled, true, 'server finalResult wins over an older active account list');
  await h.switch(account('general')); await flush();
  assert.equal(h.renderer.root.findByType('Hero').props.finalResult, undefined);
});
it('Portfolio shows immutable final summary and clearly labels live holdings as reference', async t => {
  const h = setup('season', 0, 'portfolio', { portfolios: { season: finalPortfolio } });
  t.after(h.close); await flush();
  assert.match(text(h.renderer), /최종 자산/);
  assert.match(text(h.renderer), /25,400,000/);
  assert.match(text(h.renderer), /최종 순위/);
  assert.match(text(h.renderer), /현재 참고 정보/);
  assert.doesNotMatch(text(h.renderer), /수익률 정보를 준비 중/);
});
