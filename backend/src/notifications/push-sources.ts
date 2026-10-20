import { publicSeasonWhere } from '../seasons/season-availability.policy';
import type { Prisma, PushNotificationType } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  PUSH_TTL_MS,
  type AccountLabelInput,
  type PushCopy,
  type PushData,
  type PushMarket,
  type SpotFillOrigin,
  friendRequestCopy,
  futuresFillCopy,
  liquidationCopy,
  orderFailureCopy,
  seasonEndingSoonCopy,
  seasonFinalResultCopy,
  spotFillCopy,
  type FuturesFillOrigin,
  type OrderFailureKind,
} from './push-copy';

/**
 * Push sources (docs/push-notifications-contract.md §2). Each reads ONLY rows
 * that are already committed and terminal, inside a time window on the
 * column the writing transaction stamps with its own clock, in
 * (time, id) order with keyset paging. Nothing here writes or locks a
 * financial row, and no source treats a submission, a trigger, a watch or a
 * retry as an outcome.
 */

export type PushCandidate = {
  userId: string;
  type: PushNotificationType;
  sourceKey: string;
  tradingAccountId: string | null;
  copy: PushCopy;
  data: PushData;
  eventAt: Date;
  expiresAt: Date;
};

export type ScanWindow = { from: Date; to: Date };

/** A row's position in (time, id) order: where the next page continues. */
export type Keyset = { at: Date; id: string };

export type ScanArgs = { window: ScanWindow; after: Keyset | null; now: Date };

/** `last` is the newest row read (candidates may be fewer: filtered rows
 * still advance the scan); `full` means another page may follow; `lastSafe`
 * is the newest row stamped at least COMMIT_SAFETY_MS before the scan — the
 * only safe place to resume a later tick without missing a late commit. */
export type SourcePage = {
  candidates: PushCandidate[];
  last: Keyset | null;
  lastSafe: Keyset | null;
  full: boolean;
};

export const SOURCE_PAGE_SIZE = 500;
/** Final results are announced only for Seasons that ended this recently. */
export const FINAL_RESULT_MAX_AGE_MS = 14 * 24 * 3_600_000;
/** A row stamped this long before the scan has committed (see config). */
export const COMMIT_SAFETY_MS = 30_000;
/** Final results are read one Season at a time (its participants together). */
export const SEASON_PAGE_SIZE = 20;

type Db = Pick<
  PrismaService,
  | 'order'
  | 'futuresExecution'
  | 'futuresLiquidation'
  | 'limitOnCloseOrder'
  | 'conditionalBuyOrder'
  | 'conditionalSellOrder'
  | 'futuresConditionalEntry'
  | 'futuresTpSlSetting'
  | 'entryTpSlPlan'
  | 'friendship'
  | 'season'
  | 'seasonParticipant'
  | 'pushNotification'
>;

/** Window plus keyset continuation on one timestamp column: rows after
 * `after` in (time, id) order. Exported for tests. */
export function keysetWhere(time: string, id: string, args: ScanArgs) {
  return [
    { [time]: { gte: args.window.from, lte: args.window.to } },
    ...(args.after
      ? [
          {
            OR: [
              { [time]: { gt: args.after.at } },
              { [time]: args.after.at, [id]: { gt: args.after.id } },
            ],
          },
        ]
      : []),
  ];
}

function page<T>(
  rows: readonly T[],
  take: number,
  key: (row: T) => Keyset,
  candidates: PushCandidate[],
  now: Date,
): SourcePage {
  const keys = rows.map(key);
  const safeBefore = now.getTime() - COMMIT_SAFETY_MS;
  let lastSafe: Keyset | null = null;
  for (let index = keys.length - 1; index >= 0 && !lastSafe; index--)
    if (keys[index].at.getTime() <= safeBefore) lastSafe = keys[index];
  return {
    candidates,
    last: keys.length ? keys[keys.length - 1] : null,
    lastSafe,
    full: rows.length >= take,
  };
}

const accountSelect = {
  id: true,
  userId: true,
  mode: true,
  seasonParticipant: {
    select: { season: { select: { id: true, name: true, endAt: true } } },
  },
} satisfies Prisma.TradingAccountSelect;

