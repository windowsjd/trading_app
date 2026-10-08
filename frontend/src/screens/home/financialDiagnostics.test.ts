import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { financialDiagnosticsHarness, failure, act, QUERY_KEYS } = require('../../../test/financialDiagnosticsHarness.cjs');
const { walletTransferHarness } = require('../../../test/walletTransferHarness.cjs');
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');
const { futuresHarness } = require('../../../test/futuresHarness.cjs');
const { createTradingUiHarness, elements } = require('../../../test/tradingUiHarness.cjs');
const forbidden = /fake-only-token|fake-password|db\.invalid|provider\.invalid|RAW_EXCEPTION|184527\.938475/;
const renderedText = (h: any) => h.renderer.root.findAllByType('Text')
  .flatMap((node: any) => [node.props.children].flat(Infinity))
  .filter((value: any) => typeof value === 'string' || typeof value === 'number').join(' ').replace(/\u200b/g, '');
const expandPanels = async (h: any) => {
  await act(async () => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'admin-diagnostic-toggle')
    .forEach((node: any) => { if (!node.props.accessibilityState.expanded) node.props.onPress(); }));
  await h.flush();
};

const cases = [
  { name: 'Home account lookup', screen: 'home', key: 'accounts', title: '계정 정보를 불러오지 못했습니다.' },
  { name: 'Holdings preview', screen: 'home', key: 'A:positions:preview', title: '보유 종목을 불러오지 못했습니다.' },
  { name: 'Holdings full', screen: 'home', key: 'A:positions:full', title: '전체 보유 종목을 불러오지 못했습니다.', open: 'home-holdings-toggle' },
  { name: 'Home portfolio', screen: 'home', key: 'A:portfolio', title: '포트폴리오 정보를 불러오지 못했습니다.' },
  { name: 'Home equity', screen: 'home', key: 'A:portfolio/equity', message: '자산 추이를 불러오지 못했습니다.', open: 'home-trend-toggle' },
  { name: 'Wallet portfolio', screen: 'wallet', key: 'A:portfolio', title: '총 자산을 불러오지 못했습니다.' },
  { name: 'Wallet cash', screen: 'wallet', key: 'A:wallets', title: '현금 잔액을 불러오지 못했습니다.' },
  { name: 'Wallet holdings', screen: 'wallet', key: 'A:positions:full', title: '보유 종목을 불러오지 못했습니다.' },
  { name: 'Wallet equity', screen: 'wallet', key: 'A:portfolio/equity', message: '자산 추이를 불러오지 못했습니다.', open: 'home-trend-toggle' },
  { name: 'Wallet ledger', screen: 'ledger', key: 'A:wallet-transactions', title: '지갑 원장을 불러오지 못했습니다.' },
  { name: 'Portfolio overview', screen: 'portfolio', key: 'A:portfolio', title: '포트폴리오를 불러오지 못했습니다.' },
  { name: 'Portfolio equity', screen: 'portfolio', key: 'A:portfolio/equity', message: '자산 추이를 불러오지 못했습니다.' },
  { name: 'Trade history', screen: 'history', key: 'A:orders', title: '거래 내역을 불러오지 못했습니다.' },
];
for (const role of ['user', 'operator', 'admin']) for (const scenario of cases) {
  it(`${scenario.name}: original failure, safe copy and ${role} gate`, async t => {
    const error = failure(`request-${scenario.key}`);
    const h = financialDiagnosticsHarness(scenario.screen, { role, failures: { [scenario.key]: error } });
    t.after(h.close); await h.start();
    if (scenario.open) await h.press(scenario.open);
    assert.ok(h.text().includes(scenario.title ?? scenario.message));
    assert.doesNotMatch(h.text(), forbidden);
    const errorNodes = h.renderer.root.findAll((node: any) => typeof node.type === 'function' && ['ErrorState', 'ErrorNotice', 'AdminDiagnosticPanel'].includes(node.type.name));
    assert.ok(errorNodes.some((node: any) => node.props.error === error), 'actual HTTP rejection reaches the error UI');
    assert.equal(Boolean(h.find('admin-diagnostic-panel')), role === 'admin');
    if (role === 'admin') {
      const before = h.requests.length;
      await h.expand();
      assert.ok(h.text().includes(`request-${scenario.key}`));
      assert.doesNotMatch(h.text(), forbidden);
      assert.equal(h.requests.length, before, 'opening diagnostics issues no financial/API reads');
    }
  });
}

