import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it, type TestContext } from 'node:test';
import {
  THICK_ASKS,
  THIN_ASKS,
  FIVE_MINUTE,
  PATH_A,
  PATH_B,
  buyFrames,
  summarize,
  ohlcFromPrices,
  candleParts,
  aggregateCandles,
} from './lessonCalculations.ts';

const require = createRequire(import.meta.url);
const {
  interactionHarness,
  React,
  act,
  flatten,
} = require('../../../test/interactionTestHarness.cjs');
function setup(t: TestContext, screen: string) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = interactionHarness();
  h.focused = true;
  h.native.SafeAreaView = 'SafeAreaView';
  h.positions = {};
  h.native.View = ({ ref, ...props }: any) => {
    React.useImperativeHandle(
      ref,
      () => ({
        measureLayout: (_relative: any, callback: any) => {
          const layout = h.positions[props.testID];
          if (layout) callback(0, layout.y, 280, layout.height);
        },
      }),
      [props.testID],
    );
    return React.createElement('View', props);
  };
  h.scrolls = [];
  h.native.ScrollView = ({ ref, ...props }: any) => {
    React.useImperativeHandle(
      ref,
      () => ({ scrollTo: (options: any) => h.scrolls.push(options) }),
      [],
    );
    return React.createElement('ScrollView', props);
  };
  const ui = h.load('src/screens/guide/LessonUi.tsx', {
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
  });
  const sequence = h.load('src/screens/guide/useLessonSequence.ts', {
    '@react-navigation/native': {
      useFocusEffect: (effect: () => void) =>
        React.useEffect(() => (h.focused ? effect() : undefined), [effect, h.focused]),
    },
  });
  const figures = h.load('src/screens/guide/CandleFigures.tsx', {
    './LessonUi': ui,
    'react-native-svg': {
      __esModule: true,
      default: 'Svg',
      Line: 'Line',
      Rect: 'Rect',
      Polyline: 'Polyline',
    },
  });
  h.Screen = h.load(`src/screens/guide/${screen}.tsx`, {
    './LessonUi': ui,
    './useLessonSequence': sequence,
    './CandleFigures': figures,
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
  }).default;
  h.routes = [];
  h.props = { navigation: { navigate: (route: string) => h.routes.push(route) } };
  h.renderer = h.render(React.createElement(h.Screen, h.props));
  h.find = (id: string) =>
    h.renderer.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props.testID === id,
    )[0];
  h.press = (id: string) => {
    assert.ok(h.find(id), id);
    act(() => h.find(id).props.onPress());
  };
  h.tick = (ms: number) => act(() => t.mock.timers.tick(ms));
  h.finish = () => {
    for (let i = 0; i < 12; i++) h.tick(1200);
  };
  h.update = () => act(() => h.renderer.update(React.createElement(h.Screen, h.props)));
  h.text = (id?: string) => textContent(id ? h.find(id) : h.renderer.toJSON());
  t.after(() => act(() => h.renderer.unmount()));
  return h;
}
function textContent(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return (node?.children ?? []).map(textContent).join('');
}
function order(h: any, ...ids: string[]) {
  const nodes = h.renderer.root.findAll((node: any) => typeof node.type === 'string');
  const indices = ids.map((id) => nodes.indexOf(h.find(id)));
  assert.ok(
    indices.every((value, i) => value >= 0 && (i === 0 || value > indices[i - 1])),
    `${ids}: ${indices}`,
  );
}
function checkReadable(h: any) {
  const nodes = h.renderer.root.findAll((node: any) => typeof node.type === 'string');
  const ids = nodes.filter((node: any) => node.props.testID).map((node: any) => node.props.testID);
  assert.equal(ids.length, new Set(ids).size, 'unique test IDs');
  for (const node of nodes.filter((item: any) => item.type === 'Text')) {
    const style = flatten(node.props.style);
    assert.equal(node.props.numberOfLines, undefined);
    assert.equal(node.props.ellipsizeMode, undefined);
    assert.notEqual(node.props.allowFontScaling, false);
    assert.equal(style.height, undefined);
    assert.equal(style.maxHeight, undefined);
    assert.ok(style.fontSize >= 14);
    assert.ok(style.lineHeight >= style.fontSize * 1.4);
  }
  for (const button of nodes.filter((node: any) => node.type === 'Pressable')) {
    assert.equal(button.props.accessibilityRole, 'button');
    assert.ok(button.props.accessibilityLabel);
    if (button.props.testID !== 'guide-chapter-OrderBookLesson' && button.props.testID !== 'guide-chapter-Liquidity') {
      assert.equal(flatten(button.props.style).maxWidth, '100%', 'wrapped choice buttons cannot exceed their container');
    }
  }
  assert.doesNotMatch(h.text(), /NaN|Infinity/);
}
function completeLiquidity(h: any) {
  h.press('liquidity-compare-run');
  h.finish();
  h.press('liquidity-cancel-run');
  h.press('liquidity-trade-run');
  h.finish();
}
function reachChoices(h: any) {
  h.press('orders-market-run');
  h.finish();
  h.press('orders-limit-register');
  h.press('orders-quotes-run');
  h.press('orders-limit-run');
  h.finish();
}

