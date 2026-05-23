import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type RewardsQuery = {
  limit?: string;
  offset?: string;
};

type RewardsState = 'available' | 'empty';
type RewardType = 'badge' | 'trophy';
type BadgeType = 'tier_badge' | 'ranker_trophy';

type ParsedRewardsQuery = {
  limit: number;
  offset: number;
};

type RewardRow = {
  seasonId: string;
  seasonName: string;
  rewardType: RewardType;
  rewardCode: string;
  rewardName: string;
  grantedAt: Date;
  finalRank: number | null;
  finalTier: string | null;
  createdAt: Date;
};

type UserBadgeRow = {
  badgeId: string;
  badgeType: BadgeType;
  code: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  seasonId: string;
  seasonName: string;
  awardedAt: Date;
  createdAt: Date;
};

type RewardsResponse = {
  success: true;
  data: {
    state: RewardsState;
    items: Array<{
      seasonId: string;
      seasonName: string;
      rewardType: RewardType;
      rewardCode: string;
      rewardName: string;
      grantedAt: string;
      finalRank: number | null;
      finalTier: string | null;
    }>;
    pagination: {
      limit: number;
      offset: number;
      returned: number;
    };
  };
};

type BadgesResponse = {
  success: true;
  data: {
    state: RewardsState;
    items: Array<{
      badgeId: string;
      badgeType: BadgeType;
      code: string;
      name: string;
      description: string | null;
      iconUrl: string | null;
      seasonId: string;
      seasonName: string;
      awardedAt: string;
    }>;
    pagination: {
      limit: number;
      offset: number;
      returned: number;
    };
  };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class RewardsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyRewards(
    userId: string | undefined,
    query: RewardsQuery = {},
  ): Promise<RewardsResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    const rows = await this.prisma.$queryRaw<RewardRow[]>`
      SELECT
        sr."season_id" AS "seasonId",
        s."name" AS "seasonName",
        sr."reward_type" AS "rewardType",
        sr."reward_code" AS "rewardCode",
        sr."reward_name" AS "rewardName",
        sr."granted_at" AS "grantedAt",
        sp."final_rank" AS "finalRank",
        sp."final_tier" AS "finalTier",
        sr."created_at" AS "createdAt"
      FROM "season_rewards" sr
      INNER JOIN "seasons" s ON s."id" = sr."season_id"
      INNER JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      WHERE sr."user_id" = ${userId}
      ORDER BY
        sr."granted_at" DESC,
        sr."created_at" DESC,
        sr."season_id" ASC,
        sr."reward_code" ASC
      LIMIT ${parsedQuery.limit}
      OFFSET ${parsedQuery.offset}
    `;

    return {
      success: true,
      data: {
        state: rows.length > 0 ? 'available' : 'empty',
        items: rows.map((row) => ({
          seasonId: row.seasonId,
          seasonName: row.seasonName,
          rewardType: row.rewardType,
          rewardCode: row.rewardCode,
          rewardName: row.rewardName,
          grantedAt: row.grantedAt.toISOString(),
          finalRank: row.finalRank,
          finalTier: row.finalTier,
        })),
        pagination: {
          limit: parsedQuery.limit,
          offset: parsedQuery.offset,
          returned: rows.length,
        },
      },
    };
  }

  async getMyBadges(
    userId: string | undefined,
    query: RewardsQuery = {},
  ): Promise<BadgesResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    const rows = await this.prisma.$queryRaw<UserBadgeRow[]>`
      SELECT
        b."id" AS "badgeId",
        b."badge_type" AS "badgeType",
        b."code" AS "code",
        b."name" AS "name",
        b."description" AS "description",
        b."icon_url" AS "iconUrl",
        ub."season_id" AS "seasonId",
        s."name" AS "seasonName",
        ub."awarded_at" AS "awardedAt",
        ub."created_at" AS "createdAt"
      FROM "user_badges" ub
      INNER JOIN "badges" b ON b."id" = ub."badge_id"
      INNER JOIN "seasons" s ON s."id" = ub."season_id"
      WHERE ub."user_id" = ${userId}
      ORDER BY
        ub."awarded_at" DESC,
        ub."created_at" DESC,
        ub."season_id" ASC,
        b."code" ASC
      LIMIT ${parsedQuery.limit}
      OFFSET ${parsedQuery.offset}
    `;

    return {
      success: true,
      data: {
        state: rows.length > 0 ? 'available' : 'empty',
        items: rows.map((row) => ({
          badgeId: row.badgeId,
          badgeType: row.badgeType,
          code: row.code,
          name: row.name,
          description: row.description,
          iconUrl: row.iconUrl,
          seasonId: row.seasonId,
          seasonName: row.seasonName,
          awardedAt: row.awardedAt.toISOString(),
        })),
        pagination: {
          limit: parsedQuery.limit,
          offset: parsedQuery.offset,
          returned: rows.length,
        },
      },
    };
  }

  private parseQuery(query: RewardsQuery): ParsedRewardsQuery {
    return {
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    if (!/^\d+$/.test(value)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be a positive integer.',
      );
    }

    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be a positive integer.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) {
      return 0;
    }

    if (!/^\d+$/.test(value)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_OFFSET',
        'offset must be a non-negative integer.',
      );
    }

    const offset = Number(value);
    if (!Number.isSafeInteger(offset)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_OFFSET',
        'offset must be a non-negative integer.',
      );
    }

    return offset;
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      status,
    );
  }
}
