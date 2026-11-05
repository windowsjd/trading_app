import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

/**
 * The ⓘ beside a Spot condition's price field (2026-11-06): a 44pt target
 * opening a short sheet on what the price is, in the form's own term.
 * Assertions read small strings/booleans only.
 */
const sell = TEST_IDS.assetDetail.sellButton;
const ownText = (node: any): string => node === undefined ? '' : [node.props.children].flat().join('');
/** Each Text node's own strings under one host node (never the instance itself). */
const texts = (node: any): string[] => node === undefined ? [] : node.findAll((n: any) => n.type === 'Text').map(ownText);
const rendered = (h: any) => texts(h.renderer.root).join('\n');
const buyList = (id: string) => ({
  tradingAccountId: id,
  capabilities: { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX', 'CRYPTO_SPOT'],
    offSessionMarkets: ['KRX'], maxLivePerAccount: 20 },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
const sellList = (id: string) => ({
  tradingAccountId: id,
  capabilities: {
    enabled: true,
    condition: { enabled: true, canCreate: true, canUseLimit: true, offSessionMarkets: ['KRX'] },
    protection: { enabled: true, canCreate: true, canUseLimit: false },
    canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30,
  },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
function stock(h: any) {
  h.accountId = 'general';
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = 'open';
  h.assets.samsung.tradable = true;
}
/** Closed: unmounted, or still sliding out without taking touches. */
const sheetClosed = (h: any, id: string) => h.node(id) === undefined || h.node(id).props.pointerEvents === 'none';

const FORMS = [
  {
    side: 'buy', field: 'conditional-trigger-price', label: '감시가격 (KRW)', name: '감시가격 설명', title: '감시가격이란?',
    body: [
      '감시가격은 자동으로 매수·매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 감시가격 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  },
  {
    side: 'sell', field: 'sell-condition-trigger-price', label: '매도 기준가 (KRW)', name: '매도 기준가 설명', title: '매도 기준가란?',
    body: [
      '매도 기준가는 자동으로 매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 매도 기준가 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  },
] as const;

describe('조건주문 가격 ⓘ', () => {
  for (const form of FORMS)
    it(`${form.side}: ${form.label} opens ${form.title} and closes without touching the typed price`, async (t) => {
      const h = inlineTradingHarness();
      stock(h);
      h.positions.general = '10';
      h.conditionalList = buyList('general');
      h.sellList = sellList('general');
      h.method = 'conditional';
      await h.mount(); t.after(h.close);
      if (form.side === 'sell') {
        await h.press(sell);
        await h.selectOrderType('conditional');
      }
      const info = h.node(`${form.field}-info`);
      assert.equal(info === undefined, false, 'the ⓘ is there');
      // Beside the field title (one row without the input), which keeps its words and currency.
      const row = h.renderer.root.findAll((n: any) => n.type === 'View'
        && n.findAll((c: any) => c.props?.testID === `${form.field}-info`).length > 0
        && n.findAll((c: any) => c.type === 'Text' && ownText(c) === form.label).length > 0
        && n.findAll((c: any) => c.props?.testID === form.field).length === 0);
      assert.equal(row.length > 0, true, 'label and ⓘ share a row');
      assert.deepEqual([info.props.accessibilityRole, info.props.accessibilityLabel, info.props.hitSlop], ['button', form.name, 10]);
      // A 24pt mark with a 44pt target, as 증거금 모드 ⓘ.
      assert.deepEqual([info.props.style.width, info.props.style.height], [24, 24]);
      assert.equal(sheetClosed(h, `${form.field}-info-sheet`), true, 'closed until pressed');

      await h.input(form.field, '69000');
      const dismissals = h.keyboardDismissals;
      await h.press(`${form.field}-info`);
      assert.equal(h.keyboardDismissals, dismissals + 1, 'the keyboard steps aside for the sheet');
      const sheet = h.node(`${form.field}-info-sheet`);
      assert.equal(sheet === undefined || sheet.props.pointerEvents !== 'auto', false, 'open');
      assert.equal(texts(sheet).includes(form.title), true, form.title);
      assert.deepEqual(texts(h.node(`${form.field}-info-body`)), [...form.body]);
      // Nothing about fills or guarantees in the explanation.
      assert.equal(/보장|체결되지 않을 수|체결가격/u.test(texts(h.node(`${form.field}-info-body`)).join('')), false);
      if (form.side === 'sell') assert.equal(/감시가격/u.test(rendered(h)), false, 'a SELL never says 감시가격');

      await h.press(`${form.field}-info-sheet-close`);
      await h.flush();
      assert.equal(sheetClosed(h, `${form.field}-info-sheet`), true, 'closed');
      assert.equal(h.node(form.field).props.value, '69000', 'the typed price is kept');
    });

  it('only the Spot condition forms carry it: 시장가 and 지정가 forms have no price ⓘ', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.conditionalList = buyList('general');
    h.method = 'limit';
    await h.mount(); t.after(h.close);
    const infos = () => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /-trigger-price-info$/u.test(n.props?.testID ?? '')).length;
    assert.equal(infos(), 0, 'limit');
    await h.selectOrderType('market');
    assert.equal(infos(), 0, 'market');
    await h.selectOrderType('conditional');
    assert.equal(infos(), 1, 'conditional');
  });
});
