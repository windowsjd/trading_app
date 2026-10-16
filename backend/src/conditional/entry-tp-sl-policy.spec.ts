jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertEntryTriggerSides,
  entryPlanTargetQuantity,
  entryTpSlHash,
  findEntryPlanConflict,
  parseEntryTpSlBody,
  parseEntryTpSlDrafts,
} from './entry-tp-sl-policy';
import { legacyOcoRegistrationEnabled } from './conditional.config';

const d = (value: string) => new Prisma.Decimal(value);
const code = (work: () => unknown) => {
  try {
    work();
    return 'RESOLVED';
  } catch (error) {
    return error instanceof HttpException
      ? (error.getResponse() as { error: { code: string } }).error.code
      : String(error);
  }
};

describe('activation quantity', () => {
  it('sizes each plan from the executed quantity only (30/70/100 of 0.4)', () => {
    const executed = d('0.4');
    expect(entryPlanTargetQuantity(executed, 30, 8).toFixed(8)).toBe(
      '0.12000000',
    );
    expect(entryPlanTargetQuantity(executed, 70, 8).toFixed(8)).toBe(
      '0.28000000',
    );
    expect(entryPlanTargetQuantity(executed, 100, 8).toFixed(8)).toBe(
      '0.40000000',
    );
  });
  it('cuts down to the unit, never up', () => {
    expect(entryPlanTargetQuantity(d('1.052631'), 50, 6).toFixed(6)).toBe(
      '0.526315',
    );
    expect(entryPlanTargetQuantity(d('0.000001'), 1, 6).toFixed(6)).toBe(
      '0.000000',
    );
  });
});

describe('plan conflicts per entry and kind', () => {
  const plan = (
    kind: 'stop_loss' | 'take_profit',
    triggerPrice: string,
    ratioPercent: number,
  ) => ({ kind, triggerPrice: d(triggerPrice), ratioPercent });
  it('allows 30% + 70% take-profits next to a 100% stop-loss', () => {
    expect(
      findEntryPlanConflict({
        pending: [plan('take_profit', '110', 30)],
        intents: [plan('take_profit', '120', 70), plan('stop_loss', '90', 100)],
      }),
    ).toBeNull();
  });
  it('refuses more than 100% of one kind', () => {
    expect(
      findEntryPlanConflict({
        pending: [
          plan('take_profit', '110', 30),
          plan('take_profit', '120', 70),
        ],
        intents: [plan('take_profit', '130', 1)],
      }),
    ).toBe('total_exceeds_entry');
  });
  it('refuses one kind at the same price (120 = 120.0), not across kinds', () => {
    expect(
      findEntryPlanConflict({
        pending: [plan('take_profit', '120', 10)],
        intents: [plan('take_profit', '120.0', 10)],
      }),
    ).toBe('duplicate_price');
    expect(
      findEntryPlanConflict({
        pending: [],
        intents: [
          plan('take_profit', '120', 10),
          plan('take_profit', '120', 10),
        ],
      }),
    ).toBe('duplicate_price');
  });
});

describe('trigger sides against the entry price', () => {
  it.each([
    ['long', 'stop_loss', '99', 'RESOLVED'],
    ['long', 'stop_loss', '100', 'ENTRY_TP_SL_INVALID_TRIGGER'],
    ['long', 'take_profit', '101', 'RESOLVED'],
    ['long', 'take_profit', '99', 'ENTRY_TP_SL_INVALID_TRIGGER'],
    ['short', 'stop_loss', '101', 'RESOLVED'],
    ['short', 'stop_loss', '99', 'ENTRY_TP_SL_INVALID_TRIGGER'],
    ['short', 'take_profit', '99', 'RESOLVED'],
    ['short', 'take_profit', '100', 'ENTRY_TP_SL_INVALID_TRIGGER'],
  ] as const)('%s %s at %s → %s', (direction, kind, trigger, expected) => {
    expect(
      code(() =>
        assertEntryTriggerSides(
          [{ kind, triggerPrice: d(trigger) }],
          direction,
          d('100'),
        ),
      ),
    ).toBe(expected);
  });
});

describe('parsing', () => {
  const body = {
    entryType: 'spot_limit_order',
    entryId: 'order-1',
    idempotencyKey: 'entry-plan-key-1',
    takeProfit: { triggerPrice: '110', ratio: 30 },
  };
  it('parses a single leg and hashes it with the entry', () => {
    const parsed = parseEntryTpSlBody(body);
    expect(parsed.intents).toEqual([
      { kind: 'take_profit', triggerPrice: d('110'), ratioPercent: 30 },
    ]);
    expect(entryTpSlHash('a', parsed)).not.toBe(
      entryTpSlHash('a', { ...parsed, entryId: 'order-2' }),
    );
  });
  it.each([
    [{ ...body, entryType: 'spot_sell_order' }],
    [{ ...body, takeProfit: { triggerPrice: '110', ratio: 0 } }],
    [{ ...body, takeProfit: { triggerPrice: '110', ratio: 101 } }],
    [{ ...body, takeProfit: { triggerPrice: '110', ratio: 30.5 } }],
    [{ ...body, takeProfit: { triggerPrice: '110', ratio: '30' } }],
    [{ ...body, takeProfit: undefined }],
    [{ ...body, quantity: '1' }],
  ])('refuses malformed plan bodies %#', (value) => {
    expect(code(() => parseEntryTpSlBody(value))).toBe('INVALID_ENTRY_TP_SL');
  });
  it('parses create attachments (1–10 drafts, several per kind)', () => {
    expect(
      parseEntryTpSlDrafts([
        { kind: 'take_profit', triggerPrice: '110', ratio: 30 },
        { kind: 'take_profit', triggerPrice: '120', ratio: 70 },
      ]).map((row) => row.ratioPercent),
    ).toEqual([30, 70]);
    expect(code(() => parseEntryTpSlDrafts([]))).toBe('INVALID_ENTRY_TP_SL');
    expect(
      code(() =>
        parseEntryTpSlDrafts([
          { kind: 'condition', triggerPrice: '110', ratio: 30 },
        ]),
      ),
    ).toBe('INVALID_ENTRY_TP_SL');
  });
});

describe('LEGACY_OCO_REGISTRATION_ENABLED', () => {
  it('is strict and defaults off (new OCO groups retired)', () => {
    expect(legacyOcoRegistrationEnabled({})).toBe(false);
    expect(
      legacyOcoRegistrationEnabled({ LEGACY_OCO_REGISTRATION_ENABLED: 'true' }),
    ).toBe(true);
    expect(() =>
      legacyOcoRegistrationEnabled({ LEGACY_OCO_REGISTRATION_ENABLED: '1' }),
    ).toThrow('LEGACY_OCO_REGISTRATION_ENABLED must be true or false');
  });
});
