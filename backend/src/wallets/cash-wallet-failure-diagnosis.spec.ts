// The generated Prisma client is not resolvable under ts-jest; the repo
// convention is to stub the pieces a unit spec actually uses.
jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { diagnoseCashWalletMutationFailure } from './cash-wallet-failure-diagnosis';

/**
 * 작업 5 보완 3. The point of this helper is that a 0-row guarded UPDATE is
 * classified by what is ACTUALLY wrong, and that scope corruption can no
 * longer disguise itself as "wallet not found" or a generic CONFLICT.
 */
describe('diagnoseCashWalletMutationFailure', () => {
  const expected = {
    seasonParticipantId: 'participant-1',
    tradingAccountId: 'account-1',
    currencyCode: 'KRW',
  };

  const wallet = (overrides: Record<string, unknown> = {}) => ({
    id: 'wallet-1',
    seasonParticipantId: 'participant-1',
    tradingAccountId: 'account-1',
    currencyCode: 'KRW',
    balanceAmount: new Prisma.Decimal('1000.00000000'),
    reservedAmount: new Prisma.Decimal('0.00000000'),
    ...overrides,
  });

  const createClient = (row: unknown) => ({
    cashWallet: {
      findUnique: jest.fn().mockResolvedValue(row),
    },
  });

  const errorCode = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpException) {
        return (error.getResponse() as { error: { code: string } }).error.code;
      }
      throw error;
    }
    throw new Error('expected the diagnosis to throw');
  };

  it('re-reads the wallet BY ID ONLY so a corrupted scope stays visible', async () => {
    const client = createClient(wallet());
    await diagnoseCashWalletMutationFailure(client as never, {
      walletId: 'wallet-1',
      expected,
    });

    expect(client.cashWallet.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-1' } }),
    );
  });

  it('reports a genuinely missing wallet', async () => {
    await expect(
      diagnoseCashWalletMutationFailure(createClient(null) as never, {
        walletId: 'wallet-1',
        expected,
      }),
    ).resolves.toBe('wallet_not_found');
  });

  it('throws repair-required when the trading-account scope is null', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(wallet({ tradingAccountId: null })) as never,
          { walletId: 'wallet-1', expected },
        ),
      ),
    ).resolves.toBe('FINANCIAL_SCOPE_REPAIR_REQUIRED');
  });

  it('throws scope mismatch when the trading account differs', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(wallet({ tradingAccountId: 'other-account' })) as never,
          { walletId: 'wallet-1', expected },
        ),
      ),
    ).resolves.toBe('FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH');
  });

  it('throws scope mismatch when the participant differs', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(
            wallet({ seasonParticipantId: 'other-participant' }),
          ) as never,
          { walletId: 'wallet-1', expected },
        ),
      ),
    ).resolves.toBe('FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH');
  });

  it('throws scope mismatch when a general (participant-less) wallet is reached', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(wallet({ seasonParticipantId: null })) as never,
          { walletId: 'wallet-1', expected },
        ),
      ),
    ).resolves.toBe('FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH');
  });

  it('throws scope mismatch when the currency differs', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(wallet({ currencyCode: 'USD' })) as never,
          { walletId: 'wallet-1', expected },
        ),
      ),
    ).resolves.toBe('FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH');
  });

  it('classifies an available-balance shortfall (reserved cash is not spendable)', async () => {
    await expect(
      diagnoseCashWalletMutationFailure(
        createClient(
          wallet({ reservedAmount: new Prisma.Decimal('900.00000000') }),
        ) as never,
        { walletId: 'wallet-1', expected, requires: { available: '200' } },
      ),
    ).resolves.toBe('insufficient_available');
  });

  it('classifies a raw balance shortfall', async () => {
    await expect(
      diagnoseCashWalletMutationFailure(createClient(wallet()) as never, {
        walletId: 'wallet-1',
        expected,
        requires: { balance: '1000.00000001' },
      }),
    ).resolves.toBe('insufficient_balance');
  });

  it('classifies an uncovered reservation', async () => {
    await expect(
      diagnoseCashWalletMutationFailure(
        createClient(
          wallet({ reservedAmount: new Prisma.Decimal('10.00000000') }),
        ) as never,
        { walletId: 'wallet-1', expected, requires: { reserved: '20' } },
      ),
    ).resolves.toBe('insufficient_reserved');
  });

  it('reports a real concurrency conflict when scope and amounts both hold', async () => {
    await expect(
      diagnoseCashWalletMutationFailure(createClient(wallet()) as never, {
        walletId: 'wallet-1',
        expected,
        requires: { available: '1000', balance: '1000', reserved: '0' },
      }),
    ).resolves.toBe('conflict');
  });

  it('checks scope BEFORE amounts, so a broken scope is never reported as a shortfall', async () => {
    await expect(
      errorCode(
        diagnoseCashWalletMutationFailure(
          createClient(
            wallet({
              tradingAccountId: null,
              balanceAmount: new Prisma.Decimal('0.00000000'),
            }),
          ) as never,
          { walletId: 'wallet-1', expected, requires: { available: '999999' } },
        ),
      ),
    ).resolves.toBe('FINANCIAL_SCOPE_REPAIR_REQUIRED');
  });

  it('never writes to the wallet while diagnosing', async () => {
    const client = {
      cashWallet: {
        findUnique: jest.fn().mockResolvedValue(wallet()),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };

    await diagnoseCashWalletMutationFailure(client as never, {
      walletId: 'wallet-1',
      expected,
    });

    expect(client.cashWallet.update).not.toHaveBeenCalled();
    expect(client.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(client.cashWallet.create).not.toHaveBeenCalled();
  });
});
