import { config as loadDotenv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, SeasonStatus } from '../src/generated/prisma/client';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env.development', quiet: true });
loadDotenv({ quiet: true });

const DEV_SEASON_ID = 'sea_2026_s1';
const DEV_SEASON_START_AT = new Date('2000-01-01T00:00:00.000Z');
const DEV_SEASON_END_AT = new Date('2099-12-31T23:59:59.000Z');

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  return databaseUrl;
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: requireDatabaseUrl(),
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const otherActiveSeasons = await prisma.season.findMany({
      where: {
        status: SeasonStatus.active,
        id: {
          not: DEV_SEASON_ID,
        },
      },
      orderBy: {
        startAt: 'asc',
      },
      select: {
        id: true,
        name: true,
        startAt: true,
        endAt: true,
      },
    });

    if (otherActiveSeasons.length > 0) {
      console.warn(
        `Warning: found ${otherActiveSeasons.length} other active season(s). They were not modified.`,
      );
      for (const season of otherActiveSeasons) {
        console.warn(
          `- ${season.id} / ${season.name} / startAt=${season.startAt.toISOString()} / endAt=${season.endAt.toISOString()}`,
        );
      }
    }

    const season = await prisma.season.upsert({
      where: {
        id: DEV_SEASON_ID,
      },
      update: {
        name: 'Season 1',
        status: SeasonStatus.active,
        startAt: DEV_SEASON_START_AT,
        endAt: DEV_SEASON_END_AT,
        initialCapitalKrw: '10000000.00000000',
        tradeFeeRate: '0.001000',
        fxFeeRate: '0.001000',
      },
      create: {
        id: DEV_SEASON_ID,
        name: 'Season 1',
        status: SeasonStatus.active,
        startAt: DEV_SEASON_START_AT,
        endAt: DEV_SEASON_END_AT,
        initialCapitalKrw: '10000000.00000000',
        tradeFeeRate: '0.001000',
        fxFeeRate: '0.001000',
      },
    });

    console.log('Development season is open.');
    console.log(
      `- ${season.id} / ${season.name} / ${season.status} / startAt=${season.startAt.toISOString()} / endAt=${season.endAt.toISOString()}`,
    );

    const activeSeasons = await prisma.season.findMany({
      where: {
        status: SeasonStatus.active,
      },
      orderBy: {
        startAt: 'asc',
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });

    console.log('Active seasons');
    for (const activeSeason of activeSeasons) {
      console.log(
        `- ${activeSeason.id} / ${activeSeason.name} / ${activeSeason.status} / startAt=${activeSeason.startAt.toISOString()} / endAt=${activeSeason.endAt.toISOString()}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`dev open season failed: ${error.message}`);
      return;
    }

    console.error('dev open season failed.');
  });
}
