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

function textContent(node: any): string {
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : (node.children ?? []).map(textContent).join('');
}

function assertReadableText(h: any) {
  for (const text of h.renderer.root.findAllByType('Text')) {
    const style = flatten(text.props.style);
    assert.equal(text.props.numberOfLines, undefined);
    assert.equal(text.props.ellipsizeMode, undefined);
    assert.notEqual(text.props.allowFontScaling, false);
    assert.notEqual(text.props.adjustsFontSizeToFit, true);
    assert.equal(style.height, undefined);
    assert.equal(style.maxHeight, undefined);
    if (style.fontSize !== undefined) {
      assert.ok(style.fontSize >= 14, textContent(text));
      assert.ok(style.lineHeight >= style.fontSize * 1.4, textContent(text));
    }
  }
}

function assertLessonContent(h: any) {
  const heading = h.renderer.root.findAllByType('Text').find((node: any) => node.props.children === '호가창 용어');
  const glossary = heading.parent.findAllByType('Text').slice(1).map(textContent);
  assert.deepEqual(glossary.filter((_text: string, index: number) => index % 2 === 0), [
    '호가창 (Order Book)',
    '현재가 (Last Price)',
    '매도호가 (Ask)',
    '매수호가 (Bid)',
    '매도잔량 / 매수잔량',
    '체결 / 체결량 (Trade / Trade Size)',
  ]);
  assert.equal(glossary[3], '가장 최근에 거래가 체결된 가격입니다. 이 가이드에서는 현재가를 최근 체결가격 기준으로 표시합니다. 매수·매도호가가 변하더라도 실제 체결이 발생하지 않으면 현재가는 변하지 않을 수 있습니다.');
  assert.equal(glossary[9], '각 가격에 아직 체결되지 않고 대기 중인 매도·매수 주문의 수량입니다.');
  assert.equal(glossary[11], '매수 주문과 매도 주문이 실제 거래로 성사되는 것을 체결이라 하며, 이때 실제로 거래된 수량을 체결량이라고 합니다.');
  const copy = h.renderer.root.findAllByType('Text').map(textContent).join('\n');
  assert.doesNotMatch(copy, /즉시 체결되는 것으로 단순화|주문 방식의 차이는 별도 가이드|실제 계정이나 시장 데이터와 연결되지|학습 진행도는 저장하지/);
  assert.doesNotMatch(copy, /스프레드|호가단위|매도 1호가|매수 1호가/);
  assert.deepEqual(h.find(ids.lastPrice).findAllByType('Text').map(textContent).filter((text: string) => !/원/.test(text)), ['현재가', '최근 체결가 기준']);
}

function assertPurchaseSummary(h: any, expected: {
  orderQuantity: number;
  orderAmount: number;
  orderAverage: number | null;
  holdingQuantity: number;
  holdingAmount: number;
  holdingAverage: number | null;
}) {
  const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
  for (const [id, label, average, quantity, amount, empty, scope] of [
    [ids.orderAverage, '이번 주문 평균 체결가', expected.orderAverage, expected.orderQuantity, expected.orderAmount, '체결 전', '이번 주문 체결'],
    [ids.holdingAverage, '전체 보유 평단가', expected.holdingAverage, expected.holdingQuantity, expected.holdingAmount, '보유 없음', '보유 수량'],
  ] as const) {
    const node = h.find(id);
    assert.equal(node.props.accessible, true);
    assert.ok(node.props.accessibilityLabel.startsWith(`${label} ${average === null ? empty : won(average)}.`));
    assert.ok(node.props.accessibilityLabel.includes(`${scope} ${quantity}주`));
    assert.ok(node.props.accessibilityLabel.includes(won(amount)));
    if (average === null) {
      assert.ok(!textContent(node).includes('÷'), 'no average is computed before a fill');
    } else {
      assert.ok(textContent(node).includes(`${won(amount)} ÷ ${quantity}주 = ${won(average)}`));
    }
  }
  assert.doesNotMatch(textContent(h.find(ids.purchaseSummary)), /NaN|Infinity/);
}