describe('local guide calculations', () => {
  it('derives thick/thin 20-share fills, averages and depleted levels without changing fixtures', () => {
    const before = JSON.stringify([THICK_ASKS, THIN_ASKS]);
    const thick = buyFrames(THICK_ASKS, 20).at(-1)!.value;
    const thin = buyFrames(THIN_ASKS, 20).at(-1)!.value;
    assert.deepEqual(thick.fills, [{ price: 10010, quantity: 20 }]);
    assert.deepEqual(summarize(thick.fills), { quantity: 20, amount: 200200, average: 10010 });
    assert.equal(thick.lastPrice, 10010);
    assert.deepEqual(thin.fills, [
      { price: 10010, quantity: 5 },
      { price: 10020, quantity: 8 },
      { price: 10030, quantity: 7 },
    ]);
    assert.deepEqual(summarize(thin.fills), { quantity: 20, amount: 200420, average: 10021 });
    assert.equal(thin.lastPrice, 10030);
    assert.deepEqual(thin.asks, [{ price: 10030, quantity: 3 }]);
    assert.equal(JSON.stringify([THICK_ASKS, THIN_ASKS]), before);
  });
  it('retains partial fills and empty averages for shared order exercises', () => {
    const limited = buyFrames([{ price: 10010, quantity: 2 }], 3).at(-1)!.value;
    assert.equal(summarize(limited.fills).quantity, 2);
    assert.match(limited.status, /1주 미체결/);
    assert.equal(summarize([]).average, null);
  });
  it('calculates candle ranges, opposing intrabar paths, and OHLC aggregation', () => {
    const candle = ohlcFromPrices(PATH_A);
    assert.deepEqual(candle, { open: 10000, high: 10600, low: 9700, close: 10400 });
    assert.deepEqual(ohlcFromPrices(PATH_B), candle);
    assert.deepEqual(candleParts(candle), {
      direction: '양봉',
      body: [10000, 10400],
      upper: [10400, 10600],
      lower: [9700, 10000],
    });
    assert.deepEqual(candleParts({ ...candle, close: 9800 }), {
      direction: '음봉',
      body: [9800, 10000],
      upper: [10000, 10600],
      lower: [9700, 9800],
    });
    assert.equal(candleParts({ ...candle, close: 10000 }).direction, '시가와 종가 동일');
    assert.deepEqual(aggregateCandles(FIVE_MINUTE), candle);
  });
  it('computes 12-share market buy from actual fills, not the displayed current price', () => {
    const final = buyFrames(THIN_ASKS, 12).at(-1)!.value;
    assert.deepEqual(final.fills, [
      { price: 10010, quantity: 5 },
      { price: 10020, quantity: 7 },
    ]);
    assert.deepEqual(summarize(final.fills), {
      quantity: 12,
      amount: 120190,
      average: 120190 / 12,
    });
    assert.equal(final.lastPrice, 10020);
  });
});

