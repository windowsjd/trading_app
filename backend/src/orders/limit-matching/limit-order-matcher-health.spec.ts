jest.mock('../../generated/prisma/client', () => ({
  OpsJobName: { limit_order_matcher: 'limit_order_matcher' },
  OpsJobRunStatus: {
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
  },
  OpsJobTrigger: { worker: 'worker' },
  Prisma: {},
  PrismaClient: class PrismaClient {},
}));

import { HttpException } from '@nestjs/common';
import {
  LimitOrderMatcherHealthService,
  type LimitOrderMatcherHeartbeat,
} from './limit-order-matcher-health.service';

const NOW = new Date('2026-07-22T10:00:00.000Z');

function heartbeat(
  overrides: Partial<LimitOrderMatcherHeartbeat> = {},
): Partial<LimitOrderMatcherHeartbeat> {
  return {
    activeLeaderInstance: 'matcher-1',
    leaderStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    lastRedisRead: NOW.toISOString(),
    lastSuccessfulEvent: '100-0',
    lastAcknowledgedEvent: '100-0',
    lastAcknowledgedAt: NOW.toISOString(),
    pendingCount: 0,
    oldestPendingAgeMs: null,
    consumerLag: 0,
    streamFirstId: '1-0',
    streamLastId: '100-0',
    streamLength: 100,
    retentionHeadroomRatio: 0.99,
    processedEvents: null,
    ...overrides,
  };
}

describe('LimitOrderMatcherHealthService gate', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    process.env.LIMIT_ORDER_MATCHER_MAX_LAG = '100';
    process.env.LIMIT_ORDER_MATCHER_MAX_PENDING = '10';
    process.env.LIMIT_ORDER_MATCHER_MAX_ACK_AGE_MS = '30000';
    process.env.LIMIT_ORDER_MATCHER_MAX_OLDEST_PENDING_AGE_MS = '30000';
    process.env.LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO = '0.2';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  const service = () => new LimitOrderMatcherHealthService({} as never);

  it('accepts a healthy heartbeat', () => {
    expect(service().evaluateHeartbeat(heartbeat(), NOW)).toBeNull();
  });

  it('blocks when consumer lag exceeds the limit', () => {
    expect(
      service().evaluateHeartbeat(heartbeat({ consumerLag: 101 }), NOW)?.code,
    ).toBe('LIMIT_ORDER_MATCHER_LAG_EXCEEDED');
    expect(
      service().evaluateHeartbeat(heartbeat({ consumerLag: 100 }), NOW),
    ).toBeNull();
  });

  it('blocks when the pending backlog exceeds the limit', () => {
    expect(
      service().evaluateHeartbeat(
        heartbeat({ pendingCount: 11, oldestPendingAgeMs: 10 }),
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_MATCHER_PENDING_EXCEEDED');
  });

  it('blocks when the oldest pending entry is stale', () => {
    expect(
      service().evaluateHeartbeat(
        heartbeat({ pendingCount: 1, oldestPendingAgeMs: 31_000 }),
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_MATCHER_PENDING_STALE');
  });

  it('blocks when a backlog exists and the last ACK is stale', () => {
    expect(
      service().evaluateHeartbeat(
        heartbeat({
          pendingCount: 3,
          oldestPendingAgeMs: 100,
          lastAcknowledgedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        }),
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_MATCHER_ACK_STALE');
  });

  it('blocks when a long-running leader has a backlog and never acknowledged', () => {
    expect(
      service().evaluateHeartbeat(
        heartbeat({ consumerLag: 5, lastAcknowledgedAt: null }),
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_MATCHER_ACK_STALE');
  });

  it('does NOT block a just-elected leader that has not acknowledged yet', () => {
    // Cold start into a backlog is not a stall: the reference point before the
    // first ACK is when this leader took over.
    expect(
      service().evaluateHeartbeat(
        heartbeat({
          consumerLag: 5,
          pendingCount: 2,
          oldestPendingAgeMs: 100,
          lastAcknowledgedAt: null,
          leaderStartedAt: new Date(NOW.getTime() - 200).toISOString(),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('does NOT block a quiet market with no backlog and an old last ACK', () => {
    // The critical false-positive: no pending entries and no lag means there
    // was simply nothing to process, not that the matcher is stuck.
    expect(
      service().evaluateHeartbeat(
        heartbeat({
          pendingCount: 0,
          consumerLag: 0,
          lastAcknowledgedAt: new Date(
            NOW.getTime() - 6 * 3_600_000,
          ).toISOString(),
          lastSuccessfulEvent: '1-0',
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('blocks when stream retention headroom is exhausted', () => {
    expect(
      service().evaluateHeartbeat(
        heartbeat({ retentionHeadroomRatio: 0.1 }),
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_EVENT_RETENTION_HEADROOM_LOW');
    expect(
      service().evaluateHeartbeat(
        heartbeat({ retentionHeadroomRatio: 0.2 }),
        NOW,
      ),
    ).toBeNull();
  });

  it('blocks when the matcher reported a degraded reason', () => {
    expect(
      service().evaluateHeartbeat(
        { ...heartbeat(), degradedReason: 'LIMIT_ORDER_EVENT_GAP_DETECTED' },
        NOW,
      )?.code,
    ).toBe('LIMIT_ORDER_MATCHER_DEGRADED');
  });

  it('is inert when automatic matching is disabled', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'false';
    const disabled = new LimitOrderMatcherHealthService({} as never);
    await expect(
      disabled.assertAvailable({
        opsJobRun: {
          findFirst: () => {
            throw new Error('must not be queried');
          },
        },
      } as never),
    ).resolves.toBeUndefined();
  });

  it('raises 503 with the failing gate code', async () => {
    const gated = new LimitOrderMatcherHealthService({} as never);
    const client = {
      opsJobRun: {
        findFirst: () =>
          Promise.resolve({
            id: 'run-1',
            metadataJson: heartbeat({ consumerLag: 5000 }),
          }),
      },
    };
    await expect(gated.assertAvailable(client as never, NOW)).rejects.toThrow(
      HttpException,
    );
    await gated
      .assertAvailable(client as never, NOW)
      .catch((error: unknown) => {
        expect((error as HttpException).getStatus()).toBe(503);
        expect((error as HttpException).getResponse()).toMatchObject({
          error: { code: 'LIMIT_ORDER_MATCHER_LAG_EXCEEDED' },
        });
      });
  });

  it('raises when no recent leader heartbeat row exists at all', async () => {
    const gated = new LimitOrderMatcherHealthService({} as never);
    await gated
      .assertAvailable(
        { opsJobRun: { findFirst: () => Promise.resolve(null) } } as never,
        NOW,
      )
      .catch((error: unknown) => {
        expect((error as HttpException).getResponse()).toMatchObject({
          error: { code: 'LIMIT_ORDER_MATCHER_UNAVAILABLE' },
        });
      });
  });
});
