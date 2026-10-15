/** Season final-ranking eligibility, opt-in disposable PostgreSQL
 * (docs/season-final-ranking-eligibility.md).
 *
 * Real SeasonSettlementJobService (through BatchService and the real
 * PortfolioValuationService), FinalTierAssignmentJobService, RankingService,
 * OperatorSeasonModerationService, RewardFulfillmentService,
 * TradingAccountPortfolioService, RecordsService and the ranking audit, on
 * fills inserted under the real CHECKs/triggers. Each scenario asserts the
 * stored state, not only the command outcome:
 *
 *   - only participants with >= 5 distinct instruments AND turnover >=
 *     300% of initial capital are ranked; ranks are 1..N and the tier
 *     denominator is N; everyone else keeps a final valuation, a settlement
 *     snapshot, a stored verdict and a closed account,
 *   - Spot uses its pinned execution FX; Futures uses notional ÷ leverage at
 *     the USD/KRW its execution pinned (real FuturesService), or — for an
 *     execution committed before pinning — the settlement FX rule as of its
 *     execution (priority, captured-at),
 *   - 0 qualifiers settles normally and replays idempotently; so does a rule
 *     season with no rankable participant (none at all, or all excluded),
 *   - missing/mismatched evidence fails closed BEFORE the Futures final exit:
 *     no position, wallet, ledger, snapshot, verdict or status changes,
 *   - readers never present a damaged final result as empty or pending,
 *   - exclusion during settlement, concurrent runs, a failure after the
 *     Futures exit, operator/reward bypasses, DB constraints, seasons without
 *     a rule.
 * No provider/Redis/HTTP calls; fixtures are uniquely named, removed by ID. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import type { Prisma } from '../src/generated/prisma/client';
import { BatchService } from '../src/batch/batch.service';
import { FinalTierAssignmentJobService } from '../src/batch/final-tier-assignment-job.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { FuturesSeasonSettlementService } from '../src/futures/futures-season-settlement.service';
import { FuturesService } from '../src/futures/futures.service';
import { BINANCE_FUTURES_SYMBOLS } from '../src/providers/binance/binance-product-catalog';
import { findUsdKrwRatesAtOrBefore } from '../src/providers/fx-rate-snapshot-query';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from '../src/operator/operator-season-moderation.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { formatKstRankingDate } from '../src/ranking/ranking-date.policy';
import { RankingService } from '../src/ranking/ranking.service';
import { RecordsService } from '../src/records/records.service';
import { RewardFulfillmentService } from '../src/rewards/reward-fulfillment.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
import { auditRankingAndSettlement } from './lib/repair-ranking-scope';

// Writes fixtures: loopback, disposable databases only (CI's service
// container database is `trading_app`).
const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SEASON_FINAL_QUALIFICATION_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !(
    target.pathname.endsWith('_test') ||
    (process.env.GITHUB_ACTIONS === 'true' &&
      target.pathname === '/trading_app')
  )
)
  throw new Error(
    'Requires NODE_ENV=test, SEASON_FINAL_QUALIFICATION_DB_INTEGRATION=1 and a local disposable *_test DATABASE_URL.',
  );
Logger.overrideLogger(false);

const db = new PrismaService();
const valuation = new PortfolioValuationService(db);
const settlementJob = () =>
  new SeasonSettlementJobService(new BatchService(db), db, valuation);
const tierJob = () =>
  new FinalTierAssignmentJobService(new BatchService(db), db);
const ranking = new RankingService(db);
const moderation = new OperatorSeasonModerationService(
  db,
  new OperatorAuditService(db),
  new LimitOrderCancelService(db, new OrderReservationService()),
);
const rewards = new RewardFulfillmentService(db, new OperatorAuditService(db));
const portfolio = new TradingAccountPortfolioService(
  db,
  new TradingAccountAccessService(db),
  new GeneralAccountPerformanceService(
    db,
    valuation,
    new GeneralExternalFundingService(db),
  ),
  valuation,
);
const records = new RecordsService(db, valuation);
process.env.FUTURES_TRADING_ENABLED = 'true';
const futuresFor = (prisma: PrismaService) =>
  new FuturesService(
    prisma,
    new TradingAccountAccessService(prisma),
    new GeneralAccountPerformanceService(
      prisma,
      valuation,
      new GeneralExternalFundingService(prisma),
    ),
  );

// ------------------------------------------------------------------ helpers

const RUN = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CAPITAL = '1000000';
const KOREA_EXIM = 'korea_exim_exchange_rate';
const EXCHANGE_RATE_API = 'exchange_rate_api';

type Outcome = { ok: true; value: unknown } | { ok: false; code: string };
async function outcome(command: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await command };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}
function codeOf(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string'
      ? body.error.code
      : `HTTP_${error.getStatus()}`;
  }
  return error instanceof Error
    ? `${error.constructor.name}: ${error.message.split('\n')[0].slice(0, 160)}`
    : String(error);
}
const okOrCode = (o: Outcome) => (o.ok ? 'ok' : o.code);
async function dbNow() {
  return (
    await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  )[0].now;
}
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const fixed8 = (value: { toFixed(scale: number): string } | null) =>
  value === null ? 'null' : value.toFixed(8);

/** Every row this run creates, removed by ID at the end. */
const created = {
  seasons: [] as string[],
  users: [] as string[],
  accounts: [] as string[],
  assets: [] as string[],
  instruments: [] as string[],
  fx: [] as string[],
  batchKeys: [] as string[],
  badgeCodes: [] as string[],
};

let operator!: { userId: string; role: 'admin' };

type Member = { userId: string; accountId: string; participantId: string };

async function createUser(label: string) {
  const user = await db.user.create({
    data: {
      email: `fq-${label}-${randomUUID()}@example.invalid`,
      nickname: `fq${label.slice(0, 4)}-${randomUUID().slice(0, 8)}`,
      passwordHash: 'test-only',
    },
  });
  created.users.push(user.id);
  return user;
}

async function createSeason(input: {
  label: string;
  status: 'upcoming' | 'active' | 'ended' | 'settled';
  startAt: Date;
  endAt: Date;
  criteria: boolean;
}) {
  const season = await db.season.create({
    data: {
      name: `fq-${input.label}-${RUN}`,
      status: input.status,
      startAt: input.startAt,
      endAt: input.endAt,
      initialCapitalKrw: CAPITAL,
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
      ...(input.criteria
        ? {
            finalRankingMinTradedInstruments: 5,
            finalRankingMinTurnoverRatio: '3',
          }
        : {}),
    },
  });
  created.seasons.push(season.id);
  return season;
}

async function join(
  seasonId: string,
  startAt: Date,
  label: string,
  krw: string,
  options: {
    userId?: string;
    status?: 'active' | 'excluded';
    /** Futures collateral (USD) for an open position fixture. */
    futuresUsd?: string;
  } = {},
): Promise<Member> {
  const userId = options.userId ?? (await createUser(label)).id;
  const excluded = options.status === 'excluded';
  const account = await db.tradingAccount.create({
    data: {
      userId,
      mode: 'season',
      status: excluded ? 'suspended' : 'active',
      initialCapitalKrw: CAPITAL,
      openedAt: startAt,
    },
  });
  created.accounts.push(account.id);
  const participant = await db.seasonParticipant.create({
    data: {
      userId,
      seasonId,
      tradingAccountId: account.id,
      participantStatus: excluded ? 'excluded' : 'active',
      excludedAt: excluded ? startAt : null,
      joinedAt: startAt,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: krw,
      totalReturnRate: '0',
      maxDrawdown: '0',
      // A provisional standing the season leaves behind (cleared for the
      // participants that end without a final rank).
      currentRank: excluded ? null : 1,
    },
  });
  await db.cashWallet.createMany({
    data: [
      { tradingAccountId: account.id, currencyCode: 'KRW', balanceAmount: krw },
      { tradingAccountId: account.id, currencyCode: 'USD', balanceAmount: '0' },
      ...zeroCryptoCashWalletData(account.id).map((wallet) =>
        wallet.walletScope === 'crypto_futures' && options.futuresUsd
          ? { ...wallet, balanceAmount: options.futuresUsd }
          : wallet,
      ),
    ],
  });
  return { userId, accountId: account.id, participantId: participant.id };
}

type Market = {
  krx: string[];
  usStock: string;
  crypto: string;
  btc: { assetId: string; instrumentId: string; priceId: string };
  eth: { assetId: string; instrumentId: string; priceId: string };
};

let marketCount = 0;
async function createMarket(lastPriceAt: Date): Promise<Market> {
  marketCount += 1;
  const tag = `${RUN}${marketCount}`;
  const asset = async (
    symbol: string,
    market: string,
    assetType: 'domestic_stock' | 'us_stock' | 'crypto',
    currency: 'KRW' | 'USD',
  ) => {
    const row = await db.asset.create({
      data: {
        symbol,
        name: `fq ${symbol}`,
        market,
        assetType,
        currencyCode: currency,
        priceCurrency: currency,
        settlementCurrency: currency,
        isActive: true,
      },
    });
    created.assets.push(row.id);
    return row.id;
  };
  const krx: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    krx.push(await asset(`9${tag}${index}`, 'KOSPI', 'domestic_stock', 'KRW'));
  }
  const futures = async (base: string) => {
    const assetId = await asset(
      `Q${tag}${base}USDT`,
      'BINANCE',
      'crypto',
      'USD',
    );
    const instrument = await db.futuresInstrument.create({
      data: { underlyingAssetId: assetId },
    });
    created.instruments.push(instrument.id);
    const price = await db.futuresLastPriceSnapshot.create({
      data: {
        instrumentId: instrument.id,
        symbol: `Q${tag}${base}USDT`,
        source: 'binance_usdm_agg_trade_ws',
        price: '100',
        effectiveAt: lastPriceAt,
        capturedAt: lastPriceAt,
      },
    });
    return { assetId, instrumentId: instrument.id, priceId: price.id };
  };
  return {
    krx,
    usStock: await asset(`FQ${tag}US`, 'NAS', 'us_stock', 'USD'),
    crypto: await asset(`F${tag}SPOTUSDT`, 'BINANCE', 'crypto', 'USD'),
    btc: await futures('BTC'),
    eth: await futures('ETH'),
  };
}

async function fx(input: {
  source: string;
  rate: string;
  effectiveAt: Date;
  capturedAt: Date;
  base?: 'USD' | 'KRW';
}) {
  const row = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: input.base ?? 'USD',
      quoteCurrency: input.base === 'KRW' ? 'USD' : 'KRW',
      rate: input.rate,
      sourceType: 'provider_api',
      sourceName: input.source,
      effectiveAt: input.effectiveAt,
      capturedAt: input.capturedAt,
    },
  });
  created.fx.push(row.id);
  return row.id;
}

/** One committed Spot fill: `gross` is the executed amount in `currency`. */
async function fill(
  member: Member,
  assetId: string,
  gross: string,
  executedAt: Date,
  options: {
    side?: 'buy' | 'sell';
    currency?: 'KRW' | 'USD';
    scope?: 'securities' | 'crypto_spot';
    fxId?: string;
  } = {},
) {
  await db.order.create({
    data: {
      tradingAccountId: member.accountId,
      assetId,
      side: options.side ?? 'buy',
      orderType: 'market',
      status: 'executed',
      quantity: '1',
      executedPrice: gross,
      currencyCode: options.currency ?? 'KRW',
      cashWalletScope: options.scope ?? 'securities',
      grossAmount: gross,
      feeAmount: '0',
      netAmount: gross,
      fxRateSnapshotId: options.fxId ?? null,
      submittedAt: executedAt,
      executedAt,
    },
  });
}

