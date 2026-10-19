jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

import { performance } from 'node:perf_hooks';
import { EmailVerificationService } from './email-verification.service';

describe('email request timing envelope', () => {
  it('pads a fast/unknown-account request beyond the four-second provider timeout', async () => {
    const service = new EmailVerificationService({} as never, {} as never);
    const started = performance.now();
    await service.padResponse(started);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_990);
  }, 10_000);
});

import { Logger } from '@nestjs/common';
import { EmailAuthCleanupService } from './email-auth-cleanup.service';
import { ProfileImageCleanupWorker } from './profile-image-cleanup.worker';

describe('email retention maintenance boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it('fences overlap, backs off success, retries failure and survives a failed logger', async () => {
    const service = new EmailAuthCleanupService({} as never);
    let finish!: (value: { challenges: number; buckets: number }) => void;
    const pending = new Promise<{ challenges: number; buckets: number }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const batch = jest.spyOn(service, 'deleteBatch').mockReturnValue(pending);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw new Error('logging failure');
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logging failure');
    });
    const running = service.runIfDue();
    await service.runIfDue();
    expect(batch).toHaveBeenCalledTimes(1);
    finish({ challenges: 2, buckets: 1 });
    await running;
    await service.runIfDue();
    expect(batch).toHaveBeenCalledTimes(1);
    const retry = new EmailAuthCleanupService({} as never);
    const retryBatch = jest
      .spyOn(retry, 'deleteBatch')
      .mockRejectedValueOnce(new Error('private DB error'))
      .mockResolvedValue(null);
    await expect(retry.runIfDue()).resolves.toBeUndefined();
    await retry.runIfDue();
    expect(retryBatch).toHaveBeenCalledTimes(2);
  });
  it('uses the existing timer even without configured profile storage', async () => {
    const cleanup = { runIfDue: jest.fn().mockResolvedValue(undefined) };
    const images = { hasWork: jest.fn() };
    const worker = new ProfileImageCleanupWorker(
      { isConfigured: () => false } as never,
      images as never,
      {} as never,
      {} as never,
      cleanup as never,
    );
    await worker.tick();
    expect(cleanup.runIfDue).toHaveBeenCalledTimes(1);
    expect(images.hasWork).not.toHaveBeenCalled();
  });
});
