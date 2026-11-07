jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
// The generated client's ESM specifiers are a Jest boundary (see other
// specs); the error class is the real Prisma runtime one.
jest.mock('../generated/prisma/client', () => {
  const { PrismaClientKnownRequestError } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: { PrismaClientKnownRequestError },
    AdRewardPurpose: { funding: 'funding', account_reset: 'account_reset' },
    AdRewardRedemptionStatus: {
      pending: 'pending',
      redeemed: 'redeemed',
      refused: 'refused',
      exhausted: 'exhausted',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
  };
});
// The two commands are stood in for; their transactions run on PostgreSQL.
jest.mock('./ad-reward.service', () => ({
  AdRewardService: class AdRewardService {},
}));
jest.mock('./general-account-reset.service', () => ({
  GeneralAccountResetService: class GeneralAccountResetService {},
}));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class OpsJobLockService {},
}));
jest.mock('../ops/ops-job-run.service', () => ({
  OpsJobRunService: class OpsJobRunService {},
}));

import { HttpException } from '@nestjs/common';
import type { AdRewardSession } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { AdMobRedemptionWorker } from './admob-redemption.worker';
import {
  AdMobRewardSessionService,
  type AdMobRedemptionSweep,
} from './admob-reward-session.service';
import {
  ADMOB_REDEMPTION_WINDOW_MS,
  adMobRedemptionRetryDelayMs,
} from './admob.config';
import type { AdRewardService } from './ad-reward.service';
import type { GeneralAccountResetService } from './general-account-reset.service';
import type { AdRewardVerificationRegistry } from './ad-reward-verifier';
import type { AdMobSsvKeyStore } from './admob-ssv-keys';
import type { PrismaService } from '../prisma/prisma.service';
import type { OpsJobLockService } from '../ops/ops-job-lock.service';
import type { OpsJobRunService } from '../ops/ops-job-run.service';

/**
 * Server recovery of confirmed AdMob rewards (2026-11-08): what one recovery
 * attempt does with each answer of the session's command, and when the
 * worker runs at all. The real transactions, concurrency and Ops records are
 * proven on PostgreSQL (scripts/admob-ssv-integration.ts).
 */

const MINUTE = 60_000;

function refusal(code: string, status: number) {
  return new HttpException({ success: false, error: { code } }, status);
}

function pendingSession(overrides: Partial<AdRewardSession> = {}) {
  const now = Date.now();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    tradingAccountId: 'account-1',
    provider: 'admob',
    purpose: 'funding',
    platform: 'android',
    idempotencyKey: 'ad_reward_claim_key-1',
    createdAt: new Date(now - 5 * MINUTE),
    expiresAt: new Date(now + 25 * MINUTE),
    ssvTransactionId: 'tx-1',
    ssvVerifiedAt: new Date(now - 2 * MINUTE),
    ssvRewardedAt: null,
    ssvAdUnit: '3165650506',
    ssvKeyId: '3335741209',
    ssvRewardItem: null,
    ssvRewardAmount: null,
    redemptionStatus: 'pending',
    redemptionAttemptCount: 0,
    redemptionNextAttemptAt: new Date(now - MINUTE),
    redemptionErrorCode: null,
    ...overrides,
  } as AdRewardSession;
}

function harness(due: AdRewardSession[]) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    adRewardSession: {
      findMany: jest.fn().mockResolvedValue(due),
      findFirst: jest.fn().mockResolvedValue(due[0] ? { id: due[0].id } : null),
      updateMany,
    },
  };
  const claim = jest.fn().mockResolvedValue({ success: true });
  const reset = jest.fn().mockResolvedValue({ success: true });
  const service = new AdMobRewardSessionService(
    prisma as unknown as PrismaService,
    { claim } as unknown as AdRewardService,
    { reset } as unknown as GeneralAccountResetService,
    {} as AdRewardVerificationRegistry,
    {} as AdMobSsvKeyStore,
  );
  return { service, updateMany, claim, reset };
}

type UpdateCall = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};
const calls = (mock: jest.Mock) =>
  mock.mock.calls.map(([arg]) => arg as UpdateCall);