/**
 * One Futures execution leg. In a rule season the real execution path pins the
 * USD/KRW it is converted with (`fxId`). `legacy` inserts the row the way an
 * execution committed BEFORE executions pinned FX looks: unpinned, with the
 * pin guard (which did not exist then) disabled for that one transaction.
 */
type FuturesLeg = {
  operation: 'open' | 'increase' | 'reduce' | 'close';
  quantity: string;
  after: string;
  executedAt: Date;
} & ({ fxId: string; legacy?: never } | { legacy: true; fxId?: never });

async function insertExecution(
  member: Member,
  contract: Market['btc'],
  positionId: string,
  leverage: number,
  leg: FuturesLeg,
) {
  const price = await db.futuresLastPriceSnapshot.findUniqueOrThrow({
    where: { id: contract.priceId },
  });
  const data = {
    tradingAccountId: member.accountId,
    instrumentId: contract.instrumentId,
    positionId,
    operation: leg.operation,
    direction: 'long' as const,
    marginMode: 'isolated' as const,
    quantity: leg.quantity,
    leverage,
    executionPrice: '100',
    lastPriceSnapshotId: price.id,
    priceSourceType: 'provider_api' as const,
    priceSourceName: 'binance_usdm_agg_trade_ws',
    priceEffectiveAt: price.effectiveAt,
    priceCapturedAt: price.capturedAt,
    notional: (Number(leg.quantity) * 100).toFixed(8),
    feeRate: '0.001',
    feeAmount: '0',
    realizedPnl: '0',
    positionQuantityAfter: leg.after,
    averageEntryPriceAfter: '100',
    isolatedMarginAfter:
      leg.operation === 'close' ? '0' : (100 / leverage).toFixed(8),
    executedAt: leg.executedAt,
    fxRateSnapshotId: leg.fxId ?? null,
  };
  if (!leg.legacy) {
    return db.futuresExecution.create({ data });
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'ALTER TABLE "futures_executions" DISABLE TRIGGER "futures_executions_fx_evidence_guard"',
    );
    const row = await tx.futuresExecution.create({ data });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "futures_executions" ENABLE TRIGGER "futures_executions_fx_evidence_guard"',
    );
    return row;
  });
}

/** A Futures lifetime with its user executions (quantity × 100 USD each). */
async function futuresLifetime(
  member: Member,
  contract: Market['btc'],
  leverage: number,
  closedAt: Date,
  legs: FuturesLeg[],
) {
  const position = await db.futuresPosition.create({
    data: {
      tradingAccountId: member.accountId,
      instrumentId: contract.instrumentId,
      direction: 'long',
      marginMode: 'isolated',
      status: 'closed',
      quantity: '0',
      averageEntryPrice: '100',
      entryNotional: '0',
      leverage,
      isolatedMargin: '0',
      closedAt,
    },
  });
  for (const leg of legs) {
    await insertExecution(member, contract, position.id, leverage, leg);
  }
}

/** A position still OPEN at Season end (1 contract at 100 USD) and its open. */
async function openFuturesPosition(
  member: Member,
  contract: Market['btc'],
  leverage: number,
  open: Omit<FuturesLeg, 'operation' | 'quantity' | 'after'>,
) {
  const position = await db.futuresPosition.create({
    data: {
      tradingAccountId: member.accountId,
      instrumentId: contract.instrumentId,
      direction: 'long',
      marginMode: 'isolated',
      status: 'open',
      quantity: '1',
      averageEntryPrice: '100',
      entryNotional: '100',
      leverage,
      isolatedMargin: (100 / leverage).toFixed(8),
      createdAt: open.executedAt,
    },
  });
  await insertExecution(member, contract, position.id, leverage, {
    ...open,
    operation: 'open',
    quantity: '1',
    after: '1',
  } as FuturesLeg);
  return position.id;
}

/**
 * Scenarios about "no USD/KRW evidence was held at t" first prove that this
 * shared database holds none, so a leftover old row reads as a clear
 * precondition failure instead of a confusing assertion later.
 */
async function assertNoUsdKrwEvidenceAt(instant: Date) {
  const held = await findUsdKrwRatesAtOrBefore(db, [instant.toISOString()]);
  assert.equal(
    held.size,
    0,
    `precondition: this database already holds USD/KRW evidence at or before ${instant.toISOString()}`,
  );
}

/** Futures Last received 5 s before endAt: the Season final exit price. */
async function finalExitPrice(contract: Market['btc'], endAt: Date) {
  const last = await db.futuresLastPriceSnapshot.findUniqueOrThrow({
    where: { id: contract.priceId },
  });
  await db.futuresLastPriceSnapshot.create({
    data: {
      instrumentId: contract.instrumentId,
      symbol: last.symbol,
      source: 'binance_usdm_agg_trade_ws',
      price: '110',
      effectiveAt: at(endAt, -5000),
      capturedAt: at(endAt, -5000),
    },
  });
}

/**
 * Every financial and final-result fact of a season's accounts as ONE string of
 * primitives, so "nothing changed" is a string comparison (never a large
 * object in an assertion).
 */
async function financialState(seasonId: string, members: Member[]) {
  const accounts = {
    tradingAccountId: { in: members.map((m) => m.accountId) },
  };
  const [
    positions,
    wallets,
    ledger,
    futuresSettlements,
    futuresCloses,
    finalPrices,
    snapshots,
    participants,
    tradingAccounts,
    finalRows,
    seasonRow,
  ] = await Promise.all([
    db.futuresPosition.findMany({ where: accounts, orderBy: { id: 'asc' } }),
    db.cashWallet.findMany({ where: accounts, orderBy: { id: 'asc' } }),
    db.walletTransaction.count({ where: accounts }),
    db.futuresSeasonSettlement.count({ where: accounts }),
    db.futuresSeasonClose.count({ where: accounts }),
    db.futuresSeasonPrice.count({ where: { seasonId } }),
    db.equitySnapshot.count({ where: accounts }),
    db.seasonParticipant.findMany({
      where: { seasonId },
      orderBy: { id: 'asc' },
    }),
    db.tradingAccount.findMany({
      where: { id: { in: members.map((m) => m.accountId) } },
      orderBy: { id: 'asc' },
    }),
    db.seasonRanking.count({ where: { seasonId } }),
    db.season.findUniqueOrThrow({ where: { id: seasonId } }),
  ]);
  return JSON.stringify({
    positions: positions.map(
      (p) =>
        `${p.id}:${p.status}:${fixed8(p.quantity)}:${fixed8(p.isolatedMargin)}:${fixed8(p.realizedPnl)}:${p.closedAt?.toISOString() ?? '-'}`,
    ),
    wallets: wallets.map(
      (w) =>
        `${w.walletScope}:${w.currencyCode}:${fixed8(w.balanceAmount)}:${fixed8(w.reservedAmount)}`,
    ),
    ledger,
    futuresSettlements,
    futuresCloses,
    finalPrices,
    snapshots,
    participants: participants.map(
      (p) =>
        `${p.participantStatus}:${p.finalQualified}:${p.finalRank}:${p.finalTier}:${p.currentRank}:${fixed8(p.totalAssetKrw)}`,
    ),
    accounts: tradingAccounts.map(
      (a) => `${a.status}:${a.closedAt?.toISOString() ?? '-'}`,
    ),
    finalRows,
    season: seasonRow.status,
  });
}

function settle(seasonId: string, endAt: Date, label: string) {
  const idempotencyKey = `fq:${label}:${seasonId}:${randomUUID()}`;
  created.batchKeys.push(idempotencyKey);
  return settlementJob().run({
    seasonId,
    settlementDate: formatKstRankingDate(endAt),
    idempotencyKey,
    requestedBy: 'season-final-qualification-integration',
  });
}

function assignTiers(seasonId: string, endAt: Date) {
  const idempotencyKey = `fq:tier:${seasonId}:${randomUUID()}`;
  created.batchKeys.push(idempotencyKey);
  return tierJob().run({
    seasonId,
    rankingDate: formatKstRankingDate(endAt),
    idempotencyKey,
  });
}

function resultOf(response: unknown) {
  return (
    response as {
      data: {
        run: {
          status: string;
          resultPayloadJson: {
            reason?: string;
            message?: string;
            finalQualification: {
              applied: boolean;
              evaluated: number;
              qualified: number;
              notQualified: number;
            };
            finalRankings: { created: number };
            finalSnapshots: { created: number; updated: number };
          };
        };
      };
    }
  ).data.run;
}

async function participantState(member: Member) {
  const p = await db.seasonParticipant.findUniqueOrThrow({
    where: { id: member.participantId },
    include: { tradingAccount: true },
  });
  return {
    status: p.participantStatus,
    finalRank: p.finalRank,
    finalTier: p.finalTier,
    currentRank: p.currentRank,
    qualified: p.finalQualified,
    count: p.finalTradedInstrumentCount,
    turnover: fixed8(p.finalRecognizedTurnoverKrw),
    total: fixed8(p.totalAssetKrw),
    account: p.tradingAccount.status,
    accountClosedAt: p.tradingAccount.closedAt?.toISOString() ?? null,
  };
}

async function finalRanks(seasonId: string) {
  const rows = await db.seasonRanking.findMany({
    where: { seasonId, rankType: 'final' },
    orderBy: { rank: 'asc' },
    select: { rank: true, seasonParticipantId: true },
  });
  return rows.map((row) => `${row.seasonParticipantId}:${row.rank}`);
}

async function settlementSnapshotCount(member: Member) {
  return db.equitySnapshot.count({
    where: { tradingAccountId: member.accountId, snapshotReason: 'settlement' },
  });
}