for (const scenario of [cases[1], cases[2], { name: 'Wallet account lookup', screen: 'wallet', key: 'accounts', title: '계정 정보를 불러오지 못했습니다.' }, cases[5], cases[6], cases[7]]) it(`${scenario.name}: wiring preserves the previous default public copy even for a known error code`, async t => {
  const error = failure('rate-limited-request', 'TOO_MANY_REQUESTS'); error.response.status = 429;
  const h = financialDiagnosticsHarness(scenario.screen, { failures: { [scenario.key]: error } });
  t.after(h.close); await h.start(); if ('open' in scenario && scenario.open) await h.press(scenario.open);
  const state = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorState').find((node: any) => node.props.title === scenario.title);
  assert.equal(state.props.error, error);
  assert.equal(state.props.message, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
  assert.ok(!h.text().includes('요청이 너무 많습니다.'));
});

for (const screen of ['home', 'wallet', 'portfolio', 'ledger', 'history']) it(`${screen}: account list rejection precedes empty state and retry succeeds`, async t => {
  const error = failure('account-list-request');
  const h = financialDiagnosticsHarness(screen, { failures: { accounts: error } });
  t.after(h.close); await h.start();
  assert.equal(h.accountContext.error, error, 'the actual provider exposes its query error');
  assert.equal(h.renderer.root.findAllByType('AccountSetupPanel').length, 0);
  assert.equal(h.requests.some((request: any) => request.path.includes('/trading-accounts/A/')), false, 'failed lookup cannot select an absent account');
  await h.expand(); assert.ok(h.text().includes('account-list-request'));
  delete h.failures.accounts;
  const errorState = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorState')[0];
  act(() => errorState.props.onRetry()); await h.flush(); await h.flush();
  assert.equal(h.accountContext.isError, false);
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true);
});

for (const mode of ['general', 'season']) it(`${mode} Home: HTTP 200 section failure is preserved, separate from a rejected query`, async t => {
  const h = financialDiagnosticsHarness('home', { mode });
  const diagnostic = failure('partial-portfolio').response.data.error.diagnostic;
  const partial = { section: 'portfolio', code: 'FX_RATE_UNAVAILABLE', message: 'RAW_EXCEPTION fake-only-token', diagnostic };
  h.portfolios.A = { ...h.portfolios.A, state: 'unavailable', summary: null, sectionErrors: [partial] };
  t.after(h.close); await h.start();
  assert.equal(h.client.getQueryState(QUERY_KEYS.tradingAccount.portfolio('A')).status, 'success');
  assert.match(h.text(), /일부 시세 조회 불가/);
  await h.expand(); assert.ok(h.text().includes('partial-portfolio')); assert.doesNotMatch(h.text(), forbidden);
  h.portfolios.A = { ...h.portfolios.B, tradingAccountId: 'A' };
  await act(async () => h.client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.portfolio('A') })); await h.flush();
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true);
});

for (const screen of ['home', 'wallet']) it(`${screen}: existing valuation diagnostic survives complete holdings, with no fabricated unavailable failure`, async t => {
  const h = financialDiagnosticsHarness(screen);
  const diagnostic = failure('positions-partial').response.data.error.diagnostic;
  h.positions.A.forEach((position: any) => { position.valuation = { state: 'unavailable' }; });
  h.valuationErrors.A = [{ section: 'positions', code: 'ASSET_PRICE_UNAVAILABLE', message: 'RAW_EXCEPTION', diagnostic }];
  t.after(h.close); await h.start();
  if (screen === 'home') await h.press('home-holdings-toggle');
  await h.expand(); assert.ok(h.text().includes('positions-partial')); assert.doesNotMatch(h.text(), forbidden);
  if (screen === 'wallet') {
    const cached = h.client.getQueryData(QUERY_KEYS.tradingAccount.holdings('A'));
    assert.equal(cached.valuationErrors[0].diagnostic, diagnostic);
  }
  await h.switch('B');
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true, 'normal unavailable/empty data never creates a diagnostic');
  assert.ok(!h.text().includes('positions-partial'));
});

