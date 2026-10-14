jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./futures-conditional-entry.service', () => ({
  FuturesConditionalEntryService: class {},
}));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import { FuturesConditionalEntryWorker } from './futures-conditional-entry-worker.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OpsJobLockService } from '../ops/ops-job-lock.service';
import type { OpsJobRunService } from '../ops/ops-job-run.service';
import type { FuturesConditionalEntryService } from './futures-conditional-entry.service';

function fixture(count: number) {
  const ids = Array.from({ length: count }, (_, i) =>
    String(i).padStart(4, '0'),
  );
  const ended = new Set<string>();
  const findMany = jest.fn(
    (q: {
      where: { id: { gt: string }; status: { in: string[] } };
      take: number;
    }) => {
      expect(q.where.status.in.join(',')).toBe('watching,triggered');
      expect(q.take).toBe(101);
      return Promise.resolve(
        ids
          .filter((id) => id > q.where.id.gt && !ended.has(id))
          .slice(0, q.take)
          .map((id) => ({ id })),
      );
    },
  );
  const locks = {
    acquireLock: jest
      .fn()
      .mockResolvedValue({ acquired: true, ownerId: 'test' }),
    extendLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
  };
  const runs = {
    createRunning: jest.fn().mockResolvedValue('test-run'),
    recordSucceeded: jest.fn().mockResolvedValue(undefined),
  };
  const evaluate = jest.fn((id: string) => {
    void id;
    return Promise.resolve({ state: 'watching' });
  });
  const make = () =>
    new FuturesConditionalEntryWorker(
      { futuresConditionalEntry: { findMany } } as unknown as PrismaService,
      locks as unknown as OpsJobLockService,
      runs as unknown as OpsJobRunService,
      { evaluate } as unknown as FuturesConditionalEntryService,
    );
  const evaluated = () => evaluate.mock.calls.map(([id]) => id);
  return { ids, ended, make, locks, runs, evaluate, evaluated };
}

describe('Futures conditional entry bounded worker', () => {
  it.each([100, 101, 500])(
    'evaluates every one of %i live entries once per traversal and wraps',
    async (count) => {
      const f = fixture(count),
        worker = f.make();
      for (let batch = 0; batch < Math.ceil(count / 100); batch++) {
        const before = f.evaluated().length;
        await worker.tick();
        expect(f.evaluated().length - before).toBe(
          Math.min(100, count - batch * 100),
        );
      }
      expect(new Set(f.evaluated()).size).toBe(count);
      expect(f.evaluated().join(',')).toBe(f.ids.join(','));
      await worker.tick();
      expect(f.evaluated()[count]).toBe(f.ids[0]);
      // One lease renewal per evaluated entry, under the dedicated job name.
      expect(f.locks.extendLock.mock.calls.length).toBe(f.evaluated().length);
      expect(f.locks.acquireLock.mock.calls[0][0]).toMatchObject({
        jobName: 'futures_conditional_entries',
        lockKey: 'futures_conditional_entries:current',
      });
    },
  );

  it('skips a contended lease and resumes the cursor after lease loss', async () => {
    const f = fixture(500),
      worker = f.make();
    f.locks.acquireLock.mockResolvedValueOnce({ acquired: false });
    await worker.tick();
    expect(f.evaluated().length).toBe(0);
    f.locks.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await worker.tick();
    expect(f.evaluated().join(',')).toBe(f.ids[0]);
    for (let batch = 0; batch < 5; batch++) await worker.tick();
    expect(new Set(f.evaluated()).size).toBe(500);
    expect(f.evaluated().length).toBe(500);
  });

  it('skips ended entries and does nothing without live entries', async () => {
    const f = fixture(101),
      worker = f.make();
    await worker.tick();
    f.ended.add(f.ids[100]);
    await worker.tick();
    expect(f.evaluated().length).toBe(100);
    const empty = fixture(0);
    await empty.make().tick();
    expect(empty.locks.acquireLock.mock.calls.length).toBe(0);
  });

  it('contains evaluation errors under a fixed code and reports states', async () => {
    const f = fixture(100),
      worker = f.make();
    f.evaluate.mockRejectedValueOnce(new Error('private test detail'));
    const states = await worker.tick();
    expect(states?.FUTURES_CONDITIONAL_ENTRY_EVALUATION_FAILED).toBe(1);
    expect(states?.watching).toBe(99);
    expect(JSON.stringify(states).includes('private test detail')).toBe(false);
    expect(f.runs.recordSucceeded.mock.calls.length).toBe(1);
  });
});