async function dbError(command: Promise<unknown>): Promise<string> {
  try {
    await command;
    return 'NO_ERROR';
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------- scenarios

type Scenario = { name: string; run: () => Promise<Record<string, unknown>> };
const scenarios: Scenario[] = [];
const scenario = (name: string, run: Scenario['run']) =>
  scenarios.push({ name, run });

scenario(
  '1 mixed season: only qualified participants are ranked; everyone is settled',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -20 * DAY);
    const endAt = at(now, -HOUR);
    const season = await createSeason({
      label: 'mixed',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    // Futures as-of FX: R1 is the rate before day 4 even though R2 claims to
    // be effective on day 2 — R2 was only CAPTURED on day 4. R3 is newer but
    // a lower-priority source.
    const R1 = await fx({
      source: KOREA_EXIM,
      rate: '1000',
      effectiveAt: at(startAt, -DAY),
      capturedAt: at(startAt, -DAY),
    });
    const R2 = await fx({
      source: KOREA_EXIM,
      rate: '2000',
      effectiveAt: at(startAt, 2 * DAY),
      capturedAt: at(startAt, 4 * DAY),
    });
    await fx({
      source: EXCHANGE_RATE_API,
      rate: '9999',
      effectiveAt: at(startAt, 2.5 * DAY),
      capturedAt: at(startAt, 2.5 * DAY),
    });
    // The execution-time snapshot a Spot USD fill pins.
    const pinned = await fx({
      source: EXCHANGE_RATE_API,
      rate: '1300',
      effectiveAt: at(startAt, -2 * DAY),
      capturedAt: at(startAt, -2 * DAY),
    });

    const A = await join(season.id, startAt, 'A', '1300000');
    const B = await join(season.id, startAt, 'B', '1200000');
    const C = await join(season.id, startAt, 'C', '1100000');
    const D = await join(season.id, startAt, 'D', '1050000');
    const E = await join(season.id, startAt, 'E', '1400000', {
      status: 'excluded',
    });
    const t = (days: number) => at(startAt, days * DAY);
    const [K1, K2, K3, K4, K5, K6] = market.krx;

    // A: provisional #1 (+30%), 4 instruments, turnover 5.5M → NOT qualified.
    await fill(A, K1, '2000000', t(1));
    await fill(A, K1, '2000000', t(2), { side: 'sell' });
    await fill(A, K2, '100000', t(2));
    await fill(A, K3, '100000', t(3));
    await fill(A, market.usStock, '1000', t(3), {
      currency: 'USD',
      fxId: pinned,
    });

    // B (+20%): 5 instruments, turnover EXACTLY 3,000,000.00000000 → qualified.
    await fill(B, K1, '500000', t(1));
    await fill(B, K1, '400000', t(2), { side: 'sell' });
    await fill(B, K2, '979000', t(2));
    await fill(B, market.usStock, '100', t(2), {
      currency: 'USD',
      fxId: pinned,
    }); // 130,000
    await fill(B, market.crypto, '70', t(2), {
      currency: 'USD',
      scope: 'crypto_spot',
      fxId: pinned,
    }); // 91,000
    // The open predates FX pinning (as-of lookup: R1, since R2 was only
    // captured on day 4); the later legs pinned R2 at execution.
    await futuresLifetime(B, market.btc, 5, t(6), [
      {
        operation: 'open',
        quantity: '15',
        after: '15',
        executedAt: t(3),
        legacy: true,
      }, // 1500/5 × 1000
      {
        operation: 'reduce',
        quantity: '5',
        after: '10',
        executedAt: t(5),
        fxId: R2,
      }, // 500/5 × 2000
      {
        operation: 'close',
        quantity: '10',
        after: '0',
        executedAt: t(6),
        fxId: R2,
      }, // 1000/5 × 2000
    ]);
    // Not fills: a canceled limit order, a fill AT endAt, another season's fill.
    await db.order.create({
      data: {
        tradingAccountId: B.accountId,
        assetId: K4,
        side: 'buy',
        orderType: 'limit',
        status: 'canceled',
        quantity: '1',
        limitPrice: '1000000',
        currencyCode: 'KRW',
        cashWalletScope: 'securities',
        submittedAt: t(4),
        canceledAt: t(4),
        cancelReason: 'user_canceled',
      },
    });
    await fill(B, K5, '9000000', endAt);
    const other = await createSeason({
      label: 'other',
      status: 'settled',
      startAt: at(now, -60 * DAY),
      endAt: at(now, -40 * DAY),
      criteria: true,
    });
    // B's account of another (finished) season: excluded and closed there, so
    // the fixture is itself a consistent settled season for the audit.
    const otherB = await join(other.id, at(now, -60 * DAY), 'B2', '1000000', {
      userId: B.userId,
      status: 'excluded',
    });
    await db.tradingAccount.update({
      where: { id: otherB.accountId },
      data: { status: 'closed', closedAt: at(now, -40 * DAY) },
    });
    await fill(otherB, K6, '9000000', at(now, -50 * DAY));

    // C (+10%): BTC Spot AND BTC Futures plus ETH Futures at 1x/10x → 6.
    await fill(C, K1, '3000000', t(1));
    await fill(C, K2, '10000', t(1));
    await fill(C, K3, '10000', t(1));
    await fill(C, market.btc.assetId, '10', t(2), {
      currency: 'USD',
      scope: 'crypto_spot',
      fxId: pinned,
    }); // 13,000
    await futuresLifetime(C, market.btc, 1, t(8), [
      {
        operation: 'open',
        quantity: '1',
        after: '1',
        executedAt: t(6),
        fxId: R2,
      }, // 100/1 × 2000
    ]);
    await futuresLifetime(C, market.eth, 10, t(8), [
      {
        operation: 'open',
        quantity: '10',
        after: '10',
        executedAt: t(7),
        legacy: true,
      }, // 1000/10 × 2000 (as-of lookup)
    ]);
    // The pin guard: evidence must have been held at execution, a rule
    // season's execution must carry it, and a pin never changes.
    const ethLifetime = await db.futuresPosition.findFirstOrThrow({
      where: {
        tradingAccountId: C.accountId,
        instrumentId: market.eth.instrumentId,
      },
    });
    const probe = {
      operation: 'open' as const,
      quantity: '1',
      after: '1',
      executedAt: t(3),
    };
    const pinGuards = {
      capturedLater: await dbError(
        insertExecution(C, market.eth, ethLifetime.id, 10, {
          ...probe,
          fxId: R2, // captured on day 4
        }),
      ),
      unpinned: await dbError(
        insertExecution(C, market.eth, ethLifetime.id, 10, {
          ...probe,
          fxId: null as unknown as string,
        }),
      ),
      repinned: await dbError(
        db.futuresExecution.updateMany({
          where: { tradingAccountId: C.accountId, fxRateSnapshotId: R2 },
          data: { fxRateSnapshotId: R1 },
        }),
      ),
    };
    assert.match(
      pinGuards.capturedLater,
      /effective and captured at or before the execution/,
    );
    assert.match(pinGuards.unpinned, /requires USD\/KRW evidence/);
    assert.match(pinGuards.repinned, /FX evidence is immutable/);

    // D (+5%): 5 instruments, turnover 0.00000001 short → NOT qualified.
    await fill(D, K1, '1000000', t(1));
    await fill(D, K2, '1000000', t(1));
    await fill(D, K3, '500000', t(1));
    await fill(D, K4, '300000', t(1));
    await fill(D, K5, '199999.99999999', t(1));

    // E: excluded with plenty of trading; never evaluated.
    await fill(E, K1, '9000000', t(1));

    const settled = await outcome(settle(season.id, endAt, 'mixed'));
    assert.equal(okOrCode(settled), 'ok', 'settlement');
    const summary = resultOf(
      (settled as { value: unknown }).value,
    ).resultPayloadJson;
    assert.equal(summary.finalQualification.applied, true);
    assert.equal(summary.finalQualification.evaluated, 4);
    assert.equal(summary.finalQualification.qualified, 2);
    assert.equal(summary.finalQualification.notQualified, 2);
    assert.equal(
      summary.finalSnapshots.created,
      4,
      'snapshot for every valued participant',
    );

    const s = {
      A: await participantState(A),
      B: await participantState(B),
      C: await participantState(C),
      D: await participantState(D),
      E: await participantState(E),
    };
    assert.equal(
      (await finalRanks(season.id)).join(','),
      [`${B.participantId}:1`, `${C.participantId}:2`].join(','),
      'final ranking = qualified only, 1..N',
    );
    // Tier denominator 2: rank 1 master, rank 2 silver.
    assert.equal(`${s.B.finalRank}:${s.B.finalTier}`, '1:master');
    assert.equal(`${s.C.finalRank}:${s.C.finalTier}`, '2:silver');
    assert.equal(
      `${s.B.qualified}:${s.B.count}:${s.B.turnover}`,
      'true:5:3000000.00000000',
    );
    assert.equal(
      `${s.C.qualified}:${s.C.count}:${s.C.turnover}`,
      'true:6:3433000.00000000',
    );
    assert.equal(
      `${s.A.qualified}:${s.A.count}:${s.A.turnover}`,
      'false:4:5500000.00000000',
    );
    assert.equal(
      `${s.D.qualified}:${s.D.count}:${s.D.turnover}`,
      'false:5:2999999.99999999',
    );
    for (const key of ['A', 'D'] as const) {
      assert.equal(
        `${s[key].finalRank}:${s[key].finalTier}:${s[key].currentRank}`,
        'null:null:null',
        `${key} unranked`,
      );
    }
    assert.equal(s.A.total, '1300000.00000000', 'A keeps its final valuation');
    assert.equal(
      s.E.qualified,
      null,
      'excluded participant is never evaluated',
    );
    for (const key of ['A', 'B', 'C', 'D', 'E'] as const) {
      assert.equal(s[key].account, 'closed', `${key} account closed`);
      assert.equal(s[key].accountClosedAt, endAt.toISOString());
    }
    assert.equal(await settlementSnapshotCount(A), 1);
    assert.equal(await settlementSnapshotCount(D), 1);
    assert.equal(await settlementSnapshotCount(E), 0);
    assert.equal(s.A.status, 'finished', 'not qualified is not an exclusion');
    assert.equal(s.E.status, 'excluded');
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: season.id } })).status,
      'settled',
    );

    // ---- reads ----
    const finalA = await ranking.getRanking(A.userId, {
      seasonId: season.id,
      rankType: 'final',
    });
    assert.equal(finalA.data.state, 'available');
    assert.equal(finalA.data.pagination.total, 2);
    assert.equal(finalA.data.rankings.map((r) => r.rank).join(','), '1,2');
    assert.equal(finalA.data.myRanking.state, 'unavailable');
    assert.equal(
      'reason' in finalA.data.myRanking ? finalA.data.myRanking.reason : '',
      'FINAL_RANKING_NOT_QUALIFIED',
    );
    const finalB = await ranking.getRanking(B.userId, {
      seasonId: season.id,
      rankType: 'final',
      scope: 'top10',
    });
    assert.equal(finalB.data.myRanking.state, 'available');
    assert.equal(
      'finalTier' in finalB.data.myRanking
        ? finalB.data.myRanking.finalTier
        : '',
      'master',
    );
    assert.equal(finalB.data.rankings.length, 2);
    // Friends scope keeps its rules: A's accepted friend C is listed.
    const [low, high] = [A.userId, C.userId].sort();
    await db.friendship.create({
      data: {
        lowUserId: low,
        highUserId: high,
        requesterUserId: A.userId,
        status: 'accepted',
      },
    });
    const friendsA = await ranking.getRanking(A.userId, {
      seasonId: season.id,
      rankType: 'final',
      scope: 'friends',
    });
    assert.equal(friendsA.data.rankings.map((r) => r.rank).join(','), '2');
    await db.friendship.deleteMany({
      where: { lowUserId: low, highUserId: high },
    });

    const qA = await ranking.getFinalQualification(A.userId, {
      seasonId: season.id,
    });
    assert.equal(
      `${qA.data.state}:${qA.data.basis}:${qA.data.qualified}`,
      'available:final:false',
    );
    assert.equal(qA.data.tradedInstrumentRequirementMet, false);
    assert.equal(qA.data.turnoverRequirementMet, true);
    assert.equal(qA.data.remainingTradedInstrumentCount, 1);
    assert.equal(
      qA.data.criteria?.minRecognizedTurnoverKrw,
      '3000000.00000000',
    );
    const qB = await ranking.getFinalQualification(B.userId, {
      seasonId: season.id,
    });
    assert.equal(
      `${qB.data.qualified}:${qB.data.recognizedTurnoverKrw}:${qB.data.remainingRecognizedTurnoverKrw}`,
      'true:3000000.00000000:0.00000000',
    );
    const qE = await ranking.getFinalQualification(E.userId, {
      seasonId: season.id,
    });
    assert.equal(
      `${qE.data.state}:${qE.data.reason}`,
      'unavailable:PARTICIPANT_EXCLUDED',
    );

    type SettledView = {
      state: string;
      finalResult?: { state: string; totalAssetKrw?: string; rank?: unknown };
      allocation: { state: string };
      sectionErrors: unknown[];
    };
    const pA = (await portfolio.getPortfolio(A.userId, A.accountId))
      .data as unknown as SettledView;
    assert.equal(
      `${pA.state}:${pA.finalResult?.state}:${pA.finalResult?.totalAssetKrw}:${String(pA.finalResult?.rank)}`,
      'available:not_qualified:1300000.00000000:null',
    );
    assert.equal(pA.allocation.state, 'available');
    assert.equal(pA.sectionErrors.length, 0);
    const pB = (await portfolio.getPortfolio(B.userId, B.accountId))
      .data as unknown as SettledView;
    assert.equal(pB.finalResult?.state, 'available');

    const recordList = await records.getMySeasonRecords(A.userId, {});
    const item = recordList.data.seasons.find(
      (row) => row.seasonId === season.id,
    )!;
    assert.equal(
      `${item.finalQualified}:${item.finalRank}:${item.latestTotalAssetKrw}`,
      'false:null:1300000.00000000',
    );
    const publicA = await records.getUserSeasonRecordSummary(
      B.userId,
      A.userId,
      season.id,
    );
    assert.equal(
      `${publicA.data.summary?.finalQualified}:${publicA.data.summary?.currentRank}:${publicA.data.summary?.totalAssetKrw}`,
      'false:null:1300000.00000000',
    );
    // Current-season summary: a settled non-qualifier gets no provisional
    // daily rank back. Only asserted when this season IS the current one
    // (a shared database may hold another active/upcoming/ended season).
    const otherCurrent = await db.season.count({
      where: { status: { in: ['active', 'upcoming', 'ended'] } },
    });
    let currentSummary = 'skipped: another season is current';
    if (otherCurrent === 0) {
      await db.seasonRanking.create({
        data: {
          seasonId: season.id,
          seasonParticipantId: A.participantId,
          tradingAccountId: A.accountId,
          rankType: 'daily',
          rank: 1,
          totalAssetKrw: '1290000',
          returnRate: '29',
          rankingDate: new Date(
            `${formatKstRankingDate(at(endAt, -DAY))}T00:00:00.000Z`,
          ),
          capturedAt: at(endAt, -DAY),
        },
      });
      const currentA = await records.getUserCurrentSeasonSummary(
        B.userId,
        A.userId,
      );
      assert.equal(currentA.data.season?.id, season.id);
      assert.equal(
        `${currentA.data.season?.rank}:${currentA.data.season?.provisionalTier}:${currentA.data.season?.finalQualified}:${currentA.data.season?.totalAssetKrw}`,
        'null:null:false:1300000.00000000',
        'no daily fallback for a settled non-qualifier',
      );
      await db.seasonRanking.deleteMany({
        where: { seasonId: season.id, rankType: 'daily' },
      });
      currentSummary = 'asserted';
    }

    // ---- replay, tier job ----
    const replay = await outcome(settle(season.id, endAt, 'mixed-replay'));
    assert.equal(okOrCode(replay), 'ok', 'settled replay');
    assert.equal(
      resultOf((replay as { value: unknown }).value).resultPayloadJson
        .finalRankings.created,
      0,
    );
    assert.equal((await finalRanks(season.id)).length, 2);
    assert.equal(
      (await participantState(A)).turnover,
      '5500000.00000000',
      'verdict unchanged',
    );
    const tiers = await outcome(assignTiers(season.id, endAt));
    assert.equal(
      okOrCode(tiers),
      'ok',
      'tier job on settled eligibility season',
    );

    // ---- bypasses ----
    const correctA = await outcome(
      moderation.correctFinalResult(operator, season.id, A.participantId, {
        finalRank: 3,
        reason: 'fq',
      }),
    );
    assert.equal(okOrCode(correctA), 'FINAL_RANKING_QUALIFICATION_REQUIRED');
    assert.equal((await participantState(A)).finalRank, null);
    assert.equal(
      (await finalRanks(season.id)).length,
      2,
      'no row created by a refused correction',
    );
    const correctB = await outcome(
      moderation.correctFinalResult(operator, season.id, B.participantId, {
        finalTier: 'master',
        reason: 'fq',
      }),
    );
    assert.equal(
      okOrCode(correctB),
      'ok',
      'a qualified participant can still be corrected',
    );

    const code = `FQ_${RUN}_MASTER`;
    created.badgeCodes.push(code);
    const rewardA = await outcome(
      rewards.createFulfillment(operator, {
        seasonId: season.id,
        seasonParticipantId: A.participantId,
        rewardType: 'badge',
        rewardCode: code,
        rewardName: 'fq master',
        idempotencyKey: `fq-${randomUUID()}`,
      }),
    );
    assert.equal(okOrCode(rewardA), 'REWARD_QUALIFICATION_REQUIRED');
    const rewardB = await rewards.createFulfillment(operator, {
      seasonId: season.id,
      seasonParticipantId: B.participantId,
      rewardType: 'badge',
      rewardCode: code,
      rewardName: 'fq master',
      idempotencyKey: `fq-${randomUUID()}`,
    });
    const fulfilled = await rewards.fulfill(
      operator,
      rewardB.data.fulfillment.id,
      { reason: 'fq' },
    );
    assert.equal(fulfilled.data.fulfillment.status, 'fulfilled');

    // ---- database guards ----
    const rankUnqualified = await dbError(
      db.seasonParticipant.update({
        where: { id: A.participantId },
        data: { finalRank: 3, finalTier: 'bronze' },
      }),
    );
    assert.match(
      rankUnqualified,
      /season_participants_unqualified_unranked_check/,
    );
    const halfEvidence = await dbError(
      db.seasonParticipant.update({
        where: { id: A.participantId },
        data: { finalTradedInstrumentCount: null },
      }),
    );
    assert.match(halfEvidence, /season_participants_final_qualification_check/);
    const ruleChange = await dbError(
      db.season.update({
        where: { id: season.id },
        data: { finalRankingMinTurnoverRatio: '1' },
      }),
    );
    assert.match(ruleChange, /fixed once the season has left upcoming/);

    return { s, final: await finalRanks(season.id), currentSummary };
  },
);