for (const screen of ['wallet', 'ledger', 'history']) it(`${screen}: real integrity failure keeps its classification and original diagnostic`, async t => {
  const key = screen === 'wallet' ? 'A:wallets' : screen === 'ledger' ? 'A:wallet-transactions' : 'A:orders';
  const error = failure('integrity-request', 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH');
  const h = financialDiagnosticsHarness(screen, { failures: { [key]: error } });
  t.after(h.close); await h.start();
  assert.match(h.text(), /데이터를 안전하게 표시할 수 없습니다/);
  assert.match(h.text(), /잔액이나 보유 내역이 0이라는 뜻이 아닙니다/);
  await h.expand(); assert.ok(h.text().includes('integrity-request'));
});

it('Portfolio: concurrent generic and integrity failures select the actual integrity request', async t => {
  const generic = failure('generic-overview');
  const integrity = failure('integrity-positions', 'POSITION_INVALID');
  const h = financialDiagnosticsHarness('portfolio', { failures: { 'A:portfolio': generic, 'A:positions:filtered': integrity } });
  t.after(h.close); await h.start(); await h.expand();
  assert.match(h.text(), /데이터를 안전하게 표시할 수 없습니다/);
  assert.ok(h.text().includes('integrity-positions'));
  assert.ok(!h.text().includes('generic-overview'));
});

it('Wallet: simultaneous independent query failures keep distinct error/diagnostic pairs and retry one request', async t => {
  const errors = { 'A:wallets': failure('cash-request'), 'A:positions:full': failure('holdings-request') };
  const h = financialDiagnosticsHarness('wallet', { failures: errors });
  t.after(h.close); await h.start(); await h.expand();
  assert.ok(h.text().includes('cash-request')); assert.ok(h.text().includes('holdings-request'));
  for (const [title, error] of [['현금 잔액을 불러오지 못했습니다.', errors['A:wallets']], ['보유 종목을 불러오지 못했습니다.', errors['A:positions:full']]]) {
    const state = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorState').find((node: any) => node.props.title === title);
    assert.equal(state.props.error, error);
    const panel = state.findAll((node: any) => node.type.name === 'AdminDiagnosticPanel')[0];
    assert.equal(panel.props.error, error);
  }
  delete h.failures['A:wallets'];
  await h.retry('현금 잔액을 불러오지 못했습니다.');
  assert.ok(!h.text().includes('cash-request')); assert.ok(h.text().includes('holdings-request'));
});

it('Portfolio: concurrent positions/equity errors retain both matching diagnostics in the partial notice', async t => {
  const errors = { 'A:positions:filtered': failure('portfolio-positions'), 'A:portfolio/equity': failure('portfolio-equity') };
  const h = financialDiagnosticsHarness('portfolio', { failures: errors });
  t.after(h.close); await h.start(); await h.expand();
  assert.match(h.text(), /일부 포트폴리오 정보를 불러오지 못했습니다/);
  assert.ok(h.text().includes('portfolio-positions')); assert.ok(h.text().includes('portfolio-equity'));
  const panels = h.renderer.root.findAll((node: any) => node.type.name === 'AdminDiagnosticPanel');
  for (const error of Object.values(errors)) assert.ok(panels.some((node: any) => node.props.error === error));
});

for (const scenario of cases.filter(scenario => scenario.title && scenario.key !== 'accounts')) it(`${scenario.name}: successful retry clears the failed request diagnostic`, async t => {
  const h = financialDiagnosticsHarness(scenario.screen, { failures: { [scenario.key]: failure('retry-request') } });
  t.after(h.close); await h.start(); if (scenario.open) await h.press(scenario.open);
  await h.expand(); assert.ok(h.text().includes('retry-request'));
  delete h.failures[scenario.key]; await h.retry(scenario.title); await h.flush();
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true);
});

for (const screen of ['home', 'wallet', 'ledger', 'portfolio']) it(`${screen}: failed account A diagnostics disappear on account B`, async t => {
  const key = screen === 'home' ? 'A:positions:preview' : screen === 'wallet' ? 'A:wallets' : screen === 'ledger' ? 'A:wallet-transactions' : 'A:portfolio';
  const h = financialDiagnosticsHarness(screen, { failures: { [key]: failure('request-A') } });
  t.after(h.close); await h.start(); await h.expand(); assert.ok(h.text().includes('request-A'));
  await h.switch('B');
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true); assert.ok(!h.text().includes('request-A'));
});

