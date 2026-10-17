import type {
  FuturesDirection,
  PushNotificationType,
  TradingAccountMode,
} from '../generated/prisma/client';

/**
 * Pure push copy and route payloads (docs/push-notifications-contract.md).
 *
 * Copy is fixed when the outbox row is created from committed rows. It names
 * the account, instrument, side and quantity only: no price, amount, balance,
 * PnL, token or internal reason text reaches a lock screen. Wording follows
 * the in-app fill banner (frontend features/order/fillTracker.ts).
 */

export type PushMarket = 'spot' | 'futures';

/** The `data` object the app receives. `uid` is the recipient: the app
 * ignores the route when another user is signed in. Ids only, never money. */
export type PushData = {
  v: 1;
  type: PushNotificationType;
  uid: string;
  accountId?: string;
  market?: PushMarket;
  futuresView?: 'executions' | 'liquidations';
  seasonId?: string;
  noticeId?: string;
};

export type PushCopy = { title: string; body: string };

export type AccountLabelInput = {
  mode: TradingAccountMode;
  seasonName?: string | null;
};

export const TITLE_MAX = 120;
export const BODY_MAX = 400;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long after its event a notification may still be sent. */
export const PUSH_TTL_MS: Record<PushNotificationType, number> = {
  trade_fill: 2 * HOUR,
  futures_liquidation: 6 * HOUR,
  order_failure: 6 * HOUR,
  friend_request: 3 * DAY,
  important_notice: DAY,
  season_final_result: 3 * DAY,
  // Bounded by the Season end instead (see the ending-soon source).
  season_ending_soon: DAY,
};

/** Android delivery priority: trading outcomes wake the device. */
export function pushPriority(type: PushNotificationType): 'high' | 'default' {
  return type === 'trade_fill' ||
    type === 'futures_liquidation' ||
    type === 'order_failure'
    ? 'high'
    : 'default';
}

export function accountLabel(account: AccountLabelInput): string {
  if (account.mode === 'general') return '일반모드';
  if (account.mode === 'beginner') return '초보모드';
  return account.seasonName?.trim() || '시즌 계정';
}

/** A decimal string without trailing zeros ('10.00000000' → '10'). */
export function displayDecimal(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return value.trim();
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return `${match[2]}${fraction ? `.${fraction}` : ''}`;
}

function isPositive(value: string | null | undefined): boolean {
  return !!value && /[1-9]/.test(value) && !value.trim().startsWith('-');
}