scenario(
  '2 nobody qualifies: settled with an empty final ranking, replay is idempotent',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -2 * HOUR);
    const season = await createSeason({
      label: 'zero',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    const A = await join(season.id, startAt, 'Z1', '1100000');
    const B = await join(season.id, startAt, 'Z2', '900000');
    await fill(A, market.krx[0], '100000', at(startAt, DAY));

    const settled = await outcome(settle(season.id, endAt, 'zero'));
    assert.equal(okOrCode(settled), 'ok');
    const summary = resultOf(
      (settled as { value: unknown }).value,
    ).resultPayloadJson;
    assert.equal(
      `${summary.finalQualification.qualified}:${summary.finalQualification.notQualified}`,
      '0:2',
    );
    assert.equal((await finalRanks(season.id)).length, 0);
    const a = await participantState(A);
    const b = await participantState(B);
    assert.equal(
      `${a.qualified}:${a.count}:${a.turnover}`,
      'false:1:100000.00000000',
    );
    assert.equal(
      `${b.qualified}:${b.count}:${b.turnover}`,
      'false:0:0.00000000',
    );
    assert.equal(`${a.account}:${b.account}`, 'closed:closed');
    assert.equal(`${a.status}:${b.status}`, 'finished:finished');
    assert.equal(await settlementSnapshotCount(A), 1);
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: season.id } })).status,
      'settled',
    );

    const read = await ranking.getRanking(A.userId, {
      seasonId: season.id,
      rankType: 'final',
    });
    assert.equal(
      `${read.data.state}:${read.data.reason}`,
      'unavailable:NO_QUALIFIED_PARTICIPANTS',
    );
    assert.equal(
      'reason' in read.data.myRanking ? read.data.myRanking.reason : '',
      'FINAL_RANKING_NOT_QUALIFIED',
    );
    const tiers = await outcome(assignTiers(season.id, endAt));
    assert.equal(okOrCode(tiers), 'ok');
    assert.equal(
      (
        tiers as {
          value: { data: { run: { resultPayloadJson: { reason?: string } } } };
        }
      ).value.data.run.resultPayloadJson.reason,
      'NO_QUALIFIED_PARTICIPANTS',
    );
    const replay = await outcome(settle(season.id, endAt, 'zero-replay'));
    assert.equal(okOrCode(replay), 'ok', 'empty confirmed result replays');
    assert.equal((await finalRanks(season.id)).length, 0);

    // Damage is still damage: an eligible participant without a verdict.
    await db.seasonParticipant.update({
      where: { id: B.participantId },
      data: {
        finalQualified: null,
        finalTradedInstrumentCount: null,
        finalRecognizedTurnoverKrw: null,
      },
    });
    const damaged = await outcome(settle(season.id, endAt, 'zero-damaged'));
    assert.equal(okOrCode(damaged), 'FINAL_RESULTS_INTEGRITY');
    // The public reader applies the same criteria: never "nobody qualified".
    for (const scope of ['all', 'friends', 'top10']) {
      assert.equal(
        okOrCode(
          await outcome(
            ranking.getRanking(A.userId, {
              seasonId: season.id,
              rankType: 'final',
              scope,
            }),
          ),
        ),
        'FINAL_RESULTS_INTEGRITY',
        `damaged empty result on ${scope}`,
      );
    }
    const audit = (await auditRankingAndSettlement(db)).map(
      (finding) => finding.code,
    );
    assert.ok(
      audit.includes('SETTLED_SEASON_FINAL_QUALIFICATION_MISSING'),
      'audit sees the missing verdict',
    );
    await db.seasonParticipant.update({
      where: { id: B.participantId },
      data: {
        finalQualified: false,
        finalTradedInstrumentCount: 0,
        finalRecognizedTurnoverKrw: '0',
      },
    });
    return { a, b, replay: okOrCode(replay), damaged: okOrCode(damaged) };
  },
);

scenario(
  '3 one qualifier: ranked 1 with the existing single-participant tier',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -3 * HOUR);
    const season = await createSeason({
      label: 'one',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    const top = await join(season.id, startAt, 'O1', '1500000');
    const winner = await join(season.id, startAt, 'O2', '800000');
    for (const [index, asset] of market.krx.slice(0, 5).entries()) {
      await fill(
        winner,
        asset,
        index === 0 ? '2600000' : '100000',
        at(startAt, DAY),
      );
    }
    await fill(top, market.krx[0], '100000', at(startAt, DAY));

    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'one'))),
      'ok',
    );
    const w = await participantState(winner);
    const t = await participantState(top);
    assert.equal(
      `${w.finalRank}:${w.finalTier}:${w.qualified}`,
      '1:master:true',
      'loss-making qualifier is #1',
    );
    assert.equal(
      `${t.finalRank}:${t.qualified}`,
      'null:false',
      'top return without activity is unranked',
    );
    return { w, t };
  },
);

scenario(
  '4 legacy Futures execution without FX evidence held at execution: fails closed, then settles once evidence exists',
  async () => {
    // An execution committed BEFORE executions pinned their FX: priced by the
    // as-of lookup. New executions can no longer be committed like this
    // (scenario 13), which is why the late row below cannot re-price them.
    const startAt = new Date('2020-01-01T00:00:00.000Z');
    const endAt = new Date('2020-01-31T00:00:00.000Z');
    const season = await createSeason({
      label: 'fx-missing',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(new Date('2020-01-02T00:00:00.000Z'));
    const member = await join(season.id, startAt, 'X1', '1000000');
    const executedAt = new Date('2020-01-10T00:00:00.000Z');
    await futuresLifetime(
      member,
      market.btc,
      2,
      new Date('2020-01-11T00:00:00.000Z'),
      [
        {
          operation: 'open',
          quantity: '1',
          after: '1',
          executedAt,
          legacy: true,
        },
      ],
    );
    // Effective before the execution but only captured after it: not evidence
    // the system held at execution time.
    await fx({
      source: KOREA_EXIM,
      rate: '1200',
      effectiveAt: new Date('2020-01-05T00:00:00.000Z'),
      capturedAt: new Date('2020-01-15T00:00:00.000Z'),
    });

    await assertNoUsdKrwEvidenceAt(executedAt);
    const failed = await outcome(settle(season.id, endAt, 'fx-missing'));
    assert.equal(okOrCode(failed), 'RANKING_QUALIFICATION_FX_EVIDENCE_MISSING');
    const after = await participantState(member);
    assert.equal(
      `${after.qualified}:${after.account}`,
      'null:active',
      'nothing written',
    );
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: season.id } })).status,
      'ended',
    );
    assert.equal(await settlementSnapshotCount(member), 0);

    await fx({
      source: KOREA_EXIM,
      rate: '1100',
      effectiveAt: new Date('2019-12-31T00:00:00.000Z'),
      capturedAt: new Date('2019-12-31T00:00:00.000Z'),
    });
    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'fx-retry'))),
      'ok',
    );
    const settled = await participantState(member);
    // 100 USD notional ÷ 2 × 1100 (the evidence held at execution time).
    assert.equal(
      `${settled.qualified}:${settled.count}:${settled.turnover}`,
      'false:1:55000.00000000',
    );
    return { failed: okOrCode(failed), settled };
  },
);