for (const gate of ['unresolved', 'lookup-failed']) it(`diagnostics fail closed when /me is ${gate}`, async t => {
  const h = financialDiagnosticsHarness('wallet', { role: gate === 'unresolved' ? null : 'admin', failures: { 'A:wallets': failure('private-request') } });
  t.after(h.close); await h.start();
  if (gate === 'lookup-failed') {
    h.failures.me = new Error('role lookup unavailable');
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.me })); await h.flush();
    assert.equal(h.client.getQueryState(QUERY_KEYS.me).status, 'error', 'cached admin data cannot override a failed lookup');
  }
  assert.match(h.text(), /현금 잔액을 불러오지 못했습니다/);
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true); assert.ok(!h.text().includes('private-request'));
});

for (const screen of ['home', 'wallet', 'portfolio', 'ledger', 'history']) it(`${screen}: successful empty data has no backend diagnostic`, async t => {
  const h = financialDiagnosticsHarness(screen); h.positions.A = []; h.orders.A = [];
  t.after(h.close); await h.start();
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true);
});

const confirmCancel = async (h: any) => {
  await h.press('record-order-cancel-limit-A');
  act(() => h.alerts.at(-1)[2].find((button: any) => button.text === '주문 취소').onPress());
  await h.flush();
};
for (const role of ['user', 'operator', 'admin']) it(`cancel mutation: safe existing alert, original inline failure and ${role} gate`, async t => {
  const error = failure('cancel-request');
  const h = financialDiagnosticsHarness('history', { role, failures: { 'A:cancel': error } });
  t.after(h.close); await h.start(); await confirmCancel(h);
  assert.equal(h.alerts.at(-1)[0], '주문 취소 실패');
  assert.doesNotMatch(JSON.stringify(h.alerts.at(-1)), forbidden);
  assert.ok(h.find('trade-history-cancel-error'));
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice').find((node: any) => node.props.testID === 'trade-history-cancel-error');
  assert.equal(notice.props.error, error);
  assert.equal(h.alerts.at(-1)[1], notice.props.message, 'all roles get the same existing public copy');
  assert.equal(Boolean(h.find('admin-diagnostic-panel')), role === 'admin');
  if (role === 'admin') { await h.expand(); assert.ok(h.text().includes('cancel-request')); }
  assert.doesNotMatch(h.text(), forbidden);
  assert.equal(h.requests.filter((request: any) => request.method === 'POST').length, 1);
  delete h.failures['A:cancel'];
  await confirmCancel(h); await h.flush();
  assert.equal(h.find('trade-history-cancel-error') === undefined, true);
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true, 'a new successful mutation removes the old diagnostic');
});

it('cancel errors are pinned to the history route, and cannot survive changing its subject', async t => {
  const h = financialDiagnosticsHarness('history', { failures: { 'A:cancel': failure('cancel-A') } });
  t.after(h.close); await h.start(); await confirmCancel(h); await h.expand();
  await h.switch('B');
  assert.ok(h.text().includes('cancel-A'), 'global selection cannot retarget a history screen pinned to A');
  h.route = { accountId: 'B' }; await h.update();
  assert.equal(h.find('trade-history-cancel-error') === undefined, true); assert.ok(!h.text().includes('cancel-A'));
  h.route = { accountId: 'A' }; await h.update();
  assert.equal(h.find('trade-history-cancel-error') === undefined, true, 'A→B→A is a new route scope');
});