describe('continuous guide interactions', () => {
  it('opens the two market chapters through existing ActionPressable cards', (t) => {
    const h = setup(t, 'MarketBasicsChaptersScreen');
    h.press('guide-chapter-OrderBookLesson');
    h.press('guide-chapter-Liquidity');
    assert.deepEqual(h.routes, ['OrderBookLesson', 'Liquidity']);
    assert.equal(h.renderer.root.findAllByType('Pressable').length, 2);
    checkReadable(h);
  });
  it('walks exactly two liquidity exercises downward and preserves all prior results', (t) => {
    const h = setup(t, 'LiquidityScreen');
    assert.equal(h.find('liquidity-cancel'), undefined);
    const start = h.find('liquidity-compare-run').props.onPress;
    act(() => {
      start();
      start();
    });
    assert.match(h.find('liquidity-thin-ask-10010').props.accessibilityLabel, /체결 대상/);
    h.tick(900);
    assert.match(h.text('liquidity-thin-ask-10010'), /5 → 0주/);
    assert.match(h.text('liquidity-thick-ask-10010'), /300 → 280주/);
    h.tick(1100);
    assert.equal(h.find('liquidity-thin-ask-10010'), undefined);
    h.finish();
    assert.match(h.text('liquidity-thick-values-average'), /10,010원/);
    assert.match(h.text('liquidity-thin-values-average'), /10,021원/);
    order(h, 'liquidity-compare-result', 'liquidity-cancel', 'liquidity-cancel-run');
    h.press('liquidity-cancel-run');
    assert.equal(h.find('liquidity-cancel-book-ask-10010'), undefined);
    assert.match(h.text('liquidity-cancel-book-price'), /10,000원/);
    order(h, 'liquidity-cancel-result', 'liquidity-trade-run', 'liquidity-trade-book');
    h.press('liquidity-trade-run');
    h.finish();
    assert.match(h.text('liquidity-trade-book-price'), /10,020원/);
    assert.match(h.text('liquidity-cancel-book-price'), /10,000원/, 'prior result remains frozen');
    order(h, 'liquidity-trade-result', 'lesson-takeaways');
    assert.equal(h.find('liquidity-size'), undefined);
    assert.doesNotMatch(h.text(), /실습 3|주문 규모와 가격 충격|30주|3주와 비교|10주와 비교/);
    assert.match(h.text('liquidity-cancel-book-status'), /다른 시장 참여자/);
    assert.equal(h.find('liquidity-cancel-run').props.accessibilityLabel, '대기 중인 매도 주문이 취소되는 상황 보기');
    assert.match(h.text('liquidity-thick-values-average'), /10,010원/);
    assert.match(h.text('liquidity-thin-values-average'), /10,021원/);
    assert.deepEqual(h.scrolls, [], 'no jump to an earlier exercise');
    checkReadable(h);
    h.press('liquidity-reset');
    h.finish();
    assert.equal(h.find('liquidity-cancel'), undefined);
    assert.equal(h.find('liquidity-compare-run').props.disabled, false);
    assert.match(h.text('liquidity-thin-price'), /10,000원/);
  });
  it('connects all seven beginner terms to one candle before the builder', (t) => {
    const h = setup(t, 'CandlesScreen');
    const terms = { high: '고가 (High)', upper: '윗꼬리 (Upper Wick)', close: '종가 (Close)', body: '몸통 (Body)', open: '시가 (Open)', lower: '아랫꼬리 (Lower Wick)', low: '저가 (Low)' };
    for (const [part, label] of Object.entries(terms)) {
      assert.ok(h.text(`candle-term-${part}`).includes(label));
      assert.ok(h.find(`candle-term-${part}`).findAll((node: any) => node.props.testID === `candle-anatomy-${part}`).length, 'term shares its row with its candle position');
    }
    order(h, 'candle-term-high', 'candle-term-upper', 'candle-term-close', 'candle-term-body', 'candle-term-open', 'candle-term-lower', 'candle-term-low', 'candle-builder');
    assert.match(h.text('candle-term-open'), /처음 거래가 체결/);
    assert.match(h.text('candle-term-close'), /마지막으로 거래가 체결/);
    assert.match(h.text('candle-term-body'), /높으면 양봉.*낮으면 음봉/);
    checkReadable(h);
  });
  it('updates SVG geometry, replays both paths and aggregates only after results', (t) => {
    const h = setup(t, 'CandlesScreen');
    const initialBody = { ...h.find('candle-builder-figure-body').props };
    const initialUpper = h.find('candle-builder-figure-upper').props.y1;
    h.press('candle-high-10800');
    assert.notEqual(h.find('candle-builder-figure-upper').props.y1, initialUpper);
    h.press('candle-low-9500');
    h.press('candle-close-9800');
    assert.match(h.text('candle-builder-figure'), /음봉/);
    assert.notEqual(h.find('candle-builder-figure-body').props.y, initialBody.y);
    assert.match(h.text('candle-builder-figure'), /몸통: 9,800원 ~ 10,000원/);
    assert.equal(h.find('candle-path-a-run'), undefined);
    h.press('candle-builder-confirm');
    order(h, 'candle-builder-result', 'candle-paths', 'candle-path-a-run');
    h.press('candle-path-a-run');
    h.tick(1000);
    assert.match(h.text('candle-path-a'), /10,000원 → 10,600원/);
    assert.equal(h.find('candle-path-b-run'), undefined);
    h.finish();
    order(h, 'candle-path-a-result', 'candle-path-b-run');
    h.press('candle-path-b-run');
    h.finish();
    assert.notEqual(
      h.find('candle-path-a-line').props.points,
      h.find('candle-path-b-line').props.points,
    );
    for (const prop of ['y', 'height', 'fill'])
      assert.equal(
        h.find('candle-compare-a-body').props[prop],
        h.find('candle-compare-b-body').props[prop],
      );
    order(h, 'candle-paths-result', 'candle-aggregation', 'candle-aggregate-run');
    h.press('candle-aggregate-run');
    assert.match(
      h.text('candle-fifteen'),
      /시가 10,000원.*고가 10,600원.*저가 9,700원.*종가 10,400원/s,
    );
    order(h, 'candle-aggregate-result', 'lesson-takeaways');
    assert.deepEqual(h.scrolls, []);
    checkReadable(h);
    h.press('candles-reset');
    assert.equal(h.find('candle-paths'), undefined);
    assert.match(h.text('candle-builder-figure'), /양봉/);
  });
  it('keeps a limit order waiting through quote changes and fills only on eligible selling', (t) => {
    const h = setup(t, 'OrderTypesScreen');
    h.press('orders-market-run');
    h.tick(900);
    assert.match(h.text('orders-market-book-ask-10010'), /5 → 0주/);
    h.finish();
    assert.match(h.text('orders-market-values-average'), /10,015.83원/);
    order(h, 'orders-market-result', 'orders-limit', 'orders-limit-register');
    h.press('orders-limit-register');
    assert.match(
      h.find('orders-limit-book-bid-9990').props.accessibilityLabel,
      /매수, 가격 9,990원, 잔량 10주, 내 지정가 주문/,
    );
    assert.match(h.text('orders-limit-book-status'), /대기 중/);
    order(h, 'orders-limit-waiting', 'orders-quotes-run');
    h.press('orders-quotes-run');
    assert.equal(h.find('orders-quotes-book-ask-10010'), undefined);
    assert.ok(h.find('orders-quotes-book-ask-10040'));
    assert.match(h.text('orders-quotes-book-status'), /대기 중/);
    assert.match(h.text('orders-quotes-book-price'), /10,000원/);
    order(h, 'orders-quotes-result', 'orders-limit-run', 'orders-limit-active-book');
    h.press('orders-limit-run');
    assert.match(h.find('orders-limit-active-book-bid-9990').props.accessibilityLabel, /체결 대상/);
    h.tick(1000);
    assert.match(h.text('orders-limit-active-book-bid-9990'), /10 → 0주/);
    assert.match(h.text('orders-limit-active-book-price'), /9,990원/);
    h.finish();
    assert.equal(h.find('orders-limit-active-book-bid-9990'), undefined);
    assert.match(h.text('orders-limit-values'), /99,900원/);
    assert.match(h.text('orders-quotes-book-price'), /10,000원/);
    order(h, 'orders-limit-result', 'orders-choice', 'orders-choice-a-market');
    h.press('orders-choice-a-market');
    order(h, 'orders-choice-a-result', 'orders-choice-b-limit');
    h.press('orders-choice-b-limit');
    assert.match(h.text('orders-choice-b-result'), /가격 조건을 우선하므로/);
    order(h, 'orders-choice-b-result', 'lesson-takeaways');
    assert.deepEqual(h.scrolls, []);
    checkReadable(h);
    h.press('orders-reset');
    assert.equal(h.find('orders-limit'), undefined);
    assert.equal(h.find('orders-market-run').props.disabled, false);
  });
  it('explains both alternative order choices without teaching absolute superiority', (t) => {
    const h = setup(t, 'OrderTypesScreen');
    reachChoices(h);
    h.press('orders-choice-a-limit');
    assert.match(h.text('orders-choice-a-result'), /매도가 지연될 수/);
    h.press('orders-choice-b-market');
    assert.match(h.text('orders-choice-b-result'), /상한을 보장하지 않습니다/);
    assert.match(h.text('orders-choice-b-result'), /우열보다/);
  });
  it('reveals only the current limit exercise row, including a row taller than the viewport', (t) => {
    const h = setup(t, 'OrderTypesScreen');
    h.dimensions = { width: 280, height: 568, fontScale: 3 };
    h.update();
    h.press('orders-market-run');
    h.finish();
    h.press('orders-limit-register');
    h.press('orders-quotes-run');
    h.positions['orders-limit-active-book'] = { y: 30000, height: 2000 };
    h.positions['orders-limit-active-book-bid-9990'] = { y: 31000, height: 700 };
    act(() =>
      h.renderer.root.findByType('ScrollView').props.onScroll({
        nativeEvent: {
          contentOffset: { y: 29800 },
          layoutMeasurement: { height: 568 },
        },
      }),
    );
    h.press('orders-limit-run');
    assert.deepEqual(h.scrolls, [{ y: 31000, animated: false }]);
    h.tick(1000);
    assert.ok(
      h.scrolls.every((scroll: any) => scroll.y >= 30000),
      'never falls back to the first order book',
    );
  });
  it('follows the thin book during a stacked simultaneous comparison without competing scrolls', (t) => {
    const h = setup(t, 'LiquidityScreen');
    h.positions['liquidity-thick'] = { y: 1000, height: 1500 };
    h.positions['liquidity-thick-ask-10010'] = { y: 1800, height: 200 };
    h.positions['liquidity-thin'] = { y: 3000, height: 1500 };
    h.positions['liquidity-thin-ask-10010'] = { y: 3800, height: 200 };
    act(() =>
      h.renderer.root
        .findByType('ScrollView')
        .props.onLayout({ nativeEvent: { layout: { height: 568 } } }),
    );
    h.press('liquidity-compare-run');
    assert.deepEqual(h.scrolls, [{ y: 3432, animated: false }]);
  });
  for (const [screen, start, status, reset] of [
    ['LiquidityScreen', 'liquidity-compare-run', 'liquidity-thin-status', 'liquidity-reset'],
    ['CandlesScreen', 'candle-path-a-run', 'candle-path-a', 'candles-reset'],
    ['OrderTypesScreen', 'orders-market-run', 'orders-market-book-status', 'orders-reset'],
  ]) {
    it(`${screen} guards duplicate starts, pauses on blur, and clears timers on reset/unmount`, (t) => {
      const h = setup(t, screen);
      if (screen === 'CandlesScreen') h.press('candle-builder-confirm');
      const onPress = h.find(start).props.onPress;
      act(() => {
        onPress();
        onPress();
      });
      assert.equal(h.find(reset).props.accessibilityLabel, '처음부터');
      const before = h.text(status);
      h.focused = false;
      h.update();
      h.finish();
      assert.equal(h.text(status), before);
      h.focused = true;
      h.update();
      h.tick(1100);
      assert.notEqual(h.text(status), before);
      h.press(reset);
      h.finish();
      if (screen === 'CandlesScreen') h.press('candle-builder-confirm');
      assert.equal(h.find(start).props.disabled, false);
      h.press(start);
      act(() => h.renderer.unmount());
      h.finish();
    });
  }
  for (const screen of ['LiquidityScreen', 'CandlesScreen', 'OrderTypesScreen']) {
    it(`${screen} wraps text and stacks comparisons at narrow widths and large font scales`, (t) => {
      const h = setup(t, screen);
      if (screen === 'LiquidityScreen') {
        completeLiquidity(h);
      }
      if (screen === 'CandlesScreen') {
        h.press('candle-builder-confirm');
        h.press('candle-path-a-run');
        h.finish();
        h.press('candle-path-b-run');
        h.finish();
        h.press('candle-aggregate-run');
      }
      if (screen === 'OrderTypesScreen') {
        reachChoices(h);
        h.press('orders-choice-a-market');
        h.press('orders-choice-b-limit');
      }
      for (const width of [280, 320, 1024])
        for (const fontScale of [1, 1.3, 2, 3]) {
          h.dimensions = { width, height: 568, fontScale };
          h.update();
          checkReadable(h);
          const comparisonRows = h.renderer.root
            .findAllByType('View')
            .filter(
              (node: any) =>
                Array.isArray(node.props.style) &&
                flatten(node.props.style[0]).gap === 16 &&
                flatten(node.props.style[0]).flexDirection === 'row',
            );
          for (const row of comparisonRows)
            assert.equal(
              flatten(row.props.style).flexDirection,
              width < 720 || fontScale > 1.3 ? 'column' : 'row',
            );
        }
      assert.deepEqual(h.scrolls, []);
    });
  }
  it('isolates all educational modules from account, order and candle services', () => {
    const directory = new URL('.', import.meta.url);
    for (const file of readdirSync(directory).filter(
      (name) => /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts'),
    )) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const path of imports)
        assert.doesNotMatch(
          path,
          /features|services|TradingAccount|Wallet|Position|api|axios|query/i,
          `${file}: ${path}`,
        );
      assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\b|AsyncStorage|localStorage/);
    }
  });
});
