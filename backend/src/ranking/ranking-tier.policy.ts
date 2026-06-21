import { Prisma } from '../generated/prisma/client';

export type RankingTier =
  | 'master'
  | 'diamond'
  | 'platinum'
  | 'gold'
  | 'silver'
  | 'bronze';

const TIER_CUTOFF_RULES = [
  { tier: 'master', cumulativeRatio: 0.04 },
  { tier: 'diamond', cumulativeRatio: 0.11 },
  { tier: 'platinum', cumulativeRatio: 0.23 },
  { tier: 'gold', cumulativeRatio: 0.4 },
  { tier: 'silver', cumulativeRatio: 0.7 },
  { tier: 'bronze', cumulativeRatio: 1 },
] as const satisfies readonly {
  tier: RankingTier;
  cumulativeRatio: number;
}[];

export function assignRankingTier(
  rank: number,
  totalParticipants: number,
): RankingTier {
  if (totalParticipants <= 0) {
    return 'bronze';
  }

  for (const rule of TIER_CUTOFF_RULES) {
    const cutoff = Math.max(
      1,
      Math.ceil(totalParticipants * rule.cumulativeRatio),
    );
    if (rank <= cutoff) {
      return rule.tier;
    }
  }

  return 'bronze';
}

export function calculateRankingPercentile(
  rank: number,
  totalParticipants: number,
): Prisma.Decimal {
  if (totalParticipants <= 0) {
    return new Prisma.Decimal(0);
  }

  return new Prisma.Decimal(rank).div(totalParticipants).mul(100);
}
