import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type CashWallet } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { FxService, type FxExecuteSuccessResponse } from '../fx/fx.service';
import {
  TradingAccountWalletTransferService,
  type WalletTransferResult,
} from './trading-account-wallet-transfer.service';
import { canonicalCashWalletSetIssue } from './canonical-cash-wallets';

export type WalletFxTransferQuoteRequest = {
  sourceWalletId?: unknown;
  destinationWalletId?: unknown;
  amount?: unknown;
};
export type WalletFxTransferExecuteRequest = {
  quoteId?: unknown;
  idempotencyKey?: unknown;
};
export type WalletFxTransferResult = {
  success: true;
  data: {
    commandId: string;
    tradingAccountId: string;
    quoteId: string;
    executedAt: string;
    sourceAmount: string;
    receivedAmount: string;
    source: WalletTransferResult['data']['source'] & {
      currencyCode: 'KRW' | 'USD';
    };
    destination: WalletTransferResult['data']['destination'] & {
      currencyCode: 'KRW' | 'USD';
    };
    fx: FxExecuteSuccessResponse['data'];
    transferId: string;
  };
};

/** Securities is the only FX boundary. This command owns the single commit. */
@Injectable()
export class TradingAccountWalletFxTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly fx: FxService,
    private readonly transfers: TradingAccountWalletTransferService,
  ) {}

  async quote(
    userId: string | undefined,
    accountId: string,
    body: WalletFxTransferQuoteRequest,
  ) {
    requireUser(userId);
    const sourceWalletId = text(body?.sourceWalletId);
    const destinationWalletId = text(body?.destinationWalletId);
    const amount = text(body?.amount);
    if (
      !sourceWalletId ||
      !destinationWalletId ||
      !/^\d{1,16}(\.\d{1,8})?$/.test(amount) ||
      new Prisma.Decimal(amount).lte(0)
    ) {
      fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_WALLET_TRANSFER',
        'Distinct wallets and a positive source amount are required.',
      );
    }
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    const route = await this.readRoute(
      this.prisma,
      accountId,
      sourceWalletId,
      destinationWalletId,
    );
    const quote = await this.fx.quoteForTradingAccount(
      userId,
      accountId,
      {
        fromCurrency: route.source.currencyCode,
        toCurrency: route.destination.currencyCode,
        sourceAmount: amount,
      },
      { sourceWalletId, destinationWalletId },
    );
    return {
      success: true as const,
      data: {
        ...quote.data,
        tradingAccountId: accountId,
        sourceWalletId,
        destinationWalletId,
      },
    };
  }

  async execute(
    userId: string | undefined,
    accountId: string,
    body: WalletFxTransferExecuteRequest,
  ): Promise<WalletFxTransferResult> {
    requireUser(userId);
    const quoteId = text(body?.quoteId);
    const idempotencyKey = text(body?.idempotencyKey);
    if (!quoteId || !idempotencyKey || idempotencyKey.length > 200) {
      fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_WALLET_TRANSFER',
        'Quote and idempotency key are required.',
      );
    }
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: 'wallet-fx-transfer:v1',
          accountId,
          quoteId,
        }),
      )
      .digest('hex');
    const where = {
      tradingAccountId_idempotencyKey: {
        tradingAccountId: accountId,
        idempotencyKey,
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
          'Key was used for a different transfer quote.',
        );
      return row.responsePayloadJson as unknown as WalletFxTransferResult;
    };
    const committed = await this.prisma.walletTransferExecuteRequest.findUnique(
      { where },
    );
    if (committed) return replay(committed);

    await this.fx.assertWalletTransferFxEligibility(account, new Date());
    // No financial locks while provider ingestion/refresh may perform network I/O.
    await this.fx.prepareExecuteProvider();
    let didExecute = false;
    try {
      const response = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "quotes" WHERE "id" = ${quoteId}
            AND "user_id" = ${userId} AND "trading_account_id" = ${accountId} FOR UPDATE
        `;
        const beforeLifecycleReplay =
          await tx.walletTransferExecuteRequest.findUnique({ where });
        if (beforeLifecycleReplay) return replay(beforeLifecycleReplay);
        if (isStandaloneAccountMode(account.mode)) {
          await tx.$queryRaw`SELECT "id" FROM "trading_accounts" WHERE "id" = ${accountId} AND "user_id" = ${userId} FOR UPDATE`;
        } else {
          const lifecycle = await lockSeasonTradingContext(tx, {
            userId,
            seasonParticipantId: account.seasonParticipant!.id,
          });
          if (lifecycle.account.id !== accountId)
            fail(
              HttpStatus.INTERNAL_SERVER_ERROR,
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Season account changed.',
            );
        }
        // Race replay before status/expiry gates, including a waiter across season end.
        const raced = await tx.walletTransferExecuteRequest.findUnique({
          where,
        });
        if (raced) return replay(raced);
        const lockedAccount = await this.access.getOwnedAccountOrThrow(
          userId,
          accountId,
          tx,
        );
        if (lockedAccount.mode !== account.mode)
          fail(
            HttpStatus.INTERNAL_SERVER_ERROR,
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Account mode changed.',
          );
        const durable = await tx.quote.findFirst({
          where: {
            id: quoteId,
            userId,
            tradingAccountId: accountId,
            quoteType: 'fx',
          },
          include: { walletTransferQuote: true },
        });
        if (!durable?.walletTransferQuote)
          fail(
            HttpStatus.NOT_FOUND,
            'QUOTE_NOT_FOUND',
            'Transfer quote was not found.',
          );
        const { sourceWalletId, destinationWalletId } =
          durable.walletTransferQuote;
        const before = await this.readRoute(
          tx,
          accountId,
          sourceWalletId,
          destinationWalletId,
        );
        const walletIds = [
          sourceWalletId,
          destinationWalletId,
          before.routing.id,
        ];
        await tx.$queryRaw`
          SELECT "id" FROM "cash_wallets" WHERE "trading_account_id" = ${accountId}
            AND "id" IN (${Prisma.join(walletIds)}) ORDER BY "id" FOR UPDATE
        `;
        const afterLockReplay =
          await tx.walletTransferExecuteRequest.findUnique({ where });
        if (afterLockReplay) return replay(afterLockReplay);
        const [clock] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS "now"`;
        const executeNow = clock.now;
        await this.fx.assertWalletTransferFxEligibility(
          lockedAccount,
          executeNow,
          tx,
        );
        const route = await this.readRoute(
          tx,
          accountId,
          sourceWalletId,
          destinationWalletId,
        );
        if (
          durable.fromCurrency !== route.source.currencyCode ||
          durable.toCurrency !== route.destination.currencyCode ||
          !durable.sourceAmount
        ) {
          fail(
            HttpStatus.CONFLICT,
            'QUOTE_MISMATCH',
            'Transfer quote route changed.',
          );
        }
        const commandId = randomUUID();
        const legKey = `wallet-fx-transfer:${commandId}`;
        let transfer: WalletTransferResult;
        if (route.source.currencyCode === 'USD') {
          transfer = await this.transfers.transferInTransaction(tx, {
            accountId,
            source: route.source,
            destination: route.routing,
            amount: durable.sourceAmount.toFixed(8),
            idempotencyKey: `${legKey}:transfer`,
            requestHash,
            executeNow,
          });
        }
        // Reverse route reads Securities USD AFTER the top-up. Existing reservation
        // remains intact; the exact newly received source amount is available to FX.
        const fx = await this.fx.executeWalletTransferFxInTransaction(tx, {
          account: lockedAccount,
          quoteId,
          idempotencyKey: `${legKey}:fx`,
          executeNow,
        });
        if (route.source.currencyCode === 'KRW') {
          const routingAfterFx = await tx.cashWallet.findUniqueOrThrow({
            where: { id: route.routing.id },
          });
          transfer = await this.transfers.transferInTransaction(tx, {
            accountId,
            source: routingAfterFx,
            destination: route.destination,
            amount: fx.data.netTargetAmount,
            idempotencyKey: `${legKey}:transfer`,
            requestHash,
            executeNow,
          });
        }
        const final = await this.readRoute(
          tx,
          accountId,
          sourceWalletId,
          destinationWalletId,
        );
        const walletResult = (wallet: CashWallet) => ({
          walletId: wallet.id,
          walletScope: wallet.walletScope,
          currencyCode: wallet.currencyCode,
          balanceAfter: wallet.balanceAmount.toFixed(8),
          availableAfter: wallet.balanceAmount
            .sub(wallet.reservedAmount)
            .toFixed(8),
        });
        const result: WalletFxTransferResult = {
          success: true,
          data: {
            commandId,
            tradingAccountId: accountId,
            quoteId,
            executedAt: executeNow.toISOString(),
            sourceAmount: fx.data.sourceAmount,
            receivedAmount: fx.data.netTargetAmount,
            source: walletResult(final.source),
            destination: walletResult(final.destination),
            fx: fx.data,
            transferId: transfer!.data.transferId,
          },
        };
        await tx.walletTransferExecuteRequest.create({
          data: {
            id: commandId,
            tradingAccountId: accountId,
            quoteId,
            idempotencyKey,
            requestHash,
            exchangeTransactionId: fx.data.exchangeId,
            walletTransferId: transfer!.data.transferId,
            responsePayloadJson: result as unknown as Prisma.InputJsonValue,
            executedAt: executeNow,
          },
        });
        didExecute = true;
        return result;
      });
      if (didExecute) this.fx.afterWalletTransferFxCommit(account);
      return response;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner =
          await this.prisma.walletTransferExecuteRequest.findUnique({ where });
        if (winner) return replay(winner);
      }
      throw error;
    }
  }

  private async readRoute(
    client: PrismaService | Prisma.TransactionClient,
    accountId: string,
    sourceWalletId: string,
    destinationWalletId: string,
  ) {
    const wallets = await client.cashWallet.findMany({
      where: { tradingAccountId: accountId },
    });
    if (canonicalCashWalletSetIssue(wallets))
      fail(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'FINANCIAL_SCOPE_REPAIR_REQUIRED',
        'Canonical cash wallets are inconsistent.',
      );
    const source = wallets.find((w) => w.id === sourceWalletId);
    const destination = wallets.find((w) => w.id === destinationWalletId);
    if (!source || !destination)
      fail(
        HttpStatus.NOT_FOUND,
        'WALLET_TRANSFER_WALLET_NOT_FOUND',
        'Transfer wallets were not found in this account.',
      );
    if (!isWalletFxTransferRoute(source, destination))
      fail(
        HttpStatus.BAD_REQUEST,
        'WALLET_TRANSFER_ROUTE_UNSUPPORTED',
        'Use FX for Securities KRW/USD; transfer FX supports only Securities KRW and Crypto USD.',
      );
    const routing = wallets.find(
      (w) => w.walletScope === 'securities' && w.currencyCode === 'USD',
    )!;
    return { source, destination, routing };
  }
}

export function isWalletFxTransferRoute(
  source: Pick<CashWallet, 'walletScope' | 'currencyCode'>,
  destination: Pick<CashWallet, 'walletScope' | 'currencyCode'>,
): boolean {
  const krw = (wallet: typeof source) =>
    wallet.walletScope === 'securities' && wallet.currencyCode === 'KRW';
  const cryptoUsd = (wallet: typeof source) =>
    ['crypto_spot', 'crypto_futures'].includes(wallet.walletScope) &&
    wallet.currencyCode === 'USD';
  return (
    (krw(source) && cryptoUsd(destination)) ||
    (cryptoUsd(source) && krw(destination))
  );
}
function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
function requireUser(userId: string | undefined): asserts userId is string {
  if (!userId) fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
}
function fail(status: HttpStatus, code: string, message: string): never {
  throw new HttpException({ success: false, error: { code, message } }, status);
}
