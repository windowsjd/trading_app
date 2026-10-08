jest.mock('../generated/prisma/client', () => ({
  ...jest.requireActual('../generated/prisma/enums'),
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class PrismaClient {},
}));
import { Prisma } from '../generated/prisma/client';
import { TradingAccountWalletTransferService } from './trading-account-wallet-transfer.service';
import {
  captureFinancialFailure,
  expectSafeFinancialDiagnostic,
} from '../../test/support/financial-diagnostics';
import { assertDiagnosticTriage } from '../../scripts/lib/diagnostic-quality';

const wallet = (id = 'source') => ({
  id,
  tradingAccountId: 'account-1',
  walletScope: 'securities',
  currencyCode: 'USD',
  balanceAmount: new Prisma.Decimal('987654.12345678'),
  reservedAmount: new Prisma.Decimal(0),
});
const input = () => ({
  accountId: 'account-1',
  source: wallet(),
  destination: { ...wallet('target'), walletScope: 'crypto_spot' },
  amount: '50.00000000',
  idempotencyKey: 'key',
  requestHash: 'hash',
  executeNow: new Date(),
});
const path = '/api/v1/trading-accounts/account-1/wallet-transfers';

describe('Transfer observed financial failure diagnostics', () => {
  it.each([
    ['missing', null, 'wallet_not_found'],
    [
      'account',
      { tradingAccountId: 'foreign-account' },
      'account_scope_mismatch',
    ],
    ['scope', { walletScope: 'crypto_futures' }, 'wallet_scope_mismatch'],
    ['currency', { currencyCode: 'KRW' }, 'currency_mismatch'],
    [
      'balance',
      { balanceAmount: new Prisma.Decimal(1) },
      'insufficient_available',
    ],
    [
      'reserved',
      { reservedAmount: new Prisma.Decimal('987654.12345678') },
      'insufficient_available',
    ],
    ['conflict', {}, 'conflict'],
  ])(
    '%s rejection keeps observed predicates without extra reads',
    async (_label, override, reason) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(0),
        cashWallet: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              override === null ? null : { ...wallet(), ...override },
            ),
          updateMany: jest.fn(),
        },
        walletTransfer: { create: jest.fn() },
        walletTransaction: { createMany: jest.fn() },
      };
      const service = new TradingAccountWalletTransferService(
        {} as never,
        {} as never,
        {} as never,
      );
      const { diagnostic } = await captureFinancialFailure(
        () => service.transferInTransaction(tx as never, input() as never),
        'admin',
        path,
      );
      assertDiagnosticTriage(
        diagnostic,
        diagnostic!.code,
        'wallet transfer guard',
      );
      expect(diagnostic).toMatchObject({
        operation: 'WALLET_TRANSFER',
        failureStage: 'transfer_source_debit',
        evidence: {
          financialGuard: {
            financialOperation: 'wallet_transfer',
            failureReason: reason,
            mutationAffected: 0,
            observation: 'failure_read',
          },
        },
      });
      expectSafeFinancialDiagnostic(diagnostic);
      expect(tx.cashWallet.findUnique).toHaveBeenCalledTimes(1);
      expect(tx.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(tx.walletTransfer.create).not.toHaveBeenCalled();
    },
  );
  it.each(['admin', 'user', 'operator'])(
    'credit rejection is scoped and gated for %s',
    async (role) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        cashWallet: {
          findUnique: jest.fn().mockResolvedValue(input().destination),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const service = new TradingAccountWalletTransferService(
        {} as never,
        {} as never,
        {} as never,
      );
      const { diagnostic } = await captureFinancialFailure(
        () => service.transferInTransaction(tx as never, input() as never),
        role,
        path,
      );
      if (role === 'admin') {
        expect(diagnostic).toMatchObject({
          failureStage: 'transfer_destination_credit',
          evidence: {
            financialGuard: {
              failureReason: 'conflict',
              scopeValid: true,
              currencyMatched: true,
            },
          },
        });
        expectSafeFinancialDiagnostic(diagnostic);
      } else expect(diagnostic).toBeUndefined();
      expect(tx.cashWallet.findUnique).toHaveBeenCalledTimes(1);
    },
  );
});
