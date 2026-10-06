import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { setup, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');
const gateway = { isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status: 503, data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'raw credentials/database must stay hidden' } } } };

for (const mode of ['general', 'season']) {
  it(`${mode}: persistent failure names portfolio, retains context, passes diagnostics and recovers once on focus`, async t => {
    let fails = true;
    const h = setup(mode, 7, 'home', { queryDefaults: { retryDelay: 0 }, beforeRead: async r => { if (r.section === 'portfolio' && fails) throw gateway; } });
    t.after(h.close); await flush();
    const errors = h.renderer.root.findAllByType('ErrorState');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].props.title, '포트폴리오 정보를 불러오지 못했습니다.');
    assert.equal(errors[0].props.diagnosticError, gateway);
    assert.equal(errors[0].props.diagnosticRuntime.httpStatus, 503);
    assert.equal(h.renderer.root.findAllByType('Hero').length, 0);
    const contextTexts = h.renderer.root.findAllByType('Text').flatMap(node => node.props.children).filter(value => typeof value === 'string').join(' ');
    assert.match(contextTexts, /mycroft/);
    if (mode === 'season') assert.match(contextTexts, /#99999/);
    const before = h.requests.filter(r => r.section === 'portfolio').length;
    assert.equal(before, 2);
    fails = false; h.focus(); await flush();
    assert.equal(h.renderer.root.findByType('Hero').props.summary.totalAssetKrw, mode);
    assert.equal(h.requests.filter(r => r.section === 'portfolio').length, before + 1);
    h.focus(); await flush();
    assert.equal(h.requests.filter(r => r.section === 'portfolio').length, before + 1, 'success cache is not fetched on focus');
  });
  it(`${mode}: structural failure is fail closed and is never retried by timer/focus`, async t => {
    const error = { response: { status: 500, data: { error: { code: 'CASH_WALLET_INVALID' } } } };
    const h = setup(mode, 7, 'home', { beforeRead: async r => { if (r.section === 'portfolio') throw error; } });
    t.after(h.close); await flush();
    assert.equal(h.requests.filter(r => r.section === 'portfolio').length, 1);
    assert.equal(h.renderer.root.findByType('ErrorState').props.title, '데이터를 안전하게 표시할 수 없습니다.');
    assert.equal(h.renderer.root.findByType('ErrorState').props.diagnosticError, error);
    h.focus(); await flush();
    assert.equal(h.requests.filter(r => r.section === 'portfolio').length, 1);
    assert.equal(h.renderer.root.findAllByType('Hero').length, 0);
  });
  it(`${mode}: success-envelope unavailable remains a notice, not a full request error`, async t => {
    const h = setup(mode); t.after(h.close); await flush();
    act(() => h.client.setQueryData(QUERY_KEYS.tradingAccount.portfolio(mode), { state: 'unavailable', summary: null, sectionErrors: [{ code: 'FX_RATE_STALE' }] }));
    await flush();
    assert.equal(h.renderer.root.findAllByType('ErrorState').length, 0);
    assert.equal(h.renderer.root.findByType('Hero').props.summary, null);
    h.focus(); await flush();
    assert.equal(h.requests.filter(r => r.section === 'portfolio').length, 1);
  });
}
