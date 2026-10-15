import { databaseFailureKind, postgresErrorCode } from './database-failure';

// Shapes observed from Prisma 7.6 + @prisma/adapter-pg: model calls throw
// DriverAdapterError { cause }, raw queries P2010 { meta.driverAdapterError }.
const driver = (cause: Record<string, unknown>) =>
  Object.assign(new Error('driver'), { name: 'DriverAdapterError', cause });
const raw = (cause: Record<string, unknown>) =>
  Object.assign(new Error('raw'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause } },
  });

describe('databaseFailureKind', () => {
  it.each([
    [driver({ kind: 'postgres', originalCode: '53100' }), 'disk_full', '53100'],
    [
      driver({
        kind: 'postgres',
        originalCode: 'XX000',
        originalMessage:
          'could not write to file "pg_wal/xlogtemp.1": No space left on device',
      }),
      'disk_full',
      'XX000',
    ],
    [
      raw({ kind: 'postgres', originalCode: '57014' }),
      'statement_timeout',
      '57014',
    ],
    [raw({ kind: 'postgres', originalCode: '55P03' }), 'lock_timeout', '55P03'],
    [driver({ kind: 'DatabaseNotReachable' }), 'connection', null],
    [driver({ kind: 'ConnectionClosed' }), 'connection', null],
    [
      driver({ kind: 'TooManyConnections', originalCode: '53300' }),
      'connection',
      '53300',
    ],
    [
      driver({ kind: 'postgres', originalCode: '08006' }),
      'connection',
      '08006',
    ],
    [
      driver({ kind: 'postgres', originalCode: '57P01' }),
      'connection',
      '57P01',
    ],
    [
      driver({ kind: 'postgres', originalCode: '23514' }),
      'data_rejected',
      '23514',
    ],
    [
      driver({ kind: 'postgres', originalCode: '22003' }),
      'data_rejected',
      '22003',
    ],
    [
      driver({ kind: 'postgres', originalCode: '40001' }),
      'database_error',
      '40001',
    ],
    [Object.assign(new Error('x'), { code: 'P1001' }), 'connection', null],
    // A Prisma request code alone is not an SQLSTATE.
    [Object.assign(new Error('x'), { code: 'P2010' }), 'unknown', null],
    [new Error('anything'), 'unknown', null],
    ['not an error', 'unknown', null],
    [null, 'unknown', null],
  ])('case %#', (value, kind, code) => {
    expect(databaseFailureKind(value)).toBe(kind);
    expect(postgresErrorCode(value)).toBe(code);
  });
});