it('late cancel failure and an old confirmation cannot attach to an A→B→A history scope', async t => {
  const h = financialDiagnosticsHarness('history', { failures: { 'A:cancel': failure('late-cancel-A') } });
  const gate = Promise.withResolvers(); h.gates['A:cancel'] = gate;
  t.after(h.close); await h.start(); await confirmCancel(h);
  h.route = { accountId: 'B' }; await h.update(); h.route = { accountId: 'A' }; await h.update();
  assert.equal(h.find('record-order-cancel-limit-A').props.disabled, false, 'old pending scope cannot keep the current row loading');
  await act(async () => gate.resolve(undefined)); await h.flush();
  assert.equal(h.find('trade-history-cancel-error') === undefined, true);
  assert.equal(h.alerts.some((alert: any) => alert[0] === '주문 취소 실패'), false);
  await h.press('record-order-cancel-limit-A');
  const oldConfirmation = h.alerts.at(-1)[2].find((button: any) => button.text === '주문 취소');
  h.route = { accountId: 'B' }; await h.update();
  const before = h.requests.filter((request: any) => request.method === 'POST').length;
  act(() => oldConfirmation.onPress()); await h.flush();
  assert.equal(h.requests.filter((request: any) => request.method === 'POST').length, before);
});

for (const role of ['user', 'operator', 'admin']) it(`Futures collateral query: safe copy, original error and ${role} gate`, async t => {
  const h = walletTransferHarness({ diagnostics: true, role });
  const error = failure('collateral-request'); h.riskFailure = error;
  t.after(h.close); await h.start(); await h.choose('source', 'crypto_futures'); await h.flush();
  assert.match(renderedText(h), /현재 선물 지갑의 이체 가능 금액을 확인할 수 없습니다/);
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice')[0];
  assert.equal(notice.props.error, error);
  assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin');
  const before = h.gets.length; await expandPanels(h);
  assert.equal(h.gets.length, before); assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes('collateral-request'));
  h.riskFailure = null;
  const retry = h.renderer.root.findAllByType('CTAButton').find((node: any) => node.props.label === '이체 가능 금액 다시 확인');
  await act(async () => retry.props.onPress()); await h.flush();
  assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
});

it('Futures collateral integrity failure uses the existing integrity state, while normal unavailable collateral has no diagnostic', async t => {
  const h = walletTransferHarness({ diagnostics: true, role: 'admin' });
  const error = failure('collateral-integrity', 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH'); h.riskFailure = error;
  t.after(h.close); await h.start(); await h.choose('source', 'crypto_futures'); await h.flush();
  const state = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorState')[0];
  assert.equal(state.props.error, error); assert.match(renderedText(h), /데이터를 안전하게 표시할 수 없습니다/);
  await expandPanels(h); assert.ok(renderedText(h).includes('collateral-integrity'));
  h.riskFailure = null; h.risk.A.collateral.freeCollateral = null;
  await act(async () => state.props.onRetry()); await h.flush();
  assert.match(renderedText(h), /현재 선물 지갑의 이체 가능 금액을 확인할 수 없습니다/);
  assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
  await h.switchAccount('B'); assert.ok(!renderedText(h).includes('collateral-integrity'));
});

for (const role of ['user', 'operator', 'admin']) it(`existing transfer mutation wiring preserves ${role} gate and clears after success`, async t => {
  const h = walletTransferHarness({ diagnostics: true, role }); const error = failure('transfer-request'); h.failure = error;
  t.after(h.close); await h.start(); await h.amount('10'); await h.press('wallet-transfer-submit');
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice').find((node: any) => node.props.testID === 'wallet-transfer-error');
  assert.equal(notice.props.error, error); assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin');
  await expandPanels(h); assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes('transfer-request'));
  h.failure = null; await h.press('wallet-transfer-submit');
  assert.ok(h.node('wallet-transfer-success')); assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
});

for (const role of ['user', 'operator', 'admin']) it(`Order wallet query failure reaches the existing public copy and ${role} gate`, async t => {
  const h = inlineTradingHarness(); h.role = role; const error = failure('order-wallet-request'); h.walletState = { isError: true, error };
  t.after(h.close); await h.mount(); await h.flush();
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice')[0];
  assert.equal(notice.props.error, error); assert.equal(notice.props.message, '지갑 잔액을 확인할 수 없습니다.');
  assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin');
  await expandPanels(h); assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes('order-wallet-request'));
  h.walletState = {}; await h.update(); assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
});

