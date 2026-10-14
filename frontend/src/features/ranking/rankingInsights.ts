import Decimal from 'decimal.js';
import { getHomeTier } from '../../screens/home/tierPresentation.ts';
import { formatKrw } from '../../utils/format.ts';
import type { RankingItemDto, RankingsResponseDto } from './api';

/**
 * Rules of the ranking tab's 순위 안내 slot (between 내 순위 and the tabs).
 * No React and no network: useRankingInsights fetches the rows, these
 * functions decide what may be said about them. Every rule fails closed — a
 * message whose inputs do not line up is dropped, never approximated.
 */

export type RankingInsightKey = 'above' | 'first' | 'tier' | 'goal' | 'change';

export interface RankingInsight {
  key: RankingInsightKey;
  /** `바로 위 hana까지`, `Platinum 티어까지`, `어제보다` */
  label: string;
  /** Static figure: `3,389`, `4` */
  value: string;
  /** `원`, `계단 상승`, `계단 하락` */
  suffix: string;
  /** Decorative mark in the 32px circle. */
  glyph: string;
  /** API tier of the person ahead (tier message): the glyph's palette. */
  tier?: string;
  /** Rank direction since yesterday (change message). */
  direction?: 'up' | 'down';
}

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

/** Last rank of every tier, top tier first, for `participants` ranked rows. */
export function rankingTierLastRanks(participants: number): number[] {
  return RANKING_TIER_CUTOFF_RATIOS.map((rule) =>
    Math.max(1, Math.ceil(participants * rule.cumulativeRatio)));
}

