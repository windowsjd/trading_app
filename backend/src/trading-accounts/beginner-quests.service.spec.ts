jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('../portfolio/general-account-performance.service', () => ({
  GeneralAccountPerformanceService: class GeneralAccountPerformanceService {},
}));
jest.mock('./trading-account-access.service', () => ({
  TradingAccountAccessService: class TradingAccountAccessService {},
}));

import { HttpException } from '@nestjs/common';
import { BeginnerQuestsService } from './beginner-quests.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import type { TradingAccountAccessService } from './trading-account-access.service';

const ACCOUNT = 'ta-beginner-1';
const FX_AT = new Date('2026-10-10T01:00:00.000Z');
const TRANSFER_AT = new Date('2026-10-10T01:05:00.000Z');

type Leg = {
  referenceId: string;
  txType: string;
  direction: string;
  currencyCode: string;
  wallet: {
    tradingAccountId: string;
    walletScope: string;
    currencyCode: string;
  };
};

const leg = (
  referenceId: string,
  txType: string,
  direction: string,
  currencyCode: string,
  walletScope: string,
  walletAccount = ACCOUNT,
): Leg => ({
  referenceId,
  txType,
  direction,
  currencyCode,
  wallet: { tradingAccountId: walletAccount, walletScope, currencyCode },
});
const fxLegs = (id: string) => [
  leg(id, 'exchange_source', 'debit', 'KRW', 'securities'),
  leg(id, 'exchange_target', 'credit', 'USD', 'securities'),
];
const transferLegs = (id: string) => [
  leg(id, 'wallet_transfer', 'debit', 'USD', 'securities'),
  leg(id, 'wallet_transfer', 'credit', 'USD', 'crypto_spot'),
];

function setup(input: {
  mode?: string;
  exchanges?: Array<{ id: string; executedAt: Date }>;
  transfers?: Array<{ id: string; executedAt: Date }>;
  legs?: Leg[];
  integrityError?: Error;
}) {
  const prisma = {
    exchangeTransaction: {
      findMany: jest.fn().mockResolvedValue(input.exchanges ?? []),
    },
    walletTransfer: {
      findMany: jest.fn().mockResolvedValue(input.transfers ?? []),
    },
    walletTransaction: {
      findMany: jest.fn(({ where }: { where: { referenceType: string } }) =>
        Promise.resolve(
          (input.legs ?? []).filter((row) =>
            where.referenceType === 'exchange_transaction'
              ? row.txType.startsWith('exchange_')
              : row.txType === 'wallet_transfer',
          ),
        ),
      ),
    },
  };
  const account = {
    id: ACCOUNT,
    userId: 'user-1',
    mode: input.mode ?? 'beginner',
  };
  const access = {
    getOwnedAccountOrThrow: jest.fn().mockResolvedValue(account),
  };
  const performance = {
    assertGeneralAccountReady: input.integrityError
      ? jest.fn().mockRejectedValue(input.integrityError)
      : jest.fn().mockResolvedValue({}),
  };
  const service = new BeginnerQuestsService(
    prisma as unknown as PrismaService,
    access as unknown as TradingAccountAccessService,
    performance as unknown as GeneralAccountPerformanceService,
  );
  return { service, prisma, access, performance };
}

const errorCode = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { error: { code: string } }).error.code,
      message: (error.getResponse() as { error: { message: string } }).error
        .message,
    };
  }
  throw new Error('expected rejection');
};