describe('AdMob server recovery: one attempt per due session', () => {
  it('reserves the attempt BEFORE running the command, then settles a commit as redeemed', async () => {
    const session = pendingSession();
    const { service, updateMany, claim } = harness([session]);
    const order: string[] = [];
    updateMany.mockImplementation((arg: UpdateCall) => {
      order.push(
        arg.data.redemptionStatus === 'redeemed' ? 'settle' : 'reserve',
      );
      return Promise.resolve({ count: 1 });
    });
    claim.mockImplementation(() => {
      order.push('command');
      return Promise.resolve({ success: true });
    });

    const sweep = await service.redeemDueSessions();

    expect(order.join(',')).toBe('reserve,command,settle');
    expect(sweep.redeemed).toBe(1);
    expect(sweep.due).toBe(1);
    // The same command the app and the callback send: the session's own
    // member, account and key, the session id as proof.
    expect(claim).toHaveBeenCalledTimes(1);
    const [userId, accountId, body] = claim.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
    ];
    expect(userId).toBe('user-1');
    expect(accountId).toBe('account-1');
    expect(body.provider).toBe('admob');
    expect(body.proof).toBe(session.id);
    expect(body.idempotencyKey).toBe(session.idempotencyKey);

    const [reserve, settle] = calls(updateMany);
    // Conditional on the count read: a concurrent pass cannot run it again.
    expect(reserve.where.redemptionStatus).toBe('pending');
    expect(reserve.where.redemptionAttemptCount).toBe(0);
    expect(reserve.data.redemptionAttemptCount).toBe(1);
    const nextAt = (reserve.data.redemptionNextAttemptAt as Date).getTime();
    expect(Math.abs(nextAt - (Date.now() + MINUTE)) < 5_000).toBe(true);
    expect(settle.where.redemptionStatus).toBe('pending');
    expect(settle.data.redemptionNextAttemptAt === null).toBe(true);
  });

  it('a product-rule refusal (4xx) is settled refused with its code; nothing runs it again', async () => {
    const reset = pendingSession({
      purpose: 'account_reset',
      idempotencyKey: 'account_reset_key-2',
    });
    const { service, updateMany, reset: resetCommand } = harness([reset]);
    resetCommand.mockRejectedValue(
      refusal('GENERAL_ACCOUNT_RESET_BLOCKED', 409),
    );

    const sweep = await service.redeemDueSessions();

    expect(sweep.refused).toBe(1);
    const settle = calls(updateMany)[1];
    expect(settle.data.redemptionStatus).toBe('refused');
    expect(settle.data.redemptionErrorCode).toBe(
      'GENERAL_ACCOUNT_RESET_BLOCKED',
    );
    expect(settle.data.redemptionNextAttemptAt === null).toBe(true);
  });

  it('server failures (5xx, database, unexpected) stay pending with a fixed code, for this attempt only', async () => {
    const cases: Array<[unknown, string]> = [
      [
        refusal('GENERAL_ACCOUNT_RESET_UNAVAILABLE', 503),
        'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
      ],
      [refusal('AD_REWARD_DISABLED', 503), 'AD_REWARD_DISABLED'],
      [refusal('GENERAL_ACCOUNT_INTEGRITY', 500), 'GENERAL_ACCOUNT_INTEGRITY'],
      // A recorded event is never "not confirmed yet": retried, never final.
      [
        refusal('AD_REWARD_VERIFICATION_PENDING', 409),
        'AD_REWARD_VERIFICATION_PENDING',
      ],
      [
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: 'test',
        }),
        'REDEEM_FAILED',
      ],
      [new TypeError('boom'), 'REDEEM_FAILED'],
    ];
    for (const [thrown, code] of cases) {
      const session = pendingSession({ redemptionAttemptCount: 3 });
      const { service, updateMany, claim } = harness([session]);
      claim.mockRejectedValue(thrown);

      const sweep = await service.redeemDueSessions();

      expect(sweep.retrying).toBe(1);
      const [reserve, settle] = calls(updateMany);
      expect(reserve.data.redemptionAttemptCount).toBe(4);
      // 4th failure → 8 minutes.
      const wait =
        (reserve.data.redemptionNextAttemptAt as Date).getTime() - Date.now();
      expect(Math.abs(wait - 8 * MINUTE) < 5_000).toBe(true);
      expect(settle.data.redemptionErrorCode).toBe(code);
      expect('redemptionStatus' in settle.data).toBe(false);
      expect(settle.where.redemptionAttemptCount).toBe(4);
    }
  });

  it('a session another path settled or reserved meanwhile is skipped without running the command', async () => {
    const { service, updateMany, claim } = harness([pendingSession()]);
    updateMany.mockResolvedValue({ count: 0 });

    const sweep = await service.redeemDueSessions();

    expect(sweep.skipped).toBe(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('past the 24 h window after Google confirmed it, the server stops without running the command', async () => {
    const old = pendingSession({
      ssvVerifiedAt: new Date(Date.now() - ADMOB_REDEMPTION_WINDOW_MS - 1_000),
      redemptionAttemptCount: 29,
      redemptionErrorCode: 'REDEEM_FAILED',
    });
    const { service, updateMany, claim } = harness([old]);

    const sweep = await service.redeemDueSessions();

    expect(sweep.exhausted).toBe(1);
    expect(claim).not.toHaveBeenCalled();
    const [ended] = calls(updateMany);
    expect(ended.where.redemptionAttemptCount).toBe(29);
    expect(ended.data.redemptionStatus).toBe('exhausted');
    expect(ended.data.redemptionNextAttemptAt === null).toBe(true);
    // The last server failure stays readable.
    expect(ended.data.redemptionErrorCode).toBe('REDEEM_FAILED');
  });

  it('only pending sessions that are due are read, oldest due first, in bounded batches', async () => {
    const { service } = harness([]);
    const prisma = (
      service as unknown as {
        prisma: { adRewardSession: { findMany: jest.Mock } };
      }
    ).prisma;
    await service.redeemDueSessions(new Date('2026-11-08T00:00:00Z'));
    const [query] = prisma.adRewardSession.findMany.mock.calls[0] as [
      {
        where: {
          redemptionStatus: string;
          redemptionNextAttemptAt: { lte: Date };
        };
        take: number;
      },
    ];
    expect(query.where.redemptionStatus).toBe('pending');
    expect(query.where.redemptionNextAttemptAt.lte.toISOString()).toBe(
      '2026-11-08T00:00:00.000Z',
    );
    expect(query.take).toBe(25);
  });

  it('retries back off 1, 2, 4 … minutes, at most an hour apart', () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 8, 30, 500].map(
        (attempt) => adMobRedemptionRetryDelayMs(attempt) / MINUTE,
      ),
    ).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
  });
});

