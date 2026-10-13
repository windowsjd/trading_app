import { financial } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  adjustOhlc,
  callAuction,
  changeRate,
  differenceStats,
  dividendAssets,
  eligibleDividend,
  indexImpact,
  nav,
  normalize,
  openingBuyOrder,
  premium,
  priceDomain,
  sessionOhlc,
  sessionTimeline,
  payoutRatio,
  shareConversion,
  usTradingSession,
} from './marketLessonCalculations.ts';
import {
  auctionBuys,
  auctionSells,
  fundAssets,
  sessionTrades,
  usSessionTrades,
  splitCandles,
  stableDifferences,
  variableDifferences,
} from './marketLessonData.ts';
import { guideTopics, type GuideChapter } from './guideTopics.ts';
import { UP_COLOR, DOWN_COLOR } from '../../components/charts/candleColors.ts';

const require = createRequire(import.meta.url);
const {
  interactionHarness,
  React,
  act,
  flatten,
} = require('../../../test/interactionTestHarness.cjs');
const textContent = (node: any): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : (Array.isArray(node) ? node : (node?.children ?? []))
        .map(textContent)
        .join('');
function setup(
  t: TestContext,
  chapter: GuideChapter,
  topic?: keyof typeof guideTopics,
) {
  const h = interactionHarness();
  h.native.SafeAreaView = 'SafeAreaView';
  h.scrolls = [];
  h.native.ScrollView = ({ ref, ...props }: any) => {
    React.useImperativeHandle(
      ref,
      () => ({ scrollTo: (value: any) => h.scrolls.push(value) }),
      [],
    );
    return React.createElement('ScrollView', props);
  };
  const action = { default: h.ActionPressable, __esModule: true };
  const ui = h.load('src/screens/guide/LessonUi.tsx', {
    '../../components/common/ActionPressable': action,
  });
  const figures = h.load('src/screens/guide/MarketLessonUi.tsx', {
    './LessonUi': ui,
    'react-native-svg': {
      __esModule: true,
      default: 'Svg',
      Line: 'Line',
      Rect: 'Rect',
      Circle: 'Circle',
      Polyline: 'Polyline',
      Text: 'SvgText',
    },
  });
  const mocks: any = { './LessonUi': ui, './MarketLessonUi': figures };
  for (const name of ['StockLessons', 'CorporateLessons', 'EtfLessons'])
    mocks[`./${name}`] = h.load(`src/screens/guide/${name}.tsx`, mocks);
  h.Screen = h.load(
    `src/screens/guide/${topic ? 'GuideTopicScreen' : 'GuideChapterScreen'}.tsx`,
    { ...mocks, '../../components/common/ActionPressable': action },
  ).default;
  h.routes = [];
  h.props = {
    route: { name: topic ?? 'GuideChapter', params: { chapter } },
    navigation: { navigate: (...args: any[]) => h.routes.push(args) },
  };
  h.renderer = h.render(React.createElement(h.Screen, h.props));
  h.find = (id: string) =>
    h.renderer.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props.testID === id,
    )[0];
  h.press = (id: string) => {
    const button = h.find(id);
    assert.ok(button, id);
    assert.notEqual(button.props.disabled, true, id);
    act(() => button.props.onPress());
  };
  h.text = (id?: string) => textContent(id ? h.find(id) : h.renderer.toJSON());
  h.prose = () => h.renderer.root.findAll(
    (node: any) => [ui.Body, figures.Basis].includes(node.type),
  ).map(textContent).join('');
  h.order = (...ids: string[]) => {
    const all = h.renderer.root.findAll(
      (node: any) => typeof node.type === 'string',
    );
    const positions = ids.map((id) => all.indexOf(h.find(id)));
    assert.ok(
      positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1])),
      `${ids}: ${positions}`,
    );
  };
  h.update = () =>
    act(() => h.renderer.update(React.createElement(h.Screen, h.props)));
  h.readable = () => {
    const nodes = h.renderer.root.findAll(
      (node: any) => typeof node.type === 'string',
    );
    const ids = nodes.flatMap((node: any) =>
      node.props.testID ? [node.props.testID] : [],
    );
    assert.equal(ids.length, new Set(ids).size);
    for (const node of nodes.filter((node: any) => node.type === 'Text')) {
      const style = flatten(node.props.style);
      assert.equal(node.props.numberOfLines, undefined);
      assert.equal(style.height, undefined);
      assert.ok(style.fontSize >= 14);
      assert.ok(style.lineHeight >= style.fontSize * 1.4);
    }
    for (const button of nodes.filter(
      (node: any) => node.type === 'Pressable',
    )) {
      assert.equal(button.props.accessibilityRole, 'button');
      assert.ok(button.props.accessibilityLabel);
      if (button.props.disabled) assert.equal(button.props.onPress, undefined);
    }
    assert.doesNotMatch(
      h.text(),
      /NaN|Infinity|실제 계정이나 시장 데이터와 연결되지|이 실습에서는 매수 요청이/,
    );
    assert.deepEqual(h.scrolls, []);
  };
  t.after(() => act(() => h.renderer.unmount()));
  return h;
}
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe('market guide calculations from local inputs', () => {
  it('converts actual winter/summer dates including next day and early close', () => {
    assert.deepEqual(usTradingSession('2026-01-07'), {
      day: '2026-01-07',
      openEt: '2026-01-07 09:30',
      closeEt: '2026-01-07 16:00',
      openKst: '2026-01-07 23:30',
      closeKst: '2026-01-08 06:00',
      daylightSaving: false,
    });
    assert.equal(usTradingSession('2026-07-08').openKst, '2026-07-08 22:30');
    assert.equal(usTradingSession('2026-07-08').closeKst, '2026-07-09 05:00');
    assert.equal(
      usTradingSession('2026-11-27', true).closeKst,
      '2026-11-28 03:00',
    );
  });
  it('derives eligible auction quantities without mutating orders', () => {
    const original = JSON.stringify([auctionBuys, auctionSells]);
    const result = callAuction(auctionBuys, auctionSells);
    assert.deepEqual(
      result.candidates.map(({ price, quantity }) => [price, quantity]),
      [
        [10100, 20],
        [10200, 80],
        [10300, 30],
      ],
    );
    assert.equal(result.result?.price, 10200);
    assert.equal(result.result?.quantity, 80);
    assert.equal(callAuction([], []).result, null);
    const changed = callAuction(auctionBuys, [{ price: 10100, quantity: 5 }]);
    assert.equal(changed.candidates[0].quantity, 5, 'uses input quantities');
    assert.equal(JSON.stringify([auctionBuys, auctionSells]), original);
  });
  it('adds an opening buy without mutating orders and leaves same-price allocation undetermined', () => {
    const buys = auctionBuys.map((order) => ({ ...order }));
    const sells = auctionSells.map((order) => ({ ...order }));
    const original = JSON.stringify([buys, sells]);
    for (const orders of [buys, sells]) {
      orders.forEach(Object.freeze);
      Object.freeze(orders);
    }
    const filled = openingBuyOrder(10300, 10, buys, sells);
    assert.equal(filled.status, 'filled');
    assert.equal(filled.price, 10200);
    assert.equal(filled.quantity, 10);
    assert.equal(filled.saved, 1000);
    assert.deepEqual(filled.auction.result, {
      price: 10200, buy: 90, sell: 80, quantity: 80,
    });
    assert.deepEqual(
      filled.auction.candidates.map(({ price, quantity }) => [price, quantity]),
      [[10100, 20], [10200, 80], [10300, 40]],
    );
    const unfilled = openingBuyOrder(10100, 10, buys, sells);
    assert.equal(unfilled.status, 'unfilled');
    assert.equal(unfilled.auction.result?.price, 10200);
    assert.equal(unfilled.auction.result?.quantity, 80);
    assert.deepEqual(
      unfilled.auction.candidates.map(({ price, quantity }) => [price, quantity]),
      [[10100, 20], [10200, 80], [10300, 30]],
    );
    assert.equal(openingBuyOrder(10200, 10, buys, sells).status, 'undetermined');
    const empty = openingBuyOrder(10300, 10, [], []);
    assert.equal(empty.status, 'undetermined');
    assert.equal(empty.auction.result === null, true);
    assert.equal(JSON.stringify([buys, sells]), original);
    assert.equal(JSON.stringify([auctionBuys, auctionSells]), original);
  });
  it('filters the same trades into OHLC, keeps raw candles, and sizes shared axes', () => {
    const original = JSON.stringify([sessionTrades, splitCandles]);
    assert.deepEqual(sessionOhlc(sessionTrades, false).candle, {
      open: 10700,
      high: 10750,
      low: 10550,
      close: 10600,
    });
    assert.deepEqual(sessionOhlc(sessionTrades, true).candle, {
      open: 10000,
      high: 10850,
      low: 10000,
      close: 10800,
    });
    assert.equal(sessionOhlc([], true).candle, null);
    assert.equal(changeRate(10000, 10600), 6);
    assert.deepEqual(adjustOhlc(splitCandles[0], 0.5), {
      open: 49000,
      high: 51000,
      low: 48500,
      close: 50000,
    });
    const domain = priceDomain([7000, 13000, 50000, 100000]);
    assert.ok(domain[0] < 7000 && domain[1] > 100000);
    assert.equal(JSON.stringify([sessionTrades, splitCandles]), original);
  });
  it('builds both market timelines from the same immutable session records', () => {
    for (const trades of [sessionTrades, usSessionTrades]) {
      const original = JSON.stringify(trades);
      const regular = sessionTimeline(trades, false);
      const all = sessionTimeline(trades, true);
      assert.equal(
        regular.filter((item) => item.candle).length,
        trades === sessionTrades ? 5 : 6,
      ); // prior + hourly samples
      assert.equal(
        all.filter((item) => item.candle).length,
        trades === sessionTrades ? 7 : 8,
      );
      assert.equal(
        all[1].candle,
        null,
        'overnight gap is not a zero-price candle',
      );
      assert.equal(sessionOhlc(trades, false).records.length, 8);
      const changed = trades.map((trade, i) =>
        i === trades.length - 1 ? { ...trade, price: 20000 } : trade,
      );
      assert.equal(sessionOhlc(changed, true).candle?.high, 20000);
      assert.equal(sessionOhlc(changed, true).candle?.close, 20000);
      assert.equal(JSON.stringify(trades), original);
    }
    assert.deepEqual(sessionOhlc(usSessionTrades, false).candle, {
      open: 107,
      high: 107.5,
      low: 105.5,
      close: 106,
    });
    assert.deepEqual(sessionOhlc(usSessionTrades, true).candle, {
      open: 102,
      high: 108.5,
      low: 102,
      close: 108,
    });
    assert.deepEqual(
      [20, 30, 50].map((value) => payoutRatio(value, 100)),
      [20, 30, 50],
    );
    assert.equal(payoutRatio(20, 0), null);
    assert.equal(payoutRatio(20, -10), null);
  });
  it('conserves conversion value and keeps dividends receivable separate from cash', () => {
    assert.deepEqual(shareConversion(100000, 10, 2), {
      price: 50000,
      quantity: 20,
      value: 1000000,
    });
    assert.deepEqual(shareConversion(50000, 20, 0.5), {
      price: 100000,
      quantity: 10,
      value: 1000000,
    });
    assert.equal(eligibleDividend('2026-03-13', '2026-03-16'), true);
    assert.equal(eligibleDividend('2026-03-16', '2026-03-16'), false);
    for (const stage of ['before', 'ex', 'paid'] as const)
      assert.equal(dividendAssets(stage).total, 100000);
    assert.deepEqual(dividendAssets('ex'), {
      price: 9500,
      quantity: 10,
      stock: 95000,
      receivable: 5000,
      cash: 0,
      total: 100000,
    });
    assert.deepEqual(dividendAssets('paid'), {
      price: 9500,
      quantity: 10,
      stock: 95000,
      receivable: 0,
      cash: 5000,
      total: 100000,
    });
  });
  it('computes index contributions, NAV, premium, normalized returns and dispersion', () => {
    const result = indexImpact(fundAssets, [10, 0, -5]);
    near(
      result.rows.reduce((sum, row) => sum + row.weight, 0),
      1,
    );
    assert.deepEqual(
      result.rows.map((row) => row.contribution),
      [5, 0, -1],
    );
    assert.equal(result.index, 1040);
    assert.equal(result.value, 1040000);
    assert.deepEqual(nav(result.value, 0, 100), {
      netAssets: 1040000,
      perShare: 10400,
    });
    assert.deepEqual(
      [10200, 10000, 9800].map((price) => premium(price, 10000)),
      [2, 0, -2],
    );
    near(changeRate(10000, 10980)! - changeRate(1000, 1100)!, -0.2);
    assert.equal(normalize([10000, 10980])[0], 100);
    near(normalize([10000, 10980])[1], 109.8);
    near(differenceStats(stableDifferences)!.deviation, 0);
    near(differenceStats(variableDifferences)!.mean, -0.2);
    near(differenceStats(variableDifferences)!.deviation, 0.6);
    assert.equal(nav(1, 0, 0).perShare, null);
    assert.equal(premium(1, 0), null);
    assert.equal(changeRate(0, 1), null);
    assert.deepEqual(normalize([]), []);
    assert.equal(differenceStats([]), null);
    assert.notEqual(indexImpact(fundAssets, [0, 0, 0]).index, result.index);
  });
});

