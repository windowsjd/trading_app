import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { financial } from '../../theme/financialColors.ts';

const require = createRequire(import.meta.url);
const { futuresHarness, futuresCandlesFixture, deferred } = require('../../../test/futuresHarness.cjs');
const { questProgress } = require('../../../test/questFixtures.ts');

const words = (node: any): string =>
  node === undefined ? '' : (node.children ?? []).map((child: any) => (typeof child === 'string' ? child : words(child))).join('');
const chart = (h: any) => h.renderer.root.findAll((node: any) => node.type === 'CandlestickChart')[0];
const stats = (overrides: Record<string, unknown> = {}) => ({
  state: 'available', priceChangePercent: '2.345', quoteVolume: '1000',
  windowOpenTime: new Date(Date.now() - 86_400_000).toISOString(), windowCloseTime: new Date().toISOString(),
  receivedAt: new Date(Date.now() - 1_000).toISOString(), ...overrides,
});
const styleOf = (node: any) => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
const DAY = 86_400_000;
/** The clock the harness's server reads are taken on (the device clock + its offset). */
const serverNow = (h: any) => Date.now() + (h.options.serverClockOffsetMs ?? 0);
/**
 * A contract's 1d read as the server answers the detail's `limit=2`: the
 * previous UTC day settled at `close`, and today's open bucket (999, so a
 * figure taken from it would show); `edit` changes the buckets.
 */
const dailyRead = (h: any, instrumentId: string, symbol: string, close: string, edit = (candles: any[]) => candles) => {
  const today = Math.floor(serverNow(h) / DAY) * DAY;
  const bucket = (openMs: number, price: string, provisional: boolean) => ({ time: new Date(openMs).toISOString(),
    open: price, high: price, low: price, close: price, volume: '1.00000000', amount: '1.00000000', provisional });
  const candles = edit([bucket(today - DAY, close, false), bucket(today, '999.00000000', true)]);
  const fixture = futuresCandlesFixture(instrumentId, today, '1d');
  return { ...fixture, instrument: { ...fixture.instrument, symbol }, candles,
    source: { ...fixture.source, symbol, requestedCount: 2, returnedCount: candles.length, fetchedAt: new Date(serverNow(h) - 1_000).toISOString() } };
};
/** The chart's reads keep the fixture; 1d reads are answered by `daily`. */
const withDaily = (h: any, daily: (instrumentId: string) => unknown) => {
  h.futuresCandles = (instrumentId: string, interval: string) =>
    interval === '1d' ? daily(instrumentId) : futuresCandlesFixture(instrumentId, Date.now(), interval);
};