scenario(
  '5 Spot FX evidence mismatch: fails closed with nothing written',
  async () => {
    const startAt = new Date('2021-01-01T00:00:00.000Z');
    const endAt = new Date('2021-01-31T00:00:00.000Z');
    const season = await createSeason({
      label: 'fx-mismatch',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(new Date('2021-01-02T00:00:00.000Z'));
    const member = await join(season.id, startAt, 'M1', '1000000');
    const wrongPair = await fx({
      source: EXCHANGE_RATE_API,
      rate: '0.00075',
      base: 'KRW',
      effectiveAt: new Date('2021-01-03T00:00:00.000Z'),
      capturedAt: new Date('2021-01-03T00:00:00.000Z'),
    });
    await fill(
      member,
      market.usStock,
      '100',
      new Date('2021-01-04T00:00:00.000Z'),
      {
        currency: 'USD',
        fxId: wrongPair,
      },
    );
    const failed = await outcome(settle(season.id, endAt, 'fx-mismatch'));
    assert.equal(
      okOrCode(failed),
      'RANKING_QUALIFICATION_FX_EVIDENCE_MISMATCH',
    );
    const after = await participantState(member);
    assert.equal(
      `${after.qualified}:${after.account}:${after.finalRank}`,
      'null:active:null',
    );
    return { failed: okOrCode(failed) };
  },
);

scenario(
  '6 active season: provisional eligibility reads, states, and the frozen rule',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -2 * DAY);
    const endAt = at(now, 5 * DAY);
    const season = await createSeason({
      label: 'active',
      status: 'active',
      startAt,
      endAt,
      criteria: true,
    });
    const legacy = await createSeason({
      label: 'legacy-active',
      status: 'active',
      startAt,
      endAt,
      criteria: false,
    });
    const market = await createMarket(at(startAt, HOUR));
    const busy = await join(season.id, startAt, 'P1', '1000000');
    const quiet = await join(season.id, startAt, 'P2', '1000000');
    const gone = await join(season.id, startAt, 'P3', '1000000', {
      status: 'excluded',
    });
    const outsider = await createUser('P4');
    const legacyMember = await join(legacy.id, startAt, 'P5', '1000000');
    for (const asset of market.krx.slice(0, 5)) {
      await fill(busy, asset, '700000', at(startAt, HOUR * 2));
    }
    await fill(quiet, market.krx[0], '1000000', at(startAt, HOUR * 2));

    const qBusy = await ranking.getFinalQualification(busy.userId, {
      seasonId: season.id,
    });
    assert.equal(
      `${qBusy.data.state}:${qBusy.data.basis}:${qBusy.data.qualified}:${qBusy.data.recognizedTurnoverKrw}`,
      'available:provisional:true:3500000.00000000',
    );
    const qQuiet = await ranking.getFinalQualification(quiet.userId, {
      seasonId: season.id,
    });
    assert.equal(
      `${qQuiet.data.qualified}:${qQuiet.data.remainingTradedInstrumentCount}:${qQuiet.data.remainingRecognizedTurnoverKrw}`,
      'false:4:2000000.00000000',
    );
    assert.equal(
      (
        await ranking.getFinalQualification(gone.userId, {
          seasonId: season.id,
        })
      ).data.reason,
      'PARTICIPANT_EXCLUDED',
    );
    assert.equal(
      (
        await ranking.getFinalQualification(outsider.id, {
          seasonId: season.id,
        })
      ).data.state,
      'not_joined',
    );
    assert.equal(
      (
        await ranking.getFinalQualification(legacyMember.userId, {
          seasonId: legacy.id,
        })
      ).data.state,
      'not_applicable',
    );
    // A provisional read writes nothing.
    assert.equal((await participantState(quiet)).qualified, null);

    // The rule is fixed once the season has started; an upcoming season may
    // still set it; a half rule is rejected.
    assert.match(
      await dbError(
        db.season.update({
          where: { id: season.id },
          data: { finalRankingMinTradedInstruments: 1 },
        }),
      ),
      /fixed once the season has left upcoming/,
    );
    assert.match(
      await dbError(
        db.season.update({
          where: { id: legacy.id },
          data: {
            finalRankingMinTradedInstruments: 5,
            finalRankingMinTurnoverRatio: '3',
          },
        }),
      ),
      /fixed once the season has left upcoming/,
      'the rule can never be added to a running season retroactively',
    );
    const upcoming = await createSeason({
      label: 'upcoming',
      status: 'upcoming',
      startAt: at(now, 30 * DAY),
      endAt: at(now, 51 * DAY),
      criteria: false,
    });
    assert.equal(
      await dbError(
        db.season.update({
          where: { id: upcoming.id },
          data: {
            finalRankingMinTradedInstruments: 5,
            finalRankingMinTurnoverRatio: '3',
          },
        }),
      ),
      'NO_ERROR',
    );
    assert.match(
      await dbError(
        db.season.create({
          data: {
            name: `fq-half-${RUN}`,
            status: 'upcoming',
            startAt: at(now, 30 * DAY),
            endAt: at(now, 51 * DAY),
            initialCapitalKrw: CAPITAL,
            tradeFeeRate: '0.001',
            fxFeeRate: '0.001',
            finalRankingMinTradedInstruments: 5,
          },
        }),
      ),
      /seasons_final_ranking_eligibility_check/,
    );
    return { busy: qBusy.data.qualified, quiet: qQuiet.data.qualified };
  },
);

scenario(
  '7 exclusion commits after eligibility was judged: no stale verdict is published',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -4 * HOUR);
    const season = await createSeason({
      label: 'race',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    const A = await join(season.id, startAt, 'R1', '1200000');
    const B = await join(season.id, startAt, 'R2', '1100000');
    for (const member of [A, B]) {
      for (const asset of market.krx.slice(0, 5)) {
        await fill(member, asset, '700000', at(startAt, DAY));
      }
    }
    const job = settlementJob();
    const host = job as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = host.evaluateFinalQualifications;
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const released = new Promise<void>((r) => (release = r));
    host.evaluateFinalQualifications = async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const verdicts: unknown = await original.call(this, ...args);
      reach();
      await released;
      return verdicts;
    };
    const key = `fq:race:${season.id}:${randomUUID()}`;
    created.batchKeys.push(key);
    const running = outcome(
      job.run({
        seasonId: season.id,
        settlementDate: formatKstRankingDate(endAt),
        idempotencyKey: key,
      }),
    );
    await reached;
    const excluded = await outcome(
      moderation.excludeParticipant(operator, season.id, B.participantId, {
        reason: 'fq race',
      }),
    );
    release();
    const raced = await running;
    assert.equal(okOrCode(excluded), 'ok');
    assert.equal(okOrCode(raced), 'SETTLEMENT_PARTICIPANTS_CHANGED');
    assert.equal(
      `${(await participantState(A)).qualified}:${(await participantState(B)).qualified}`,
      'null:null',
      'nothing written',
    );
    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'race-retry'))),
      'ok',
    );
    const a = await participantState(A);
    const b = await participantState(B);
    assert.equal(`${a.finalRank}:${a.qualified}`, '1:true');
    assert.equal(
      `${b.status}:${b.qualified}:${b.account}`,
      'excluded:null:closed',
    );
    return { raced: okOrCode(raced), a, b };
  },
);

scenario(
  '8 concurrent settlement runs leave exactly one confirmed result',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -5 * HOUR);
    const season = await createSeason({
      label: 'concurrent',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    const A = await join(season.id, startAt, 'C1', '1200000');
    const B = await join(season.id, startAt, 'C2', '1100000');
    for (const asset of market.krx.slice(0, 5)) {
      await fill(A, asset, '700000', at(startAt, DAY));
    }
    const runs = await Promise.all([
      outcome(settle(season.id, endAt, 'concurrent-1')),
      outcome(settle(season.id, endAt, 'concurrent-2')),
    ]);
    const codes = runs.map(okOrCode).sort().join(',');
    assert.ok(
      ['ok,ok', 'SEASON_NOT_ENDED,ok'].includes(codes),
      `outcomes ${codes}`,
    );
    assert.equal((await finalRanks(season.id)).length, 1);
    assert.equal(await settlementSnapshotCount(A), 1);
    assert.equal(await settlementSnapshotCount(B), 1);
    assert.equal(
      `${(await participantState(A)).finalRank}:${(await participantState(B)).qualified}`,
      '1:false',
    );
    return { codes };
  },
);

scenario(
  '9 a season without a rule is untouched: everyone is ranked, nothing is evaluated',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -6 * HOUR);
    const season = await createSeason({
      label: 'legacy',
      status: 'ended',
      startAt,
      endAt,
      criteria: false,
    });
    const A = await join(season.id, startAt, 'L1', '1200000');
    const B = await join(season.id, startAt, 'L2', '1100000');
    const settled = await outcome(settle(season.id, endAt, 'legacy'));
    assert.equal(okOrCode(settled), 'ok');
    assert.equal(
      resultOf((settled as { value: unknown }).value).resultPayloadJson
        .finalQualification.applied,
      false,
    );
    const a = await participantState(A);
    const b = await participantState(B);
    assert.equal(
      `${a.finalRank}:${a.finalTier}:${a.qualified}`,
      '1:master:null',
    );
    assert.equal(
      `${b.finalRank}:${b.finalTier}:${b.qualified}`,
      '2:silver:null',
    );
    // Readers of a season without a rule are unchanged too.
    const read = await ranking.getRanking(A.userId, {
      seasonId: season.id,
      rankType: 'final',
    });
    assert.equal(
      `${read.data.state}:${read.data.rankings.map((r) => r.rank).join(',')}`,
      'available:1,2',
    );
    return { a, b };
  },
);

scenario(
  '10 a final row written before settlement (bypass) is refused, and corrections cannot create one',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -7 * HOUR);
    const season = await createSeason({
      label: 'bypass',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const A = await join(season.id, startAt, 'Y1', '1200000');
    const correction = await outcome(
      moderation.correctFinalResult(operator, season.id, A.participantId, {
        finalRank: 1,
        reason: 'fq',
      }),
    );
    assert.equal(okOrCode(correction), 'FINAL_RANKING_QUALIFICATION_REQUIRED');
    await db.seasonRanking.create({
      data: {
        seasonId: season.id,
        seasonParticipantId: A.participantId,
        tradingAccountId: A.accountId,
        rankType: 'final',
        rank: 1,
        totalAssetKrw: '1200000',
        returnRate: '20',
        rankingDate: new Date(`${formatKstRankingDate(endAt)}T00:00:00.000Z`),
        capturedAt: endAt,
      },
    });
    const refused = await outcome(settle(season.id, endAt, 'bypass'));
    assert.equal(okOrCode(refused), 'FINAL_RESULTS_INTEGRITY');
    assert.equal(
      `${(await participantState(A)).qualified}:${(await participantState(A)).account}`,
      'null:active',
    );
    await db.seasonRanking.deleteMany({ where: { seasonId: season.id } });
    return { correction: okOrCode(correction), refused: okOrCode(refused) };
  },
);

