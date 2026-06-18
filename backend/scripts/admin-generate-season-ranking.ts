import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  OrderStatus,
  SeasonRankingType,
} from '../src/generated/prisma/client';
import { writeSeasonRankings } from '../src/portfolio/season-ranking-generation';
import { buildRankingRowsForSnapshots } from '../src/ranking/ranking-calculation.policy';

type SeasonRankingCliArgs = {
  seasonId?: string;
  rankingDate?: string;
  rankType?: string;
  dryRun?: boolean;
};

type CliValueOptionName = Exclude<keyof SeasonRankingCliArgs, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--season-id': 'seasonId',
  '--ranking-date': 'rankingDate',
  '--rank-type': 'rankType',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseSeasonRankingCliArgs(
  argv: string[],
): SeasonRankingCliArgs {
  const parsed: SeasonRankingCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    const booleanName = BOOLEAN_OPTIONS[option];
    if (booleanName) {
      parsed.dryRun = true;
      continue;
    }

    const valueName = VALUE_OPTIONS[option];
    if (!valueName) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    parsed[valueName] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

export async function runAdminGenerateSeasonRanking(argv: string[]) {
  const args = parseSeasonRankingCliArgs(argv);
  const seasonId = parseRequiredText(args.seasonId, 'season-id');
  const rankingDate = parseDateOnly(args.rankingDate, 'ranking-date');
  const rankType = parseRankType(args.rankType);
  const capturedAt = new Date();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const snapshots = await prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: rankingDate,
        seasonParticipant: {
          seasonId,
        },
      },
      select: {
        seasonParticipantId: true,
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (snapshots.length === 0) {
      throw new Error('No daily portfolio snapshots found for rankingDate.');
    }

    const latestCapturedAt = snapshots.reduce<Date | null>(
      (latest, snapshot) =>
        latest === null || snapshot.capturedAt.getTime() > latest.getTime()
          ? snapshot.capturedAt
          : latest,
      null,
    );
    const [historicalSnapshots, executedOrders] = await Promise.all([
      prisma.dailyPortfolioSnapshot.findMany({
        where: {
          snapshotDate: {
            lte: rankingDate,
          },
          seasonParticipant: {
            seasonId,
          },
        },
        select: {
          seasonParticipantId: true,
          snapshotDate: true,
          totalAssetKrw: true,
          returnRate: true,
          capturedAt: true,
          createdAt: true,
        },
      }),
      prisma.order.findMany({
        where: {
          status: OrderStatus.executed,
          executedAt: {
            not: null,
            lte: latestCapturedAt ?? capturedAt,
          },
          seasonParticipant: {
            seasonId,
          },
        },
        select: {
          seasonParticipantId: true,
          executedAt: true,
        },
      }),
    ]);
    const rows = buildRankingRowsForSnapshots({
      rankingSnapshots: snapshots.map((snapshot) => ({
        seasonParticipantId: snapshot.seasonParticipantId,
        userId: snapshot.seasonParticipant.userId,
        snapshotDate: snapshot.snapshotDate,
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
        capturedAt: snapshot.capturedAt,
        createdAt: snapshot.createdAt,
      })),
      historicalSnapshots,
      executedOrders,
    });
    const writeResult = await writeSeasonRankings(prisma, {
      seasonId,
      rankType,
      rankingDate,
      capturedAt,
      rows,
      dryRun: args.dryRun === true,
    });

    console.log(
      args.dryRun
        ? 'season ranking dry-run completed'
        : 'season ranking generation completed',
    );
    console.log(
      JSON.stringify(
        {
          seasonId,
          rankingDate: formatDateOnly(rankingDate),
          rankType,
          capturedAt: capturedAt.toISOString(),
          rankings: writeResult,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseRankType(value: string | undefined): SeasonRankingType {
  const text = value?.trim() || SeasonRankingType.daily;

  if (text === SeasonRankingType.daily || text === SeasonRankingType.final) {
    return text;
  }

  throw new Error(`Invalid --rank-type: ${text}.`);
}

function parseDateOnly(value: string | undefined, fieldName: string): Date {
  const text = parseRequiredText(value, fieldName);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Invalid --${fieldName}: must be YYYY-MM-DD.`);
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateOnly(date) !== text) {
    throw new Error(`Invalid --${fieldName}: must be YYYY-MM-DD.`);
  }

  return date;
}

function parseRequiredText(
  value: string | undefined,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or empty --${fieldName}.`);
  }

  return value.trim();
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

if (require.main === module) {
  runAdminGenerateSeasonRanking(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.exitCode = 1;

      if (error instanceof Error) {
        console.error(`season ranking generation failed: ${error.message}`);
        return;
      }

      console.error('season ranking generation failed.');
    },
  );
}