for (const role of ['user', 'operator', 'admin']) for (const screen of ['order', 'futures']) it(`${screen}: account query rejection reaches its actual error UI for ${role}`, async t => {
  const h = screen === 'order' ? inlineTradingHarness() : futuresHarness({ diagnostics: true, role });
  const error = failure('bound-account-list'); h.role = role; h.accountState = { isError: true, error };
  t.after(h.close);
  if (screen === 'order') { await h.mount(); await h.flush(); } else await h.start();
  const state = h.renderer.root.findAll((node: any) => ['ErrorState', 'ErrorNotice'].includes(node.type.name)).find((node: any) => node.props.error === error);
  assert.ok(state); assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin');
  await expandPanels(h); assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes('bound-account-list'));
});

for (const role of ['user', 'operator', 'admin']) it(`Home season header: existing ranking failure notice preserves its own diagnostic for ${role}`, async t => {
  const error = failure('home-ranking-request'); const h = financialDiagnosticsHarness('home', { role, mode: 'season', failures: { ranking: error } });
  t.after(h.close); await h.start();
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice').find((node: any) => node.props.error === error);
  assert.ok(notice); assert.match(h.text(), /랭킹 정보를 불러오지 못했습니다/); assert.equal(Boolean(h.find('admin-diagnostic-panel')), role === 'admin');
  await h.expand(); assert.doesNotMatch(h.text(), forbidden);
  if (role === 'admin') assert.ok(h.text().includes('home-ranking-request'));
});

for (const walletFailed of [false, true]) it(`FX: ${walletFailed ? 'wallet rejection selects only its own failure' : 'HTTP 200 unavailable wallets do not borrow a rate failure'}`, () => {
  const h = createTradingUiHarness('wallet/WalletFxScreen.tsx'); const walletError = failure('fx-wallet-request');
  h.walletQuery = { data: { state: 'unavailable', wallets: [] }, isError: walletFailed, error: walletFailed ? walletError : undefined };
  h.rateQuery = { data: undefined, isError: true, error: failure('unrelated-rate-request') };
  const state = elements(h.render(), 'ErrorState')[0];
  assert.ok(state); assert.equal(state.props.error, walletFailed ? walletError : undefined);
  assert.equal(state.props.diagnosticError, undefined);
});

it('Order concurrent generic position and wallet integrity errors select only the actual integrity failure', async t => {
  const h = inlineTradingHarness(); h.role = 'admin';
  h.positionState = { isError: true, error: failure('generic-position-request') };
  const integrity = failure('wallet-integrity-request', 'CASH_WALLET_INVALID'); h.walletState = { isError: true, error: integrity };
  t.after(h.close); await h.mount(); await h.flush(); await expandPanels(h);
  const panel = h.renderer.root.findAll((node: any) => node.type.name === 'AdminDiagnosticPanel').find((node: any) => node.props.error === integrity);
  assert.ok(panel); assert.ok(renderedText(h).includes('wallet-integrity-request')); assert.ok(!renderedText(h).includes('generic-position-request'));
});

for (const stage of ['quote', 'create']) for (const role of ['user', 'operator', 'admin']) it(`existing ${stage} mutation wiring preserves ${role} gate and clears after success`, async t => {
  const h = inlineTradingHarness(); h.role = role; const error = failure(`order-${stage}-request`);
  h[stage === 'quote' ? 'quoteFailure' : 'failure'] = error;
  t.after(h.close); await h.mount(); await h.input(TEST_IDS.order.quantityInput, '1'); await h.press(TEST_IDS.order.executeSubmit); await h.flush();
  assert.ok(h.renderer.root.findAll((node: any) => node.type.name === 'AdminDiagnosticPanel').some((node: any) => node.props.error === error));
  assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin'); await expandPanels(h);
  assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes(`order-${stage}-request`));
  h.quoteFailure = null; h.failure = null; await h.press(TEST_IDS.order.executeSubmit); await h.flush();
  assert.equal(h.node('admin-diagnostic-panel') === undefined, true); assert.equal(h.success().visible, true);
});

