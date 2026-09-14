import type { TradingAccountDto } from './api';

/**
 * What the SELECTED account can actually do (작업 9 §B-7 · §B-8).
 *
 * Deliberately a small derived record, not a feature framework. It answers the
 * two questions the UI keeps asking — "may I show this control as usable?" and
 * "why not?" — from account status and its own season/participant lifecycle.
 *
 * WHY THE FRONTEND MIRRORS SERVER GATES AT ALL
 * -------------------------------------------
 * The server is still authoritative and still refuses; nothing here can enable
 * anything. What this prevents is a UI that renders a live-looking Buy button
 * whose only possible outcome is a 409. Letting a user press it and reading
 * them an error is not "server-authoritative", it is a broken screen.
 *
 * General trading and FX use the same account-scoped backend cores as season.
 */

export type CapabilityBlockReason =
  | 'account_suspended'
  | 'account_closed'
  | 'season_not_active'
  | 'participant_excluded'
  | 'participant_not_active'
  | null;

export type TradingAccountCapabilities = {
  mode: TradingAccountDto['mode'];
  status: TradingAccountDto['status'];
  isSeason: boolean;
  isGeneral: boolean;
  /** Reads are status-blind by contract: active, suspended and closed alike. */
  canRead: boolean;
  canTrade: boolean;
  canQuote: boolean;
  canCancelOrder: boolean;
  canExchange: boolean;
  canClaimAdReward: boolean;
  /** Season-only UI: ranking, tier, reward. */
  showsSeasonUi: boolean;
  tradeBlockReason: CapabilityBlockReason;
  exchangeBlockReason: CapabilityBlockReason;
  returnRateMethod: 'time_weighted' | 'initial_capital';
};

export const CAPABILITY_BLOCK_MESSAGE: Record<
  Exclude<CapabilityBlockReason, null>,
  string
> = {
  account_suspended:
    '일시정지된 계정입니다. 조회는 가능하지만 새 주문과 환전은 할 수 없습니다.',
  account_closed:
    '종료된 계정입니다. 과거 기록은 조회만 가능하며 새 거래는 할 수 없습니다.',
  season_not_active: '현재 거래 가능한 시즌이 아닙니다.',
  participant_excluded:
    '참가가 제한된 시즌계좌입니다. 조회와 기존 주문 취소는 가능하지만 신규 주문과 환전은 할 수 없습니다.',
  participant_not_active:
    '현재 선택한 시즌계좌의 참가 상태로는 신규 주문과 환전을 할 수 없습니다.',
};

export function isSeasonNotActiveReason(reason?: string | null): boolean {
  return reason?.trim().toLowerCase() === 'season_not_active';
}

/** Account capability copy; asset/market warnings are handled separately. */
export function getCapabilityBlockMessage(
  capabilities:
    | Pick<TradingAccountCapabilities, 'isGeneral'>
    | null
    | undefined,
  reason?: CapabilityBlockReason,
): string | null {
  if (!reason) return null;
  // Legacy display guard only: derived general capabilities never emit this.
  if (capabilities?.isGeneral && reason === 'season_not_active') return null;
  return CAPABILITY_BLOCK_MESSAGE[reason];
}

type CapabilityInput = Pick<TradingAccountDto, 'mode' | 'status' | 'season'>;

function statusBlockReason(
  status: TradingAccountDto['status'],
): CapabilityBlockReason {
  if (status === 'suspended') return 'account_suspended';
  if (status === 'closed') return 'account_closed';
  return null;
}

export function getTradingAccountCapabilities(
  account: CapabilityInput | null | undefined,
  now = Date.now(),
): TradingAccountCapabilities | null {
  if (!account) {
    return null;
  }

  const isSeason = account.mode === 'season';
  const isGeneral = account.mode === 'general';
  const statusBlock = statusBlockReason(account.status);
  const season = isSeason ? account.season : null;
  const seasonActive =
    !!season &&
    season.seasonStatus === 'active' &&
    Date.parse(season.startAt) <= now &&
    now < Date.parse(season.endAt);

  // Status is checked BEFORE mode so a closed general account reads as closed
  // rather than as "not implemented yet" — they are different situations and
  // one of them will never change.
  const tradeBlockReason: CapabilityBlockReason = statusBlock
    ? statusBlock
    : isGeneral
      ? null
      : !seasonActive
        ? 'season_not_active'
        : season?.participantStatus === 'excluded'
          ? 'participant_excluded'
          : season?.participantStatus !== 'active'
            ? 'participant_not_active'
            : null;

  const exchangeBlockReason = tradeBlockReason;

  return {
    mode: account.mode,
    status: account.status,
    isSeason,
    isGeneral,
    canRead: true,
    canTrade: tradeBlockReason === null,
    canQuote: tradeBlockReason === null,
    // Cancelling RELEASES a reservation, so the backend deliberately allows it
    // on suspended and closed accounts. Blocking it in the UI would strand a
    // user's own money behind a screen they can still see.
    canCancelOrder: true,
    canExchange: exchangeBlockReason === null,
    canClaimAdReward: isGeneral && account.status === 'active',
    showsSeasonUi: isSeason,
    tradeBlockReason,
    exchangeBlockReason,
    returnRateMethod: isGeneral ? 'time_weighted' : 'initial_capital',
  };
}

/** Recompute the UX gate when the selected season crosses its next boundary. */
export function nextCapabilityBoundary(
  account: CapabilityInput | null | undefined,
  now = Date.now(),
): number | null {
  if (account?.mode !== 'season' || !account.season) return null;
  const boundaries = [
    Date.parse(account.season.startAt),
    Date.parse(account.season.endAt),
  ].filter((at) => Number.isFinite(at) && at > now);
  return boundaries.length ? Math.min(...boundaries) : null;
}
