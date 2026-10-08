jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { Prisma } from '../generated/prisma/client';
import {
  parseProtectionLegs,
  assertTriggerDirections,
  isTriggered,
} from './conditional-policy';
import { conditionalEnabled } from './conditional.config';
describe('Conditional exact trigger policy', () => {
  it.each(['long', 'short'] as const)(
    '%s inclusive boundaries and strict registration',
    (direction) => {
      for (const kind of ['stop_loss', 'take_profit'] as const) {
        expect(
          isTriggered(
            direction,
            kind,
            new Prisma.Decimal(100),
            new Prisma.Decimal(100),
          ),
        ).toBe(true);
        expect(() =>
          assertTriggerDirections(
            [{ kind, triggerPrice: '100', childOrderType: 'market' }],
            direction,
            new Prisma.Decimal(100),
          ),
        ).toThrow();
        const below = (direction === 'long') === (kind === 'stop_loss');
        const triggerPrice = below ? '99.99999999' : '100.00000001';
        expect(() =>
          assertTriggerDirections(
            [{ kind, triggerPrice, childOrderType: 'market' }],
            direction,
            new Prisma.Decimal(100),
          ),
        ).not.toThrow();
        expect(
          isTriggered(
            direction,
            kind,
            new Prisma.Decimal(triggerPrice),
            new Prisma.Decimal(triggerPrice),
          ),
        ).toBe(true);
      }
    },
  );
  it('requires one of each leg and exact positive financial strings', () => {
    const leg = {
      kind: 'stop_loss',
      triggerPrice: '99',
      childOrderType: 'market',
    };
    for (const value of [
      [],
      [leg, leg],
      [{ ...leg, triggerPrice: 99 }],
      [{ ...leg, triggerPrice: '0' }],
      [{ ...leg, triggerPrice: '1.000000001' }],
      [{ ...leg, childLimitPrice: '90' }],
      [{ ...leg, childOrderType: 'limit' }],
    ])
      expect(() => parseProtectionLegs(value)).toThrow();
    expect(parseProtectionLegs([leg])[0].triggerPrice).toBe('99.00000000');
  });
  it('defaults OFF and rejects malformed operational flags', () => {
    expect(conditionalEnabled({})).toBe(false);
    expect(conditionalEnabled({ CONDITIONAL_ORDERS_ENABLED: 'true' })).toBe(
      true,
    );
    expect(() =>
      conditionalEnabled({ CONDITIONAL_ORDERS_ENABLED: 'yes' }),
    ).toThrow();
  });
});