type AccountRow = Prisma.TradingAccountGetPayload<{
  select: typeof accountSelect;
}>;

function label(account: AccountRow): AccountLabelInput {
  return {
    mode: account.mode,
    seasonName: account.seasonParticipant?.season.name ?? null,
  };
}

/** A Season account's event at or after its Season end belongs to the
 * Season-end cleanup, which is not reported as a failure (§2.3). */
export function isSeasonEndCleanup(account: AccountRow, at: Date): boolean {
  const season = account.seasonParticipant?.season;
  return account.mode === 'season' && !!season && at >= season.endAt;
}

function expiry(type: PushNotificationType, eventAt: Date): Date {
  return new Date(eventAt.getTime() + PUSH_TTL_MS[type]);
}

function accountCandidate(
  type: PushNotificationType,
  account: AccountRow,
  sourceKey: string,
  copy: PushCopy,
  eventAt: Date,
  route: {
    market: PushMarket;
    futuresView?: 'executions' | 'liquidations';
    extra?: Pick<PushData, 'failureKind' | 'failureId' | 'liquidationId'>;
  },
): PushCandidate {
  return {
    userId: account.userId,
    type,
    sourceKey,
    tradingAccountId: account.id,
    copy,
    data: {
      v: 1,
      type,
      uid: account.userId,
      accountId: account.id,
      market: route.market,
      ...(route.futuresView ? { futuresView: route.futuresView } : {}),
      ...route.extra,
    },
    eventAt,
    expiresAt: expiry(type, eventAt),
  };
}

const decimal = (value: { toFixed(): string }) => value.toFixed();
const optionalDecimal = (value: { toFixed(): string } | null) =>
  value === null ? null : value.toFixed();

/** §2.1 Spot: every Order that reached `executed` (market, limit paths A/B,
 * LOC, conditional BUY/SELL, stop-loss/take-profit, legacy protection). A
 * submitted, canceled or rejected order is never read. */
export async function readSpotFills(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.order.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'executed',
      AND: keysetWhere('executedAt', 'id', args),
    } as Prisma.OrderWhereInput,
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      side: true,
      orderType: true,
      quantity: true,
      executedQuantity: true,
      canceledQuantity: true,
      executedAt: true,
      asset: { select: { name: true, symbol: true } },
      tradingAccount: { select: accountSelect },
      limitOnClose: { select: { orderId: true } },
      conditionalBuy: { select: { id: true } },
      conditionalSell: { select: { kind: true } },
      protectionChild: { select: { leg: { select: { kind: true } } } },
    },
  });
  const candidates = rows.flatMap((row) => {
    if (!row.executedAt) return [];
    const origin: SpotFillOrigin = row.conditionalSell
      ? row.conditionalSell.kind === 'condition'
        ? 'conditional'
        : row.conditionalSell.kind
      : row.protectionChild
        ? row.protectionChild.leg.kind
        : row.conditionalBuy
          ? 'conditional'
          : 'order';
    return [
      accountCandidate(
        'trade_fill',
        row.tradingAccount,
        `order:${row.id}`,
        spotFillCopy({
          account: label(row.tradingAccount),
          asset: row.asset,
          side: row.side,
          orderType: row.orderType,
          quantity: decimal(row.quantity),
          executedQuantity: optionalDecimal(row.executedQuantity),
          canceledQuantity: optionalDecimal(row.canceledQuantity),
          loc: !!row.limitOnClose,
          origin,
        }),
        row.executedAt,
        { market: 'spot' },
      ),
    ];
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.executedAt!, id: row.id }),
    candidates,
    args.now,
  );
}

/** §2.1 Futures: every committed FuturesExecution (manual market, limit
 * entry, conditional entry, stop-loss/take-profit, legacy protection). A
 * liquidation or Season final exit never writes this table. */
