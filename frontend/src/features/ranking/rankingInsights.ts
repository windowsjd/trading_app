import Decimal from 'decimal.js';
import { getHomeTier } from '../../screens/home/tierPresentation.ts';
import { formatKrw } from '../../utils/format.ts';
import type { RankingItemDto, RankingsResponseDto } from './api';

/**
 * Rules of the ranking tab's 순위 안내 slot (between 내 순위 and the tabs).
 * No React and no network: useRankingInsights fetches the rows, these
 * functions decide what may be said about them. Every rule fails closed — a
 * message whose inputs do not line up is dropped, never approximated — and
 * every drop has a reason (explainRankingInsights).
 */

export type RankingInsightKey = 'above' | 'first' | 'tier' | 'goal' | 'change';
/** Slot order: 바로 위, 1위, 윗 티어, 수익률 목표, 어제보다. */
export const RANKING_INSIGHT_KEYS: readonly RankingInsightKey[] = ['above', 'first', 'tier', 'goal', 'change'];

/** A smaller second line under the figure (어제보다: the rank move). */
export interface RankingInsightDetail {
  /** Shown; starts with its mark (`▲ 순위 1계단 상승`), and only the mark takes the direction color. */
  text: string;
  /** Read after the figure by screen readers: `순위 1계단 상승`. */
  spoken: string;
  direction?: 'up' | 'down';
}

export interface RankingInsight {
  key: RankingInsightKey;
  /** `바로 위 hana까지`, `Platinum 티어까지`, `어제보다 자산` */
  label: string;
  /** Static figure: `3,389`, `+55,269`, `변동 없음` */
  value: string;
  /** `원`; empty when the figure is a phrase (`변동 없음`). */
  suffix: string;
  /** Decorative mark in the 32px circle. */
  glyph: string;
  /** API tier of the person ahead (tier message): the glyph's palette. */
  tier?: string;
  /** Direction of the figure (change message: my total asset since yesterday). */
  direction?: 'up' | 'down';
  detail?: RankingInsightDetail;
}

/** Why yesterday's standing cannot be compared (previousDayStanding). */
export type PreviousDayMiss =
  | 'no_previous_date'
  | 'not_read'
  | 'no_previous_set'
  | 'no_my_row'
  | 'date_mismatch'
  | 'captured_at_mismatch'
  | 'previous_rank_invalid'
  | 'previous_asset_invalid';

/** Why a message is hidden; `ok` when it is shown. */
export type RankingInsightReason =
  | 'ok'
  | 'my_rank_invalid'
  | 'is_first'
  | 'row_missing_or_rank_gap'
  | 'unknown_tier'
  | 'top_tier'
  | 'edge_mismatch'
  | 'amount_invalid'
  | 'no_initial_capital'
  | PreviousDayMiss
  /** Only useRankingInsights knows this one: the read behind the message failed. */
  | 'fetch_failed';

export type RankingInsightRow = Pick<
  RankingItemDto,
  'rank' | 'userId' | 'nickname' | 'totalAssetKrw' | 'provisionalTier'
>;

/**
 * COPY of backend/src/ranking/ranking-tier.policy.ts (TIER_CUTOFF_RULES). A
 * tier ends at rank `Math.max(1, Math.ceil(N * cumulativeRatio))`; keep the
 * ratios and that exact expression — a float product of another shape can
 * land on a different rank. Fetched rows are checked against it, so a policy
 * change hides the tier message instead of naming the wrong person.
 */
export const RANKING_TIER_CUTOFF_RATIOS = [
  { tier: 'master', cumulativeRatio: 0.04 },
  { tier: 'diamond', cumulativeRatio: 0.11 },
  { tier: 'platinum', cumulativeRatio: 0.23 },
  { tier: 'gold', cumulativeRatio: 0.4 },
  { tier: 'silver', cumulativeRatio: 0.7 },
  { tier: 'bronze', cumulativeRatio: 1 },
] as const;

const tierKey = (tier: string | null | undefined) => tier?.trim().toLowerCase() ?? '';
const tierIndex = (tier: string | null | undefined) =>
  RANKING_TIER_CUTOFF_RATIOS.findIndex((rule) => rule.tier === tierKey(tier));

/** Last rank of every tier, top tier first, for `participants` ranked rows. */
export function rankingTierLastRanks(participants: number): number[] {
  return RANKING_TIER_CUTOFF_RATIOS.map((rule) =>
    Math.max(1, Math.ceil(participants * rule.cumulativeRatio)));
}

