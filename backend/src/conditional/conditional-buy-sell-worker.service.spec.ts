jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./conditional-buy.service', () => ({
  ConditionalBuyService: class {},
}));
jest.mock('./conditional-sell.service', () => ({
  ConditionalSellService: class {},
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
import { ConditionalBuyWorker } from './conditional-buy-worker.service';
import { ConditionalSellWorker } from './conditional-sell-worker.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OpsJobLockService } from '../ops/ops-job-lock.service';
import type { OpsJobRunService } from '../ops/ops-job-run.service';
import type { ConditionalBuyService } from './conditional-buy.service';
import type { ConditionalSellService } from './conditional-sell.service';

function fixture(kind: 'BUY' | 'SELL', count: number) {
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
  const prisma = {
    conditionalBuyOrder: { findMany },
    conditionalSellOrder: { findMany },
  };
  const make = () =>
    kind === 'BUY'
      ? new ConditionalBuyWorker(
          prisma as unknown as PrismaService,
          locks as unknown as OpsJobLockService,
          runs as unknown as OpsJobRunService,
          { evaluate } as unknown as ConditionalBuyService,
        )
      : new ConditionalSellWorker(
          prisma as unknown as PrismaService,
          locks as unknown as OpsJobLockService,
          runs as unknown as OpsJobRunService,
          { evaluate } as unknown as ConditionalSellService,
        );
  const evaluated = () => evaluate.mock.calls.map(([id]) => id);
  return { ids, ended, make, locks, evaluate, evaluated, findMany, runs };
}

describe.each(['BUY', 'SELL'] as const)('%s bounded worker', (kind) => {
  it('polls at one second and stops the timer on destruction', async () => {
    jest.useFakeTimers();
    const f = fixture(kind, 100),
      worker = f.make();
    try {
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(999);
      expect(f.evaluated().length).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(f.evaluated().length).toBe(100);
      worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(2000);
      expect(f.evaluated().length).toBe(100);
    } finally {
      worker.onModuleDestroy();
      jest.useRealTimers();
    }
  });
  it.each([100, 101, 500])(
    'evaluates every one of %i IDs once and wraps',
    async (count) => {
      const f = fixture(kind, count),
        worker = f.make();
      for (let batch = 0; batch < Math.ceil(count / 100); batch++) {
        const before = f.evaluated().length;
        await worker.tick();
        expect(f.evaluated().length - before).toBe(
          Math.min(100, count - batch * 100),
        );
      }
      expect(new Set(f.evaluated()).size).toBe(count);
      expect(f.ids.filter((id) => !f.evaluated().includes(id)).length).toBe(0);
      expect(f.evaluated().join(',')).toBe(f.ids.join(','));
      await worker.tick();
      expect(f.evaluated()[count]).toBe(f.ids[0]);
      await f.make().tick();
      expect(f.evaluated()[count + 100]).toBe(f.ids[0]);
    },
  );

  it('retries the same cursor after contention and resumes after lease loss', async () => {
    const f = fixture(kind, 500),
      worker = f.make();
    f.locks.acquireLock.mockResolvedValueOnce({ acquired: false });
    await worker.tick();
    expect(f.evaluated().length).toBe(0);
    f.locks.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await worker.tick();
    expect(f.evaluated().join(',')).toBe(f.ids[0]);
    await worker.tick();
    expect(f.evaluated()[1]).toBe(f.ids[1]);
    for (let batch = 0; batch < 4; batch++) await worker.tick();
    expect(new Set(f.evaluated()).size).toBe(500);
    expect(f.evaluated().length).toBe(500);
  });

  it('eventually covers a final short batch after lease loss', async () => {
    const f = fixture(kind, 100),
      worker = f.make();
    f.locks.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await worker.tick();
    await worker.tick();
    expect(new Set(f.evaluated()).size).toBe(100);
    // A short interrupted batch wraps; one safe re-evaluation is expected.
    expect(f.evaluated().length).toBe(101);
  });

  it('skips ended rows and clears an empty tail cursor', async () => {
    const f = fixture(kind, 101),
      worker = f.make();
    await worker.tick();
    f.ended.add(f.ids[100]);
    await worker.tick();
    expect(f.evaluated().length).toBe(100);
    f.ended.add(f.ids[0]);
    await worker.tick();
    expect(f.evaluated().slice(100).includes(f.ids[0])).toBe(false);
    expect(f.evaluated().slice(100).includes(f.ids[100])).toBe(false);
  });

  it('prevents overlapping ticks and recovers after release failure', async () => {
    const f = fixture(kind, 101),
      worker = f.make();
    let resume!: (value: { state: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.evaluate.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        resume = resolve;
      });
    });
    const active = worker.tick();
    await started;
    await worker.tick();
    expect(f.locks.acquireLock.mock.calls.length).toBe(1);
    resume({ state: 'watching' });
    await active;
    f.locks.releaseLock.mockRejectedValueOnce(
      new Error('test release failure'),
    );
    await expect(worker.tick()).rejects.toThrow('test release failure');
    await worker.tick();
    expect(f.evaluated().length).toBe(201);
  });

  it('contains evaluation errors and retries them next traversal', async () => {
    const f = fixture(kind, 100),
      worker = f.make();
    f.evaluate.mockRejectedValueOnce(new Error('private test detail'));
    const states = await worker.tick();
    expect(states?.[`CONDITIONAL_${kind}_EVALUATION_FAILED`]).toBe(1);
    expect(f.evaluated().length).toBe(100);
    expect(
      JSON.stringify(f.runs.recordSucceeded.mock.calls).includes(
        'private test detail',
      ),
    ).toBe(false);
    await worker.tick();
    expect(f.evaluated().length).toBe(200);
  });
});