export async function readFuturesFills(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.futuresExecution.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      AND: keysetWhere('executedAt', 'id', args),
    } as Prisma.FuturesExecutionWhereInput,
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      operation: true,
      direction: true,
      quantity: true,
      executedAt: true,
      instrument: {
        select: { underlyingAsset: { select: { symbol: true } } },
      },
      tradingAccount: { select: accountSelect },
      limitOrder: { select: { conditionalEntry: { select: { id: true } } } },
      conditionalEntry: { select: { id: true } },
      tpSlSetting: { select: { kind: true } },
      protectionChild: { select: { leg: { select: { kind: true } } } },
    },
  });
  const candidates = rows.map((row) => {
    const origin: FuturesFillOrigin = row.tpSlSetting
      ? row.tpSlSetting.kind
      : row.protectionChild
        ? row.protectionChild.leg.kind
        : row.conditionalEntry || row.limitOrder?.conditionalEntry
          ? 'conditional'
          : row.limitOrder
            ? 'limit'
            : 'order';
    return accountCandidate(
      'trade_fill',
      row.tradingAccount,
      `futures_execution:${row.id}`,
      futuresFillCopy({
        account: label(row.tradingAccount),
        symbol: row.instrument.underlyingAsset.symbol,
        direction: row.direction,
        operation: row.operation,
        quantity: decimal(row.quantity),
        origin,
      }),
      row.executedAt,
      { market: 'futures', futuresView: 'executions' },
    );
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.executedAt, id: row.id }),
    candidates,
    args.now,
  );
}

/** §2.2 One notification per FuturesLiquidation event. A user close or a
 * Season final exit has no liquidation row and is never reported here. */
export async function readLiquidations(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.futuresLiquidation.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      AND: keysetWhere('executedAt', 'id', args),
    } as Prisma.FuturesLiquidationWhereInput,
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      marginMode: true,
      executedAt: true,
      tradingAccount: { select: accountSelect },
      closes: {
        orderBy: { id: 'asc' },
        select: {
          direction: true,
          instrument: {
            select: { underlyingAsset: { select: { symbol: true } } },
          },
        },
      },
    },
  });
  const candidates = rows.map((row) =>
    accountCandidate(
      'futures_liquidation',
      row.tradingAccount,
      `futures_liquidation:${row.id}`,
      liquidationCopy({
        account: label(row.tradingAccount),
        marginMode: row.marginMode,
        positions: row.closes.map((close) => ({
          symbol: close.instrument.underlyingAsset.symbol,
          direction: close.direction,
        })),
      }),
      row.executedAt,
      {
        market: 'futures',
        futuresView: 'liquidations',
        extra: { liquidationId: row.id },
      },
    ),
  );
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.executedAt, id: row.id }),
    candidates,
    args.now,
  );
}

/** §2.3 helper: anything decided at or after its Season's end is Season
 * cleanup, never a failure. The key and the payload name the same row. */
function failureCandidate(
  account: AccountRow,
  failure: { kind: OrderFailureKind; id: string },
  eventAt: Date | null,
  market: PushMarket,
  build: () => PushCopy,
): PushCandidate[] {
  if (!eventAt || isSeasonEndCleanup(account, eventAt)) return [];
  return [
    accountCandidate(
      'order_failure',
      account,
      `${failure.kind}:${failure.id}`,
      build(),
      eventAt,
      {
        market,
        extra: { failureKind: failure.kind, failureId: failure.id },
      },
    ),
  ];
}

/** §2.3 LOC decided `unfilled` (close missed the limit) or `expired` (no
 * usable final close before the deadline). User cancels are `canceled`. */
export async function readLocFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.limitOnCloseOrder.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: { in: ['unfilled', 'expired'] },
      AND: keysetWhere('decidedAt', 'orderId', args),
    } as Prisma.LimitOnCloseOrderWhereInput,
    orderBy: [{ decidedAt: 'asc' }, { orderId: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      orderId: true,
      status: true,
      decisionReason: true,
      decidedAt: true,
      asset: { select: { name: true, symbol: true } },
      order: { select: { side: true } },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.decidedAt!, id: row.orderId }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'loc', id: row.orderId },
        row.decidedAt,
        'spot',
        () =>
          orderFailureCopy({
            kind: row.status === 'unfilled' ? 'loc_unfilled' : 'loc_expired',
            account: label(row.tradingAccount),
            asset: row.asset,
            side: row.order.side,
            reason: row.decisionReason,
          }),
      ),
    ),
    args.now,
  );
}

