import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

const successSheet = stripComments(
  read('screens/order/OrderSuccessBottomSheet.tsx'),
);
const orderScreen = stripComments(read('screens/order/OrderPanel.tsx'));
const orderApi = stripComments(read('features/order/api.ts'));
const require = createRequire(import.meta.url);
const { interactionHarness } = require('../../../test/interactionTestHarness.cjs');
const { elements } = require('../../../test/ledgerTestHarness.cjs');
const { marketResult } = require('../../../test/browser/marketExecutionFixtures.js');

describe('order completion display contract', () => {
  it('history stays conditional and secondary; home remains primary and 주문으로 돌아가기 stays neutral and only closes', () => {
    const h = interactionHarness();
    // The result itself (no hooks); the default export adds the 공유하기 check around it.
    const Sheet = h.load('src/screens/order/OrderSuccessBottomSheet.tsx', {
      '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
      '../../components/common/BottomSheetBackdrop': { default: 'BottomSheetBackdrop', __esModule: true },
      '../history/TradeShareSheet': { default: 'TradeShareSheet', __esModule: true },
      '../../features/tradingAccount/api': {},
    }).OrderSuccessSheet;
    for (const kind of ['quantity', 'limit', 'full']) for (const historyAvailable of [true, false]) {
      const calls: string[] = [];
      const tree = Sheet({ visible: true, payload: marketResult(kind), onClose: () => calls.push('close'),
        onGoHome: () => calls.push('home'),
        onGoOrderHistory: historyAvailable ? () => calls.push('history') : undefined });
      const [first, home, ...rest] = elements(tree, 'CTAButton');
      assert.equal(rest.length, 0, 'a BUY result has no 공유하기');
      const history = historyAvailable && kind !== 'full';
      assert.equal(first.props.variant, history ? 'secondary' : 'neutral');
      assert.equal(first.props.label, history ? '주문내역 보기' : '주문으로 돌아가기');
      assert.equal(home.props.label, '홈으로 가기');
      assert.equal(home.props.variant, undefined, 'default primary');
      first.props.onPress(); home.props.onPress();
      assert.deepEqual(calls, [history ? 'history' : 'close', 'home']);
    }
  });

  it('공유하기 sits above the two actions with the check’s state, and says why it is unavailable', () => {
    const h = interactionHarness();
    const Sheet = h.load('src/screens/order/OrderSuccessBottomSheet.tsx', {
      '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
      '../../components/common/BottomSheetBackdrop': { default: 'BottomSheetBackdrop', __esModule: true },
      '../history/TradeShareSheet': { default: 'TradeShareSheet', __esModule: true },
      '../../features/tradingAccount/api': {},
    }).OrderSuccessSheet;
    const { ORDER_SHARE_NOTE } = require('../share/orderShare.ts');
    for (const [state, button, note] of [
      ['checking', 'loading', null],
      ['ready', 'enabled', null],
      ['holding', 'disabled', ORDER_SHARE_NOTE.holding],
      ['unverified', 'disabled', ORDER_SHARE_NOTE.unverified],
      ['failed', 'enabled', ORDER_SHARE_NOTE.failed],
    ] as const) {
      let pressed = 0;
      const tree = Sheet({ visible: true, payload: marketResult('full'), onClose() {}, onGoHome() {},
        share: { state, onPress: () => { pressed++; } } });
      const [share, back, home] = elements(tree, 'CTAButton');
      assert.equal(share.props.label, '공유하기', state);
      assert.equal(share.props.variant, 'secondary');
      assert.equal(share.props.state, button, state);
      assert.deepEqual([back.props.label, home.props.label], ['주문으로 돌아가기', '홈으로 가기']);
      const shown = elements(tree, 'Text').find((node: any) => node.props.testID === 'order-success-share-note');
      assert.equal(shown ? shown.props.children : null, note, state);
      share.props.onPress();
      assert.equal(pressed, 1);
    }
  });

  it('hides identifiers, net amount, submission time and FX execution details', () => {
    for (const label of [
      '주문 ID',
      '견적 ID',
      '순금액',
      '제출 시각',
      '견적 환율',
      '실행 환율',
      '환율 변동',
    ]) {
      assert.ok(!successSheet.includes(`label="${label}"`), label);
    }
  });

  it('retains market-fill and limit-registration facts', () => {
    for (const label of [
      '종목',
      '주문 유형',
      '수량',
      '수수료',
      '체결 시각',
      '지정가',
      '예상 주문 금액 (견적 기준)',
      '예상 수수료 (견적 기준)',
      '예상 순수령액 (견적 기준)',
    ]) {
      assert.ok(successSheet.includes(`label="${label}"`), label);
    }
    assert.match(successSheet, /'체결 가격'/u);
    assert.match(successSheet, /'총 주문 금액'/u);
    assert.match(successSheet, /예약금 \(미체결 예약\)/u);
    assert.match(successSheet, /예약 수량 \(미체결 예약\)/u);
    assert.match(successSheet, /이미 처리된 요청입니다/u);
  });
});

describe('order quote display and safety contract', () => {
  it('hides quote identifiers, position deltas, tolerance and expiry timestamp', () => {
    for (const label of [
      '견적 ID',
      '주문 전 포지션',
      '주문 후 예상 포지션',
      '주문 전 사용 가능 수량',
      '주문 후 사용 가능 수량',
      '허용 변동',
      '만료 시각',
    ]) {
      assert.ok(!orderScreen.includes(label), label);
    }
  });

  it('keeps quote execution, expiry, requote and idempotency guards', () => {
    assert.match(orderScreen, /runQuotedAction\(action/u);
    assert.match(orderScreen, /validateOrderQuote\(request.payload, quote\)/u);
    assert.match(orderScreen, /quoteId:\s*quote\.quoteId/u);
    assert.match(orderScreen, /idempotencyKey:\s*key/u);
    assert.match(orderScreen, /isOrderRequoteRequiredCode/u);
    assert.match(orderScreen, /isOrderIdempotencyConflictCode/u);
    assert.doesNotMatch(orderScreen, /TEST_IDS.order.quoteSubmit/u);

    for (const field of [
      'quoteId',
      'expiresAt',
      'maxChangeBps',
      'positionQuantityBefore',
      'estimatedPositionQuantityAfter',
    ]) {
      assert.match(orderApi, new RegExp(`\\b${field}\\b`, 'u'), field);
    }
  });

  it('leaves order and FX raw input state unformatted while typing', () => {
    const walletScreen = read('screens/wallet/WalletFxSheet.tsx');

    assert.match(orderScreen, /value=\{orderInput\}/u);
    assert.match(orderScreen, /value=\{limitPrice\}/u);
    // Both FX fields: the typed one verbatim, the other computed (resolveFxAmounts).
    assert.match(walletScreen, /value=\{amounts\.fields\.KRW\}/u);
    assert.match(walletScreen, /value=\{amounts\.fields\.USD\}/u);
    assert.doesNotMatch(orderScreen, /<TextInput[^>]*value=\{formatDisplayDecimal\(/u);
    assert.doesNotMatch(walletScreen, /<TextInput[^>]*value=\{formatDisplayDecimal\(/u);
  });
});