describe('futures contract detail in the asset detail layout (market 선물 row → 종목 상세 → order screen)', () => {
  it('shows the name with the contract picker, USD badge, contract line, the Last large with its won line, and the chart', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    assert.equal(words(h.node('futures-detail-name')), '비트코인');
    assert.equal(h.node('futures-name-selector').props.accessibilityLabel, '종목 변경, 현재 비트코인');
    assert.equal(words(h.node('futures-settlement-currency')), 'USD');
    assert.equal(words(h.node('futures-detail-contract')), 'BTCUSDT · USDⓈ-M 무기한');
    // The contract's own fresh Last (102), never Mark (101); 102 × 1,400 = 142,800원.
    assert.equal(words(h.node('futures-detail-primary-price')), '$102');
    assert.equal(words(h.node('futures-detail-secondary-price')), '142,800원');
    // 전일대비: the Last against the fixture's settled previous UTC day (close 101).
    assert.equal(words(h.node('futures-day-change')), '전일대비 +0.99%');
    // The contract's own Last candles at the asset detail's default 봉 시간, and its 1d read (two buckets).
    assert.deepEqual(h.candleWindows, ['btc:5m:2d:600', 'btc:1d:1y:2']);
    assert.equal(chart(h).props.viewportResetKey, 'btc:5m');
    assert.equal(chart(h).props.currentPrice, '102');
    assert.equal(h.node('asset-timeframe-selector') === undefined, false, 'the shared 봉 시간 selector');
    const actions = h.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => [n.props.label, n.props.state]);
    assert.deepEqual(actions, [['매도하기', 'enabled'], ['매수하기', 'enabled']]);
  });

  it('says no more than the asset detail: the basis, provisional-candle, Mark and entry notes and the chart icon are gone', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    const text = h.text();
    for (const removed of [
      '선물 계약 거래가격(Last) 기준', '최근 96일', '마지막 봉은 진행 중인 잠정 봉입니다',
      'Mark Price는 차트와 별개로', '구매하기는 롱(Long), 판매하기는 숏(Short) 신규 진입 주문으로 이어집니다',
    ]) assert.equal(text.includes(removed), false, removed);
    assert.equal(h.node('futures-detail-open-chart') === undefined, true);
    // The order bar: AssetDetail's row, padded by the bottom inset (0 here).
    const bar = h.node('futures-detail-actions');
    assert.deepEqual([bar.props.style.flexDirection, bar.props.style.gap, bar.props.style.paddingBottom], ['row', 10, 8]);
  });

  it('$ | 원 switches the large figure to won and back; display only', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    await h.press('futures-currency-krw');
    assert.equal(words(h.node('futures-detail-primary-price')), '142,800원');
    assert.equal(words(h.node('futures-detail-secondary-price')), '$102');
    assert.equal(h.node('futures-currency-krw').props.accessibilityState.selected, true);
    // The order still opens on the contract (USD), nothing else changes.
    const button = h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '매수하기')[0];
    button.props.onPress();
    assert.deepEqual(h.navigation, [['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'long' }]]);
    await h.press('futures-currency-usd');
    assert.equal(words(h.node('futures-detail-primary-price')), '$102');
  });

  it('never shows a won figure from an expired or missing rate, or for a stale Last', async (t) => {
    const expired = futuresHarness({ screen: 'detail' });
    expired.fxRate = { state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1400.00000000',
      validUntil: new Date(Date.now() - 1_000).toISOString() };
    await expired.start(); t.after(expired.close);
    assert.equal(words(expired.node('futures-detail-secondary-price')), '원 환산 불가');
    assert.equal(expired.node('futures-currency-krw').props.disabled, true);
    await expired.press('futures-currency-krw');
    assert.equal(words(expired.node('futures-detail-primary-price')), '$102');

    const failed = futuresHarness({ screen: 'detail' });
    failed.fxFailure = Object.assign(new Error('down'), { response: { status: 503 } });
    await failed.start(); t.after(failed.close);
    assert.equal(words(failed.node('futures-detail-secondary-price')), '원 환산 불가');

    const stale = futuresHarness({ screen: 'detail', expiredReference: true });
    await stale.start(); t.after(stale.close);
    assert.equal(words(stale.node('futures-detail-primary-price')), '시세 확인 불가');
    assert.equal(words(stale.node('futures-detail-secondary-price')), '원 환산 불가');
    assert.equal(chart(stale).props.currentPrice, null);
  });

  it("shows 전일대비: the fresh Last against the contract's own settled close of the previous UTC day, never the rolling 24h ticker", async (t) => {
    // The 24h ticker says -9.87%; the Last 102 against the previous day's 100 is +2%.
    const rise = futuresHarness({ screen: 'detail' });
    rise.catalogInstruments = (instrument: any) => [{ ...instrument, marketStats: stats({ priceChangePercent: '-9.87' }) }];
    withDaily(rise, (id) => dailyRead(rise, id, 'BTCUSDT', '100.00000000'));
    await rise.start(); t.after(rise.close);
    assert.equal(words(rise.node('futures-day-change')), '전일대비 +2%');
    assert.equal(styleOf(rise.node('futures-day-change')).color, financial.rise);
    assert.equal(rise.text().includes('9.87') || rise.text().includes('24시간'), false);
    assert.deepEqual(rise.candleWindows, ['btc:5m:2d:600', 'btc:1d:1y:2']);
    // The won display never moves it: the contract's USD prices, not the USD/KRW rate.
    await rise.press('futures-currency-krw');
    assert.equal(words(rise.node('futures-detail-primary-price')), '142,800원');
    assert.equal(words(rise.node('futures-day-change')), '전일대비 +2%');

    const fall = futuresHarness({ screen: 'detail' });
    withDaily(fall, (id) => dailyRead(fall, id, 'BTCUSDT', '102.68000000'));
    await fall.start(); t.after(fall.close);
    assert.equal(words(fall.node('futures-day-change')), '전일대비 -0.66%');
    assert.equal(styleOf(fall.node('futures-day-change')).color, financial.fall);

    const flat = futuresHarness({ screen: 'detail' });
    withDaily(flat, (id) => dailyRead(flat, id, 'BTCUSDT', '102.00000000'));
    await flat.start(); t.after(flat.close);
    assert.equal(words(flat.node('futures-day-change')), '전일대비 0%');
    assert.equal([financial.rise, financial.fall].includes(styleOf(flat.node('futures-day-change')).color), false);
  });

  it('reads 전일대비 - (never 0%, never an older day) without a fresh Last, a settled previous day of this contract, or the read', async (t) => {
    const down = () => Object.assign(new Error('down'), { response: { status: 503 } });
    const cases: Array<[string, (h: any) => void, Record<string, unknown>?]> = [
      ['a stale Last', (h) => withDaily(h, (id) => dailyRead(h, id, 'BTCUSDT', '100')), { expiredReference: true }],
      ['the previous day not settled yet', (h) => withDaily(h, (id) => dailyRead(h, id, 'BTCUSDT', '100',
        ([previous, today]) => [{ ...previous, provisional: true }, today]))],
      ['the previous day missing (an older day never stands in)', (h) => withDaily(h, (id) => dailyRead(h, id, 'BTCUSDT', '100',
        ([previous, today]) => [{ ...previous, time: new Date(Date.parse(previous.time) - DAY).toISOString() }, today]))],
      ["another contract's series", (h) => withDaily(h, (id) => dailyRead(h, id, 'ETHUSDT', '100'))],
      ['a failed read', (h) => withDaily(h, () => { throw down(); })],
    ];
    for (const [name, setup, options] of cases) {
      const h = futuresHarness({ screen: 'detail', ...options });
      setup(h);
      await h.start(); t.after(h.close);
      assert.equal(words(h.node('futures-day-change')), '전일대비 -', name);
    }
  });

  it("at 00:00 UTC on the server clock the basis becomes the day that just closed; the previous day's figure never carries over", async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    // The server's clock a minute before the next UTC midnight (the device clock stays as it is).
    const midnight = Math.floor(Date.now() / DAY) * DAY + DAY;
    h.options.serverClockOffsetMs = midnight - 60_000 - Date.now();
    // The day before closed at 100; the day ending at midnight closes at 101.
    const closes: Record<number, string> = { [midnight - 2 * DAY]: '100.00000000', [midnight - DAY]: '101.00000000' };
    withDaily(h, (id) => dailyRead(h, id, 'BTCUSDT', closes[Math.floor(serverNow(h) / DAY) * DAY - DAY]));
    await h.start(); t.after(h.close);
    assert.equal(words(h.node('futures-day-change')), '전일대비 +2%');
    // A minute past midnight; the new day's 1d read waits until released.
    h.candleGates = { '1d': deferred() };
    h.options.serverClockOffsetMs = midnight + 60_000 - Date.now();
    await h.client.invalidateQueries({ queryKey: ['tradingAccount', 'futures', 'A', 'instruments'] });
    await h.flush();
    assert.equal(words(h.node('futures-day-change')), '전일대비 -');
    h.candleGates['1d'].resolve();
    await h.flush();
    assert.equal(words(h.node('futures-day-change')), '전일대비 +0.99%');
    assert.deepEqual(h.candleWindows.filter((read: string) => read.startsWith('btc:1d:')), ['btc:1d:1y:2', 'btc:1d:1y:2']);
  });

  it('the 봉 시간 selector reads that window of the contract, and a late answer for an earlier choice is never drawn', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    h.candleGates = { '15m': deferred() };
    await h.start(); t.after(h.close);
    await h.press('asset-timeframe-selector');
    await h.press('asset-timeframe-option-15m');
    // 15m is still loading: the whale, never the 5m candles.
    assert.equal(h.node('chart-loading') === undefined, false);
    assert.equal(chart(h) === undefined, true);
    await h.press('asset-timeframe-selector');
    await h.press('asset-timeframe-option-1h');
    assert.equal(chart(h).props.viewportResetKey, 'btc:1h');
    h.candleGates['15m'].resolve();
    await h.flush();
    // The 15m answer arrived after 1h was chosen: still the 1h chart.
    assert.equal(chart(h).props.viewportResetKey, 'btc:1h');
    const hour = futuresCandlesFixture('btc', Date.now(), '1h').candles.map((c: any) => c.time);
    assert.deepEqual(chart(h).props.candles.map((c: any) => c.time), hour);
    assert.deepEqual(h.candleWindows, ['btc:5m:2d:600', 'btc:1d:1y:2', 'btc:15m:3d:300', 'btc:1h:14d:350']);
  });

  it('the name picker lists the verified contracts and changes the contract, leaving none of the previous one', async (t) => {
    const h = futuresHarness({ screen: 'detail', futuresOnly: true });
    // Distinct figures per contract, so a leaked price or change would show.
    h.catalogInstruments = (btc: any) => [{ ...btc, marketStats: stats() }, { ...btc, id: 'hype', referencePrice: '57.5',
      underlying: { ...btc.underlying, assetId: 'asset-hype', symbol: 'HYPEUSDT', name: 'Hyperliquid', displayPriceDecimals: 3 },
      marketStats: stats({ priceChangePercent: '-1.25' }) }];
    // Each contract's own settled previous day: BTC 100 (+2%), HYPE 50 (+15%).
    withDaily(h, (id) => (id === 'hype' ? dailyRead(h, id, 'HYPEUSDT', '50.00000000') : dailyRead(h, id, 'BTCUSDT', '100.00000000')));
    await h.start(); t.after(h.close);
    assert.equal(words(h.node('futures-day-change')), '전일대비 +2%');
    await h.press('futures-currency-krw');
    await h.press('futures-name-selector');
    assert.equal(h.node('futures-instrument-sheet') === undefined, false);
    await h.press('futures-instrument-hype');
    assert.deepEqual(h.navigation, [['setParams', { instrumentId: 'hype' }]]);
    // The navigator re-renders the route with the new params; HYPE's 1d read is held back.
    h.candleGates = { '1d': deferred() };
    await h.update();
    // Until HYPE's own read arrives: no figure, never BTC's +2%.
    assert.equal(words(h.node('futures-day-change')), '전일대비 -');
    h.candleGates['1d'].resolve();
    await h.flush();
    assert.equal(words(h.node('futures-detail-name')), 'Hyperliquid');
    assert.equal(words(h.node('futures-detail-contract')), 'HYPEUSDT · USDⓈ-M 무기한');
    assert.equal(words(h.node('futures-detail-primary-price')).includes('102'), false);
    assert.match(words(h.node('futures-detail-primary-price')), /^\$57\.5/);
    assert.equal(words(h.node('futures-detail-secondary-price')), '80,500원');
    assert.equal(words(h.node('futures-day-change')), '전일대비 +15%');
    assert.equal(chart(h).props.currentPrice, '57.5');
    // A new contract starts from the defaults: USD, 5m, its own chart only.
    assert.equal(h.node('futures-currency-usd').props.accessibilityState.selected, true);
    assert.equal(chart(h).props.viewportResetKey, 'hype:5m');
    // Each contract's chart and 1d reads, BTC's before the switch and HYPE's after.
    assert.deepEqual([h.candleWindows.slice(0, 2).sort(), h.candleWindows.slice(2).sort()],
      [['btc:1d:1y:2', 'btc:5m:2d:600'], ['hype:1d:1y:2', 'hype:5m:2d:600']]);
    assert.equal(h.node('futures-instrument-sheet') === undefined, true, 'the picker closed');
  });

  it('the picker lists futures contracts only, marks the one on screen, and picking it again only closes', async (t) => {
    const h = futuresHarness({ screen: 'detail', futuresOnly: true });
    h.catalogInstruments = (btc: any) => [btc, { ...btc, id: 'hype',
      underlying: { ...btc.underlying, assetId: 'asset-hype', symbol: 'HYPEUSDT', name: 'Hyperliquid' } }];
    await h.start(); t.after(h.close);
    await h.press('futures-name-selector');
    const rows = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.accessibilityRole === 'radio'
      && String(n.props.testID).startsWith('futures-instrument-')).map((n: any) => n.props.testID);
    assert.deepEqual(rows, ['futures-instrument-btc', 'futures-instrument-hype']);
    assert.deepEqual(['btc', 'hype'].map((id) => h.node(`futures-instrument-${id}`).props.accessibilityState.selected), [true, false]);
    assert.equal(h.node('futures-instrument-sheet').props.pointerEvents, 'auto');
    await h.press('futures-instrument-btc');
    assert.deepEqual(h.navigation, []);
    // Closed: it takes no touches while it slides away, and the contract stays.
    assert.equal(h.node('futures-instrument-sheet').props.pointerEvents, 'none', 'the picker closed');
    assert.equal(words(h.node('futures-detail-contract')), 'BTCUSDT · USDⓈ-M 무기한');
  });

  it('a failed poll keeps the contract on screen; a failed rate re-read drops the won figure, never the last rate', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    assert.equal(words(h.node('futures-detail-secondary-price')), '142,800원');
    const down = () => Object.assign(new Error('down'), { response: { status: 503 } });
    h.readFailures = { '/trading-accounts/A/futures/instruments': down() };
    h.fxFailure = down();
    await h.client.invalidateQueries(); await h.flush();
    assert.match(h.text(), /상품 정보를 불러오지 못했습니다/);
    assert.equal(words(h.node('futures-detail-name')), '비트코인');
    assert.equal(words(h.node('futures-detail-primary-price')), '$102', 'its Last ages out by its own evidence');
    assert.equal(words(h.node('futures-detail-secondary-price')), '원 환산 불가');
    assert.deepEqual(h.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.state), ['enabled', 'enabled']);
  });

  it("a beginner's locked entry explains itself here, as on the order screen; a held position always leads on", async (t) => {
    const progress = questProgress(6);
    progress.learningPermissions = { ...progress.learningPermissions, futuresShortOpen: false };
    const beginnerOn = (options: Record<string, unknown> = {}) => {
      const h = futuresHarness({ screen: 'detail', ...options });
      h.questProgress = progress;
      h.accountState = { selectedAccount: { id: 'A', mode: 'beginner', status: 'active', season: null } };
      return h;
    };
    const h = beginnerOn();
    await h.start(); t.after(h.close);
    const button = (label: string) => h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === label)[0];
    assert.equal(typeof button('매도하기').props.learningHint, 'string');
    assert.equal(button('매수하기').props.learningHint, null, 'the long practice is open');
    button('매도하기').props.onPress();
    assert.deepEqual(h.navigation, [], 'the lock stays on the detail');
    assert.equal(h.alerts.length, 1);
    button('매수하기').props.onPress();
    assert.deepEqual(h.navigation, [['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'long' }]]);

    // A position on the contract: the order screen shows its terms and decides.
    const held = beginnerOn({ position: true });
    await held.start(); t.after(held.close);
    const heldButton = held.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '매도하기')[0];
    assert.equal(heldButton.props.learningHint, null);
    heldButton.props.onPress();
    assert.deepEqual(held.navigation, [['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'short' }]]);
  });

  it('매수하기 opens a new long entry and 매도하기 a new short entry on the order screen', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    const button = (label: string) => h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === label)[0];
    button('매수하기').props.onPress();
    button('매도하기').props.onPress();
    assert.deepEqual(h.navigation, [
      ['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'long' }],
      ['Futures', { accountId: 'A', instrumentId: 'btc', direction: 'short' }],
    ]);
  });

  it('another selected account leaves nothing to trade here; an unknown contract or a failed read disables both actions', async (t) => {
    const moved = futuresHarness({ screen: 'detail' });
    moved.accountId = 'B';
    await moved.start(); t.after(moved.close);
    assert.match(moved.text(), /선택한 계정이 변경되었습니다/);
    assert.equal(moved.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '매수하기').length, 0);

    const missing = futuresHarness({ screen: 'detail', instrumentId: 'not-listed' });
    await missing.start(); t.after(missing.close);
    assert.equal(missing.node('futures-detail-missing') === undefined, false);
    // No 전일대비 read for a contract outside the verified list.
    assert.deepEqual([missing.candleWindows.some((read: string) => read.includes(':1d:')), words(missing.node('futures-day-change'))],
      [false, '전일대비 -']);
    assert.deepEqual(missing.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.state), ['disabled', 'disabled']);

    const failed = futuresHarness({ screen: 'detail' });
    failed.readFailures = { '/trading-accounts/A/futures/instruments': Object.assign(new Error('down'), { response: { status: 503 } }) };
    await failed.start(); t.after(failed.close);
    assert.match(failed.text(), /상품 정보를 불러오지 못했습니다/);
    assert.deepEqual(failed.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.state), ['disabled', 'disabled']);
    assert.equal(failed.node('futures-name-selector').props.disabled, true, 'no contract list to pick from');
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

describe('futures contract detail in guest browsing (2026-10-30)', () => {
  const { resolve } = require('node:path');
  // The module instance the screen loads natively: flipping it is guest browsing.
  const guestState = require(resolve('src/features/auth/guestBrowsing.ts'));

  const guestDetail = () => {
    const h = futuresHarness({ screen: 'detail' });
    // No account: none selected, none in the route.
    h.accountId = null;
    h.routeAccountId = null;
    return h;
  };

  it("shows the contract's market data — Last, won figure, 전일대비, chart — from public reads only", async (t) => {
    guestState.setGuestBrowsing(true);
    t.after(() => guestState.setGuestBrowsing(false));
    const h = guestDetail();
    await h.start(); t.after(h.close);
    assert.equal(h.node('futures-detail-unbound') === undefined, true, 'no account to bind');
    assert.equal(words(h.node('futures-detail-name')), '비트코인');
    assert.equal(words(h.node('futures-detail-primary-price')), '$102');
    assert.equal(words(h.node('futures-detail-secondary-price')), '142,800원');
    assert.equal(words(h.node('futures-day-change')), '전일대비 +0.99%');
    assert.equal(chart(h).props.currentPrice, '102');
    // Only the market-data routes, each without credentials; never an account.
    assert.equal(h.reads.some((path: string) => path.startsWith('/trading-accounts/')), false);
    assert.equal(h.reads.includes('/futures/instruments'), true);
    assert.deepEqual([...new Set(h.readConfigs.map((read: any) => read.public))], [true]);
    assert.equal(h.fxReads > 0, true, 'the won figure reads the display rate');
  });

  it('매수하기/매도하기 open the sign-in sheet; no order screen, position or learning read', async (t) => {
    guestState.setGuestBrowsing(true);
    t.after(() => guestState.setGuestBrowsing(false));
    const h = guestDetail();
    await h.start(); t.after(h.close);
    const actions = h.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => [n.props.label, n.props.state]);
    assert.deepEqual(actions, [['매도하기', 'enabled'], ['매수하기', 'enabled']]);
    for (const id of ['futures-detail-long', 'futures-detail-short']) {
      await h.press(id);
      assert.equal(h.text().includes('선물 매수·매도 주문은 로그인한 뒤 나의 가상투자 계정으로 할 수 있습니다.'), true, id);
    }
    assert.deepEqual(h.navigation.filter((args: unknown[]) => args[0] === 'Futures'), []);
    assert.equal(h.reads.some((path: string) => path.includes('positions') || path.includes('quests')), false);
    assert.deepEqual(h.requests, []);
  });

  it('a member keeps the account route and its credentials', async (t) => {
    const h = futuresHarness({ screen: 'detail' });
    await h.start(); t.after(h.close);
    assert.equal(h.reads.includes('/trading-accounts/A/futures/instruments'), true);
    assert.equal(h.reads.includes('/futures/instruments'), false);
    assert.deepEqual([...new Set(h.readConfigs.map((read: any) => read.public))], [false]);
  });
});
