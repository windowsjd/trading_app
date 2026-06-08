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

import { computeFxExecuteRequestHash } from './fx-execute-idempotency-policy';
import {
  preflightFxExecuteRequest,
  type FxExecuteRequestBodyLike,
  type FxExecuteRequestContextLike,
} from './fx-execute-request-policy';

describe('fx execute request policy', () => {
  const context: FxExecuteRequestContextLike = {
    userId: 'user-1',
    seasonParticipantId: 'participant-1',
  };

  const validKrwUsdBody: FxExecuteRequestBodyLike = {
    quoteId: 'quote-fx-1',
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1000',
    idempotencyKey: 'idempotency-key-1',
  };

  const expectErrorCode = (
    body: FxExecuteRequestBodyLike,
    errorCode: string,
  ) => {
    expect(preflightFxExecuteRequest(body, context)).toEqual({
      ok: false,
      errorCode,
    });
  };

  it('canonicalizes a valid KRW to USD request', () => {
    const result = preflightFxExecuteRequest(validKrwUsdBody, context);

    expect(result).toEqual({
      ok: true,
      value: {
        userId: 'user-1',
        seasonParticipantId: 'participant-1',
        quoteId: 'quote-fx-1',
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000.00000000',
        idempotencyKey: 'idempotency-key-1',
        requestHash: expect.any(String),
      },
    });
  });

  it('canonicalizes a valid USD to KRW request', () => {
    const result = preflightFxExecuteRequest(
      {
        quoteId: 'quote-fx-1',
        fromCurrency: 'USD',
        toCurrency: 'KRW',
        sourceAmount: '100',
        idempotencyKey: 'idempotency-key-1',
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        fromCurrency: 'USD',
        toCurrency: 'KRW',
        sourceAmount: '100.00000000',
      },
    });
  });

  it('normalizes lowercase currencies to uppercase', () => {
    const result = preflightFxExecuteRequest(
      {
        ...validKrwUsdBody,
        fromCurrency: 'krw',
        toCurrency: 'usd',
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
      },
    });
  });

  it.each(['1000', '1000.0', '1000.00000000'])(
    'canonicalizes sourceAmount %s to scale 8',
    (sourceAmount) => {
      const result = preflightFxExecuteRequest(
        {
          ...validKrwUsdBody,
          sourceAmount,
        },
        context,
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          sourceAmount: '1000.00000000',
        },
      });
    },
  );

  it('trims idempotencyKey', () => {
    const result = preflightFxExecuteRequest(
      {
        ...validKrwUsdBody,
        idempotencyKey: '  idempotency-key-1  ',
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        idempotencyKey: 'idempotency-key-1',
      },
    });
  });

  it('connects requestHash to the accepted canonical hash helper', () => {
    const result = preflightFxExecuteRequest(validKrwUsdBody, context);
    const expectedHash = computeFxExecuteRequestHash({
      userId: 'user-1',
      seasonParticipantId: 'participant-1',
      quoteId: 'quote-fx-1',
      fromCurrency: 'KRW',
      toCurrency: 'USD',
      sourceAmount: '1000.00000000',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        requestHash: expectedHash,
      },
    });
  });

  it('keeps requestHash stable when only idempotencyKey changes', () => {
    const first = preflightFxExecuteRequest(validKrwUsdBody, context);
    const second = preflightFxExecuteRequest(
      {
        ...validKrwUsdBody,
        idempotencyKey: 'different-idempotency-key',
      },
      context,
    );

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });

    if (first.ok && second.ok) {
      expect(first.value.requestHash).toBe(second.value.requestHash);
      expect(first.value.idempotencyKey).not.toBe(second.value.idempotencyKey);
    }
  });

  it('includes normalized quoteId in requestHash', () => {
    const first = preflightFxExecuteRequest(
      {
        ...validKrwUsdBody,
        quoteId: ' quote-fx-1 ',
      },
      context,
    );
    const second = preflightFxExecuteRequest(
      {
        ...validKrwUsdBody,
        quoteId: 'quote-fx-2',
      },
      context,
    );

    expect(first).toMatchObject({
      ok: true,
      value: {
        quoteId: 'quote-fx-1',
      },
    });
    expect(second).toMatchObject({ ok: true });

    if (first.ok && second.ok) {
      expect(first.value.requestHash).not.toBe(second.value.requestHash);
    }
  });

  it.each([
    ['same KRW pair', { fromCurrency: 'KRW', toCurrency: 'KRW' }],
    ['same USD pair', { fromCurrency: 'USD', toCurrency: 'USD' }],
    ['unsupported currency', { fromCurrency: 'EUR', toCurrency: 'USD' }],
    ['missing fromCurrency', { fromCurrency: undefined, toCurrency: 'USD' }],
    ['missing toCurrency', { fromCurrency: 'KRW', toCurrency: undefined }],
    ['non-string currency', { fromCurrency: 1, toCurrency: 'USD' }],
  ])('returns INVALID_CURRENCY_PAIR for %s', (_label, override) => {
    expectErrorCode(
      {
        ...validKrwUsdBody,
        ...override,
      },
      'INVALID_CURRENCY_PAIR',
    );
  });

  it.each([
    ['missing sourceAmount', undefined],
    ['non-string sourceAmount', 1000],
    ['invalid decimal string', 'not-money'],
    ['zero sourceAmount', '0'],
    ['negative sourceAmount', '-1'],
  ])('returns INVALID_AMOUNT for %s', (_label, sourceAmount) => {
    expectErrorCode(
      {
        ...validKrwUsdBody,
        sourceAmount,
      },
      'INVALID_AMOUNT',
    );
  });

  it.each([
    ['missing quoteId', undefined],
    ['empty quoteId', ''],
    ['whitespace-only quoteId', '   '],
    ['non-string quoteId', 123],
  ])('returns QUOTE_REQUIRED for %s', (_label, quoteId) => {
    expectErrorCode(
      {
        ...validKrwUsdBody,
        quoteId,
      },
      'QUOTE_REQUIRED',
    );
  });

  it.each([
    ['missing idempotencyKey', undefined],
    ['empty idempotencyKey', ''],
    ['whitespace-only idempotencyKey', '   '],
    ['non-string idempotencyKey', 123],
  ])('returns IDEMPOTENCY_REQUIRED for %s', (_label, idempotencyKey) => {
    expectErrorCode(
      {
        ...validKrwUsdBody,
        idempotencyKey,
      },
      'IDEMPOTENCY_REQUIRED',
    );
  });

  it('throws for missing or empty context userId', () => {
    expect(() =>
      preflightFxExecuteRequest(validKrwUsdBody, {
        ...context,
        userId: undefined as never,
      }),
    ).toThrow('userId is required');
    expect(() =>
      preflightFxExecuteRequest(validKrwUsdBody, {
        ...context,
        userId: ' ',
      }),
    ).toThrow('userId is required');
  });

  it('throws for missing or empty context seasonParticipantId', () => {
    expect(() =>
      preflightFxExecuteRequest(validKrwUsdBody, {
        ...context,
        seasonParticipantId: undefined as never,
      }),
    ).toThrow('seasonParticipantId is required');
    expect(() =>
      preflightFxExecuteRequest(validKrwUsdBody, {
        ...context,
        seasonParticipantId: ' ',
      }),
    ).toThrow('seasonParticipantId is required');
  });

  it('does not require PrismaService or DB access', () => {
    expect(preflightFxExecuteRequest(validKrwUsdBody, context)).toMatchObject({
      ok: true,
    });
  });

  it('does not include execute-time or wallet fields in the normalized result', () => {
    const bodyWithIgnoredFields = {
      ...validKrwUsdBody,
      appliedRate: '1350.00000000',
      walletId: 'wallet-1',
      balance: '100000.00000000',
      fxRateSnapshotId: 'snapshot-1',
      feeRate: '0.001000',
    } as FxExecuteRequestBodyLike;
    const result = preflightFxExecuteRequest(bodyWithIgnoredFields, context);

    expect(result).toMatchObject({ ok: true });

    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual([
        'fromCurrency',
        'idempotencyKey',
        'quoteId',
        'requestHash',
        'seasonParticipantId',
        'sourceAmount',
        'toCurrency',
        'userId',
      ]);
      expect(result.value).not.toHaveProperty('appliedRate');
      expect(result.value).not.toHaveProperty('walletId');
      expect(result.value).not.toHaveProperty('balance');
      expect(result.value).not.toHaveProperty('fxRateSnapshotId');
      expect(result.value).not.toHaveProperty('feeRate');
    }
  });
});
