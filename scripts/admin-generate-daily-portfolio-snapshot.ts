import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ParticipantStatus,
  PrismaClient,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DailyPortfolioSnapshotWriteResult,
  writeDailyPortfolioSnapshot,
} from '../src/portfolio/daily-portfolio-snapshot-generation';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';

type DailyPortfolioSnapshotCliArgs = {
  seasonParticipantId?: string;
  seasonId?: string;
  snapshotDate?: string;
  capturedAt?: string;
  dryRun?: boolean;
};

type CliValueOptionName = Exclude<
  keyof DailyPortfolioSnapshotCliArgs,
  'dryRun'
>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--season-participant-id': 'seasonParticipantId',
  '--season-id': 'seasonId',
  '--snapshot-date': 'snapshotDate',
  '--captured-at': 'capturedAt',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseDailyPortfolioSnapshotCliArgs(
  argv: string[],
): DailyPortfolioSnapshotCliArgs {
  const parsed: DailyPortfolioSnapshotCliArgs = {};

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

export async function runAdminGenerateDailyPortfolioSnapshot(argv: string[]) {
  const args = parseDailyPortfolioSnapshotCliArgs(argv);
  const snapshotDate = parseDateOnly(args.snapshotDate, 'snapshot-date');
  const capturedAt = args.capturedAt
    ? parseUtcIsoDateTime(args.capturedAt, 'captured-at')
    : new Date();

  if (!args.seasonParticipantId && !args.seasonId) {
    throw new Error('Provide --season-participant-id or --season-id.');
  }

  if (args.seasonParticipantId && args.seasonId) {
    throw new Error('Use either --season-participant-id or --season-id.');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const valuationService = new PortfolioValuationService(
    prisma as unknown as PrismaService,
  );

  try {
    const participantIds = args.seasonParticipantId
      ? [args.seasonParticipantId]
      : await findActiveSeasonParticipantIds(prisma, args.seasonId as string);

    if (participantIds.length === 0) {
      throw new Error('No active season participants found.');
    }

    const successes: DailyPortfolioSnapshotWriteResult[] = [];
    const failures: Array<{ seasonParticipantId: string; error: string }> = [];

    for (const seasonParticipantId of participantIds) {
      try {
        const valuation =
          await valuationService.calculateSeasonParticipantValuation(
            seasonParticipantId,
            capturedAt,
          );
        const writeResult = await writeDailyPortfolioSnapshot(prisma, {
          valuation,
          snapshotDate,
          capturedAt,
          dryRun: args.dryRun === true,
        });

        successes.push(writeResult);
      } catch (error) {
        const failure = {
          seasonParticipantId,
          error: error instanceof Error ? error.message : 'Unknown error.',
        };

        if (args.seasonParticipantId) {
          throw new Error(
            `Daily portfolio snapshot generation failed for ${seasonParticipantId}: ${failure.error}`,
          );
        }

        failures.push(failure);
      }
    }

    if (successes.length === 0) {
      throw new Error('Daily portfolio snapshot generation produced no rows.');
    }

    console.log(
      args.dryRun
        ? 'daily portfolio snapshot dry-run completed'
        : 'daily portfolio snapshot generation completed',
    );
    console.log(
      JSON.stringify(
        {
          snapshotDate: formatDateOnly(snapshotDate),
          capturedAt: capturedAt.toISOString(),
          successes,
          failures,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function findActiveSeasonParticipantIds(
  prisma: PrismaClient,
  seasonId: string,
): Promise<string[]> {
  const participants = await prisma.seasonParticipant.findMany({
    where: {
      seasonId,
      participantStatus: ParticipantStatus.active,
    },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
    },
  });

  return participants.map((participant) => participant.id);
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

function parseUtcIsoDateTime(
  value: string | undefined,
  fieldName: string,
): Date {
  const text = parseRequiredText(value, fieldName);
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  if (!pattern.test(text)) {
    throw new Error(`Invalid --${fieldName}: must be UTC ISO timestamp.`);
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`Invalid --${fieldName}: must be UTC ISO timestamp.`);
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
  runAdminGenerateDailyPortfolioSnapshot(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.exitCode = 1;

      if (error instanceof Error) {
        console.error(
          `daily portfolio snapshot generation failed: ${error.message}`,
        );
        return;
      }

      console.error('daily portfolio snapshot generation failed.');
    },
  );
}
