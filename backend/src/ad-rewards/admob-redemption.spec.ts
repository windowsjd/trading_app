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
    AdRewardClaimStatus: {
      pending: 'pending',
      verified: 'verified',
      granted: 'granted',
      rejected: 'rejected',
      failed: 'failed',
    },
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
  classifyRedemptionFailure,
  isTransientDatabaseFailure,
} from './admob-redemption-policy';
import {
  ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
  ADMOB_REDEMPTION_UNSETTLED,
  ADMOB_REDEMPTION_WINDOW_MS,
  ADMOB_SESSION_EXPIRY_GRACE_MS,
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
 * Server recovery of confirmed AdMob rewards (2026-11-08): which failures
 * are run again (per purpose), what one recovery attempt does with each
 * answer, how an attempt whose outcome was never written is read, the
 * member's call that only reads the result, and when the worker runs at all.
 * The real transactions, PostgreSQL fault injection, concurrency and Ops
 * records are proven in scripts/admob-ssv-integration.ts.
 */

const MINUTE = 60_000;

function refusal(code: string, status: number) {
  return new HttpException({ success: false, error: { code } }, status);
}
const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('database', {
    code,
    clientVersion: 'test',
    ...(meta ? { meta } : {}),
  });
/** A raw query's driver failure as adapter-pg reports it (P2010 + SQLSTATE). */
const raw = (sqlState: string) =>
  known('P2010', {
    driverAdapterError: {
      cause: { originalCode: sqlState, kind: 'postgres', code: sqlState },
    },
  });
class PortfolioValuationError extends Error {
  constructor(readonly code: string) {
    super('valuation');
    this.name = 'PortfolioValuationError';
  }
}

/** A due session whose callback attempt failed for a server reason. */
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
    redemptionErrorCode: 'REDEEM_FAILED',
    ...overrides,
  } as AdRewardSession;
}

function harness(due: AdRewardSession[]) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    adRewardSession: {
      findMany: jest.fn().mockResolvedValue(due),
      findFirst: jest.fn().mockResolvedValue(due[0] ? { id: due[0].id } : null),
      findUnique: jest.fn().mockResolvedValue(due[0] ?? null),
      updateMany,
    },
    adRewardClaim: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const claim = jest.fn().mockResolvedValue({ success: true });
  const reset = jest.fn().mockResolvedValue({ success: true });
  const resolveGeneralAccount = jest.fn().mockResolvedValue({
    id: 'account-1',
    userId: 'user-1',
    mode: 'general',
    status: 'active',
  });
  const service = new AdMobRewardSessionService(
    prisma as unknown as PrismaService,
    { claim, resolveGeneralAccount } as unknown as AdRewardService,
    { reset } as unknown as GeneralAccountResetService,
    {} as AdRewardVerificationRegistry,
    {} as AdMobSsvKeyStore,
  );
  return { service, prisma, updateMany, claim, reset };
}

type UpdateCall = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};
const calls = (mock: jest.Mock) =>
  mock.mock.calls.map(([arg]) => arg as UpdateCall);

