jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal },
    AdRewardClaimStatus: { granted: 'granted' },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    WalletTransactionDirection: { credit: 'credit', debit: 'debit' },
    WalletTransactionReferenceType: {
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      ad_reward: 'ad_reward',
    },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { GeneralExternalFundingService } from './general-external-funding.service';

/**
 * Performance epochs (general-account reset, 2026-10-20): the lifetime
 * allow-list is validated as before; the epoch principal is the reset target
 * plus the rewards granted since, derived arithmetically.
 */

const ACCOUNT = 'account-1';
const KRW_WALLET = 'krw-wallet';
const d = (value: string) => new Prisma.Decimal(value);

const grant = {
  id: 'grant',
  walletId: KRW_WALLET,
  currencyCode: 'KRW',
  direction: 'credit',
  txType: 'initial_grant',
  referenceType: 'general_account_open',
  referenceId: ACCOUNT,
  amount: d('10000000'),
};
const reward = (id: string) => ({
  id: `ledger-${id}`,
  walletId: KRW_WALLET,
  currencyCode: 'KRW',
  direction: 'credit',
  txType: 'ad_reward',
  referenceType: 'ad_reward_claim',
  referenceId: id,
  amount: d('5000000'),
});
const claim = (id: string) => ({
  id,
  status: 'granted',
  tradingAccountId: ACCOUNT,
  rewardAmountKrw: d('5000000'),
  walletTransactionId: `ledger-${id}`,
});

function client(
  rows: unknown[],
  reset: null | {
    lifetimeExternalFundingKrw: string;
    targetKrwBalance?: string;
  },
) {
  const claims = rows
    .filter((row) => (row as { txType: string }).txType === 'ad_reward')
    .map((row) => claim((row as { referenceId: string }).referenceId));
  return {
    walletTransaction: { findMany: jest.fn().mockResolvedValue(rows) },
    adRewardClaim: { findMany: jest.fn().mockResolvedValue(claims) },
    cashWallet: {},
    generalAccountReset: {
      findFirst: jest.fn().mockResolvedValue(
        reset && {
          id: 'reset-2',
          sequence: 2,
          resetAt: new Date('2026-10-20T01:00:00.000Z'),
          targetKrwBalance: d(reset.targetKrwBalance ?? '10000000'),
          lifetimeExternalFundingKrw: d(reset.lifetimeExternalFundingKrw),
        },
      ),
    },
  };
}

const service = new GeneralExternalFundingService({} as never);

describe('GeneralExternalFundingService epochs', () => {
  it('without a reset the epoch is the opening one and every value is lifetime', async () => {
    const summary = await service.summarize(
      ACCOUNT,
      KRW_WALLET,
      client([grant, reward('c1')], null) as never,
    );
    expect(summary.initialFundingKrw.toString()).toBe('10000000');
    expect(summary.cumulativeAdRewardKrw.toString()).toBe('5000000');
    expect(summary.cumulativeExternalFundingKrw.toString()).toBe('15000000');
    expect(summary.lifetimeExternalFundingKrw.toString()).toBe('15000000');
    expect(summary.epoch).toEqual({
      sequence: 0,
      resetId: null,
      startedAt: null,
    });
  });

  it('after a reset the principal is the target plus the rewards granted since', async () => {
    // c1 was granted before the reset (lifetime then 15M), c2 after it.
    const summary = await service.summarize(
      ACCOUNT,
      KRW_WALLET,
      client([grant, reward('c1'), reward('c2')], {
        lifetimeExternalFundingKrw: '15000000',
      }) as never,
    );
    expect(summary.initialFundingKrw.toString()).toBe('10000000');
    expect(summary.cumulativeAdRewardKrw.toString()).toBe('5000000');
    expect(summary.cumulativeExternalFundingKrw.toString()).toBe('15000000');
    expect(summary.lifetimeExternalFundingKrw.toString()).toBe('20000000');
    expect(summary.epoch).toEqual({
      sequence: 2,
      resetId: 'reset-2',
      startedAt: new Date('2026-10-20T01:00:00.000Z'),
    });
  });

  it('right after a reset the principal is exactly the target', async () => {
    const summary = await service.summarize(
      ACCOUNT,
      KRW_WALLET,
      client([grant, reward('c1')], {
        lifetimeExternalFundingKrw: '15000000',
      }) as never,
    );
    expect(summary.cumulativeExternalFundingKrw.toString()).toBe('10000000');
    expect(summary.cumulativeAdRewardKrw.toString()).toBe('0');
  });

  it.each([
    ['above the verified lifetime total', '25000000'],
    ['below the opening grant', '9000000'],
  ])(
    'fails closed when the reset records a lifetime total %s',
    async (_label, recorded) => {
      await expect(
        service.summarize(
          ACCOUNT,
          KRW_WALLET,
          client([grant, reward('c1')], {
            lifetimeExternalFundingKrw: recorded,
          }) as never,
        ),
      ).rejects.toBeInstanceOf(HttpException);
    },
  );
});
