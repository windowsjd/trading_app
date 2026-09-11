jest.mock('../../src/generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import {
  repairFinancialTradingAccountScope,
  resolveFinancialScopeExitCode,
  type FinancialScopeSummary,
} from './repair-financial-trading-account-scope';

const nullRow = (id: string, accountId: string | null) => ({
  id,
  seasonParticipantId: `sp-${id}`,
  participantTradingAccountId: accountId,
});

const createPrisma = () => {
  const nullRowsByTable: Record<string, ReturnType<typeof nullRow>[]> = {};
  const prisma = {
    nullRowsByTable,
    $queryRawUnsafe: jest.fn(
      (sql: string, cursorId = ''): Promise<unknown[]> => {
        if (sql.includes('ORDER BY t."id" ASC')) {
          const table = /FROM "([^"]+)" t/.exec(sql)?.[1] ?? '';
          return Promise.resolve(
            (nullRowsByTable[table] ?? []).filter((row) => row.id > cursorId),
          );
        }
        return Promise.resolve([{ n: 0 }]);
      },
    ),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );

  return prisma;
};

describe('repairFinancialTradingAccountScope', () => {
  it('dry-run scans all four models and never writes', async () => {
    const prisma = createPrisma();
    prisma.nullRowsByTable.cash_wallets = [
      nullRow('w1', 'ta-1'),
      nullRow('w2', 'ta-1'),
    ];
    prisma.nullRowsByTable.wallet_transactions = [nullRow('t1', 'ta-1')];

    const summary = await repairFinancialTradingAccountScope(prisma as never, {
      apply: false,
    });

    expect(summary.mode).toBe('dry-run');
    expect(summary.models.cashWallet.nullRowCount).toBe(2);
    expect(summary.models.cashWallet.backfilledCount).toBe(2);
    expect(summary.models.walletTransaction.backfilledCount).toBe(1);
    expect(summary.models.exchangeTransaction.nullRowCount).toBe(0);
    expect(summary.failures).toEqual([]);
    expect(summary.remainingNullCounts).toBeNull();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('apply backfills null rows via guarded grouped updates and re-verifies', async () => {
    const prisma = createPrisma();
    prisma.nullRowsByTable.cash_wallets = [
      nullRow('w1', 'ta-1'),
      nullRow('w2', 'ta-2'),
    ];
    prisma.$executeRawUnsafe.mockResolvedValue(1);

    const summary = await repairFinancialTradingAccountScope(prisma as never, {
      apply: true,
    });

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "cash_wallets"'),
      'ta-1',
      ['w1'],
    );
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "cash_wallets"'),
      'ta-2',
      ['w2'],
    );
    expect(summary.models.cashWallet.backfilledCount).toBe(2);
    expect(summary.remainingNullCounts).toEqual({
      cashWallet: 0,
      walletTransaction: 0,
      exchangeTransaction: 0,
      fxExecuteRequest: 0,
    });
    expect(summary.remainingMismatchCounts).toEqual({
      cashWallet: 0,
      walletTransaction: 0,
      exchangeTransaction: 0,
      fxExecuteRequest: 0,
    });
  });

  it('reports rows blocked by a missing participant link and never touches them', async () => {
    const prisma = createPrisma();
    prisma.nullRowsByTable.wallet_transactions = [nullRow('t1', null)];

    const summary = await repairFinancialTradingAccountScope(prisma as never, {
      apply: true,
    });

    expect(summary.models.walletTransaction.missingParticipantLinkRows).toEqual(
      [{ rowId: 't1', seasonParticipantId: 'sp-t1' }],
    );
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports scope mismatches as failures without overwriting anything', async () => {
    const prisma = createPrisma();
    // Participant mismatch counter for cashWallet returns 3.
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('ORDER BY t."id" ASC')
          ? []
          : sql.includes('"cash_wallets" t')
            ? [{ n: 3 }]
            : [{ n: 0 }],
      ),
    );

    const summary = await repairFinancialTradingAccountScope(prisma as never, {
      apply: false,
    });

    expect(summary.models.cashWallet.mismatchCount).toBe(3);
    expect(summary.failures).toEqual([
      expect.objectContaining({
        model: 'cashWallet',
        code: 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      }),
    ]);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports wallet-vs-transaction scope disagreements', async () => {
    const prisma = createPrisma();
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('ORDER BY t."id" ASC')
          ? []
          : sql.includes('JOIN "cash_wallets" w')
            ? [{ n: 2 }]
            : [{ n: 0 }],
      ),
    );

    const summary = await repairFinancialTradingAccountScope(prisma as never, {
      apply: false,
    });

    expect(summary.walletTransactionWalletMismatchCount).toBe(2);
    expect(summary.failures).toEqual([
      expect.objectContaining({
        model: 'walletTransaction',
        code: 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      }),
    ]);
  });
});

describe('resolveFinancialScopeExitCode', () => {
  const zeroCounts = {
    cashWallet: 0,
    walletTransaction: 0,
    exchangeTransaction: 0,
    fxExecuteRequest: 0,
  };
  const modelSummary = {
    nullRowCount: 0,
    backfilledCount: 0,
    missingParticipantLinkRows: [],
    mismatchCount: 0,
  };
  const base: FinancialScopeSummary = {
    mode: 'apply',
    models: {
      cashWallet: modelSummary,
      walletTransaction: modelSummary,
      exchangeTransaction: modelSummary,
      fxExecuteRequest: modelSummary,
    },
    walletTransactionWalletMismatchCount: 0,
    failures: [],
    remainingNullCounts: zeroCounts,
    remainingMismatchCounts: zeroCounts,
  };

  it('exits 0 when apply converged clean', () => {
    expect(resolveFinancialScopeExitCode(base).exitCode).toBe(0);
  });

  it('exits 1 when nulls remain after apply', () => {
    expect(
      resolveFinancialScopeExitCode({
        ...base,
        remainingNullCounts: { ...zeroCounts, walletTransaction: 4 },
      }).exitCode,
    ).toBe(1);
  });

  it('exits 1 when mismatches remain after apply', () => {
    expect(
      resolveFinancialScopeExitCode({
        ...base,
        remainingMismatchCounts: { ...zeroCounts, fxExecuteRequest: 1 },
      }).exitCode,
    ).toBe(1);
  });

  it('exits 1 on any reported failure and when verification is unreadable', () => {
    expect(
      resolveFinancialScopeExitCode({
        ...base,
        failures: [
          {
            model: 'cashWallet',
            rowId: 'w1',
            code: 'FINANCIAL_SCOPE_BACKFILL_FAILED',
            message: 'boom',
          },
        ],
      }).exitCode,
    ).toBe(1);
    expect(
      resolveFinancialScopeExitCode({ ...base, remainingNullCounts: null })
        .exitCode,
    ).toBe(1);
  });

  it('dry-run exits 0 when only pending backfills were found', () => {
    expect(
      resolveFinancialScopeExitCode({
        ...base,
        mode: 'dry-run',
        remainingNullCounts: null,
        remainingMismatchCounts: null,
      }).exitCode,
    ).toBe(0);
  });
});