for (const resource of ['instruments', 'executions']) for (const role of ['user', 'operator', 'admin']) it(`Futures ${resource} query failure connects its original error for ${role}`, async t => {
  const h = futuresHarness({ diagnostics: true, role }); const error = failure(`futures-${resource}`);
  const suffix = resource === 'executions' ? 'executions?limit=20&offset=0' : resource;
  h.readFailures = { [`/trading-accounts/A/futures/${suffix}`]: error };
  t.after(h.close); await h.start();
  const notice = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorNotice').find((node: any) => node.props.error === error);
  assert.ok(notice); assert.equal(Boolean(h.node('admin-diagnostic-panel')), role === 'admin'); await expandPanels(h);
  assert.doesNotMatch(renderedText(h), forbidden);
  if (role === 'admin') assert.ok(renderedText(h).includes(`futures-${resource}`));
  h.readFailures = {}; await act(async () => h.client.refetchQueries()); await h.flush();
  assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
});

it('equity range change does not reuse the preceding range failure', async t => {
  const h = financialDiagnosticsHarness('home', { failures: { 'A:portfolio/equity': failure('range-30d') } });
  t.after(h.close); await h.start(); await h.press('home-trend-toggle'); await h.expand();
  assert.ok(h.text().includes('range-30d')); delete h.failures['A:portfolio/equity'];
  await h.press('home-trend-range-7d');
  assert.equal(h.client.getQueryState(QUERY_KEYS.tradingAccount.portfolioEquity('A', '7d', 'daily')).status, 'success');
  assert.equal(h.find('admin-diagnostic-panel') === undefined, true);
  assert.equal(h.client.getQueryState(QUERY_KEYS.tradingAccount.portfolioEquity('A', '30d', 'daily')).status, 'error');
});


for (const kind of ['timeout', 'network', 'contract']) for (const role of ['user', 'operator', 'admin']) it(`transfer ${kind}: uncertain outcome, observed runtime and pinned retry for ${role}`, async t => {
  const h = walletTransferHarness({ diagnostics: true, role }); t.after(h.close);
  if (kind === 'contract') h.response = { tradingAccountId: 'A' };
  else h.failure = { isAxiosError: true, code: kind === 'timeout' ? 'ECONNABORTED' : 'ERR_NETWORK', message: 'Bearer fake-only-token' };
  await h.start(); await h.amount('10'); await h.press('wallet-transfer-submit'); await expandPanels(h);
  assert.match(renderedText(h), kind === 'contract' ? /데이터를 안전하게 표시할 수 없습니다/ : /이체 결과를 확인하지 못했습니다/);
  assert.doesNotMatch(renderedText(h), /fake-only-token|Backend Exception/);
  assert.equal(h.requests.length, 1);
  if (role === 'admin') {
    assert.match(renderedText(h), /wallet_transfer/); assert.match(renderedText(h), /unknown/);
    assert.match(renderedText(h), kind === 'contract' ? /response_validation/ : /request_transport/);
  } else assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
  const key = h.requests[0].body.idempotencyKey;
  h.failure = null; h.response = null;
  if (kind === 'contract') {
    const state = h.renderer.root.findAll((node: any) => node.type.name === 'ErrorState')[0];
    act(() => state.props.onRetry()); await h.flush();
    assert.equal(h.requests.length, 1, 'integrity retry only rereads wallets');
  }
  await h.press('wallet-transfer-submit');
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].body.idempotencyKey, key);
  assert.ok(h.node('wallet-transfer-success')); assert.equal(h.node('admin-diagnostic-panel') === undefined, true);
});

for (const stage of ['quote', 'execute']) it(`order timeout at ${stage}: client observations never assert server execution failure`, async t => {
  const h = inlineTradingHarness(); h.role = 'admin'; t.after(h.close);
  h[stage === 'quote' ? 'quoteFailure' : 'failure'] = { isAxiosError: true, code: 'ECONNABORTED', message: 'Bearer fake-only-token' };
  await h.mount(); await h.input(TEST_IDS.order.quantityInput, '100'); await h.press(TEST_IDS.order.executeSubmit); await h.flush(); await expandPanels(h);
  const before = h.requests.length;
  assert.equal(before, stage === 'quote' ? 1 : 2);
  assert.match(renderedText(h), /request_transport/); assert.doesNotMatch(renderedText(h), /Backend Exception|fake-only-token/);
  assert.match(renderedText(h), stage === 'quote' ? /not_submitted/ : /unknown/);
  if (stage === 'execute') {
    assert.match(renderedText(h), /주문 결과를 확인하지 못했습니다/);
    const key = h.requests[1].body.idempotencyKey;
    h.failure = null; await h.press(TEST_IDS.order.executeSubmit); await h.flush();
    assert.equal(h.requests.length, before + 1); assert.equal(h.requests[2].body.idempotencyKey, key);
  }
});

