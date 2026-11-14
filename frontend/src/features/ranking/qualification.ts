// Runtime imports carry the .ts extension so `node --test` can load this module.
import { formatKstDateTime } from '../../utils/format.ts';

/**
 * 최종 랭킹 참가 기준 안내 (2026-11-14): what the ranking tab says when the
 * SERVER reports that my participation does not meet the season's final
 * ranking criteria (GET /ranking/qualification, backend
 * docs/season-final-ranking-eligibility.md §7).
 *
 * The server's verdict is the only source: the app never recounts fills,
 * turnover or criteria, and never shows the notice on anything but a
 * well-formed `available` answer with `qualified === false` for the season on
 * screen. No rule (`not_applicable`), not joined, excluded, a failed or
 * malformed read: nothing is shown — a missing answer is never "not met".
 *
 * Before settlement the verdict is provisional (still running, or ended and
 * awaiting settlement); after settlement it is the confirmed one. Money is
 * shown in whole won without ever overstating progress: required and
 * remaining amounts round up, the current amount rounds down.
 */
export type QualificationPhase = 'in_progress' | 'awaiting_settlement' | 'final';

export type QualificationCriterion = {
  required: string;
  current: string;
  /** Still needed; `null` once met. */
  remaining: string | null;
  met: boolean;
};

export type QualificationNotice = {
  phase: QualificationPhase;
  text: string;
  /** The verdict's basis line in the detail sheet. */
  basisLine: string;
  instruments: QualificationCriterion;
  turnover: QualificationCriterion;
  notes: string[];
};

type Dto = Record<string, unknown>;
const MONEY = /^\d+(?:\.\d+)?$/u;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isMoney = (value: unknown): value is string => typeof value === 'string' && MONEY.test(value);

function withSeparators(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Whole won from an 8-place money string, rounded down or up by digits (no float). */
export function wholeWon(value: string, rounding: 'down' | 'up'): string {
  const [, integer = '0', fraction = ''] = /^(\d+)(?:\.(\d+))?$/u.exec(value) ?? [];
  let digits = integer.replace(/^0+(?=\d)/u, '');
  if (rounding === 'up' && /[1-9]/u.test(fraction)) {
    const chars = digits.split('');
    let index = chars.length - 1;
    for (; index >= 0; index--) {
      if (chars[index] === '9') chars[index] = '0';
      else {
        chars[index] = String(Number(chars[index]) + 1);
        break;
      }
    }
    digits = (index < 0 ? '1' : '') + chars.join('');
  }
  return `${withSeparators(digits)}원`;
}

const TEXT: Record<QualificationPhase, string> = {
  in_progress: '최종 랭킹 참가 기준을 아직 충족하지 못했습니다.',
  awaiting_settlement: '최종 랭킹 참가 기준을 충족하지 못했습니다. 정산 후 확정됩니다.',
  final: '최종 랭킹 참가 기준을 충족하지 못해 최종 순위에 포함되지 않았습니다.',
};

/** The notice for one season's answer, or null when nothing may be shown. */
export function qualificationNotice(
  value: unknown,
  seasonId: string | null | undefined,
  nowMs: number,
): QualificationNotice | null {
  if (!value || typeof value !== 'object' || !seasonId) return null;
  const dto = value as Dto;
  const season = dto.season as Dto | null | undefined;
  const criteria = dto.criteria as Dto | null | undefined;
  if (dto.state !== 'available' || !season || season.id !== seasonId || !criteria) return null;
  if (dto.qualified !== false) return null;
  const basis = dto.basis;
  if (basis !== 'provisional' && basis !== 'final') return null;
  const minCount = criteria.minTradedInstrumentCount;
  const minTurnover = criteria.minRecognizedTurnoverKrw;
  const count = dto.tradedInstrumentCount;
  const turnover = dto.recognizedTurnoverKrw;
  const remainingCount = dto.remainingTradedInstrumentCount;
  const remainingTurnover = dto.remainingRecognizedTurnoverKrw;
  const countMet = dto.tradedInstrumentRequirementMet;
  const turnoverMet = dto.turnoverRequirementMet;
  if (
    !isCount(minCount) || minCount < 1 || !isCount(count) || !isCount(remainingCount) ||
    !isMoney(minTurnover) || !isMoney(turnover) || !isMoney(remainingTurnover) ||
    typeof countMet !== 'boolean' || typeof turnoverMet !== 'boolean' ||
    // The server's own fields must agree: a contradictory answer is not shown.
    (countMet && turnoverMet) || countMet !== (remainingCount === 0) ||
    turnoverMet === /[1-9]/u.test(remainingTurnover)
  ) return null;
  const endMs = typeof season.endAt === 'string' ? Date.parse(season.endAt) : Number.NaN;
  let phase: QualificationPhase;
  if (basis === 'final') {
    if (season.status !== 'settled') return null;
    phase = 'final';
  } else {
    if (season.status === 'settled') return null;
    phase = season.status === 'ended' || (Number.isFinite(endMs) && nowMs >= endMs) ? 'awaiting_settlement' : 'in_progress';
  }
  const asOf = typeof dto.asOf === 'string' ? formatKstDateTime(dto.asOf) : '-';
  const basisLine = phase === 'final'
    ? '정산에서 확정된 판정입니다.'
    : phase === 'awaiting_settlement'
      ? '시즌 종료 시점까지의 체결 기준 잠정 판정입니다. 정산 후 확정됩니다.'
      : `${asOf === '-' ? '지금까지' : `${asOf} 기준`}의 체결로 본 잠정 판정입니다.`;
  const notes = [
    '두 기준을 모두 충족해야 최종 순위·티어·순위 보상 대상이 됩니다.',
    ...(phase === 'in_progress'
      ? ['기준을 충족하지 못해도 시즌 중 거래와 잠정 순위·티어 확인은 그대로 할 수 있습니다.']
      : []),
    '인정 거래대금은 현물 체결금액(매수·매도)과 선물 체결 명목가치 ÷ 레버리지를 더한 금액입니다. 수수료·환전·강제청산은 포함되지 않습니다.',
  ];
  return {
    phase,
    text: TEXT[phase],
    basisLine,
    instruments: {
      required: `${minCount}개`,
      current: `${count}개`,
      remaining: countMet ? null : `${remainingCount}개`,
      met: countMet,
    },
    turnover: {
      required: wholeWon(minTurnover, 'up'),
      current: wholeWon(turnover, 'down'),
      remaining: turnoverMet ? null : wholeWon(remainingTurnover, 'up'),
      met: turnoverMet,
    },
    notes,
  };
}

/** Re-read while the tab is on screen and a running season's verdict is still "not met"; never otherwise. */
export const QUALIFICATION_REFRESH_MS = 60_000;
export function qualificationRefreshMs(value: unknown, focused: boolean): number | false {
  const dto = value && typeof value === 'object' ? (value as Dto) : null;
  return focused && dto?.state === 'available' && dto.basis === 'provisional' && dto.qualified === false
    ? QUALIFICATION_REFRESH_MS : false;
}
