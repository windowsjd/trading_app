import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { assertAccountFinancialScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import { canonicalCashWalletSetIssue } from '../wallets/canonical-cash-wallets';
import {
  assertGeneralAccountFinancialIntegrity,
  assertGeneralAccountTradingRowsIntegrity,
  assertGeneralAccountFxRowsIntegrity,
} from '../trading-accounts/general-account-integrity';
import { futuresDecimal as d, planFuturesExecution } from './futures-math';
import {
  accountFuturesFee,
  positionRisk,
  crossRisk,
  sumRisk,
} from './futures-risk';
import { readFuturesMark } from './futures-mark';
import { futuresRiskConfig } from './futures.config';
import { futuresError } from './futures-error';
import { bankruptcySettlement, settleFuturesCash } from './futures-settlement';

@Injectable()
export class FuturesLiquidationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Candidate is only a lifetime hint. Every financial fact is reloaded after locks. */
  async liquidate(accountId: string, scope: string) {
    if (!futuresRiskConfig().enabled) return { state: 'risk_disabled' };
    return this.prisma.$transaction(
      async (tx) => {
        const target = await tx.tradingAccount.findUnique({
          where: { id: accountId },
          include: { seasonParticipant: true },
        });
        if (!target) return { state: 'account_missing' };
        if (target.mode === 'general')
          await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${accountId} FOR UPDATE`;
        else {
          if (!target.seasonParticipant)
            futuresError(
              'FINANCIAL_SCOPE_REPAIR_REQUIRED',
              'Account information could not be verified. Please try again.',
            );
          const lifecycle = await lockSeasonTradingContext(tx, {
            seasonParticipantId: target.seasonParticipant.id,
            participantWrite: false,
          });
          if (lifecycle.account.id !== accountId)
            futuresError(
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Account information could not be verified. Please try again.',
            );
        }
        await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${accountId} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM futures_positions WHERE trading_account_id = ${accountId} AND status = 'open' ORDER BY id FOR UPDATE`;
        const now = (
          await tx.$queryRaw<
            Array<{ now: Date }>
          >`SELECT clock_timestamp() AS now`
        )[0].now;
        if (!futuresRiskConfig().enabled) return { state: 'risk_disabled' };
        const account = await tx.tradingAccount.findUniqueOrThrow({
          where: { id: accountId },
          include: { seasonParticipant: { include: { season: true } } },
        });
        const season = account.seasonParticipant?.season;
        // Forced reduction may run for suspended/excluded accounts, but never changes finalized season cash.
        if (
          account.status === 'closed' ||
          (account.mode === 'season' &&
            (!season ||
              !['active', 'excluded'].includes(
                account.seasonParticipant!.participantStatus,
              ) ||
              season.status !== 'active' ||
              now < season.startAt ||
              now >= season.endAt))
        )
          return { state: 'lifecycle_blocked', accountId };
        const wallets = await tx.cashWallet.findMany({
          where: { tradingAccountId: accountId },
        });
        if (canonicalCashWalletSetIssue(wallets))
          futuresError(
            'FINANCIAL_SCOPE_REPAIR_REQUIRED',
            'Futures wallet information could not be verified.',
          );
        await assertAccountFinancialScopeIntegrity(tx, {
          tradingAccountId: accountId,
        });
        if (account.mode === 'general') {
          await assertGeneralAccountFinancialIntegrity(tx, account);
          await assertGeneralAccountTradingRowsIntegrity(tx, accountId);
          await assertGeneralAccountFxRowsIntegrity(
            tx,
            accountId,
            account.userId,
          );
        }
        const wallet = wallets.find(
          (w) => w.walletScope === 'crypto_futures' && w.currencyCode === 'USD',
        )!;
        const all = await tx.futuresPosition.findMany({
          where: { tradingAccountId: accountId, status: 'open' },
          include: { instrument: { include: { underlyingAsset: true } } },
          orderBy: { id: 'asc' },
        });
        const positions = all.filter((p) =>
          scope === 'cross'
            ? p.marginMode === 'cross'
            : p.id === scope && p.marginMode === 'isolated',
        );
        if (!positions.length) return { state: 'already_closed' };
        const fee = await accountFuturesFee(tx, accountId);
        const rows = await Promise.all(
          positions.map(async (p) => {
            const mark = (await readFuturesMark(tx, p.instrument, now))!;
            return {
              p,
              mark,
              risk: positionRisk(p, mark.price, fee),
              plan: planFuturesExecution(
                {
                  instrumentId: p.instrumentId,
                  positionId: p.id,
                  marginMode: p.marginMode,
                  operation: 'close',
                  direction: p.direction,
                  quantity: p.quantity.toFixed(8),
                  leverage: p.leverage,
                  idempotencyKey: 'system',
                },
                p,
                mark.price,
                fee,
                'liquidation',
              ),
            };
          }),
        );
        const isolated = sumRisk(
          all
            .filter((p) => p.marginMode === 'isolated')
            .map((p) => p.isolatedMargin),
        );
        const cross = crossRisk(
          wallet,
          isolated,
          rows.map((r) => r.risk),
        );
        const collateral =
          scope === 'cross'
            ? cross.crossBaseCollateral
            : d(positions[0].isolatedMargin);
        // Underfunded allocations are integrity damage, never permission to raid another mode.
        if (d(wallet.balanceAmount).sub(wallet.reservedAmount).lt(isolated))
          futuresError(
            'FUTURES_COLLATERAL_INTEGRITY',
            'Futures collateral information could not be verified.',
          );
        const equity =
          scope === 'cross' ? cross.crossEquity : rows[0].risk.equity;
        const maintenanceMargin = sumRisk(
          rows.map((r) => r.risk.maintenanceMargin),
        );
        const estimatedCloseFee = sumRisk(
          rows.map((r) => r.risk.estimatedCloseFee),
        );
        const requirement = maintenanceMargin.add(estimatedCloseFee);
        if (equity.gt(requirement)) return { state: 'healthy' };
        const pnl = sumRisk(rows.map((r) => r.plan.realizedPnl)),
          feeAmount = sumRisk(rows.map((r) => r.plan.feeAmount));
        const settlement = bankruptcySettlement(collateral, pnl, feeAmount);
        const id = randomUUID();
        const event = await tx.futuresLiquidation.create({
          data: {
            id,
            tradingAccountId: accountId,
            marginMode: scope === 'cross' ? 'cross' : 'isolated',
            evaluationAt: now,
            executedAt: now,
            collateralAvailable: collateral,
            preEquity: equity,
            maintenanceMargin,
            estimatedCloseFee,
            liquidationRequirement: requirement,
            realizedPnl: pnl,
            feeAmount,
            ...settlement,
            walletBalanceBefore: wallet.balanceAmount,
            walletBalanceAfter: d(wallet.balanceAmount).add(
              settlement.settledCash,
            ),
          },
        });
        for (const row of rows) {
          await tx.futuresPosition.update({
            where: { id: row.p.id },
            data: {
              quantity: '0',
              isolatedMargin: '0',
              entryNotional: '0',
              status: 'closed',
              closedAt: now,
              updatedAt: now,
              realizedPnl: row.plan.cumulativeRealizedPnl,
            },
          });
          await tx.futuresLiquidationClose.create({
            data: {
              liquidationId: id,
              tradingAccountId: accountId,
              positionId: row.p.id,
              instrumentId: row.p.instrumentId,
              markSnapshotId: row.mark.id,
              direction: row.p.direction,
              quantity: row.p.quantity,
              executionPrice: row.mark.price,
              maintenanceMargin: row.risk.maintenanceMargin,
              estimatedCloseFee: row.risk.estimatedCloseFee,
              realizedPnl: row.plan.realizedPnl,
              feeRate: fee,
              feeAmount: row.plan.feeAmount,
            },
          });
        }
        const cash = await settleFuturesCash(
          tx,
          wallet,
          'futures_liquidation',
          id,
          settlement.settledPnl,
          settlement.settledFee,
          now,
        );
        await tx.walletTransaction.createMany({ data: cash.ledger });
        return { state: 'liquidated', eventId: event.id };
      },
      { maxWait: 5000, timeout: 15000 },
    );
  }
}
