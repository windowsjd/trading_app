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
