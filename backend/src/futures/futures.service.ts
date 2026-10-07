import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
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
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { buildPagination } from '../common/pagination';
import { futuresError } from './futures-error';
import {
  futuresCommandHash,
  parseFuturesCommand,
  type FuturesExecuteBody,
} from './futures-input';
import { assertFuturesOperation } from './futures.config';
import { settleFuturesCash } from './futures-settlement';
import { readFuturesMark } from './futures-mark';
import {
  riskStrings,
  assertCrossSafe,
  loadCrossRisk,
  crossRisk,
  positionRisk,
  presentPositionRisk,
  accountFuturesFee,
} from './futures-risk';
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
          'This request conflicts with an earlier Futures command.',
        );
      return row.responsePayloadJson as unknown as FuturesExecuteResult;
    };
    const committed = await this.prisma.futuresExecuteRequest.findUnique({
      where,
    });
    if (committed) return replay(committed);
    assertFuturesOperation(request.operation);
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
              'Account information could not be verified. Please try again.',
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
        assertFuturesOperation(request.operation);
        const lockedAccount = await this.access.getOwnedAccountOrThrow(
          userId,
          accountId,
          tx,
        );
        if (lockedAccount.mode !== account.mode)
          futuresError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Account information could not be verified. Please try again.',
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
        let freeAfter = balanceAfter.sub(wallet.reservedAmount).sub(usedAfter);
        let reportedFreeAfter: Prisma.Decimal | null = freeAfter;
        if (['open', 'increase'].includes(request.operation)) {
          const mark = (await readFuturesMark(
            tx,
            lockedInstrument,
            executeNow,
          ))!;
          const nextRisk = positionRisk(
            {
              ...plan,
              direction: request.direction,
              leverage: request.leverage,
              marginMode: request.marginMode ?? 'isolated',
            },
            mark.price,
            feeRate,
          );
          if (
            request.marginMode !== 'cross' &&
            nextRisk.liquidationBuffer.lte(0)
          ) {
            setAdminDiagnosticContext({
              evidence: {
                financialGuard: {
                  financialOperation: 'market_execute',
                  guardName: 'futures_maintenance',
                  observation: 'mutation_plan',
                  mutationResult: 'rejected',
                  walletScope: 'crypto_futures',
                  currencyCode: 'USD',
                  marginMode: 'isolated',
                  maintenanceSufficient: false,
                  failureReason: 'maintenance_unsafe',
                },
              },
            });
            futuresError(
              'FUTURES_MAINTENANCE_UNSAFE',
              'The position would not meet maintenance requirements.',
            );
          }
          const cross = await loadCrossRisk(
            tx,
            wallet,
            executeNow,
            usedAfter,
            feeRate,
          );
          const risks = cross.rows
            .filter((r) => r.position.id !== current?.id)
            .map((r) => r.risk!);
          if (request.marginMode === 'cross') risks.push(nextRisk);
          const after = crossRisk(
            { ...wallet, balanceAmount: balanceAfter },
            usedAfter,
            risks,
          );
          assertCrossSafe(after, risks.length > 0);
          freeAfter = after.crossFreeCollateral;
          reportedFreeAfter = freeAfter;
        } else {
          const cross = await loadCrossRisk(
            tx,
            wallet,
            executeNow,
            usedAfter,
            feeRate,
            false,
          );
          if (
            current?.marginMode === 'isolated' &&
            cross.rows.length > 0 &&
            plan.realizedPnl
              .sub(plan.feeAmount)
              .lt(
                futuresDecimal(current.isolatedMargin)
                  .sub(plan.isolatedMargin)
                  .neg(),
              )
          ) {
            setAdminDiagnosticContext({
              evidence: {
                financialGuard: {
                  financialOperation: 'market_execute',
                  guardName: 'isolated_allocation',
                  observation: 'mutation_plan',
                  mutationResult: 'rejected',
                  walletScope: 'crypto_futures',
                  currencyCode: 'USD',
                  marginMode: 'isolated',
                  crossPositionsPresent: true,
                  isolatedAllocationSufficient: false,
                  failureReason: 'cross_collateral_protected',
                },
              },
            });
            futuresError(
              'FUTURES_LIQUIDATION_REQUIRED',
              'This trade would spend collateral protected for Cross positions.',
            );
          }
          const remaining = cross.rows.filter(
            (row) => row.position.id !== current?.id || plan.status === 'open',
          );
          const risks = remaining.map((row) =>
            !row.mark
              ? null
              : positionRisk(
                  row.position.id === current?.id
                    ? { ...row.position, ...plan }
                    : row.position,
                  row.mark.price,
                  feeRate,
                ),
          );
          // Risk-reducing commands do not require marks. Never label raw cash as Cross free collateral.
          reportedFreeAfter = risks.every((r) => r !== null)
            ? crossRisk(
                { ...wallet, balanceAmount: balanceAfter },
                usedAfter,
                risks.filter((r) => r !== null),
              ).crossFreeCollateral
            : null;
        }
        setAdminDiagnosticContext({
          evidence: {
            financialGuard: {
              financialOperation: 'market_execute',
              guardName: 'futures_collateral',
              observation: 'mutation_plan',
              walletScope: 'crypto_futures',
              currencyCode: 'USD',
              walletFound: true,
              scopeValid: wallet.tradingAccountId === accountId,
              currencyMatched: wallet.currencyCode === 'USD',
              reservedCashPresent: wallet.reservedAmount.gt(0),
              isolatedAllocationsPresent: usedAfter.gt(0),
              balanceSufficient: balanceAfter.gte(0),
              collateralSufficient: freeAfter.gte(0),
              mutationResult:
                freeAfter.lt(0) || balanceAfter.lt(0)
                  ? 'rejected'
                  : 'guard_satisfied',
              failureReason: balanceAfter.lt(0)
                ? 'insufficient_balance'
                : freeAfter.lt(0)
                  ? 'insufficient_free_collateral'
                  : 'none',
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
              : 'Available Futures collateral is insufficient for margin and fees.',
          );
        const executionId = randomUUID();
        const commandId = randomUUID();
        const { ledger } = await settleFuturesCash(
          tx,
          wallet,
          'futures_execution',
          executionId,
          plan.realizedPnl,
          plan.feeAmount,
          executeNow,
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
                marginMode: request.marginMode,
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
            marginMode: request.marginMode,
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
              freeCollateral: reportedFreeAfter?.toFixed(8) ?? null,
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
        const fee = await accountFuturesFee(tx, accountId);
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
            const mark = await readFuturesMark(tx, row.instrument, now, false);
            const risk = mark ? positionRisk(row, mark.price, fee) : null;
            return {
              ...presentFuturesPosition(row),
              markPrice: mark?.price.toFixed(8) ?? null,
              markEvidence: mark
                ? {
                    snapshotId: mark.id,
                    source: mark.source,
                    effectiveAt: mark.effectiveAt.toISOString(),
                    capturedAt: mark.capturedAt.toISOString(),
                  }
                : null,
              markState: mark ? 'fresh' : 'unavailable_or_stale',
              risk: risk ? presentPositionRisk(row, risk, fee) : null,
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
        const cross = await loadCrossRisk(tx, wallet, now, used, fee, false);
        return {
          success: true,
          data: {
            tradingAccountId: accountId,
            positions,
            cross: {
              positionIds: cross.rows.map((r) => r.position.id),
              evaluatedAt: now.toISOString(),
              markState: cross.risk ? 'fresh' : 'unavailable_or_stale',
              metrics: cross.risk ? riskStrings(cross.risk) : null,
            },
            collateral: {
              walletId: wallet.id,
              currencyCode: 'USD',
              balanceAmount: wallet.balanceAmount.toFixed(8),
              totalMarginUsed: used.toFixed(8),
              freeCollateral:
                cross.risk?.crossFreeCollateral.toFixed(8) ?? null,
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

  async liquidations(
    userId: string | undefined,
    accountId: string,
    query: { limit?: string; offset?: string } = {},
  ) {
    requireUser(userId);
    const limit = pageNumber(query.limit, 20, 1, 100),
      offset = pageNumber(query.offset, 0, 0, 1_000_000);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.getOwnedAccountOrThrow(userId, accountId, tx);
        const where = { tradingAccountId: accountId };
        const total = await tx.futuresLiquidation.count({ where });
        const rows = await tx.futuresLiquidation.findMany({
          where,
          include: {
            closes: {
              include: { markSnapshot: true },
              orderBy: { positionId: 'asc' },
            },
          },
          orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
          take: limit,
          skip: offset,
        });
        return {
          success: true,
          data: {
            tradingAccountId: accountId,
            liquidations: JSON.parse(JSON.stringify(rows)) as Prisma.JsonValue,
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
        'This Futures instrument is not available for trading.',
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
    const walletSetIssue = canonicalCashWalletSetIssue(rows);
    if (walletSetIssue) {
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            guardName: 'wallet_scope',
            observation: 'existing_read',
            mutationResult: 'rejected',
            walletScope: 'crypto_futures',
            currencyCode: 'USD',
            canonicalWalletSetValid: false,
            failureReason: walletSetIssue,
          },
        },
      });
      futuresError(
        'FINANCIAL_SCOPE_REPAIR_REQUIRED',
        'Futures wallet information could not be verified.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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
}

function requireUser(userId: string | undefined): asserts userId is string {
  if (!userId)
    futuresError('UNAUTHORIZED', 'Unauthorized', HttpStatus.UNAUTHORIZED);
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
