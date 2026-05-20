jest.mock('../generated/prisma/client', () => ({
  AssetPriceSourceType: {
    admin_manual: 'admin_manual',
  },
  CurrencyCode: {
    KRW: 'KRW',
    USD: 'USD',
  },
  FxRateSourceType: {
    admin_manual: 'admin_manual',
  },
  Prisma: {
    Decimal: jest.fn(),
    JsonNull: null,
  },
  PrismaClient: class PrismaClient {},
}));

import { parseAdminRunBatchJobArgs } from './batch-admin-runner';

describe('parseAdminRunBatchJobArgs', () => {
  it('parses noop job options with payload JSON', () => {
    expect(
      parseAdminRunBatchJobArgs([
        '--job',
        'noop',
        '--idempotency-key',
        'noop:2026-05-19',
        '--dry-run',
        '--requested-by=operator',
        '--payload-json',
        '{"scope":"smoke"}',
      ]),
    ).toEqual({
      job: 'noop',
      idempotencyKey: 'noop:2026-05-19',
      dryRun: true,
      requestedBy: 'operator',
      payloadJson: {
        scope: 'smoke',
      },
    });
  });

  it('parses health-check job', () => {
    expect(
      parseAdminRunBatchJobArgs([
        '--job=health-check',
        '--idempotency-key=health-check:local',
      ]),
    ).toMatchObject({
      job: 'health-check',
      idempotencyKey: 'health-check:local',
    });
  });

  it('parses daily portfolio snapshot job options and generates idempotency key', () => {
    expect(
      parseAdminRunBatchJobArgs([
        '--job',
        'daily-portfolio-snapshot',
        '--season-id',
        'season-1',
        '--snapshot-date',
        '2026-05-20',
        '--dry-run',
        '--requested-by',
        'operator',
      ]),
    ).toMatchObject({
      job: 'daily-portfolio-snapshot',
      seasonId: 'season-1',
      snapshotDate: '2026-05-20',
      idempotencyKey: 'daily-portfolio-snapshot:season-1:2026-05-20',
      dryRun: true,
      requestedBy: 'operator',
    });
  });

  it('keeps explicit daily portfolio snapshot idempotency key', () => {
    expect(
      parseAdminRunBatchJobArgs([
        '--job=daily-portfolio-snapshot',
        '--season-id=season-1',
        '--snapshot-date=2026-05-20',
        '--idempotency-key=manual-key',
      ]),
    ).toMatchObject({
      job: 'daily-portfolio-snapshot',
      idempotencyKey: 'manual-key',
    });
  });

  it('rejects unknown options', () => {
    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'noop',
        '--idempotency-key',
        'noop:key',
        '--unknown',
      ]),
    ).toThrow('Unknown option: --unknown');
  });

  it('rejects invalid jobs and invalid payload JSON', () => {
    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'daily-snapshot',
        '--idempotency-key',
        'daily-snapshot:key',
      ]),
    ).toThrow('Invalid --job: daily-snapshot.');

    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'noop',
        '--idempotency-key',
        'noop:key',
        '--payload-json',
        '{nope',
      ]),
    ).toThrow('Invalid --payload-json');
  });

  it('rejects missing daily portfolio snapshot required options', () => {
    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'daily-portfolio-snapshot',
        '--snapshot-date',
        '2026-05-20',
      ]),
    ).toThrow('Missing or empty --season-id.');

    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'daily-portfolio-snapshot',
        '--season-id',
        'season-1',
      ]),
    ).toThrow('Missing or empty --snapshot-date.');
  });

  it('rejects invalid daily portfolio snapshot dates', () => {
    expect(() =>
      parseAdminRunBatchJobArgs([
        '--job',
        'daily-portfolio-snapshot',
        '--season-id',
        'season-1',
        '--snapshot-date',
        '2026-02-31',
      ]),
    ).toThrow('Invalid --snapshot-date: must be YYYY-MM-DD.');
  });
});
