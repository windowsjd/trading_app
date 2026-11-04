import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import { fxPreview, fxSourceForTarget } from '../tradingAccount/indicativePreview.ts';
import {
  FX_AMOUNT_INVALID,
  FX_AMOUNT_REQUIRED,
  fxSourceAtRatio,
  fxSourceShare,
  plainAmount,
  resolveFxAmounts,
  spendableDisplayAmount,
} from './fxAmountEntry.ts';

const now = Date.now();
const rate = (value: string) => ({
  state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: value,
  validUntil: new Date(now + 60_000).toISOString(),
}) as any;
// The server's proceeds before its final 8-place rounding, exactly.
const X = Decimal.clone({ precision: 60 });
const exactProceeds = (source: string, from: 'KRW' | 'USD', rateValue: string, fee: string) => {
  const gross = from === 'KRW' ? new X(source).div(rateValue) : new X(source).mul(rateValue);
  return gross.sub(gross.mul(fee));
};

describe('amount to receive → amount to pay', () => {
  it('pays the fewest 8-place units whose proceeds reach the target, and the preview receives it', () => {
    // Deterministic pseudo-random cases across both directions, fee policies and rates.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let index = 0; index < 400; index += 1) {
      const from = index % 2 ? 'KRW' : 'USD';
      const rateValue = (1100 + next() * 500).toFixed(8);
      const fee = ['0', '0.001', '0.0025', '0.002500', '0.123456'][index % 5];
      const target = from === 'KRW'
        ? (next() * 10_000).toFixed(1 + (index % 8))
        : (next() * 50_000_000).toFixed(index % 9);
      if (Number(target) <= 0) continue;
      const source = fxSourceForTarget({ target, fromCurrency: from, rate: rate(rateValue), feeRate: fee, now });
      assert.ok(source && /^\d+\.\d{8}$/u.test(source), `${target} ${from} ${rateValue} ${fee}: ${source}`);
      // Never short: the server's formula and rounding receive at least the target.
      const preview = fxPreview({ amount: source, fromCurrency: from, rate: rate(rateValue), feeRate: fee, now });
      assert.equal(new Decimal(preview!.netTargetAmount).gte(target), true, `${source} → ${preview!.netTargetAmount} < ${target}`);
      assert.equal(exactProceeds(source, from, rateValue, fee).gte(target), true);
      // Never more than needed: one unit less no longer reaches it exactly.
      const less = new X(source).sub('0.00000001');
      if (less.gt(0)) assert.equal(exactProceeds(less.toFixed(8), from, rateValue, fee).lt(target), true, `${source} is not the fewest`);
    }
  });

  it('has no amount without a positive 8-place target, a current rate, a valid fee or a reachable target', () => {
    const base = { fromCurrency: 'KRW' as const, rate: rate('1350'), feeRate: '0.001', now };
    for (const target of ['', '0', '-1', '1e3', '1,000', '1.000000001', 'NaN'])
      assert.equal(fxSourceForTarget({ ...base, target }), null, target);
    assert.equal(fxSourceForTarget({ ...base, target: '1', rate: { ...rate('1350'), validUntil: new Date(now - 1).toISOString() } }), null, 'expired rate');
    assert.equal(fxSourceForTarget({ ...base, target: '1', rate: null }), null, 'no rate');
    assert.equal(fxSourceForTarget({ ...base, target: '1', feeRate: null }), null, 'no fee');
    assert.equal(fxSourceForTarget({ ...base, target: '1', feeRate: '1' }), null, 'a 100% fee never reaches it');
    // The smallest target still gets a payable amount that reaches it.
    assert.equal(fxSourceForTarget({ ...base, target: '0.00000001' }), '0.00001352');
  });
});