describe('BeginnerQuestsService', () => {
  it('starts a fresh beginner account at 0/2 without writing anything', async () => {
    const { service, prisma, access, performance } = setup({});
    const result = await service.getQuestProgress('user-1', ` ${ACCOUNT} `);

    expect(access.getOwnedAccountOrThrow).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
    );
    expect(performance.assertGeneralAccountReady).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      data: {
        tradingAccountId: ACCOUNT,
        quests: [
          {
            questId: 'common-01-trading-funds',
            status: 'not_started',
            completedStepCount: 0,
            totalStepCount: 2,
            steps: [
              {
                stepId: 'fx_krw_to_usd',
                completed: false,
                completedAt: null,
                referenceId: null,
              },
              {
                stepId: 'transfer_securities_usd_to_crypto_spot_usd',
                completed: false,
                completedAt: null,
                referenceId: null,
              },
            ],
          },
        ],
      },
    });
    // No proven FX means the transfer step is never even looked up.
    expect(prisma.walletTransfer.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
  });

  it('selects only committed standalone KRW→USD FX of this account', async () => {
    const { service, prisma } = setup({});
    await service.getQuestProgress('user-1', ACCOUNT);

    expect(prisma.exchangeTransaction.findMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: ACCOUNT,
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        walletTransferExecuteRequest: { is: null },
        fxExecuteRequests: {
          some: { tradingAccountId: ACCOUNT, status: 'succeeded' },
        },
      },
      orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, executedAt: true },
    });
  });

  it('counts the FX step once its two Securities ledger legs prove it (1/2)', async () => {
    const { service, prisma } = setup({
      exchanges: [{ id: 'fx-1', executedAt: FX_AT }],
      legs: fxLegs('fx-1'),
    });
    const quest = (await service.getQuestProgress('user-1', ACCOUNT)).data
      .quests[0];

    expect(quest.status).toBe('in_progress');
    expect(quest.completedStepCount).toBe(1);
    expect(quest.steps[0]).toEqual({
      stepId: 'fx_krw_to_usd',
      completed: true,
      completedAt: FX_AT.toISOString(),
      referenceId: 'fx-1',
    });
    expect(quest.steps[1].completed).toBe(false);
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tradingAccountId: ACCOUNT,
          referenceType: 'exchange_transaction',
          referenceId: { in: ['fx-1'] },
        },
      }),
    );
    // Only Securities USD → Crypto Spot USD, standalone, strictly after FX.
    expect(prisma.walletTransfer.findMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: ACCOUNT,
        currencyCode: 'USD',
        compositeCommand: { is: null },
        executedAt: { gt: FX_AT },
        sourceWallet: {
          is: {
            tradingAccountId: ACCOUNT,
            walletScope: 'securities',
            currencyCode: 'USD',
          },
        },
        destinationWallet: {
          is: {
            tradingAccountId: ACCOUNT,
            walletScope: 'crypto_spot',
            currencyCode: 'USD',
          },
        },
      },
      orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, executedAt: true },
    });
  });

  it('completes the quest with a proven transfer after the FX (2/2)', async () => {
    const { service } = setup({
      exchanges: [{ id: 'fx-1', executedAt: FX_AT }],
      transfers: [{ id: 'tr-1', executedAt: TRANSFER_AT }],
      legs: [...fxLegs('fx-1'), ...transferLegs('tr-1')],
    });
    const quest = (await service.getQuestProgress('user-1', ACCOUNT)).data
      .quests[0];

    expect(quest.status).toBe('completed');
    expect(quest.completedStepCount).toBe(2);
    expect(quest.steps[1]).toEqual({
      stepId: 'transfer_securities_usd_to_crypto_spot_usd',
      completed: true,
      completedAt: TRANSFER_AT.toISOString(),
      referenceId: 'tr-1',
    });
  });

  it.each([
    ['no ledger legs', []],
    ['only one leg', [fxLegs('fx-1')[0]]],
    [
      'a leg on a crypto wallet',
      [
        fxLegs('fx-1')[0],
        leg('fx-1', 'exchange_target', 'credit', 'USD', 'crypto_spot'),
      ],
    ],
    [
      'a leg on another account wallet',
      [
        fxLegs('fx-1')[0],
        leg('fx-1', 'exchange_target', 'credit', 'USD', 'securities', 'other'),
      ],
    ],
    ['a duplicated leg', [...fxLegs('fx-1'), fxLegs('fx-1')[1]]],
  ])('never infers the FX step from %s', async (_label, legs) => {
    const { service } = setup({
      exchanges: [{ id: 'fx-1', executedAt: FX_AT }],
      legs,
    });
    const quest = (await service.getQuestProgress('user-1', ACCOUNT)).data
      .quests[0];
    expect(quest.status).toBe('not_started');
    expect(quest.steps.every((step) => !step.completed)).toBe(true);
  });

  it('skips an unproven earliest FX and uses the first proven one', async () => {
    const later = new Date('2026-10-10T02:00:00.000Z');
    const { service } = setup({
      exchanges: [
        { id: 'fx-broken', executedAt: FX_AT },
        { id: 'fx-2', executedAt: later },
      ],
      legs: fxLegs('fx-2'),
    });
    const fx = (await service.getQuestProgress('user-1', ACCOUNT)).data
      .quests[0].steps[0];
    expect(fx.referenceId).toBe('fx-2');
    expect(fx.completedAt).toBe(later.toISOString());
  });

  it('does not count a transfer whose legs land on the wrong wallets', async () => {
    const { service } = setup({
      exchanges: [{ id: 'fx-1', executedAt: FX_AT }],
      transfers: [{ id: 'tr-1', executedAt: TRANSFER_AT }],
      legs: [
        ...fxLegs('fx-1'),
        leg('tr-1', 'wallet_transfer', 'debit', 'USD', 'securities'),
        leg('tr-1', 'wallet_transfer', 'credit', 'USD', 'crypto_futures'),
      ],
    });
    const quest = (await service.getQuestProgress('user-1', ACCOUNT)).data
      .quests[0];
    expect(quest.status).toBe('in_progress');
    expect(quest.steps[1].completed).toBe(false);
  });

  it.each(['general', 'season'])(
    'refuses %s accounts before reading any financial row',
    async (mode) => {
      const { service, prisma, performance } = setup({ mode });
      expect(
        await errorCode(service.getQuestProgress('user-1', ACCOUNT)),
      ).toEqual({
        status: 409,
        code: 'BEGINNER_QUEST_ACCOUNT_ONLY',
        message: 'Quests are available only for beginner accounts.',
      });
      expect(performance.assertGeneralAccountReady).not.toHaveBeenCalled();
      expect(prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
    },
  );

  it('requires a user and fails closed on damaged financial rows', async () => {
    const anonymous = setup({});
    expect(
      await errorCode(anonymous.service.getQuestProgress(undefined, ACCOUNT)),
    ).toEqual({ status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    expect(anonymous.access.getOwnedAccountOrThrow).not.toHaveBeenCalled();

    const damaged = setup({ integrityError: new Error('integrity') });
    await expect(
      damaged.service.getQuestProgress('user-1', ACCOUNT),
    ).rejects.toThrow('integrity');
    expect(damaged.prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
  });
});
