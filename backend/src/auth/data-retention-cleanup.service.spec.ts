jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { Logger } from '@nestjs/common';
import {
  DATA_RETENTION_BATCH,
  DATA_RETENTION_MAX_BATCHES,
  DataRetentionCleanupService,
} from './data-retention-cleanup.service';
import { dataRetentionConfig } from './data-retention.config';

type Statement = { sql: string; values: unknown[] };

/** A transaction client that answers each fixed statement by its SQL. */
function harness(
  options: {
    acquired?: boolean;
    sessions?: number[];
    auditLogs?: number[];
    inquiries?: string[][];
    fail?: boolean;
  } = {},
) {
  const statements: Statement[] = [];
  const sessions = [...(options.sessions ?? [0])];
  const auditLogs = [...(options.auditLogs ?? [0])];
  const inquiries = [...(options.inquiries ?? [[]])];
  // Like Prisma: every call returns a promise, a failure rejects it.
  const respond = (answer: (sql: string, values: unknown[]) => unknown) =>
    jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        new Promise((resolve) => {
          const sql = strings.join('?').replace(/\s+/g, ' ').trim();
          statements.push({ sql, values });
          resolve(answer(sql, values));
        }),
    );
  const tx = {
    $executeRaw: respond((sql, values) => {
      if (sql.startsWith('SET LOCAL')) return 0;
      if (sql.includes('DELETE FROM refresh_token_sessions')) {
        if (options.fail) throw new Error('private DB failure 10.0.0.7');
        return sessions.shift() ?? 0;
      }
      if (sql.includes('DELETE FROM operator_audit_logs'))
        return auditLogs.shift() ?? 0;
      if (sql.startsWith('DELETE FROM inquiry_answers')) return 1;
      if (sql.startsWith('DELETE FROM inquiries'))
        return (values[0] as string[]).length;
      throw new Error(`unexpected statement: ${sql}`);
    }),
    $queryRaw: respond((sql) => {
      if (sql.includes('pg_try_advisory_xact_lock'))
        return [{ acquired: options.acquired ?? true }];
      if (sql.includes('FROM inquiries i'))
        return (inquiries.shift() ?? []).map((id) => ({ id }));
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const prisma = {
    $transaction: jest.fn(
      async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    ),
  };
  const service = new DataRetentionCleanupService(prisma as never);
  return { service, prisma, statements };
}

describe('DataRetentionCleanupService', () => {
  const saved = { ...process.env };
  let now = Date.parse('2026-10-21T00:00:00.000Z');
  let logs: string[];

  beforeEach(() => {
    process.env = { ...saved };
    for (const name of [
      'DATA_RETENTION_CLEANUP_ENABLED',
      'AUTH_SESSION_RETENTION_DAYS',
      'OPERATOR_AUDIT_LOG_RETENTION_DAYS',
      'INQUIRY_RETENTION_DAYS',
    ])
      delete process.env[name];
    now = Date.parse('2026-10-21T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    logs = [];
    for (const level of ['log', 'warn'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });
  });

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('runs bounded fixed statements under the cluster-wide lock', async () => {
    const { service, statements } = harness();
    const config = {
      ...dataRetentionConfig({}),
      sessionDays: 120,
      auditLogDays: 400,
      inquiryDays: 2000,
    };
    expect(await service.deleteBatch(config)).toEqual({
      sessions: 0,
      auditLogs: 0,
      inquiries: 0,
    });
    const sql = statements.map((statement) => statement.sql);
    expect(sql[0]).toBe("SET LOCAL lock_timeout = '100ms'");
    expect(sql[1]).toBe("SET LOCAL statement_timeout = '5s'");
    expect(sql[2]).toContain(
      "pg_try_advisory_xact_lock(hashtextextended('data-retention', 0))",
    );
    const [sessions, auditLogs, inquiries] = statements.slice(3);
    expect(sessions.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sessions.sql).toContain("status = 'revoked' AND revoked_at <");
    expect(auditLogs.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(inquiries.sql).toContain('COALESCE(a.answered_at, i.created_at)');
    expect(inquiries.sql).toContain('FOR UPDATE OF i SKIP LOCKED');
    // Periods and the batch size are parameters from the configuration.
    expect(sessions.values).toEqual([120, 120, DATA_RETENTION_BATCH, 120, 120]);
    expect(auditLogs.values).toEqual([400, DATA_RETENTION_BATCH, 400]);
    expect(inquiries.values).toEqual([2000, DATA_RETENTION_BATCH]);
    // No inquiry selected: nothing else is deleted.
    expect(statements).toHaveLength(6);
  });

  it('deletes the answers of a batch before its inquiries', async () => {
    const { service, statements } = harness({ inquiries: [['i-1', 'i-2']] });
    const result = await service.deleteBatch(dataRetentionConfig({}));
    expect(result?.inquiries).toBe(2);
    const answers = statements.findIndex((s) =>
      s.sql.startsWith('DELETE FROM inquiry_answers'),
    );
    const inquiries = statements.findIndex((s) =>
      s.sql.startsWith('DELETE FROM inquiries'),
    );
    expect(answers > 0 && inquiries === answers + 1).toBe(true);
    expect(statements[answers].values).toEqual([['i-1', 'i-2']]);
    expect(statements[inquiries].values).toEqual([['i-1', 'i-2']]);
  });

  it('does nothing while another instance holds the lock', async () => {
    const { service, prisma, statements } = harness({ acquired: false });
    expect((await service.deleteBatch(dataRetentionConfig({}))) === null).toBe(
      true,
    );
    expect(statements.some((s) => s.sql.includes('DELETE'))).toBe(false);
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([]);
    // That instance does the work; this one looks again in an hour.
    now += 3_599_999;
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('is off with DATA_RETENTION_CLEANUP_ENABLED=false', async () => {
    process.env.DATA_RETENTION_CLEANUP_ENABLED = 'false';
    const { service, prisma } = harness();
    await service.runIfDue();
    now += 3_600_000;
    await service.runIfDue();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('stops after a short batch and runs again in an hour', async () => {
    const { service, prisma } = harness({
      sessions: [3],
      auditLogs: [DATA_RETENTION_BATCH - 1],
      inquiries: [['i-1']],
    });
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(logs.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        event: 'data_retention_completed',
        sessions: 3,
        auditLogs: DATA_RETENTION_BATCH - 1,
        inquiries: 1,
      },
    ]);
    now += 3_599_999;
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    now += 1;
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('works through a backlog: ten full batches, then again in a minute', async () => {
    const full = Array.from(
      { length: DATA_RETENTION_MAX_BATCHES },
      () => DATA_RETENTION_BATCH,
    );
    const { service, prisma } = harness({ auditLogs: full });
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(
      DATA_RETENTION_MAX_BATCHES,
    );
    expect(JSON.parse(logs[0]) as unknown).toEqual({
      event: 'data_retention_completed',
      sessions: 0,
      auditLogs: DATA_RETENTION_BATCH * DATA_RETENTION_MAX_BATCHES,
      inquiries: 0,
    });
    now += 59_999;
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(
      DATA_RETENTION_MAX_BATCHES,
    );
    now += 1;
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(
      DATA_RETENTION_MAX_BATCHES + 1,
    );
  });

  it('logs a fixed failure without details and retries on the next tick', async () => {
    const { service, prisma } = harness({ fail: true });
    await expect(service.runIfDue()).resolves.toBeUndefined();
    expect(logs).toEqual(['{"event":"data_retention_failed"}']);
    expect(logs.join(' ').includes('10.0.0.7')).toBe(false);
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('never starts a second run while one is in progress', async () => {
    const { service, prisma } = harness();
    let release!: () => void;
    prisma.$transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const running = service.runIfDue();
    await service.runIfDue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    release();
    await running;
  });
});
