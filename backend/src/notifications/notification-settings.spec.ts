jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { HttpException } from '@nestjs/common';
import {
  DEFAULT_PREFERENCES,
  NotificationPreferencesService,
  preferenceEnabled,
} from './notification-preferences.service';
import {
  EXPO_PUSH_TOKEN_PATTERN,
  PushDevicesService,
} from './push-devices.service';

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException)
      return (error.getResponse() as { error: { code: string } }).error.code;
    throw error;
  }
  return null;
}

describe('NotificationPreferencesService', () => {
  function service(row: Record<string, unknown> | null = null) {
    const upserts: Array<Record<string, unknown>> = [];
    const prisma = {
      notificationPreference: {
        findUnique: jest.fn(async () => row),
        upsert: jest.fn(async (args: Record<string, unknown>) => {
          upserts.push(args);
          return {
            userId: 'u1',
            ...DEFAULT_PREFERENCES,
            ...(args.update as object),
            updatedAt: new Date(),
          };
        }),
      },
    };
    return {
      preferences: new NotificationPreferencesService(prisma as never),
      upserts,
    };
  }

  it('starts with every type on', async () => {
    const result = await service().preferences.get('u1');
    expect(result.data.allEnabled).toBe(true);
    expect(result.data.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(
      Object.values(result.data.preferences).every((value) => value === true),
    ).toBe(true);
  });

  it('returns only the seven switches of a stored row, with 전체 알림 beside them', async () => {
    const result = await service({
      userId: 'u1',
      allEnabled: false,
      ...DEFAULT_PREFERENCES,
      tradeFill: false,
      updatedAt: new Date(),
    }).preferences.get('u1');
    expect(Object.keys(result.data.preferences)).toHaveLength(7);
    expect(result.data.preferences.tradeFill).toBe(false);
    expect(Object.keys(result.data)).toEqual(['allEnabled', 'preferences']);
    expect(result.data.allEnabled).toBe(false);
  });

  it('stores a partial update on top of the defaults', async () => {
    const { preferences, upserts } = service();
    const result = await preferences.update('u1', { orderFailure: false });
    expect(upserts[0]).toEqual({
      where: { userId: 'u1' },
      create: {
        userId: 'u1',
        allEnabled: true,
        ...DEFAULT_PREFERENCES,
        orderFailure: false,
      },
      update: { orderFailure: false },
    });
    expect(result.data.preferences.orderFailure).toBe(false);
    expect(result.data.preferences.tradeFill).toBe(true);
  });

  it('turns 전체 알림 off and on without rewriting any per-type switch', async () => {
    const { preferences, upserts } = service();
    const off = await preferences.update('u1', { allEnabled: false });
    expect(upserts[0].update).toEqual({ allEnabled: false });
    expect(upserts[0].create).toEqual({
      userId: 'u1',
      allEnabled: false,
      ...DEFAULT_PREFERENCES,
    });
    expect(off.data.allEnabled).toBe(false);
    expect(off.data.preferences).toEqual(DEFAULT_PREFERENCES);
    const on = await preferences.update('u1', { allEnabled: true });
    expect(upserts[1].update).toEqual({ allEnabled: true });
    expect(on.data.allEnabled).toBe(true);
  });

  it('rejects unknown keys, non-booleans, empty bodies and anonymous calls', async () => {
    const { preferences, upserts } = service();
    for (const body of [
      {},
      { marketing: true },
      { tradeFill: 'false' },
      { allEnabled: 'off' },
      { all: false },
      null,
      [],
    ])
      expect(await errorCode(preferences.update('u1', body))).toBe(
        'INVALID_NOTIFICATION_PREFERENCES',
      );
    expect(
      await errorCode(preferences.update(undefined, { tradeFill: true })),
    ).toBe('UNAUTHORIZED');
    expect(upserts).toHaveLength(0);
  });

  it('treats a missing row as on and honours each switch separately', () => {
    expect(preferenceEnabled(null, 'friend_request')).toBe(true);
    const row = { ...DEFAULT_PREFERENCES, friendRequest: false };
    expect(preferenceEnabled(row, 'friend_request')).toBe(false);
    expect(preferenceEnabled(row, 'important_notice')).toBe(true);
  });

  it('holds every type while 전체 알림 is off, whatever the per-type switch says', () => {
    const off = { allEnabled: false, ...DEFAULT_PREFERENCES };
    for (const type of [
      'trade_fill',
      'futures_liquidation',
      'order_failure',
      'friend_request',
      'important_notice',
      'season_final_result',
      'season_ending_soon',
    ] as const)
      expect(preferenceEnabled(off, type)).toBe(false);
    // Back on: the per-type switches decide again (a row from before the column reads as on).
    expect(
      preferenceEnabled(
        { allEnabled: true, ...DEFAULT_PREFERENCES, tradeFill: false },
        'trade_fill',
      ),
    ).toBe(false);
    expect(
      preferenceEnabled({ ...DEFAULT_PREFERENCES }, 'season_ending_soon'),
    ).toBe(true);
  });
});

describe('PushDevicesService', () => {
  const token = 'ExponentPushToken[abcDEF123]';

  function service(options: { conflictOnce?: boolean; stale?: string[] } = {}) {
    const upserts: Array<Record<string, unknown>> = [];
    const deletes: unknown[] = [];
    let conflicts = options.conflictOnce ? 1 : 0;
    const tx = {
      pushDevice: {
        upsert: jest.fn(async (args: Record<string, unknown>) => {
          if (conflicts-- > 0)
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          upserts.push(args);
          return {};
        }),
        findMany: jest.fn(async () =>
          (options.stale ?? []).map((id) => ({ id })),
        ),
        deleteMany: jest.fn(async (args: unknown) => {
          deletes.push(args);
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
        run(tx),
      ),
      pushDevice: {
        deleteMany: jest.fn(async (args: unknown) => {
          deletes.push(args);
          return { count: 0 };
        }),
      },
    };
    return {
      devices: new PushDevicesService(prisma as never),
      upserts,
      deletes,
    };
  }

  it('accepts Expo push tokens only', () => {
    expect(EXPO_PUSH_TOKEN_PATTERN.test(token)).toBe(true);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('ExpoPushToken[x]')).toBe(true);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('ExponentPushToken[]')).toBe(false);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('ExponentPushToken[a b]')).toBe(false);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('fcm-raw-token')).toBe(false);
  });

  it('moves a token to the user who registers it (account switch)', async () => {
    const { devices, upserts } = service();
    await devices.register('user-b', { token, platform: 'ios' });
    expect(upserts[0]).toMatchObject({
      where: { token },
      create: { userId: 'user-b', token, platform: 'ios' },
      update: { userId: 'user-b', platform: 'ios' },
    });
  });

  it('keeps at most the newest devices per user', async () => {
    const { devices, deletes } = service({ stale: ['old-1', 'old-2'] });
    await devices.register('u1', { token, platform: 'android' });
    expect(deletes).toEqual([{ where: { id: { in: ['old-1', 'old-2'] } } }]);
  });

  it('turns a racing first registration into an update', async () => {
    const { devices, upserts } = service({ conflictOnce: true });
    const result = await devices.register('u1', { token, platform: 'android' });
    expect(result.data.registered).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it('rejects malformed input and anonymous registration', async () => {
    const { devices, upserts } = service();
    expect(
      await errorCode(
        devices.register('u1', { token: 'nope', platform: 'ios' }),
      ),
    ).toBe('INVALID_PUSH_TOKEN');
    expect(
      await errorCode(devices.register('u1', { token, platform: 'web' })),
    ).toBe('INVALID_PUSH_PLATFORM');
    expect(
      await errorCode(devices.register(undefined, { token, platform: 'ios' })),
    ).toBe('UNAUTHORIZED');
    expect(upserts).toHaveLength(0);
  });

  it('releases by token with the same answer whether or not it was known', async () => {
    const { devices, deletes } = service();
    const result = await devices.release({ token });
    expect(result).toEqual({ success: true, data: { released: true } });
    expect(deletes).toEqual([{ where: { token } }]);
    expect(await errorCode(devices.release({ token: 'x' }))).toBe(
      'INVALID_PUSH_TOKEN',
    );
  });
});
