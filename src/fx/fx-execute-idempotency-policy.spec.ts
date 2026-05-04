jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    Prisma: {
      Decimal,
    },
  };
});

import {
  buildFxExecuteCanonicalPayload,
  computeFxExecuteRequestHash,
  serializeFxExecuteCanonicalPayload,
} from './fx-execute-idempotency-policy';

describe('fx execute idempotency policy', () => {
  const baseInput = {
    userId: 'user-1',
    seasonParticipantId: 'participant-1',
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1000',
  };

  it('canonicalizes equivalent scale 8 source amounts to the same hash', () => {
    const hashes = ['1000', '1000.0', '1000.00000000'].map((sourceAmount) =>
      computeFxExecuteRequestHash({ ...baseInput, sourceAmount }),
    );

    expect(new Set(hashes).size).toBe(1);
  });

  it('canonicalizes equivalent fractional source amounts to the same hash', () => {
    const hashA = computeFxExecuteRequestHash({
      ...baseInput,
      sourceAmount: '0.1',
    });
    const hashB = computeFxExecuteRequestHash({
      ...baseInput,
      sourceAmount: '0.100000000',
    });

    expect(hashA).toBe(hashB);
  });

  it('canonicalizes currency casing before hashing', () => {
    const lowerHash = computeFxExecuteRequestHash({
      ...baseInput,
      fromCurrency: 'krw',
      toCurrency: 'usd',
    });
    const upperHash = computeFxExecuteRequestHash({
      ...baseInput,
      fromCurrency: 'KRW',
      toCurrency: 'USD',
    });

    expect(lowerHash).toBe(upperHash);
  });

  it('changes the hash when economic identity fields change', () => {
    const originalHash = computeFxExecuteRequestHash(baseInput);

    expect(
      computeFxExecuteRequestHash({ ...baseInput, sourceAmount: '1001' }),
    ).not.toBe(originalHash);
    expect(
      computeFxExecuteRequestHash({
        ...baseInput,
        fromCurrency: 'USD',
        toCurrency: 'KRW',
      }),
    ).not.toBe(originalHash);
    expect(
      computeFxExecuteRequestHash({ ...baseInput, userId: 'user-2' }),
    ).not.toBe(originalHash);
    expect(
      computeFxExecuteRequestHash({
        ...baseInput,
        seasonParticipantId: 'participant-2',
      }),
    ).not.toBe(originalHash);
  });

  it('excludes timestamp, rate, wallet balance, quote, and idempotency key fields', () => {
    const originalHash = computeFxExecuteRequestHash(baseInput);
    const extraFieldsHash = computeFxExecuteRequestHash({
      ...baseInput,
      idempotencyKey: 'idempotency-key-1',
      requestedAt: '2026-05-01T00:00:00.000Z',
      quoteId: 'quote-1',
      expiresAt: '2026-05-01T00:01:00.000Z',
      fxRateSnapshotId: 'snapshot-1',
      appliedRate: '1350.00000000',
      feeRate: '0.001000',
      walletBalance: '999999.00000000',
    });

    expect(extraFieldsHash).toBe(originalHash);
  });

  it('keeps canonical JSON field order fixed', () => {
    const canonicalPayload = buildFxExecuteCanonicalPayload(baseInput);

    expect(serializeFxExecuteCanonicalPayload(canonicalPayload)).toBe(
      '{"apiVersion":"fx-execute:v1","userId":"user-1","seasonParticipantId":"participant-1","fromCurrency":"KRW","toCurrency":"USD","sourceAmount":"1000.00000000"}',
    );
  });

  it('fails before hashing when sourceAmount is invalid', () => {
    expect(() =>
      computeFxExecuteRequestHash({ ...baseInput, sourceAmount: 'not-money' }),
    ).toThrow('Invalid decimal string');
    expect(() =>
      computeFxExecuteRequestHash({ ...baseInput, sourceAmount: '0' }),
    ).toThrow('Decimal must be greater than 0');
  });
});
