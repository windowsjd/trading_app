import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

function setup(t: TestContext, home = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = interactionHarness();
  h.focused = true;
  h.native.SafeAreaView = 'SafeAreaView';
  h.scrolls = [];
  h.native.ScrollView = ({ ref, ...props }: any) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: (options: any) => h.scrolls.push(options) }), []);
    return React.createElement('ScrollView', props);
  };
  const lessonModule = h.load('src/screens/guide/useOrderBookLesson.ts', {
    '@react-navigation/native': {
      useFocusEffect: (effect: () => void) => React.useEffect(() => h.focused ? effect() : undefined, [effect, h.focused]),
    },
  });
  h.Screen = h.load(`src/screens/guide/${home ? 'GuideScreen' : 'MarketBasicsScreen'}.tsx`, {
    './useOrderBookLesson': lessonModule,
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
  }).default;
  h.routes = [];
  h.props = { navigation: { navigate: (route: string) => h.routes.push(route) } };
  h.renderer = h.render(React.createElement(h.Screen, h.props));
  h.find = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  h.tick = (milliseconds: number) => act(() => t.mock.timers.tick(milliseconds));
  h.press = (id: string) => act(() => h.find(id).props.onPress());
  h.text = () => JSON.stringify(h.renderer.toJSON());
  h.update = () => act(() => h.renderer.update(React.createElement(h.Screen, h.props)));
  t.after(() => act(() => h.renderer.unmount()));
  return h;
}

const ids = TEST_IDS.guide;