describe('which failures the server runs again (admob-redemption-policy)', () => {
  const transient: Array<[string, unknown]> = [
    ['P2034 write conflict / deadlock (model call, 40001)', known('P2034')],
    ['40001 serialization failure (raw query)', raw('40001')],
    ['40P01 deadlock (raw query)', raw('40P01')],
    ['P2028 interactive transaction expired', known('P2028')],
    ['P2024 connection pool timeout', known('P2024')],
    ['P1008 operations timed out', known('P1008')],
    [
      'P1001 database not reachable',
      known('P1001', {
        driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } },
      }),
    ],
    ['57014 statement timeout', raw('57014')],
    ['55P03 lock timeout', raw('55P03')],
    ['08006 connection failure', raw('08006')],
  ];
  const notTransient: Array<[string, unknown]> = [
    ['23514 CHECK violation', raw('23514')],
    ['22003 numeric out of range', raw('22003')],
    ['XX000 internal error', raw('XX000')],
    ['53100 disk full', raw('53100')],
    ['P2002 unique violation', known('P2002')],
    ['P2025 record not found', known('P2025')],
    ['valuation unavailable', new PortfolioValuationError('FX_RATE_STALE')],
    ['application bug', new TypeError('boom')],
    ['a coded 5xx answer', refusal('GENERAL_ACCOUNT_RESET_UNAVAILABLE', 503)],
    ['a bare 500', new HttpException('Internal', 500)],
  ];

  it.each(transient)('transient: %s', (_label, thrown) => {
    expect(isTransientDatabaseFailure(thrown)).toBe(true);
  });
  it.each(notTransient)('not transient: %s', (_label, thrown) => {
    expect(isTransientDatabaseFailure(thrown)).toBe(false);
  });

  it('a reset runs again ONLY after a transient database failure; every answer of the command is final', () => {
    for (const [, thrown] of transient)
      expect(classifyRedemptionFailure('account_reset', thrown).kind).toBe(
        'failed',
      );
    const finals: Array<[unknown, string]> = [
      // The coded 503s that used to be retried: product answers, not outages.
      [
        refusal('GENERAL_ACCOUNT_RESET_UNAVAILABLE', 503),
        'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
      ],
      [refusal('AD_REWARD_DISABLED', 503), 'AD_REWARD_DISABLED'],
      [
        refusal('AD_REWARD_PROVIDER_UNAVAILABLE', 503),
        'AD_REWARD_PROVIDER_UNAVAILABLE',
      ],
      [refusal('GENERAL_ACCOUNT_INTEGRITY', 500), 'GENERAL_ACCOUNT_INTEGRITY'],
      [
        refusal('GENERAL_ACCOUNT_RESET_BLOCKED', 409),
        'GENERAL_ACCOUNT_RESET_BLOCKED',
      ],
      [
        refusal('AD_REWARD_VERIFICATION_PENDING', 409),
        'AD_REWARD_VERIFICATION_PENDING',
      ],
      [new HttpException('Internal', 500), 'HTTP_500'],
      // Cannot be classified: a safe stop, never a later reset.
      [new TypeError('boom'), 'REDEEM_FAILED_UNCLASSIFIED'],
      [
        new PortfolioValuationError('ASSET_PRICE_UNAVAILABLE'),
        'REDEEM_FAILED_UNCLASSIFIED',
      ],
      [raw('23514'), 'REDEEM_FAILED_UNCLASSIFIED'],
    ];
    for (const [thrown, code] of finals) {
      const result = classifyRedemptionFailure('account_reset', thrown);
      expect(result.kind).toBe('refused');
      expect(result.code).toBe(code);
    }
  });

  it('a top-up keeps its recovery: only a product refusal (4xx) is final', () => {
    const retried: Array<[unknown, string]> = [
      [
        refusal('GENERAL_ACCOUNT_RESET_UNAVAILABLE', 503),
        'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
      ],
      [refusal('AD_REWARD_DISABLED', 503), 'AD_REWARD_DISABLED'],
      [refusal('GENERAL_ACCOUNT_INTEGRITY', 500), 'GENERAL_ACCOUNT_INTEGRITY'],
      [
        refusal('AD_REWARD_VERIFICATION_PENDING', 409),
        'AD_REWARD_VERIFICATION_PENDING',
      ],
      [known('P2034'), 'REDEEM_FAILED'],
      [new PortfolioValuationError('FX_RATE_STALE'), 'REDEEM_FAILED'],
      [new TypeError('boom'), 'REDEEM_FAILED'],
    ];
    for (const [thrown, code] of retried) {
      const result = classifyRedemptionFailure('funding', thrown);
      expect(result.kind).toBe('failed');
      expect(result.code).toBe(code);
    }
    for (const code of [
      'TRADING_ACCOUNT_NOT_ACTIVE',
      'AD_REWARD_VERIFICATION_FAILED',
      'AD_REWARD_IDEMPOTENCY_CONFLICT',
    ])
      expect(classifyRedemptionFailure('funding', refusal(code, 409))).toEqual(
        { kind: 'refused', code },
      );
    expect(
      classifyRedemptionFailure(
        'funding',
        refusal('AD_REWARD_DAILY_COUNT_LIMIT', 429),
      ).kind,
    ).toBe('refused');
  });
});

