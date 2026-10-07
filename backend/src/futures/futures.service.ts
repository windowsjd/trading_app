import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type CashWallet } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { assertAccountFinancialScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { readGeneralTradeFeeRate } from '../orders/general-trading.config';
import { canonicalCashWalletSetIssue } from '../wallets/canonical-cash-wallets';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { buildPagination } from '../common/pagination';
import { futuresError } from './futures-error';
import {
  futuresCommandHash,
  parseFuturesCommand,
  type FuturesExecuteBody,
} from './futures-input';
import { isFuturesTradingEnabled } from './futures.config';
import {
  assertFuturesMoney,
  futuresDecimal,
  futuresPnl,
  planFuturesExecution,
} from './futures-math';
import { futuresMarginUsed } from './futures-collateral';
import { readFuturesPrice } from './futures-price';
import {
  futuresInstrumentInclude,
  presentFuturesExecution,
  presentFuturesInstrument,
  presentFuturesPosition,
  type FuturesExecuteResult,
  type InstrumentWithAsset,
} from './futures.presenter';

@Injectable()
export class FuturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly performance: GeneralAccountPerformanceService,
  ) {}

  async execute(
    userId: string | undefined,
    accountId: string,
    body: FuturesExecuteBody,
  ): Promise<FuturesExecuteResult> {
    requireUser(userId);
    stage('futures_ownership', accountId);
    const request = parseFuturesCommand(body);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const requestHash = futuresCommandHash(accountId, request);
    const where = {
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
        futuresError(
          'FUTURES_IDEMPOTENCY_CONFLICT',
          'Idempotency key was used for another Futures command.',
        );
      return row.responsePayloadJson as unknown as FuturesExecuteResult;
    };
    const committed = await this.prisma.futuresExecuteRequest.findUnique({
      where,
    });
    if (committed) return replay(committed);
    assertEnabled();
    await this.assertTradable(
      account,
      await this.dbNow(this.prisma),
      this.prisma,
    );
    const instrument = await this.instrument(this.prisma, request.instrumentId);
    // No network refresh is introduced. Existing Binance ingestion commits snapshots
    // independently. Preflight and financial transaction both read canonical DB evidence.
    await readFuturesPrice(
      this.prisma,
      instrument.underlyingAsset,
      await this.dbNow(this.prisma),
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        stage('futures_lifecycle_lock', accountId);
        if (account.mode === 'general') {
          await tx.$queryRaw`SELECT "id" FROM "trading_accounts" WHERE "id" = ${accountId} AND "user_id" = ${userId} FOR UPDATE`;
        } else {
          const lifecycle = await lockSeasonTradingContext(tx, {
            userId,
            seasonParticipantId: account.seasonParticipant!.id,
            participantWrite: false,
          });
          if (lifecycle.account.id !== accountId)
            futuresError(
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Season trading account changed.',
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
        const raced = await tx.futuresExecuteRequest.findUnique({ where });
        if (raced) return replay(raced);
        await tx.$queryRaw`
          SELECT i."id" FROM "futures_instruments" i JOIN "assets" a ON a."id" = i."underlying_asset_id"
          WHERE i."id" = ${request.instrumentId} FOR SHARE OF i, a
        `;
        // All Futures instruments share this wallet fence; never upgrade Season
        // authorization locks. Existing outgoing transfers take the same wallet lock.
        await tx.$queryRaw`
          SELECT "id" FROM "cash_wallets" WHERE "trading_account_id" = ${accountId}
            AND "wallet_scope" = 'crypto_futures' AND "currency_code" = 'USD' FOR UPDATE
        `;
        const afterWait = await tx.futuresExecuteRequest.findUnique({ where });
        if (afterWait) return replay(afterWait);
        await tx.$queryRaw`
          SELECT "id" FROM "futures_positions" WHERE "trading_account_id" = ${accountId}
            AND "instrument_id" = ${request.instrumentId} AND "status" = 'open' FOR UPDATE
        `;
        const executeNow = await this.dbNow(tx);
        assertEnabled();
        const lockedAccount = await this.access.getOwnedAccountOrThrow(
          userId,
          accountId,
          tx,
        );
        if (lockedAccount.mode !== account.mode)
          futuresError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Trading account mode changed.',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        await this.assertTradable(lockedAccount, executeNow, tx);
        const lockedInstrument = await this.instrument(
          tx,
          request.instrumentId,
        );
        const wallet = await this.wallet(tx, accountId);
        stage('futures_execution_price_selection', accountId);
        const price = (await readFuturesPrice(
          tx,
          lockedInstrument.underlyingAsset,
          executeNow,
        ))!;
        const current = await tx.futuresPosition.findFirst({
          where: {
            tradingAccountId: accountId,
            instrumentId: request.instrumentId,
            status: 'open',
          },
        });
        const usedBefore = await futuresMarginUsed(tx, accountId);
        stage('futures_collateral_calculation', accountId);
        const feeRate =
          lockedAccount.mode === 'general'
            ? readGeneralTradeFeeRate()
            : lockedAccount.seasonParticipant!.season.tradeFeeRate;
        const plan = planFuturesExecution(
          request,
          current,
          price.price,
          feeRate,
        );
        const usedAfter = usedBefore
          .sub(current?.isolatedMargin ?? '0')
          .add(plan.isolatedMargin);
        const balanceAfter = assertFuturesMoney(
          futuresDecimal(wallet.balanceAmount)
            .add(plan.realizedPnl)
            .sub(plan.feeAmount),
        );
        const freeAfter = balanceAfter
          .sub(wallet.reservedAmount)
          .sub(usedAfter);
        setAdminDiagnosticContext({
          evidence: {
            financialGuard: {
              walletScope: 'crypto_futures',
              balance: wallet.balanceAmount.toFixed(8),
              reserved: wallet.reservedAmount.toFixed(8),
              marginUsed: usedBefore.toFixed(8),
              marginAfter: usedAfter.toFixed(8),
              feeAmount: plan.feeAmount.toFixed(8),
              realizedPnl: plan.realizedPnl.toFixed(8),
              freeAfter: freeAfter.toFixed(8),
              collateralSufficient: freeAfter.gte(0),
            },
          },
        });
        if (freeAfter.lt(0) || balanceAfter.lt(0))
          futuresError(
            ['reduce', 'close'].includes(request.operation)
              ? 'FUTURES_LIQUIDATION_REQUIRED'
              : 'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
            ['reduce', 'close'].includes(request.operation)
              ? 'Loss and fee cannot settle safely without liquidation.'
              : 'Free collateral must cover additional margin and executed-notional fee.',
          );
        const executionId = randomUUID();
        const commandId = randomUUID();
        const ledger: Prisma.WalletTransactionCreateManyInput[] = [];
        let runningBalance = futuresDecimal(wallet.balanceAmount);
        stage('futures_realized_pnl_settlement', accountId);
        // Settle PnL first, so a profitable reduction can fund its actual fee.
        if (!plan.realizedPnl.eq(0)) {
          if (plan.realizedPnl.lt(0))
            await this.debit(tx, wallet, plan.realizedPnl.abs().toFixed(8));
          else {
            const credit = await tx.cashWallet.updateMany({
              where: {
                id: wallet.id,
                tradingAccountId: accountId,
                walletScope: 'crypto_futures',
                currencyCode: 'USD',
              },
              data: {
                balanceAmount: { increment: plan.realizedPnl.toFixed(8) },
              },
            });
            if (credit.count !== 1)
              futuresError(
                'FUTURES_CASH_CONFLICT',
                'Futures collateral wallet changed.',
              );
          }
          runningBalance = runningBalance.add(plan.realizedPnl);
          assertFuturesMoney(runningBalance);
          ledger.push(
            this.ledger(
              wallet,
              executionId,
              executeNow,
              'futures_pnl',
              plan.realizedPnl.gt(0) ? 'credit' : 'debit',
              plan.realizedPnl.abs().toFixed(8),
              runningBalance.toFixed(8),
            ),
          );
        }
        stage('futures_fee_debit', accountId);
        if (plan.feeAmount.gt(0))
          await this.debit(tx, wallet, plan.feeAmount.toFixed(8));
        runningBalance = runningBalance.sub(plan.feeAmount);
        ledger.push(
          this.ledger(
            wallet,
            executionId,
            executeNow,
            'fee',
            'debit',
            plan.feeAmount.toFixed(8),
            runningBalance.toFixed(8),
          ),
        );
        const positionData = {
          quantity: plan.quantity.toFixed(8),
          averageEntryPrice: plan.averageEntryPrice.toFixed(8),
          entryNotional: plan.entryNotional.toFixed(16),
          leverage: request.leverage,
          isolatedMargin: plan.isolatedMargin.toFixed(8),
          realizedPnl: plan.cumulativeRealizedPnl.toFixed(8),
          status: plan.status,
          closedAt: plan.status === 'closed' ? executeNow : null,
          updatedAt: executeNow,
        };
        stage('futures_position_write', accountId);
        const position = current
          ? await tx.futuresPosition.update({
              where: { id: current.id },
              data: positionData,
            })
          : await tx.futuresPosition.create({
              data: {
                ...positionData,
                tradingAccountId: accountId,
                instrumentId: lockedInstrument.id,
                direction: request.direction,
                createdAt: executeNow,
              },
            });
        stage('futures_execution_evidence_write', accountId);
        const execution = await tx.futuresExecution.create({
          data: {
            id: executionId,
            tradingAccountId: accountId,
            instrumentId: lockedInstrument.id,
            positionId: position.id,
            operation: plan.status === 'closed' ? 'close' : request.operation,
            direction: request.direction,
            quantity: request.quantity,
            leverage: request.leverage,
            executionPrice: price.price,
            assetPriceSnapshotId: price.id,
            priceSourceType: price.sourceType,
            priceSourceName: price.sourceName!,
            priceEffectiveAt: price.effectiveAt,
            priceCapturedAt: price.capturedAt,
            notional: plan.notional.toFixed(8),
            feeRate,
            feeAmount: plan.feeAmount.toFixed(8),
            realizedPnl: plan.realizedPnl.toFixed(8),
            positionQuantityAfter: position.quantity,
            averageEntryPriceAfter: position.averageEntryPrice,
            isolatedMarginAfter: position.isolatedMargin,
            executedAt: executeNow,
            createdAt: executeNow,
          },
        });
        stage('futures_ledger_write', accountId);
        await tx.walletTransaction.createMany({ data: ledger });
        const result: FuturesExecuteResult = {
          success: true,
          data: {
            tradingAccountId: accountId,
            commandId,
            instrument: presentFuturesInstrument(lockedInstrument),
            execution: presentFuturesExecution(execution),
            position: presentFuturesPosition(position),
            collateral: {
              walletId: wallet.id,
              currencyCode: 'USD',
              balanceAmount: balanceAfter.toFixed(8),
              totalMarginUsed: usedAfter.toFixed(8),
              freeCollateral: freeAfter.toFixed(8),
            },
          },
        };
        stage('futures_idempotency_write', accountId);
        await tx.futuresExecuteRequest.create({
          data: {
            id: commandId,
            tradingAccountId: accountId,
            executionId,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            responsePayloadJson: result as unknown as Prisma.InputJsonValue,
            executedAt: executeNow,
            createdAt: executeNow,
          },
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.futuresExecuteRequest.findUnique({
          where,
        });
        if (winner) return replay(winner);
      }
      throw error;
    }
  }

  async instruments(userId: string | undefined, accountId: string) {
    requireUser(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    const rows = await this.prisma.futuresInstrument.findMany({
      where: { isActive: true, underlyingAsset: { isActive: true } },
      include: futuresInstrumentInclude,
      orderBy: { id: 'asc' },
    });
    return {
      success: true,
      data: {
        tradingAccountId: accountId,
        instruments: rows.map(presentFuturesInstrument),
      },
    };
  }

  async positions(userId: string | undefined, accountId: string) {
    requireUser(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.getOwnedAccountOrThrow(userId, accountId, tx);
        const wallet = await this.wallet(tx, accountId);
        const now = await this.dbNow(tx);
        const rows = await tx.futuresPosition.findMany({
          where: { tradingAccountId: accountId, status: 'open' },
          include: { instrument: { include: futuresInstrumentInclude } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const positions = await Promise.all(
          rows.map(async (row) => {
            const price = await readFuturesPrice(
              tx,
              row.instrument.underlyingAsset,
              now,
              false,
            );
            return {
              ...presentFuturesPosition(row),
              instrument: presentFuturesInstrument(row.instrument),
              referencePrice: price?.price.toFixed(8) ?? null,
              unrealizedPnl: price
                ? futuresPnl(
                    row.direction,
                    row.averageEntryPrice,
                    price.price,
                    row.quantity,
                  ).toFixed(8)
                : null,
              referencePriceEvidence: price
                ? {
                    assetPriceSnapshotId: price.id,
                    sourceType: price.sourceType,
                    sourceName: price.sourceName,
                    effectiveAt: price.effectiveAt.toISOString(),
                    capturedAt: price.capturedAt.toISOString(),
                  }
                : null,
            };
          }),
        );
        const used = await futuresMarginUsed(tx, accountId);
        return {
          success: true,
          data: {
            tradingAccountId: accountId,
            positions,
            collateral: {
              walletId: wallet.id,
              currencyCode: 'USD',
              balanceAmount: wallet.balanceAmount.toFixed(8),
              totalMarginUsed: used.toFixed(8),
              freeCollateral: futuresDecimal(wallet.balanceAmount)
                .sub(wallet.reservedAmount)
                .sub(used)
                .toFixed(8),
            },
            evaluatedAt: now.toISOString(),
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async executions(
    userId: string | undefined,
    accountId: string,
    query: { limit?: string; offset?: string } = {},
  ) {
    requireUser(userId);
    const limit = pageNumber(query.limit, 20, 1, 100);
    const offset = pageNumber(query.offset, 0, 0, 1_000_000);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.getOwnedAccountOrThrow(userId, accountId, tx);
        const where = { tradingAccountId: accountId };
        const total = await tx.futuresExecution.count({ where });
        const rows = await tx.futuresExecution.findMany({
          where,
          include: { instrument: { include: futuresInstrumentInclude } },
          orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
          take: limit,
          skip: offset,
        });
        return {
          success: true,
          data: {
            tradingAccountId: accountId,
            executions: rows.map((row) => ({
              ...presentFuturesExecution(row),
              instrument: presentFuturesInstrument(row.instrument),
            })),
            pagination: buildPagination({
              limit,
              offset,
              total,
              returned: rows.length,
            }),
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async instrument(
    client: PrismaService | Prisma.TransactionClient,
    id: string,
  ): Promise<InstrumentWithAsset> {
    const row = await client.futuresInstrument.findUnique({
      where: { id },
      include: futuresInstrumentInclude,
    });
    if (!row)
      futuresError(
        'FUTURES_INSTRUMENT_NOT_FOUND',
        'Futures instrument was not found.',
        HttpStatus.NOT_FOUND,
      );
    const asset = row.underlyingAsset;
    if (
      !row.isActive ||
      !asset.isActive ||
      row.productType !== 'synthetic_perpetual' ||
      row.settlementCurrency !== 'USD' ||
      asset.assetType !== 'crypto' ||
      asset.market !== 'BINANCE' ||
      asset.currencyCode !== 'USD' ||
      asset.priceCurrency !== 'USD' ||
      asset.settlementCurrency !== 'USD'
    )
      futuresError(
        'FUTURES_INSTRUMENT_UNSUPPORTED',
        'Only active USD-settled synthetic Binance crypto perpetual instruments are supported.',
      );
    return row;
  }

  private async wallet(
    client: PrismaService | Prisma.TransactionClient,
    accountId: string,
  ) {
    const rows = await client.cashWallet.findMany({
      where: { tradingAccountId: accountId },
    });
    if (canonicalCashWalletSetIssue(rows))
      futuresError(
        'FINANCIAL_SCOPE_REPAIR_REQUIRED',
        'Canonical cash wallets are missing or inconsistent.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    return rows.find(
      (row) =>
        row.walletScope === 'crypto_futures' && row.currencyCode === 'USD',
    )!;
  }

  private async assertTradable(
    account: OwnedTradingAccount,
    now: Date,
    client: PrismaService | Prisma.TransactionClient,
  ) {
    if (account.status !== 'active')
      futuresError(
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active.',
      );
    if (account.mode === 'general') {
      await this.performance.assertGeneralAccountReady(account, client);
      return;
    }
    const participant = account.seasonParticipant!;
    if (participant.participantStatus === 'excluded')
      futuresError(
        'PARTICIPANT_EXCLUDED',
        'Season participant is excluded.',
        HttpStatus.FORBIDDEN,
      );
    if (participant.participantStatus !== 'active')
      futuresError(
        'PARTICIPANT_NOT_ACTIVE',
        'Season participant is not active.',
      );
    const season = participant.season;
    if (season.status !== 'active')
      futuresError('SEASON_NOT_ACTIVE', 'Season is not active.');
    if (now < season.startAt)
      futuresError('SEASON_NOT_STARTED', 'Season has not started.');
    if (now >= season.endAt) futuresError('SEASON_ENDED', 'Season has ended.');
    await this.wallet(client, account.id);
    await assertAccountFinancialScopeIntegrity(client, {
      tradingAccountId: account.id,
    });
  }

  private async dbNow(client: PrismaService | Prisma.TransactionClient) {
    return (
      await client.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS "now"`
    )[0].now;
  }
  private async debit(
    tx: Prisma.TransactionClient,
    wallet: CashWallet,
    amount: string,
  ) {
    if (
      (await debitAvailableCash(tx, {
        walletId: wallet.id,
        tradingAccountId: wallet.tradingAccountId,
        walletScope: 'crypto_futures',
        currencyCode: 'USD',
        amount,
      })) !== 1
    )
      futuresError(
        'FUTURES_CASH_CONFLICT',
        'Futures collateral cash debit failed.',
      );
  }
  private ledger(
    wallet: CashWallet,
    executionId: string,
    now: Date,
    txType: 'fee' | 'futures_pnl',
    direction: 'credit' | 'debit',
    amount: string,
    balanceAfter: string,
  ): Prisma.WalletTransactionCreateManyInput {
    return {
      tradingAccountId: wallet.tradingAccountId,
      walletId: wallet.id,
      currencyCode: 'USD',
      direction,
      txType,
      referenceType: 'futures_execution',
      referenceId: executionId,
      amount,
      balanceAfter,
      occurredAt: now,
    };
  }
}

function requireUser(userId: string | undefined): asserts userId is string {
  if (!userId)
    futuresError('UNAUTHORIZED', 'Unauthorized', HttpStatus.UNAUTHORIZED);
}
function assertEnabled() {
  if (!isFuturesTradingEnabled())
    futuresError(
      'FUTURES_TRADING_DISABLED',
      'Futures trading is disabled.',
      HttpStatus.FORBIDDEN,
    );
}
function stage(failureStage: string, accountId: string) {
  setAdminDiagnosticContext({
    domain: 'futures',
    operation: 'market_execute',
    failureStage,
    entities: { tradingAccountId: accountId },
    nextInvestigation: ['backend/src/futures/futures.service.ts'],
  });
}
function pageNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (raw === undefined) return fallback;
  if (
    typeof raw !== 'string' ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  )
    futuresError(
      'INVALID_PAGINATION',
      'Pagination is outside the supported range.',
      HttpStatus.BAD_REQUEST,
    );
  return Number(raw);
}
