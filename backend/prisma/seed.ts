import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from '../scripts/lib/load-runtime-env';
import {
  ensureDevBaselineParticipant,
  ensureDevSeasonOpen,
} from '../scripts/lib/dev-baseline';

/**
 * NON-DESTRUCTIVE development seed.
 *
 * This used to reset the season to a closed window and overwrite participant
 * financials and wallet balances on every run, which fought `dev:open-season`
 * and could wipe local trading state. It now delegates to the shared,
 * create-if-absent dev baseline: the season is kept active (2000-2099) and the
 * dev user / participant / wallets / initial grant are created only when
 * missing. Existing balances, ledgers, ranks, and orders are never touched.
 *
 * Env is loaded exactly like the running backend (.env.local > .env.development
 * > .env) so `prisma db seed` targets the same database.
 */

loadRuntimeEnv();

const adapter = new PrismaPg({
  connectionString: requireDatabaseUrl(),
});

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(
    `Seed target DB: ${formatDatabaseTarget(process.env.DATABASE_URL)}`,
  );

  const season = await ensureDevSeasonOpen({ prisma, apply: true });
  console.log(
    `Season ${season.seasonId}: ${season.action} (status=${season.status}, ${season.startAt} -> ${season.endAt})`,
  );
  for (const other of season.otherActiveSeasons) {
    console.warn(
      `Warning: other active season left unmodified: ${other.id} / ${other.name}`,
    );
  }

  const baseline = await ensureDevBaselineParticipant({ prisma, apply: true });
  console.log(
    `Dev user: ${baseline.userAction}; participant: ${baseline.participantAction}` +
      ` (walletsCreated=${baseline.walletsCreated}, grantCreated=${baseline.grantCreated})`,
  );
  for (const note of baseline.notes) {
    console.log(`- ${note}`);
  }

  console.log('seed completed (non-destructive)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
