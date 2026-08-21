jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});

import {
  computeFxQuoteRequestHash,
  computeGeneralFxQuoteRequestHash,
} from './durable-quote.policy';

describe('FX durable quote hash compatibility', () => {
  const economic = {
    userId: 'user-1',
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1000',
  };

  it('keeps the released season v1 vector fixed', () => {
    expect(
      computeFxQuoteRequestHash({
        ...economic,
        seasonParticipantId: 'participant-1',
      }),
    ).toBe('4cccde695b02cb680cc827c3871f2c4d6cda1240b2f25d8e367c39099d61707c');
  });

  it('uses account-scoped v2 identity for general quotes', () => {
    const first = computeGeneralFxQuoteRequestHash({
      ...economic,
      tradingAccountId: 'account-1',
    });
    expect(
      computeGeneralFxQuoteRequestHash({
        ...economic,
        sourceAmount: '1000.00000000',
        tradingAccountId: 'account-1',
      }),
    ).toBe(first);
    expect(
      computeGeneralFxQuoteRequestHash({
        ...economic,
        tradingAccountId: 'account-2',
      }),
    ).not.toBe(first);
  });
});
