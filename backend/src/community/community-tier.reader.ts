import { Injectable, Logger } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { assignRankingTier } from '../ranking/ranking-tier.policy';
import { assertSeasonRankingSetScope } from '../ranking/season-ranking-set-scope';
import { publicSeasonWhere } from '../seasons/season-availability.policy';
import { sequential } from './community-sequential';

type Client = Prisma.TransactionClient;

/** Same priority and ordering as the ranking and user season summary. */
const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const PUBLIC_RANKING_PARTICIPANT_WHERE = {
  participantStatus: { not: ParticipantStatus.excluded },
  rankingHiddenAt: null,
} satisfies Prisma.SeasonParticipantWhereInput;
/** A verified set is reused for a minute: a feed page would otherwise
 * verify the whole set on every request. */
const VERIFIED_SET_TTL_MS = 60_000;

function seasonOrderBy(
  status: SeasonStatus,
): Prisma.SeasonFindFirstArgs['orderBy'] {
  switch (status) {
    case SeasonStatus.upcoming:
      return [{ startAt: 'asc' }, { createdAt: 'asc' }];
    case SeasonStatus.ended:
    case SeasonStatus.settled:
      return [{ endAt: 'desc' }, { createdAt: 'desc' }];
    default:
      return [{ startAt: 'desc' }, { createdAt: 'desc' }];
  }
}

/**
 * Community author tiers (docs/community-api-contract.md §3.4): no new tier
 * calculation. The current season's latest public ranking set (final when
 * settled, else daily; the other type when that has none) gives
 * `assignRankingTier(rank, set size)` for daily rows and
 * `finalTier ?? assignRankingTier(...)` for final rows — what the ranking
 * shows. Authors outside the set get null. Constant query count for any
 * number of authors. A set that fails the ranking's integrity verification
 * yields no tiers at all (null), never a tier derived from damage.
 */
@Injectable()
export class CommunityTierReader {
  private readonly logger = new Logger(CommunityTierReader.name);
  private readonly verifiedSets = new Map<string, number>();

  async read(
    client: Client,
    userIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    const tiers = new Map<string, string | null>(
      userIds.map((id) => [id, null]),
    );
    if (userIds.length === 0) return tiers;
    const season = await this.currentSeason(client);
    if (!season) return tiers;
    const preferred =
      season.status === SeasonStatus.settled
        ? SeasonRankingType.final
        : SeasonRankingType.daily;
    const other =
      preferred === SeasonRankingType.final
        ? SeasonRankingType.daily
        : SeasonRankingType.final;
    let rankType = preferred;
    let set = await this.latestSet(client, season.id, preferred);
    if (!set) {
      rankType = other;
      set = await this.latestSet(client, season.id, other);
    }
    if (!set) return tiers;
    const key = {
      seasonId: season.id,
      rankType,
      rankingDate: set.rankingDate,
      capturedAt: set.capturedAt,
    };
    if (!(await this.verified(client, key))) return tiers;
    const where = {
      seasonId: season.id,
      rankType,
      rankingDate: set.rankingDate,
      capturedAt: set.capturedAt,
    };
    const [total, rows] = await sequential([
      () =>
        client.seasonRanking.count({
          where: {
            ...where,
            seasonParticipant: PUBLIC_RANKING_PARTICIPANT_WHERE,
          },
        }),
      () =>
        client.seasonRanking.findMany({
          where: {
            ...where,
            seasonParticipant: {
              ...PUBLIC_RANKING_PARTICIPANT_WHERE,
              userId: { in: [...userIds] },
            },
          },
          select: {
            rank: true,
            seasonParticipant: { select: { userId: true, finalTier: true } },
          },
        }),
    ] as const);
    if (total <= 0) return tiers;
    for (const row of rows) {
      const tier =
        rankType === SeasonRankingType.final
          ? (row.seasonParticipant.finalTier ??
            assignRankingTier(row.rank, total))
          : assignRankingTier(row.rank, total);
      tiers.set(row.seasonParticipant.userId, tier);
    }
    return tiers;
  }

  private async currentSeason(client: Client) {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await client.season.findFirst({
        where: { ...publicSeasonWhere(), status },
        select: { id: true, status: true },
        orderBy: seasonOrderBy(status),
      });
      if (season) return season;
    }
    return null;
  }

  private latestSet(
    client: Client,
    seasonId: string,
    rankType: SeasonRankingType,
  ) {
    return client.seasonRanking.findFirst({
      where: { seasonId, rankType },
      orderBy: [{ rankingDate: 'desc' }, { capturedAt: 'desc' }],
      select: { rankingDate: true, capturedAt: true },
    });
  }

  private async verified(
    client: Client,
    key: {
      seasonId: string;
      rankType: SeasonRankingType;
      rankingDate: Date;
      capturedAt: Date;
    },
  ): Promise<boolean> {
    const cacheKey = [
      key.seasonId,
      key.rankType,
      key.rankingDate.toISOString(),
      key.capturedAt.toISOString(),
    ].join('|');
    const until = this.verifiedSets.get(cacheKey);
    if (until !== undefined && until > Date.now()) return true;
    try {
      await assertSeasonRankingSetScope(client, key);
    } catch {
      this.logger.warn(
        JSON.stringify({ event: 'community_tier_set_unverified' }),
      );
      return false;
    }
    if (this.verifiedSets.size > 32) this.verifiedSets.clear();
    this.verifiedSets.set(cacheKey, Date.now() + VERIFIED_SET_TTL_MS);
    return true;
  }
}
