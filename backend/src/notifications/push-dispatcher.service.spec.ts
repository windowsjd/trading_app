jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import {
  decideOutcome,
  packGroups,
  PushDispatcher,
  type ClaimedNotification,
} from './push-dispatcher.service';
import type { ExpoSendResult } from './expo-push.client';
import { pushNotificationsConfig } from './push-notifications.config';

const now = new Date('2026-10-17T00:00:00.000Z');
const config = pushNotificationsConfig({});

function claimed(
  overrides: Partial<ClaimedNotification> = {},
): ClaimedNotification {
  return {
    id: 'n1',
    userId: 'u1',
    type: 'trade_fill',
    sourceKey: 'order:o1',
    title: '삼성전자 매수 체결 완료',
    body: '일반모드 · 시장가 · 체결 수량 1',
    data: {
      v: 1,
      type: 'trade_fill',
      uid: 'u1',
      accountId: 'a1',
      market: 'spot',
    },
    expiresAt: new Date(now.getTime() + 3_600_000),
    attemptCount: 1,
    ...overrides,
  };
}

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    rows?: ClaimedNotification[];
    users?: Array<{ id: string; status: string }>;
    preferences?: Array<Record<string, unknown>>;
    devices?: Array<{
      id: string;
      userId: string;
      token: string;
      registeredAt: Date;
    }>;
    /** Devices as re-read right before a request (default: `devices`). */
    currentDevices?: Array<{ id: string; userId: string; token: string }>;
    deliveryFailOnce?: boolean;
    send?: (count: number) => ExpoSendResult;
    friendships?: Array<{ id: string; requesterUserId: string }>;
    seasons?: Array<{ id: string; status: string; endAt: Date }>;
    participants?: Array<{ seasonId: string; userId: string }>;
    notices?: Array<{ id: string }>;
  } = {},
) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const deliveries: unknown[] = [];
  const deletedDevices: unknown[] = [];
  const sent: unknown[][] = [];
  let deviceReads = 0;
  let deliveryFailures = options.deliveryFailOnce ? 1 : 0;
  const prisma = {
    // claimRows: the boolean value selects the important-notice phase.
    $queryRaw: jest.fn(async (_sql: unknown, ...values: unknown[]) => {
      const notices = values.find((value) => typeof value === 'boolean');
      return (options.rows ?? [claimed()]).filter(
        (row) => (row.type === 'important_notice') === notices,
      );
    }),
    user: {
      findMany: jest.fn(
        async () => options.users ?? [{ id: 'u1', status: 'active' }],
      ),
    },
    notificationPreference: {
      findMany: jest.fn(async () => options.preferences ?? []),
    },
    pushDevice: {
      findMany: jest.fn(async () => {
        const loaded = options.devices ?? [
          {
            id: 'd1',
            userId: 'u1',
            token: 'ExponentPushToken[one]',
            registeredAt: now,
          },
        ];
        // The first read loads the devices; later reads are the re-checks.
        return deviceReads++ === 0
          ? loaded
          : (options.currentDevices ?? loaded);
      }),
      deleteMany: jest.fn(async (args: unknown) => {
        deletedDevices.push(args);
        return { count: 1 };
      }),
    },
    friendship: { findMany: jest.fn(async () => options.friendships ?? []) },
    season: { findMany: jest.fn(async () => options.seasons ?? []) },
    seasonParticipant: {
      findMany: jest.fn(async () => options.participants ?? []),
    },
    importantNotice: { findMany: jest.fn(async () => options.notices ?? []) },
    pushDelivery: {
      createMany: jest.fn(async (args: { data: unknown[] }) => {
        if (deliveryFailures-- > 0)
          throw Object.assign(new Error('foreign key'), { code: 'P2003' });
        deliveries.push(...args.data);
        return { count: args.data.length };
      }),
    },
    pushNotification: {
      updateMany: jest.fn(
        async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        },
      ),
    },
  };
  const expo = {
    send: jest.fn(async (_endpoint: unknown, messages: unknown[]) => {
      sent.push(messages);
      return options.send
        ? options.send(messages.length)
        : {
            kind: 'tickets' as const,
            tickets: messages.map((_, i) => ({
              ok: true as const,
              id: `t${i}`,
            })),
          };
    }),
    getReceipts: jest.fn(),
  };
  const dispatcher = new PushDispatcher(prisma as never, expo as never);
  return {
    dispatcher,
    prisma,
    expo,
    updates,
    deliveries,
    deletedDevices,
    sent,
  };
}

