import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

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
const orderScreen = stripComments(read('screens/order/OrderScreen.tsx'));
const orderApi = stripComments(read('features/order/api.ts'));

describe('order completion display contract', () => {
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
      '체결 가격',
      '총 주문 금액',
      '수수료',
      '체결 시각',
      '지정가',
      '예상 주문 금액 (견적 기준)',
      '예상 수수료 (견적 기준)',
      '예상 순수령액 (견적 기준)',
    ]) {
      assert.ok(successSheet.includes(`label="${label}"`), label);
    }
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
    assert.match(orderScreen, /quoteId:\s*quoteData\.quoteId/u);
    assert.match(orderScreen, /isOrderQuoteExpired\(quoteData, quoteNow\)/u);
    assert.match(orderScreen, /getOrderQuoteExpiresInSeconds\(quoteData, quoteNow\)/u);
    assert.match(orderScreen, /if \(quoteExpired\)/u);
    assert.match(orderScreen, /!quoteExpired/u);
    assert.match(orderScreen, /order_requote_required/u);
    assert.match(orderScreen, /idempotencyKey:\s*executeIdempotencyKey/u);

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
    const walletScreen = read('screens/wallet/WalletFxScreen.tsx');

    assert.match(orderScreen, /value=\{quantity\}/u);
    assert.match(orderScreen, /value=\{limitPrice\}/u);
    assert.match(walletScreen, /value=\{amount\}/u);
    assert.doesNotMatch(orderScreen, /value=\{formatDisplayDecimal\(/u);
    assert.doesNotMatch(walletScreen, /value=\{formatDisplayDecimal\(/u);
  });
});
