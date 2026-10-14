import { financial } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  callAuction,
  changeRate,
  indexImpact,
  nav,
  normalize,
  openingBuyOrder,
  premium,
  priceDomain,
  sessionOhlc,
  sessionTimeline,
  usTradingSession,
} from './marketLessonCalculations.ts';
import {
  auctionBuys,
  auctionSells,
  fundAssets,
  sessionTrades,
  usSessionTrades,
} from './marketLessonData.ts';
import {
  guideChapters,
  guideTopics,
  type GuideChapter,
} from './guideTopics.ts';
import { UP_COLOR, DOWN_COLOR } from '../../components/charts/candleColors.ts';
import { WORD_JOINER, ZERO_WIDTH_SPACE, visibleText } from './figureText.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const {
  interactionHarness,
  React,
  act,
  flatten,
} = require('../../../test/interactionTestHarness.cjs');
const rawText = (node: any): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : (Array.isArray(node) ? node : (node?.children ?? []))
        .map(rawText)
        .join('');
// What a reader sees (figureText's visibleText): line-break controls are not read.
const textContent = (node: any): string => visibleText(rawText(node));
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
  for (const name of ['StockLessons', 'EtfLessons'])
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
    const original = JSON.stringify(sessionTrades);
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
    const domain = priceDomain([7000, 13000, 50000, 100000]);
    assert.ok(domain[0] < 7000 && domain[1] > 100000);
    assert.equal(JSON.stringify(sessionTrades), original);
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
  });
  it('computes index contributions, NAV, premium and normalized returns', () => {
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
    assert.equal(nav(1, 0, 0).perShare, null);
    assert.equal(premium(1, 0), null);
    assert.equal(changeRate(0, 1), null);
    assert.deepEqual(normalize([]), []);
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
    // The core example itself separates the exchange auction from the app's simulated fills.
    assert.match(h.text('closed-market-3'), /이 체결은 실제 거래소의 개장 방식입니다\. Trading Class의 모의투자 주문은 개장 단일가를 거치지 않습니다\./);
    h.order('closed-market-my-result', 'closed-market-finish');
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
    assert.match(h.text('closed-market-3'), /Trading Class의 모의투자 주문은 개장 단일가를 거치지 않습니다/);
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
        assert.match(h.text('closed-market-more-text'), /Trading Class에서 장이 닫혀 있을 때 낸 지정가 매수는 다음 정규장을 기다립니다.*시세가 지정가에 닿으면 체결.*그 시세 또는 지정가.*경쟁하는 개장 단일가는 없습니다/s);
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
  it('keeps ETF and index as guide 05 with four chapters and no corporate actions', () => {
    assert.deepEqual(
      guideTopics.EtfIndex.chapters.map((c) => c.id),
      ['index', 'etf', 'etf-price', 'etf-pick'],
    );
    assert.equal(guideTopics.EtfIndex.number, '05');
    assert.equal(guideTopics.StockCharacteristics.number, '04');
    assert.equal(Object.keys(guideTopics).includes('CorporateActions'), false);
    const ids: string[] = guideChapters.map((c) => c.id);
    for (const removed of ['splits', 'dividends', 'adjusted', 'following', 'nav', 'tracking'])
      assert.equal(ids.includes(removed), false, removed);
  });
  it('predicts which weighted move lifts the index more, then merges three moves into one index', (t) => {
    const h = setup(t, 'index');
    assert.match(
      h.text('index-definition'),
      /시장 전체.*숫자 하나.*여러 자산의 가격 움직임.*기준.*직접 사는 종목이 아닙니다.*1,000에서 시작.*A 50%, B 30%, C 20%/s,
    );
    assert.equal(h.find('index-predict-result') === undefined, true);
    assert.equal(h.find('index-merge') === undefined, true);
    assert.equal(h.find('index-predict-record').props.disabled, true);
    h.press('index-predict-a');
    const right = h.text('index-predict-result');
    for (const value of ['50% × 10%', '+5%포인트', '1,000 → 1,050포인트', '20% × 10%', '+2%포인트', '1,000 → 1,020포인트'])
      assert.ok(right.includes(value), value);
    assert.match(right, /예측이 맞았습니다/);
    assert.match(right, /같은 비율로 움직여도 비중이 큰 종목이 지수를 더 크게 움직입니다/);
    h.press('index-predict-c');
    const wrong = h.text('index-predict-result');
    assert.equal(wrong === right, false);
    assert.doesNotMatch(wrong, /예측이 맞았습니다/);
    assert.match(wrong, /A 기업만 오른 경우가 지수를 더 크게 올립니다.*C 기업은 비중이 작아/s);
    for (const value of ['50% × 10%', '1,050', '20% × 10%', '1,020'])
      assert.ok(wrong.includes(value), value);
    assert.equal(h.find('index-merge') === undefined, true);
    h.press('index-predict-record');
    for (const id of ['index-predict-a', 'index-predict-c', 'index-predict-record'])
      assert.equal(h.find(id).props.disabled, true, id);
    assert.equal(h.find('index-predict-c').props.accessibilityState.selected, true);
    assert.equal(h.text('index-predict-result'), wrong);
    assert.equal(h.find('index-result') === undefined, true);
    assert.equal(h.find('lesson-takeaways') === undefined, true);
    assert.equal(
      h.find('index-apply').props.accessibilityLabel,
      'A +10% · B 0% · C -5%를 하나의 지수로 모으기',
    );
    h.press('index-apply');
    assert.match(
      h.text('index-flow'),
      /A \+10% · B 0% · C -5%.*A: 50% × \+10% = \+5%포인트\nB: 30% × 0% = 0%포인트\nC: 20% × -5% = -1%포인트.*1,000 → 1,040포인트/s,
    );
    const result = h.text('index-result');
    assert.match(result, /합산 변화율\+4%.*1,000 → 1,040포인트/s);
    assert.match(result, /지수 1,040은 주식 한 주의 가격이 아닙니다/);
    assert.match(
      result,
      /실제 지수마다 계산방법이 다릅니다\. 모든 지수가 같은 가중방식을 쓰지는 않습니다/,
    );
    assert.equal(h.find('index-apply').props.disabled, true);
    assert.equal(h.text('index-predict-result'), wrong);
    assert.doesNotMatch(h.text(), /NAV|괴리율|추적차이|운용비용|추종|분산/);
    h.order(
      'index-definition',
      'index-predict',
      'index-predict-record',
      'index-apply',
      'index-flow',
      'index-result',
      'lesson-takeaways',
    );
    h.readable();
  });
  it('puts one ETF share in a basket, then compares a one-stock drop with a whole-market drop', (t) => {
    const h = setup(t, 'etf');
    assert.match(
      h.text('etf-definition'),
      /Exchange-Traded Fund.*펀드의 지분.*각각 직접 소유하는 것은 아닙니다.*지수.*기준 숫자.*ETF.*펀드 상품/s,
    );
    assert.doesNotMatch(h.text('etf-definition') + h.text('etf-share'), /분산/);
    assert.equal(h.find('etf-shock') === undefined, true);
    h.press('etf-unit');
    assert.match(
      h.text('etf-structure'),
      /A 주식 50%.*B 주식 30%.*C 주식 20%.*1,000,000원.*100주.*10,000원/s,
    );
    const unit = h.text('etf-unit-result');
    assert.match(unit, /각각 한 주씩 직접 소유하는 것은 아닙니다.*펀드의 지분/s);
    assert.match(h.text('etf-shock'), /한 종목이 갑자기 -20% 내려간다면.*미리 알 수 없습니다/s);
    assert.equal(h.find('etf-shock-result') === undefined, true);
    assert.equal(h.find('etf-shock-record').props.disabled, true);
    for (const [pick, etf, share] of [
      ['a', '1,000,000원 → 900,000원 (-10%)', 'A 비중 50% × -20% = -10%'],
      ['b', '1,000,000원 → 940,000원 (-6%)', 'B 비중 30% × -20% = -6%'],
      ['c', '1,000,000원 → 960,000원 (-4%)', 'C 비중 20% × -20% = -4%'],
    ]) {
      h.press(`etf-shock-pick-${pick}`);
      const shock = h.text('etf-shock-result');
      assert.ok(shock.includes('그 종목에만 100만 원1,000,000원 → 800,000원 (-20%)'), pick);
      assert.ok(shock.includes(`ETF에 100만 원${etf}`), etf);
      assert.ok(shock.includes(share), share);
      assert.match(shock, /분산이라고 합니다/);
    }
    h.press('etf-shock-pick-b');
    const shock = h.text('etf-shock-result');
    assert.equal(h.find('etf-market-result') === undefined, true);
    assert.equal(h.find('lesson-takeaways') === undefined, true);
    h.press('etf-shock-record');
    for (const id of ['etf-shock-pick-a', 'etf-shock-pick-b', 'etf-shock-pick-c', 'etf-shock-record'])
      assert.equal(h.find(id).props.disabled, true, id);
    assert.equal(h.find('etf-shock-pick-b').props.accessibilityState.selected, true);
    assert.equal(h.text('etf-shock-result'), shock);
    assert.equal(h.text('etf-unit-result'), unit);
    const market = h.text('etf-market-result');
    assert.match(market, /이번에는 세 종목이 모두 -20%/);
    assert.ok(market.includes('ETF에 100만 원1,000,000원 → 800,000원 (-20%)'));
    assert.match(
      market,
      /분산은 한 종목의 사고를 줄여 줄 뿐 시장 전체의 하락을 피하게 해 주지는 않습니다/,
    );
    assert.match(market, /ETF는 원금이 보장되는 상품이 아닙니다/);
    assert.doesNotMatch(h.text(), /NAV|괴리율|추적차이|운용비용|추종|순자산가치/);
    h.order(
      'etf-definition',
      'etf-unit',
      'etf-structure',
      'etf-unit-result',
      'etf-shock',
      'etf-shock-pick-a',
      'etf-shock-result',
      'etf-shock-record',
      'etf-market-result',
      'lesson-takeaways',
    );
    h.readable();
  });
  it('carries the basket change into one-share NAV, then compares market prices with a fixed NAV', (t) => {
    const h = setup(t, 'etf-price');
    assert.match(
      h.text('etf-price-definition'),
      /NAV, Net Asset Value.*부채를 뺀.*발행주식수.*시장가격.*항상 같지는 않습니다.*기준 시각.*다를 수 있습니다/s,
    );
    assert.match(
      h.text('etf-price-follow'),
      /‘추종’.*기준 지수의 움직임을 비슷하게 반영하도록 운용/s,
    );
    for (const id of ['etf-price-flow', 'etf-price-result', 'etf-price-gap', 'lesson-takeaways'])
      assert.equal(h.find(id) === undefined, true, id);
    h.press('etf-price-apply');
    assert.match(
      h.text('etf-price-flow'),
      /1,000 → 1,040포인트.*1,000,000원 → 1,040,000원.*10,000원 → 10,400원/s,
    );
    assert.match(h.text('etf-price-flow'), /÷100주/);
    const follow = h.text('etf-price-result');
    assert.match(follow, /지수 변화율\+4%.*1주당 NAV 변화율\+4%/s);
    assert.match(
      follow,
      /지수 1,040포인트와 ETF 한 주 10,400원은 같은 숫자가 될 필요가 없습니다/,
    );
    assert.match(follow, /액티브 ETF/);
    assert.match(follow, /부채·비용·자금 유출입 없음 · 발행 100주 고정/);
    assert.equal(h.find('etf-price-apply').props.disabled, true);
    assert.equal(h.find('etf-price-gap-result') === undefined, true);
    assert.equal(h.find('etf-price-record').props.disabled, true);
    for (const [price, value, label] of [
      [9800, '-2%', 'NAV보다 2% 낮은 가격 · 할인'],
      [10000, '0%', 'NAV와 같은 가격'],
      [10200, '+2%', 'NAV보다 2% 높은 가격 · 할증'],
    ] as const) {
      h.press(`etf-price-gap-${price}`);
      const gap = h.text('etf-price-gap-result');
      assert.ok(gap.includes(`괴리율${value} · ${label}`), value);
      assert.match(gap, /\(시장가격 - NAV\) ÷ NAV × 100/);
      assert.match(
        gap,
        /NAV보다 싸다고 반드시 좋은 매수기회나 저평가라고 판단할 수는 없습니다/,
      );
    }
    const gap = h.text('etf-price-gap-result');
    h.press('etf-price-record');
    for (const price of [9800, 10000, 10200])
      assert.equal(h.find(`etf-price-gap-${price}`).props.disabled, true, String(price));
    assert.equal(h.find('etf-price-record').props.disabled, true);
    assert.equal(h.text('etf-price-gap-result'), gap);
    assert.equal(h.text('etf-price-result'), follow);
    h.order(
      'etf-price-definition',
      'etf-price-follow',
      'etf-price-apply',
      'etf-price-flow',
      'etf-price-result',
      'etf-price-gap',
      'etf-price-gap-10200',
      'etf-price-gap-result',
      'etf-price-record',
      'lesson-takeaways',
    );
    h.readable();
  });
  it('compares two virtual ETFs by sector spread, then shows the index gap as more than cost and a checklist', (t) => {
    const h = setup(t, 'etf-pick');
    assert.match(h.text('etf-pick-intro'), /무엇을 담았나.*무엇을 따라가나.*얼마가 드나/s);
    assert.match(h.text('etf-pick-compare'), /가상 ETF 두 개 · 실제 상품 아님 · 교육용 가정/);
    assert.match(
      h.text('etf-pick-cards'),
      /ETF X30종목 · 여러 업종 · 비용 연 0\.2%.*ETF Y5종목 · 한 업종 · 비용 연 0\.9%/s,
    );
    // The question is decidable from the cards alone: sector breadth, not future swings.
    assert.match(
      h.text('etf-pick-compare'),
      /카드에 적힌 구성만 보고 답해 보세요\. 업종 분산 측면에서 더 폭넓게 구성된 ETF는 어느 쪽일까요\?/,
    );
    assert.equal(h.find('etf-pick-spread-result') === undefined, true);
    assert.equal(h.find('etf-pick-record').props.disabled, true);
    h.press('etf-pick-spread-y');
    const y = h.text('etf-pick-spread-result');
    h.press('etf-pick-spread-x');
    const x = h.text('etf-pick-spread-result');
    assert.equal(x === y, false);
    assert.match(x, /판단이 맞았습니다\. 여러 업종에 나눠 담은 ETF X가 업종 분산 측면에서 더 폭넓게 구성되어 있습니다/);
    assert.doesNotMatch(y, /맞았습니다/);
    assert.match(y, /ETF Y가 아니라, 여러 업종에 나눠 담은 ETF X가 업종 분산 측면에서 더 폭넓게 구성되어 있습니다/);
    for (const text of [x, y]) {
      assert.match(text, /^업종 분산 비교 결과/);
      assert.match(
        text,
        /여러 업종에 나눠 담으면 특정 업종에 집중된 위험을 낮출 수 있습니다\. 한 업종에만 담은 ETF Y는 그 업종의 부진에 더 직접적으로 노출됩니다/,
      );
      // Breadth alone promises neither a smaller loss nor smaller swings; weights and co-movement matter.
      assert.match(
        text,
        /업종이 넓게 나뉘어 있다는 사실만으로 ETF X의 손실이 더 작거나 가격이 덜 움직인다고 보장되지는 않습니다/,
      );
      assert.match(
        text,
        /종목 수뿐 아니라 종목별 구성 비중과, 종목들이 서로 얼마나 비슷하게 움직이는지\(상관관계\)도 함께 봐야 합니다/,
      );
      assert.match(
        text,
        /이름에 ETF가 붙었다는 것만으로 원금이 보장되거나 충분히 분산되는 것은 아닙니다/,
      );
      assert.doesNotMatch(
        text,
        /흔들|함께 내려갑니다|덜 움직입니다|손실이 더 작습니다|변동성이 (더 )?낮습니다/,
      );
    }
    assert.equal(h.find('etf-pick-cost') === undefined, true);
    h.press('etf-pick-record');
    for (const id of ['etf-pick-spread-x', 'etf-pick-spread-y', 'etf-pick-record'])
      assert.equal(h.find(id).props.disabled, true, id);
    assert.equal(h.find('etf-pick-spread-x').props.accessibilityState.selected, true);
    assert.equal(h.text('etf-pick-spread-result'), x);
    for (const id of ['etf-pick-gap-result', 'etf-pick-checklist', 'lesson-takeaways'])
      assert.equal(h.find(id) === undefined, true, id);
    // Cost is one cause among several, and the button names the gap neutrally.
    const cost = h.text('etf-pick-cost');
    assert.match(
      cost,
      /이 비용은 같은 지수를 따라가는 ETF의 수익률이 지수와 달라지는 원인 중 하나입니다\. 펀드가 일부를 현금으로 들고 있거나 구성종목을 편입·조정하는 과정에서도 차이가 생길 수 있습니다/,
    );
    assert.doesNotMatch(cost, /그래서 같은 지수를 따라가도|연 0\.[29]%/);
    assert.equal(h.find('etf-pick-gap').props.accessibilityLabel, '지수와 ETF 수익률 차이 보기');
    h.press('etf-pick-gap');
    const gap = h.text('etf-pick-gap-result');
    assert.match(
      gap,
      /지수 수익률\+10%.*ETF NAV 수익률\+9\.8%.*추적차이 \(ETF - 지수\)-0\.2%포인트/s,
    );
    assert.match(gap, /추적차이는 같은 기간 ETF 수익률에서 지수 수익률을 뺀 값입니다/);
    assert.match(
      gap,
      /비용·현금 보유·구성종목 편입과 조정 효과를 합친 가정이며, 원인별 비중은 추정하지 않습니다\. 따라서 이 차이 전체를 비용 때문이라고 볼 수는 없습니다/,
    );
    // The -0.2%p example is not tied to ETF X's 0.2% yearly cost.
    assert.doesNotMatch(gap, /ETF X|ETF Y|연 0\.2%|0\.9%/);
    assert.match(
      h.text('etf-pick-plot'),
      /지수시작: 100 \(시작=100\).*종료: 110 \(시작=100\).*ETF NAV시작: 100 \(시작=100\).*종료: 109\.8 \(시작=100\)/s,
    );
    assert.match(
      h.text('etf-pick-checklist'),
      /무엇을 담았나구성종목·업종·비중.*무엇을 따라가나추종하는 지수 또는 운용 방식.*얼마가 드나총보수 등 비용과 지수와의 차이/s,
    );
    const takeaways = h.text('lesson-takeaways');
    for (const [i, item] of [
      '지수는 여러 자산의 움직임을 하나의 기준 숫자로 나타냅니다.',
      'ETF는 여러 자산을 담은 펀드의 지분을 거래소에서 사고팔 수 있게 만든 상품입니다.',
      '분산은 한 종목이나 한 업종에 집중된 위험을 낮출 수 있지만, 시장 전체의 하락은 피하지 못합니다.',
      'ETF에는 자산으로 계산한 NAV와 거래소에서 형성되는 시장가격이 있습니다.',
      '비용·현금 보유·구성종목 조정 등의 영향으로 ETF 수익률은 지수와 차이가 날 수 있습니다.',
      'ETF를 고를 때는 무엇을 담았는지, 무엇을 따라가는지, 비용이 얼마인지 확인합니다.',
    ].entries())
      assert.ok(takeaways.includes(`${i + 1}. ${item}`), item);
    assert.doesNotMatch(takeaways, /7\./);
    assert.doesNotMatch(h.text(), /추적오차|흔들/);
    assert.equal(h.text('etf-pick-spread-result'), x);
    h.order(
      'etf-pick-intro',
      'etf-pick-compare',
      'etf-pick-cards',
      'etf-pick-spread-x',
      'etf-pick-spread-result',
      'etf-pick-record',
      'etf-pick-cost',
      'etf-pick-gap',
      'etf-pick-gap-result',
      'etf-pick-plot',
      'etf-pick-checklist',
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
    index: ['index-predict-a', 'index-predict-record', 'index-apply'],
    etf: ['etf-unit', 'etf-shock-pick-a', 'etf-shock-record'],
    'etf-price': ['etf-price-apply', 'etf-price-gap-10200', 'etf-price-record'],
    'etf-pick': ['etf-pick-spread-x', 'etf-pick-record', 'etf-pick-gap'],
  };
  it('ends each of the first three ETF chapters with its own summary', (t) => {
    const owners = new Map<string, string>();
    for (const chapter of ['index', 'etf', 'etf-price'] as const) {
      const h = setup(t, chapter);
      for (const action of completionActions[chapter]) h.press(action);
      const summaries = h.renderer.root.findAll(
        (node: any) =>
          typeof node.type === 'string' && node.props.testID === 'lesson-takeaways',
      );
      assert.equal(summaries.length, 1, chapter);
      const items: string[] = summaries[0]
        .findAll(
          (node: any) =>
            node.type === 'Text' && node.props.accessibilityRole !== 'header',
        )
        .map((node: any) => textContent(node).replace(/^\d+\. /, ''));
      assert.equal(items.length, 3, chapter);
      for (const item of items) {
        assert.equal(owners.has(item), false, `${chapter} repeats ${owners.get(item)}: ${item}`);
        owners.set(item, chapter);
      }
      act(() => h.renderer.unmount());
    }
    assert.equal(owners.size, 9);
  });
  it('leaves no removed ETF wording after finishing every ETF chapter', (t) => {
    for (const { id } of guideTopics.EtfIndex.chapters) {
      const h = setup(t, id);
      for (const action of completionActions[id]) h.press(action);
      assert.doesNotMatch(h.text(), /추적오차|분배금|총수익/, id);
      act(() => h.renderer.unmount());
    }
  });
  it('keeps every figure with its unit on screen, while screen-reader labels stay plain', (t) => {
    for (const chapter of guideChapters) {
      const h = setup(t, chapter.id);
      for (const action of completionActions[chapter.id]) h.press(action);
      if (chapter.id === 'closed-market') h.press('closed-market-more');
      const texts: string[] = h.renderer.root
        .findAll((node: any) => node.type === 'Text')
        .map(rawText);
      // A digit right before its unit, a % right before 포인트 or a digit right
      // after a range's tilde would still be a place to break inside a figure.
      const loose = texts.filter((text) =>
        /\d(?:%|원|주|포인트|종목|만 원|시간|건|분|시)|%포|~\d/.test(text),
      );
      assert.deepEqual(loose, [], chapter.id);
      assert.equal(texts.some((text) => text.includes('\u2060')), true, chapter.id);
      const labels: string[] = h.renderer.root
        .findAll((node: any) => typeof node.props?.accessibilityLabel === 'string')
        .map((node: any) => node.props.accessibilityLabel);
      assert.equal(labels.length > 0, true, chapter.id);
      assert.equal(
        labels.some((label) => /[\u2060\u200B]/.test(label)),
        false,
        `${chapter.id} labels stay plain`,
      );
      act(() => h.renderer.unmount());
    }
  });
  it('wraps a figure wider than its whole line at a readable place (very large text)', (t) => {
    const h = setup(t, 'etf-pick');
    for (const action of completionActions['etf-pick']) h.press(action);
    const value = () => h.find('etf-pick-gap-result').findAll(
      (node: any) => node.type === 'Text' && textContent(node) === '-0.2%포인트',
    )[0];
    const J = WORD_JOINER, Z = ZERO_WIDTH_SPACE;
    assert.equal(rawText(value()), `-0.2${J}%${J}포${J}인${J}트`, 'whole before any measurement');
    h.dimensions = { width: 320, height: 568, fontScale: 3 };
    h.update();
    const layout = (width: number) =>
      act(() => value().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 100 } } }));
    layout(230);
    assert.equal(rawText(value()), `-0.2%${Z}포${J}인${J}트`, 'breaks after the % only');
    layout(400);
    assert.equal(rawText(value()), `-0.2${J}%${J}포${J}인${J}트`, 'whole again once it fits');
    assert.equal(textContent(value()), '-0.2%포인트');
  });
  it('marks only the selected choice with ✓, hidden from screen readers, also after recording', (t) => {
    const sets: Record<GuideChapter, { before: string[]; ids: string[]; record: string }> = {
      'closed-market': {
        before: ['closed-market-next'],
        ids: ['closed-market-price-10100', 'closed-market-price-10300'],
        record: 'closed-market-order',
      },
      index: { before: [], ids: ['index-predict-a', 'index-predict-c'], record: 'index-predict-record' },
      etf: {
        before: ['etf-unit'],
        ids: ['etf-shock-pick-a', 'etf-shock-pick-b', 'etf-shock-pick-c'],
        record: 'etf-shock-record',
      },
      'etf-price': {
        before: ['etf-price-apply'],
        ids: ['etf-price-gap-9800', 'etf-price-gap-10000', 'etf-price-gap-10200'],
        record: 'etf-price-record',
      },
      'etf-pick': { before: [], ids: ['etf-pick-spread-x', 'etf-pick-spread-y'], record: 'etf-pick-record' },
    };
    for (const [chapter, { before, ids, record }] of Object.entries(sets) as [GuideChapter, (typeof sets)[GuideChapter]][]) {
      const h = setup(t, chapter);
      for (const action of before) h.press(action);
      const marks = (id: string) =>
        h.find(id).findAll((node: any) => typeof node.type === 'string' && node.props.testID === `${id}-selected`);
      const marked = () => ids.filter((id) => marks(id).length > 0);
      const box = (id: string) => {
        const { paddingHorizontal, paddingVertical, borderWidth } = flatten(h.find(id).props.style);
        return [paddingHorizontal, paddingVertical, borderWidth].join('/');
      };
      const sizes = ids.map(box);
      assert.deepEqual(marked(), [], `${chapter}: nothing selected yet`);
      const [first, last] = [ids[0], ids.at(-1)!];
      h.press(first);
      assert.deepEqual(marked(), [first], chapter);
      h.press(last);
      assert.deepEqual(marked(), [last], `${chapter}: the mark follows the selection`);
      assert.deepEqual(ids.map(box), sizes, `${chapter}: selecting changes no size`);
      const [mark] = marks(last);
      // Decorative: hidden from screen readers and touches, drawn as the ✓ path.
      assert.equal(mark.props['aria-hidden'], true);
      assert.equal(mark.props.importantForAccessibility, 'no-hide-descendants');
      assert.equal(mark.props.accessibilityElementsHidden, true);
      assert.equal(mark.props.pointerEvents, 'none');
      assert.equal(mark.findAll((node: any) => node.type === 'Path').length, 1);
      // The ring sits inside the button and is drawn in the label color on the fill.
      const ring = flatten(mark.props.style);
      assert.equal(ring.position, 'absolute');
      assert.equal(ring.borderWidth >= 2, true);
      assert.equal(ring.borderColor, semantic.onAccent);
      assert.equal([ring.top, ring.left, ring.right, ring.bottom].every((inset) => inset >= 0), true);
      for (const id of ids) {
        const button = h.find(id);
        const label = button.findAll((node: any) => node.type === 'Text')[0];
        // Screen readers keep reading the plain label and the selected state.
        assert.equal(textContent(label), button.props.accessibilityLabel, id);
        assert.equal(button.props.accessibilityState.selected, id === last, id);
      }
      h.press(record);
      assert.equal(h.find(last).props.disabled, true, chapter);
      assert.deepEqual(marked(), [last], `${chapter}: the recorded choice stays marked`);
      h.readable();
      act(() => h.renderer.unmount());
    }
  });
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
