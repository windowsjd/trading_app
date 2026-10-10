import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
// The same module instance the screens load through the harnesses.
const bridge = require('../../features/quest/questGuideBridge.ts');
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');
const { walletTransferHarness } = require('../../../test/walletTransferHarness.cjs');
const { createHomeHarness } = require('../../../test/homeTestHarness.cjs');

const seasonAccount = {
  id: 'account-1', mode: 'season', status: 'active',
  season: { seasonId: 'season-1', seasonName: '10월 시즌', seasonStatus: 'active', participantStatus: 'active',
    startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() },
};

function fxHarness(mode: 'general' | 'beginner' | 'season' = 'beginner') {
  const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
  h.account = mode === 'season' ? { ...seasonAccount } : { ...h.account, mode };
  return h;
}

async function executeFx(h: any) {
  h.quote = { tradingAccountId: 'account-1', quoteId: 'quote-1', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '100000' };
  h.result = { ...h.quote, exchangeId: 'exchange-1', netTargetAmount: '73.82', wallets: { KRW: '900000', USD: '173.82' } };
  let tree = h.render();
  h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText('100000');
  tree = h.render();
  h.control(tree, TEST_IDS.walletFx.executeSubmit).props.onPress();
  await h.flush();
  return h.render();
}

describe('FX screen and the quest guide', () => {
  it('publishes only what the form shows, following direction, amount and rate', () => {
    const h = fxHarness();
    let tree = h.render();
    assert.deepEqual(bridge.getQuestGuideFacts('fx'), {
      screen: 'fx', accountId: 'account-1', blocked: false, fromCurrency: 'KRW', amountValid: false, rate: 'available',
      previewReady: false, canExecute: false, pending: false, failed: false,
    });
    h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText('100000');
    tree = h.render();
    const ready = bridge.getQuestGuideFacts('fx');
    assert.deepEqual([ready.amountValid, ready.previewReady, ready.canExecute], [true, true, true]);
    h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
    h.render();
    assert.equal(bridge.getQuestGuideFacts('fx').fromCurrency, 'USD');
    h.rateQuery.isError = true;
    h.render();
    assert.deepEqual([bridge.getQuestGuideFacts('fx').rate, bridge.getQuestGuideFacts('fx').canExecute], ['unavailable', false]);
    h.account.status = 'suspended';
    h.render();
    assert.equal(bridge.getQuestGuideFacts('fx').blocked, true);
  });

  it('lets an adopting guide replace the success sheet without changing the command', async () => {
    const adopted: unknown[] = [];
    const dispose = bridge.setQuestGuideCommandSink((command: unknown) => { adopted.push(command); return true; });
    try {
      const h = fxHarness();
      const tree = await executeFx(h);
      assert.equal(h.requests.length, 2, 'one quote and one execute, exactly as without a guide');
      assert.equal(h.requests[0].url, '/trading-accounts/account-1/fx/quote');
      assert.deepEqual(h.requests[1].body, { quoteId: 'quote-1', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '100000',
        idempotencyKey: h.requests[1].body.idempotencyKey });
      assert.deepEqual(adopted, [{ kind: 'fx', accountId: 'account-1', fromCurrency: 'KRW', toCurrency: 'USD', summary: '받은 금액 USD 73.82' }]);
      assert.equal(elements(tree, 'FxSuccessBottomSheet')[0].props.visible, false, 'the guide presents the server-checked outcome');
      assert.equal(h.control(tree, TEST_IDS.walletFx.amountInput).props.value, '');
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, true, 'no second execute');
    } finally { dispose(); }
  });

  it('keeps the normal receipt when no guide adopts the command', async () => {
    const dispose = bridge.setQuestGuideCommandSink(() => false);
    try {
      const h = fxHarness();
      const tree = await executeFx(h);
      assert.equal(elements(tree, 'FxSuccessBottomSheet')[0].props.visible, true);
    } finally { dispose(); }
    const h = fxHarness('general');
    assert.equal(elements(await executeFx(h), 'FxSuccessBottomSheet')[0].props.visible, true);
  });

  for (const mode of ['beginner', 'general', 'season'] as const) {
    it(`${mode}: no account switcher in the exchange form or its restriction state`, () => {
      const h = fxHarness(mode);
      const form = h.render();
      assert.equal(elements(form).some((node: any) => node.type === 'AccountSwitcher'), false);
      assert.equal(elements(form).some((node: any) => node.props.testID === 'fx-wallet-summary'), true);
      h.account.status = 'closed';
      const blocked = h.render();
      assert.match(textContent(blocked), /환전이 제한된 계정입니다/);
      assert.equal(elements(blocked).some((node: any) => node.type === 'AccountSwitcher'), false);
    });
  }

  it('never imports the switcher, keeps the scoped bindings and a no-account notice', () => {
    const source = readFileSync(resolve('src/screens/wallet/WalletFxScreen.tsx'), 'utf8');
    assert.doesNotMatch(source, /AccountSwitcher/);
    assert.match(source, /testID="wallet-fx-no-account"/);
    assert.match(source, /환전할 투자 계정이 없습니다\./);
    // Account-bound reset and request scope are untouched.
    assert.match(source, /\}, \[accountId, clearInputFocus\]\);/);
    assert.match(source, /isFxResponseInScope\(request\.scope, readScope\(\)\)/);
  });

  it('shows no invented rate: the summary says "-" and the retry lives outside it', () => {
    const h = fxHarness();
    h.rateQuery.isError = true;
    const tree = h.render();
    const summary = elements(tree).find((node: any) => node.props.testID === 'fx-wallet-summary');
    assert.equal(textContent(elements(summary).find((node: any) => node.props.testID === 'fx-summary-rate')), '-');
    assert.doesNotMatch(textContent(summary), /1350|중단/);
    const unavailable = elements(tree).find((node: any) => node.props.testID === 'fx-rate-unavailable');
    assert.match(textContent(unavailable), /현재 환율을 사용할 수 없어 환전 기능이 잠시 중단되었습니다/);
    assert.equal(elements(unavailable, 'CTAButton')[0].props.label, '환율 다시 불러오기');
    assert.equal(elements(unavailable, 'AdminDiagnosticPanel').length, 1);
  });
});

