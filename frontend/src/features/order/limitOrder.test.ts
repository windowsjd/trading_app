import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getOrderSuccessDisplay,
  isOrderSuccess,
  isSubmittedLimitOrder,
} from './mapper.ts';
import type { CreateOrderDto } from './api.ts';
import {
  getOrderStatusLabel,
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
    grossAmount: '150000.00000000',
    feeAmount: '150.00000000',
    netAmount: '150150.00000000',
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
