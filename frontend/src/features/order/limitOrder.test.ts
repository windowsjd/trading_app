import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getLimitQuoteEstimateDisplay,
  getOrderSuccessDisplay,
  isOrderSuccess,
  isSubmittedLimitOrder,
} from './mapper.ts';
import type { CreateOrderDto, OrderQuoteDto } from './api.ts';
import {
  getOrderStatusLabel,
  hasNoExecutionResult,
  isOpenLimitBuyOrder,
} from '../record/openOrder.ts';
import {
  getWalletAvailableAmount,
  getWalletBalanceAmount,
  getWalletReservedAmount,
} from '../wallet/mapper.ts';
import type { WalletsDto } from '../wallet/api.ts';
import { ERROR_CODE } from '../../models/enums/errorCode.ts';
import {
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper.ts';

const submittedLimitResult: CreateOrderDto = {
  order: {
    orderId: 'order-1',
    quoteId: 'quote-1',
    side: 'buy',
    orderType: 'limit',
    status: 'submitted',
    quantity: '3.000000',
    limitPrice: '50000.00000000',
    currencyCode: 'KRW',
    // Nothing filled, so every execution-result column is null server-side.
    grossAmount: null,
    feeAmount: null,
    netAmount: null,
    executedPrice: null,
    executedAt: null,
    reservedAmount: '150150.00000000',
    reservationReleasedAt: null,
    submittedAt: '2026-05-07T00:01:00.000Z',
    asset: { id: 'asset-1', symbol: '005930', name: '삼성전자' },
  },
  execution: {
    state: 'submitted',
    quoteId: 'quote-1',
    submittedAt: '2026-05-07T00:01:00.000Z',
    reservedAmount: '150150.00000000',
    reservationFeeRate: '0.001000',
    duplicate: false,
  },
};

test('isOrderSuccess accepts submitted limit registrations and executed market orders', () => {
  assert.equal(isOrderSuccess(submittedLimitResult), true);
  assert.equal(
    isOrderSuccess({
      order: {},
      execution: { state: 'executed' },
    } as CreateOrderDto),
    true,
  );
  assert.equal(
    isOrderSuccess({
      order: {},
      execution: { state: 'already_executed' },
    } as CreateOrderDto),
    true,
  );
  assert.equal(
    isOrderSuccess({
      order: {},
      execution: { state: 'rejected' },
    } as CreateOrderDto),
    false,
  );
  assert.equal(isOrderSuccess(null), false);
});

test('isSubmittedLimitOrder identifies only submitted registrations', () => {
  assert.equal(isSubmittedLimitOrder(submittedLimitResult), true);
  assert.equal(
    isSubmittedLimitOrder({
      order: {},
      execution: { state: 'executed' },
    } as CreateOrderDto),
    false,
  );
});

test('getOrderSuccessDisplay surfaces reservation fields for submitted limit orders', () => {
  const display = getOrderSuccessDisplay(submittedLimitResult);
  assert.equal(display.isSubmittedLimitOrder, true);
  assert.equal(display.isAlreadyExecuted, false);
  // Server-final decimal strings are only formatted, never recomputed.
  assert.equal(display.limitPrice, '50,000원');
  assert.equal(display.reservedAmount, '150,150');
  assert.equal(display.quantity, '3.000000');
});

test('getOrderSuccessDisplay never shows execution amounts for an unfilled limit order', () => {
  const display = getOrderSuccessDisplay(submittedLimitResult);
  assert.equal(display.grossAmount, '-');
  assert.equal(display.feeAmount, '-');
  assert.equal(display.netAmount, '-');
  assert.equal(display.executedPrice, '-');
  assert.equal(display.executedAt, '-');
  // The reservation IS the order's monetary fact while it is unfilled.
  assert.equal(display.reservedAmount, '150,150');
  assert.equal(display.reservationFeeRate, '0.001000');
});

test('a stale server fill amount cannot leak into a submitted limit display', () => {
  // Defense in depth: even if a server response carried amounts on a
  // submitted order, the mapper must not render them as a fill.
  const display = getOrderSuccessDisplay({
    ...submittedLimitResult,
    order: {
      ...submittedLimitResult.order,
      grossAmount: '150000.00000000',
      netAmount: '150150.00000000',
      executedPrice: '50000.00000000',
    },
    execution: {
      ...submittedLimitResult.execution,
      grossAmount: '150000.00000000',
      executedPrice: '50000.00000000',
      executedAt: '2026-05-07T00:02:00.000Z',
    },
  });

  assert.equal(display.grossAmount, '-');
  assert.equal(display.netAmount, '-');
  assert.equal(display.executedPrice, '-');
  assert.equal(display.executedAt, '-');
});

test('executed market orders keep their real execution amounts', () => {
  const display = getOrderSuccessDisplay({
    order: {
      orderId: 'order-2',
      side: 'buy',
      orderType: 'market',
      status: 'executed',
      quantity: '3.000000',
      currencyCode: 'KRW',
      grossAmount: '150000.00000000',
      feeAmount: '150.00000000',
      netAmount: '150150.00000000',
      asset: { id: 'asset-1', symbol: '005930', name: '삼성전자' },
    },
    execution: {
      state: 'executed',
      executedPrice: '50000.00000000',
      executedAt: '2026-05-07T00:01:30.000Z',
      currencyCode: 'KRW',
    },
  } as CreateOrderDto);

  assert.equal(display.isSubmittedLimitOrder, false);
  assert.equal(display.grossAmount, '150,000');
  assert.equal(display.feeAmount, '150');
  assert.equal(display.netAmount, '150,150');
  assert.equal(display.executedPrice, '50,000원');
  assert.equal(display.executedAt, '2026-05-07T00:01:30.000Z');
});

test('limit quote estimates come from the pinned quote basis and are labeled as estimates', () => {
  const estimate = getLimitQuoteEstimateDisplay({
    quotedGrossAmount: '150000.00000000',
    quotedFeeAmount: '150.00000000',
    quotedFeeRate: '0.001000',
    quotedReservedAmount: '150150.00000000',
    currencyCode: 'KRW',
  } as OrderQuoteDto);

  assert.ok(estimate);
  assert.equal(estimate.estimatedGrossAmount, '150,000');
  assert.equal(estimate.estimatedFeeAmount, '150');
  assert.equal(estimate.quotedFeeRate, '0.001000');
  assert.equal(estimate.reservedAmount, '150,150');
});

test('limit quote estimates are absent for a market quote', () => {
  assert.equal(getLimitQuoteEstimateDisplay(null), null);
  assert.equal(getLimitQuoteEstimateDisplay(undefined), null);
  assert.equal(
    getLimitQuoteEstimateDisplay({ currencyCode: 'KRW' } as OrderQuoteDto),
    null,
  );
});

test('hasNoExecutionResult covers submitted AND canceled limit rows', () => {
  assert.equal(
    hasNoExecutionResult({ orderType: 'limit', status: 'submitted' }),
    true,
  );
  assert.equal(
    hasNoExecutionResult({ orderType: 'limit', status: 'canceled' }),
    true,
  );
  // A market row's amounts keep their historical execution meaning.
  assert.equal(
    hasNoExecutionResult({ orderType: 'market', status: 'executed' }),
    false,
  );
  assert.equal(
    hasNoExecutionResult({ orderType: 'market', status: 'canceled' }),
    false,
  );
  // A future filled limit order does have a result.
  assert.equal(
    hasNoExecutionResult({ orderType: 'limit', status: 'executed' }),
    false,
  );
});

test('open limit buy detection requires limit + buy + submitted', () => {
  assert.equal(
    isOpenLimitBuyOrder({ orderType: 'limit', side: 'buy', status: 'submitted' }),
    true,
  );
  assert.equal(
    isOpenLimitBuyOrder({ orderType: 'limit', side: 'buy', status: 'canceled' }),
    false,
  );
  assert.equal(
    isOpenLimitBuyOrder({ orderType: 'limit', side: 'sell', status: 'submitted' }),
    false,
  );
  assert.equal(
    isOpenLimitBuyOrder({ orderType: 'market', side: 'buy', status: 'submitted' }),
    false,
  );
});

test('order status labels cover 미체결/체결/취소 and pass through unknowns', () => {
  assert.equal(getOrderStatusLabel('submitted'), '미체결');
  assert.equal(getOrderStatusLabel('executed'), '체결');
  assert.equal(getOrderStatusLabel('canceled'), '취소');
  assert.equal(getOrderStatusLabel('rejected'), '거부');
  assert.equal(getOrderStatusLabel('unknown_status'), 'unknown_status');
  assert.equal(getOrderStatusLabel(null), null);
});

const walletsDto = {
  state: 'available',
  wallets: [
    {
      currencyCode: 'KRW',
      balanceAmount: '1000000.00000000',
      reservedAmount: '150150.00000000',
      availableAmount: '849850.00000000',
    },
    {
      currencyCode: 'USD',
      balanceAmount: '500.00000000',
    },
  ],
} as WalletsDto;

test('wallet mappers prefer server availableAmount and fall back for legacy payloads', () => {
  assert.equal(getWalletBalanceAmount(walletsDto, 'KRW'), '1000000.00000000');
  assert.equal(getWalletReservedAmount(walletsDto, 'KRW'), '150150.00000000');
  assert.equal(getWalletAvailableAmount(walletsDto, 'KRW'), '849850.00000000');
  // Legacy wallet payload without reservation fields: available falls back
  // to the balance and reserved defaults to '0'.
  assert.equal(getWalletAvailableAmount(walletsDto, 'USD'), '500.00000000');
  assert.equal(getWalletReservedAmount(walletsDto, 'USD'), '0');
});

test('new limit-order error codes map to dedicated user messages by CODE', () => {
  const generic = getErrorMessageFromCode('SOME_UNKNOWN_CODE');
  for (const code of [
    ERROR_CODE.LIMIT_ORDER_DISABLED,
    ERROR_CODE.LIMIT_BUY_ONLY,
    ERROR_CODE.INVALID_LIMIT_PRICE,
    ERROR_CODE.INSUFFICIENT_AVAILABLE_BALANCE,
    ERROR_CODE.ORDER_RESERVATION_CONFLICT,
    ERROR_CODE.ORDER_RESERVATION_INCONSISTENT,
    ERROR_CODE.ORDER_NOT_CANCELABLE,
    ERROR_CODE.ORDER_CANCEL_CONFLICT,
    ERROR_CODE.ORDER_CANCEL_NOT_SUPPORTED,
  ]) {
    const message = getErrorMessageFromCode(code);
    assert.notEqual(message, generic, `expected dedicated message for ${code}`);
  }
});

test('success copy never promises automatic execution', () => {
  const display = getOrderSuccessDisplay(submittedLimitResult);
  const rendered = JSON.stringify(display);
  assert.ok(!rendered.includes('자동으로 체결'));
  assert.ok(!rendered.includes('자동 체결'));
});

test('existing market error semantics stay intact', () => {
  assert.equal(
    mapOrderErrorCodeToBlockedReason(ERROR_CODE.MARKET_CLOSED),
    'blocked_market_closed',
  );
  assert.equal(
    mapOrderErrorCodeToBlockedReason(ERROR_CODE.INSUFFICIENT_BALANCE),
    'blocked_insufficient_balance',
  );
});
