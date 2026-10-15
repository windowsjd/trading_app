import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import {
  FUTURES_LEVERAGE_PRESETS,
  futuresAmountAtRatio,
  futuresAmountExceeds,
  futuresAmountRatio,
  futuresEntryCapacity,
  futuresEntryEstimate,
  futuresNotional,
  futuresPrice,
  futuresQuantityForAmount,
  isFuturesLeverage,
} from './orderSizing.ts';

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const money = (value: Decimal) => value.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
const ceil = (value: Decimal) => value.toDecimalPlaces(8, Decimal.ROUND_CEIL);

type Side = 'long' | 'short';
type Mode = 'isolated' | 'cross';
type Held = { quantity: string; entry: string; mark: string; leverage: number; direction: Side };

/** backend futures-risk positionRisk() for one position on Mark. */
function risk(p: Held & { isolatedMargin?: Decimal }, fee: Decimal) {
  const raw = new D(p.quantity).mul(p.mark);
  const unrealized = money(new D(p.mark).sub(p.entry).mul(p.quantity).mul(p.direction === 'long' ? 1 : -1));
  const maintenance = ceil(raw.mul('0.005')).add(money(money(raw).mul(fee)));
  const equity = (p.isolatedMargin ?? new D(0)).add(unrealized);
  return { unrealized, initial: ceil(raw.div(p.leverage)), maintenance, buffer: equity.sub(maintenance) };
}

/** The positions endpoint's collateral figures (crossRisk without a new order). */
function account(cash: { balance: string; reserved: string; isolated: string }, cross: Held[], fee: Decimal) {
  const risks = cross.map((p) => risk(p, fee));
  const base = new D(cash.balance).sub(cash.reserved).sub(cash.isolated);
  const equity = base.add(risks.reduce((sum, r) => sum.add(r.unrealized), new D(0)));
  return {
    freeCollateral: equity.sub(risks.reduce((sum, r) => sum.add(r.initial), new D(0))).toFixed(8),
    crossBase: base.toFixed(8),
    liquidationBuffer: equity.sub(risks.reduce((sum, r) => sum.add(r.maintenance), new D(0))).toFixed(8),
  };
}

/**
 * Replica of the server's open guards (backend FuturesService.execute →
 * planFuturesExecution, positionRisk, crossRisk, assertCrossSafe): the fee is
 * paid from cash, Isolated margin is allocated at the fill price, an Isolated
 * position must clear its own maintenance on Mark, and the Cross base, free
 * collateral and (with Cross positions) liquidation buffer must stay safe.
 */
function serverAccepts(order: { quantity: string; price: string; mark: string; leverage: number; mode: Mode; direction: Side; fee: Decimal },
  cash: { balance: string; reserved: string; isolated: string }, cross: Held[]) {
  const raw = new D(order.quantity).mul(order.price);
  const notional = money(raw);
  if (notional.lte(0)) return 'FUTURES_VALUE_TOO_SMALL';
  const feeAmount = money(notional.mul(order.fee));
  const isolatedMargin = order.mode === 'cross' ? new D(0) : ceil(raw.div(order.leverage));
  const next = risk({ quantity: order.quantity, entry: order.price, mark: order.mark, leverage: order.leverage, direction: order.direction, isolatedMargin }, order.fee);
  if (order.mode === 'isolated' && next.buffer.lte(0)) return 'FUTURES_MAINTENANCE_UNSAFE';
  const risks = [...cross.map((p) => risk(p, order.fee)), ...(order.mode === 'cross' ? [next] : [])];
  const base = new D(order.mode === 'cross' ? cash.balance : cash.balance).sub(feeAmount).sub(cash.reserved).sub(cash.isolated).sub(isolatedMargin);
  const equity = base.add(risks.reduce((sum, r) => sum.add(r.unrealized), new D(0)));
  const free = equity.sub(risks.reduce((sum, r) => sum.add(r.initial), new D(0)));
  const buffer = equity.sub(risks.reduce((sum, r) => sum.add(r.maintenance), new D(0)));
  if (base.lt(0)) return 'isolated_allocation_underfunded';
  if (free.lt(0)) return 'insufficient_free_collateral';
  if (risks.length && buffer.lte(0)) return 'maintenance_unsafe';
  return 'accepted';
}

