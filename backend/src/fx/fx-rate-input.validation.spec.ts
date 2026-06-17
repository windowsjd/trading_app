jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import {
  buildAdminFxRateSnapshotPayload,
} from './fx-rate-input.validation';
import { CurrencyCode, FxRateSourceType } from '../generated/prisma/client';

describe('buildAdminFxRateSnapshotPayload', () => {
  const now = new Date('2026-05-01T01:02:03.000Z');

  it('parses valid admin_manual input', () => {
    const payload = buildAdminFxRateSnapshotPayload(
      {
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        note: 'approved operating input',
      },
      now,
    );

    expect(payload).toMatchObject({
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1350.12345678',
      sourceType: FxRateSourceType.admin_manual,
      sourceName: 'manual-approved-usd-krw',
      capturedAt: now,
      note: 'approved operating input',
    });
    expect(payload.effectiveAt.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('accepts strict UTC ISO timestamps for capturedAt and sourceTimestamp', () => {
    const payload = buildAdminFxRateSnapshotPayload({
      rate: '1350.12345678',
      sourceName: 'manual-approved-usd-krw',
      effectiveAt: '2026-05-01T00:00:00.000Z',
      capturedAt: '2026-05-01T01:02:03.004Z',
      sourceTimestamp: '2026-05-01T00:30:00.005Z',
    });

    expect(payload.effectiveAt.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
    expect(payload.capturedAt.toISOString()).toBe(
      '2026-05-01T01:02:03.004Z',
    );
    expect(payload.sourceTimestamp?.toISOString()).toBe(
      '2026-05-01T00:30:00.005Z',
    );
  });

  it('rejects invalid rate values', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '0',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
      }),
    ).toThrow('Invalid rate');
  });

  it('rejects rates beyond supported scale', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.123456789',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
      }),
    ).toThrow('Decimal(18, 8)');
  });

  it('rejects invalid effectiveAt', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: 'not-a-date',
      }),
    ).toThrow('Invalid --effective-at');
  });

  it('rejects date-only effectiveAt', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01',
      }),
    ).toThrow(
      'Invalid --effective-at: must be UTC ISO timestamp like 2026-05-01T00:00:00.000Z.',
    );
  });

  it('rejects effectiveAt with timezone offset', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00+09:00',
      }),
    ).toThrow('Invalid --effective-at');
  });

  it('rejects effectiveAt without milliseconds', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00Z',
      }),
    ).toThrow('Invalid --effective-at');
  });

  it('rejects invalid capturedAt', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        capturedAt: '2026-05-01T00:00:00',
      }),
    ).toThrow('Invalid --captured-at');
  });

  it('rejects invalid sourceTimestamp', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        sourceTimestamp: 'not-a-date',
      }),
    ).toThrow('Invalid --source-timestamp');
  });

  it('rejects forbidden input wording', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-static-rate',
        effectiveAt: '2026-05-01T00:00:00.000Z',
      }),
    ).toThrow('forbidden term');
  });

  it('rejects forbidden wording in note', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        note: 'temporary operating input',
      }),
    ).toThrow('Invalid --note');
  });

  it('rejects forbidden wording in raw payload JSON', () => {
    expect(() =>
      buildAdminFxRateSnapshotPayload({
        rate: '1350.12345678',
        sourceName: 'manual-approved-usd-krw',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        rawPayloadJson: '{"kind":"placeholder"}',
      }),
    ).toThrow('Invalid --raw-payload-json');
  });

  it('parses raw payload JSON', () => {
    const payload = buildAdminFxRateSnapshotPayload({
      rate: '1350.12345678',
      sourceName: 'manual-approved-usd-krw',
      effectiveAt: '2026-05-01T00:00:00.000Z',
      rawPayloadJson: '{"source":"manual-approved-usd-krw"}',
    });

    expect(payload.rawPayloadJson).toEqual({
      source: 'manual-approved-usd-krw',
    });
  });

  it('normalizes empty approvedByUserId to undefined', () => {
    const payload = buildAdminFxRateSnapshotPayload({
      rate: '1350.12345678',
      sourceName: 'manual-approved-usd-krw',
      effectiveAt: '2026-05-01T00:00:00.000Z',
      approvedByUserId: '',
    });

    expect(payload.approvedByUserId).toBeUndefined();
  });
});