describe('guide home and market basics lesson', () => {
  it('opens only MarketBasics; upcoming guides have no touch surface', (t) => {
    const h = setup(t, true);
    const buttons = h.renderer.root.findAllByType('Pressable');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.testID, ids.marketBasicsCard);
    assert.equal(buttons[0].props.accessibilityRole, 'button');
    h.press(ids.marketBasicsCard);
    assert.deepEqual(h.routes, ['MarketBasics']);
    for (const title of ['시장기초', '캔들', '주문방식', '주식특성']) assert.ok(h.text().includes(title));
    assert.equal(h.renderer.root.findAllByType('Text').filter((node: any) => node.props.children === '준비 중').length, 3);
    assert.equal(h.renderer.root.findAllByType('Text').filter((node: any) => node.props.children === '가이드').length, 0);
    act(() => buttons[0].props.onPressIn({ nativeEvent: { pageX: 120, pageY: 210 } }));
    assert.ok(h.renderer.root.findAllByType('AnimatedView').length > 0, 'available card keeps the shared ripple');
  });

  it('shows the resting book, visibly executes each price level in order, then fully resets', (t) => {
    const h = setup(t);
    const row = (price: number) => h.find(ids.ask(price));
    const lastPrice = () => h.find(ids.lastPrice).props.accessibilityLabel;
    const bids = () => [9990, 9980, 9970].map((price) => h.find(ids.bid(price)).props.accessibilityLabel);
    const initialBids = bids();
    const initialAsks = [10030, 10020, 10010].map((price) => row(price).props.accessibilityLabel);
    assert.match(lastPrice(), /10,000원/);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.equal(h.find(ids.restart), undefined);
    act(() => h.find(ids.orderBook).props.onLayout({ nativeEvent: { layout: { y: 280 } } }));

    const firstPress = h.find(ids.buyThree).props.onPress;
    act(() => { firstPress(); firstPress(); });
    assert.deepEqual(h.scrolls[0], { y: 280, animated: false });
    assert.match(row(10010).props.accessibilityLabel, /잔량 3주.*체결 대상/);
    assert.equal(h.find(ids.buyThree).props.disabled, true);
    assert.notEqual(flatten(row(10010).props.style).borderColor, 'transparent');
    assert.match(lastPrice(), /10,000원/);
    h.tick(1000);
    assert.match(row(10010).props.accessibilityLabel, /잔량 0주.*3주 체결/);
    assert.match(lastPrice(), /10,010원/);
    h.tick(1300);
    assert.equal(row(10010), undefined);
    assert.match(row(10020).props.accessibilityLabel, /잔량 5주.*최우선 매도호가/);
    assert.ok(h.text().includes('대기 중인 매도호가가 실제 매수 주문에 의해 체결되면서'));
    assert.equal(h.find(ids.buyEight).props.disabled, false);

    const secondPress = h.find(ids.buyEight).props.onPress;
    act(() => { secondPress(); secondPress(); });
    assert.match(row(10020).props.accessibilityLabel, /체결 대상/);
    assert.equal(h.find(ids.buyEight).props.disabled, true);
    h.tick(1000);
    assert.match(row(10020).props.accessibilityLabel, /잔량 0주.*5주 체결/);
    assert.match(lastPrice(), /10,020원/);
    assert.ok(h.text().includes('매수 요청 중 3주가 남았습니다'));
    h.tick(1300);
    assert.equal(row(10020), undefined);
    assert.match(row(10030).props.accessibilityLabel, /잔량 8주.*최우선 매도호가.*체결 대상/);
    h.tick(1200);
    assert.match(row(10030).props.accessibilityLabel, /잔량 5주.*3주 체결/);
    assert.match(lastPrice(), /10,030원/);
    h.tick(1300);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.ok(h.text().includes('핵심 정리'));
    assert.ok(h.text().includes('10,020원에서 5주, 10,030원에서 3주'));
    assert.deepEqual(bids(), initialBids, 'buying only consumes the resting sell orders');

    h.press(ids.restart);
    assert.match(lastPrice(), /10,000원/);
    assert.deepEqual([10030, 10020, 10010].map((price) => row(price).props.accessibilityLabel), initialAsks);
    assert.equal(h.find(ids.buyThree).props.disabled, false);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.equal(h.find(ids.restart), undefined);
    assert.ok(!h.text().includes('실습 1 · 체결 결과'));
    h.tick(10000);
    assert.match(lastPrice(), /10,000원/, 'no stale execution survives reset');
    h.press(ids.buyThree);
    h.tick(1000);
    assert.match(lastPrice(), /10,010원/, 'the initial fixture remains reusable');
  });

  it('pauses while blurred, cancels on unmount, and opens a fresh lesson', (t) => {
    const h = setup(t);
    h.press(ids.buyThree);
    h.focused = false;
    h.update();
    h.tick(10000);
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,000원/);
    h.focused = true;
    h.update();
    h.tick(1000);
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,010원/);
    const clear = t.mock.method(globalThis, 'clearTimeout');
    act(() => h.renderer.unmount());
    assert.ok(clear.mock.callCount() > 0);
    h.tick(10000);
    h.renderer = h.render(React.createElement(h.Screen, h.props));
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,000원/);
    assert.equal(h.find(ids.buyThree).props.disabled, false);
  });

  it('keeps text results and accessible quote labels, with unrestricted large-font layouts', (t) => {
    const h = setup(t);
    assert.equal(h.find(ids.executionStatus).props.accessibilityLiveRegion, 'polite');
    for (const [width, fontScale] of [[320, 1], [320, 2], [320, 3]]) {
      h.dimensions = { width, height: 568, fontScale };
      h.update();
      assert.equal(h.renderer.root.findAllByType('ScrollView').length, 1);
      for (const text of h.renderer.root.findAllByType('Text')) {
        assert.equal(text.props.numberOfLines, undefined);
        assert.notEqual(text.props.allowFontScaling, false);
        assert.equal(flatten(text.props.style).height, undefined);
      }
      const quote = h.find(ids.ask(10010));
      assert.equal(quote.props.accessible, true);
      assert.match(quote.props.accessibilityLabel, /매도, 가격 10,010원, 잔량 3주/);
      assert.match(h.find(ids.bid(9990)).props.accessibilityLabel, /매수, 가격 9,990원, 잔량 4주/);
      assert.ok(quote.findAllByType('View').some((view: any) => flatten(view.props.style).flexDirection === (fontScale === 1 ? 'row' : 'column')));
    }
    act(() => {
      h.find(ids.orderBook).props.onLayout({ nativeEvent: { layout: { y: 280 } } });
      h.find(ids.ask(10010)).props.onLayout({ nativeEvent: { layout: { y: 650 } } });
    });
    h.press(ids.buyThree);
    assert.deepEqual(h.scrolls.at(-1), { y: 930, animated: false }, 'the active quote stays visible with enlarged text');
  });
});