describe('USD amount → contract quantity', () => {
  it('reads the amount as USD notional: 50 is $50 of BTC, never 50 BTC', () => {
    const sized = futuresQuantityForAmount('50', '81738', 'no price');
    assert.deepEqual(sized, { state: 'ready', quantity: '0.00061171' });
    assert.deepEqual(futuresQuantityForAmount('80', '80000', 'no price'), { state: 'ready', quantity: '0.001' });
    assert.deepEqual(futuresQuantityForAmount('127.5', '102', 'no price'), { state: 'ready', quantity: '1.25' });
  });

  it('rounds down to 8 decimals so the order never exceeds the amount', () => {
    assert.deepEqual(futuresQuantityForAmount('100', '3', 'no price'), { state: 'ready', quantity: '33.33333333' });
    const sized = futuresQuantityForAmount('99.99', '0.07', 'no price');
    assert.equal(sized.state, 'ready');
    if (sized.state === 'ready') assert.equal(new D(sized.quantity).mul('0.07').lte('99.99'), true);
  });

  it('never converts without a valid basis price, and refuses empty, malformed and too small amounts', () => {
    assert.deepEqual(futuresQuantityForAmount('', '100', 'no price'), { state: 'empty' });
    for (const price of [null, '', '0', '-1', '1.123456789', 'abc'])
      assert.deepEqual(futuresQuantityForAmount('50', price, '가격 없음'), { state: 'unpriced', message: '가격 없음' });
    for (const amount of ['0', '0.00', '-5', '1.234', 'abc', '1e3', '12345678901234567'])
      assert.equal(futuresQuantityForAmount(amount, '100', 'no price').state, 'invalid', amount);
    assert.equal(futuresQuantityForAmount('0.01', '2000000', 'no price').state, 'tooSmall', '5e-9 rounds down to 0');
  });

  it('prices, notionals and estimates use decimal strings', () => {
    assert.equal(futuresPrice(' 102.5 '), '102.5');
    assert.equal(futuresPrice('0'), null);
    assert.equal(futuresNotional('2', '102'), '204');
    assert.deepEqual(futuresEntryEstimate('80', 10, '0.001'), { margin: '8', fee: '0.08' });
    assert.deepEqual(futuresEntryEstimate('100', 3, null), { margin: '33.33333334', fee: null }, 'margin rounds up like the server');
    assert.equal(futuresEntryEstimate('80', 0, '0.001'), null);
  });
});