it('portfolio renders each failed query once, even when its partial notice is visible', async t => {
  const h = financialDiagnosticsHarness('portfolio', { failures: { 'A:positions:filtered': failure('positions-only'), 'A:portfolio/equity': failure('equity-only') } }); t.after(h.close);
  await h.start(); await h.expand();
  const panels = h.renderer.root.findAll((node: any) => node.type.name === 'AdminDiagnosticPanel' && node.props.error);
  assert.equal(panels.filter((node: any) => node.props.error === h.failures['A:positions:filtered']).length, 1);
  assert.equal(panels.filter((node: any) => node.props.error === h.failures['A:portfolio/equity']).length, 1);
});

for (const stage of ['quote', 'execute']) it(`order ${stage} response validation preserves uncertainty without an automatic second mutation`, async t => {
  const h = inlineTradingHarness(); h.role = 'admin'; t.after(h.close);
  if (stage === 'quote') h.quoteOverride = { quoteId: '' };
  else h.createOverride = { execution: { state: 'unexpected' } };
  await h.mount(); await h.input(TEST_IDS.order.quantityInput, '100'); await h.press(TEST_IDS.order.executeSubmit); await h.flush(); await expandPanels(h);
  assert.match(renderedText(h), /response_validation/);
  assert.match(renderedText(h), stage === 'quote' ? /not_submitted/ : /unknown/);
  assert.doesNotMatch(renderedText(h), /Backend Exception/);
  assert.equal(h.requests.length, stage === 'quote' ? 1 : 2);
  if (stage === 'execute') {
    assert.match(renderedText(h), /주문 결과를 확인할 수 없습니다/);
    await h.press(TEST_IDS.order.executeSubmit); await h.flush();
    assert.equal(h.requests.length, 2, 'existing completed-action fence prevents a duplicate command');
  }
});

for (const screen of ['home', 'portfolio']) for (const role of ['user', 'operator', 'admin']) it(`${screen} cached live-valuation failure: ${role} gate, sanitization and recovery`, async t => {
  const h = financialDiagnosticsHarness(screen, { role }); t.after(h.close);
  const live = h.positions.A[0].valuation;
  const diagnostic = failure('cached-live-request').response.data.error.diagnostic;
  diagnostic.evidence = { ...diagnostic.evidence, rawPayload: 'Bearer fake-only-token', balanceAmount: '184527.938475' };
  h.positions.A[0].valuation = { ...live, state: 'stale_cache', reason: 'LIVE_VALUATION_UNAVAILABLE', diagnostic };
  await h.start(); await h.expand();
  assert.equal(h.text().includes('cached-live-request'), role === 'admin'); assert.doesNotMatch(h.text(), forbidden);
  const cachedPosition = h.client.getQueriesData({ queryKey: QUERY_KEYS.tradingAccount.positionsAll('A') })
    .flatMap(([, data]: any) => data?.positions ?? data?.pages.flatMap((page: any) => page.positions) ?? [])[0];
  assert.equal(cachedPosition.valuation.state, 'stale_cache');
  h.positions.A = h.positions.A.map((position: any, index: number) => index === 0 ? { ...position, valuation: live } : position);
  assert.equal(cachedPosition === h.positions.A[0], false, 'fixture recovery replaces the position without mutating the cached response');
  assert.equal(cachedPosition.valuation.state, 'stale_cache', 'cached failure survives until the refetch');
  await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.positionsAll('A') }); }); await h.flush();
  const recoveredPosition = h.client.getQueriesData({ queryKey: QUERY_KEYS.tradingAccount.positionsAll('A') })
    .flatMap(([, data]: any) => data?.positions ?? data?.pages.flatMap((page: any) => page.positions) ?? [])[0];
  assert.equal(recoveredPosition.valuation.state, live.state);
  assert.equal(h.text().includes('cached-live-request'), false);
  assert.equal(Boolean(h.find('admin-diagnostic-panel')), false);
});