/** Last rank of the tier directly above `tier`; null for the top tier or an unknown one. */
export function upperTierLastRank(tier: string | null | undefined, participants: number): number | null {
  const index = RANKING_TIER_CUTOFF_RATIOS.findIndex((rule) => rule.tier === tierKey(tier));
  if (index <= 0 || !Number.isInteger(participants) || participants < 1) return null;
  return Math.max(1, Math.ceil(participants * RANKING_TIER_CUTOFF_RATIOS[index - 1].cumulativeRatio));
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

/**
 * My final rank of `previousDate`, read from that date's latest daily set.
 * Sets stored before 2026-10-14 are filed under their UTC date; a set whose
 * capture time is not on the KST `previousDate` would compare another moment,
 * so it is not used.
 */
export function previousDayRank(
  response: RankingsResponseDto | null | undefined,
  previousDate: string | null,
): number | null {
  const mine = response?.state === 'available' ? response.myRanking : null;
  if (!previousDate || mine?.state !== 'available') return null;
  if (mine.rankingDate !== previousDate || kstDateOf(mine.capturedAt) !== previousDate) return null;
  return Number.isInteger(mine.rank) && mine.rank > 0 ? mine.rank : null;
}

/** Steps moved since yesterday; null when unchanged or unknown. */
export function rankChange(
  todayRank: number,
  previousRank: number | null,
): { steps: number; direction: 'up' | 'down' } | null {
  const valid = (rank: number | null): rank is number => rank !== null && Number.isInteger(rank) && rank > 0;
  if (!valid(todayRank) || !valid(previousRank) || todayRank === previousRank) return null;
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
  /** My final rank yesterday (previousDayRank). */
  previousRank: number | null;
}

/**
 * The person ahead of me in the next tier up and that tier's display name.
 * Rank b must be another tier and rank b + 1 mine — the edge has to sit where
 * the copied policy puts it, or the policy moved and nothing is said.
 */
function upperTierTarget(
  me: RankingInsightInput['me'],
  participants: number,
  edge: RankingInsightInput['tierEdge'],
): { row: RankingInsightRow; tier: string; name: string } | null {
  const last = upperTierLastRank(me.provisionalTier, participants);
  if (last === null || me.rank <= last || !edge) return null;
  const [ahead, behind] = edge;
  if (ahead?.rank !== last || behind?.rank !== last + 1 || !ahead.provisionalTier) return null;
  if (tierKey(behind.provisionalTier) !== tierKey(me.provisionalTier)
    || tierKey(ahead.provisionalTier) === tierKey(me.provisionalTier)) return null;
  // The row's own tier: an empty tier in between is skipped, not named. Tier
  // names are the same in both appearance modes.
  const name = getHomeTier(ahead.provisionalTier, 'light')?.name;
  return name ? { row: ahead, tier: ahead.provisionalTier, name } : null;
}

type PersonKey = 'above' | 'first' | 'tier';
/** One person behind several messages keeps one: 1위 > 윗 티어 > 바로 위. */
const PERSON_PRIORITY: Record<PersonKey, number> = { first: 0, tier: 1, above: 2 };
const SLOT_ORDER: Record<RankingInsightKey, number> = { above: 0, first: 1, tier: 2, goal: 3, change: 4 };

type PersonMessage = { userId: string; order: number; priority: number; message: RankingInsight };

/**
 * The slot's messages in order: 바로 위, 1위, 윗 티어, 수익률 목표, 어제보다.
 * Messages about one person merge into the highest-priority label, placed at
 * the earliest position of that group.
 */
export function buildRankingInsights(input: RankingInsightInput): RankingInsight[] {
  const { me, participants, first, above, tierEdge, initialCapitalKrw, previousRank } = input;
  if (!Number.isInteger(me.rank) || me.rank < 1) return [];
  const toward = (key: PersonKey, row: RankingInsightRow, label: string, glyph: string, tier?: string): PersonMessage | null => {
    const amount = wonToReach(row.totalAssetKrw, me.totalAssetKrw);
    return amount ? {
      userId: row.userId,
      order: SLOT_ORDER[key],
      priority: PERSON_PRIORITY[key],
      message: { key, label, value: formatKrw(amount.toFixed(0)), suffix: '원', glyph, ...(tier ? { tier } : {}) },
    } : null;
  };

  const tierTarget = upperTierTarget(me, participants, tierEdge);
  const people = [
    above && me.rank > 1 && above.rank === me.rank - 1
      ? toward('above', above, `바로 위 ${above.nickname}까지`, '↑') : null,
    first && me.rank > 1 && first.rank === 1
      ? toward('first', first, `1위 ${first.nickname}까지`, '1') : null,
    tierTarget
      ? toward('tier', tierTarget.row, `${tierTarget.name} 티어까지`, tierTarget.name.charAt(0), tierTarget.tier) : null,
  ].filter((person): person is PersonMessage => person !== null);

  const placed: Array<{ order: number; message: RankingInsight }> = [];
  for (const userId of new Set(people.map((person) => person.userId))) {
    const group = people.filter((person) => person.userId === userId);
    placed.push({
      order: Math.min(...group.map((person) => person.order)),
      message: group.reduce((best, person) => (person.priority < best.priority ? person : best)).message,
    });
  }

  const goal = nextReturnGoal(initialCapitalKrw, me.totalAssetKrw);
  if (goal) {
    placed.push({ order: SLOT_ORDER.goal, message: {
      key: 'goal',
      label: goal.percent === 0 ? '본전(수익률 0%)까지' : `수익률 ${goal.percent}%까지`,
      value: formatKrw(goal.amount.toFixed(0)),
      suffix: '원',
      glyph: goal.percent === 0 ? '0%' : '%',
    } });
  }

  const change = rankChange(me.rank, previousRank);
  if (change) {
    placed.push({ order: SLOT_ORDER.change, message: {
      key: 'change',
      label: '어제보다',
      value: String(change.steps),
      suffix: change.direction === 'up' ? '계단 상승' : '계단 하락',
      glyph: change.direction === 'up' ? '▲' : '▼',
      direction: change.direction,
    } });
  }

  return placed.sort((a, b) => a.order - b.order).map((entry) => entry.message);
}

/** One screen-reader sentence list for every message (the slot itself never announces rotation). */
export function describeRankingInsights(messages: readonly RankingInsight[]): string {
  return ['순위 안내', ...messages.map((message) => `${message.label} ${message.value}${message.suffix}`)].join('. ') + '.';
}
