import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import {
  liveProtection,
  protectionInclude,
} from '../conditional/conditional-state';
import { Prisma, type FuturesPosition } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { assertBeginnerLearningAccess } from '../trading-accounts/beginner-learning-policy';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { futuresMarginUsed } from './futures-collateral';
import { futuresError } from './futures-error';
import { assertFuturesLeverage } from './futures-input';
import {
  assessFuturesExposure,
  futuresLeverageChangeHash,
  parseFuturesLeverageChange,
  type FuturesRisk,
} from './futures-leverage-policy';
import { verifiedFuturesInstrument } from './futures-instrument-coverage';
import { readFuturesLastPrice } from './futures-last-price';
import { readFuturesMark } from './futures-mark';
import {
  assertFuturesMoney,
  futuresDecimal,
  planFuturesExecution,
  planFuturesLeverageChange,
} from './futures-math';
import { presentFuturesPerformance } from './futures-position-display';
import { positionChanged } from './futures-position-policy';
import {
  accountFuturesFee,
  assertCrossSafe,
  isolatedLiquidationPrice,
  loadCrossRisk,
  positionRisk,
} from './futures-risk';
import { assertFuturesOperation } from './futures.config';
import {
  futuresInstrumentInclude,
  presentFuturesPosition,
} from './futures.presenter';
import { FuturesService } from './futures.service';

/**
 * Leverage change of an open Futures lifetime (2026-11-06,
 * docs/futures-api-contract.md 「Leverage change」). The user confirms the
 * change naming the leverage the lifetime has; quantity, average entry,
 * entry basis, executions, realized PnL and stop-loss/take-profit settings
 * stay. Isolated re-derives its allocation (margin added or released), Cross
 * only changes its Mark requirement. No cash, fee or PnL moves, so no ledger,
 * execution or fill count is written; the change is its own evidence row.
 */
