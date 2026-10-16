import { Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { buildPagination } from '../common/pagination';
import { Prisma, type FuturesDirection } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { assertBeginnerLearningAccess } from '../trading-accounts/beginner-learning-policy';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import {
  assertFuturesOperation,
  futuresTradingMode,
} from '../futures/futures.config';
import {
  assertFuturesTpSlEnabled,
  futuresTpSlCondition,
  futuresTpSlEnabled,
} from '../futures/futures-tp-sl-policy';
import { conditionalMarkets } from './conditional-markets';
import { conditionalTradable } from './conditional-policy';
import {
  assertConditionalSellKindEnabled,
  independentTpSlEnabled,
} from './conditional-sell-policy';
import {
  ENTRY_TP_SL_MAX_PENDING_PER_ACCOUNT,
  ENTRY_TP_SL_MAX_PER_ENTRY,
  entryTpSlHash,
  parseEntryId,
  parseEntryTpSlBody,
  parseEntryType,
  type EntryType,
} from './entry-tp-sl-policy';
import {
  createEntryTpSlPlansInTransaction,
  entryPlanWhere,
  pendingEntryTpSl,
  resolveEntryRoot,
  type EntryRoot,
} from './entry-tp-sl-state';

const PLAN_INCLUDE = {
  conditionalBuyOrder: { select: { orderId: true } },
  futuresLimitOrder: { select: { direction: true } },
  futuresConditionalEntry: { select: { direction: true, limitOrderId: true } },
} as const;

type PlanRecord = Prisma.EntryTpSlPlanGetPayload<{
  include: typeof PLAN_INCLUDE;
}>;

type ListQuery = {
  entryType?: string;
  entryId?: string;
  state?: string;
  limit?: string;
  offset?: string;
};

/**
 * Stop-loss / take-profit plans on pending entries (Spot limit BUY, Spot
 * conditional BUY, Futures limit entry, Futures conditional entry). A plan is
 * a protection the user prepares BEFORE the entry fills: it reserves nothing
 * and never triggers. The entry's own fill transaction turns it into an
 * independent setting for its share of the quantity that entry actually
 * filled; an entry that ends unfilled ends its plans. Lifecycle authorization
 * uses the existing Season → Account → Participant / General Account fence.
 */
@Injectable()
export class EntryTpSlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
  ) {}

  async create(userId: string | undefined, accountId: string, body: unknown) {
    this.user(userId);
    const input = parseEntryTpSlBody(body);
    const hash = entryTpSlHash(accountId, input);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const committed = await tx.entryTpSlPlan.findMany({
        where: {
          tradingAccountId: accountId,
          idempotencyKey: input.idempotencyKey,
        },
        include: PLAN_INCLUDE,
        orderBy: { kind: 'asc' },
      });
      if (committed.length) {
        if (committed.some((row) => row.requestHash !== hash))
          throw createApiError(
            'CONDITIONAL_IDEMPOTENCY_CONFLICT',
            'The command differs from the committed request.',
            409,
          );
        const root = await resolveEntryRoot(
          tx,
          accountId,
          input.entryType,
          input.entryId,
          false,
        );
        return this.response(accountId, committed, root, true);
      }
      const root = await resolveEntryRoot(
        tx,
        accountId,
        input.entryType,
        input.entryId,
        true,
      );
      if (!root)
        throw createApiError(
          'ENTRY_TP_SL_ENTRY_NOT_FOUND',
          'The entry was not found.',
          404,
        );
      if (root.domain === 'spot') assertConditionalSellKindEnabled('stop_loss');
      else {
        assertFuturesTpSlEnabled();
        // Reduce-only protection: refused only while Futures is DISABLED.
        assertFuturesOperation('reduce');
      }
      const now = await this.now(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      if (!conditionalTradable(account, now))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      // The same learning gate as stop-loss/take-profit on a holding.
      await assertBeginnerLearningAccess(
        tx,
        account,
        root.domain === 'spot' && root.asset.assetType === 'crypto'
          ? 'spotProtection'
          : 'allTrading',
      );
      const rows = await createEntryTpSlPlansInTransaction(tx, {
        accountId,
        root,
        intents: input.intents,
        idempotencyKey: () => input.idempotencyKey,
        requestHash: hash,
        now,
      });
      if (!conditionalTradable(account, await this.now(tx)))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      const created = await tx.entryTpSlPlan.findMany({
        where: { id: { in: rows.map((row) => row.id) } },
        include: PLAN_INCLUDE,
        orderBy: { kind: 'asc' },
      });
      return this.response(accountId, created, root, false);
    });
  }

  async cancel(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "entry_tp_sl_plans" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.entryTpSlPlan.findFirst({
        where: { id, tradingAccountId: accountId },
        include: PLAN_INCLUDE,
      });
      if (!row)
        throw createApiError(
          'ENTRY_TP_SL_NOT_FOUND',
          'Stop-loss or take-profit plan not found.',
          404,
        );
      if (row.status === 'pending') {
        const updated = await tx.entryTpSlPlan.update({
          where: { id },
          data: {
            status: 'canceled',
            terminalReason: 'user_canceled',
            endedAt: await this.now(tx),
          },
          include: PLAN_INCLUDE,
        });
        return this.single(accountId, updated, false);
      }
      // Activated plans are managed as the setting they became.
      return this.single(accountId, row, true);
    });
  }

  async list(userId: string | undefined, accountId: string, query: ListQuery) {
    this.user(userId);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const limit = Number(query.limit ?? 100),
      offset = Number(query.offset ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      (query.state !== undefined && !['open', 'ended'].includes(query.state)) ||
      (query.entryType === undefined) !== (query.entryId === undefined) ||
      (query.entryType !== undefined && query.state !== undefined)
    )
      throw createApiError('INVALID_PAGINATION', 'Invalid history query.', 400);
    const root =
      query.entryType !== undefined
        ? await resolveEntryRoot(
            this.prisma,
            accountId,
            parseEntryType(query.entryType),
            parseEntryId(query.entryId),
            false,
          )
        : null;
    if (query.entryType !== undefined && !root)
      throw createApiError(
        'ENTRY_TP_SL_ENTRY_NOT_FOUND',
        'The entry was not found.',
        404,
      );
    // One entry: every plan it ever had. Otherwise: the account's pending
    // plans (`state=open`, default) or the others (`state=ended`).
    const where: Prisma.EntryTpSlPlanWhereInput = root
      ? { tradingAccountId: accountId, ...entryPlanWhere(root) }
      : {
          tradingAccountId: accountId,
          ...(query.state === 'ended'
            ? { NOT: pendingEntryTpSl }
            : pendingEntryTpSl),
        };
    const [rows, total, clock] = await Promise.all([
      this.prisma.entryTpSlPlan.findMany({
        where,
        include: PLAN_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.entryTpSlPlan.count({ where }),
      this.now(this.prisma),
    ]);
    const tradable = conditionalTradable(account, clock);
    const spot = independentTpSlEnabled();
    const futures = futuresTpSlEnabled();
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          // Additive: the spot markets whose pending entries accept plans
          // (KRX, Spot crypto; US with the Tiingo provider, 2026-10-17).
          spot: {
            enabled: spot,
            canCreate: spot && tradable,
            markets: conditionalMarkets(),
          },
          futures: {
            enabled: futures,
            canCreate:
              futures && tradable && futuresTradingMode() !== 'DISABLED',
          },
          canCancel: true,
          maxPendingPerAccount: ENTRY_TP_SL_MAX_PENDING_PER_ACCOUNT,
          maxPerEntry: ENTRY_TP_SL_MAX_PER_ENTRY,
        },
        entry: root ? presentEntryRoot(root) : null,
        plans: rows.map((row) => presentEntryTpSlPlan(row)),
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: rows.length,
        }),
      },
    };
  }

  private response(
    accountId: string,
    rows: PlanRecord[],
    root: EntryRoot | null,
    duplicate: boolean,
  ) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        entry: root ? presentEntryRoot(root) : null,
        plans: rows.map((row) => presentEntryTpSlPlan(row)),
        duplicate,
      },
    };
  }

  private single(accountId: string, row: PlanRecord, duplicate: boolean) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        plan: presentEntryTpSlPlan(row),
        duplicate,
      },
    };
  }

  private user(userId: string | undefined): asserts userId is string {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  /** Existing financial writer fence (same as the conditional services). */
  private async lockAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
    userId: string,
  ) {
    const account = await this.access.getOwnedAccountOrThrow(
      userId,
      accountId,
      tx,
    );
    if (account.mode === 'season')
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: account.seasonParticipant!.id,
        userId,
        participantWrite: true,
      });
    else
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${accountId} AND user_id = ${userId} FOR UPDATE`;
  }

  private async now(client: Pick<Prisma.TransactionClient, '$queryRaw'>) {
    const [row] = await client.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return row.now;
  }
}

const money = (value: Prisma.Decimal | null) => value?.toFixed(8) ?? null;

/** The entry facts a client needs to show what a plan will protect. They
 * describe the entry, not a fill: `expectedQuantity` is what the entry would
 * acquire if it filled completely (null when decided at execution). */
export function presentEntryRoot(root: EntryRoot) {
  return {
    entryType: root.type,
    entryId: root.id,
    domain: root.domain,
    state: root.state,
    supported: root.supported,
    assetId: root.assetId,
    asset: root.asset,
    instrumentId: root.instrumentId,
    direction: root.direction,
    executionType: root.executionType,
    entryPrice: money(root.entryPrice),
    triggerPrice: money(root.triggerPrice),
    limitPrice: money(root.limitPrice),
    expectedQuantity: money(root.expectedQuantity),
    amount: money(root.amount),
    currencyCode: root.currencyCode,
    leverage: root.leverage,
    legacyProtection: root.legacyProtection,
    childOrderId: root.childOrderId,
  };
}

/** A plan is never an order: `pending` waits for its entry's fill,
 * `activated` became the linked setting for `activatedQuantity`. */
export function presentEntryTpSlPlan(row: PlanRecord) {
  const direction: FuturesDirection =
    row.futuresLimitOrder?.direction ??
    row.futuresConditionalEntry?.direction ??
    'long';
  const entryType: EntryType = row.orderId
    ? 'spot_limit_order'
    : row.conditionalBuyOrderId
      ? 'spot_conditional_buy'
      : row.futuresLimitOrderId
        ? 'futures_limit_order'
        : 'futures_conditional_entry';
  return {
    id: row.id,
    entryType,
    entryId:
      row.orderId ??
      row.conditionalBuyOrderId ??
      row.futuresLimitOrderId ??
      row.futuresConditionalEntryId,
    // The order a conditional entry created (its plans follow that order).
    childOrderId:
      row.conditionalBuyOrder?.orderId ??
      row.futuresConditionalEntry?.limitOrderId ??
      null,
    domain: row.domain,
    assetId: row.assetId,
    direction,
    kind: row.kind,
    triggerCondition: futuresTpSlCondition(direction, row.kind),
    triggerPrice: row.triggerPrice.toFixed(8),
    ratioPercent: row.ratioPercent,
    status: row.status,
    basisQuantity: money(row.basisQuantity),
    activatedQuantity: money(row.activatedQuantity),
    fillOrderId: row.fillOrderId,
    fillExecutionId: row.fillExecutionId,
    settingId: row.conditionalSellOrderId ?? row.futuresTpSlSettingId,
    failureCode: row.failureCode,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
