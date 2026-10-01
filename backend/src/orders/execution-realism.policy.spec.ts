jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});

import { Prisma } from '../generated/prisma/client';
import { assessExecutionRealism } from './execution-realism.policy';
import type {
  ExecutionMarketEvidence,
  ExecutionRealismOrder,
} from './execution-realism.types';

const context = {
  assetId: 'generic-asset',
  priceCurrency: 'KRW',
  quantityUnit: 'share',
  effectiveAt: new Date('2026-09-29T01:00:00.000Z'),
  capturedAt: new Date('2026-09-29T01:00:00.100Z'),
  validation: {
    state: 'usable' as const,
    checkedAt: new Date('2026-09-29T01:00:00.200Z'),
  },
};

function order(
  overrides: Partial<ExecutionRealismOrder> = {},
): ExecutionRealismOrder {
  return {
    assetId: context.assetId,
    priceCurrency: context.priceCurrency,
    quantityUnit: context.quantityUnit,
    side: 'buy',
    quantity: '250',
    ...overrides,
  };
}

function l2(): ExecutionMarketEvidence & { kind: 'l2' } {
  return {
    ...context,
    kind: 'l2',
    asks: [
      { price: '102', quantity: '70' },
      { price: '100', quantity: '100' },
      { price: '101', quantity: '100' },
    ],
    bids: [
      { price: '98', quantity: '100' },
      { price: '99', quantity: '100' },
      { price: '97', quantity: '70' },
    ],
  };
}

function top(): ExecutionMarketEvidence & { kind: 'top_of_book' } {
  return {
    ...context,
    kind: 'top_of_book',
    ask: { price: '100', quantity: '100' },
    bid: { price: '99', quantity: '50' },
  };
}

