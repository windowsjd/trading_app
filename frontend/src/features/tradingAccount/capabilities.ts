import type { TradingAccountDto } from './api';

/**
 * What the SELECTED account can actually do (작업 9 §B-7 · §B-8).
 *
 * Deliberately a small derived record, not a feature framework. It answers the
 * two questions the UI keeps asking — "may I show this control as usable?" and
 * "why not?" — from the two facts the backend gates on: `mode` and `status`.
 *
 * WHY THE FRONTEND MIRRORS SERVER GATES AT ALL
 * -------------------------------------------
 * The server is still authoritative and still refuses; nothing here can enable
 * anything. What this prevents is a UI that renders a live-looking Buy button
 * whose only possible outcome is a 409. Letting a user press it and reading
 * them an error is not "server-authoritative", it is a broken screen.
 *
 * Equally, this NEVER relaxes a gate: `canTrade` is false whenever the server
 * would refuse, and there is no path that turns a general account into a
 * tradable one. General-mode trading and FX are not implemented in the backend
 * (409 `GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED` /
 * `GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`) and are presented as "준비 중", not as
 * failures.
 */

export type CapabilityBlockReason =
  | 'general_trading_not_implemented'
  | 'general_fx_not_implemented'
  | 'account_suspended'
  | 'account_closed'
  | 'season_not_active'
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
  general_trading_not_implemented:
    '일반 투자 계정의 매매 기능은 아직 준비 중입니다. 현재는 잔고와 수익률 조회만 지원합니다.',
  general_fx_not_implemented:
    '일반 투자 계정의 환전 기능은 아직 준비 중입니다.',
  account_suspended:
    '일시정지된 계정입니다. 조회는 가능하지만 새 주문과 환전은 할 수 없습니다.',
  account_closed:
    '종료된 계정입니다. 과거 기록은 조회만 가능하며 새 거래는 할 수 없습니다.',
  season_not_active: '현재 거래 가능한 시즌이 아닙니다.',
};

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
): TradingAccountCapabilities | null {
  if (!account) {
    return null;
  }

  const isSeason = account.mode === 'season';
  const isGeneral = account.mode === 'general';
  const statusBlock = statusBlockReason(account.status);
  const seasonActive = account.season?.seasonStatus === 'active';

  // Status is checked BEFORE mode so a closed general account reads as closed
  // rather than as "not implemented yet" — they are different situations and
  // one of them will never change.
  const tradeBlockReason: CapabilityBlockReason = statusBlock
    ? statusBlock
    : isGeneral
      ? 'general_trading_not_implemented'
      : seasonActive
        ? null
        : 'season_not_active';

  const exchangeBlockReason: CapabilityBlockReason = statusBlock
    ? statusBlock
    : isGeneral
      ? 'general_fx_not_implemented'
      : seasonActive
        ? null
        : 'season_not_active';

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
    canCancelOrder: isSeason,
    canExchange: exchangeBlockReason === null,
    canClaimAdReward: isGeneral && account.status === 'active',
    showsSeasonUi: isSeason,
    tradeBlockReason,
    exchangeBlockReason,
    returnRateMethod: isGeneral ? 'time_weighted' : 'initial_capital',
  };
}