describe('ratio capacity (100% of 주문가능)', () => {
  const fee = '0.001';
  it('isolated: collateral ÷ (1/leverage + fee), less headroom — not collateral × leverage', () => {
    const capacity = futuresEntryCapacity({ freeCollateral: '70', crossBase: '70', liquidationBuffer: '70', leverage: 10, feeRate: fee,
      marginMode: 'isolated', direction: 'long', price: '81738', mark: '81738', opening: true });
    assert.equal(capacity.state, 'ready');
    if (capacity.state !== 'ready') return;
    assert.equal(capacity.limit, new D(70).div('0.101').toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed());
    assert.equal(capacity.max, '689.6');
    assert.equal(new D(capacity.max).lt(700), true, 'collateral × leverage would ignore the fee');
  });

  it('unknown collateral, fee or price never yields an amount', () => {
    const known = { freeCollateral: '70', crossBase: '70', liquidationBuffer: '70', leverage: 10, feeRate: fee, marginMode: 'isolated' as const, direction: 'long' as const, price: '100', mark: '100', opening: true };
    assert.deepEqual(futuresEntryCapacity({ ...known, freeCollateral: null }), { state: 'unavailable', reason: 'collateral' });
    assert.deepEqual(futuresEntryCapacity({ ...known, crossBase: undefined }), { state: 'unavailable', reason: 'collateral' });
    assert.deepEqual(futuresEntryCapacity({ ...known, feeRate: null }), { state: 'unavailable', reason: 'fee' });
    assert.deepEqual(futuresEntryCapacity({ ...known, feeRate: '1.5' }), { state: 'unavailable', reason: 'fee' });
    assert.deepEqual(futuresEntryCapacity({ ...known, price: null }), { state: 'unavailable', reason: 'price' });
    assert.deepEqual(futuresEntryCapacity({ ...known, leverage: 101 }), { state: 'unavailable', reason: 'collateral' });
    const empty = futuresEntryCapacity({ ...known, freeCollateral: '-3', crossBase: '0', liquidationBuffer: '0' });
    assert.equal(empty.state === 'ready' && empty.max === '0' && empty.limit === '0', true, 'no collateral, no amount');
  });

  it('immediate fills require valid Mark; deferred estimates are an explicit opt-in', () => {
    const known = { freeCollateral: '70', crossBase: '70', liquidationBuffer: '70', leverage: 10, feeRate: fee,
      marginMode: 'isolated' as const, direction: 'long' as const, price: '100', opening: true };
    for (const mark of [null, undefined, '', '0', '-1', 'abc', '1.123456789'])
      assert.deepEqual(futuresEntryCapacity({ ...known, mark }), { state: 'unavailable', reason: 'mark' });
    assert.equal(futuresEntryCapacity({ ...known, deferred: true }).state, 'ready');
  });

  it('a new isolated position that would start under maintenance on Mark has no capacity', () => {
    const base = { freeCollateral: '70', crossBase: '70', liquidationBuffer: '70', leverage: 100, feeRate: fee, marginMode: 'isolated' as const, price: '100', opening: true };
    assert.deepEqual(futuresEntryCapacity({ ...base, direction: 'long', mark: '99.5' }), { state: 'unavailable', reason: 'maintenance' });
    assert.equal(futuresEntryCapacity({ ...base, direction: 'short', mark: '99.5' }).state, 'ready', 'a Mark gain is fine');
    // The server checks an increase as the whole position, which this cannot see.
    assert.equal(futuresEntryCapacity({ ...base, direction: 'long', mark: '99.5', opening: false }).state, 'ready');
    // It matches the server: 100x long at Last 100, Mark 99.5 is refused, 99.7 passes.
    const cash = { balance: '70', reserved: '0', isolated: '0' };
    assert.equal(serverAccepts({ quantity: '0.1', price: '100', mark: '99.5', leverage: 100, mode: 'isolated', direction: 'long', fee: new D(fee) }, cash, []), 'FUTURES_MAINTENANCE_UNSAFE');
    assert.equal(futuresEntryCapacity({ ...base, direction: 'long', mark: '99.7' }).state, 'ready');
    assert.equal(serverAccepts({ quantity: '0.1', price: '100', mark: '99.7', leverage: 100, mode: 'isolated', direction: 'long', fee: new D(fee) }, cash, []), 'accepted');
  });

  it('100% passes the server guards in normal markets; collateral × leverage does not', () => {
    const cashes = [
      { balance: '70', reserved: '0', isolated: '0' },
      { balance: '10000', reserved: '125.5', isolated: '2' },
      { balance: '1000', reserved: '0', isolated: '400' },
    ];
    const crosses: Held[][] = [
      [],
      [{ quantity: '0.01', entry: '80000', mark: '80500', leverage: 10, direction: 'short' }],
      // Large Cross profit: free collateral exceeds the cash an Isolated margin can use.
      [{ quantity: '0.05', entry: '60000', mark: '81000', leverage: 20, direction: 'long' }],
    ];
    let checked = 0;
    for (const feeRate of ['0', '0.0005', '0.001', '0.002'])
      for (const leverage of [1, 2, 3, 5, 10, 25, 37, 50, 100])
        for (const mode of ['isolated', 'cross'] as const)
          for (const direction of ['long', 'short'] as const)
            for (const markRatio of ['0.999', '1', '1.001'])
              for (const [index, cash] of cashes.entries()) {
                const cross = crosses[index];
                const f = new D(feeRate);
                const price = '81738';
                const mark = new D(price).mul(markRatio).toFixed(2);
                const collateral = account(cash, cross, f);
                const capacity = futuresEntryCapacity({ ...collateral, leverage, feeRate, marginMode: mode, direction, price, mark, opening: true });
                const label = `${feeRate}/${leverage}x/${mode}/${direction}/mark×${markRatio}/account ${index}`;
                if (capacity.state !== 'ready') {
                  assert.equal(capacity.state === 'unavailable' && capacity.reason === 'maintenance' && mode === 'isolated', true, label);
                  continue;
                }
                const sized = futuresQuantityForAmount(capacity.max, price, '-');
                if (sized.state !== 'ready') { assert.equal(capacity.max, '0', label); continue; }
                // Filled at the same Last, and after a 0.3% adverse move of Last and Mark.
                for (const move of ['1', direction === 'long' ? '1.003' : '0.997', direction === 'long' ? '0.997' : '1.003']) {
                  const fill = new D(price).mul(move).toFixed(8), fillMark = new D(mark).mul(move).toFixed(8);
                  assert.equal(serverAccepts({ quantity: sized.quantity, price: fill, mark: fillMark, leverage, mode, direction, fee: f }, cash, cross), 'accepted', `${label} fill×${move}`);
                }
                // Collateral × leverage leaves nothing for the fee (it fits only at a zero
                // fee, or when a Mark gain at entry happens to cover it).
                const naive = new D(collateral.freeCollateral).mul(leverage).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed();
                const naiveSized = futuresQuantityForAmount(naive, price, '-');
                if (naiveSized.state === 'ready' && f.gt(0) && markRatio === '1' && new D(collateral.freeCollateral).gt(1))
                  assert.notEqual(serverAccepts({ quantity: naiveSized.quantity, price, mark, leverage, mode, direction, fee: f }, cash, cross), 'accepted', `${label} naive`);
                checked++;
              }
    assert.equal(checked > 1000, true);
  });

  it('the reported $70 / 1x / 50 BTC order is far above the limit; $50 fits', () => {
    const cash = { balance: '70', reserved: '0', isolated: '0' };
    const collateral = account(cash, [], new D('0.001'));
    const capacity = futuresEntryCapacity({ ...collateral, leverage: 1, feeRate: '0.001', marginMode: 'isolated', direction: 'long', price: '81738', mark: '81738', opening: true });
    assert.equal(capacity.state, 'ready');
    if (capacity.state !== 'ready') return;
    const fiftyBtc = futuresNotional('50', '81738');
    assert.equal(futuresAmountExceeds(fiftyBtc.split('.')[0], capacity.limit), true);
    assert.equal(serverAccepts({ quantity: '50', price: '81738', mark: '81738', leverage: 1, mode: 'isolated', direction: 'long', fee: new D('0.001') }, cash, []), 'isolated_allocation_underfunded');
    const fifty = futuresQuantityForAmount('50', '81738', '-');
    assert.equal(futuresAmountExceeds('50', capacity.limit), false);
    if (fifty.state === 'ready')
      assert.equal(serverAccepts({ quantity: fifty.quantity, price: '81738', mark: '81738', leverage: 1, mode: 'isolated', direction: 'long', fee: new D('0.001') }, cash, []), 'accepted');
  });
});

