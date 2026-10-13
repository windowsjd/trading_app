import { OpsJobName } from '../../src/generated/prisma/enums';
import {
  runLongBackfillGroup,
  type LongBackfillGroup,
  type LongBackfillResults,
} from './candle-long-backfill-run';

function summary(runFailed = false) {
  return { market: 'spot', runFailed } as never;
}

function harness(overrides: Partial<LongBackfillGroup> = {}) {
  const locks = {
    acquireLock: jest.fn().mockResolvedValue({
      acquired: true,
      lockKey: 'market_candle_long_sync',
      ownerId: 'cli-owner',
      expiresAt: new Date(Date.now() + 900_000),
    }),
    extendLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
  };
  const runs = {
    createRunning: jest.fn().mockResolvedValue({ id: 'run-1' }),
    recordSucceeded: jest.fn().mockResolvedValue({}),
    recordFailed: jest.fn().mockResolvedValue({}),
  };
  const operator = new AbortController();
  const group: LongBackfillGroup = {
    locks: locks as never,
    runs: runs as never,
    jobName: OpsJobName.market_candle_long_sync,
    lockKey: 'market_candle_long_sync',
    apply: true,
    metadataJson: { markets: ['spot'] },
    signal: operator.signal,
    execute: jest.fn().mockResolvedValue({ spot: summary() }),
    ...overrides,
  };
  const failureCode = () =>
    (runs.recordFailed.mock.calls[0] as [unknown, { errorCode: string }])[1]
      .errorCode;
  return { locks, runs, operator, group, failureCode };
}

/** Resolves with the given results once the group signal aborts. */
function untilAborted(results: LongBackfillResults) {
  return (signal: AbortSignal) =>
    new Promise<LongBackfillResults>((resolve) => {
      signal.addEventListener('abort', () => resolve(results), { once: true });
    });
}

describe('runLongBackfillGroup', () => {
  it('plans without the Ops lock or a run record, and a stopped plan is not a success', async () => {
    const h = harness({ apply: false });
    expect(await runLongBackfillGroup(h.group)).toBe(true);
    expect(h.locks.acquireLock).not.toHaveBeenCalled();
    expect(h.runs.createRunning).not.toHaveBeenCalled();

    const stopped = harness({ apply: false });
    stopped.operator.abort();
    expect(await runLongBackfillGroup(stopped.group)).toBe(false);
  });

  it('starts nothing while another run holds the Ops job lock', async () => {
    const h = harness();
    h.locks.acquireLock.mockResolvedValueOnce({
      acquired: false,
      lockKey: 'market_candle_long_sync',
      activeOwnerId: 'scheduler',
      expiresAt: new Date(),
    });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runLongBackfillGroup(h.group)).toBe(false);
    quiet.mockRestore();
    expect(h.runs.createRunning).not.toHaveBeenCalled();
    expect(h.group.execute).not.toHaveBeenCalled();
    expect(h.locks.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the lock when the run record cannot be created', async () => {
    const h = harness();
    h.runs.createRunning.mockRejectedValueOnce(new Error('db down'));
    let message = '';
    await runLongBackfillGroup(h.group).catch((error: Error) => {
      message = error.message;
    });
    expect(message).toBe('db down');
    expect(h.group.execute).not.toHaveBeenCalled();
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('records success only when every market completed', async () => {
    const h = harness();
    expect(await runLongBackfillGroup(h.group)).toBe(true);
    expect(h.runs.recordSucceeded).toHaveBeenCalledTimes(1);
    expect(h.runs.recordFailed).not.toHaveBeenCalled();
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('records a failed series as a failed run and keeps the partial results', async () => {
    const h = harness({
      execute: jest
        .fn()
        .mockResolvedValue({ spot: summary(), krx: summary(true) }),
    });
    expect(await runLongBackfillGroup(h.group)).toBe(false);
    expect(h.runs.recordSucceeded).not.toHaveBeenCalled();
    expect(h.failureCode()).toBe('MARKET_CANDLE_LONG_BACKFILL_FAILED');
    const [, failure] = h.runs.recordFailed.mock.calls[0] as [
      unknown,
      { resultJson: LongBackfillResults },
    ];
    expect(Object.keys(failure.resultJson).join(',')).toBe('spot,krx');
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('records an operator stop as canceled, not succeeded', async () => {
    const h = harness();
    h.group.execute = jest.fn((signal: AbortSignal) => {
      h.operator.abort();
      expect(signal.aborted).toBe(true);
      return Promise.resolve({ spot: summary() });
    });
    expect(await runLongBackfillGroup(h.group)).toBe(false);
    expect(h.runs.recordSucceeded).not.toHaveBeenCalled();
    expect(h.failureCode()).toBe('MARKET_CANDLE_LONG_BACKFILL_CANCELED');
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['refused', () => Promise.resolve(false)],
    ['rejected', () => Promise.reject(new Error('db down'))],
  ])(
    'stops the work and records OPS_JOB_LOCK_LOST when a renewal is %s',
    async (_label, renewal) => {
      const h = harness({
        extendEveryMs: 5,
        execute: jest.fn(untilAborted({ spot: summary() })),
      });
      h.locks.extendLock.mockImplementation(renewal);
      expect(await runLongBackfillGroup(h.group)).toBe(false);
      expect(h.runs.recordSucceeded).not.toHaveBeenCalled();
      expect(h.failureCode()).toBe('OPS_JOB_LOCK_LOST');
      expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
    },
  );

  it('treats a renewal that answers after the lease deadline as lost', async () => {
    const h = harness({
      lockTtlSeconds: 0.05,
      extendEveryMs: 5,
      execute: jest.fn(untilAborted({ spot: summary() })),
    });
    h.locks.extendLock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 120)),
    );
    expect(await runLongBackfillGroup(h.group)).toBe(false);
    expect(h.failureCode()).toBe('OPS_JOB_LOCK_LOST');
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('records a thrown error as failed, rethrows it and releases the lock', async () => {
    const h = harness({
      execute: jest.fn().mockRejectedValue(new Error('storage failed')),
    });
    let message = '';
    await runLongBackfillGroup(h.group).catch((error: Error) => {
      message = error.message;
    });
    expect(message).toBe('storage failed');
    expect(h.failureCode()).toBe('MARKET_CANDLE_LONG_BACKFILL_FAILED');
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('reports a thrown error after a lost lease as OPS_JOB_LOCK_LOST', async () => {
    const h = harness({
      extendEveryMs: 5,
      execute: jest.fn(
        (signal: AbortSignal) =>
          new Promise<LongBackfillResults>((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new Error('aborted write')),
            );
          }),
      ),
    });
    h.locks.extendLock.mockResolvedValue(false);
    await runLongBackfillGroup(h.group).catch(() => undefined);
    expect(h.failureCode()).toBe('OPS_JOB_LOCK_LOST');
    expect(h.locks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
