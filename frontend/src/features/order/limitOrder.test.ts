import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getLimitQuoteEstimateDisplay,
  getLimitOrderSuccessMessage,
  getOrderQuoteDisplay,
  getOrderQuoteExpiresInSeconds,
  getOrderSuccessDisplay,
  isOrderQuoteExpired,
  isOrderSuccess,
  isSubmittedLimitOrder,
} from './mapper.ts';
import type { CreateOrderDto, OrderQuoteDto } from './api.ts';
import {
  getOrderStatusLabel,
  hasNoExecutionResult,
  isOpenLimitBuyOrder,
  shouldPollSubmittedLimitOrders,
} from '../record/openOrder.ts';
import { captureOrderSuccess, clearOrderSuccess } from './successState.ts';
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

test('order quote expiration stays active independently of the visible timestamp', () => {
  const quote = { expiresAt: '2026-08-25T03:45:00.000Z' };
  const beforeExpiry = new Date('2026-08-25T03:44:30.000Z');
  const atExpiry = new Date('2026-08-25T03:45:00.000Z');

  assert.equal(isOrderQuoteExpired(quote, beforeExpiry), false);
  assert.equal(getOrderQuoteExpiresInSeconds(quote, beforeExpiry), 30);
  assert.equal(isOrderQuoteExpired(quote, atExpiry), true);
  assert.equal(getOrderQuoteExpiresInSeconds(quote, atExpiry), 0);
  assert.equal(isOrderQuoteExpired({ expiresAt: 'invalid' }), true);
});

test('order quote display timestamps use KST without changing expiry calculation', () => {
  const display = getOrderQuoteDisplay({
    expiresAt: '2026-08-25T03:45:00.000Z',
    quoteAt: '2026-08-25T03:44:30.000Z',
  } as OrderQuoteDto);

  assert.equal(display.expiresAt, '2026-08-25 12:45');
  assert.equal(display.quoteAt, '2026-08-25 12:44');
});

test('getOrderSuccessDisplay surfaces reservation fields for submitted limit orders', () => {
  const display = getOrderSuccessDisplay(submittedLimitResult);
  assert.equal(display.isSubmittedLimitOrder, true);
  assert.equal(display.isAlreadyExecuted, false);
  // Hidden from the completion sheet, but still retained in the display model
  // and untouched in the API DTO for audit/requery flows.
  assert.equal(display.orderId, 'order-1');
  assert.equal(display.quoteId, 'quote-1');
  assert.equal(display.assetLabel, '삼성전자');
  assert.equal(display.submittedAt, '2026-05-07 09:01');
  // Server-final decimal strings are only formatted, never recomputed.
  assert.equal(display.limitPrice, '50,000원');
  assert.equal(display.reservedAmount, '150,150');
  assert.equal(display.quantity, '3');
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
  assert.equal(display.reservationFeeRate, '0.001');
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
  assert.equal(display.assetLabel, '삼성전자');
  assert.equal(display.executedAt, '2026-05-07 09:01');
});