describe('the two FX fields', () => {
  const base = { rate: rate('1350'), feeRate: '0.001', now };

  it('typed in the paying wallet: the amount to pay as typed, the other field its estimated proceeds', () => {
    const krw = resolveFxAmounts({ ...base, fromCurrency: 'KRW', entry: { currency: 'KRW', text: '100000' } });
    assert.deepEqual([krw.basis, krw.sourceAmount, krw.fields.KRW, krw.fields.USD], ['source', '100000', '100000', '74']);
    assert.equal(krw.preview?.netTargetAmount, '74.00000000');
    const usd = resolveFxAmounts({ ...base, fromCurrency: 'USD', entry: { currency: 'USD', text: ' 10.5 ' } });
    // The typed text is never rewritten (cursor and spaces stay); the request trims it.
    assert.deepEqual([usd.basis, usd.sourceAmount, usd.fields.USD, usd.fields.KRW], ['source', '10.5', ' 10.5 ', '14160.825']);
  });

  it('typed in the receiving wallet: the amount to receive as typed, the other field what it costs', () => {
    const toUsd = resolveFxAmounts({ ...base, fromCurrency: 'KRW', entry: { currency: 'USD', text: '100' } });
    assert.deepEqual([toUsd.basis, toUsd.fields.USD, toUsd.fields.KRW, toUsd.sourceAmount], ['target', '100', '135135.13513514', '135135.13513514']);
    assert.equal(new Decimal(toUsd.preview!.netTargetAmount).gte(100), true);
    const toKrw = resolveFxAmounts({ ...base, fromCurrency: 'USD', entry: { currency: 'KRW', text: '100000' } });
    assert.deepEqual([toKrw.basis, toKrw.fields.KRW, toKrw.fields.USD, toKrw.sourceAmount], ['target', '100000', '74.1482223', '74.1482223']);
    assert.equal(new Decimal(toKrw.preview!.netTargetAmount).gte(100000), true);
  });

  it('a direction change keeps the typed field and recomputes the other one for the new direction', () => {
    const entry = { currency: 'KRW' as const, text: '100000' };
    const paying = resolveFxAmounts({ ...base, fromCurrency: 'KRW', entry });
    const receiving = resolveFxAmounts({ ...base, fromCurrency: 'USD', entry });
    assert.deepEqual([paying.basis, receiving.basis], ['source', 'target']);
    assert.equal(receiving.fields.KRW, '100000');
    assert.notEqual(receiving.fields.USD, paying.fields.USD);
  });

  it('empty, malformed, too precise or unconvertible amounts have no amount to pay', () => {
    for (const [text, reason] of [['', FX_AMOUNT_REQUIRED], ['  ', FX_AMOUNT_REQUIRED], ['0', FX_AMOUNT_INVALID], ['-1', FX_AMOUNT_INVALID],
      ['1e3', FX_AMOUNT_INVALID], ['1,000', FX_AMOUNT_INVALID], ['1.000000001', FX_AMOUNT_INVALID]] as const) {
      for (const currency of ['KRW', 'USD'] as const) {
        const result = resolveFxAmounts({ ...base, fromCurrency: 'KRW', entry: { currency, text } });
        assert.deepEqual([result.invalidReason, result.sourceAmount, result.preview], [reason, null, null], `${currency} ${text}`);
        assert.equal(result.fields[currency], text, 'never rewritten');
        assert.equal(result.fields[currency === 'KRW' ? 'USD' : 'KRW'], '');
      }
    }
    // A valid amount without a current rate: nothing computed, nothing to execute.
    const noRate = resolveFxAmounts({ ...base, rate: null, fromCurrency: 'KRW', entry: { currency: 'USD', text: '100' } });
    assert.deepEqual([noRate.invalidReason, noRate.sourceAmount, noRate.fields.KRW], [null, null, '']);
  });

  it('shows decimal strings the way an input does', () => {
    assert.deepEqual(['100000.00000000', '74.14822230', '100', '0.10000000', '1000'].map(plainAmount), ['100000', '74.1482223', '100', '0.1', '1000']);
  });
});

describe('the ratio bar', () => {
  it('sizes 0/25/50/75/100% of the spendable amount, floored to 8 places; 100% is exactly all of it', () => {
    assert.deepEqual([0, 0.25, 0.5, 0.75, 1].map((ratio) => fxSourceAtRatio('800000.5', ratio)),
      ['0', '200000.125', '400000.25', '600000.375', '800000.5']);
    assert.deepEqual([0.25, 0.37, 1].map((ratio) => fxSourceAtRatio('0.00000003', ratio)), ['0', '0.00000001', '0.00000003']);
    // 16 integer digits keep every place (no float rounding).
    assert.equal(fxSourceAtRatio('9999999999999999.99999999', 1), '9999999999999999.99999999');
    for (const ratio of [0.01, 0.33, 0.99, 1]) {
      assert.equal(new Decimal(fxSourceAtRatio('1234567.89012345', ratio)!).lte('1234567.89012345'), true, String(ratio));
    }
    for (const [available, ratio] of [[null, 0.5], ['-1', 0.5], ['x', 0.5], ['100', -0.1], ['100', 1.1], ['100', Number.NaN]] as const)
      assert.equal(fxSourceAtRatio(available, ratio), null, `${available} ${ratio}`);
  });

  it('follows a typed amount back as its share of the spendable amount', () => {
    assert.equal(fxSourceShare('200000.125', '800000.5'), 0.25);
    assert.equal(fxSourceShare('900000', '800000.5'), 1, 'over the balance stays at the end');
    for (const [amount, available] of [[null, '100'], ['10', null], ['10', '0'], ['0', '100'], ['x', '100']] as const)
      assert.equal(fxSourceShare(amount, available), 0);
  });

  it('shows the spendable amount rounded down at the display unit', () => {
    assert.deepEqual([spendableDisplayAmount('1000000.99', 'KRW'), spendableDisplayAmount('100.999', 'USD'),
      spendableDisplayAmount('0.00000001', 'USD'), spendableDisplayAmount(null, 'KRW'), spendableDisplayAmount('-1', 'KRW')],
    ['1000000', '100.99', '0.00', null, null]);
  });
});
