jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
jest.mock('./push-notification-scanner.service', () => ({
  PushNotificationScanner: class {},
}));
jest.mock('./push-dispatcher.service', () => ({ PushDispatcher: class {} }));

import { PushNotificationWorker } from './push-notification.worker';

const now = new Date('2026-10-17T00:00:00.000Z');

function harness(
  options: { acquired?: boolean; dispatchFails?: boolean } = {},
) {
  const runs: Array<{
    status: string;
    resultJson?: unknown;
    errorCode?: string;
  }> = [];
  const released: unknown[] = [];
  const prisma = { $queryRaw: jest.fn(async () => [{ now }]) };
  const locks = {
    acquireLock: jest.fn(async () =>
      options.acquired === false
        ? { acquired: false }
        : { acquired: true, ownerId: 'owner-1' },
    ),
    extendLock: jest.fn(async () => true),
    releaseLock: jest.fn(async (args: unknown) => {
      released.push(args);
      return true;
    }),
  };
  const opsRuns = {
    createRunning: jest.fn(async () => ({ id: 'run-1', startedAt: now })),
    recordSucceeded: jest.fn(
      async (_run: unknown, input: { resultJson?: unknown }) => {
        runs.push({ status: 'succeeded', resultJson: input.resultJson });
      },
    ),
    recordFailed: jest.fn(
      async (
        _run: unknown,
        input: { errorCode: string; resultJson?: unknown },
      ) => {
        runs.push({
          status: 'failed',
          errorCode: input.errorCode,
          resultJson: input.resultJson,
        });
      },
    ),
  };
  const scanner = {
    scan: jest.fn(async () => ({
      created: { spot_fills: 2 },
      failedSources: [],
    })),
  };
  const dispatcher = {
    dispatch: jest.fn(async () => {
      if (options.dispatchFails) throw new Error('expo unreachable');
      return {
        claimed: 2,
        sent: 2,
        retried: 0,
        failed: 0,
        skipped: {},
        tickets: { ok: 2, error: 0 },
        devicesRemoved: 0,
      };
    }),
    checkReceipts: jest.fn(async () => ({
      checked: 0,
      ok: 0,
      error: 0,
      missing: 0,
      devicesRemoved: 0,
      failure: null,
    })),
    prune: jest.fn(async () => 0),
  };
  const worker = new PushNotificationWorker(
    prisma as never,
    locks as never,
    opsRuns as never,
    scanner as never,
    dispatcher as never,
  );
  return { worker, locks, scanner, dispatcher, runs, released };
}

describe('PushNotificationWorker', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('does nothing while disabled', async () => {
    process.env.PUSH_NOTIFICATIONS_ENABLED = 'false';
    const h = harness();
    h.worker.onModuleInit();
    await h.worker.tick();
    expect(h.locks.acquireLock).not.toHaveBeenCalled();
    h.worker.onModuleDestroy();
  });

  it('leaves the tick to the instance holding the lease', async () => {
    const h = harness({ acquired: false });
    await h.worker.tick();
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(h.runs).toHaveLength(0);
  });

  it('scans, dispatches, records and releases its lease', async () => {
    const h = harness();
    await h.worker.tick();
    expect(h.scanner.scan).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(h.released).toEqual([
      { lockKey: 'push_notifications:current', ownerId: 'owner-1' },
    ]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].status).toBe('succeeded');
    expect(h.runs[0].resultJson).toMatchObject({
      created: { spot_fills: 2 },
      sent: 2,
    });
    // The next tick inside the minute adds counts without another run row.
    await h.worker.tick();
    expect(h.runs).toHaveLength(1);
  });

  it('records a failed step and still releases the lease', async () => {
    const h = harness({ dispatchFails: true });
    await h.worker.tick();
    expect(h.runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'PUSH_NOTIFICATIONS_STEP_FAILED',
    });
    expect(
      (h.runs[0].resultJson as { failures: Record<string, number> }).failures,
    ).toEqual({
      dispatch: 1,
    });
    expect(h.released).toHaveLength(1);
  });
});