scenario(
  '11 ranking audit: legitimate non-qualifiers are clean, an injected final row is damage',
  async () => {
    const first = (await auditRankingAndSettlement(db)).map(
      (finding) => finding.code,
    );
    const noise = [
      'ELIGIBLE_PARTICIPANT_FINAL_RANKING_MISSING',
      'UNQUALIFIED_PARTICIPANT_HAS_FINAL_RANKING',
      'SETTLED_SEASON_FINAL_QUALIFICATION_MISSING',
    ];
    assert.equal(
      first.filter((code) => noise.includes(code)).join(','),
      '',
      'no eligibility findings on a consistent DB',
    );
    const unqualified = await db.seasonParticipant.findFirstOrThrow({
      where: { seasonId: { in: created.seasons }, finalQualified: false },
      include: { season: true },
    });
    const injected = await db.seasonRanking.create({
      data: {
        seasonId: unqualified.seasonId,
        seasonParticipantId: unqualified.id,
        tradingAccountId: unqualified.tradingAccountId,
        rankType: 'final',
        rank: 999,
        totalAssetKrw: unqualified.totalAssetKrw,
        returnRate: unqualified.totalReturnRate,
        rankingDate: new Date(
          `${formatKstRankingDate(unqualified.season.endAt)}T00:00:00.000Z`,
        ),
        capturedAt: unqualified.season.endAt,
      },
    });
    const second = (await auditRankingAndSettlement(db)).map(
      (finding) => finding.code,
    );
    await db.seasonRanking.delete({ where: { id: injected.id } });
    assert.ok(second.includes('UNQUALIFIED_PARTICIPANT_HAS_FINAL_RANKING'));
    return { first, second };
  },
);

scenario(
  '12 missing FX evidence with open Futures positions: nothing financial moves until the evidence is valid',
  async () => {
    const startAt = new Date('2018-06-01T00:00:00.000Z');
    const endAt = new Date('2018-06-22T00:00:00.000Z');
    const season = await createSeason({
      label: 'partial',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(new Date('2018-06-01T12:00:00.000Z'));
    await finalExitPrice(market.btc, endAt);
    await finalExitPrice(market.eth, endAt);
    const A = await join(season.id, startAt, 'PA', '1000000', {
      futuresUsd: '200',
    });
    const B = await join(season.id, startAt, 'PB', '1000000', {
      futuresUsd: '200',
    });
    // B's open pinned the rate held at its execution; A's open predates
    // pinning and NO USD/KRW was held at its execution time.
    const heldForB = await fx({
      source: KOREA_EXIM,
      rate: '1200',
      effectiveAt: new Date('2018-06-02T12:00:00.000Z'),
      capturedAt: new Date('2018-06-02T12:00:00.000Z'),
    });
    await openFuturesPosition(A, market.btc, 2, {
      executedAt: new Date('2018-06-02T00:00:00.000Z'),
      legacy: true,
    });
    await openFuturesPosition(B, market.eth, 4, {
      executedAt: new Date('2018-06-03T00:00:00.000Z'),
      fxId: heldForB,
    });
    await assertNoUsdKrwEvidenceAt(new Date('2018-06-02T00:00:00.000Z'));
    const before = await financialState(season.id, [A, B]);
    const firstKey = created.batchKeys.length;

    const dryKey = `fq:partial-dry:${season.id}:${randomUUID()}`;
    created.batchKeys.push(dryKey);
    const dry = await outcome(
      settlementJob().run({
        seasonId: season.id,
        settlementDate: formatKstRankingDate(endAt),
        dryRun: true,
        idempotencyKey: dryKey,
      }),
    );
    const failed = await outcome(settle(season.id, endAt, 'partial'));
    const retried = await outcome(settle(season.id, endAt, 'partial-retry'));
    for (const run of [dry, failed, retried]) {
      assert.equal(okOrCode(run), 'RANKING_QUALIFICATION_FX_EVIDENCE_MISSING');
    }
    assert.equal(
      await financialState(season.id, [A, B]),
      before,
      'no Futures exit, price pin, wallet, ledger, snapshot, verdict, rank, account or status change',
    );
    // What a failed run may leave behind: its job history, nothing financial.
    assert.equal(
      await db.batchJobRun.count({
        where: {
          idempotencyKey: { in: created.batchKeys.slice(firstKey) },
          status: 'failed',
        },
      }),
      3,
    );

    // The evidence the system held at A's execution becomes readable (as an
    // in-flight ingestion row stamped earlier would). Two runs race.
    await fx({
      source: KOREA_EXIM,
      rate: '1100',
      effectiveAt: new Date('2018-06-01T00:00:00.000Z'),
      capturedAt: new Date('2018-06-01T00:00:00.000Z'),
    });
    const runs = await Promise.all([
      outcome(settle(season.id, endAt, 'partial-race-1')),
      outcome(settle(season.id, endAt, 'partial-race-2')),
    ]);
    const codes = runs.map(okOrCode).sort().join(',');
    assert.ok(
      ['ok,ok', 'SEASON_NOT_ENDED,ok'].includes(codes),
      `outcomes ${codes}`,
    );
    const exits = await db.futuresSeasonSettlement.groupBy({
      by: ['tradingAccountId'],
      where: { seasonId: season.id },
      _count: { _all: true },
    });
    assert.equal(
      exits.map((row) => row._count._all).join(','),
      '1,1',
      'each account exits exactly once',
    );
    const settledState = await financialState(season.id, [A, B]);
    const a = await participantState(A);
    const b = await participantState(B);
    // A: 100 ÷ 2 × 1100; B: 100 ÷ 4 × 1200 (its pin). One instrument each.
    assert.equal(
      `${a.qualified}:${a.count}:${a.turnover}`,
      'false:1:55000.00000000',
    );
    assert.equal(
      `${b.qualified}:${b.count}:${b.turnover}`,
      'false:1:30000.00000000',
    );
    assert.equal(`${a.account}:${b.account}`, 'closed:closed');
    assert.equal(
      await db.futuresPosition.count({
        where: {
          tradingAccountId: { in: [A.accountId, B.accountId] },
          status: 'open',
        },
      }),
      0,
    );
    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'partial-replay'))),
      'ok',
    );
    assert.equal(
      await financialState(season.id, [A, B]),
      settledState,
      'a replay moves nothing',
    );
    return { failed: okOrCode(failed), codes, a, b };
  },
);

/**
 * A Futures contract the real execution path accepts for a NEW position: an
 * offered symbol with a verified contract. Reuses an asset another suite left,
 * but only ever creates (and later removes) its own instrument.
 */
async function offeredContract() {
  // From the end of the catalog: the leading symbols (BTCUSDT, ETHUSDT, …) are
  // what other suites in the same CI database create for themselves.
  for (const symbol of [...BINANCE_FUTURES_SYMBOLS].reverse()) {
    const asset = await db.asset.findUnique({
      where: { market_symbol: { market: 'BINANCE', symbol } },
    });
    // An existing asset is reused only if a contract on it can verify.
    if (
      asset &&
      (!asset.isActive ||
        asset.assetType !== 'crypto' ||
        asset.currencyCode !== 'USD' ||
        asset.priceCurrency !== 'USD' ||
        asset.settlementCurrency !== 'USD' ||
        (await db.futuresInstrument.count({
          where: { underlyingAssetId: asset.id },
        })) > 0)
    )
      continue;
    const underlying =
      asset ??
      (await db.asset.create({
        data: {
          symbol,
          name: `fq ${symbol}`,
          market: 'BINANCE',
          assetType: 'crypto',
          currencyCode: 'USD',
          priceCurrency: 'USD',
          settlementCurrency: 'USD',
          isActive: true,
        },
      }));
    if (!asset) created.assets.push(underlying.id);
    const instrument = await db.futuresInstrument.create({
      data: {
        underlyingAssetId: underlying.id,
        markVerifiedAt: at(await dbNow(), -60_000),
        markContractJson: {
          symbol,
          pair: symbol,
          baseAsset: symbol.slice(0, -4),
          contractType: 'PERPETUAL',
          status: 'TRADING',
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          underlyingType: 'COIN',
        },
      },
    });
    created.instruments.push(instrument.id);
    return { symbol, instrumentId: instrument.id };
  }
  throw new Error(
    'Every offered Futures symbol already has an instrument in this database.',
  );
}

/** Futures Last and Mark observed 1 s ago (the F1 fixture convention). */
async function freshFuturesPrices(contract: {
  symbol: string;
  instrumentId: string;
}) {
  const observed = at(await dbNow(), -1000);
  for (let shift = 0; shift < 5; shift += 1) {
    const stamp = at(observed, -shift);
    try {
      await db.futuresLastPriceSnapshot.create({
        data: {
          instrumentId: contract.instrumentId,
          symbol: contract.symbol,
          source: 'binance_usdm_agg_trade_ws',
          price: '100',
          effectiveAt: stamp,
          capturedAt: stamp,
        },
      });
      await db.futuresMarkSnapshot.create({
        data: {
          instrumentId: contract.instrumentId,
          symbol: contract.symbol,
          source: 'binance_usdm_mark_ws',
          price: '100',
          effectiveAt: stamp,
          capturedAt: stamp,
        },
      });
      return;
    } catch (error) {
      if (!String(error).includes('Unique constraint')) throw error;
    }
  }
}

type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/** A member read through a Proxy; a method is still called on its owner. */
function boundTo(owner: object, value: unknown): unknown {
  return typeof value === 'function'
    ? (...args: unknown[]): unknown =>
        Reflect.apply(value as (...a: unknown[]) => unknown, owner, args)
    : value;
}

/** The real client, except that every interactive transaction hands
 * `wrap(tx)` to its work: a fault injected inside real PostgreSQL work. */
function wrapTransactions(
  wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient,
): PrismaService {
  return new Proxy(db, {
    get(target, key) {
      if (key !== '$transaction')
        return boundTo(target, Reflect.get(target, key));
      return (work: unknown, options?: TransactionOptions) =>
        typeof work === 'function'
          ? target.$transaction(
              (tx) =>
                (
                  work as (client: Prisma.TransactionClient) => Promise<unknown>
                )(wrap(tx)),
              options,
            )
          : target.$transaction(
              work as Prisma.PrismaPromise<unknown>[],
              options,
            );
    },
  });
}

/** Inside transactions every USD/KRW lookup finds nothing: "no evidence
 * held" without touching shared FX rows. */
const withoutFxEvidence = () =>
  wrapTransactions(
    (tx) =>
      new Proxy(tx, {
        get(client, prop) {
          const value: unknown = Reflect.get(client, prop);
          if (prop === '$queryRaw') {
            const query = value as (
              strings: TemplateStringsArray,
              ...values: unknown[]
            ) => Promise<unknown>;
            return (strings: TemplateStringsArray, ...values: unknown[]) =>
              strings.join('').includes('fx_rate_snapshots')
                ? Promise.resolve([])
                : Reflect.apply(query, client, [strings, ...values]);
          }
          return boundTo(client, value);
        },
      }),
  );

