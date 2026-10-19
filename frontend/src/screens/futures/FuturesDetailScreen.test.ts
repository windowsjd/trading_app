import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { futuresHarness } = require('../../../test/futuresHarness.cjs');

describe('futures contract detail (market 선물 row → detail → order screen)', () => {
  it('shows the contract, its fresh Last and its own chart, with 판매하기 / 구매하기 at the bottom', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    assert.equal(h.node('futures-detail-symbol').props.children, 'BTCUSDT');
    assert.match([h.node('futures-detail-last').props.children].flat().join(''), /^Last \$/);
    // The contract's own Last candles (account-free), never Mark or Spot.
    assert.deepEqual(h.candleReads, ['btc']);
    assert.match(h.text(), /구매하기는 롱\(Long\), 판매하기는 숏\(Short\) 신규 진입 주문으로 이어집니다/);
    const actions = h.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => [n.props.label, n.props.state]);
    assert.deepEqual(actions, [['판매하기', 'enabled'], ['구매하기', 'enabled']]);
  });

  it('구매하기 opens a new long entry and 판매하기 a new short entry on the order screen; the chart opens full screen', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    const button = (label: string) => h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === label)[0];
    button('구매하기').props.onPress();
    button('판매하기').props.onPress();
    await h.press('futures-detail-open-chart');
    assert.deepEqual(h.navigation, [
      ['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'long' }],
      ['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'short' }],
      ['FuturesChart', { accountId: 'A', instrumentId: 'btc', symbol: 'BTCUSDT', displayPriceDecimals: 2 }],
    ]);
  });

  it('another selected account leaves nothing to trade here; an unknown contract or a failed read disables both actions', async (t) => {
    const moved = futuresHarness({ screen: 'detail' });
    moved.accountId = 'B';
    await moved.start(); t.after(moved.close);
    assert.match(moved.text(), /선택한 계정이 변경되었습니다/);
    assert.equal(moved.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '구매하기').length, 0);

    const missing = futuresHarness({ screen: 'detail', instrumentId: 'not-listed' });
    await missing.start(); t.after(missing.close);
    assert.equal(missing.node('futures-detail-missing') === undefined, false);
    assert.deepEqual(missing.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.state), ['disabled', 'disabled']);

    const failed = futuresHarness({ screen: 'detail' });
    failed.readFailures = { '/trading-accounts/A/futures/instruments': Object.assign(new Error('down'), { response: { status: 503 } }) };
    await failed.start(); t.after(failed.close);
    assert.match(failed.text(), /상품 정보를 불러오지 못했습니다/);
    assert.deepEqual(failed.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.state), ['disabled', 'disabled']);
  });
});

describe('futures order screen opened from the detail', () => {
  it('starts on the requested side for a new entry', async (t) => {
    const h = futuresHarness({ routeDirection: 'short', instrumentId: 'btc' });
    await h.start(); t.after(h.close);
    assert.equal(h.node('futures-direction-short').props.accessibilityState.selected, true);
    assert.equal(h.node('futures-direction-long').props.accessibilityState.selected, false);
  });

  it("with a long position held, a short request keeps the position's terms and says why: never a reduce or close", async (t) => {
    const h = futuresHarness({ routeDirection: 'short', instrumentId: 'btc', position: true });
    await h.start(); t.after(h.close);
    assert.equal(h.node('futures-position-terms') === undefined, false);
    assert.match([h.node('futures-direction-held').props.children].flat().join(''),
      /롱\(Long\) 포지션이 열려 있어 숏\(Short\)으로 새로 진입할 수 없습니다\. 이 포지션을 전량 종료한 뒤 진입할 수 있어요\./);
    // The default stays the existing one (추가 금액 = increase of the held long), not a reduce/close.
    assert.match(h.text(), /추가 금액 \(USD\)/);
    // The same side as the held position: nothing to explain.
    const same = futuresHarness({ routeDirection: 'long', instrumentId: 'btc', position: true });
    await same.start(); t.after(same.close);
    assert.equal(same.node('futures-direction-held') === undefined, true);
  });
});