const noPurchases = {
  orderQuantity: 0, orderAmount: 0, orderAverage: null,
  holdingQuantity: 0, holdingAmount: 0, holdingAverage: null,
};
const firstPurchase = {
  orderQuantity: 3, orderAmount: 30030, orderAverage: 10010,
  holdingQuantity: 3, holdingAmount: 30030, holdingAverage: 10010,
};
const partialSecondPurchase = {
  orderQuantity: 5, orderAmount: 50100, orderAverage: 10020,
  holdingQuantity: 8, holdingAmount: 80130, holdingAverage: 10016.25,
};
const allPurchases = {
  orderQuantity: 8, orderAmount: 80190, orderAverage: 10023.75,
  holdingQuantity: 11, holdingAmount: 110220, holdingAverage: 10020,
};

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
    const lastPrice = () => {
      const label = h.find(ids.lastPrice).props.accessibilityLabel;
      assert.match(label, /^현재가 10,0[0-3]0원\. 최근 체결가 기준$/);
      return label;
    };
    const bids = () => [9990, 9980, 9970].map((price) => h.find(ids.bid(price)).props.accessibilityLabel);
    const initialBids = bids();
    const initialAsks = [10030, 10020, 10010].map((price) => row(price).props.accessibilityLabel);
    assert.match(lastPrice(), /10,000원/);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.equal(h.find(ids.restart), undefined);
    assertLessonContent(h);
    assertPurchaseSummary(h, noPurchases);
    act(() => h.find(ids.orderBook).props.onLayout({ nativeEvent: { layout: { y: 280 } } }));

    const firstPress = h.find(ids.buyThree).props.onPress;
    act(() => { firstPress(); firstPress(); });
    assert.deepEqual(h.scrolls[0], { y: 280, animated: false });
    assert.match(row(10010).props.accessibilityLabel, /잔량 3주.*체결 대상/);
    assert.equal(h.find(ids.buyThree).props.disabled, true);
    assert.notEqual(flatten(row(10010).props.style).borderColor, 'transparent');
    assert.match(lastPrice(), /10,000원/);
    assertPurchaseSummary(h, noPurchases);
    h.tick(1000);
    assert.match(row(10010).props.accessibilityLabel, /잔량 0주.*3주 체결/);
    assert.match(lastPrice(), /10,010원/);
    assertPurchaseSummary(h, firstPurchase);
    h.tick(1300);
    assert.equal(row(10010), undefined);
    assert.match(row(10020).props.accessibilityLabel, /잔량 5주.*최우선 매도호가/);
    assert.ok(h.text().includes('대기 중인 매도호가가 실제 매수 주문에 의해 순차적으로 체결되면서 거래 가격이 형성됩니다.'));
    assert.ok(h.text().includes('가장 최근 체결가격이 10,010원이 되면서 현재가도 10,010원으로 변경됩니다.'));
    assert.equal(h.find(ids.buyEight).props.disabled, false);
    assertPurchaseSummary(h, firstPurchase);

    const secondPress = h.find(ids.buyEight).props.onPress;
    act(() => { secondPress(); secondPress(); });
    assert.match(row(10020).props.accessibilityLabel, /체결 대상/);
    assert.equal(h.find(ids.buyEight).props.disabled, true);
    assertPurchaseSummary(h, { ...firstPurchase, orderQuantity: 0, orderAmount: 0, orderAverage: null });
    h.tick(1000);
    assert.match(row(10020).props.accessibilityLabel, /잔량 0주.*5주 체결/);
    assert.match(lastPrice(), /10,020원/);
    assert.ok(h.text().includes('매수 요청 중 3주가 남았습니다'));
    assertPurchaseSummary(h, partialSecondPurchase);
    h.tick(1300);
    assert.equal(row(10020), undefined);
    assert.match(row(10030).props.accessibilityLabel, /잔량 8주.*최우선 매도호가.*체결 대상/);
    assertPurchaseSummary(h, partialSecondPurchase);
    h.tick(1200);
    assert.match(row(10030).props.accessibilityLabel, /잔량 5주.*3주 체결/);
    assert.match(lastPrice(), /10,030원/);
    assertPurchaseSummary(h, allPurchases);
    h.tick(1300);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.ok(h.text().includes('핵심 정리'));
    assert.ok(h.text().includes('10,020원에서 5주, 10,030원에서 3주'));
    assert.ok(h.text().includes('마지막 체결가격이 10,030원이므로 현재가 역시 10,030원으로 변경됩니다.'));
    const summary = h.renderer.root.findAllByType('Text').find((node: any) => node.props.children === '핵심 정리');
    assert.deepEqual(summary.parent.findAllByType('Text').slice(1, 6).map(textContent), [
      '1. 호가창에는 가격대별로 대기 중인 매수·매도 주문과 잔량이 표시됩니다.',
      '2. 거래는 매수 주문과 매도 주문이 실제로 체결될 때 발생합니다.',
      '3. 현재가는 가장 최근에 거래가 체결된 가격을 기준으로 표시됩니다.',
      '4. 매수 주문이 더 높은 가격대의 매도호가까지 순차적으로 체결되면 현재가가 상승할 수 있습니다.',
      '5. 평균 매입단가는 체결가격과 수량을 함께 반영합니다. 이번 주문의 평균 체결가와 전체 보유 평단가는 계산에 포함하는 범위가 다릅니다.',
    ]);
    assertLessonContent(h);
    assertPurchaseSummary(h, allPurchases);
    const fills = h.find(ids.orderFills).findAllByType('Text').map(textContent);
    assert.deepEqual(fills, [
      '실습 2 · 8주 매수',
      '이번 주문 체결 수량: 8주 / 8주',
      '10,020원 × 5주 = 50,100원',
      '10,030원 × 3주 = 30,090원',
    ]);
    assert.deepEqual(bids(), initialBids, 'buying only consumes the resting sell orders');

    h.press(ids.restart);
    assert.match(lastPrice(), /10,000원/);
    assert.deepEqual([10030, 10020, 10010].map((price) => row(price).props.accessibilityLabel), initialAsks);
    assert.equal(h.find(ids.buyThree).props.disabled, false);
    assert.equal(h.find(ids.buyEight), undefined);
    assert.equal(h.find(ids.restart), undefined);
    assert.ok(!h.text().includes('실습 1 · 체결 결과'));
    assertPurchaseSummary(h, noPurchases);
    h.tick(10000);
    assert.match(lastPrice(), /10,000원/, 'no stale execution survives reset');
    h.press(ids.buyThree);
    h.tick(1000);
    assert.match(lastPrice(), /10,010원/, 'the initial fixture remains reusable');
    assertPurchaseSummary(h, firstPurchase);
  });

  it('pauses while blurred, cancels on unmount, and opens a fresh lesson', (t) => {
    const h = setup(t);
    h.press(ids.buyThree);
    h.focused = false;
    h.update();
    h.tick(10000);
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,000원/);
    assertPurchaseSummary(h, noPurchases);
    h.focused = true;
    h.update();
    h.tick(1000);
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,010원/);
    assertPurchaseSummary(h, firstPurchase);
    h.update();
    assertPurchaseSummary(h, firstPurchase);
    const clear = t.mock.method(globalThis, 'clearTimeout');
    act(() => h.renderer.unmount());
    assert.ok(clear.mock.callCount() > 0);
    h.tick(10000);
    h.renderer = h.render(React.createElement(h.Screen, h.props));
    assert.match(h.find(ids.lastPrice).props.accessibilityLabel, /10,000원/);
    assert.equal(h.find(ids.buyThree).props.disabled, false);
    assertPurchaseSummary(h, noPurchases);
  });

  it('keeps text results and accessible quote labels, with unrestricted large-font layouts', (t) => {
    const h = setup(t);
    assert.equal(h.find(ids.executionStatus).props.accessibilityLiveRegion, 'polite');
    for (const [width, fontScale] of [[280, 1], [320, 1], [320, 1.3], [320, 2], [320, 3]]) {
      h.dimensions = { width, height: 568, fontScale };
      h.update();
      assert.equal(h.renderer.root.findAllByType('ScrollView').length, 1);
      assertReadableText(h);
      const quote = h.find(ids.ask(10010));
      assert.equal(quote.props.accessible, true);
      assert.match(quote.props.accessibilityLabel, /매도, 가격 10,010원, 잔량 3주/);
      assert.match(h.find(ids.bid(9990)).props.accessibilityLabel, /매수, 가격 9,990원, 잔량 4주/);
      assert.ok(quote.findAllByType('View').some((view: any) => flatten(view.props.style).flexDirection === (width / fontScale < 240 ? 'column' : 'row')));
    }
    act(() => {
      h.find(ids.orderBook).props.onLayout({ nativeEvent: { layout: { y: 280 } } });
      h.find(ids.ask(10010)).props.onLayout({ nativeEvent: { layout: { y: 650 } } });
    });
    h.press(ids.buyThree);
    assert.deepEqual(h.scrolls.at(-1), { y: 930, animated: false }, 'the active quote stays visible with enlarged text');
    h.tick(1000);
    assertReadableText(h);
    h.tick(1300);
    h.press(ids.buyEight);
    for (const delay of [1000, 1300, 1200, 1300]) {
      h.tick(delay);
      assertReadableText(h);
    }
    for (const label of ['시장 가격은 어떻게 형성될까요?', '실습 2 · 체결 결과', '처음부터 다시 보기']) {
      const text = h.renderer.root.findAllByType('Text').find((node: any) => node.props.children === label);
      const minimum = label === '시장 가격은 어떻게 형성될까요?' ? 24 : label === '처음부터 다시 보기' ? 16 : 19;
      assert.ok(flatten(text.props.style).fontSize >= minimum);
    }
  });

  it('enlarges home typography without restricting card text or button labels', (t) => {
    const h = setup(t, true);
    assertReadableText(h);
    assert.equal(h.renderer.root.findAllByType('ScrollView').length, 1);
    for (const label of ['기초 가이드', '시장기초', '캔들', '주문방식', '주식특성']) {
      const text = h.renderer.root.findAllByType('Text').find((node: any) => node.props.children === label);
      assert.ok(flatten(text.props.style).fontSize >= 19);
    }
    for (const text of h.renderer.root.findAllByType('Text')) {
      if (textContent(text).endsWith('합니다.') || textContent(text).endsWith('살펴봅니다.')) {
        assert.ok(flatten(text.props.style).fontSize >= 16);
      }
    }
  });
});