/** §2.3 Conditional BUY `failed` (retries over or a non-retryable error). */
export async function readConditionalBuyFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.conditionalBuyOrder.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'failed',
      AND: keysetWhere('endedAt', 'id', args),
    } as Prisma.ConditionalBuyOrderWhereInput,
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      endedAt: true,
      asset: { select: { name: true, symbol: true } },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.endedAt!, id: row.id }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'conditional_buy', id: row.id },
        row.endedAt,
        'spot',
        () =>
          orderFailureCopy({
            kind: 'conditional_buy_failed',
            account: label(row.tradingAccount),
            asset: row.asset,
          }),
      ),
    ),
    args.now,
  );
}

/** §2.3 Conditional SELL / stop-loss / take-profit `failed`. */
export async function readConditionalSellFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.conditionalSellOrder.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'failed',
      AND: keysetWhere('endedAt', 'id', args),
    } as Prisma.ConditionalSellOrderWhereInput,
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      terminalReason: true,
      endedAt: true,
      asset: { select: { name: true, symbol: true } },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.endedAt!, id: row.id }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'conditional_sell', id: row.id },
        row.endedAt,
        'spot',
        () =>
          orderFailureCopy({
            kind: 'conditional_sell_failed',
            account: label(row.tradingAccount),
            asset: row.asset,
            sellKind: row.kind,
            terminalReason: row.terminalReason,
          }),
      ),
    ),
    args.now,
  );
}

/** §2.3 Futures conditional entry `failed`. */
export async function readFuturesConditionalEntryFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.futuresConditionalEntry.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'failed',
      AND: keysetWhere('endedAt', 'id', args),
    } as Prisma.FuturesConditionalEntryWhereInput,
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      direction: true,
      endedAt: true,
      instrument: {
        select: { underlyingAsset: { select: { symbol: true } } },
      },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.endedAt!, id: row.id }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'futures_conditional_entry', id: row.id },
        row.endedAt,
        'futures',
        () =>
          orderFailureCopy({
            kind: 'futures_conditional_entry_failed',
            account: label(row.tradingAccount),
            symbol: row.instrument.underlyingAsset.symbol,
            direction: row.direction,
          }),
      ),
    ),
    args.now,
  );
}

/** §2.3 Futures stop-loss/take-profit `failed`. */
export async function readFuturesTpSlFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.futuresTpSlSetting.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'failed',
      AND: keysetWhere('endedAt', 'id', args),
    } as Prisma.FuturesTpSlSettingWhereInput,
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      endedAt: true,
      instrument: {
        select: { underlyingAsset: { select: { symbol: true } } },
      },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.endedAt!, id: row.id }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'futures_tp_sl', id: row.id },
        row.endedAt,
        'futures',
        () =>
          orderFailureCopy({
            kind: 'futures_tp_sl_failed',
            account: label(row.tradingAccount),
            symbol: row.instrument.underlyingAsset.symbol,
            tpSlKind: row.kind,
          }),
      ),
    ),
    args.now,
  );
}

/** §2.3 A stop-loss/take-profit plan that could not be activated after its
 * entry filled (`failed`): the user believes a protection exists. */
export async function readEntryPlanFailures(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.entryTpSlPlan.findMany({
    where: {
      tradingAccount: notificationAccountWhere(args.now),
      status: 'failed',
      AND: keysetWhere('endedAt', 'id', args),
    } as Prisma.EntryTpSlPlanWhereInput,
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      domain: true,
      kind: true,
      endedAt: true,
      asset: { select: { name: true, symbol: true } },
      tradingAccount: { select: accountSelect },
    },
  });
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.endedAt!, id: row.id }),
    rows.flatMap((row) =>
      failureCandidate(
        row.tradingAccount,
        { kind: 'entry_tp_sl_plan', id: row.id },
        row.endedAt,
        row.domain,
        () =>
          orderFailureCopy({
            kind: 'entry_tp_sl_plan_failed',
            account: label(row.tradingAccount),
            // A Futures plan's asset is the contract's underlying asset,
            // whose symbol is how the app names the contract.
            name:
              row.domain === 'futures'
                ? row.asset.symbol
                : row.asset.name?.trim() || row.asset.symbol,
            domain: row.domain,
            planKind: row.kind,
          }),
      ),
    ),
    args.now,
  );
}

export const FRIEND_REQUEST_PAIR_COOLDOWN_MS = 24 * 3_600_000;

