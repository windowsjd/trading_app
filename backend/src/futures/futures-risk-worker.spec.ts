jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./futures-liquidation.service', () => ({
  FuturesLiquidationService: class {},
}));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
import { HttpException } from '@nestjs/common';
import { FuturesRiskWorker } from './futures-risk-worker.service';
import { PrismaService } from '../prisma/prisma.service';
import { FuturesLiquidationService } from './futures-liquidation.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
describe('Risk worker failure boundaries', () => {
  const saved = { ...process.env };
  let locks: {
    acquireLock: jest.Mock;
    extendLock: jest.Mock;
    releaseLock: jest.Mock;
  };
  let runs: { createRunning: jest.Mock; recordSucceeded: jest.Mock };
  let liquidate: jest.Mock;
  let worker: FuturesRiskWorker;
  beforeEach(() => {
    process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    locks = {
      acquireLock: jest
        .fn()
        .mockResolvedValue({ acquired: true, ownerId: 'owner' }),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    runs = {
      createRunning: jest
        .fn()
        .mockResolvedValue({ id: 'run', startedAt: new Date() }),
      recordSucceeded: jest.fn().mockResolvedValue({}),
    };
    liquidate = jest.fn().mockResolvedValue({ state: 'healthy' });
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'account' }]),
      futuresPosition: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', marginMode: 'cross' },
          { id: 'p2', marginMode: 'cross' },
          { id: 'p3', marginMode: 'isolated' },
        ]),
      },
    };
    worker = new FuturesRiskWorker(
      db as unknown as PrismaService,
      locks as unknown as OpsJobLockService,
      runs as unknown as OpsJobRunService,
      { liquidate } as unknown as FuturesLiquidationService,
    );
  });
  afterEach(() => {
    worker.onModuleDestroy();
    process.env = { ...saved };
  });
  it('evaluates one Cross scope and one Isolated scope while user mode is disabled', async () => {
    await worker.tick();
    expect(liquidate.mock.calls).toEqual([
      ['account', 'cross'],
      ['account', 'p3'],
    ]);
  });
  it('stops before financial work when the PostgreSQL lease cannot be renewed', async () => {
    locks.extendLock.mockResolvedValue(false);
    await worker.tick();
    expect(liquidate).not.toHaveBeenCalled();
  });
  it('records unavailable marks without fabricating a close and continues other scopes', async () => {
    liquidate.mockRejectedValueOnce(
      new HttpException({ error: { code: 'FUTURES_MARK_STALE' } }, 503),
    );
    await worker.tick();
    expect(liquidate).toHaveBeenCalledTimes(2);
    expect(
      runs.recordSucceeded.mock.calls[0][1].resultJson.results[0].state,
    ).toBe('FUTURES_MARK_STALE');
  });
  it('a lock release failure cannot permanently suppress subsequent risk ticks', async () => {
    locks.releaseLock.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(worker.tick()).rejects.toThrow('DB unavailable');
    await worker.tick();
    expect(locks.acquireLock).toHaveBeenCalledTimes(2);
  });
  it.each(['error', 'string-code', 'object-code', 'null-body', 'unknown-code'])(
    'keeps raw %s failures out of Ops results without removing account/scope',
    async (kind) => {
      const raw =
        'https://provider.invalid/private postgres://fake:password@db.invalid/db Bearer fake-token 987654.12345678 {"secret":"fake-nested-secret"}';
      const error =
        kind === 'error'
          ? new Error(raw, { cause: new Error(raw) })
          : new HttpException(
              {
                error:
                  kind === 'null-body'
                    ? null
                    : {
                        code:
                          kind === 'object-code'
                            ? { message: raw }
                            : kind === 'unknown-code'
                              ? 'UNREVIEWED_FAILURE_CODE'
                              : raw,
                        message: raw,
                        cause: raw,
                      },
              },
              500,
            );
      liquidate.mockRejectedValueOnce(error);
      await worker.tick();
      const result = runs.recordSucceeded.mock.calls[0][1].resultJson;
      expect(result.results[0]).toEqual({
        accountId: 'account',
        scope: 'cross',
        state: 'FUTURES_RISK_TRANSACTION_FAILED',
      });
      expect(result.results[1]).toEqual({
        accountId: 'account',
        scope: 'p3',
        state: 'healthy',
      });
      expect(JSON.stringify(result)).not.toMatch(
        /provider.invalid|db.invalid|fake-token|987654|fake-nested-secret|UNREVIEWED_FAILURE_CODE/,
      );
    },
  );
  it('deduplicates scheduler overlap in one process and respects the separate emergency stop', async () => {
    let release!: () => void;
    liquidate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ state: 'healthy' });
        }),
    );
    const first = worker.tick();
    while (!release) await Promise.resolve();
    await worker.tick();
    expect(locks.acquireLock).toHaveBeenCalledTimes(1);
    release();
    await first;
    process.env.FUTURES_RISK_ENGINE_ENABLED = 'false';
    await worker.tick();
    expect(locks.acquireLock).toHaveBeenCalledTimes(1);
  });
});
