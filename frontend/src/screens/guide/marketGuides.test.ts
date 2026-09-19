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
  limitBuy,
  nav,
  normalize,
  premium,
  priceDomain,
  sessionOhlc,
  shareConversion,
  usTradingSession,
} from './marketLessonCalculations.ts';
import {
  auctionBuys,
  auctionSells,
  fundAssets,
  sessionTrades,
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
function untilLimits(h: any) {
  h.press('halt-apply');
  h.press('halt-resume');
  for (let i = 0; i < 4; i++) h.press('vi-step');
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
  it('derives eligible auction quantities and limit executions without mutating orders', () => {
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
    const fill = limitBuy(
      [
        { price: 10100, quantity: 20 },
        { price: 10050, quantity: 10 },
        { price: 10010, quantity: 5 },
      ],
      20,
      10050,
    );
    assert.deepEqual(fill.fills, [
      { price: 10010, quantity: 5 },
      { price: 10050, quantity: 10 },
    ]);
    assert.equal(fill.remaining, 5);
    assert.equal(fill.quantity, 15);
    assert.equal(limitBuy([], 20, 10050).average, null);
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
      open: 10200,
      high: 10850,
      low: 10200,
      close: 10850,
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
      const h = setup(t, 'sessions', topic);
      for (const chapter of guideTopics[topic].chapters) {
        h.press(`guide-chapter-${chapter.id}`);
        assert.deepEqual(h.routes.at(-1), [
          'GuideChapter',
          { chapter: chapter.id },
        ]);
      }
      h.readable();
    });
  it('distinguishes simultaneous KRX sessions, NXT, dated ET/KST and holiday precedence', (t) => {
    const h = setup(t, 'sessions');
    h.press('session-krx-open');
    assert.match(h.text('session-result'), /08:35.*지금은 체결하지/s);
    h.press('session-krx-pre');
    assert.match(h.text('session-result'), /08:35.*전 거래일 정규장 종가/s);
    h.press('session-krx-after-receive');
    assert.match(h.text('session-result'), /15:30.*15:40.*지금은 체결하지/s);
    h.press('session-nxt-day');
    assert.match(h.text('session-result'), /NXT.*09:00:30~15:20/s);
    h.press('session-record');
    const before = h.text('session-result');
    h.press('us-date-2026-01-07');
    assert.match(h.text('us-date-result'), /2026-01-08 06:00/);
    h.press('us-date-2026-07-08');
    assert.match(h.text('us-date-result'), /2026-07-09 05:00/);
    h.press('us-date-record');
    const us = h.text('us-date-result');
    for (const id of ['weekend', 'krx-holiday', 'us-holiday']) {
      h.press(`calendar-${id}`);
      assert.match(h.text('calendar-result'), /운영하지 않음/);
    }
    h.press('calendar-us-may');
    assert.doesNotMatch(h.text('calendar-result'), /운영하지 않음/);
    h.press('calendar-early');
    assert.match(h.text('calendar-result'), /13:00.*2026-11-28 03:00/s);
    assert.equal(h.text('session-result'), before);
    assert.equal(h.text('us-date-result'), us);
    h.order(
      'session-result',
      'sessions-b',
      'us-date-result',
      'sessions-c',
      'calendar-result',
    );
    h.readable();
  });
  it('collects without execution, preserves close, then runs regular and thin comparisons sequentially', (t) => {
    const h = setup(t, 'auctions');
    for (let i = 0; i < 3; i++) {
      h.press('auction-collect');
      assert.match(h.text('auction-collection'), /10,000원.*0주/s);
    }
    assert.match(h.text('auction-candidates'), /10,200원.*80주/);
    h.press('auction-match');
    assert.match(h.text('auction-result'), /10,200원에서 80주/);
    const opening = h.text('auction-result');
    h.press('close-collect');
    h.press('close-match');
    const close = h.text('close-result');
    h.press('close-after');
    assert.match(h.text('after-close-result'), /10,200원.*10,250원/s);
    assert.equal(h.find('session-extended-buy'), undefined);
    h.press('session-regular-buy');
    assert.match(h.text('session-regular-result'), /체결 수량20주/);
    const regular = h.text('session-regular-result');
    h.press('session-extended-buy');
    assert.match(
      h.text('session-extended-result'),
      /10,010원 × 5주.*10,050원 × 10주.*미체결 수량5주/s,
    );
    assert.doesNotMatch(h.text('session-extended-result'), /10,100원/);
    assert.equal(h.text('auction-result'), opening);
    assert.equal(h.text('close-result'), close);
    assert.equal(h.text('session-regular-result'), regular);
    h.order(
      'auction-result',
      'auction-b',
      'close-result',
      'after-close-result',
      'auction-c',
      'session-regular-result',
      'session-extended-buy',
      'session-extended-result',
    );
    h.readable();
  });
  it('renders the gap and a falling candle with +6%, then filters the original records', (t) => {
    const h = setup(t, 'gaps');
    h.press('gap-open');
    const gap = h.text('gap-result');
    h.press('gap-close');
    assert.equal(h.find('gap-candle-body-0')?.props.fill, DOWN_COLOR);
    assert.match(h.text('gap-close-result'), /음봉.*\+6%/s);
    const result = h.text('gap-close-result');
    h.press('gap-scope-extended');
    assert.match(h.text('gap-scope-candle'), /10,200원.*10,850원/s);
    assert.equal(h.text('gap-result'), gap);
    assert.equal(h.text('gap-close-result'), result);
    h.order('gap-result', 'gap-close', 'gap-close-result', 'gaps-c');
    h.readable();
  });
  it('separates halt, VI collection and limits without zero-price candles', (t) => {
    const h = setup(t, 'safeguards');
    h.press('halt-apply');
    assert.match(h.text('halt-plot'), /거래 기록 없음/);
    h.press('halt-resume');
    const halt = h.text('halt-result');
    const startVi = h.find('vi-step').props.onPress;
    act(() => {
      startVi();
      startVi();
    });
    assert.match(h.text('vi-state'), /VI 발동/);
    h.press('vi-step');
    assert.match(h.text('vi-state'), /단일가 주문 접수 가능.*10,000원.*0주/s);
    h.press('vi-step');
    assert.match(h.text('vi-state'), /10,200원.*80주/s);
    h.press('vi-step');
    h.press('limit-price-13200');
    h.press('limit-submit');
    assert.match(h.text('limit-price-result'), /거절/);
    h.press('limit-upper');
    h.press('limit-lower');
    assert.match(h.text('limit-upper-result'), /13,000원.*0주/);
    assert.match(h.text('limit-lower-result'), /7,000원.*0주/);
    assert.equal(h.text('halt-result'), halt);
    h.order(
      'halt-resume-result',
      'vi-b',
      'vi-result',
      'limits-c',
      'limit-price-result',
      'limit-upper-result',
      'limit-lower-result',
    );
    h.readable();
    h.press('reset-safeguards');
    untilLimits(h);
    h.press('limit-price-7000');
    h.press('limit-submit');
    assert.match(h.text('limit-price-result'), /가격 조건 허용/);
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
  it('uses ex-date eligibility and moves receivable to cash only on payment', (t) => {
    const h = setup(t, 'dividends');
    h.press('dividend-buy-2026-03-13');
    assert.match(h.text('dividend-eligibility'), /받을 권리/);
    h.press('dividend-buy-2026-03-16');
    assert.match(h.text('dividend-eligibility'), /받을 권리가 없습니다/);
    h.press('dividend-record');
    h.press('dividend-ex');
    const ex = h.text('dividend-ex-result');
    assert.match(ex, /95,000원.*받을 배당금5,000원.*받은 현금0원.*100,000원/s);
    h.press('dividend-pay');
    assert.match(
      h.text('dividend-paid-result'),
      /받을 배당금0원.*받은 현금5,000원.*100,000원/s,
    );
    assert.equal(h.text('dividend-ex-result'), ex);
    h.order(
      'dividend-eligibility',
      'dividend-record',
      'dividend-ex-result',
      'dividend-pay',
      'dividend-paid-result',
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
  it('derives +4% index and NAV from the same quantities and freezes selected inputs', (t) => {
    const h = setup(t, 'index');
    h.press('index-apply');
    const result = h.text('index-result');
    assert.match(result, /\+4%.*1,040포인트/s);
    h.press('index-fund');
    assert.match(h.text('index-fund-result'), /1,040,000원.*100주.*10,400원/s);
    assert.equal(h.text('index-result'), result);
    h.order('index-result', 'index-b', 'index-fund-result');
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
    assert.equal(h.find('tracking-variable'), undefined);
    h.press('tracking-stable');
    const stable = h.text('tracking-stable-result');
    h.press('tracking-variable');
    assert.match(h.text('tracking-variable-result'), /0.60%포인트/);
    for (const id of [
      'assets',
      'benchmark',
      'weights',
      'costs',
      'distribution',
      'asof',
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
  for (const chapter of Object.values(guideTopics).flatMap((topic) => [
    ...topic.chapters,
  ]))
    it(`${chapter.id} resets locally, has no background playback and uses readable text`, (t) => {
      const h = setup(t, chapter.id);
      const original = h.text();
      const button = h.renderer.root
        .findAllByType('Pressable')
        .find(
          (button: any) =>
            !button.props.disabled &&
            button.props.testID !== `reset-${chapter.id}`,
        );
      act(() => button.props.onPress());
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
    assert.equal(UP_COLOR, '#16a34a');
    assert.equal(DOWN_COLOR, '#dc2626');
    const source = readFileSync(
      new URL('./MarketLessonUi.tsx', import.meta.url),
      'utf8',
    );
    assert.match(source, /UP_COLOR/);
    assert.match(source, /DOWN_COLOR/);
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