describe('transfer screen and the quest guide', () => {
  it('publishes the real wallets and amount, and keeps its own receipt when adopted', async t => {
    const adopted: unknown[] = [];
    const dispose = bridge.setQuestGuideCommandSink((command: unknown) => { adopted.push(command); return true; });
    const h = walletTransferHarness();
    await h.start();
    t.after(async () => { dispose(); await h.close(); });
    assert.deepEqual(bridge.getQuestGuideFacts('transfer'), {
      screen: 'transfer', accountId: 'A', blocked: false, source: 'securities', destination: 'crypto_spot',
      amountValid: false, amountFits: false, nothingToSend: false, canExecute: false, pending: false, failed: false, succeeded: false,
    });
    await h.amount('800');
    assert.deepEqual([bridge.getQuestGuideFacts('transfer').amountValid, bridge.getQuestGuideFacts('transfer').amountFits], [true, false]);
    await h.amount('500');
    assert.equal(bridge.getQuestGuideFacts('transfer').canExecute, true);
    await h.press('wallet-transfer-submit');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.sourceWalletId, 'A:securities');
    assert.equal(h.requests[0].body.destinationWalletId, 'A:crypto_spot');
    assert.equal(h.requests[0].body.amount, '500.00000000');
    assert.ok(h.node('wallet-transfer-success'), 'the receipt stays on screen');
    assert.deepEqual(adopted, [{ kind: 'transfer', accountId: 'A', source: 'securities', destination: 'crypto_spot', currency: 'USD', summary: '보낸 금액 USD 500' }]);
    assert.equal(bridge.getQuestGuideFacts('transfer').succeeded, true);
  });

  it('reports wrong routes and an empty source wallet as they are', async t => {
    const h = walletTransferHarness();
    h.wallets.A.wallets.find((wallet: any) => wallet.id === 'A:securities').reservedAmount = '1000';
    await h.start();
    t.after(h.close);
    assert.equal(bridge.getQuestGuideFacts('transfer').nothingToSend, true);
    await h.choose('destination', 'crypto_futures');
    assert.equal(bridge.getQuestGuideFacts('transfer').destination, 'crypto_futures');
  });
});

describe('Wallet entry buttons and the quest guide', () => {
  it('exposes only 환전하기 and 이체하기 as guide targets', (t) => {
    const h = createHomeHarness('general');
    t.after(h.close);
    h.seed(h.account, { points: [] });
    const tree = h.renderWallet().tree;
    const item = (id: string) => elements(tree).find((node: any) => node.props.testID === `${id}-item`);
    assert.equal(item('wallet-exchange').props.ref === bridge.questGuideTarget('wallet-exchange'), true);
    assert.equal(item('wallet-transfer').props.ref === bridge.questGuideTarget('wallet-transfer'), true);
    assert.equal(item('wallet-ledger').props.ref === undefined, true);
    assert.equal(item('wallet-orders').props.ref === undefined, true);
    assert.equal(item('wallet-exchange').props.collapsable, false, 'measurable on Android');
  });
});
