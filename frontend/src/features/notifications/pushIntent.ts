import { isOrderFailureKind, type OrderFailureKind } from './orderFailure.ts';

/**
 * Where a tapped push leads (pure; node --test loads it).
 *
 * The payload carries ids only: the recipient (`uid`), an account, a Season,
 * a notice or the failure row. A tap is applied only for the signed-in user it was sent to, only
 * after sign-in and the investment-mode choice have finished (the main tabs
 * are showing), and an account target only when that account is in the
 * user's own account list. Anything else is dropped without opening a screen,
 * so a stale push can never show someone else's data.
 */

export type PushIntent =
  | {
      kind: 'trade_history';
      type: 'trade_fill' | 'futures_liquidation';
      uid: string;
      accountId: string;
      market: 'spot' | 'futures';
      futuresView?: 'executions' | 'liquidations';
      /** A liquidation's event id: its in-app notice is shown once. */
      liquidationId?: string;
    }
  | {
      /** The failure row itself: a failed order has no fill to show. */
      kind: 'order_failure';
      type: 'order_failure';
      uid: string;
      accountId: string;
      market: 'spot' | 'futures';
      failureKind: OrderFailureKind;
      failureId: string;
    }
  | { kind: 'friend_requests'; type: 'friend_request'; uid: string }
  | { kind: 'notice'; type: 'important_notice'; uid: string; noticeId: string }
  | {
      kind: 'season_record';
      type: 'season_final_result' | 'season_ending_soon';
      uid: string;
      seasonId: string;
    };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (value: unknown) => (typeof value === 'string' && ID.test(value) ? value : null);

/** Validates a push `data` object; anything unexpected yields null. */
export function parsePushData(data: unknown): PushIntent | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  const uid = id(value.uid);
  if (value.v !== 1 || !uid) return null;
  switch (value.type) {
    case 'trade_fill':
    case 'futures_liquidation': {
      const accountId = id(value.accountId);
      const market = value.market === 'spot' || value.market === 'futures' ? value.market : null;
      if (!accountId || !market) return null;
      const futuresView =
        market === 'futures'
          ? value.type === 'futures_liquidation' || value.futuresView === 'liquidations'
            ? ('liquidations' as const)
            : ('executions' as const)
          : undefined;
      const liquidationId = value.type === 'futures_liquidation' ? id(value.liquidationId) : null;
      return {
        kind: 'trade_history',
        type: value.type,
        uid,
        accountId,
        market,
        ...(futuresView ? { futuresView } : {}),
        ...(liquidationId ? { liquidationId } : {}),
      };
    }
    case 'order_failure': {
      // Without the row it names there is nothing true to open: a failure is
      // not in the fill history (every server payload carries both ids).
      const accountId = id(value.accountId);
      const market = value.market === 'spot' || value.market === 'futures' ? value.market : null;
      const failureId = id(value.failureId);
      if (!accountId || !market || !failureId || !isOrderFailureKind(value.failureKind)) return null;
      return {
        kind: 'order_failure',
        type: 'order_failure',
        uid,
        accountId,
        market,
        failureKind: value.failureKind,
        failureId,
      };
    }
    case 'friend_request':
      return { kind: 'friend_requests', type: 'friend_request', uid };
    case 'important_notice': {
      const noticeId = id(value.noticeId);
      return noticeId ? { kind: 'notice', type: 'important_notice', uid, noticeId } : null;
    }
    case 'season_final_result':
    case 'season_ending_soon': {
      const seasonId = id(value.seasonId);
      return seasonId ? { kind: 'season_record', type: value.type, uid, seasonId } : null;
    }
    default:
      return null;
  }
}

/** A tap older than this is not applied after a later sign-in. */
export const PENDING_INTENT_TTL_MS = 10 * 60 * 1000;

export type IntentContext = {
  /** The signed-in user, or null (signed out / restoring). */
  userId: string | null;
  /** True once the main tabs show (sign-in and mode choice are done). */
  mainReady: boolean;
  /** The user's own account ids; null while the list is loading. */
  ownedAccountIds: readonly string[] | null;
  receivedAt: number;
  now: number;
};

export type IntentResolution =
  | { action: 'wait' }
  | { action: 'discard'; reason: 'expired' | 'other_user' | 'account_not_owned' }
  | { action: 'navigate'; intent: PushIntent };

export function resolvePushIntent(intent: PushIntent, context: IntentContext): IntentResolution {
  if (context.now - context.receivedAt > PENDING_INTENT_TTL_MS)
    return { action: 'discard', reason: 'expired' };
  if (!context.userId || !context.mainReady) return { action: 'wait' };
  if (intent.uid !== context.userId) return { action: 'discard', reason: 'other_user' };
  if (intent.kind === 'trade_history' || intent.kind === 'order_failure') {
    if (!context.ownedAccountIds) return { action: 'wait' };
    if (!context.ownedAccountIds.includes(intent.accountId))
      return { action: 'discard', reason: 'account_not_owned' };
  }
  return { action: 'navigate', intent };
}

/** The screen the beginner-quest guard checks: the pushed history or
 * failure, or the 전체(MyTab) stack every other target opens in. */
export function intentGuardName(intent: PushIntent): 'TradeHistory' | 'OrderFailure' | 'MyTab' {
  if (intent.kind === 'trade_history') return 'TradeHistory';
  return intent.kind === 'order_failure' ? 'OrderFailure' : 'MyTab';
}
