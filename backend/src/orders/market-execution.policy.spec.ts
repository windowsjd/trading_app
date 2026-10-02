jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { assessExecutionRealism } from './execution-realism.policy';
import { decideMarketExecution } from './market-execution.policy';
import {
  MarketExecutionEvidenceAdapter,
  type MarketExecutionContext,
  type ExecutionEvidenceCandidate,
} from './market-execution-evidence.adapter';

const now = new Date('2026-10-02T01:00:00Z');
const context: MarketExecutionContext = {
  assetId: 'asset',
  assetType: 'crypto',
  market: 'GENERIC',
  priceCurrency: 'USD',
  quantityUnit: 'base_asset',
  side: 'buy',
  executedAt: now,
};
function evidence(
  asks = [
    { price: '3', quantity: '1' },
    { price: '7', quantity: '2' },
  ],
): ExecutionEvidenceCandidate['evidence'] {
  return {
    ...context,
    kind: 'l2',
    effectiveAt: now,
    capturedAt: now,
    asks,
    bids: [],
  };
}
function assess(amount: string, asks?: { price: string; quantity: string }[]) {
  return assessExecutionRealism({
    order: { ...context, side: 'buy', amount },
    evidence: {
      ...evidence(asks),
      validation: { state: 'usable', checkedAt: now },
    },
    quantityScale: 6,
  });
}
class Adapter extends MarketExecutionEvidenceAdapter {
  candidate: ExecutionEvidenceCandidate | null = {
    source: 'generic_l2',
    evidence: evidence(),
  };
  gates = { sourceEligible: true, sessionEligible: true, fresh: true };
  read = jest.fn(() => this.candidate);
  validate = jest.fn(() => this.gates);
}
function code(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException)
      return (e.getResponse() as { error: { code: string } }).error.code;
    throw e;
  }
  throw new Error('Expected rejection');
}
const intent = { quantity: new Prisma.Decimal('10'), amount: null };

describe('amount-aware observed depth', () => {
  it('rejects quantity intents outside the explicitly selected execution precision', () => {
    expect(
      assessExecutionRealism({
        order: { ...context, quantity: '1.00000001' },
        evidence: {
          ...evidence(),
          validation: { state: 'usable', checkedAt: now },
        },
        quantityScale: 6,
      }),
    ).toMatchObject({ state: 'unassessable', reason: 'invalid_order' });
  });
  it('does not auto-cancel a zero monetary remainder after round8 settlement', () => {
    const a = new Adapter();
    a.candidate!.evidence = evidence([
      { price: '0.00000001', quantity: '0.5' },
    ]);
    const result = decideMarketExecution(a, context, {
      ...intent,
      amount: new Prisma.Decimal('0.00000001'),
    });
    expect(result.unspentAmount!.eq(0)).toBe(true);
    expect(result.cancelReason).toBeNull();
  });
  it('solves across prices, rounds aggregate quantity down, and values only consumed levels', () => {
    expect(assess('10')).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '2.00000000',
      observedGrossAmount: '10.00000000',
      simulatedFillPrice: '5.00000000',
      unspentAmount: '0.00000000',
    });
    expect(assess('11')).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '2.14285700',
      observedGrossAmount: '10.99999900',
      unspentAmount: '0.00000100',
    });
  });
  it('distinguishes a depth shortage from budget dust; includes fees nowhere in principal', () => {
    expect(assess('20')).toMatchObject({
      state: 'partial_observed_fill',
      observedFillableQuantity: '3.00000000',
      observedGrossAmount: '17.00000000',
      unspentAmount: '3.00000000',
    });
    expect(assess('1', [{ price: '3', quantity: '1' }])).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '0.33333300',
      observedGrossAmount: '0.99999900',
      unspentAmount: '0.00000100',
    });
    expect(assess('17')).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '3.00000000',
      unspentAmount: '0.00000000',
    });
  });
  it('values rounding dust on the final consumed level, retaining micro levels', () => {
    expect(
      assess('1', [
        { price: '1', quantity: '0.00000051' },
        { price: '2', quantity: '1' },
      ]),
    ).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '0.50000000',
      observedGrossAmount: '0.99999949',
    });
  });
  it('does not spend above the budget over a deterministic price/amount grid', () => {
    for (const price of ['0.00000123', '0.7', '3', '100.1', '999999.99999999'])
      for (const amount of [
        '0.00000001',
        '0.1',
        '1',
        '100',
        '99999.99999999',
      ]) {
        const result = assess(amount, [{ price, quantity: '1000000' }]);
        const gross = new Prisma.Decimal(result.observedGrossAmount!);
        assertDecimalLte(gross, amount);
        expect(gross.add(result.unspentAmount!).eq(amount)).toBe(true);
        expect(
          new Prisma.Decimal(result.observedFillableQuantity!).decimalPlaces(),
        ).toBeLessThanOrEqual(6);
      }
  });
  it('rejects a price-only/unknown-size budget and zero representable quantity', () => {
    const a = new Adapter();
    a.candidate!.evidence = {
      ...context,
      kind: 'price_only',
      effectiveAt: now,
      capturedAt: now,
      referencePrice: '1',
    };
    expect(
      code(() =>
        decideMarketExecution(a, context, {
          ...intent,
          amount: new Prisma.Decimal('1'),
        }),
      ),
    ).toBe('EXECUTION_EVIDENCE_UNAVAILABLE');
    a.candidate!.evidence = evidence([{ price: '100', quantity: '1' }]);
    expect(
      code(() =>
        decideMarketExecution(a, context, {
          ...intent,
          amount: new Prisma.Decimal('0.00000001'),
        }),
      ),
    ).toBe('ORDER_LIQUIDITY_UNAVAILABLE');
  });
});
function assertDecimalLte(value: Prisma.Decimal, ceiling: string) {
  expect(value.lte(ceiling)).toBe(true);
}

