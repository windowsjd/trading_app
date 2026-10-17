import { HttpStatus, Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type { PushDevicePlatform } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { pushNotificationsConfig } from './push-notifications.config';

/** Same rule as the push_devices_token_format_check SQL CHECK. */
export const EXPO_PUSH_TOKEN_PATTERN =
  /^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/;

const PLATFORMS: readonly PushDevicePlatform[] = ['ios', 'android'];

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Device registrations (docs/push-notifications-contract.md §3).
 *
 * - Register needs an access token: the token is owned by the signed-in user
 *   from now on (an account switch on one device moves it). The dispatcher
 *   re-reads ownership before every request, so A's later pushes do not go
 *   to a device where B signed in.
 * - Release needs only the token itself (proof of possession, like
 *   /auth/logout's refresh token): a signed-out app, a reinstall or a revoked
 *   OS permission can always drop the registration. The answer never says
 *   whether the token was known.
 * Token values are never logged or echoed.
 */
@Injectable()
export class PushDevicesService {
  constructor(private readonly prisma: PrismaService) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw createApiError(code, message, status);
  }

  private token(body: unknown): string {
    const token = (body as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !EXPO_PUSH_TOKEN_PATTERN.test(token))
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_PUSH_TOKEN',
        'A valid Expo push token is required.',
      );
    return token;
  }

  async register(userId: string | undefined, body: unknown) {
    if (!userId)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    const token = this.token(body);
    const platform = (body as { platform?: unknown }).platform;
    if (
      typeof platform !== 'string' ||
      !(PLATFORMS as readonly string[]).includes(platform)
    )
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_PUSH_PLATFORM',
        'Platform must be ios or android.',
      );
    const { maxDevicesPerUser } = pushNotificationsConfig();
    const write = () =>
      this.prisma.$transaction(async (tx) => {
        const registeredAt = new Date();
        await tx.pushDevice.upsert({
          where: { token },
          create: {
            userId,
            token,
            platform: platform as PushDevicePlatform,
            registeredAt,
          },
          update: {
            userId,
            platform: platform as PushDevicePlatform,
            registeredAt,
          },
        });
        // Old installs that never released stay bounded per user.
        const stale = await tx.pushDevice.findMany({
          where: { userId },
          orderBy: [{ registeredAt: 'desc' }, { id: 'desc' }],
          skip: maxDevicesPerUser,
          select: { id: true },
        });
        if (stale.length)
          await tx.pushDevice.deleteMany({
            where: { id: { in: stale.map((device) => device.id) } },
          });
      });
    try {
      await write();
    } catch (error) {
      // Two first registrations of one token raced on the unique key; the
      // second becomes an ownership update.
      if (!isUniqueViolation(error)) throw error;
      await write();
    }
    return { success: true, data: { registered: true } };
  }

  async release(body: unknown) {
    const token = this.token(body);
    await this.prisma.pushDevice.deleteMany({ where: { token } });
    return { success: true, data: { released: true } };
  }
}
