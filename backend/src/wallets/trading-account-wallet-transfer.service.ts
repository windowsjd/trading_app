import {
  isStandaloneAccountMode,
  assertBeginnerModeEnabled,
} from '../trading-accounts/account-mode-policy';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  TradingAccountStatus,
  type WalletScope,
  type CashWallet,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { assertCashWalletTradingAccountScope } from './cash-wallet-scope';
import { debitAvailableCash } from './cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from './cash-wallet-failure-diagnosis';
import { canonicalCashWalletSetIssue } from './canonical-cash-wallets';
import { assertFuturesTransferCollateral } from '../futures/futures-collateral';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

export type WalletTransferRequest = {
  sourceWalletId?: unknown;
  destinationWalletId?: unknown;
  amount?: unknown;
  idempotencyKey?: unknown;
};
export type WalletTransferResult = {
  success: true;
  data: {
    tradingAccountId: string;
    transferId: string;
    currencyCode: 'USD';
    amount: string;
    executedAt: string;
    source: TransferWalletResult;
    destination: TransferWalletResult;
  };
};
type TransferWalletResult = {
  walletId: string;
  walletScope: WalletScope;
  balanceAfter: string;
  availableAfter: string;
};

/** Committed command, two cash legs and two ledger legs form one DB transaction. */
@Injectable()
export class TradingAccountWalletTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly performance: GeneralAccountPerformanceService,
  ) {}

  async transfer(
    userId: string | undefined,
    accountId: string,
    body: WalletTransferRequest,
  ): Promise<WalletTransferResult> {
    if (!userId) fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    const request = parseRequest(body);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: 'wallet-transfer:v1',
          sourceWalletId: request.sourceWalletId,
          destinationWalletId: request.destinationWalletId,
          amount: request.amount,
        }),
      )
      .digest('hex');
    const commandKey = {
      tradingAccountId_idempotencyKey: {
        tradingAccountId: accountId,
        idempotencyKey: request.idempotencyKey,
      },
    };
    const replay = (row: {
      requestHash: string;
      responsePayloadJson: Prisma.JsonValue;
    }) => {
      if (row.requestHash !== requestHash)
        fail(
          HttpStatus.CONFLICT,
          'WALLET_TRANSFER_IDEMPOTENCY_CONFLICT',
          'Idempotency key was used for a different wallet transfer.',
        );
      return row.responsePayloadJson as unknown as WalletTransferResult;
    };
    const existing = await this.prisma.walletTransfer.findUnique({
      where: commandKey,
    });
    if (existing) return replay(existing);

    setAdminDiagnosticContext({ failureStage: 'transfer_transaction_start' });
    try {
      return await this.prisma.$transaction(async (tx) => {
        setAdminDiagnosticContext({ failureStage: 'transfer_account_lock' });
        // Same lifecycle ordering as orders/FX; General uses the existing TWR fence.
        let seasonContext: Awaited<
          ReturnType<typeof lockSeasonTradingContext>
        > | null = null;
        if (isStandaloneAccountMode(account.mode)) {
          await tx.$queryRaw`SELECT "id" FROM "trading_accounts" WHERE "id" = ${accountId} FOR UPDATE`;
        } else {
          seasonContext = await lockSeasonTradingContext(tx, {
            userId,
            seasonParticipantId: account.seasonParticipant!.id,
            participantWrite: false,
          });
          if (seasonContext.account.id !== accountId)
            fail(
              HttpStatus.INTERNAL_SERVER_ERROR,
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Season account scope changed.',
            );
        }
        const lockedAccount = await this.access.getOwnedAccountOrThrow(
          userId,
          accountId,
          tx,
        );
        const raced = await tx.walletTransfer.findUnique({ where: commandKey });
        if (raced) return replay(raced);
        assertBeginnerModeEnabled(lockedAccount.mode);
        if (lockedAccount.status !== TradingAccountStatus.active)
          fail(
            HttpStatus.CONFLICT,
            'TRADING_ACCOUNT_NOT_ACTIVE',
            'Trading account is not active.',
          );
        if (lockedAccount.mode !== account.mode)
          fail(
            HttpStatus.INTERNAL_SERVER_ERROR,
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Account mode changed.',
          );
        if (isStandaloneAccountMode(lockedAccount.mode))
          await this.performance.assertGeneralAccountReady(lockedAccount, tx);

        // ID order prevents opposite-direction transfers from forming a wallet lock cycle.
        // The account predicate excludes foreign rows before any lock or mutation.
        setAdminDiagnosticContext({ failureStage: 'transfer_wallet_lock' });
        await tx.$queryRaw`
          SELECT "id" FROM "cash_wallets"
          WHERE "trading_account_id" = ${accountId}
            AND "id" IN (${request.sourceWalletId}, ${request.destinationWalletId})
          ORDER BY "id" FOR UPDATE
        `;
        // A waiter may pass the Season deadline while the winning command commits.
        // Replay is a read of committed money, so return it before new-mutation gates.
        const afterLockReplay = await tx.walletTransfer.findUnique({
          where: commandKey,
        });
        if (afterLockReplay) return replay(afterLockReplay);
        const [clock] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS "now"`;
        if (seasonContext) {
          const { season, participant } = seasonContext;
          if (participant.participantStatus === ParticipantStatus.excluded)
            fail(
              HttpStatus.FORBIDDEN,
              'PARTICIPANT_EXCLUDED',
              'Season participant is excluded.',
            );
          if (participant.participantStatus !== ParticipantStatus.active)
            fail(
              HttpStatus.CONFLICT,
              'PARTICIPANT_NOT_ACTIVE',
              'Season participant is not active.',
            );
          if (season.status !== SeasonStatus.active)
            fail(
              HttpStatus.CONFLICT,
              'SEASON_NOT_ACTIVE',
              'Season is not active.',
            );
          if (clock.now < season.startAt)
            fail(
              HttpStatus.CONFLICT,
              'SEASON_NOT_STARTED',
              'Season has not started.',
            );
          if (clock.now >= season.endAt)
            fail(HttpStatus.CONFLICT, 'SEASON_ENDED', 'Season has ended.');
        }
        setAdminDiagnosticContext({ failureStage: 'transfer_wallet_read' });
        const wallets = await tx.cashWallet.findMany({
          where: { tradingAccountId: accountId },
        });
        if (canonicalCashWalletSetIssue(wallets))
          fail(
            HttpStatus.INTERNAL_SERVER_ERROR,
            'FINANCIAL_SCOPE_REPAIR_REQUIRED',
            'Canonical cash wallets are missing or inconsistent.',
          );
        const source = wallets.find(
          (wallet) => wallet.id === request.sourceWalletId,
        );
        const destination = wallets.find(
          (wallet) => wallet.id === request.destinationWalletId,
        );
        if (!source || !destination)
          fail(
            HttpStatus.NOT_FOUND,
            'WALLET_TRANSFER_WALLET_NOT_FOUND',
            'Transfer wallets were not found in this account.',
          );
        const result = await this.transferInTransaction(tx, {
          accountId,
          source,
          destination,
          amount: request.amount,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          executeNow: clock.now,
        });
        setAdminDiagnosticContext({
          failureStage: 'transfer_transaction_commit',
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.walletTransfer.findUnique({
          where: commandKey,
        });
        if (winner) return replay(winner);
      }
      throw error;
    }
  }

  /** Caller owns lifecycle/wallet locks and the transaction; no commit/replay here. */
  async transferInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      accountId: string;
      source: CashWallet;
      destination: CashWallet;
      amount: string;
      idempotencyKey: string;
      requestHash: string;
      executeNow: Date;
    },
  ): Promise<WalletTransferResult> {
    setAdminDiagnosticContext({
      failureStage: 'transfer_wallet_validation',
      nextInvestigation: [
        'backend/src/wallets/trading-account-wallet-transfer.service.ts',
        'backend/src/wallets/cash-wallet-failure-diagnosis.ts',
      ],
    });
    const {
      accountId,
      source,
      destination,
      amount,
      idempotencyKey,
      requestHash,
      executeNow,
    } = input;
    if (
      source.currencyCode !== CurrencyCode.USD ||
      destination.currencyCode !== CurrencyCode.USD
    )
      fail(
        HttpStatus.BAD_REQUEST,
        'WALLET_TRANSFER_USD_ONLY',
        'Only same-currency USD transfers are supported.',
      );
    for (const wallet of [source, destination]) {
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId: accountId,
        walletScope: wallet.walletScope,
      });
    }
    setAdminDiagnosticContext({
      failureStage: 'transfer_collateral_validation',
    });
    await assertFuturesTransferCollateral(tx, source, amount);
    setAdminDiagnosticContext({ failureStage: 'transfer_source_debit' });
    const changed = await debitAvailableCash(tx, {
      walletId: source.id,
      tradingAccountId: accountId,
      walletScope: source.walletScope,
      currencyCode: CurrencyCode.USD,
      amount: amount,
    });
    if (changed !== 1) {
      await diagnoseCashWalletMutationFailure(tx, {
        walletId: source.id,
        expected: {
          tradingAccountId: accountId,
          walletScope: source.walletScope,
          currencyCode: CurrencyCode.USD,
        },
        requires: { available: amount },
        diagnostic: {
          financialOperation: 'wallet_transfer',
          failureStage: 'transfer_source_debit',
          mutationAffected: changed,
        },
      });
      fail(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_AVAILABLE_BALANCE',
        'Available source balance is insufficient.',
      );
    }
    setAdminDiagnosticContext({ failureStage: 'transfer_destination_credit' });
    const credit = await tx.cashWallet.updateMany({
      where: {
        id: destination.id,
        tradingAccountId: accountId,
        walletScope: destination.walletScope,
        currencyCode: CurrencyCode.USD,
      },
      data: { balanceAmount: { increment: amount } },
    });
    if (credit.count !== 1) {
      await diagnoseCashWalletMutationFailure(tx, {
        walletId: destination.id,
        expected: {
          tradingAccountId: accountId,
          walletScope: destination.walletScope,
          currencyCode: CurrencyCode.USD,
        },
        diagnostic: {
          financialOperation: 'wallet_transfer',
          failureStage: 'transfer_destination_credit',
          mutationAffected: credit.count,
        },
      });
      fail(
        HttpStatus.CONFLICT,
        'WALLET_TRANSFER_CONFLICT',
        'Destination wallet changed.',
      );
    }
    const transferId = randomUUID();
    const decimalAmount = new Prisma.Decimal(amount);
    const sourceAfter = source.balanceAmount.sub(decimalAmount);
    const destinationAfter = destination.balanceAmount.add(decimalAmount);
    const result: WalletTransferResult = {
      success: true,
      data: {
        tradingAccountId: accountId,
        transferId,
        currencyCode: 'USD',
        amount: amount,
        executedAt: executeNow.toISOString(),
        source: {
          walletId: source.id,
          walletScope: source.walletScope,
          balanceAfter: sourceAfter.toFixed(8),
          availableAfter: sourceAfter.sub(source.reservedAmount).toFixed(8),
        },
        destination: {
          walletId: destination.id,
          walletScope: destination.walletScope,
          balanceAfter: destinationAfter.toFixed(8),
          availableAfter: destinationAfter
            .sub(destination.reservedAmount)
            .toFixed(8),
        },
      },
    };
    setAdminDiagnosticContext({ failureStage: 'transfer_command_write' });
    await tx.walletTransfer.create({
      data: {
        id: transferId,
        tradingAccountId: accountId,
        sourceWalletId: source.id,
        destinationWalletId: destination.id,
        currencyCode: CurrencyCode.USD,
        amount: amount,
        idempotencyKey: idempotencyKey,
        requestHash,
        responsePayloadJson: result as unknown as Prisma.InputJsonValue,
        executedAt: executeNow,
      },
    });
    setAdminDiagnosticContext({ failureStage: 'transfer_ledger_write' });
    await tx.walletTransaction.createMany({
      data: [
        {
          tradingAccountId: accountId,
          walletId: source.id,
          currencyCode: CurrencyCode.USD,
          direction: 'debit',
          txType: 'wallet_transfer',
          referenceType: 'wallet_transfer',
          referenceId: transferId,
          amount: amount,
          balanceAfter: sourceAfter,
          occurredAt: executeNow,
        },
        {
          tradingAccountId: accountId,
          walletId: destination.id,
          currencyCode: CurrencyCode.USD,
          direction: 'credit',
          txType: 'wallet_transfer',
          referenceType: 'wallet_transfer',
          referenceId: transferId,
          amount: amount,
          balanceAfter: destinationAfter,
          occurredAt: executeNow,
        },
      ],
    });
    return result;
  }
}

function parseRequest(body: WalletTransferRequest) {
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';
  const sourceWalletId = text(body?.sourceWalletId);
  const destinationWalletId = text(body?.destinationWalletId);
  const idempotencyKey = text(body?.idempotencyKey);
  const amountText = text(body?.amount);
  if (
    !sourceWalletId ||
    !destinationWalletId ||
    sourceWalletId === destinationWalletId ||
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(amountText) ||
    new Prisma.Decimal(amountText).lte(0)
  ) {
    fail(
      HttpStatus.BAD_REQUEST,
      'INVALID_WALLET_TRANSFER',
      'Distinct wallets, a positive decimal amount and an idempotency key are required.',
    );
  }
  return {
    sourceWalletId,
    destinationWalletId,
    idempotencyKey,
    amount: new Prisma.Decimal(amountText).toFixed(8),
  };
}

function fail(status: HttpStatus, code: string, message: string): never {
  throw new HttpException({ success: false, error: { code, message } }, status);
}