/** §2.4 A new pending request, to its recipient only. Accepting, rejecting
 * or re-reading creates no row; a reject-then-request loop from the same
 * requester is held to one notification per pair per 24 h. */
export async function readFriendRequests(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const rows = await db.friendship.findMany({
    where: {
      status: 'pending',
      AND: keysetWhere('createdAt', 'id', args),
    } as Prisma.FriendshipWhereInput,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_PAGE_SIZE,
    select: {
      id: true,
      requesterUserId: true,
      createdAt: true,
      lowUser: { select: { id: true, nickname: true, status: true } },
      highUser: { select: { id: true, nickname: true, status: true } },
    },
  });
  const requests = rows.flatMap((row) => {
    const requester =
      row.lowUser.id === row.requesterUserId ? row.lowUser : row.highUser;
    const recipient =
      row.lowUser.id === row.requesterUserId ? row.highUser : row.lowUser;
    if (requester.status !== 'active' || recipient.status !== 'active')
      return [];
    return [{ row, requester, recipient }];
  });
  const recent = requests.length
    ? await db.pushNotification.findMany({
        where: {
          type: 'friend_request',
          userId: { in: [...new Set(requests.map((r) => r.recipient.id))] },
          createdAt: {
            gte: new Date(args.now.getTime() - FRIEND_REQUEST_PAIR_COOLDOWN_MS),
          },
        },
        select: { userId: true, sourceKey: true },
      })
    : [];
  const notified = new Set(
    recent.map((item) => `${item.userId}|${item.sourceKey.split(':')[1]}`),
  );
  const candidates: PushCandidate[] = [];
  for (const { row, requester, recipient } of requests) {
    const sourceKey = `friend:${requester.id}:${row.id}`;
    const pair = `${recipient.id}|${requester.id}`;
    // The same request is deduplicated by its key; another request of the
    // same pair inside the cooldown is not announced again.
    if (
      notified.has(pair) &&
      !recent.some(
        (item) => item.userId === recipient.id && item.sourceKey === sourceKey,
      )
    )
      continue;
    notified.add(pair);
    candidates.push({
      userId: recipient.id,
      type: 'friend_request',
      sourceKey,
      tradingAccountId: null,
      copy: friendRequestCopy(requester.nickname),
      data: { v: 1, type: 'friend_request', uid: recipient.id },
      eventAt: row.createdAt,
      expiresAt: expiry('friend_request', row.createdAt),
    });
  }
  return page(
    rows,
    SOURCE_PAGE_SIZE,
    (row) => ({ at: row.createdAt, id: row.id }),
    candidates,
    args.now,
  );
}

/** §2.6 Final rank AND tier, only after the Season is `settled` (written in
 * the same transaction as every final result). Participants without both
 * (not qualified, excluded, hidden from the ranking) are not told anything.
 * The settlement's `updatedAt` stamp is the event time; settled Seasons are
 * never updated again by the application. */
export async function readSeasonFinalResults(
  db: Db,
  args: ScanArgs,
): Promise<SourcePage> {
  const seasons = await db.season.findMany({
    where: {
      ...notificationSeasonWhere(args.now),
      status: 'settled',
      // A Season that ended long ago is never (re-)announced, e.g. when a
      // settlement re-run touches `updated_at` again.
      endAt: { gte: new Date(args.now.getTime() - FINAL_RESULT_MAX_AGE_MS) },
      AND: [
        notificationSeasonWhere(args.now),
        ...keysetWhere('updatedAt', 'id', args),
      ],
    } as Prisma.SeasonWhereInput,
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: SEASON_PAGE_SIZE,
    select: { id: true, name: true, updatedAt: true },
  });
  const candidates: PushCandidate[] = [];
  for (const season of seasons) {
    const participants = await db.seasonParticipant.findMany({
      // `final_qualified = false` cannot hold a rank or tier (SQL CHECK), so
      // requiring both covers eligibility seasons and rule-less seasons alike.
      where: {
        seasonId: season.id,
        finalRank: { not: null },
        finalTier: { not: null },
        participantStatus: { not: 'excluded' },
        rankingHiddenAt: null,
      },
      orderBy: { id: 'asc' },
      select: {
        userId: true,
        tradingAccountId: true,
        finalRank: true,
        finalTier: true,
      },
    });
    for (const participant of participants) {
      if (participant.finalRank === null || !participant.finalTier) continue;
      candidates.push({
        userId: participant.userId,
        type: 'season_final_result',
        sourceKey: `season_final:${season.id}`,
        tradingAccountId: participant.tradingAccountId,
        copy: seasonFinalResultCopy({
          seasonName: season.name,
          finalRank: participant.finalRank,
          finalTier: participant.finalTier,
        }),
        data: {
          v: 1,
          type: 'season_final_result',
          uid: participant.userId,
          seasonId: season.id,
        },
        eventAt: season.updatedAt,
        expiresAt: expiry('season_final_result', season.updatedAt),
      });
    }
  }
  return page(
    seasons,
    SEASON_PAGE_SIZE,
    (season) => ({ at: season.updatedAt, id: season.id }),
    candidates,
    args.now,
  );
}

