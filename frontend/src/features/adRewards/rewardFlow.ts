import Decimal from 'decimal.js';
import { getApiErrorInfo } from '../../services/api/errorMapper.ts';
import { formatKrw } from '../../utils/format.ts';
import type {
  AccountResetEligibilityDto,
  AdRewardEligibilityDto,
  GeneralAccountResetBlocker,
} from '../tradingAccount/api';
import type { RewardedAdPurpose } from './rewardedAd';

/**
 * The general home's 보상 sheet (2026-10-20), as pure rules: what may start,
 * what to say, and how to read a failed command. Display and gating only —
 * the server decides every amount, limit, verification and reset.
 */

/** The product's top-up per ad, for copy when the server sends no amount. */
export const GENERAL_AD_REWARD_AMOUNT_KRW = '5000000';
/** The general account's reset target (and opening grant). */
export const GENERAL_ACCOUNT_RESET_TARGET_KRW = '10000000';

export const RESET_BLOCKER_COPY: Record<GeneralAccountResetBlocker, string> = {
  SPOT_HOLDINGS: '보유 중인 종목이 있습니다.',
  FUTURES_POSITIONS: '열려 있는 선물 포지션이 있습니다.',
  OPEN_ORDERS: '체결되지 않은 주문이 있습니다.',
  ACTIVE_CONDITIONAL_ORDERS: '감시 중인 조건주문 또는 손절·익절 설정이 있습니다.',
  RESERVED_FUNDS: '주문에 묶인 자금이 있습니다.',
};

/** 5,000,000 → "500만 원"; amounts that are not whole 만 원 keep their won. */
export function formatManwon(amountKrw: string | null | undefined): string {
  try {
    const value = new Decimal(amountKrw ?? '');
    if (!value.isFinite() || value.lte(0)) return '-';
    return value.mod(10_000).isZero()
      ? `${formatKrw(value.div(10_000).toString())}만 원`
      : `${formatKrw(value.toString())}원`;
  } catch {
    return '-';
  }
}

export type RewardSectionState = {
  /** The action may be started (an ad would be shown). */
  canStart: boolean;
  /** One status line under the section, or null. */
  status: string | null;
};

export type RewardSheetState = {
  /** A provider exists on this device AND the server can verify its ads. */
  adReady: boolean;
  /** "광고 기능 준비 중" while either side is missing. */
  notice: string | null;
  funding: RewardSectionState & { amountLabel: string };
  reset: RewardSectionState & { blockers: string[] };
};

const AD_UNAVAILABLE_REASONS = new Set([
  'AD_REWARD_DISABLED',
  'AD_REWARD_PROVIDER_UNAVAILABLE',
]);

/** 09:05 in KST — built from parts with a 0–23 hour on every engine. */
function kstTime(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  return hour && minute ? `${hour}:${minute}` : null;
}

function fundingStatus(eligibility: AdRewardEligibilityDto): string | null {
  switch (eligibility.reason) {
    case null:
      return eligibility.remainingCountToday > 0
        ? `오늘 ${eligibility.remainingCountToday}회 더 받을 수 있습니다.`
        : null;
    case 'AD_REWARD_DAILY_COUNT_LIMIT':
    case 'AD_REWARD_DAILY_AMOUNT_LIMIT':
      return '오늘 받을 수 있는 가상자금을 모두 받았습니다.';
    case 'AD_REWARD_COOLDOWN_ACTIVE': {
      const at = eligibility.nextEligibleAt ? kstTime(eligibility.nextEligibleAt) : null;
      return at ? `${at} 이후 다시 받을 수 있습니다.` : '잠시 후 다시 받을 수 있습니다.';
    }
    case 'TRADING_ACCOUNT_NOT_ACTIVE':
      return '현재 계정 상태에서는 받을 수 없습니다.';
    default:
      return null;
  }
}

/**
 * What the sheet may offer. Nothing starts without an ad provider on the
 * device, a server that can verify it, and a fresh eligibility answer; a
 * reset additionally needs nothing held or pending (the blockers are listed
 * from that answer, so the user can prepare before watching an ad).
 */
export function rewardSheetState(input: {
  providerReady: boolean;
  funding: AdRewardEligibilityDto | undefined;
  reset: AccountResetEligibilityDto | undefined;
}): RewardSheetState {
  const serverReady =
    !!input.funding &&
    input.funding.enabled &&
    !AD_UNAVAILABLE_REASONS.has(input.funding.reason ?? '');
  const adReady = input.providerReady && serverReady;
  const blockers = (input.reset?.blockers ?? []).map(
    (code) => RESET_BLOCKER_COPY[code] ?? '정리되지 않은 주문이나 자산이 있습니다.',
  );
  return {
    adReady,
    notice: adReady ? null : '광고 기능 준비 중',
    funding: {
      amountLabel: formatManwon(
        input.funding?.rewardAmountKrw ?? GENERAL_AD_REWARD_AMOUNT_KRW,
      ),
      canStart: adReady && input.funding?.eligible === true,
      // Counts and waits only once a reward can actually be watched for.
      status: input.funding && adReady ? fundingStatus(input.funding) : null,
    },
    reset: {
      blockers,
      canStart:
        adReady && input.reset?.eligible === true && blockers.length === 0,
      status:
        input.reset?.reason === 'TRADING_ACCOUNT_NOT_ACTIVE'
          ? '현재 계정 상태에서는 초기화할 수 없습니다.'
          : input.reset?.reason === 'GENERAL_ACCOUNT_RESET_UNAVAILABLE'
            ? '환율 정보를 확인할 수 없어 지금은 초기화할 수 없습니다. 잠시 후 다시 시도해주세요.'
            : null,
    },
  };
}

/**
 * A command whose answer never arrived (network, timeout, a bare 5xx) may
 * still have committed: it is retried with the SAME idempotency key and
 * proof, and the server replays the first result — never re-paid, never
 * reset twice. A coded refusal is final for that attempt.
 */
export function classifyRewardCommandFailure(
  failure: unknown,
): 'uncertain' | 'refused' {
  const info = getApiErrorInfo(failure);
  if (info.serverCode && !GENERIC_SERVER_CODES.has(info.serverCode)) return 'refused';
  if (!info.hasResponse) return 'uncertain';
  return info.status !== null && info.status >= 500 ? 'uncertain' : 'refused';
}

/** Codes that say only "the server failed", not what happened to the command. */
const GENERIC_SERVER_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
]);

/** One attempt of a top-up or reset: the key and proof a retry must reuse. */
export type RewardAttempt = {
  purpose: RewardedAdPurpose;
  idempotencyKey: string;
  proof: string;
  providerKey: string;
};
