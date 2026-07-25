import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, SeasonStatus } from '../src/generated/prisma/client';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import { ensureDevSeasonOpen } from './lib/dev-baseline';

/**
 * Open the local development season `sea_2026_s1` as always active
 * (2000-2099). Thin CLI over the shared, non-destructive `ensureDevSeasonOpen`;
 * `--dry-run` reports the intended action without writing. Env is loaded like
 * the backend so it targets the same DB.
 */

async function main(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  loadRuntimeEnv();

  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`Target DB: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);

    const result = await ensureDevSeasonOpen({ prisma, apply: !dryRun });

    for (const other of result.otherActiveSeasons) {
      console.warn(
        `Warning: other active season left unmodified: ${other.id} / ${other.name} / startAt=${other.startAt} / endAt=${other.endAt}`,
      );
    }

    console.log(
      `Development season ${result.seasonId}: ${result.action} (status=${result.status}, startAt=${result.startAt}, endAt=${result.endAt})`,
    );

    const activeSeasons = await prisma.season.findMany({
      where: { status: SeasonStatus.active },
      orderBy: { startAt: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
    console.log('Active seasons:');
    for (const season of activeSeasons) {
      console.log(
        `- ${season.id} / ${season.name} / ${season.status} / startAt=${season.startAt.toISOString()} / endAt=${season.endAt.toISOString()}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`dev open season failed: ${error.message}`);
      return;
    }

    console.error('dev open season failed.');
  });
}