test('order asset labels keep non-numeric symbols', () => {
  const display = getOrderSuccessDisplay({
    order: {
      orderId: 'order-aapl',
      asset: { id: 'asset-aapl', name: 'Apple', symbol: 'AAPL' },
    },
    execution: { state: 'executed' },
  } as CreateOrderDto);

  assert.equal(display.assetLabel, 'Apple · AAPL');
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
  assert.equal(estimate.quotedFeeRate, '0.001');
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

test('submitted limit success retains its quote snapshot until the sheet closes', () => {
  const activeQuote = {
    quotedGrossAmount: '150000.00000000',
    quotedFeeAmount: '150.00000000',
    quotedFeeRate: '0.001000',
    quotedReservedAmount: '150150.00000000',
    currencyCode: 'KRW',
  } as OrderQuoteDto;
  const success = captureOrderSuccess(submittedLimitResult, activeQuote);

  // OrderScreen clears its active quote after create, but the success state
  // keeps the exact quote-time estimate used by the bottom sheet.
  const clearedActiveQuote: OrderQuoteDto | null = null;
  assert.equal(clearedActiveQuote, null);
  assert.equal(success.data, submittedLimitResult);
  assert.equal(
    getLimitQuoteEstimateDisplay(success.quote)?.estimatedGrossAmount,
    '150,000',
  );
  assert.equal(
    getLimitQuoteEstimateDisplay(success.quote)?.estimatedFeeAmount,
    '150',
  );

  assert.deepEqual(clearOrderSuccess(), { data: null, quote: null });
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

test('open limit detection covers submitted buys and sells only', () => {
  assert.equal(
    isOpenLimitBuyOrder({
      orderType: 'limit',
      side: 'buy',
      status: 'submitted',
    }),
    true,
  );
  assert.equal(
    isOpenLimitBuyOrder({
      orderType: 'limit',
      side: 'buy',
      status: 'canceled',
    }),
    false,
  );
  assert.equal(
    isOpenLimitBuyOrder({
      orderType: 'limit',
      side: 'sell',
      status: 'submitted',
    }),
    true,
  );
  assert.equal(
    isOpenLimitBuyOrder({
      orderType: 'market',
      side: 'buy',
      status: 'submitted',
    }),
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

test('success copy follows the server execution policy without promising exchange liquidity', () => {
  const enabled = getLimitOrderSuccessMessage({
    autoExecutionEnabled: true,
    mode: 'scheduler_snapshot_candle',
    triggerType: 'provider_snapshot_or_closed_candle',
    fullFillOnly: true,
  });
  assert.match(enabled, /전량 자동 체결/);
  assert.match(enabled, /유동성과 거래량은 반영하지 않습니다/);
  assert.doesNotMatch(enabled, /무조건/);

  const disabled = getLimitOrderSuccessMessage({
    autoExecutionEnabled: false,
    mode: 'reservation_only',
    triggerType: null,
    fullFillOnly: true,
  });
  assert.match(disabled, /미체결 상태로 등록/);
  assert.doesNotMatch(disabled, /자동 체결/);

  const sellEnabled = getLimitOrderSuccessMessage(
    {
      autoExecutionEnabled: true,
      mode: 'scheduler_snapshot_candle',
      triggerType: 'provider_snapshot_or_closed_candle',
      fullFillOnly: true,
    },
    'sell',
  );
  assert.match(sellEnabled, /지정가 이상/);
});

test('submitted limit sell displays reserved quantity and expected proceeds', () => {
  const sellResult: CreateOrderDto = {
    order: {
      orderId: 'sell-order-1',
      side: 'sell',
      orderType: 'limit',
      status: 'submitted',
      quantity: '2.000000',
      limitPrice: '60000.00000000',
      currencyCode: 'KRW',
      reservedAmount: null,
      reservedQuantity: '2.000000',
    },
    execution: {
      state: 'submitted',
      side: 'sell',
      reservedAmount: null,
      reservedQuantity: '2.000000',
    },
  };
  const display = getOrderSuccessDisplay(sellResult);
  assert.equal(display.side, 'sell');
  assert.equal(display.reservedAmount, '-');
  assert.equal(display.reservedQuantity, '2');

  const estimate = getLimitQuoteEstimateDisplay({
    quotedGrossAmount: '120000.00000000',
    quotedFeeAmount: '120.00000000',
    quotedNetAmount: '119880.00000000',
    reservedQuantity: '2.000000',
    currencyCode: 'KRW',
  });
  assert.ok(estimate);
  assert.equal(estimate.expectedNetAmount, '119,880');
  assert.equal(estimate.reservedQuantity, '2');
});

test('submitted-limit polling requires foreground, focus, and an open order', () => {
  const open = [{ orderType: 'limit', side: 'buy', status: 'submitted' }];
  assert.equal(
    shouldPollSubmittedLimitOrders({
      isFocused: true,
      appState: 'active',
      items: open,
    }),
    true,
  );
  assert.equal(
    shouldPollSubmittedLimitOrders({
      isFocused: false,
      appState: 'active',
      items: open,
    }),
    false,
  );
  assert.equal(
    shouldPollSubmittedLimitOrders({
      isFocused: true,
      appState: 'background',
      items: open,
    }),
    false,
  );
  assert.equal(
    shouldPollSubmittedLimitOrders({
      isFocused: true,
      appState: 'active',
      items: [{ orderType: 'limit', side: 'buy', status: 'executed' }],
    }),
    false,
  );
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


test('limit success copy is server-driven: reservation-only vs scheduler auto-execution', () => {
  const reservationOnly = getLimitOrderSuccessMessage({
    autoExecutionEnabled: false,
    mode: 'reservation_only',
    triggerType: null,
    fullFillOnly: true,
  });
  assert.match(reservationOnly, /미체결 상태로 등록/);
  assert.ok(!reservationOnly.includes('자동 체결'));

  const auto = getLimitOrderSuccessMessage({
    autoExecutionEnabled: true,
    mode: 'scheduler_snapshot_candle',
    triggerType: 'provider_snapshot_or_closed_candle',
    fullFillOnly: true,
  });
  assert.match(auto, /체결가격이 지정가 이하가 되면/);
  assert.match(auto, /주문장 유동성과 거래량은 반영하지 않습니다/);
  // Path B fills off a closed 5m candle, so the copy must not claim real-time.
  assert.ok(!auto.includes('실시간'));
});
