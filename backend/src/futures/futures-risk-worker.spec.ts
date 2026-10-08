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
import * as config from './futures.config';
describe('Risk worker failure boundaries', () => {
  const saved = { ...process.env };
  let locks: {
    acquireLock: jest.Mock;
    extendLock: jest.Mock;
    releaseLock: jest.Mock;
  };
  let runs: { createRunning: jest.Mock; recordSucceeded: jest.Mock };
  let liquidate: jest.Mock;
  let candidateScopes: jest.Mock;
  let scan: jest.Mock;
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
    candidateScopes = jest.fn().mockResolvedValue([
      { scope: 'cross', candidate: true },
      { scope: 'p3', candidate: true },
    ]);
    scan = jest.fn().mockResolvedValue([{ id: 'account' }]);
    const db = {
      $queryRaw: scan,
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
      { liquidate, candidateScopes } as unknown as FuturesLiquidationService,
    );
  });
  afterEach(() => {
    worker.onModuleDestroy();
    process.env = { ...saved };
    jest.restoreAllMocks();
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
        failureStage: 'risk_liquidation',
        failure: {
          code: 'FUTURES_RISK_TRANSACTION_FAILED',
          message: 'Background operation failed.',
          safeCause: expect.objectContaining({ category: 'unexpected_error' }),
        },
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
  it('healthy preview is an Ops state and never enters a financial transaction', async () => {
    candidateScopes.mockResolvedValue([{ scope: 'p3', candidate: false }]);
    await worker.tick();
    expect(liquidate).not.toHaveBeenCalled();
    expect(runs.recordSucceeded.mock.calls[0][1].resultJson.results).toEqual([
      { accountId: 'account', scope: 'p3', state: 'healthy' },
    ]);
  });
  function smallScan(ids: string[]) {
    jest.spyOn(config, 'futuresRiskConfig').mockReturnValue({
      enabled: true,
      ingestion: false,
      intervalMs: 1000,
      batchSize: 2,
      concurrency: 2,
    });
    scan.mockImplementation((_sql, cursor, limit) =>
      Promise.resolve(
        ids
          .filter((id) => id > cursor)
          .sort()
          .slice(0, limit)
          .map((id) => ({ id })),
      ),
    );
    candidateScopes.mockImplementation((id) =>
      Promise.resolve([{ scope: `${id}-position`, candidate: true }]),
    );
  }
  it('uses lookahead across batches and resets at an exact batch boundary without an idle tick', async () => {
    smallScan(['a', 'b', 'c', 'd']);
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(candidateScopes.mock.calls.flat()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'a',
      'b',
    ]);
    expect(scan.mock.calls.map((call) => call[1])).toEqual(['', 'b', '']);
  });
  it('visits accounts added behind the cursor on the next sweep and tolerates removed/closed accounts', async () => {
    const ids = ['a', 'b', 'c'];
    smallScan(ids);
    await worker.tick();
    ids.splice(2, 1, 'd');
    ids.push('aa');
    candidateScopes.mockImplementation((id) =>
      Promise.resolve(id === 'd' ? [] : [{ scope: id, candidate: true }]),
    );
    await worker.tick();
    await worker.tick();
    expect(candidateScopes.mock.calls.flat()).toEqual([
      'a',
      'b',
      'd',
      'a',
      'aa',
    ]);
  });
  it('empty cursor end resets and a restarted worker begins at the first current account', async () => {
    const ids = ['a', 'b', 'c'];
    smallScan(ids);
    await worker.tick();
    ids.length = 0;
    await worker.tick();
    ids.push('a');
    await worker.tick();
    expect(scan.mock.calls.map((call) => call[1])).toEqual(['', 'b', '']);
  });
  it('does not start account reads when another durable worker owns the lease', async () => {
    locks.acquireLock.mockResolvedValue({ acquired: false });
    await worker.tick();
    expect(candidateScopes).not.toHaveBeenCalled();
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });
  it('lease loss during a scope keeps the account cursor for safe replay', async () => {
    jest.spyOn(config, 'futuresRiskConfig').mockReturnValue({
      enabled: true,
      ingestion: false,
      intervalMs: 1000,
      batchSize: 2,
      concurrency: 1,
    });
    locks.extendLock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await worker.tick();
    expect(liquidate.mock.calls).toEqual([['account', 'cross']]);
    await worker.tick();
    expect(scan.mock.calls.map((call) => call[1])).toEqual(['', '']);
    expect(liquidate.mock.calls.slice(1)).toEqual([
      ['account', 'cross'],
      ['account', 'p3'],
    ]);
  });
  it('a slow account leaves other lanes able to visit later accounts without exceeding the bound', async () => {
    smallScan(['a', 'b']);
    let release!: () => void;
    liquidate.mockImplementation((id: string) =>
      id === 'a'
        ? new Promise((resolve) => {
            release = () => resolve({ state: 'healthy' });
          })
        : Promise.resolve({ state: 'healthy' }),
    );
    const tick = worker.tick();
    while (!release || liquidate.mock.calls.length < 2) await Promise.resolve();
    expect(liquidate.mock.calls).toEqual([
      ['a', 'a-position'],
      ['b', 'b-position'],
    ]);
    expect(locks.releaseLock).not.toHaveBeenCalled();
    release();
    await tick;
  });
  it('another lane cannot start work after observing lease loss while its renewal was pending', async () => {
    smallScan(['a', 'b']);
    const renewals: Array<(owned: boolean) => void> = [];
    locks.extendLock.mockImplementation(
      () => new Promise<boolean>((resolve) => renewals.push(resolve)),
    );
    const tick = worker.tick();
    while (renewals.length < 2) await Promise.resolve();
    renewals[0](false);
    await Promise.resolve();
    renewals[1](true);
    await tick;
    expect(candidateScopes).not.toHaveBeenCalled();
    expect(liquidate).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });
  it('drains started lanes before lease release on an account read failure', async () => {
    smallScan(['a', 'b']);
    let release!: () => void;
    candidateScopes.mockImplementation((id: string) =>
      id === 'a'
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve([{ scope: id, candidate: true }]),
    );
    liquidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ state: 'healthy' });
        }),
    );
    const tick = worker.tick();
    const rejected = expect(tick).rejects.toThrow('read failed');
    while (!release) await Promise.resolve();
    expect(locks.releaseLock).not.toHaveBeenCalled();
    await worker.tick();
    expect(locks.acquireLock).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