describe('new guide chapters preserve downward learning flow', () => {
  for (const topic of Object.keys(guideTopics) as (keyof typeof guideTopics)[])
    it(`${topic} opens each chapter through the existing stack`, (t) => {
      const h = setup(t, 'closed-market', topic);
      for (const chapter of guideTopics[topic].chapters) {
        h.press(`guide-chapter-${chapter.id}`);
        assert.deepEqual(h.routes.at(-1), [
          'GuideChapter',
          { chapter: chapter.id },
        ]);
      }
      h.readable();
    });
  it('keeps virtual reservations separate from opening reception and fills a 10,300-won buy at the opening price', (t) => {
    const h = setup(t, 'closed-market');
    assert.match(h.text(), /개장 단일가만 다루는 가상 예제/);
    assert.match(h.text('closed-market-close'), /정규장 종가10,000원.*예제 속 체결0건/s);
    assert.match(h.text('closed-market-1'), /가상으로 준비.*개장 주문 접수는 08:30부터/s);
    assert.equal(h.find('closed-market-2') === undefined, true);
    assert.equal(h.find('closed-market-time') === undefined, true);
    h.press('closed-market-next');
    assert.equal(h.find('closed-market-next').props.disabled, true);
    assert.equal(h.find('closed-market-order').props.disabled, true);
    assert.equal(h.find('closed-market-time') === undefined, true);
    h.press('closed-market-price-10100');
    h.press('closed-market-price-10300');
    h.press('closed-market-order');
    const order = h.text('closed-market-order-result');
    assert.match(order, /가상 예약 완료.*10,300원에 10주.*가상으로 예약.*아직 체결되지 않았습니다/s);
    assert.doesNotMatch(order, /접수되었습니다/);
    assert.equal(h.find('closed-market-order').props.disabled, true);
    for (const price of [10100, 10300])
      assert.equal(h.find(`closed-market-price-${price}`).props.disabled, true);
    assert.match(h.text('closed-market-book'), /매수내 주문 · 10,300원 · 10주매도아직 쌓인 주문 없음/);
    const own = h.find('closed-market-book').findAll(
      (node: any) => node.type === 'Text' && textContent(node).startsWith('내 주문'),
    )[0];
    assert.equal(flatten(own.props.style).fontWeight, '700');
    const quantities = [[10, 0], [40, 20], [90, 80], [170, 180]];
    const times = ['장 마감 직후', '밤 22:00', '새벽 05:00', '08:30'];
    for (let stage = 0; stage <= 3; stage++) {
      if (stage) h.press('closed-market-time');
      const status = h.text('closed-market-status');
      assert.match(status, /전일 정규장 종가10,000원.*예제 속 체결0건/s);
      assert.ok(status.includes(stage === 3 ? '주문 단계거래소 개장 주문 접수' : '주문 단계가상 예약'));
      assert.doesNotMatch(status, /현재가|지금까지 체결/);
      assert.ok(status.includes(times[stage]));
      assert.ok(status.includes(`매수 ${quantities[stage][0]}주 · 매도 ${quantities[stage][1]}주`));
      assert.equal(h.text('closed-market-order-result'), order);
      assert.equal(h.find('closed-market-time').props.accessibilityLabel, `시간 보내기 (${stage}/3)`);
      assert.equal(h.find('closed-market-time').props.disabled, stage === 3);
      assert.equal(h.find('closed-market-open') === undefined, stage < 3);
      assert.equal(h.find('closed-market-3') === undefined, true);
      h.readable();
    }
    assert.match(h.text('closed-market-status'), /매수 170주.*매도 180주/);
    const pile = h.text('closed-market-pile-result');
    assert.match(pile, /08:30부터 개장 단일가 주문을 접수.*이 예제는 09:00 체결 전까지 종가 10,000원을 기준값으로/s);
    h.press('closed-market-open');
    assert.equal(h.find('closed-market-open').props.disabled, true);
    assert.match(h.text('closed-market-candidates'), /10,200원: 매수 90주 · 매도 80주 → 80주 ← 시가/);
    assert.match(h.text('closed-market-open-values'), /10,200원 · 80주 체결.*\+2%/s);
    assert.match(h.text('closed-market-my-result'), /내 주문: 10,200원에 체결.*10,300원 지정가 매수 10주가 주당 10,200원에 체결.*주당 100원, 10주 전체는 총 1,000원 싸게/s);
    assert.match(h.text('closed-market-my-result'), /10,100원을 냈다면.*체결되지 않았을/);
    assert.match(h.text('closed-market-open-candle'), /전 거래일 · 정규장 종가 10,000원.*밤사이 · 예제 속 체결 없음.*09:00 · 시가 10,200원/s);
    assert.match(h.text('closed-market-3'), /체결되는 주문은 같은 시가.*같은 가격에서는 접수 순서에 따라 일부만 체결될 수/s);
    for (const index of [0, 2])
      assert.equal(h.find(`closed-market-open-candle-body-${index}`) !== undefined, true);
    assert.equal(h.find('closed-market-open-candle-body-1') === undefined, true);
    assert.equal(h.find('closed-market-4') === undefined, true);
    h.press('closed-market-finish');
    assert.equal(h.find('closed-market-finish').props.disabled, true);
    assert.equal(h.text('closed-market-order-result'), order);
    assert.equal(h.text('closed-market-pile-result'), pile);
    assert.match(h.text('lesson-takeaways'), /가상으로 준비한 주문.*08:30.*09:00.*정규장 종가.*갭.*체결될 수 있습니다/s);
    assert.doesNotMatch(h.text(), /장 마감 후 체결|현재가는 계속|오늘의 마지막 가격/);
    const syllables = (h.prose().match(/[가-힣]/g) ?? []).length;
    assert.ok(syllables <= 700, `${syllables} Hangul syllables in lesson prose`);
    t.diagnostic(`10,300-won path: ${syllables} Hangul syllables, including shared Basis text`);
    h.readable();
  });
  it('leaves a 10,100-won buy unfilled at the same 10,200-won opening and 80-share volume', (t) => {
    const h = setup(t, 'closed-market');
    for (const id of [
      'closed-market-next', 'closed-market-price-10100', 'closed-market-order',
      'closed-market-time', 'closed-market-time', 'closed-market-time',
      'closed-market-open', 'closed-market-finish',
    ]) h.press(id);
    assert.match(h.text('closed-market-open-values'), /10,200원 · 80주 체결.*\+2%/s);
    assert.match(h.text('closed-market-candidates'), /10,200원: 매수 80주 · 매도 80주 → 80주 ← 시가/);
    assert.match(h.text('closed-market-my-result'), /내 주문: 체결되지 않음.*시가 10,200원.*낸 가격 10,100원/s);
    assert.match(h.text('closed-market-my-result'), /10,300원을 냈다면 10,200원에 체결/);
    const syllables = (h.prose().match(/[가-힣]/g) ?? []).length;
    assert.ok(syllables <= 700, `${syllables} Hangul syllables in lesson prose`);
    t.diagnostic(`10,100-won path: ${syllables} Hangul syllables, including shared Basis text`);
    h.readable();
  });
  it('reveals four cards in order, freezes earlier results and toggles optional detail', (t) => {
    const h = setup(t, 'closed-market');
    const close = h.text('closed-market-1');
    h.press('closed-market-next');
    h.press('closed-market-price-10300');
    h.press('closed-market-order');
    const order = h.text('closed-market-order-result');
    for (let stage = 0; stage < 3; stage++) h.press('closed-market-time');
    const night = h.text('closed-market-2');
    const pile = h.text('closed-market-pile-result');
    h.press('closed-market-open');
    const mine = h.text('closed-market-my-result');
    const opening = h.text('closed-market-3');
    h.press('closed-market-finish');
    h.order('closed-market-1', 'closed-market-2', 'closed-market-3', 'closed-market-4');
    h.order('closed-market-order-result', 'closed-market-pile-result', 'closed-market-my-result', 'lesson-takeaways');
    assert.equal(h.find('closed-market-more-text') === undefined, true);
    assert.equal(h.find('closed-market-more').props.accessibilityLabel, '더 알아보기 열기');
    for (const expanded of [true, false]) {
      h.press('closed-market-more');
      assert.equal(h.find('closed-market-more-text') !== undefined, expanded);
      assert.equal(h.find('closed-market-more').props.accessibilityLabel, expanded ? '더 알아보기 접기' : '더 알아보기 열기');
      if (expanded) {
        assert.match(h.text('closed-market-more-text'), /08:30.*09:00.*15:20~15:30.*NYSE Arca.*암호화폐는 24시간/s);
        assert.match(h.text('closed-market-more-text'), /야간 가상 예약은 거래소 접수가 아닙니다/);
        assert.match(h.text('closed-market-more-text'), /예약주문의 접수 시간과 처리 방식은 이용하는 증권사에서 확인/);
        assert.match(h.text('closed-market-more-text'), /정규장과 별도의 시간외 거래.*0건은 개장 단일가 체결만/s);
      }
      assert.equal(h.text('closed-market-1'), close);
      assert.equal(h.text('closed-market-2'), night);
      assert.equal(h.text('closed-market-3'), opening);
      assert.equal(h.text('closed-market-order-result'), order);
      assert.equal(h.text('closed-market-pile-result'), pile);
      assert.equal(h.text('closed-market-my-result'), mine);
      h.readable();
    }
    h.press('closed-market-more');
    h.press('reset-closed-market');
    assert.equal(h.find('closed-market-2') === undefined, true);
    assert.equal(h.find('closed-market-more-text') === undefined, true);
    h.press('closed-market-next');
    assert.equal(h.find('closed-market-order').props.disabled, true);
    for (const price of [10100, 10300]) {
      assert.equal(h.find(`closed-market-price-${price}`).props.disabled, false);
      assert.equal(h.find(`closed-market-price-${price}`).props.accessibilityState.selected, false);
    }
    assert.equal(h.find('closed-market-order-result') === undefined, true);
  });
  it('keeps one closed-market stock chapter without removed content', () => {
    assert.deepEqual(
      guideTopics.StockCharacteristics.chapters.map((c) => c.id),
      ['closed-market'],
    );
    assert.equal(guideTopics.StockCharacteristics.number, '04');
    assert.equal(guideTopics.StockCharacteristics.title, '주식특성');
    assert.equal(guideTopics.StockCharacteristics.chapters[0].title, '장이 닫혀 있는 동안');
    assert.match(guideTopics.StockCharacteristics.description, /가상으로 주문을 준비.*체결 여부/);
    assert.match(guideTopics.StockCharacteristics.chapters[0].description, /시가가 어떻게 결정.*체결 여부가 어떻게 정해지는지/);
    for (const name of [
      'StockLessons.tsx',
      'guideTopics.ts',
      'marketLessonData.ts',
      'GuideChapterScreen.tsx',
    ]) {
      assert.doesNotMatch(
        readFileSync(new URL(name, import.meta.url), 'utf8'),
        /거래정지|가격제한|상한가|하한가|\bVI\b|safeguards/,
      );
    }
  });
  it('applies split/reverse once and preserves independent results', (t) => {
    const h = setup(t, 'splits');
    const press = h.find('split-apply').props.onPress;
    act(() => {
      press();
      press();
    });
    assert.match(h.text('split-result'), /50,000원.*20주.*1,000,000원/s);
    const split = h.text('split-result');
    h.press('reverse-apply');
    assert.match(h.text('reverse-result'), /100,000원.*10주.*1,000,000원/s);
    assert.equal(h.text('split-result'), split);
    h.order('split-result', 'split-b', 'reverse-result');
    h.readable();
  });
  it('teaches dividends before two major phases and transfers receivable only on payment', (t) => {
    const h = setup(t, 'dividends');
    assert.match(
      h.text('dividend-terms'),
      /배당\(Dividend\).*배당락\(Ex-Dividend\).*배당성향\(Payout Ratio\)/s,
    );
    assert.match(h.text('dividend-before'), /100,000원.*5,000원.*현금0원/s);
    h.press('dividend-hold');
    const before = h.text('dividend-before');
    assert.match(
      h.text('dividend-eligibility'),
      /이번 배당을 받을 권리가 있습니다/,
    );
    assert.match(h.text('dividend-eligibility'), /2026-03-16.*2026-03-17/s);
    h.press('dividend-ex');
    const ex = h.text('dividend-ex-result');
    assert.match(
      ex,
      /9,500원.*95,000원.*받을 배당금5,000원.*배당 현금0원.*100,000원/s,
    );
    const pay = h.find('dividend-pay').props.onPress;
    act(() => {
      pay();
      pay();
    });
    const paid = h.text('dividend-paid-result');
    assert.match(paid, /받을 배당금0원.*배당 현금5,000원.*100,000원/s);
    for (const amount of [20, 30, 50]) {
      h.press(`payout-${amount}`);
      assert.ok(
        h.text('payout-result').includes(`${amount} ÷ 100 × 100 = ${amount}%`),
      );
    }
    assert.equal(h.text('dividend-before'), before);
    assert.equal(h.text('dividend-ex-result'), ex);
    assert.equal(h.text('dividend-paid-result'), paid);
    const headings = h.renderer.root
      .findAllByType('Text')
      .filter((node: any) => node.props.accessibilityRole === 'header')
      .map((node: any) => textContent(node));
    assert.deepEqual(
      headings.filter((text: string) => /^\d\. 배당락/.test(text)),
      ['1. 배당락 전', '2. 배당락 후'],
    );
    h.order(
      'dividend-terms',
      'dividend-before',
      'dividend-eligibility',
      'dividend-after',
      'dividend-ex-result',
      'dividend-pay',
      'dividend-paid-result',
      'dividend-payout',
      'payout-result',
    );
    h.readable();
  });
  it('adjusts all OHLC values on a common axis and keeps the prior chart fixed', (t) => {
    const h = setup(t, 'adjusted');
    const original = h.text('adjust-split-chart');
    h.press('adjust-split-adjusted');
    assert.match(
      h.text('adjust-split-chart'),
      /49,000원.*51,000원.*48,500원.*50,000원/s,
    );
    h.press('adjust-split-raw');
    assert.equal(h.text('adjust-split-chart'), original);
    h.press('adjust-split-adjusted');
    h.press('adjust-split-record');
    const split = h.text('adjust-split-chart');
    h.press('adjust-dividend-dividend');
    assert.match(
      h.text('adjust-dividend-chart'),
      /9,405원.*9,595원.*9,310원.*9,500원/s,
    );
    assert.equal(h.text('adjust-split-chart'), split);
    h.readable();
  });
  it('teaches index then ETF before following, NAV and tracking', (t) => {
    assert.deepEqual(
      guideTopics.EtfIndex.chapters.map((c) => c.id),
      ['index', 'etf', 'following', 'nav', 'tracking'],
    );
    const h = setup(t, 'index');
    assert.match(
      h.text('index-definition'),
      /여러 자산의 가격 움직임.*기준.*직접 사는 종목이 아닙니다/s,
    );
    assert.doesNotMatch(h.text(), /NAV|추적오차/);
    h.press('index-apply');
    assert.match(h.text('index-result'), /\+4%.*1,040포인트/s);
    h.order('index-definition', 'index-apply', 'index-flow', 'index-result');
    h.press('reset-index');
    h.press('index-b-return-10');
    h.press('index-apply');
    assert.match(h.text('index-result'), /\+7%.*1,070포인트/s);
    h.readable();
  });
  it('shows assets → fund → one ETF share without direct constituent ownership', (t) => {
    const h = setup(t, 'etf');
    assert.match(
      h.text('etf-definition'),
      /Exchange-Traded Fund.*펀드의 지분.*지수.*기준 숫자.*ETF.*펀드 상품/s,
    );
    h.press('etf-unit');
    assert.match(
      h.text('etf-structure'),
      /A 주식 50%.*B 주식 30%.*C 주식 20%.*1,000,000원.*100주.*10,000원/s,
    );
    assert.match(
      h.text('etf-unit-result'),
      /각각 한 주씩 직접 소유하는 것은 아닙니다.*펀드의 지분/s,
    );
    h.order('etf-definition', 'etf-unit', 'etf-structure', 'etf-unit-result');
    h.readable();
  });
  it('applies one asset change to index, fund assets and per-share value together', (t) => {
    const h = setup(t, 'following');
    h.press('following-apply');
    assert.match(
      h.text('following-flow'),
      /1,000 → 1,040포인트.*1,000,000원 → 1,040,000원.*10,000원 → 10,400원/s,
    );
    assert.match(
      h.text('following-result'),
      /\+4%.*100주 = 10,400원.*액티브 ETF/s,
    );
    h.readable();
  });
  it('separates net assets, unit NAV, premium and mismatched timestamps', (t) => {
    const h = setup(t, 'nav');
    h.press('nav-calculate');
    const first = h.text('nav-result');
    for (const [price, value] of [
      [10200, '+2%'],
      [10000, '0%'],
      [9800, '-2%'],
    ]) {
      h.press(`nav-price-${price}`);
      assert.ok(h.text('nav-premium-result').includes(value));
    }
    h.press('nav-record');
    const premium = h.text('nav-premium-result');
    h.press('nav-timing-stale');
    assert.match(h.text('nav-timing-result'), /2026-07-08 05:00/);
    assert.match(h.text('nav-timing-result'), /이전/);
    assert.equal(h.text('nav-result'), first);
    assert.equal(h.text('nav-premium-result'), premium);
    h.order(
      'nav-result',
      'nav-b',
      'nav-premium-result',
      'nav-c',
      'nav-timing-result',
    );
    h.readable();
  });
  it('compares normalized returns and sequential dispersion examples before product details', (t) => {
    const h = setup(t, 'tracking');
    h.press('tracking-compare');
    assert.match(h.text('tracking-result'), /-0.2%포인트/);
    const result = h.text('tracking-result');
    assert.equal(h.find('tracking-variable') === undefined, true);
    h.press('tracking-stable');
    const stable = h.text('tracking-stable-result');
    h.press('tracking-variable');
    assert.match(h.text('tracking-variable-result'), /위아래로 크게 변함/);
    for (const id of [
      'assets',
      'benchmark',
      'weights',
      'costs',
      'distribution',
      'nav',
      'price',
    ])
      h.press(`product-${id}`);
    assert.equal(h.text('tracking-result'), result);
    assert.equal(h.text('tracking-stable-result'), stable);
    h.order(
      'tracking-result',
      'tracking-stable',
      'tracking-stable-result',
      'tracking-variable',
      'tracking-variable-result',
      'tracking-c',
      'lesson-takeaways',
    );
    h.readable();
  });
  const completionActions: Record<GuideChapter, string[]> = {
    'closed-market': [
      'closed-market-next',
      'closed-market-price-10300',
      'closed-market-order',
      'closed-market-time',
      'closed-market-time',
      'closed-market-time',
      'closed-market-open',
      'closed-market-finish',
    ],
    splits: ['split-apply', 'reverse-apply'],
    dividends: ['dividend-hold', 'dividend-ex', 'dividend-pay', 'payout-50'],
    adjusted: [
      'adjust-split-adjusted',
      'adjust-split-record',
      'adjust-dividend-dividend',
    ],
    index: ['index-apply'],
    etf: ['etf-unit'],
    following: ['following-apply'],
    nav: ['nav-calculate', 'nav-price-10200', 'nav-record', 'nav-timing-stale'],
    tracking: [
      'tracking-compare',
      'tracking-stable',
      'tracking-variable',
      'product-assets',
      'product-benchmark',
      'product-weights',
      'product-costs',
      'product-distribution',
      'product-nav',
      'product-price',
    ],
  };
  for (const chapter of Object.values(guideTopics).flatMap((topic) => [
    ...topic.chapters,
  ]))
    it(`${chapter.id} resets locally, has no background playback and uses readable text`, (t) => {
      const h = setup(t, chapter.id);
      const original = h.text();
      assert.equal(
        h.find(`reset-${chapter.id}`).props.accessibilityLabel,
        '처음부터',
      );
      for (const action of completionActions[chapter.id]) h.press(action);
      assert.notEqual(h.text(), original);
      for (const fontScale of [1, 2, 3]) {
        h.dimensions = { width: 280, height: 568, fontScale };
        h.update();
        h.readable();
      }
      h.press(`reset-${chapter.id}`);
      assert.equal(h.text(), original);
      act(() => h.renderer.unmount());
    });
  it('shares existing real chart colors without changing the market chart policy', () => {
    assert.equal(UP_COLOR, financial.candleUp);
    assert.equal(DOWN_COLOR, financial.candleDown);
    const source = readFileSync(
      new URL('./MarketLessonUi.tsx', import.meta.url),
      'utf8',
    );
    assert.match(source, /financialColors.candleUp/);
    assert.match(source, /financialColors.candleDown/);
    for (const name of [
      'StockLessons',
      'CorporateLessons',
      'EtfLessons',
      'GuideChapterScreen',
    ]) {
      const content = readFileSync(
        new URL(`./${name}.tsx`, import.meta.url),
        'utf8',
      );
      assert.doesNotMatch(
        content,
        /setTimeout|setInterval|measureLayout|scrollTo|fetch\(/,
      );
    }
  });
});