function statusOf(h: Harness, id = 'n1') {
  const update = h.updates.find((item) =>
    ((item.where as { id: { in: string[] } }).id.in ?? []).includes(id),
  );
  return update?.data;
}

describe('decideOutcome', () => {
  it('is sent when any device accepted it', () => {
    expect(
      decideOutcome(
        claimed(),
        [{ ok: false, code: 'X' }, { ok: true }],
        now,
        config,
      ),
    ).toEqual({
      kind: 'sent',
    });
  });

  it('retries a retryable failure with backoff, then gives up', () => {
    const first = decideOutcome(
      claimed({ attemptCount: 1 }),
      [{ ok: false, code: 'TOO_MANY_REQUESTS', retryable: true }],
      now,
      config,
    );
    expect(first).toEqual({
      kind: 'retry',
      code: 'TOO_MANY_REQUESTS',
      nextAttemptAt: new Date(now.getTime() + config.retryDelaysMs[0]),
    });
    expect(
      decideOutcome(
        claimed({ attemptCount: config.maxAttempts }),
        [{ ok: false, code: 'TOO_MANY_REQUESTS', retryable: true }],
        now,
        config,
      ),
    ).toEqual({ kind: 'failed', code: 'TOO_MANY_REQUESTS' });
  });

  it('does not schedule a retry past the expiry', () => {
    expect(
      decideOutcome(
        claimed({ expiresAt: new Date(now.getTime() + 1000) }),
        [{ ok: false, code: 'EXPO_TRANSPORT_ERROR', retryable: true }],
        now,
        config,
      ),
    ).toEqual({ kind: 'failed', code: 'EXPO_TRANSPORT_ERROR' });
  });

  it('fails permanent errors immediately', () => {
    expect(
      decideOutcome(
        claimed(),
        [{ ok: false, code: 'DeviceNotRegistered' }],
        now,
        config,
      ),
    ).toEqual({ kind: 'failed', code: 'DeviceNotRegistered' });
  });
});

