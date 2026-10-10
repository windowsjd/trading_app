import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { finishFuturesProtection } from '../conditional/conditional-state';
import {
  Prisma,
  type FuturesPosition,
  type FuturesSeasonPrice,
  type AssetPriceSnapshot,
  type FuturesLastPriceSnapshot,
  type CashWallet,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockSeasonForWriteOrThrow } from '../ranking/season-write-lock';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { canonicalCashWalletSetIssue } from '../wallets/canonical-cash-wallets';
import { assertAccountFinancialScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import { futuresError } from './futures-error';
import { futuresDecimal as d, planFuturesExecution } from './futures-math';
import { sumRisk } from './futures-risk';
import { validLegacySpotFinalPrice } from './futures-price';
import {
  FUTURES_FINAL_LAST_WINDOW_MS,
  FUTURES_LAST_MAX_TRADE_AGE_MS,
  readFuturesFinalLastPrice,
  validFuturesFinalLastPrice,
} from './futures-last-price';
import { bankruptcySettlement, settleFuturesCash } from './futures-settlement';
import type { InstrumentWithAsset } from './futures.presenter';

/** Exactly one evidence kind (SQL CHECK). Spot pins predate Futures Last. */
type PinnedPrice = FuturesSeasonPrice & {
  snapshot: AssetPriceSnapshot | null;
  lastPriceSnapshot: FuturesLastPriceSnapshot | null;
};
const pinInclude = { snapshot: true, lastPriceSnapshot: true } as const;

/** A pin is re-verified by its own evidence kind and reused unchanged. */
function validSeasonPin(
  pin: PinnedPrice,
  instrument: InstrumentWithAsset,
  endAt: Date,
) {
  if (pin.lastPriceSnapshot)
    return (
      !pin.snapshot &&
      validFuturesFinalLastPrice(pin.lastPriceSnapshot, instrument, endAt)
    );
  return (
    !!pin.snapshot &&
    validLegacySpotFinalPrice(pin.snapshot, instrument.underlyingAsset, endAt)
  );
}

/** Pinned final price and its time bounds; null for a malformed pin. */
function pinnedFinalEvidence(pin: PinnedPrice, instrumentId: string) {
  if (pin.lastPriceSnapshot && !pin.snapshot)
    return pin.lastPriceSnapshot.instrumentId === instrumentId
      ? {
          price: pin.lastPriceSnapshot.price,
          effectiveAt: pin.lastPriceSnapshot.effectiveAt,
          capturedAt: pin.lastPriceSnapshot.capturedAt,
          maxEffectiveAgeMs: FUTURES_LAST_MAX_TRADE_AGE_MS,
        }
      : null;
  if (pin.snapshot && !pin.lastPriceSnapshot && pin.snapshot.assetId !== '')
    return {
      price: pin.snapshot.price,
      effectiveAt: pin.snapshot.effectiveAt,
      capturedAt: pin.snapshot.capturedAt,
      maxEffectiveAgeMs: 10000,
    };
  return null;
}

/** No provider I/O. Season → Account → Participant → Futures wallet → sorted lifetimes.
 * Pin all instrument prices first, then commit bounded account transactions. A retry
 * resumes closed accounts without re-settling them. Final ranking is a later barrier. */
@Injectable()
export class FuturesSeasonSettlementService {
  constructor(private readonly prisma: PrismaService) {}

  async assertNoOpen(
    seasonId: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const count = await client.futuresPosition.count({
      where: {
        status: 'open',
        tradingAccount: { seasonParticipant: { seasonId } },
      },
    });
    setAdminDiagnosticContext({
      failureStage: 'futures_final_open_lifetimes',
      entities: { seasonId },
      evidence: {
        openPositionCount: count,
        checkState: 'final_lifetime_barrier',
      },
    });
    if (count)
      futuresError(
        'FUTURES_FINAL_SETTLEMENT_REQUIRED',
        'Season final results require all Futures positions to be closed.',
      );
  }

  async settleSeason(seasonId: string, dryRun = false) {
    const prices = await this.preparePrices(seasonId, dryRun);
    const projections = new Map<string, Prisma.Decimal>();
    // All statuses, including excluded participants. No ranking eligibility filter.
    const accounts = await this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        tradingAccount: { futuresPositions: { some: { status: 'open' } } },
      },
      select: { tradingAccountId: true },
      orderBy: { tradingAccountId: 'asc' },
    });
    for (const { tradingAccountId } of accounts) {
      const balance = await this.settleAccount(
        seasonId,
        tradingAccountId,
        dryRun,
        prices,
      );
      if (balance) projections.set(tradingAccountId, balance);
    }
    if (!dryRun) await this.assertNoOpen(seasonId);
    return projections;
  }

  private async preparePrices(seasonId: string, dryRun: boolean) {
    setAdminDiagnosticContext({
      failureStage: 'futures_final_price_pin',
      entities: { seasonId },
      evidence: { checkState: 'end_boundary_validation', dryRun },
    });
    return this.prisma.$transaction(
      async (tx) => {
        await lockSeasonForWriteOrThrow(tx, seasonId);
        const season = await tx.season.findUniqueOrThrow({
          where: { id: seasonId },
        });
        if (season.status !== 'ended')
          futuresError(
            'SEASON_NOT_ENDED',
            'Futures final settlement requires an ended Season.',
          );
        const instruments = await tx.futuresInstrument.findMany({
          where: {
            positions: {
              some: {
                status: 'open',
                tradingAccount: { seasonParticipant: { seasonId } },
              },
            },
          },
          include: { underlyingAsset: true },
          orderBy: { id: 'asc' },
        });
        const pinned = await tx.futuresSeasonPrice.findMany({
          where: { seasonId },
          include: pinInclude,
        });
        const prices = new Map(pinned.map((p) => [p.instrumentId, p]));
        for (const instrument of instruments) {
          const existing = prices.get(instrument.id);
          if (existing) {
            if (
              +existing.endAt !== +season.endAt ||
              !existing.feeRate.eq(season.tradeFeeRate) ||
              !validSeasonPin(existing, instrument, season.endAt)
            )
              futuresError(
                'FUTURES_FINAL_EVIDENCE_INTEGRITY',
                'Season final settlement terms could not be verified.',
              );
            continue;
          }
          // Futures Last received within 10 seconds before endAt (never after),
          // reporting a trade within 60 seconds. No Spot or Mark substitute.
          const lastPriceSnapshot = await readFuturesFinalLastPrice(
            tx,
            instrument,
            season.endAt,
          );
          const data = {
            id: randomUUID(),
            seasonId,
            instrumentId: instrument.id,
            lastPriceSnapshotId: lastPriceSnapshot.id,
            endAt: season.endAt,
            feeRate: season.tradeFeeRate,
          };
          const price: PinnedPrice = dryRun
            ? {
                ...data,
                assetPriceSnapshotId: null,
                createdAt: new Date(),
                snapshot: null,
                lastPriceSnapshot,
              }
            : await tx.futuresSeasonPrice.create({
                data,
                include: pinInclude,
              });
          prices.set(instrument.id, price);
        }
        return prices;
      },
      { timeout: 15000 },
    );
  }

  async settleAccount(
    seasonId: string,
    accountId: string,
    dryRun = false,
    previewPrices?: Map<string, PinnedPrice>,
  ) {
    setAdminDiagnosticContext({
      failureStage: 'futures_final_account_settlement',
      entities: { seasonId, tradingAccountId: accountId },
      evidence: { checkState: 'locked_final_exit', dryRun },
    });
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', '15000', true)`;
        const participant = await tx.seasonParticipant.findUnique({
          where: { tradingAccountId: accountId },
        });
        if (!participant || participant.seasonId !== seasonId)
          futuresError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Season settlement account scope could not be verified.',
          );
        const context = await lockSeasonTradingContext(tx, {
          seasonParticipantId: participant.id,
          participantWrite: false,
        });
        await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${accountId} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM futures_positions WHERE trading_account_id = ${accountId} AND status = 'open' ORDER BY id FOR UPDATE`;
        const now = (
          await tx.$queryRaw<
            Array<{ now: Date }>
          >`SELECT clock_timestamp() AS now`
        )[0].now;
        const positions = await tx.futuresPosition.findMany({
          where: { tradingAccountId: accountId, status: 'open' },
          include: { instrument: { include: { underlyingAsset: true } } },
          orderBy: { id: 'asc' },
        });
        const existing = await tx.futuresSeasonSettlement.findUnique({
          where: { tradingAccountId: accountId },
        });
        if (!positions.length) return null;
        if (
          existing ||
          context.season.status !== 'ended' ||
          context.account.status === 'closed' ||
          now < context.season.endAt
        )
          futuresError(
            'FUTURES_FINAL_SETTLEMENT_INTEGRITY',
            'Final Futures settlement lifecycle could not be verified.',
          );
        await assertAccountFinancialScopeIntegrity(tx, {
          tradingAccountId: accountId,
        });
        const wallets = await tx.cashWallet.findMany({
          where: { tradingAccountId: accountId },
        });
        if (canonicalCashWalletSetIssue(wallets))
          futuresError(
            'FINANCIAL_SCOPE_REPAIR_REQUIRED',
            'Season wallet set could not be verified.',
          );
        // Lifecycle cleanup is authoritative; a final exit never consumes reserved cash.
        if (wallets.some((w) => w.reservedAmount.gt(0)))
          futuresError(
            'OPEN_LIMIT_ORDER_RESERVATIONS',
            'Release all Season reservations before final settlement.',
          );
        const wallet = wallets.find(
          (w) => w.walletScope === 'crypto_futures' && w.currencyCode === 'USD',
        )!;
        const season = await tx.season.findUniqueOrThrow({
          where: { id: seasonId },
        });
        const prices =
          dryRun && previewPrices
            ? previewPrices
            : new Map(
                (
                  await tx.futuresSeasonPrice.findMany({
                    where: { seasonId },
                    include: pinInclude,
                  })
                ).map((p) => [p.instrumentId, p]),
              );
        for (const position of positions) {
          const price = prices.get(position.instrumentId);
          if (
            !price ||
            !validSeasonPin(price, position.instrument, season.endAt)
          )
            futuresError(
              'FUTURES_FINAL_PRICE_UNAVAILABLE',
              'Final Futures settlement price could not be verified.',
            );
        }
        const plan = planSeasonFuturesExit(
          wallet,
          positions,
          prices,
          season.endAt,
          season.tradeFeeRate,
        );
        if (dryRun) return plan.walletBalanceAfter;
        const id = randomUUID();
        await tx.futuresSeasonSettlement.create({
          data: {
            id,
            seasonId,
            tradingAccountId: accountId,
            endAt: season.endAt,
            feeRate: season.tradeFeeRate,
            realizedPnl: plan.realizedPnl,
            feeAmount: plan.feeAmount,
            settledPnl: plan.settledPnl,
            settledFee: plan.settledFee,
            settledCash: plan.settledCash,
            bankruptcyShortfall: plan.bankruptcyShortfall,
            walletBalanceBefore: wallet.balanceAmount,
            walletBalanceAfter: plan.walletBalanceAfter,
            scopesJson: plan.scopes,
            executedAt: now,
          },
        });
        for (const row of plan.rows) {
          await tx.futuresPosition.update({
            where: { id: row.position.id },
            data: {
              quantity: '0',
              isolatedMargin: '0',
              entryNotional: '0',
              status: 'closed',
              realizedPnl: row.close.cumulativeRealizedPnl,
              closedAt: season.endAt,
              updatedAt: now,
            },
          });
          await tx.futuresSeasonClose.create({
            data: {
              settlementId: id,
              tradingAccountId: accountId,
              positionId: row.position.id,
              instrumentId: row.position.instrumentId,
              priceId: row.price.id,
              direction: row.position.direction,
              marginMode: row.position.marginMode,
              quantity: row.position.quantity,
              executionPrice: row.executionPrice,
              realizedPnl: row.close.realizedPnl,
              feeRate: season.tradeFeeRate,
              feeAmount: row.close.feeAmount,
            },
          });
          await finishFuturesProtection(
            tx,
            row.position.id,
            'season_settled',
            now,
          );
        }
        const { ledger } = await settleFuturesCash(
          tx,
          wallet,
          'futures_season_settlement',
          id,
          plan.settledPnl,
          plan.settledFee,
          now,
        );
        await tx.walletTransaction.createMany({ data: ledger });
        return plan.walletBalanceAfter;
      },
      { timeout: 15000 },
    );
  }
}

/** Scope budgets are frozen BEFORE any exit. Profits/releases in another mode
 * cannot cover this scope's bankruptcy; iteration order never changes economics. */
export function planSeasonFuturesExit(
  wallet: CashWallet,
  positions: FuturesPosition[],
  prices: Map<string, PinnedPrice>,
  endAt: Date,
  feeRate: Prisma.Decimal,
) {
  setAdminDiagnosticContext({
    failureStage: 'futures_final_collateral_scope',
    evidence: {
      openPositionCount: positions.length,
      checkState: 'frozen_scope_budgets',
      endAt,
    },
  });
  const isolated = sumRisk(
    positions
      .filter((p) => p.marginMode === 'isolated')
      .map((p) => p.isolatedMargin),
  );
  const crossCollateral = d(wallet.balanceAmount)
    .sub(wallet.reservedAmount)
    .sub(isolated);
  if (crossCollateral.lt(0))
    futuresError(
      'FUTURES_COLLATERAL_INTEGRITY',
      'Protected collateral is underfunded.',
    );
  const rows = positions.map((position) => {
    const price = prices.get(position.instrumentId);
    const evidence = price && pinnedFinalEvidence(price, position.instrumentId);
    if (
      !price ||
      !evidence ||
      +price.endAt !== +endAt ||
      !price.feeRate.eq(feeRate) ||
      evidence.effectiveAt > evidence.capturedAt ||
      evidence.capturedAt > endAt ||
      +endAt - +evidence.capturedAt > FUTURES_FINAL_LAST_WINDOW_MS ||
      +endAt - +evidence.effectiveAt > evidence.maxEffectiveAgeMs
    )
      futuresError(
        'FUTURES_FINAL_PRICE_UNAVAILABLE',
        'A fresh final execution price at Season end is required.',
      );
    return {
      position,
      price,
      executionPrice: evidence.price,
      close: planFuturesExecution(
        {
          instrumentId: position.instrumentId,
          positionId: position.id,
          marginMode: position.marginMode,
          operation: 'close',
          direction: position.direction,
          quantity: position.quantity.toFixed(8),
          leverage: position.leverage,
          idempotencyKey: 'season-final',
        },
        position,
        evidence.price,
        feeRate,
        'season_final',
      ),
    };
  });
  const scopes = [
    ...new Set(
      rows.map((r) =>
        r.position.marginMode === 'cross' ? 'cross' : r.position.id,
      ),
    ),
  ].map((scope) => {
    const group = rows.filter(
      (r) =>
        (r.position.marginMode === 'cross' ? 'cross' : r.position.id) === scope,
    );
    const collateral =
      scope === 'cross' ? crossCollateral : d(group[0].position.isolatedMargin);
    const pnl = sumRisk(group.map((r) => r.close.realizedPnl));
    const fee = sumRisk(group.map((r) => r.close.feeAmount));
    const settled = bankruptcySettlement(collateral, pnl, fee);
    return {
      scope,
      marginMode: group[0].position.marginMode,
      positionIds: group.map((r) => r.position.id),
      collateralAvailable: collateral.toFixed(8),
      realizedPnl: pnl.toFixed(8),
      feeAmount: fee.toFixed(8),
      ...(Object.fromEntries(
        Object.entries(settled).map(([key, value]) => [key, value.toFixed(8)]),
      ) as {
        settledPnl: string;
        settledFee: string;
        settledCash: string;
        bankruptcyShortfall: string;
      }),
    };
  });
  const total = (
    key:
      | 'realizedPnl'
      | 'feeAmount'
      | 'settledPnl'
      | 'settledFee'
      | 'settledCash'
      | 'bankruptcyShortfall',
  ) => sumRisk(scopes.map((s) => d(s[key])));
  const settledCash = total('settledCash');
  return {
    rows,
    scopes,
    realizedPnl: total('realizedPnl'),
    feeAmount: total('feeAmount'),
    settledPnl: total('settledPnl'),
    settledFee: total('settledFee'),
    settledCash,
    bankruptcyShortfall: total('bankruptcyShortfall'),
    walletBalanceAfter: d(wallet.balanceAmount).add(settledCash),
  };
}