@Injectable()
export class FuturesLeverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly futures: FuturesService,
  ) {}

  async change(
    userId: string | undefined,
    accountId: string,
    positionId: string,
    body: unknown,
  ) {
    requireUser(userId);
    stage('futures_leverage_ownership', accountId);
    const input = parseFuturesLeverageChange(body);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const requestHash = futuresLeverageChangeHash(accountId, positionId, input);
    const where = {
      tradingAccountId_idempotencyKey: {
        tradingAccountId: accountId,
        idempotencyKey: input.idempotencyKey,
      },
    };
    const replay = (row: {
      requestHash: string | null;
      responsePayloadJson: Prisma.JsonValue;
    }) => {
      if (row.requestHash !== requestHash)
        futuresError(
          'FUTURES_IDEMPOTENCY_CONFLICT',
          'This request conflicts with an earlier Futures command.',
        );
      return row.responsePayloadJson as unknown as FuturesLeverageChangeResult;
    };
    // A committed change replays before any mutable gate.
    const committed = await this.prisma.futuresLeverageChange.findUnique({
      where,
    });
    if (committed) return replay(committed);
    assertFuturesOperation('increase');
    const located = await this.prisma.futuresPosition.findFirst({
      where: { id: positionId, tradingAccountId: accountId },
      select: { instrumentId: true },
    });
    if (!located) notFound();
    try {
      return await this.prisma.$transaction(async (tx) => {
        stage('futures_leverage_lifecycle_lock', accountId);
        // The execution core's fences, in its order: lifecycle, instrument,
        // the shared Futures wallet, then the lifetime.
        if (isStandaloneAccountMode(account.mode)) {
          await tx.$queryRaw`SELECT "id" FROM "trading_accounts" WHERE "id" = ${accountId} AND "user_id" = ${userId} FOR UPDATE`;
        } else {
          const lifecycle = await lockSeasonTradingContext(tx, {
            userId,
            seasonParticipantId: account.seasonParticipant!.id,
            participantWrite: true,
          });
          if (lifecycle.account.id !== accountId)
            futuresError(
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Account information could not be verified. Please try again.',
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
        const raced = await tx.futuresLeverageChange.findUnique({ where });
        if (raced) return replay(raced);
        await tx.$queryRaw`
          SELECT i."id" FROM "futures_instruments" i JOIN "assets" a ON a."id" = i."underlying_asset_id"
          WHERE i."id" = ${located.instrumentId} FOR SHARE OF i, a
        `;
        await tx.$queryRaw`
          SELECT "id" FROM "cash_wallets" WHERE "trading_account_id" = ${accountId}
            AND "wallet_scope" = 'crypto_futures' AND "currency_code" = 'USD' FOR UPDATE
        `;
        const afterWait = await tx.futuresLeverageChange.findUnique({ where });
        if (afterWait) return replay(afterWait);
        await tx.$queryRaw`
          SELECT "id" FROM "futures_positions" WHERE "id" = ${positionId}
            AND "trading_account_id" = ${accountId} FOR UPDATE
        `;
        const now = await this.futures.dbNow(tx);
        assertFuturesOperation('increase');
        const locked = await this.access.getOwnedAccountOrThrow(
          userId,
          accountId,
          tx,
        );
        if (locked.mode !== account.mode)
          futuresError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Account information could not be verified. Please try again.',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        await this.futures.assertTradable(locked, now, tx);
        await assertBeginnerLearningAccess(tx, locked, 'allTrading');
        const instrument = await this.futures.instrument(
          tx,
          located.instrumentId,
        );
        if (!verifiedFuturesInstrument(instrument, now))
          futuresError(
            'FUTURES_INSTRUMENT_UNVERIFIED',
            'This Futures instrument is not yet available for new trades.',
          );
        const wallet = await this.futures.wallet(tx, accountId);
        const current = await tx.futuresPosition.findFirst({
          where: {
            id: positionId,
            tradingAccountId: accountId,
            status: 'open',
          },
        });
        if (!current) notFound();
        // Approval scope: the leverage the user changed from.
        if (current.leverage !== input.fromLeverage) positionChanged();
        // A legacy whole-lifetime exit in flight keeps the lifetime as it is.
        const protection = await tx.protectionGroup.findFirst({
          where: { futuresPositionId: current.id, ...liveProtection },
          include: protectionInclude,
        });
        if (protection?.children.length)
          futuresError(
            'PROTECTION_CHILD_PENDING',
            'Cancel the pending exit before increasing.',
          );
        stage('futures_leverage_collateral_calculation', accountId);
        const feeRate = await accountFuturesFee(tx, accountId);
        const plan = planFuturesLeverageChange(current, input.leverage);
        const usedBefore = await futuresMarginUsed(tx, accountId);
        const usedAfter = usedBefore
          .sub(current.isolatedMargin)
          .add(plan.isolatedMargin);
        const mark = (await readFuturesMark(tx, instrument, now))!;
        const nextRisk = positionRisk(
          {
            ...current,
            leverage: input.leverage,
            isolatedMargin: plan.isolatedMargin,
          },
          mark.price,
          feeRate,
        );
        const cross = await loadCrossRisk(tx, wallet, now, usedAfter, feeRate);
        const assessed = assessFuturesExposure({
          wallet,
          balanceAfter: futuresDecimal(wallet.balanceAmount),
          usedAfter,
          marginMode: current.marginMode,
          nextRisk,
          otherCrossRisks: cross.rows
            .filter((row) => row.position.id !== current.id)
            .map((row) => row.risk!),
        });
        if (assessed.refusal === 'FUTURES_MAINTENANCE_UNSAFE') {
          setAdminDiagnosticContext({
            evidence: {
              financialGuard: {
                financialOperation: 'leverage_change',
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
        // Same fixed diagnostics and refusal as an increase.
        assertCrossSafe(assessed.after, assessed.hasCross);
        stage('futures_leverage_position_write', accountId);
        const position = await tx.futuresPosition.update({
          where: { id: current.id },
          data: {
            leverage: input.leverage,
            isolatedMargin: plan.isolatedMargin.toFixed(8),
            updatedAt: now,
          },
        });
        const changeId = randomUUID();
        const result: FuturesLeverageChangeResult = {
          success: true,
          data: {
            tradingAccountId: accountId,
            changeId,
            position: {
              ...presentFuturesPosition(position),
              initialMargin: presentFuturesPerformance(position, null)
                .initialMargin,
            },
            leverageChange: {
              fromLeverage: current.leverage,
              toLeverage: input.leverage,
              isolatedMarginBefore: current.isolatedMargin.toFixed(8),
              isolatedMarginAfter: position.isolatedMargin.toFixed(8),
            },
            collateral: {
              walletId: wallet.id,
              currencyCode: 'USD',
              balanceAmount: wallet.balanceAmount.toFixed(8),
              totalMarginUsed: usedAfter.toFixed(8),
              freeCollateral: assessed.after.crossFreeCollateral.toFixed(8),
            },
            changedAt: now.toISOString(),
          },
        };
        stage('futures_leverage_evidence_write', accountId);
        await tx.futuresLeverageChange.create({
          data: {
            id: changeId,
            tradingAccountId: accountId,
            instrumentId: instrument.id,
            positionId: position.id,
            fromLeverage: current.leverage,
            toLeverage: input.leverage,
            isolatedMarginBefore: current.isolatedMargin,
            isolatedMarginAfter: position.isolatedMargin,
            markPrice: mark.price,
            markEffectiveAt: mark.effectiveAt,
            markCapturedAt: mark.capturedAt,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            responsePayloadJson: result as unknown as Prisma.InputJsonValue,
            createdAt: now,
          },
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.futuresLeverageChange.findUnique({
          where,
        });
        if (winner) return replay(winner);
      }
      throw error;
    }
  }

  /**
   * Read-only estimate of a leverage change, alone or with an add of
   * `quantity` at `price` (the add's own basis; the current Futures Last when
   * omitted), from the same plan and exposure checks as the commands. Values
   * that cannot be evaluated (no fresh Mark or price) are null, never
   * guessed; `refusal` names the check that would refuse it now.
   */
  async preview(
    userId: string | undefined,
    accountId: string,
    positionId: string,
    query: { leverage?: string; quantity?: string; price?: string },
  ) {
    requireUser(userId);
    const leverage = Number(query.leverage);
    if (
      typeof query.leverage !== 'string' ||
      !/^\d{1,3}$/u.test(query.leverage)
    )
      invalidPreview();
    assertFuturesLeverage(leverage);
    const quantity = optionalDecimal(query.quantity);
    const price = optionalDecimal(query.price);
    if (price && !quantity) invalidPreview();
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.getOwnedAccountOrThrow(userId, accountId, tx);
        const now = await this.futures.dbNow(tx);
        const current = await tx.futuresPosition.findFirst({
          where: {
            id: positionId,
            tradingAccountId: accountId,
            status: 'open',
          },
          include: { instrument: { include: futuresInstrumentInclude } },
        });
        if (!current) notFound();
        const wallet = await this.futures.wallet(tx, accountId);
        const fee = await accountFuturesFee(tx, accountId);
        const mark = await readFuturesMark(tx, current.instrument, now, false);
        const last =
          quantity && !price
            ? await readFuturesLastPrice(tx, current.instrument, now, false)
            : null;
        const basisPrice = price ?? last?.price ?? null;
        const usedBefore = await futuresMarginUsed(tx, accountId);
        const cross = await loadCrossRisk(
          tx,
          wallet,
          now,
          usedBefore,
          fee,
          false,
        );
        const before = mark ? positionRisk(current, mark.price, fee) : null;
        const base = {
          tradingAccountId: accountId,
          positionId,
          evaluatedAt: now.toISOString(),
          markState: mark ? 'fresh' : 'unavailable_or_stale',
          basisPrice: basisPrice?.toFixed(8) ?? null,
          before: describe(current, before, fee),
        };
        const unavailable = (refusal: string) => ({
          success: true as const,
          data: {
            ...base,
            after: null,
            collateral: null,
            refusal,
          },
        });
        if (!mark) return unavailable('FUTURES_MARK_UNAVAILABLE');
        if (quantity && !basisPrice)
          return unavailable('FUTURES_PRICE_UNAVAILABLE');
        if (cross.rows.some((row) => !row.risk))
          return unavailable('FUTURES_MARK_UNAVAILABLE');
        const changing = leverage !== current.leverage;
        let next: Pick<
          FuturesPosition,
          | 'quantity'
          | 'averageEntryPrice'
          | 'entryNotional'
          | 'isolatedMargin'
          | 'leverage'
          | 'direction'
          | 'marginMode'
        >;
        let feeAmount = futuresDecimal('0');
        try {
          if (quantity) {
            const plan = planFuturesExecution(
              {
                instrumentId: current.instrumentId,
                positionId: current.id,
                operation: 'increase',
                direction: current.direction,
                marginMode: current.marginMode,
                leverage,
                quantity: quantity.toFixed(8),
                idempotencyKey: 'preview',
                ...(changing ? { fromLeverage: current.leverage } : {}),
              },
              current,
              basisPrice!,
              fee,
            );
            feeAmount = plan.feeAmount;
            next = {
              ...current,
              quantity: plan.quantity,
              averageEntryPrice: plan.averageEntryPrice,
              entryNotional: plan.entryNotional,
              isolatedMargin: plan.isolatedMargin,
              leverage,
            };
          } else {
            if (!changing) invalidPreview();
            const plan = planFuturesLeverageChange(current, leverage);
            next = {
              ...current,
              isolatedMargin: plan.isolatedMargin,
              leverage,
            };
          }
        } catch (error) {
          return unavailable(refusalCode(error));
        }
        const usedAfter = usedBefore
          .sub(current.isolatedMargin)
          .add(next.isolatedMargin);
        const nextRisk = positionRisk(next, mark.price, fee);
        const assessed = assessFuturesExposure({
          wallet,
          balanceAfter: assertFuturesMoney(
            futuresDecimal(wallet.balanceAmount).sub(feeAmount),
          ),
          usedAfter,
          marginMode: current.marginMode,
          nextRisk,
          otherCrossRisks: cross.rows
            .filter((row) => row.position.id !== current.id)
            .map((row) => row.risk!),
        });
        return {
          success: true as const,
          data: {
            ...base,
            after: describe(next, nextRisk, fee),
            collateral: {
              freeCollateralBefore:
                cross.risk?.crossFreeCollateral.toFixed(8) ?? null,
              freeCollateralAfter:
                assessed.after.crossFreeCollateral.toFixed(8),
              // Isolated: margin added (+) or released (−) to the lifetime.
              isolatedMarginDelta: futuresDecimal(next.isolatedMargin)
                .sub(current.isolatedMargin)
                .toFixed(8),
              // Mark initial requirement change (Cross: what it holds back).
              initialRequirementDelta: nextRisk.initialRequirement
                .sub(before!.initialRequirement)
                .toFixed(8),
              estimatedFee: feeAmount.toFixed(8),
              crossLiquidationBufferBefore:
                cross.rows.length > 0
                  ? (cross.risk?.liquidationBuffer.toFixed(8) ?? null)
                  : null,
              crossLiquidationBufferAfter: assessed.hasCross
                ? assessed.after.liquidationBuffer.toFixed(8)
                : null,
            },
            refusal: assessed.refusal,
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

export type FuturesLeverageChangeResult = {
  success: true;
  data: {
    tradingAccountId: string;
    changeId: string;
    position: ReturnType<typeof presentFuturesPosition> & {
      initialMargin: string;
    };
    leverageChange: {
      fromLeverage: number;
      toLeverage: number;
      isolatedMarginBefore: string;
      isolatedMarginAfter: string;
    };
    collateral: {
      walletId: string;
      currencyCode: 'USD';
      balanceAmount: string;
      totalMarginUsed: string;
      freeCollateral: string;
    };
    changedAt: string;
  };
};

/** One side of a preview: the lifetime's terms and Mark risk (null when unknown). */
function describe(
  position: Pick<
    FuturesPosition,
    | 'quantity'
    | 'averageEntryPrice'
    | 'entryNotional'
    | 'isolatedMargin'
    | 'leverage'
    | 'direction'
    | 'marginMode'
  >,
  risk: FuturesRisk | null,
  fee: Prisma.Decimal,
) {
  const isolated = position.marginMode === 'isolated';
  return {
    leverage: position.leverage,
    quantity: futuresDecimal(position.quantity).toFixed(8),
    averageEntryPrice: futuresDecimal(position.averageEntryPrice).toFixed(8),
    isolatedMargin: futuresDecimal(position.isolatedMargin).toFixed(8),
    // The 수익률 basis (stored margin, or the entry basis at leverage for Cross).
    initialMargin: presentFuturesPerformance(position, null).initialMargin,
    initialRequirement: risk?.initialRequirement.toFixed(8) ?? null,
    liquidationPrice:
      isolated && risk
        ? (isolatedLiquidationPrice(position, fee)?.toFixed(8) ?? null)
        : null,
    liquidationBuffer:
      isolated && risk ? risk.liquidationBuffer.toFixed(8) : null,
  };
}

function refusalCode(error: unknown) {
  const response =
    error && typeof error === 'object' && 'getResponse' in error
      ? (error as { getResponse(): unknown }).getResponse()
      : null;
  const code =
    response && typeof response === 'object'
      ? (response as { error?: { code?: unknown } }).error?.code
      : null;
  return typeof code === 'string' ? code : 'FUTURES_PREVIEW_UNAVAILABLE';
}

function optionalDecimal(value: string | undefined) {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/u.test(value) ||
    futuresDecimal(value).lte(0)
  )
    invalidPreview();
  return futuresDecimal(value);
}

function requireUser(userId: string | undefined): asserts userId is string {
  if (!userId)
    futuresError('UNAUTHORIZED', 'Unauthorized', HttpStatus.UNAUTHORIZED);
}

function notFound(): never {
  futuresError(
    'FUTURES_POSITION_NOT_FOUND',
    'The intended open position was not found.',
    HttpStatus.NOT_FOUND,
  );
}

function invalidPreview(): never {
  futuresError(
    'INVALID_FUTURES_LEVERAGE_PREVIEW',
    'Check the leverage, quantity and price of the preview.',
    HttpStatus.BAD_REQUEST,
  );
}

function stage(failureStage: string, accountId: string) {
  setAdminDiagnosticContext({
    domain: 'futures',
    operation: 'FUTURES_LEVERAGE_CHANGE',
    failureStage,
    entities: { tradingAccountId: accountId },
    nextInvestigation: ['backend/src/futures/futures-leverage.service.ts'],
  });
}
