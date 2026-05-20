jest.mock('../generated/prisma/client', () => ({
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
});