describe('AdMob server recovery: one attempt per due session', () => {
  it('reserves the attempt (with its unsettled marker) BEFORE running the command, then settles a commit as redeemed', async () => {
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
    // The same command the callback runs: the session's own member, account
    // and key, the session id as proof.
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
    // Conditional on the row as read: a concurrent pass cannot run it again.
    expect(reserve.where.redemptionStatus).toBe('pending');
    expect(reserve.where.redemptionAttemptCount).toBe(0);
    expect(reserve.where.redemptionErrorCode).toBe('REDEEM_FAILED');
    expect(reserve.data.redemptionAttemptCount).toBe(1);
    expect(reserve.data.redemptionErrorCode).toBe(ADMOB_REDEMPTION_UNSETTLED);
    const nextAt = (reserve.data.redemptionNextAttemptAt as Date).getTime();
    expect(Math.abs(nextAt - (Date.now() + MINUTE)) < 5_000).toBe(true);
    // The outcome is written on this attempt's own reservation only.
    expect(settle.where).toEqual({
      id: session.id,
      redemptionStatus: 'pending',
      redemptionAttemptCount: 1,
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
    });
    expect(settle.data.redemptionNextAttemptAt === null).toBe(true);
    expect(settle.data.redemptionErrorCode === null).toBe(true);
  });

  it('a reset refused for a product rule — a coded 503 included — is settled refused with its code', async () => {
    for (const [thrown, code] of [
      [
        refusal('GENERAL_ACCOUNT_RESET_BLOCKED', 409),
        'GENERAL_ACCOUNT_RESET_BLOCKED',
      ],
      [
        refusal('GENERAL_ACCOUNT_RESET_UNAVAILABLE', 503),
        'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
      ],
    ] as const) {
      const session = pendingSession({
        purpose: 'account_reset',
        idempotencyKey: 'account_reset_key-2',
      });
      const { service, updateMany, reset } = harness([session]);
      reset.mockRejectedValue(thrown);

      const sweep = await service.redeemDueSessions();

      expect(sweep.refused).toBe(1);
      const settle = calls(updateMany)[1];
      expect(settle.data.redemptionStatus).toBe('refused');
      expect(settle.data.redemptionErrorCode).toBe(code);
      expect(settle.data.redemptionNextAttemptAt === null).toBe(true);
    }
  });

  it('a reset after a transient database failure stays pending (backoff); an unclassified failure is final', async () => {
    const transientSession = pendingSession({ purpose: 'account_reset' });
    const first = harness([transientSession]);
    first.reset.mockRejectedValue(known('P2034'));
    expect((await first.service.redeemDueSessions()).retrying).toBe(1);
    const settle = calls(first.updateMany)[1];
    expect('redemptionStatus' in settle.data).toBe(false);
    expect(settle.data.redemptionErrorCode).toBe('REDEEM_FAILED');

    const unknownSession = pendingSession({ purpose: 'account_reset' });
    const second = harness([unknownSession]);
    second.reset.mockRejectedValue(new TypeError('boom'));
    expect((await second.service.redeemDueSessions()).refused).toBe(1);
    expect(calls(second.updateMany)[1].data.redemptionStatus).toBe('refused');
  });

  it('top-up server failures (5xx, database, unexpected) stay pending with a fixed code, for this attempt only', async () => {
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
      [known('P2034'), 'REDEEM_FAILED'],
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
      expect(settle.where.redemptionErrorCode).toBe(ADMOB_REDEMPTION_UNSETTLED);
    }
  });

  it('a session another path settled or reserved meanwhile is skipped without running the command', async () => {
    const { service, updateMany, claim } = harness([pendingSession()]);
    updateMany.mockResolvedValue({ count: 0 });

    const sweep = await service.redeemDueSessions();

    expect(sweep.skipped).toBe(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('an outcome write that changes 0 rows is not reported as recorded: the row is re-read and the attempt counted skipped', async () => {
    const session = pendingSession({ purpose: 'account_reset' });
    const { service, prisma, updateMany, reset } = harness([session]);
    reset.mockRejectedValue(refusal('GENERAL_ACCOUNT_RESET_BLOCKED', 409));
    updateMany
      .mockResolvedValueOnce({ count: 1 }) // the reservation
      .mockResolvedValueOnce({ count: 0 }); // the outcome: superseded
    prisma.adRewardSession.findUnique.mockResolvedValue({
      redemptionStatus: 'pending',
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
      redemptionAttemptCount: 2,
    });

    const sweep = await service.redeemDueSessions();

    expect(sweep.skipped).toBe(1);
    expect(sweep.refused).toBe(0);
    expect(prisma.adRewardSession.findUnique).toHaveBeenCalledTimes(1);
  });

  it('an outcome that cannot be written leaves the marker (unsettled); money that moved is still reported redeemed', async () => {
    const refusedReset = pendingSession({ purpose: 'account_reset' });
    const first = harness([refusedReset]);
    first.reset.mockRejectedValue(refusal('GENERAL_ACCOUNT_RESET_BLOCKED', 409));
    first.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(known('P1001'));
    expect((await first.service.redeemDueSessions()).unsettled).toBe(1);

    const paid = harness([pendingSession()]);
    paid.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(known('P1001'));
    expect((await paid.service.redeemDueSessions()).redeemed).toBe(1);
  });

  it('a reset whose last attempt left no recorded outcome is closed (REDEMPTION_OUTCOME_UNKNOWN) without running it', async () => {
    for (const code of [ADMOB_REDEMPTION_UNSETTLED, null]) {
      const session = pendingSession({
        purpose: 'account_reset',
        redemptionErrorCode: code,
        redemptionAttemptCount: 2,
      });
      const { service, updateMany, reset } = harness([session]);

      const sweep = await service.redeemDueSessions();

      expect(sweep.unknown).toBe(1);
      expect(reset).not.toHaveBeenCalled();
      const [closed] = calls(updateMany);
      expect(closed.where.redemptionAttemptCount).toBe(2);
      expect(closed.where.redemptionErrorCode).toBe(code);
      expect(closed.data.redemptionStatus).toBe('refused');
      expect(closed.data.redemptionErrorCode).toBe(
        ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
      );
    }
  });

  it('…but one that committed is replayed by its command, and a top-up runs again (it pays at most once)', async () => {
    const committed = pendingSession({
      purpose: 'account_reset',
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
    });
    const first = harness([committed]);
    first.prisma.adRewardClaim.findUnique.mockResolvedValue({
      status: 'granted',
      failureCode: null,
    });
    expect((await first.service.redeemDueSessions()).redeemed).toBe(1);
    expect(first.reset).toHaveBeenCalledTimes(1);

    const topUp = harness([
      pendingSession({ redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED }),
    ]);
    expect((await topUp.service.redeemDueSessions()).redeemed).toBe(1);
    expect(topUp.claim).toHaveBeenCalledTimes(1);
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

  it('past the window, a command that did commit is reported redeemed (never "unredeemed"), still without running it', async () => {
    const old = pendingSession({
      purpose: 'account_reset',
      ssvVerifiedAt: new Date(Date.now() - ADMOB_REDEMPTION_WINDOW_MS - 1_000),
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
    });
    const { service, prisma, updateMany, reset } = harness([old]);
    prisma.adRewardClaim.findUnique.mockResolvedValue({
      status: 'granted',
      failureCode: null,
    });

    expect((await service.redeemDueSessions()).redeemed).toBe(1);
    expect(reset).not.toHaveBeenCalled();
    expect(calls(updateMany)[0].data.redemptionStatus).toBe('redeemed');
  });

  it('only pending sessions that are due are read, oldest due first, in bounded batches', async () => {
    const { service, prisma } = harness([]);
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

describe("the member's call reads the server's result (memberCommand)", () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';
  const body = (overrides: Record<string, unknown> = {}) => ({
    provider: 'admob',
    proof: SESSION,
    idempotencyKey: 'ad_reward_claim_key-1',
    ...overrides,
  });
  async function codeOf(work: Promise<unknown>) {
    try {
      await work;
    } catch (caught) {
      const response = (caught as HttpException).getResponse() as {
        error: { code: string; details?: Record<string, string> };
      };
      return {
        status: (caught as HttpException).getStatus(),
        code: response.error.code,
        details: response.error.details ?? null,
      };
    }
    return null;
  }

  it('pending on the server: 409 AD_REWARD_REDEMPTION_PENDING, and the command is NOT run', async () => {
    const { service, claim, reset } = harness([pendingSession()]);
    expect(
      await codeOf(service.memberCommand('funding', 'user-1', 'G', body())),
    ).toEqual({
      status: 409,
      code: 'AD_REWARD_REDEMPTION_PENDING',
      details: null,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('refused or exhausted: 409 AD_REWARD_REDEMPTION_CLOSED with the stored reason; a 결과 확인 never re-runs the reset', async () => {
    for (const [status, reasonCode] of [
      ['refused', 'GENERAL_ACCOUNT_RESET_UNAVAILABLE'],
      ['refused', ADMOB_REDEMPTION_OUTCOME_UNKNOWN],
      ['exhausted', 'REDEEM_FAILED'],
    ] as const) {
      const session = pendingSession({
        purpose: 'account_reset',
        idempotencyKey: 'account_reset_key-1',
        redemptionStatus: status,
        redemptionNextAttemptAt: null,
        redemptionErrorCode: reasonCode,
      });
      const { service, reset } = harness([session]);
      expect(
        await codeOf(
          service.memberCommand(
            'account_reset',
            'user-1',
            'G',
            body({ idempotencyKey: 'account_reset_key-1' }),
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'AD_REWARD_REDEMPTION_CLOSED',
        details: { status, reasonCode },
      });
      expect(reset).not.toHaveBeenCalled();
    }
  });

  it('a committed command is answered by the command itself (its replay), whatever the bookkeeping says', async () => {
    const session = pendingSession({ redemptionStatus: 'refused' });
    const { service, prisma, claim } = harness([session]);
    prisma.adRewardClaim.findUnique.mockResolvedValue({
      status: 'granted',
      failureCode: null,
    });
    await service.memberCommand('funding', 'user-1', 'G', body());
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('not confirmed by Google yet: PENDING (then FAILED past the grace) without running the command', async () => {
    const unconfirmed = pendingSession({
      ssvTransactionId: null,
      ssvVerifiedAt: null,
      redemptionStatus: null,
      redemptionNextAttemptAt: null,
      redemptionErrorCode: null,
    });
    const waiting = harness([unconfirmed]);
    expect(
      (await codeOf(waiting.service.memberCommand('funding', 'user-1', 'G', body())))
        ?.code,
    ).toBe('AD_REWARD_VERIFICATION_PENDING');
    expect(waiting.claim).not.toHaveBeenCalled();

    const ended = harness([
      {
        ...unconfirmed,
        expiresAt: new Date(
          Date.now() - ADMOB_SESSION_EXPIRY_GRACE_MS - 1_000,
        ),
      },
    ]);
    expect(
      (await codeOf(ended.service.memberCommand('funding', 'user-1', 'G', body())))
        ?.code,
    ).toBe('AD_REWARD_VERIFICATION_FAILED');
    expect(ended.claim).not.toHaveBeenCalled();
  });

  it('anything that is not this command\'s own session goes to the command unchanged (which refuses it)', async () => {
    const cases: Array<[Record<string, unknown>, Partial<AdRewardSession> | null]> = [
      [body({ provider: 'another-network' }), {}],
      [body({ proof: 'not-a-session' }), {}],
      [body(), null],
      [body(), { userId: 'someone-else' }],
      [body(), { tradingAccountId: 'another-account' }],
      [body({ idempotencyKey: 'another-key' }), {}],
      [body(), { purpose: 'account_reset' }],
      // Recorded before 2026-11-08 (no status): the member's command, as before.
      [body(), { redemptionStatus: null, redemptionNextAttemptAt: null }],
    ];
    for (const [request, overrides] of cases) {
      const { service, prisma, claim } = harness([pendingSession()]);
      prisma.adRewardSession.findUnique.mockResolvedValue(
        overrides === null ? null : pendingSession(overrides),
      );
      await service.memberCommand('funding', 'user-1', 'G', request);
      expect(claim).toHaveBeenCalledTimes(1);
    }
  });

  it('a reset proof goes to the reset command, a top-up proof to the claim', async () => {
    const { service, prisma, claim, reset } = harness([pendingSession()]);
    prisma.adRewardSession.findUnique.mockResolvedValue(null);
    await service.memberCommand('account_reset', 'user-1', 'G', body());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
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
    unknown: 0,
    unsettled: 0,
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

  it('a pass that left a confirmed ad unapplied for a server reason is recorded failed (Ops sees it)', async () => {
    for (const counts of [
      { retrying: 1 },
      { exhausted: 1 },
      { unknown: 1 },
      { unsettled: 1 },
    ]) {
      const { instance, sessions, runs } = worker();
      sessions.redeemDueSessions.mockResolvedValue(sweepOf(counts));
      await instance.tick();
      expect(runs.recordSucceeded).not.toHaveBeenCalled();
      const [, failed] = runs.recordFailed.mock.calls[0] as [
        unknown,
        { errorCode: string },
      ];
      expect(failed.errorCode).toBe('AD_REWARD_REDEMPTION_RETRYING');
    }
    // A product refusal is an answer, not an Ops problem.
    const { instance, sessions, runs } = worker();
    sessions.redeemDueSessions.mockResolvedValue(sweepOf({ refused: 1 }));
    await instance.tick();
    expect(runs.recordSucceeded).toHaveBeenCalledTimes(1);
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