export function assetName(asset: {
  name?: string | null;
  symbol?: string | null;
}): string {
  return asset.name?.trim() || asset.symbol?.trim() || '종목';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function copy(
  title: string,
  parts: Array<string | null | undefined>,
): PushCopy {
  return {
    title: clip(title, TITLE_MAX),
    body: clip(
      parts.filter((part): part is string => !!part).join(' · '),
      BODY_MAX,
    ),
  };
}

const SIDE = { buy: '매수', sell: '매도' } as const;
const DIRECTION: Record<FuturesDirection, string> = { long: '롱', short: '숏' };

export type SpotFillOrigin =
  | 'order'
  | 'conditional'
  | 'stop_loss'
  | 'take_profit';

export type SpotFillFacts = {
  account: AccountLabelInput;
  asset: { name?: string | null; symbol?: string | null };
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  /** The order's quantity (intent; resolved quantity for amount orders). */
  quantity: string;
  /** Set only by a one-shot market result (partial execution). */
  executedQuantity: string | null;
  canceledQuantity: string | null;
  loc: boolean;
  origin: SpotFillOrigin;
};

const SPOT_ORIGIN: Record<Exclude<SpotFillOrigin, 'order'>, string> = {
  conditional: '조건주문',
  stop_loss: '손절',
  take_profit: '익절',
};

/** An executed Spot order. A partial market result names the executed
 * quantity and the automatically canceled remainder, never a full fill. */
export function spotFillCopy(facts: SpotFillFacts): PushCopy {
  const partial =
    facts.executedQuantity !== null && isPositive(facts.canceledQuantity);
  const filled = facts.executedQuantity ?? facts.quantity;
  const method =
    facts.origin !== 'order'
      ? SPOT_ORIGIN[facts.origin]
      : facts.loc
        ? null
        : facts.orderType === 'market'
          ? '시장가'
          : '지정가';
  return copy(
    `${assetName(facts.asset)} ${facts.loc ? 'LOC ' : ''}${SIDE[facts.side]} ${partial ? '일부 체결' : '체결 완료'}`,
    [
      accountLabel(facts.account),
      method,
      `체결 수량 ${displayDecimal(filled)}`,
      partial && facts.canceledQuantity
        ? `미체결 ${displayDecimal(facts.canceledQuantity)} 자동 취소`
        : null,
    ],
  );
}

export type FuturesFillOrigin =
  | 'order'
  | 'limit'
  | 'conditional'
  | 'stop_loss'
  | 'take_profit';

export type FuturesFillFacts = {
  account: AccountLabelInput;
  symbol: string;
  direction: FuturesDirection;
  operation: 'open' | 'increase' | 'reduce' | 'close';
  quantity: string;
  origin: FuturesFillOrigin;
};

const OPERATION = {
  open: '신규 진입',
  increase: '추가 진입',
  reduce: '일부 종료',
  close: '전량 종료',
} as const;

const FUTURES_ORIGIN: Record<FuturesFillOrigin, string> = {
  order: '시장가',
  limit: '지정가',
  conditional: '조건 진입',
  stop_loss: '손절',
  take_profit: '익절',
};

/** One committed FuturesExecution (always a full fill of its quantity). */
export function futuresFillCopy(facts: FuturesFillFacts): PushCopy {
  return copy(
    `${facts.symbol} ${DIRECTION[facts.direction]} ${OPERATION[facts.operation]} 체결`,
    [
      accountLabel(facts.account),
      FUTURES_ORIGIN[facts.origin],
      `체결 수량 ${displayDecimal(facts.quantity)}`,
    ],
  );
}

export type LiquidationFacts = {
  account: AccountLabelInput;
  marginMode: 'cross' | 'isolated';
  /** Every position this one liquidation event closed. */
  positions: ReadonlyArray<{ symbol: string; direction: FuturesDirection }>;
};

/** One FuturesLiquidation event: a Cross event that closed several
 * positions is still one notification. */
export function liquidationCopy(facts: LiquidationFacts): PushCopy {
  const [first] = facts.positions;
  const target = !first
    ? '선물 포지션이'
    : facts.positions.length > 1
      ? `교차 포지션 ${facts.positions.length}개(${first.symbol} 외 ${facts.positions.length - 1}개)가`
      : `${facts.marginMode === 'cross' ? '교차 ' : ''}${first.symbol} ${DIRECTION[first.direction]} 포지션이`;
  return copy('선물 강제청산', [
    accountLabel(facts.account),
    `${target} 강제청산되었어요.`,
  ]);
}

export type OrderFailureFacts =
  | {
      kind: 'loc_unfilled' | 'loc_expired';
      account: AccountLabelInput;
      asset: { name?: string | null; symbol?: string | null };
      side: 'buy' | 'sell';
      /** LOC_DECISION_REASONS value of an expired row. */
      reason: string | null;
    }
  | {
      kind: 'conditional_buy_failed';
      account: AccountLabelInput;
      asset: { name?: string | null; symbol?: string | null };
    }
  | {
      kind: 'conditional_sell_failed';
      account: AccountLabelInput;
      asset: { name?: string | null; symbol?: string | null };
      sellKind: 'condition' | 'stop_loss' | 'take_profit';
      terminalReason: string | null;
    }
  | {
      kind: 'futures_conditional_entry_failed';
      account: AccountLabelInput;
      symbol: string;
      direction: FuturesDirection;
    }
  | {
      kind: 'futures_tp_sl_failed';
      account: AccountLabelInput;
      symbol: string;
      tpSlKind: 'stop_loss' | 'take_profit';
    }
  | {
      kind: 'entry_tp_sl_plan_failed';
      account: AccountLabelInput;
      name: string;
      domain: 'spot' | 'futures';
      planKind: 'stop_loss' | 'take_profit';
    };

const TP_SL = { stop_loss: '손절', take_profit: '익절' } as const;

const LOC_EXPIRED_REASON: Record<string, string> = {
  loc_close_evidence_unavailable: '확정 종가를 기한 안에 확인하지 못해',
  loc_session_invalid: '주문한 정규장 세션이 유효하지 않아',
};

/** A final failure or expiry (never a retry, a user cancel or a Season-end
 * cleanup — the sources exclude those). */
export function orderFailureCopy(facts: OrderFailureFacts): PushCopy {
  const account = accountLabel(facts.account);
  switch (facts.kind) {
    case 'loc_unfilled':
      return copy(`${assetName(facts.asset)} LOC ${SIDE[facts.side]} 미체결`, [
        account,
        '확정 종가가 지정가 조건에 맞지 않아 체결되지 않았어요. 예약은 해제되었어요.',
      ]);
    case 'loc_expired':
      return copy(`${assetName(facts.asset)} LOC ${SIDE[facts.side]} 만료`, [
        account,
        `${(facts.reason && LOC_EXPIRED_REASON[facts.reason]) || '체결 조건을 기한 안에 확인하지 못해'} 주문이 만료되었어요. 예약은 해제되었어요.`,
      ]);
    case 'conditional_buy_failed':
      return copy(`${assetName(facts.asset)} 조건주문 실패`, [
        account,
        '조건은 충족됐지만 매수 주문을 실행하지 못해 종료되었어요.',
      ]);
    case 'conditional_sell_failed':
      return copy(
        `${assetName(facts.asset)} ${facts.sellKind === 'condition' ? '조건주문' : TP_SL[facts.sellKind]} 실행 실패`,
        [
          account,
          facts.terminalReason === 'quantity_unavailable'
            ? '조건은 충족됐지만 매도할 수 있는 수량이 없어 종료되었어요.'
            : '조건은 충족됐지만 매도 주문을 실행하지 못해 종료되었어요.',
        ],
      );
    case 'futures_conditional_entry_failed':
      return copy(`${facts.symbol} 조건 진입 실패`, [
        account,
        `조건은 충족됐지만 ${DIRECTION[facts.direction]} 진입을 실행하지 못해 종료되었어요.`,
      ]);
    case 'futures_tp_sl_failed':
      return copy(`${facts.symbol} ${TP_SL[facts.tpSlKind]} 실행 실패`, [
        account,
        `조건은 충족됐지만 포지션을 종료하지 못해 ${TP_SL[facts.tpSlKind]} 설정이 종료되었어요.`,
      ]);
    case 'entry_tp_sl_plan_failed':
      return copy(`${facts.name} ${TP_SL[facts.planKind]}가 설정 실패`, [
        account,
        `${facts.domain === 'futures' ? '진입' : '매수'} 체결 후 ${TP_SL[facts.planKind]}가를 등록하지 못했어요. 다시 설정해 주세요.`,
      ]);
  }
}

export function friendRequestCopy(requesterNickname: string): PushCopy {
  return copy('친구 요청', [`${requesterNickname}님이 친구 요청을 보냈어요.`]);
}

export function importantNoticeCopy(notice: {
  title: string;
  summary: string;
}): PushCopy {
  return copy(`[공지] ${notice.title}`, [notice.summary]);
}

/** The app's tier display names (frontend screens/home/tierPresentation.ts). */
const TIER_LABEL: Record<string, string> = {
  master: 'Whale',
  diamond: 'Diamond',
  platinum: 'Platinum',
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};

export function tierLabel(tier: string): string {
  return TIER_LABEL[tier] ?? tier;
}

export function seasonFinalResultCopy(facts: {
  seasonName: string;
  finalRank: number;
  finalTier: string;
}): PushCopy {
  return copy('시즌 최종 결과 확정', [
    facts.seasonName,
    `최종 ${facts.finalRank}위 · ${tierLabel(facts.finalTier)} 등급이 확정되었어요.`,
  ]);
}

/** "10월 24일 09:00" in KST (Asia/Seoul has no DST). */
export function formatKstMinute(at: Date): string {
  const kst = new Date(at.getTime() + 9 * HOUR);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/** States the actual end time, so a delayed send is still accurate. */
export function seasonEndingSoonCopy(facts: {
  seasonName: string;
  endAt: Date;
}): PushCopy {
  return copy('시즌 종료 예정', [
    facts.seasonName,
    `${formatKstMinute(facts.endAt)}에 종료돼요. 남은 시간 동안 포트폴리오를 점검해 보세요.`,
  ]);
}