describe('trusted composition and revalidation boundary', () => {
  it('does not accept a raw usable verdict over failed source/session/freshness gates', () => {
    for (const gate of [
      'sourceEligible',
      'sessionEligible',
      'fresh',
    ] as const) {
      const a = new Adapter();
      a.gates[gate] = false;
      Object.assign(a.candidate!.evidence, {
        validation: { state: 'usable', checkedAt: now },
      });
      expect(code(() => decideMarketExecution(a, context, intent))).toBe(
        'EXECUTION_EVIDENCE_UNAVAILABLE',
      );
    }
  });
  it('revalidates the exact snapshot and time for every decision without shared liquidity', () => {
    const a = new Adapter(),
      snapshot = JSON.stringify(a.candidate);
    const first = decideMarketExecution(a, context, intent);
    expect(decideMarketExecution(a, context, intent)).toEqual(first);
    expect(JSON.stringify(a.candidate)).toBe(snapshot);
    expect(a.validate).toHaveBeenCalledWith(a.candidate, context);
    expect(a.validate).toHaveBeenCalledTimes(2);
    a.gates.fresh = false;
    expect(
      code(() =>
        decideMarketExecution(
          a,
          { ...context, executedAt: new Date(now.getTime() + 60_000) },
          intent,
        ),
      ),
    ).toBe('EXECUTION_EVIDENCE_UNAVAILABLE');
  });
  it('rejects future evidence and identity/unit/currency mismatches, not just a usable flag', () => {
    for (const override of [
      { assetId: 'other' },
      { priceCurrency: 'KRW' },
      { quantityUnit: 'share' },
      { capturedAt: new Date(now.getTime() + 1) },
    ]) {
      const a = new Adapter();
      Object.assign(a.candidate!.evidence, override);
      expect(code(() => decideMarketExecution(a, context, intent))).toBe(
        'EXECUTION_EVIDENCE_UNAVAILABLE',
      );
    }
  });
  it('rejects a missing adapter snapshot without current-price fallback', () => {
    const a = new Adapter();
    a.candidate = null;
    expect(code(() => decideMarketExecution(a, context, intent))).toBe(
      'EXECUTION_EVIDENCE_UNAVAILABLE',
    );
  });
});