describe('PushDispatcher.dispatch', () => {
  it('sends to every device of the recipient with the app payload', async () => {
    const h = harness({
      devices: [
        {
          id: 'd1',
          userId: 'u1',
          token: 'ExponentPushToken[one]',
          registeredAt: now,
        },
        {
          id: 'd2',
          userId: 'u1',
          token: 'ExponentPushToken[two]',
          registeredAt: now,
        },
      ],
    });
    const summary = await h.dispatcher.dispatch(now, config);
    expect(summary.sent).toBe(1);
    expect(h.sent).toHaveLength(1);
    const messages = h.sent[0] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.to)).toEqual([
      'ExponentPushToken[one]',
      'ExponentPushToken[two]',
    ]);
    expect(messages[0]).toMatchObject({
      channelId: 'default',
      priority: 'high',
      sound: 'default',
      ttl: 3600,
      data: { uid: 'u1', accountId: 'a1' },
    });
    expect(statusOf(h)).toMatchObject({ status: 'sent', sentAt: now });
    expect(h.deliveries).toHaveLength(2);
  });

  it('skips without sending when policy says so', async () => {
    const cases: Array<[Parameters<typeof harness>[0], string]> = [
      [{ rows: [claimed({ expiresAt: now })] }, 'expired'],
      [{ users: [{ id: 'u1', status: 'suspended' }] }, 'user_inactive'],
      [
        { preferences: [{ userId: 'u1', tradeFill: false }] },
        'preference_disabled',
      ],
      [{ devices: [] }, 'no_device'],
    ];
    for (const [options, reason] of cases) {
      const h = harness(options);
      await h.dispatcher.dispatch(now, config);
      expect(h.sent).toHaveLength(0);
      expect(statusOf(h)).toMatchObject({
        status: 'skipped',
        skipReason: reason,
      });
    }
    const dry = harness();
    await dry.dispatcher.dispatch(now, { ...config, dryRun: true });
    expect(dry.sent).toHaveLength(0);
    expect(statusOf(dry)).toMatchObject({
      status: 'skipped',
      skipReason: 'dry_run',
    });
  });

  it('keeps another type on when one type is off', async () => {
    const h = harness({
      rows: [
        claimed({
          type: 'futures_liquidation',
          sourceKey: 'futures_liquidation:l1',
        }),
      ],
      preferences: [
        { userId: 'u1', tradeFill: false, futuresLiquidation: true },
      ],
    });
    await h.dispatcher.dispatch(now, config);
    expect(statusOf(h)).toMatchObject({ status: 'sent' });
  });

  it('re-validates sources that can go stale before sending', async () => {
    const friend = claimed({
      id: 'n-friend',
      type: 'friend_request',
      sourceKey: 'friend:u2:f1',
    });
    const ending = claimed({
      id: 'n-ending',
      type: 'season_ending_soon',
      sourceKey: `season_ending:s1:${now.getTime() + 3_600_000}`,
    });
    const notice = claimed({
      id: 'n-notice',
      type: 'important_notice',
      sourceKey: 'notice:notice-1',
    });
    const h = harness({
      rows: [friend, ending, notice],
      // The request was rejected, the Season end moved, the notice withdrawn.
      friendships: [],
      seasons: [
        {
          id: 's1',
          status: 'active',
          endAt: new Date(now.getTime() + 7_200_000),
        },
      ],
      participants: [{ seasonId: 's1', userId: 'u1' }],
      notices: [],
    });
    await h.dispatcher.dispatch(now, config);
    expect(h.sent).toHaveLength(0);
    for (const id of ['n-friend', 'n-ending', 'n-notice'])
      expect(statusOf(h, id)).toMatchObject({
        status: 'skipped',
        skipReason: 'source_invalid',
      });
  });

  it('sends a still-pending request and an unchanged Season end', async () => {
    const endAt = new Date(now.getTime() + 3_600_000);
    const h = harness({
      rows: [
        claimed({
          id: 'n-friend',
          type: 'friend_request',
          sourceKey: 'friend:u2:f1',
        }),
        claimed({
          id: 'n-ending',
          type: 'season_ending_soon',
          sourceKey: `season_ending:s1:${endAt.getTime()}`,
        }),
      ],
      friendships: [{ id: 'f1', requesterUserId: 'u2' }],
      seasons: [{ id: 's1', status: 'active', endAt }],
      participants: [{ seasonId: 's1', userId: 'u1' }],
    });
    await h.dispatcher.dispatch(now, config);
    expect(statusOf(h, 'n-friend')).toMatchObject({ status: 'sent' });
    expect(statusOf(h, 'n-ending')).toMatchObject({ status: 'sent' });
  });

  it('does not send an ending-soon to someone who left the Season', async () => {
    const endAt = new Date(now.getTime() + 3_600_000);
    const h = harness({
      rows: [
        claimed({
          type: 'season_ending_soon',
          sourceKey: `season_ending:s1:${endAt.getTime()}`,
        }),
      ],
      seasons: [{ id: 's1', status: 'active', endAt }],
      participants: [],
    });
    await h.dispatcher.dispatch(now, config);
    expect(statusOf(h)).toMatchObject({ skipReason: 'source_invalid' });
  });

  it('removes a device Expo reports as not registered, guarded by its registration time', async () => {
    const h = harness({
      send: () => ({
        kind: 'tickets',
        tickets: [{ ok: false, error: 'DeviceNotRegistered' }],
      }),
    });
    const summary = await h.dispatcher.dispatch(now, config);
    expect(summary.devicesRemoved).toBe(1);
    expect(h.deletedDevices).toEqual([
      { where: { id: 'd1', registeredAt: { lte: now } } },
    ]);
    expect(statusOf(h)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'DeviceNotRegistered',
    });
  });

  it('retries a transport failure without recording tickets', async () => {
    const h = harness({
      send: () => ({
        kind: 'failed',
        retryable: true,
        code: 'EXPO_TRANSPORT_ERROR',
      }),
    });
    const summary = await h.dispatcher.dispatch(now, config);
    expect(summary.retried).toBe(1);
    expect(h.deliveries).toHaveLength(0);
    expect(statusOf(h)).toMatchObject({
      status: 'pending',
      lastErrorCode: 'EXPO_TRANSPORT_ERROR',
      nextAttemptAt: new Date(now.getTime() + config.retryDelaysMs[0]),
    });
  });

  it('returns unsent rows to the queue once the send budget is used', async () => {
    const h = harness({
      rows: [claimed({ id: 'n1' }), claimed({ id: 'n2', userId: 'u2' })],
      users: [
        { id: 'u1', status: 'active' },
        { id: 'u2', status: 'active' },
      ],
      devices: [
        {
          id: 'd1',
          userId: 'u1',
          token: 'ExponentPushToken[one]',
          registeredAt: now,
        },
        {
          id: 'd2',
          userId: 'u2',
          token: 'ExponentPushToken[two]',
          registeredAt: now,
        },
      ],
    });
    // One message per request and a budget that ends after the first send.
    let clock = 0;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    h.expo.send.mockImplementation(
      async (_endpoint: unknown, messages: unknown[]) => {
        clock += config.claimLeaseMs;
        h.sent.push(messages);
        return {
          kind: 'tickets' as const,
          tickets: messages.map(() => ({ ok: true as const, id: 't' })),
        };
      },
    );
    try {
      await h.dispatcher.dispatch(now, { ...config, sendChunkSize: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(h.sent).toHaveLength(1);
    expect(statusOf(h, 'n1')).toMatchObject({ status: 'sent' });
    expect(statusOf(h, 'n2')).toMatchObject({
      status: 'pending',
      lastErrorCode: 'PUSH_SEND_DEFERRED',
      nextAttemptAt: now,
    });
  });

  it('claims trading outcomes first and notices only with the room left', async () => {
    const fill = claimed({ id: 'fill' });
    const notice = claimed({
      id: 'notice',
      type: 'important_notice',
      sourceKey: 'notice:x',
    });
    const full = harness({ rows: [fill, notice] });
    await full.dispatcher.dispatch(now, { ...config, dispatchBatchSize: 1 });
    // The fill used the whole batch: the notice phase never ran.
    expect(full.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const room = harness({ rows: [fill, notice], notices: [{ id: 'x' }] });
    await room.dispatcher.dispatch(now, { ...config, dispatchBatchSize: 5 });
    expect(room.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(statusOf(room, 'fill')).toMatchObject({ status: 'sent' });
    expect(statusOf(room, 'notice')).toMatchObject({ status: 'sent' });
  });

  it('does not send to a device released or taken over after the claim', async () => {
    const h = harness({
      currentDevices: [
        { id: 'd1', userId: 'someone-else', token: 'ExponentPushToken[one]' },
      ],
    });
    await h.dispatcher.dispatch(now, config);
    expect(h.sent).toHaveLength(0);
    expect(statusOf(h)).toMatchObject({
      status: 'skipped',
      skipReason: 'no_device',
    });
  });

  it('records the outcome even when the delivery link cannot be stored', async () => {
    const h = harness({ deliveryFailOnce: true });
    await h.dispatcher.dispatch(now, config);
    // Written before the deliveries: nothing is left to be resent.
    expect(statusOf(h)).toMatchObject({ status: 'sent' });
    expect(h.deliveries).toEqual([
      expect.objectContaining({ ticketId: 't0', deviceId: null }),
    ]);
  });

  it('sends each message alone when Expo rejects a whole request', async () => {
    const h = harness({
      rows: [claimed({ id: 'n1' }), claimed({ id: 'n2', userId: 'u2' })],
      users: [
        { id: 'u1', status: 'active' },
        { id: 'u2', status: 'active' },
      ],
      devices: [
        {
          id: 'd1',
          userId: 'u1',
          token: 'ExponentPushToken[one]',
          registeredAt: now,
        },
        {
          id: 'd2',
          userId: 'u2',
          token: 'ExponentPushToken[other-project]',
          registeredAt: now,
        },
      ],
      send: (count) =>
        count > 1
          ? {
              kind: 'failed',
              retryable: false,
              code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
            }
          : { kind: 'tickets', tickets: [{ ok: true, id: 't' }] },
    });
    h.expo.send.mockImplementation(
      async (_endpoint: unknown, messages: Array<{ to: string }>) => {
        h.sent.push(messages);
        if (messages.length > 1)
          return {
            kind: 'failed',
            retryable: false,
            code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
          };
        return messages[0].to.includes('other-project')
          ? {
              kind: 'failed',
              retryable: false,
              code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
            }
          : { kind: 'tickets', tickets: [{ ok: true as const, id: 't' }] };
      },
    );
    await h.dispatcher.dispatch(now, config);
    expect(h.sent.map((messages) => messages.length)).toEqual([2, 1, 1]);
    expect(statusOf(h, 'n1')).toMatchObject({ status: 'sent' });
    expect(statusOf(h, 'n2')).toMatchObject({ status: 'failed' });
  });

  it('packs whole notifications into requests', () => {
    const group = (n: number) => ({ items: Array.from({ length: n }) });
    expect(
      packGroups([group(2), group(2), group(1)], 5).map((c) => c.length),
    ).toEqual([3]);
    expect(
      packGroups([group(3), group(3), group(3)], 5).map((c) => c.length),
    ).toEqual([1, 1, 1]);
    expect(packGroups([], 5)).toEqual([]);
    // Only an oversized notification is spread over requests of `size`.
    expect(
      packGroups([group(1), group(12), group(1)], 5).map((chunk) =>
        chunk.map((g) => g.items.length),
      ),
    ).toEqual([[1], [5], [5], [2], [1]]);
  });

  it('splits sends into Expo-sized chunks', async () => {
    const devices = Array.from({ length: 150 }, (_, i) => ({
      id: `d${i}`,
      userId: 'u1',
      token: `ExponentPushToken[t${i}]`,
      registeredAt: now,
    }));
    const h = harness({ devices });
    await h.dispatcher.dispatch(now, config);
    expect(h.sent.map((chunk) => chunk.length)).toEqual([100, 50]);
  });

  it('only finalizes rows it still holds', async () => {
    const h = harness();
    await h.dispatcher.dispatch(now, config);
    expect(
      h.updates.every(
        (update) => (update.where as { status: string }).status === 'sending',
      ),
    ).toBe(true);
  });
});

describe('PushDispatcher.checkReceipts', () => {
  it('resolves receipts and drops dead devices', async () => {
    const createdAt = new Date(now.getTime() - 20 * 60_000);
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> =
      [];
    const deleted: unknown[] = [];
    const prisma = {
      pushDelivery: {
        updateMany: jest.fn(
          async (args: { where: unknown; data: Record<string, unknown> }) => {
            updates.push(args);
            return { count: 0 };
          },
        ),
        findMany: jest.fn(async () => [
          { id: 'del-1', ticketId: 't1', deviceId: 'd1', createdAt },
          { id: 'del-2', ticketId: 't2', deviceId: 'd2', createdAt },
          { id: 'del-3', ticketId: 't3', deviceId: 'd3', createdAt },
        ]),
      },
      pushDevice: {
        deleteMany: jest.fn(async (args: unknown) => {
          deleted.push(args);
          return { count: 1 };
        }),
      },
    };
    const expo = {
      getReceipts: jest.fn(async () => ({
        kind: 'receipts' as const,
        receipts: new Map([
          ['t1', { ok: true as const }],
          ['t2', { ok: false as const, error: 'DeviceNotRegistered' }],
        ]),
      })),
    };
    const dispatcher = new PushDispatcher(prisma as never, expo as never);
    const result = await dispatcher.checkReceipts(now, config);
    expect(result).toMatchObject({
      checked: 3,
      ok: 1,
      error: 1,
      devicesRemoved: 1,
    });
    expect(deleted).toEqual([
      { where: { id: 'd2', registeredAt: { lte: createdAt } } },
    ]);
    const byIds = (id: string) =>
      updates.find((u) =>
        ((u.where as { id?: { in: string[] } }).id?.in ?? []).includes(id),
      )?.data;
    expect(byIds('del-1')).toMatchObject({ status: 'receipt_ok' });
    expect(byIds('del-2')).toMatchObject({
      status: 'receipt_error',
      errorCode: 'DeviceNotRegistered',
    });
    // Not available yet: only the check time moves.
    expect(byIds('del-3')).toEqual({ receiptCheckedAt: now });
  });
});
