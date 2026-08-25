import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getFxExecuteSuccessDisplay,
  getFxQuoteDisplay,
  getKnownWalletBalanceAmount,
} from './mapper.ts';
import type { FxExecuteDto, FxQuoteDto } from './api.ts';

describe('status-aware wallet balance display', () => {
  it('keeps an unfetched or absent wallet unknown', () => {
    assert.equal(getKnownWalletBalanceAmount(undefined, 'KRW'), null);
    assert.equal(getKnownWalletBalanceAmount({ wallets: [] }, 'KRW'), null);
  });

  it('distinguishes a real zero from a positive API balance', () => {
    const wallets = {
      wallets: [
        { currencyCode: 'KRW' as const, balanceAmount: '7502495.13164150' },
        { currencyCode: 'USD' as const, balanceAmount: '0.00000000' },
      ],
    };

    assert.equal(
      getKnownWalletBalanceAmount(wallets, 'KRW'),
      '7502495.13164150',
    );
    assert.equal(getKnownWalletBalanceAmount(wallets, 'USD'), '0.00000000');
  });
});

describe('FX decimal display', () => {
  it('trims quote rates and formats display timestamps in KST', () => {
    const quote = {
      quoteId: 'quote-1000',
      fromCurrency: 'USD',
      toCurrency: 'KRW',
      sourceAmount: '10.50000000',
      appliedRate: '1337.50000000',
      grossTargetAmount: '14043.75000000',
      feeRate: '0.001000',
      feeAmount: '14.04375000',
      feeCurrency: 'KRW',
      netTargetAmount: '14029.70625000',
      expiresAt: '2026-08-25T03:45:00.000Z',
      maxChangeBps: '30.0000',
      rateCapturedAt: '2026-08-25T03:44:30.000Z',
      rateEffectiveAt: '2026-08-25T03:44:29.000Z',
      rateSource: {},
    } as FxQuoteDto;

    const display = getFxQuoteDisplay(quote);
    assert.equal(display.quoteId, 'quote-1000');
    assert.equal(display.expiresAt, '2026-08-25 12:45');
    assert.equal(display.rateCapturedAt, '2026-08-25 12:44');
    assert.equal(display.rateEffectiveAt, '2026-08-25 12:44');
    assert.equal(display.sourceAmount, '10.5');
    assert.equal(display.appliedRate, '1337.5');
    assert.equal(display.feeRate, '0.001');
    assert.equal(display.maxChangeBps, '30');
  });

  it('trims execution rates and balances after currency rounding', () => {
    const result = {
      exchangeId: 'exchange-1000',
      executedAt: '2026-08-25T03:44:48.000Z',
      fromCurrency: 'USD',
      toCurrency: 'KRW',
      sourceAmount: '10.50000000',
      grossTargetAmount: '14043.75000000',
      feeRate: '0.001000',
      feeAmount: '14.04375000',
      feeCurrency: 'KRW',
      appliedRate: '1337.50000000',
      quoteId: 'quote-1000',
      quotedRate: '1337.50000000',
      executeRate: '1337.60000000',
      rateChangeBps: '30.5000',
      idempotencyKey: 'idem-1000',
      netTargetAmount: '14029.70625000',
      sourceWalletBalanceAfter: '1000.00000000',
      targetWalletBalanceAfter: '14029.70625000',
      rateSource: {},
    } as FxExecuteDto;

    const display = getFxExecuteSuccessDisplay(result);
    assert.equal(display.exchangeId, 'exchange-1000');
    assert.equal(display.executedAt, '2026-08-25 12:44');
    assert.equal(display.sourceAmount, '10.5');
    assert.equal(display.quotedRate, '1337.5');
    assert.equal(display.executeRate, '1337.6');
    assert.equal(display.rateChangeBps, '30.5');
    assert.equal(display.sourceWalletBalanceAfter, '1,000');
  });
});