scenario(
  '13 a real Futures execution in a rule season pins its USD/KRW; without evidence it commits nothing',
  async () => {
    const now = await dbNow();
    const season = await createSeason({
      label: 'pin',
      status: 'active',
      startAt: at(now, -DAY),
      endAt: at(now, 5 * DAY),
      criteria: true,
    });
    const plain = await createSeason({
      label: 'pin-plain',
      status: 'active',
      startAt: at(now, -DAY),
      endAt: at(now, 5 * DAY),
      criteria: false,
    });
    const contract = await offeredContract();
    const M = await join(season.id, at(now, -DAY), 'N1', '1000000', {
      futuresUsd: '1000',
    });
    const P = await join(plain.id, at(now, -DAY), 'N2', '1000000', {
      futuresUsd: '1000',
    });
    await fx({
      source: KOREA_EXIM,
      rate: '1350',
      effectiveAt: at(now, -10_000),
      capturedAt: at(now, -10_000),
    });
    const futures = futuresFor(db);
    const command = (operation: 'open' | 'close', positionId?: string) => ({
      instrumentId: contract.instrumentId,
      operation,
      marginMode: 'isolated',
      direction: 'long',
      quantity: '1',
      leverage: 5,
      idempotencyKey: randomUUID(),
      ...(positionId ? { positionId } : {}),
    });
    const ruleOf = async (executionId: string) => {
      const row = await db.futuresExecution.findUniqueOrThrow({
        where: { id: executionId },
        include: { fxRateSnapshot: true },
      });
      const instant = row.executedAt.toISOString();
      const asOf = (await findUsdKrwRatesAtOrBefore(db, [instant])).get(
        instant,
      );
      return { row, asOf };
    };

    // Open: the pin is the settlement rule's evidence at executedAt.
    await freshFuturesPrices(contract);
    const openBody = command('open');
    const opened = await futures.execute(M.userId, M.accountId, openBody);
    const open = await ruleOf(opened.data.execution.id);
    assert.ok(open.row.fxRateSnapshot, 'pinned in a rule season');
    assert.equal(open.row.fxRateSnapshotId, open.asOf?.snapshotId);
    const openKrw = open.row.notional
      .div(open.row.leverage)
      .mul(open.row.fxRateSnapshot.rate);
    const progress = async () =>
      (await ranking.getFinalQualification(M.userId, { seasonId: season.id }))
        .data.recognizedTurnoverKrw;
    assert.equal(await progress(), openKrw.toFixed(8));

    // A row committed later but stamped before the execution changes what an
    // as-of lookup returns — and does not re-price the pinned execution.
    const late = await fx({
      source: KOREA_EXIM,
      rate: '1400',
      effectiveAt: at(open.row.executedAt, -1),
      capturedAt: at(open.row.executedAt, -1),
    });
    const relookup = (
      await findUsdKrwRatesAtOrBefore(db, [open.row.executedAt.toISOString()])
    ).get(open.row.executedAt.toISOString());
    assert.equal(relookup?.snapshotId, late, 'the as-of lookup moved');
    assert.equal(await progress(), openKrw.toFixed(8), 'turnover did not');
    // Instants are UTC: a session in another time zone selects the same row.
    const instant = open.row.executedAt.toISOString();
    const seoulLookup = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Seoul'`);
      return (await findUsdKrwRatesAtOrBefore(tx, [instant])).get(instant);
    });
    assert.equal(seoulLookup?.snapshotId, late, 'time-zone independent');

    // Retrying the same command replays it: still one execution.
    const replayed = await futures.execute(M.userId, M.accountId, openBody);
    assert.equal(replayed.data.execution.id, opened.data.execution.id);
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: M.accountId },
      }),
      1,
    );

    // Close pins the evidence held at ITS execution.
    await freshFuturesPrices(contract);
    const closed = await futures.execute(
      M.userId,
      M.accountId,
      command('close', opened.data.position.id),
    );
    const close = await ruleOf(closed.data.execution.id);
    assert.equal(close.row.fxRateSnapshotId, close.asOf?.snapshotId);

    // No evidence held: refused before any write, nothing changes.
    await freshFuturesPrices(contract);
    const stateBefore = await financialState(season.id, [M]);
    const requestsBefore = await db.futuresExecuteRequest.count({
      where: { tradingAccountId: M.accountId },
    });
    const refused = await outcome(
      futuresFor(withoutFxEvidence()).execute(
        M.userId,
        M.accountId,
        command('open'),
      ),
    );
    assert.equal(okOrCode(refused), 'FUTURES_FX_EVIDENCE_UNAVAILABLE');
    assert.equal(await financialState(season.id, [M]), stateBefore);
    assert.equal(
      `${await db.futuresExecution.count({ where: { tradingAccountId: M.accountId } })}:${await db.futuresExecuteRequest.count({ where: { tradingAccountId: M.accountId } })}`,
      `2:${requestsBefore}`,
    );

    // A season without a rule needs no FX evidence at all.
    const free = await futuresFor(withoutFxEvidence()).execute(
      P.userId,
      P.accountId,
      command('open'),
    );
    const freeRow = await db.futuresExecution.findUniqueOrThrow({
      where: { id: free.data.execution.id },
    });
    assert.equal(freeRow.fxRateSnapshotId, null);

    // An ended season admits no new fill, so a settlement's eligibility
    // judgement cannot be overtaken by one.
    await db.season.update({
      where: { id: season.id },
      data: { status: 'ended' },
    });
    await freshFuturesPrices(contract);
    assert.equal(
      okOrCode(
        await outcome(futures.execute(M.userId, M.accountId, command('open'))),
      ),
      'SEASON_NOT_ACTIVE',
    );
    return {
      openPin: open.row.fxRateSnapshotId,
      closePin: close.row.fxRateSnapshotId,
      refused: okOrCode(refused),
    };
  },
);

scenario(
  '14 readers verify a settled final result: empty is not damaged, on every scope',
  async () => {
    const now = await dbNow();
    const startAt = at(now, -10 * DAY);
    const endAt = at(now, -9 * HOUR);
    const finalDate = new Date(`${formatKstRankingDate(endAt)}T00:00:00.000Z`);
    const reads = async (userId: string, seasonId: string) =>
      Promise.all(
        ['all', 'friends', 'top10'].map(async (scope) => {
          const read = await outcome(
            ranking.getRanking(userId, { seasonId, rankType: 'final', scope }),
          );
          if (!read.ok) return read.code;
          const data = (
            read.value as {
              data: { state: string; reason?: string; rankings: unknown[] };
            }
          ).data;
          return `${data.state}:${data.reason ?? data.rankings.length}`;
        }),
      );

    // Nobody qualified: a normal empty final ranking, on every scope.
    const season = await createSeason({
      label: 'verify',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(at(startAt, HOUR));
    const A = await join(season.id, startAt, 'V1', '1100000');
    const B = await join(season.id, startAt, 'V2', '1000000');
    const C = await join(season.id, startAt, 'V3', '900000');
    await fill(A, market.krx[0], '100000', at(startAt, DAY));
    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'verify'))),
      'ok',
    );
    const empty = 'unavailable:NO_QUALIFIED_PARTICIPANTS';
    assert.equal(
      (await reads(A.userId, season.id)).join(','),
      [empty, empty, empty].join(','),
    );

    // An injected final row for a participant that did not qualify.
    const injected = await db.seasonRanking.create({
      data: {
        seasonId: season.id,
        seasonParticipantId: C.participantId,
        tradingAccountId: C.accountId,
        rankType: 'final',
        rank: 1,
        totalAssetKrw: '900000',
        returnRate: '-10',
        rankingDate: finalDate,
        capturedAt: endAt,
      },
    });
    const withInjectedRow = await reads(A.userId, season.id);
    await db.seasonRanking.delete({ where: { id: injected.id } });
    // A season account open again after settlement.
    await db.tradingAccount.update({
      where: { id: B.accountId },
      data: { status: 'active', closedAt: null },
    });
    const withOpenAccount = await reads(A.userId, season.id);
    await db.tradingAccount.update({
      where: { id: B.accountId },
      data: { status: 'closed', closedAt: endAt },
    });
    const damage = 'FINAL_RESULTS_INTEGRITY';
    for (const observed of [withInjectedRow, withOpenAccount]) {
      assert.equal(observed.join(','), [damage, damage, damage].join(','));
    }
    assert.equal(
      (await reads(A.userId, season.id)).join(','),
      [empty, empty, empty].join(','),
      'healthy again',
    );

    // One qualifier whose final row disappears: damage, never "pending".
    const one = await createSeason({
      label: 'verify-one',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const W = await join(one.id, startAt, 'V4', '900000');
    const L = await join(one.id, startAt, 'V5', '1200000');
    for (const [index, asset] of market.krx.slice(0, 5).entries()) {
      await fill(
        W,
        asset,
        index === 0 ? '2600000' : '100000',
        at(startAt, DAY),
      );
    }
    assert.equal(
      okOrCode(await outcome(settle(one.id, endAt, 'verify-one'))),
      'ok',
    );
    // all / friends (L has no friends: an empty page) / top10.
    const healthyOne = 'available:1,available:0,available:1';
    assert.equal((await reads(L.userId, one.id)).join(','), healthyOne);
    const row = await db.seasonRanking.findFirstOrThrow({
      where: { seasonId: one.id, rankType: 'final' },
    });
    await db.seasonRanking.delete({ where: { id: row.id } });
    const withoutRow = await reads(L.userId, one.id);
    await db.seasonRanking.create({ data: row });
    assert.equal(withoutRow.join(','), [damage, damage, damage].join(','));
    assert.equal((await reads(L.userId, one.id)).join(','), healthyOne);

    // A final row on an eligibility season that is not settled yet.
    const pending = await createSeason({
      label: 'verify-pending',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const Q = await join(pending.id, startAt, 'V6', '1000000');
    assert.equal(
      (await reads(Q.userId, pending.id)).join(','),
      [
        'unavailable:RANKING_UNAVAILABLE',
        'unavailable:RANKING_UNAVAILABLE',
        'unavailable:RANKING_UNAVAILABLE',
      ].join(','),
    );
    const early = await db.seasonRanking.create({
      data: {
        seasonId: pending.id,
        seasonParticipantId: Q.participantId,
        tradingAccountId: Q.accountId,
        rankType: 'final',
        rank: 1,
        totalAssetKrw: '1000000',
        returnRate: '0',
        rankingDate: finalDate,
        capturedAt: endAt,
      },
    });
    const beforeSettlement = await reads(Q.userId, pending.id);
    await db.seasonRanking.delete({ where: { id: early.id } });
    assert.equal(
      beforeSettlement.join(','),
      [damage, damage, damage].join(','),
    );
    return { withInjectedRow, withOpenAccount, withoutRow, beforeSettlement };
  },
);

scenario(
  '15 a rule season with no rankable participant settles: nobody judged, every account closed',
  async () => {
    const now = await dbNow();
    const tierReason = async (seasonId: string, endAt: Date) => {
      const run = await outcome(assignTiers(seasonId, endAt));
      return run.ok
        ? ((
            run.value as {
              data: { run: { resultPayloadJson: { reason?: string } } };
            }
          ).data.run.resultPayloadJson.reason ?? 'ok')
        : run.code;
    };

    // (a) No participant at all.
    const emptyEnd = at(now, -10 * HOUR);
    const empty = await createSeason({
      label: 'empty',
      status: 'ended',
      startAt: at(now, -10 * DAY),
      endAt: emptyEnd,
      criteria: true,
    });
    const dryKey = `fq:empty-dry:${empty.id}:${randomUUID()}`;
    created.batchKeys.push(dryKey);
    assert.equal(
      okOrCode(
        await outcome(
          settlementJob().run({
            seasonId: empty.id,
            settlementDate: formatKstRankingDate(emptyEnd),
            dryRun: true,
            idempotencyKey: dryKey,
          }),
        ),
      ),
      'ok',
    );
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: empty.id } })).status,
      'ended',
      'a dry run changes nothing',
    );
    assert.equal(
      okOrCode(await outcome(settle(empty.id, emptyEnd, 'empty'))),
      'ok',
    );
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: empty.id } })).status,
      'settled',
    );
    const outsider = await createUser('E0');
    const emptyRead = await ranking.getRanking(outsider.id, {
      seasonId: empty.id,
      rankType: 'final',
    });
    assert.equal(
      `${emptyRead.data.state}:${emptyRead.data.reason}:${emptyRead.data.myRanking.state}`,
      'unavailable:NO_QUALIFIED_PARTICIPANTS:not_joined',
    );
    assert.equal(
      await tierReason(empty.id, emptyEnd),
      'NO_QUALIFIED_PARTICIPANTS',
    );
    assert.equal(
      okOrCode(await outcome(settle(empty.id, emptyEnd, 'empty-replay'))),
      'ok',
    );

    // (b) Every participant excluded; one still holds an open Futures
    // position whose open predates FX pinning (never judged, so never needed).
    const startAt = new Date('2018-08-01T00:00:00.000Z');
    const endAt = new Date('2018-08-22T00:00:00.000Z');
    const excludedSeason = await createSeason({
      label: 'all-excluded',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(new Date('2018-08-01T12:00:00.000Z'));
    await finalExitPrice(market.btc, endAt);
    const X = await join(excludedSeason.id, startAt, 'E1', '1000000', {
      status: 'excluded',
      futuresUsd: '200',
    });
    const Y = await join(excludedSeason.id, startAt, 'E2', '1000000', {
      status: 'excluded',
    });
    await openFuturesPosition(X, market.btc, 2, {
      executedAt: new Date('2018-08-02T00:00:00.000Z'),
      legacy: true,
    });
    const moderation = async () =>
      (
        await db.seasonParticipant.findMany({
          where: { seasonId: excludedSeason.id },
          orderBy: { id: 'asc' },
        })
      )
        .map(
          (p) =>
            `${p.participantStatus}:${p.excludedAt?.toISOString()}:${p.finalQualified}:${p.finalRank}`,
        )
        .join(',');
    const moderationBefore = await moderation();
    assert.equal(
      okOrCode(await outcome(settle(excludedSeason.id, endAt, 'excluded'))),
      'ok',
    );
    assert.equal(
      await moderation(),
      moderationBefore,
      'sanctions kept, nobody judged',
    );
    const x = await participantState(X);
    const y = await participantState(Y);
    assert.equal(
      `${x.account}:${x.accountClosedAt}:${y.account}`,
      `closed:${endAt.toISOString()}:closed`,
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: X.accountId, status: 'open' },
      }),
      0,
      'the open position was finally settled',
    );
    assert.equal(
      `${await settlementSnapshotCount(X)}:${await settlementSnapshotCount(Y)}:${(await finalRanks(excludedSeason.id)).length}`,
      '0:0:0',
    );
    const settledState = await financialState(excludedSeason.id, [X, Y]);
    assert.equal(
      okOrCode(
        await outcome(settle(excludedSeason.id, endAt, 'excluded-replay')),
      ),
      'ok',
    );
    assert.equal(
      await financialState(excludedSeason.id, [X, Y]),
      settledState,
      'no second Futures exit on replay',
    );
    assert.equal(
      await tierReason(excludedSeason.id, endAt),
      'NO_QUALIFIED_PARTICIPANTS',
    );

    // (c) Unfinished financial processing still fails closed.
    const reserved = await createSeason({
      label: 'reserved',
      status: 'ended',
      startAt: at(now, -10 * DAY),
      endAt: at(now, -11 * HOUR),
      criteria: true,
    });
    const Z = await join(reserved.id, at(now, -10 * DAY), 'E3', '1000000', {
      status: 'excluded',
    });
    await db.cashWallet.updateMany({
      where: { tradingAccountId: Z.accountId, currencyCode: 'KRW' },
      data: { reservedAmount: '1000' },
    });
    const reservedBefore = await financialState(reserved.id, [Z]);
    assert.equal(
      okOrCode(await outcome(settle(reserved.id, reserved.endAt, 'reserved'))),
      'OPEN_LIMIT_ORDER_RESERVATIONS',
    );
    assert.equal(await financialState(reserved.id, [Z]), reservedBefore);

    // (d) A season without a rule keeps its refusal.
    const legacy = await createSeason({
      label: 'empty-legacy',
      status: 'ended',
      startAt: at(now, -10 * DAY),
      endAt: at(now, -12 * HOUR),
      criteria: false,
    });
    assert.equal(
      okOrCode(await outcome(settle(legacy.id, legacy.endAt, 'empty-legacy'))),
      'NO_SETTLEMENT_PARTICIPANTS',
    );
    return { moderationBefore };
  },
);