describe('AdMobRedemptionWorker', () => {
  const ADS_ON = {
    AD_REWARD_ENABLED: 'true',
    AD_REWARD_PROVIDER: 'admob',
    AD_REWARD_AMOUNT_KRW: '5000000',
    AD_REWARD_DAILY_MAX_COUNT: 'unlimited',
    AD_REWARD_DAILY_MAX_AMOUNT_KRW: 'unlimited',
    AD_REWARD_COOLDOWN_SECONDS: '0',
    AD_REWARD_DAY_TIME_ZONE: 'Asia/Seoul',
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of Object.keys(ADS_ON)) saved[key] = process.env[key];
    Object.assign(process.env, ADS_ON);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sweepOf = (counts: Partial<AdMobRedemptionSweep>) => ({
    due: 1,
    redeemed: 0,
    refused: 0,
    retrying: 0,
    exhausted: 0,
    skipped: 0,
    ...counts,
  });

  function worker(options: { due?: boolean; acquired?: boolean } = {}) {
    const sessions = {
      hasDueRedemption: jest.fn().mockResolvedValue(options.due ?? true),
      redeemDueSessions: jest.fn().mockResolvedValue(sweepOf({ redeemed: 1 })),
    };
    const locks = {
      acquireLock: jest
        .fn()
        .mockResolvedValue(
          options.acquired === false
            ? { acquired: false }
            : { acquired: true, ownerId: 'owner-1' },
        ),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    const runs = {
      createRunning: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', startedAt: new Date() }),
      recordSucceeded: jest.fn().mockResolvedValue({}),
      recordFailed: jest.fn().mockResolvedValue({}),
    };
    const instance = new AdMobRedemptionWorker(
      sessions as unknown as AdMobRewardSessionService,
      locks as unknown as OpsJobLockService,
      runs as unknown as OpsJobRunService,
    );
    return { instance, sessions, locks, runs };
  }

  it('does nothing while ads are switched off (pending sessions wait, their attempts unspent)', async () => {
    process.env.AD_REWARD_ENABLED = 'false';
    const { instance, sessions, locks } = worker();
    await instance.tick();
    expect(sessions.hasDueRedemption).not.toHaveBeenCalled();
    expect(locks.acquireLock).not.toHaveBeenCalled();

    process.env.AD_REWARD_ENABLED = 'true';
    process.env.AD_REWARD_PROVIDER = 'another-network';
    await instance.tick();
    expect(sessions.hasDueRedemption).not.toHaveBeenCalled();
  });

  it('an idle tick is one read: no lease, no run record', async () => {
    const { instance, locks, runs } = worker({ due: false });
    await instance.tick();
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(runs.createRunning).not.toHaveBeenCalled();
  });

  it('with due work: one lease, one run recorded with the pass counts, lease released', async () => {
    const { instance, sessions, locks, runs } = worker();
    await instance.tick();
    const [lease] = locks.acquireLock.mock.calls[0] as [
      { jobName: string; lockKey: string },
    ];
    expect(lease.jobName).toBe('ad_reward_redemption');
    expect(lease.lockKey).toBe('ad_reward_redemption:current');
    expect(sessions.redeemDueSessions).toHaveBeenCalledTimes(1);
    expect(runs.recordSucceeded).toHaveBeenCalledTimes(1);
    const [, recorded] = runs.recordSucceeded.mock.calls[0] as [
      unknown,
      { resultJson: AdMobRedemptionSweep },
    ];
    expect(recorded.resultJson.redeemed).toBe(1);
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('a pass that left a server failure pending is recorded failed (Ops sees it)', async () => {
    const { instance, sessions, runs } = worker();
    sessions.redeemDueSessions.mockResolvedValue(sweepOf({ retrying: 1 }));
    await instance.tick();
    expect(runs.recordSucceeded).not.toHaveBeenCalled();
    const [, failed] = runs.recordFailed.mock.calls[0] as [
      unknown,
      { errorCode: string },
    ];
    expect(failed.errorCode).toBe('AD_REWARD_REDEMPTION_RETRYING');
  });

  it('a pass that stopped on a server failure is recorded failed, rethrown, and the lease released', async () => {
    const { instance, sessions, locks, runs } = worker();
    sessions.redeemDueSessions.mockRejectedValue(new Error('database down'));
    await expect(instance.tick()).rejects.toThrow();
    const [, failed] = runs.recordFailed.mock.calls[0] as [
      unknown,
      { errorCode: string },
    ];
    expect(failed.errorCode).toBe('AD_REWARD_REDEMPTION_FAILED');
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
    // The next tick runs again.
    sessions.redeemDueSessions.mockResolvedValue(sweepOf({ redeemed: 1 }));
    await instance.tick();
    expect(runs.recordSucceeded).toHaveBeenCalledTimes(1);
  });

  it('another instance holding the lease: this tick runs nothing', async () => {
    const { instance, sessions, runs } = worker({ acquired: false });
    await instance.tick();
    expect(sessions.redeemDueSessions).not.toHaveBeenCalled();
    expect(runs.createRunning).not.toHaveBeenCalled();
  });

  it('never overlaps itself', async () => {
    const { instance, sessions } = worker();
    let release!: () => void;
    sessions.redeemDueSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(sweepOf({ redeemed: 1 }));
        }),
    );
    const first = instance.tick();
    for (
      let turn = 0;
      turn < 50 && sessions.redeemDueSessions.mock.calls.length === 0;
      turn += 1
    )
      await new Promise((resolve) => setImmediate(resolve));
    expect(sessions.redeemDueSessions).toHaveBeenCalledTimes(1);
    await instance.tick(); // returns at once: the first pass still runs
    release();
    await first;
    expect(sessions.hasDueRedemption).toHaveBeenCalledTimes(1);
    expect(sessions.redeemDueSessions).toHaveBeenCalledTimes(1);
  });
});
