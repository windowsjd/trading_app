jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./conditional.service', () => ({ ConditionalService: class {} }));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { ConditionalWorker } from './conditional-worker.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OpsJobLockService } from '../ops/ops-job-lock.service';
import type { OpsJobRunService } from '../ops/ops-job-run.service';
import type { ConditionalService } from './conditional.service';
function fixture() {
  const ids = Array.from({ length: 203 }, (_, i) => String(i).padStart(4, '0'));
  const findMany = jest.fn(async (q) =>
    ids
      .filter((id) => id > q.where.id.gt)
      .slice(0, q.take)
      .map((id) => ({ id })),
  );
  const locks = {
    acquireLock: jest
      .fn()
      .mockResolvedValue({ acquired: true, ownerId: 'worker' }),
    extendLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn(),
  };
  const runs = {
    createRunning: jest.fn().mockResolvedValue('run'),
    recordSucceeded: jest.fn(),
  };
  const evaluate = jest.fn().mockResolvedValue({ state: 'disabled' });
  const make = () =>
    new ConditionalWorker(
      { protectionGroup: { findMany } } as unknown as PrismaService,
      locks as unknown as OpsJobLockService,
      runs as unknown as OpsJobRunService,
      { evaluate } as unknown as ConditionalService,
    );
  return { make, locks, runs, evaluate, findMany };
}
it('bounds each scan, renews the lease, and resumes after disabled/retry/restart', async () => {
  const f = fixture(),
    worker = f.make();
  await worker.tick();
  expect(f.evaluate).toHaveBeenCalledTimes(100);
  expect(f.findMany.mock.calls[0][0].take).toBe(101);
  await worker.tick();
  expect(f.evaluate).toHaveBeenCalledTimes(200);
  await worker.tick();
  expect(f.evaluate).toHaveBeenCalledTimes(203);
  await f.make().tick();
  expect(f.evaluate).toHaveBeenCalledTimes(303);
  expect(f.locks.extendLock).toHaveBeenCalledTimes(303);
  expect(f.locks.releaseLock).toHaveBeenCalledTimes(4);
});
it('duplicate lease loser does no evaluation and lost lease stops the batch', async () => {
  const f = fixture(),
    worker = f.make();
  f.locks.acquireLock.mockResolvedValueOnce({ acquired: false });
  await worker.tick();
  expect(f.evaluate).not.toHaveBeenCalled();
  f.locks.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await worker.tick();
  expect(f.evaluate).toHaveBeenCalledTimes(1);
  expect(f.locks.releaseLock).toHaveBeenCalledTimes(1);
});
it('failure leaves remaining candidates retryable and never exposes raw exception prose', async () => {
  const f = fixture();
  f.evaluate.mockRejectedValueOnce(new Error('private provider body'));
  const states = await f.make().tick();
  expect(states).toEqual({ CONDITIONAL_EVALUATION_FAILED: 1, disabled: 99 });
  expect(JSON.stringify(f.runs.recordSucceeded.mock.calls)).not.toContain(
    'private provider',
  );
});

it('retries after a lease-release DB failure instead of remaining stuck running', async () => {
  const f = fixture(),
    worker = f.make();
  f.locks.releaseLock.mockRejectedValueOnce(
    new Error('temporary database failure'),
  );
  await expect(worker.tick()).rejects.toThrow('temporary database failure');
  await worker.tick();
  expect(f.evaluate).toHaveBeenCalledTimes(200);
});