describe('ratios', () => {
  it('writes cents and reads any amount back as a 0–1 ratio', () => {
    assert.equal(futuresAmountAtRatio('689.6', 0.25), '172.4');
    assert.equal(futuresAmountAtRatio('204', 0.75), '153');
    assert.equal(futuresAmountAtRatio('0.03', 0.5), '0.01');
    assert.equal(futuresAmountAtRatio('100', 1.5), '0');
    assert.equal(futuresAmountRatio('51', '204'), 0.25);
    assert.equal(futuresAmountRatio('300', '204'), 1, 'over the capacity reads 100%');
    assert.equal(futuresAmountRatio('51', null), 0);
    assert.equal(futuresAmountRatio('51', '0'), 0);
    assert.equal(futuresAmountExceeds('689.61', '689.6'), true);
    assert.equal(futuresAmountExceeds('689.6', '689.6'), false);
    assert.equal(futuresAmountExceeds('abc', '1'), false);
    assert.equal(futuresAmountExceeds('5', null), false, 'unknown is never over');
  });

  it('presets stay inside the server leverage range (integers 1–100)', () => {
    assert.deepEqual([...FUTURES_LEVERAGE_PRESETS], [1, 2, 3, 5, 10, 25, 50, 100]);
    assert.equal(FUTURES_LEVERAGE_PRESETS.every(isFuturesLeverage), true);
    for (const value of [0, 101, 2.5, NaN, -1]) assert.equal(isFuturesLeverage(value), false, String(value));
  });
});