export const SEASON_ENDING_LEAD_MS = 24 * 3_600_000;
/** No new "ending soon" is created with less than this left. */
export const SEASON_ENDING_MIN_LEAD_MS = 10 * 60_000;

/** §2.7 One notification per participant and Season end instant, from 24 h
 * before `endAt` until 10 minutes before it, to participants that are active
 * in a currently running Season. It expires at `endAt`, so a late send never
 * happens after the end. A changed `endAt` is a new key: the confirmed end
 * at scan time is what is announced. */
export async function scanSeasonEndingSoon(
  db: Db,
  now: Date,
): Promise<
  Array<{ seasonId: string; endAt: Date; candidates: PushCandidate[] }>
> {
  const seasons = await db.season.findMany({
    where: {
      ...notificationSeasonWhere(now),
      status: 'active',
      startAt: { lte: now },
      endAt: {
        gt: new Date(now.getTime() + SEASON_ENDING_MIN_LEAD_MS),
        lte: new Date(now.getTime() + SEASON_ENDING_LEAD_MS),
      },
    },
    orderBy: { endAt: 'asc' },
    take: 5,
    select: { id: true, name: true, endAt: true },
  });
  const result: Array<{
    seasonId: string;
    endAt: Date;
    candidates: PushCandidate[];
  }> = [];
  for (const season of seasons) {
    const participants = await db.seasonParticipant.findMany({
      where: {
        seasonId: season.id,
        participantStatus: 'active',
        tradingAccount: { status: 'active' },
      },
      orderBy: { id: 'asc' },
      select: { userId: true, tradingAccountId: true },
    });
    result.push({
      seasonId: season.id,
      endAt: season.endAt,
      candidates: participants.map((participant) => ({
        userId: participant.userId,
        type: 'season_ending_soon' as const,
        sourceKey: seasonEndingSourceKey(season.id, season.endAt),
        tradingAccountId: participant.tradingAccountId,
        copy: seasonEndingSoonCopy({
          seasonName: season.name,
          endAt: season.endAt,
        }),
        data: {
          v: 1 as const,
          type: 'season_ending_soon' as const,
          uid: participant.userId,
          seasonId: season.id,
        },
        eventAt: now,
        expiresAt: season.endAt,
      })),
    });
  }
  return result;
}

export function seasonEndingSourceKey(seasonId: string, endAt: Date): string {
  return `season_ending:${seasonId}:${endAt.getTime()}`;
}

export function parseSeasonEndingSourceKey(
  sourceKey: string,
): { seasonId: string; endAtMs: number } | null {
  const match = /^season_ending:([^:]+):(\d+)$/.exec(sourceKey);
  return match ? { seasonId: match[1], endAtMs: Number(match[2]) } : null;
}

/** Test launches never create external pushes; hidden development is private. */
export function notificationSeasonWhere(
  now = new Date(),
): Prisma.SeasonWhereInput {
  return {
    ...publicSeasonWhere(now),
    AND: [{ OR: [{ launchKind: null }, { launchKind: 'release' }] }],
  };
}
export function notificationAccountWhere(
  now = new Date(),
): Prisma.TradingAccountWhereInput {
  return {
    OR: [
      { mode: { not: 'season' } },
      { seasonParticipant: { is: { season: notificationSeasonWhere(now) } } },
    ],
  };
}