/** Last rank of the tier directly above `tier`; null for the top tier or an unknown one. */
export function upperTierLastRank(tier: string | null | undefined, participants: number): number | null {
  const index = tierIndex(tier);
  if (index <= 0 || !Number.isInteger(participants) || participants < 1) return null;
  return Math.max(1, Math.ceil(participants * RANKING_TIER_CUTOFF_RATIOS[index - 1].cumulativeRatio));
}

/** A finite Decimal, or null for anything unreadable. */
function finiteDecimal(value: Decimal.Value | null | undefined): Decimal | null {
  try {
    const decimal = new Decimal(value ?? '');
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/**
 * Whole won still needed to pass `target` from `current`, rounded up (so at
 * least 1). Null when already level or ahead, or when an amount is unreadable.
 */
export function wonToReach(target: Decimal.Value, current: Decimal.Value): Decimal | null {
  let gap: Decimal;
  try {
    gap = new Decimal(target).minus(current);
  } catch {
    return null;
  }
  return gap.isFinite() && gap.greaterThan(0) ? gap.ceil() : null;
}

/**
 * Whole won still needed to pass a person ahead: the gap rounded up (so at
 * least 1), and 1 won on a tie — one more won lifts my return strictly above
 * everyone level with me. Null when they hold less than I do (the ranks
 * disagree with the amounts) or an amount is unreadable.
 */
export function wonToPass(target: Decimal.Value, current: Decimal.Value): Decimal | null {
  const ahead = finiteDecimal(target);
  const mine = finiteDecimal(current);
  if (!ahead || !mine) return null;
  const gap = ahead.minus(mine);
  if (gap.lessThan(0)) return null;
  return gap.isZero() ? new Decimal(1) : gap.ceil();
}

/**
 * My total asset now minus then, rounded to whole won half up (a half won
 * moves away from zero either way). Null when an amount is unreadable.
 */
export function wonChange(current: Decimal.Value, previous: Decimal.Value): Decimal | null {
  const now = finiteDecimal(current);
  const before = finiteDecimal(previous);
  return now && before ? now.minus(before).toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : null;
}

/** Return-rate goals up to +100%; past it the ladder climbs by 50 (150, 200, …). */
export const RETURN_GOAL_STEPS = [-50, -30, -10, 0, 10, 30, 50, 100] as const;
const RETURN_GOAL_CLIMB = 50;

/**
 * The first goal whose asset — initial capital × (1 + goal%) — is STRICTLY
 * above my total asset, decided on Decimal amounts rather than the rounded
 * returnRate. Sitting exactly on a goal moves on to the next one.
 */
export function nextReturnGoal(
  initialCapitalKrw: string | null | undefined,
  totalAssetKrw: string,
): { percent: number; amount: Decimal } | null {
  let initial: Decimal;
  let current: Decimal;
  try {
    initial = new Decimal(initialCapitalKrw ?? '');
    current = new Decimal(totalAssetKrw);
  } catch {
    return null;
  }
  if (!initial.isFinite() || !initial.greaterThan(0) || !current.isFinite()) return null;
  const assetAt = (percent: number) => initial.times(100 + percent).dividedBy(100);
  for (const percent of RETURN_GOAL_STEPS) {
    const amount = wonToReach(assetAt(percent), current);
    if (amount) return { percent, amount };
  }
  // Past the listed goals: estimate the rung from the return, then step up to
  // the first one strictly above (the estimate starts one rung low).
  const top = RETURN_GOAL_STEPS[RETURN_GOAL_STEPS.length - 1];
  const rungs = current.dividedBy(initial).times(100).minus(100 + top).dividedBy(RETURN_GOAL_CLIMB).floor().toNumber();
  let percent = top + RETURN_GOAL_CLIMB * Math.max(0, rungs - 1);
  for (let step = 0; step < 3 && Number.isSafeInteger(percent); step += 1) {
    percent += RETURN_GOAL_CLIMB;
    const amount = wonToReach(assetAt(percent), current);
    if (amount) return { percent, amount };
  }
  return null;
}

const toDateString = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The business date before `rankingDate` (YYYY-MM-DD). Calendar arithmetic
 * only: the date is already a KST business date, so no clock or time zone.
 */
export function previousRankingDate(rankingDate: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rankingDate ?? '');
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  date.setUTCDate(day - 1);
  return toDateString(date);
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Asia/Seoul calendar date of a UTC instant (a fixed +9h; Korea keeps no DST). */
export function kstDateOf(instant: string | null | undefined): string | null {
  const time = Date.parse(instant ?? '');
  return Number.isFinite(time) ? toDateString(new Date(time + KST_OFFSET_MS)) : null;
}

/** My last standing of a past date: rank and total asset in that date's latest daily set. */
export interface PreviousDayStanding {
  rank: number;
  totalAssetKrw: string;
}

/**
 * My standing at the end of `previousDate`, read from that date's latest
 * daily set, or why it cannot be compared. Sets stored before 2026-10-14 are
 * filed under their UTC date; a set whose capture time is not on the KST
 * `previousDate` would compare another moment, so it is not used.
 */
export function previousDayStanding(
  response: RankingsResponseDto | null | undefined,
  previousDate: string | null,
): PreviousDayStanding | PreviousDayMiss {
  if (!previousDate) return 'no_previous_date';
  if (!response) return 'not_read';
  if (response.state !== 'available') return 'no_previous_set';
  const mine = response.myRanking;
  if (mine?.state !== 'available') return 'no_my_row';
  if (mine.rankingDate !== previousDate) return 'date_mismatch';
  if (kstDateOf(mine.capturedAt) !== previousDate) return 'captured_at_mismatch';
  if (!Number.isInteger(mine.rank) || mine.rank < 1) return 'previous_rank_invalid';
  if (!finiteDecimal(mine.totalAssetKrw)) return 'previous_asset_invalid';
  return { rank: mine.rank, totalAssetKrw: mine.totalAssetKrw };
}

/** Steps moved since yesterday (`{ steps: 0 }` when unchanged); null when a rank is unknown. */
export function rankChange(
  todayRank: number,
  previousRank: number | null,
): { steps: number; direction?: 'up' | 'down' } | null {
  const valid = (rank: number | null): rank is number => rank !== null && Number.isInteger(rank) && rank > 0;
  if (!valid(todayRank) || !valid(previousRank)) return null;
  if (todayRank === previousRank) return { steps: 0 };
  return { steps: Math.abs(previousRank - todayRank), direction: todayRank < previousRank ? 'up' : 'down' };
}

export interface RankingInsightInput {
  /** My row of the current daily set. */
  me: { rank: number; totalAssetKrw: string; provisionalTier: string | null };
  /** Ranked rows of the set (`pagination.total` of scope all): the tier denominator. */
  participants: number;
  /** The row ranked 1. */
  first: RankingInsightRow | null;
  /** The row ranked directly above me. */
  above: RankingInsightRow | null;
  /** Rows at the upper tier's last rank `b` and at `b + 1`. */
  tierEdge: readonly [RankingInsightRow | null, RankingInsightRow | null] | null;
  initialCapitalKrw?: string | null;
  /** My standing at the end of yesterday, or why there is none (previousDayStanding). */
  previous: PreviousDayStanding | PreviousDayMiss;
}

type Me = RankingInsightInput['me'];
/** A message, or the reason it is hidden. */
type Decision = RankingInsight | Exclude<RankingInsightReason, 'ok'>;

/**
 * The person ahead of me in the next tier up and that tier's display name.
 * Rank b must be another tier and rank b + 1 mine — the edge has to sit where
 * the copied policy puts it, or the policy moved and nothing is said.
 */
function upperTierTarget(
  me: Me,
  participants: number,
  edge: RankingInsightInput['tierEdge'],
): { row: RankingInsightRow; tier: string; name: string } | 'unknown_tier' | 'top_tier' | 'row_missing_or_rank_gap' | 'edge_mismatch' {
  const index = tierIndex(me.provisionalTier);
  if (index < 0) return 'unknown_tier';
  if (index === 0) return 'top_tier';
  const last = upperTierLastRank(me.provisionalTier, participants);
  // My rank inside the upper tier means my tier and the copied policy disagree.
  if (last === null || me.rank <= last) return 'edge_mismatch';
  const [ahead, behind] = edge ?? [null, null];
  if (ahead?.rank !== last || behind?.rank !== last + 1) return 'row_missing_or_rank_gap';
  if (!ahead.provisionalTier || tierKey(behind.provisionalTier) !== tierKey(me.provisionalTier)
    || tierKey(ahead.provisionalTier) === tierKey(me.provisionalTier)) return 'edge_mismatch';
  // The row's own tier: an empty tier in between is skipped, not named. Tier
  // names are the same in both appearance modes.
  const name = getHomeTier(ahead.provisionalTier, 'light')?.name;
  return name ? { row: ahead, tier: ahead.provisionalTier, name } : 'edge_mismatch';
}

function towardPerson(me: Me, key: RankingInsightKey, row: RankingInsightRow, label: string, glyph: string,
  tier?: string): Decision {
  const amount = wonToPass(row.totalAssetKrw, me.totalAssetKrw);
  return amount
    ? { key, label, value: formatKrw(amount.toFixed(0)), suffix: '원', glyph, ...(tier ? { tier } : {}) }
    : 'amount_invalid';
}

const MARK = { up: '▲', down: '▼', same: '–' } as const;

function changeInsight(me: Me, previous: RankingInsightInput['previous']): Decision {
  if (typeof previous === 'string') return previous;
  if (!finiteDecimal(previous.totalAssetKrw)) return 'previous_asset_invalid';
  const won = wonChange(me.totalAssetKrw, previous.totalAssetKrw);
  if (!won) return 'amount_invalid';
  const moved = rankChange(me.rank, previous.rank);
  if (!moved) return 'previous_rank_invalid';
  const direction = won.greaterThan(0) ? 'up' : won.lessThan(0) ? 'down' : undefined;
  const rank = moved.direction ? `순위 ${moved.steps}계단 ${moved.direction === 'up' ? '상승' : '하락'}` : '순위 변동 없음';
  return {
    key: 'change',
    label: '어제보다 자산',
    value: direction ? `${direction === 'up' ? '+' : '-'}${formatKrw(won.abs().toFixed(0))}` : '변동 없음',
    suffix: direction ? '원' : '',
    glyph: MARK[direction ?? 'same'],
    ...(direction ? { direction } : {}),
    detail: { text: `${MARK[moved.direction ?? 'same']} ${rank}`, spoken: rank,
      ...(moved.direction ? { direction: moved.direction } : {}) },
  };
}

/**
 * Every message or the reason it is hidden, decided once for both
 * buildRankingInsights and explainRankingInsights. Each message stands alone:
 * when 바로 위, 1위 and the upper tier's edge are one person (2위, or the first
 * rank of a tier) every one of them is still shown, with the same amount.
 */
function decideRankingInsights(input: RankingInsightInput): Record<RankingInsightKey, Decision> {
  const { me, participants, first, above, tierEdge, initialCapitalKrw, previous } = input;
  if (!Number.isInteger(me.rank) || me.rank < 1) {
    return { above: 'my_rank_invalid', first: 'my_rank_invalid', tier: 'my_rank_invalid', goal: 'my_rank_invalid',
      change: 'my_rank_invalid' };
  }
  const tier = upperTierTarget(me, participants, tierEdge);
  const goal = nextReturnGoal(initialCapitalKrw, me.totalAssetKrw);
  return {
    above: me.rank === 1 ? 'is_first'
      : above?.rank !== me.rank - 1 ? 'row_missing_or_rank_gap'
        : towardPerson(me, 'above', above, `바로 위 ${above.nickname}까지`, '↑'),
    first: me.rank === 1 ? 'is_first'
      : first?.rank !== 1 ? 'row_missing_or_rank_gap'
        : towardPerson(me, 'first', first, `1위 ${first.nickname}까지`, '1'),
    tier: typeof tier === 'string' ? tier
      : towardPerson(me, 'tier', tier.row, `${tier.name} 티어까지`, tier.name.charAt(0), tier.tier),
    goal: !finiteDecimal(initialCapitalKrw)?.greaterThan(0) ? 'no_initial_capital'
      : !goal ? 'amount_invalid'
        : {
          key: 'goal',
          label: goal.percent === 0 ? '본전까지' : `수익률 ${goal.percent}%까지`,
          value: formatKrw(goal.amount.toFixed(0)),
          suffix: '원',
          glyph: goal.percent === 0 ? '0%' : '%',
        },
    change: changeInsight(me, previous),
  };
}

/** The slot's messages in order: 바로 위, 1위, 윗 티어, 수익률 목표, 어제보다. */
export function buildRankingInsights(input: RankingInsightInput): RankingInsight[] {
  const decided = decideRankingInsights(input);
  return RANKING_INSIGHT_KEYS.map((key) => decided[key])
    .filter((decision): decision is RankingInsight => typeof decision !== 'string');
}

export type RankingInsightExplanation = Record<RankingInsightKey, { shown: boolean; reason: RankingInsightReason }>;

/** Per message: shown, or why not. Same decisions as buildRankingInsights; it never changes what is shown. */
export function explainRankingInsights(input: RankingInsightInput): RankingInsightExplanation {
  const decided = decideRankingInsights(input);
  const explain = (decision: Decision) =>
    typeof decision === 'string' ? { shown: false, reason: decision } : { shown: true, reason: 'ok' as const };
  return {
    above: explain(decided.above),
    first: explain(decided.first),
    tier: explain(decided.tier),
    goal: explain(decided.goal),
    change: explain(decided.change),
  };
}

/** One screen-reader sentence list for every message (the slot itself never announces rotation). */
export function describeRankingInsights(messages: readonly RankingInsight[]): string {
  return ['순위 안내', ...messages.map((message) =>
    `${message.label} ${message.value}${message.suffix}${message.detail ? `, ${message.detail.spoken}` : ''}`)]
    .join('. ') + '.';
}