describe('Execution realism assessment (no Provider or production caller)', () => {
  it('walks ascending asks for BUY, partially consumes the last level and ignores bid liquidity', () => {
    expect(assessExecutionRealism({ order: order(), evidence: l2() })).toEqual({
      order: order(),
      evidenceKind: 'l2',
      evidenceTimestamps: {
        effectiveAt: '2026-09-29T01:00:00.000Z',
        capturedAt: '2026-09-29T01:00:00.100Z',
        checkedAt: '2026-09-29T01:00:00.200Z',
      },
      state: 'full_observed_fill',
      reason: null,
      invalidField: null,
      referencePrice: '100.00000000',
      referencePriceBasis: 'ask',
      observedFillableQuantity: '250.00000000',
      simulatedFillPrice: '100.80000000',
      adversePriceImpactBps: '80.00000000',
      levelsConsumed: 3,
    });
  });

  it('walks descending bids for SELL, with a positive adverse impact and no ask consumption', () => {
    expect(
      assessExecutionRealism({
        order: order({ side: 'sell' }),
        evidence: l2(),
      }),
    ).toMatchObject({
      state: 'full_observed_fill',
      referencePrice: '99.00000000',
      referencePriceBasis: 'bid',
      observedFillableQuantity: '250.00000000',
      simulatedFillPrice: '98.20000000',
      adversePriceImpactBps: '80.80808081',
      levelsConsumed: 3,
    });
  });

  it.each(['buy', 'sell'] as const)(
    'never invents depth beyond the observed %s side',
    (side) => {
      const evidence = l2();
      evidence.asks = [
        { price: '100', quantity: '100' },
        { price: '101', quantity: '50' },
      ];
      evidence.bids = [
        { price: '99', quantity: '100' },
        { price: '98', quantity: '50' },
      ];
      expect(
        assessExecutionRealism({ order: order({ side }), evidence }),
      ).toMatchObject({
        state: 'partial_observed_fill',
        reason: 'observed_depth_exhausted',
        observedFillableQuantity: '150.00000000',
        simulatedFillPrice: side === 'buy' ? '100.33333333' : '98.66666667',
        levelsConsumed: 2,
      });
    },
  );

  it('recognizes an exact depth match without requiring unseen levels', () => {
    const evidence = l2();
    evidence.asks = [
      { price: '100', quantity: '100' },
      { price: '101', quantity: '100' },
      { price: '102', quantity: '50' },
    ];
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      state: 'full_observed_fill',
      reason: null,
      observedFillableQuantity: '250.00000000',
      levelsConsumed: 3,
    });
  });

  it('stops within the best level when the requested quantity is smaller', () => {
    expect(
      assessExecutionRealism({
        order: order({ quantity: '1' }),
        evidence: l2(),
      }),
    ).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '1.00000000',
      simulatedFillPrice: '100.00000000',
      adversePriceImpactBps: '0.00000000',
      levelsConsumed: 1,
    });
  });

  it.each(['buy', 'sell'] as const)(
    'distinguishes an empty observed %s side from missing evidence',
    (side) => {
      const evidence = l2();
      if (side === 'buy') evidence.asks = [];
      else evidence.bids = [];
      expect(
        assessExecutionRealism({ order: order({ side }), evidence }),
      ).toMatchObject({
        state: 'no_observed_fill',
        reason: 'no_observed_liquidity',
        observedFillableQuantity: '0.00000000',
        referencePrice: null,
        simulatedFillPrice: null,
        adversePriceImpactBps: null,
        levelsConsumed: 0,
      });
    },
  );

  it.each([
    ['buy', '101', '100.50000000'],
    ['sell', '98', '98.50000000'],
  ] as const)(
    'respects a hypothetical %s limit for each level, not just the weighted price',
    (side, limitPrice, weighted) => {
      expect(
        assessExecutionRealism({
          order: order({ side, limitPrice }),
          evidence: l2(),
        }),
      ).toMatchObject({
        state: 'partial_observed_fill',
        reason: 'limit_price_boundary',
        observedFillableQuantity: '200.00000000',
        simulatedFillPrice: weighted,
        levelsConsumed: 2,
      });
    },
  );

  it.each([
    ['buy', '99'],
    ['sell', '100'],
  ] as const)(
    'returns zero observable quantity when %s best price is outside the limit',
    (side, limitPrice) => {
      expect(
        assessExecutionRealism({
          order: order({ side, limitPrice }),
          evidence: l2(),
        }),
      ).toMatchObject({
        state: 'no_observed_fill',
        reason: 'limit_price_boundary',
        observedFillableQuantity: '0.00000000',
        simulatedFillPrice: null,
        levelsConsumed: 0,
      });
    },
  );

  it.each([
    ['buy', '100.00000000', 'ask'],
    ['sell', '99.00000000', 'bid'],
  ] as const)(
    'uses only the %s top quote and its size',
    (side, price, basis) => {
      expect(
        assessExecutionRealism({
          order: order({ side, quantity: '50' }),
          evidence: top(),
        }),
      ).toMatchObject({
        evidenceKind: 'top_of_book',
        state: 'full_observed_fill',
        referencePrice: price,
        referencePriceBasis: basis,
        simulatedFillPrice: price,
        observedFillableQuantity: '50.00000000',
        adversePriceImpactBps: '0.00000000',
        levelsConsumed: 1,
      });
    },
  );

  it.each([
    ['buy', '100.00000000'],
    ['sell', '50.00000000'],
  ] as const)(
    'caps %s liquidity at the observed top size',
    (side, quantity) => {
      expect(
        assessExecutionRealism({ order: order({ side }), evidence: top() }),
      ).toMatchObject({
        state: 'partial_observed_fill',
        reason: 'observed_size_exceeded',
        observedFillableQuantity: quantity,
        levelsConsumed: 1,
      });
    },
  );

  it.each(['buy', 'sell'] as const)(
    'keeps a %s price reference without assuming quantity when size is missing',
    (side) => {
      const evidence = top();
      evidence.ask = { price: '100' };
      evidence.bid = { price: '99' };
      expect(
        assessExecutionRealism({ order: order({ side }), evidence }),
      ).toMatchObject({
        state: 'unassessable',
        reason: 'size_missing',
        referencePrice: side === 'buy' ? '100.00000000' : '99.00000000',
        referencePriceBasis: side === 'buy' ? 'ask' : 'bid',
        observedFillableQuantity: null,
        simulatedFillPrice: null,
        adversePriceImpactBps: null,
        levelsConsumed: 0,
      });
    },
  );

  it('never uses the opposite top quote when the required side is missing', () => {
    const evidence = top();
    evidence.ask = null;
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      state: 'unassessable',
      reason: 'side_missing',
      referencePrice: null,
      observedFillableQuantity: null,
    });
  });

  it('can observe zero within the limit from a best quote even without its size', () => {
    const evidence = top();
    evidence.ask = { price: '100' };
    expect(
      assessExecutionRealism({ order: order({ limitPrice: '99' }), evidence }),
    ).toMatchObject({
      state: 'no_observed_fill',
      reason: 'limit_price_boundary',
      referencePrice: '100.00000000',
      observedFillableQuantity: '0.00000000',
      simulatedFillPrice: null,
    });
  });

  it.each(['buy', 'sell'] as const)(
    'does not turn a last/reference price and historical volume into %s depth or spread',
    (side) => {
      const evidence: ExecutionMarketEvidence = {
        ...context,
        kind: 'price_only',
        referencePrice: '100',
        volume: {
          quantity: '1000000',
          from: new Date('2026-09-29T00:59:00Z'),
          to: context.effectiveAt,
        },
      };
      expect(
        assessExecutionRealism({ order: order({ side }), evidence }),
      ).toMatchObject({
        state: 'unassessable',
        reason: 'liquidity_model_required',
        referencePrice: '100.00000000',
        referencePriceBasis: 'reference',
        observedFillableQuantity: null,
        simulatedFillPrice: null,
        adversePriceImpactBps: null,
        levelsConsumed: 0,
      });
    },
  );

  it('expresses price-only and volume-only limitations without any invented fill', () => {
    const priceOnly: ExecutionMarketEvidence = {
      ...context,
      kind: 'price_only',
      referencePrice: '100',
    };
    expect(
      assessExecutionRealism({ order: order(), evidence: priceOnly }),
    ).toMatchObject({
      reason: 'liquidity_model_required',
      referencePriceBasis: 'reference',
      observedFillableQuantity: null,
    });
    const volumeOnly: ExecutionMarketEvidence = {
      ...priceOnly,
      referencePrice: null,
      volume: {
        quantity: '0',
        from: new Date('2026-09-29T00:59:00Z'),
        to: context.effectiveAt,
      },
    };
    expect(
      assessExecutionRealism({ order: order(), evidence: volumeOnly }),
    ).toMatchObject({
      reason: 'liquidity_model_required',
      referencePrice: null,
      referencePriceBasis: null,
      observedFillableQuantity: null,
    });
  });

  it('distinguishes missing evidence from known zero observed liquidity', () => {
    expect(
      assessExecutionRealism({ order: order(), evidence: null }),
    ).toMatchObject({
      state: 'unassessable',
      reason: 'evidence_missing',
      evidenceKind: 'missing',
      evidenceTimestamps: null,
      observedFillableQuantity: null,
    });
  });

  it('distinguishes an empty price/volume envelope from a missing calibrated model', () => {
    const evidence: ExecutionMarketEvidence = {
      ...context,
      kind: 'price_only',
      referencePrice: null,
    };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      state: 'unassessable',
      reason: 'evidence_missing',
      referencePrice: null,
      observedFillableQuantity: null,
    });
  });

  it.each(['stale', 'ineligible', 'unchecked'] as const)(
    'propagates external %s validation without a fallback or new freshness rule',
    (state) => {
      for (const evidence of [
        l2(),
        top(),
        { ...context, kind: 'price_only' as const, referencePrice: '100' },
      ]) {
        evidence.validation = { ...context.validation, state };
        expect(
          assessExecutionRealism({ order: order(), evidence }),
        ).toMatchObject({
          state: 'unassessable',
          reason: `evidence_${state}`,
          referencePrice: null,
          observedFillableQuantity: null,
          simulatedFillPrice: null,
          levelsConsumed: 0,
          evidenceTimestamps: {
            checkedAt: context.validation.checkedAt.toISOString(),
          },
        });
      }
    },
  );

  it('assesses at the explicit validation instant, permits unknown market time, and reads no live clock', () => {
    const evidence = { ...l2(), effectiveAt: null };
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('live clock read');
    });
    try {
      expect(
        assessExecutionRealism({ order: order(), evidence }),
      ).toMatchObject({
        state: 'full_observed_fill',
        evidenceTimestamps: { effectiveAt: null },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    '0',
    '-1',
    'not-a-decimal',
    'NaN',
    'Infinity',
    '1e2',
    '0x10',
    '0.000000001',
    '10000000000000000',
    100 as unknown as string,
  ])(
    'rejects corrupt/out-of-range price %s, including unused levels',
    (price) => {
      const evidence = l2();
      evidence.asks = [...evidence.asks, { price, quantity: '1' }];
      expect(
        assessExecutionRealism({ order: order({ quantity: '1' }), evidence }),
      ).toMatchObject({
        state: 'unassessable',
        reason: 'invalid_evidence',
        invalidField: 'evidence.asks[3].price',
        referencePrice: null,
        observedFillableQuantity: null,
        simulatedFillPrice: null,
      });
    },
  );

  it.each([
    '0',
    '-1',
    'bad',
    'NaN',
    'Infinity',
    '0.000000001',
    '10000000000000000',
  ])('rejects corrupt quantity %s on the opposite book side', (quantity) => {
    const evidence = l2();
    evidence.bids = [{ price: '99', quantity }];
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      state: 'unassessable',
      reason: 'invalid_evidence',
      invalidField: 'evidence.bids[0].quantity',
      observedFillableQuantity: null,
    });
  });

  it.each([
    ['assetId', 'wrong-asset'],
    ['priceCurrency', 'USD'],
    ['quantityUnit', 'lot'],
  ] as const)('rejects mismatched %s without conversion', (field, value) => {
    expect(
      assessExecutionRealism({
        order: order(),
        evidence: { ...l2(), [field]: value },
      }),
    ).toMatchObject({
      state: 'unassessable',
      reason: 'invalid_evidence',
      invalidField: `evidence.${field}`,
      observedFillableQuantity: null,
    });
  });

  it.each([
    ['effectiveAt', new Date('invalid')],
    ['capturedAt', new Date('invalid')],
    ['effectiveAt', new Date('2026-09-29T01:00:01Z')],
    ['capturedAt', new Date('2026-09-29T01:00:01Z')],
    ['effectiveAt', '2026-09-29T01:00:00Z' as unknown as Date],
  ] as const)('rejects invalid/future %s (%s)', (field, value) => {
    expect(
      assessExecutionRealism({
        order: order(),
        evidence: { ...l2(), [field]: value },
      }),
    ).toMatchObject({
      state: 'unassessable',
      reason: 'invalid_evidence',
      invalidField: `evidence.${field}`,
      observedFillableQuantity: null,
    });
  });

  it('rejects invalid validation timestamps and states instead of treating them as usable', () => {
    expect(
      assessExecutionRealism({
        order: order(),
        evidence: {
          ...l2(),
          validation: { state: 'usable', checkedAt: new Date('invalid') },
        },
      }),
    ).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.validation.checkedAt',
    });
    expect(
      assessExecutionRealism({
        order: order(),
        evidence: {
          ...l2(),
          validation: { ...context.validation, state: 'unknown' as 'usable' },
        },
      }),
    ).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.validation.state',
    });
  });

  it('rejects duplicate prices rather than double-counting quantity and rejects crossed books', () => {
    const evidence = l2();
    evidence.asks = [
      ...evidence.asks,
      { price: '100.00000000', quantity: '999' },
    ];
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.asks[3].price',
    });
    evidence.asks = [{ price: '98', quantity: '100' }];
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.crossedBook',
    });
    const crossedTop = top();
    crossedTop.bid = { price: '101', quantity: '1' };
    expect(
      assessExecutionRealism({ order: order(), evidence: crossedTop }),
    ).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.crossedBook',
    });
  });

  it('accepts a locked book without inventing a spread', () => {
    const evidence = top();
    evidence.bid = { price: '100', quantity: '100' };
    expect(
      assessExecutionRealism({
        order: order({ side: 'sell', quantity: '1' }),
        evidence,
      }),
    ).toMatchObject({
      state: 'full_observed_fill',
      referencePrice: '100.00000000',
      adversePriceImpactBps: '0.00000000',
    });
  });

  it.each(['price', 'quantity'] as const)(
    'rejects corrupt top %s on the opposite side, without falling back to L2/last',
    (field) => {
      const evidence = top();
      evidence.bid = { price: '99', quantity: '1', [field]: '0' };
      expect(
        assessExecutionRealism({ order: order(), evidence }),
      ).toMatchObject({
        reason: 'invalid_evidence',
        invalidField: `evidence.bid.${field}`,
        referencePrice: null,
        observedFillableQuantity: null,
      });
    },
  );

  it('rejects invalid reference price and historical volume/interval rather than repairing them', () => {
    const evidence: ExecutionMarketEvidence & { kind: 'price_only' } = {
      ...context,
      kind: 'price_only',
      referencePrice: '0',
    };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.referencePrice',
    });
    evidence.referencePrice = '100';
    evidence.volume = {
      quantity: '-1',
      from: new Date('2026-09-29T00:59:00Z'),
      to: context.effectiveAt,
    };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.volume.quantity',
    });
    evidence.volume = {
      ...evidence.volume,
      quantity: '10',
      from: context.effectiveAt,
    };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.volume.interval',
    });
    evidence.volume = { ...evidence.volume, from: new Date('invalid') };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.volume.from',
    });
  });

  it('rejects a future volume interval and an explicitly corrupt volume object', () => {
    const evidence: ExecutionMarketEvidence & { kind: 'price_only' } = {
      ...context,
      kind: 'price_only',
      referencePrice: '100',
      volume: {
        quantity: '1',
        from: context.effectiveAt,
        to: new Date('2026-09-29T01:00:01Z'),
      },
    };
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.volume.interval',
    });
    evidence.volume = null as unknown as NonNullable<typeof evidence.volume>;
    expect(assessExecutionRealism({ order: order(), evidence })).toMatchObject({
      reason: 'invalid_evidence',
      invalidField: 'evidence.volume',
    });
  });

  it.each([
    { quantity: '0' },
    { quantity: '-1' },
    { quantity: 'bad' },
    { quantity: '0.000000001' },
    { limitPrice: '0' },
    { limitPrice: 'NaN' },
    { side: 'unknown' as 'buy' },
    { assetId: '' },
    { priceCurrency: '' },
    { quantityUnit: '' },
  ])(
    'rejects invalid hypothetical order %s separately from corrupt evidence',
    (overrides) => {
      expect(
        assessExecutionRealism({ order: order(overrides), evidence: l2() }),
      ).toMatchObject({
        state: 'unassessable',
        reason: 'invalid_order',
        observedFillableQuantity: null,
        simulatedFillPrice: null,
      });
    },
  );

  it('produces deterministic results without mutating or reordering input evidence', () => {
    const evidence = l2();
    const hypothetical = order();
    const before = JSON.stringify({ evidence, hypothetical });
    Object.freeze(evidence.asks);
    Object.freeze(evidence.bids);
    Object.freeze(evidence);
    Object.freeze(hypothetical);
    const first = assessExecutionRealism({ order: hypothetical, evidence });
    expect(assessExecutionRealism({ order: hypothetical, evidence })).toEqual(
      first,
    );
    expect(JSON.stringify({ evidence, hypothetical })).toBe(before);
    expect(first.order).not.toBe(hypothetical);
  });

  it('uses Decimal arithmetic for fractional book walking and calculates impact before rounding VWAP', () => {
    const evidence = l2();
    evidence.asks = [
      { price: '0.1', quantity: '0.1' },
      { price: '0.2', quantity: '0.2' },
    ];
    evidence.bids = [];
    expect(
      assessExecutionRealism({ order: order({ quantity: '0.3' }), evidence }),
    ).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '0.30000000',
      simulatedFillPrice: '0.16666667',
      adversePriceImpactBps: '6666.66666667',
    });
  });

  it('keeps high precision for Decimal(24,8) quantity and notional before the final half-up rounding', () => {
    const evidence = l2();
    evidence.asks = [
      { price: '1.00000001', quantity: '5000000000000000.00000001' },
      { price: '1.00000002', quantity: '4999999999999999.99999998' },
    ];
    evidence.bids = [];
    const precision = Prisma.Decimal.precision;
    const rounding = Prisma.Decimal.rounding;
    expect(
      assessExecutionRealism({
        order: order({ quantity: '9999999999999999.99999999' }),
        evidence,
      }),
    ).toMatchObject({
      state: 'full_observed_fill',
      observedFillableQuantity: '9999999999999999.99999999',
      simulatedFillPrice: '1.00000001',
      adversePriceImpactBps: '0.00005000',
      levelsConsumed: 2,
    });
    expect(Prisma.Decimal.precision).toBe(precision);
    expect(Prisma.Decimal.rounding).toBe(rounding);
  });

  it('rounds an exact weighted half to the existing monetary scale using ROUND_HALF_UP', () => {
    const evidence = {
      ...l2(),
      asks: [
        { price: '1', quantity: '1' },
        { price: '1.00000001', quantity: '1' },
      ],
      bids: [],
    };
    expect(
      assessExecutionRealism({ order: order({ quantity: '2' }), evidence }),
    ).toMatchObject({
      simulatedFillPrice: '1.00000001',
      adversePriceImpactBps: '0.00005000',
    });
  });

  it('works with generic units and currencies without Provider-specific raw fields', () => {
    const evidence = {
      ...l2(),
      assetId: 'future-product',
      priceCurrency: 'EUR',
      quantityUnit: 'normalized-unit',
    };
    expect(
      assessExecutionRealism({
        order: order({
          assetId: evidence.assetId,
          priceCurrency: 'EUR',
          quantityUnit: 'normalized-unit',
        }),
        evidence,
      }),
    ).toMatchObject({
      state: 'full_observed_fill',
      simulatedFillPrice: '100.80000000',
    });
  });
});