scenario(
  '16 a failure after the Futures final exit rolls back the final write; the retry completes it once',
  async () => {
    const startAt = new Date('2018-10-01T00:00:00.000Z');
    const endAt = new Date('2018-10-22T00:00:00.000Z');
    const season = await createSeason({
      label: 'after-exit',
      status: 'ended',
      startAt,
      endAt,
      criteria: true,
    });
    const market = await createMarket(new Date('2018-10-01T12:00:00.000Z'));
    await finalExitPrice(market.btc, endAt);
    const held = await fx({
      source: KOREA_EXIM,
      rate: '1250',
      effectiveAt: new Date('2018-10-01T06:00:00.000Z'),
      capturedAt: new Date('2018-10-01T06:00:00.000Z'),
    });
    const A = await join(season.id, startAt, 'F1', '1000000', {
      futuresUsd: '200',
    });
    const B = await join(season.id, startAt, 'F2', '900000');
    await openFuturesPosition(A, market.btc, 2, {
      executedAt: new Date('2018-10-02T00:00:00.000Z'),
      fxId: held,
    });
    for (const [index, asset] of market.krx.slice(0, 5).entries()) {
      await fill(
        B,
        asset,
        index === 0 ? '2600000' : '100000',
        new Date('2018-10-03T00:00:00.000Z'),
      );
    }
    // The final write fails at its first final-ranking row, after the Futures
    // exit (separate, already committed transactions) went through.
    const failing = wrapTransactions(
      (tx) =>
        new Proxy(tx, {
          get(client, prop) {
            const value: unknown = Reflect.get(client, prop);
            if (prop === 'seasonRanking') {
              return new Proxy(client.seasonRanking, {
                get(delegate, method) {
                  if (method === 'create')
                    return () =>
                      Promise.reject(new Error('injected final write failure'));
                  return boundTo(delegate, Reflect.get(delegate, method));
                },
              });
            }
            return boundTo(client, value);
          },
        }),
    );
    const key = `fq:after-exit:${season.id}:${randomUUID()}`;
    created.batchKeys.push(key);
    const first = await outcome(
      new SeasonSettlementJobService(
        new BatchService(db),
        failing,
        valuation,
        new FuturesSeasonSettlementService(db),
      ).run({
        seasonId: season.id,
        settlementDate: formatKstRankingDate(endAt),
        idempotencyKey: key,
      }),
    );
    assert.notEqual(okOrCode(first), 'ok');
    const a1 = await participantState(A);
    assert.equal(
      `${a1.qualified}:${a1.account}:${(await db.season.findUniqueOrThrow({ where: { id: season.id } })).status}`,
      'null:active:ended',
      'no verdict, account or status from the failed final write',
    );
    assert.equal(
      await db.futuresSeasonSettlement.count({
        where: { seasonId: season.id },
      }),
      1,
      'the legitimately committed Futures exit is kept, not reverted',
    );
    const ledgerAfterExit = await db.walletTransaction.count({
      where: { tradingAccountId: A.accountId },
    });

    assert.equal(
      okOrCode(await outcome(settle(season.id, endAt, 'after-exit-retry'))),
      'ok',
    );
    assert.equal(
      `${await db.futuresSeasonSettlement.count({ where: { seasonId: season.id } })}:${await db.walletTransaction.count({ where: { tradingAccountId: A.accountId } })}`,
      `1:${ledgerAfterExit}`,
      'the retry neither exits nor charges again',
    );
    const a = await participantState(A);
    const b = await participantState(B);
    assert.equal(`${b.finalRank}:${b.qualified}`, '1:true');
    // 100 ÷ 2 × 1250 from the pinned evidence; one instrument.
    assert.equal(`${a.qualified}:${a.turnover}`, 'false:62500.00000000');
    return { first: okOrCode(first), a, b };
  },
);

// ------------------------------------------------------------------ cleanup

async function cleanup() {
  const accounts = { tradingAccountId: { in: created.accounts } };
  const seasons = { seasonId: { in: created.seasons } };
  await db.operatorAuditLog.deleteMany({
    where: { actorUserId: operator?.userId },
  });
  await db.seasonReward.deleteMany({ where: seasons });
  await db.rewardFulfillmentRequest.deleteMany({ where: seasons });
  await db.userBadge.deleteMany({ where: seasons });
  await db.badge.deleteMany({ where: { code: { in: created.badgeCodes } } });
  await db.batchJobRun.deleteMany({
    where: { idempotencyKey: { in: created.batchKeys } },
  });
  await db.seasonRanking.deleteMany({ where: seasons });
  await db.equitySnapshot.deleteMany({ where: accounts });
  await db.dailyPortfolioSnapshot.deleteMany({ where: accounts });
  await db.futuresSeasonClose.deleteMany({ where: accounts });
  await db.futuresSeasonSettlement.deleteMany({ where: accounts });
  await db.futuresSeasonPrice.deleteMany({ where: seasons });
  await db.futuresExecuteRequest.deleteMany({ where: accounts });
  await db.futuresExecution.deleteMany({ where: accounts });
  await db.futuresPosition.deleteMany({ where: accounts });
  await db.futuresLastPriceSnapshot.deleteMany({
    where: { instrumentId: { in: created.instruments } },
  });
  await db.futuresMarkSnapshot.deleteMany({
    where: { instrumentId: { in: created.instruments } },
  });
  await db.futuresInstrument.deleteMany({
    where: { id: { in: created.instruments } },
  });
  await db.walletTransaction.deleteMany({ where: accounts });
  await db.order.deleteMany({ where: accounts });
  await db.cashWallet.deleteMany({ where: accounts });
  await db.seasonParticipant.deleteMany({ where: seasons });
  await db.tradingAccount.deleteMany({
    where: { id: { in: created.accounts } },
  });
  await db.season.deleteMany({ where: { id: { in: created.seasons } } });
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: created.fx } } });
  await db.asset.deleteMany({ where: { id: { in: created.assets } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
}

async function main() {
  const admin = await createUser('operator');
  await db.user.update({ where: { id: admin.id }, data: { role: 'admin' } });
  operator = { userId: admin.id, role: 'admin' };

  const results: Array<{ scenario: string; verdict: string }> = [];
  try {
    for (const item of scenarios) {
      const started = Date.now();
      try {
        const detail = await item.run();
        results.push({ scenario: item.name, verdict: 'PASS' });
        console.log(
          JSON.stringify({
            scenario: item.name,
            verdict: 'PASS',
            ms: Date.now() - started,
            detail,
          }),
        );
      } catch (error) {
        results.push({ scenario: item.name, verdict: 'FAIL' });
        console.log(
          JSON.stringify({
            scenario: item.name,
            verdict: 'FAIL',
            error:
              error instanceof Error
                ? error.message.slice(0, 600)
                : String(error),
          }),
        );
      }
    }
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  const failed = results.filter((row) => row.verdict !== 'PASS');
  console.log(
    JSON.stringify({
      summary: {
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.map((row) => row.scenario),
      },
    }),
  );
  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('season final qualification PostgreSQL ok');
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
});
