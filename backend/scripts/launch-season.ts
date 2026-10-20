import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { DEVELOPMENT_SEASON_ID } from '../src/seasons/season-availability.policy';
import {
  activateLaunchSeason,
  armLaunchSeason,
  lockSeasonAdministration,
  parseLaunchStart,
  prepareLaunchSeason,
  rescheduleLaunchSeason,
  restoreDevelopmentSeason,
  seasonDatabaseNow,
  stopLaunchTest,
} from '../src/seasons/launch-season.operations';
import {
  applyLaunchTestCleanup,
  lockLaunchTestCleanupAccounts,
  lockLaunchTestCleanupQuotes,
  planLaunchTestCleanup,
} from '../src/seasons/launch-test-cleanup';
import {
  describeDatabaseTarget,
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';

export type LaunchRequest = {
  action: string;
  seasonId: string;
  actorUserId: string;
  startAt?: string;
  kind?: 'test' | 'release';
  testUserIds?: string[];
};
const ACTIONS = [
  'prepare',
  'reschedule',
  'arm',
  'disarm',
  'activate',
  'stop-test',
  'restore-development',
  'cleanup-test',
];
export async function executeLaunchRequest(
  tx: Prisma.TransactionClient,
  request: LaunchRequest,
  apply: boolean,
) {
  const now = await seasonDatabaseNow(tx);
  switch (request.action) {
    case 'prepare':
      return prepareLaunchSeason(
        tx,
        {
          id: request.seasonId,
          kind: request.kind!,
          startAt: parseLaunchStart(request.startAt ?? ''),
          testUserIds: request.testUserIds ?? [],
        },
        now,
        apply,
      );
    case 'reschedule':
      return rescheduleLaunchSeason(
        tx,
        request.seasonId,
        parseLaunchStart(request.startAt ?? ''),
        now,
        apply,
      );
    case 'arm':
      return armLaunchSeason(tx, request.seasonId, now, true, apply);
    case 'disarm':
      return armLaunchSeason(tx, request.seasonId, now, false, apply);
    case 'activate':
      return activateLaunchSeason(tx, request.seasonId, now, apply);
    case 'stop-test':
      return stopLaunchTest(tx, request.seasonId, now, apply);
    case 'restore-development':
      return restoreDevelopmentSeason(tx, request.seasonId, now, apply);
    case 'cleanup-test': {
      const plan = await planLaunchTestCleanup(tx, request.seasonId, now);
      return apply ? applyLaunchTestCleanup(tx, plan, now) : plan;
    }
    default:
      throw new Error('Unknown launch action.');
  }
}

export async function inspectLaunchRequest(
  tx: Prisma.TransactionClient,
  request: LaunchRequest,
) {
  if (
    !ACTIONS.includes(request.action) ||
    !request.seasonId ||
    !request.actorUserId
  )
    throw new Error('An explicit action, season ID and actor ID are required.');
  const actor = await tx.user.findUnique({
    where: { id: request.actorUserId },
    select: { id: true, role: true, status: true },
  });
  if (
    !actor ||
    actor.status !== 'active' ||
    !['admin', 'operator'].includes(actor.role)
  )
    throw new Error('Active operator/admin authorization required.');
  const before = await tx.season.findMany({
    where: {
      OR: [
        { id: { in: [DEVELOPMENT_SEASON_ID, request.seasonId] } },
        { status: { in: ['active', 'upcoming'] }, suspendedAt: null },
      ],
    },
    orderBy: { id: 'asc' },
  });
  const preview = await executeLaunchRequest(tx, request, false);
  return { actor, before, preview };
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      !(item instanceof Date)
    )
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    return item;
  });

export function launchPlanFingerprint(
  environment: unknown,
  request: LaunchRequest,
  inspection: Awaited<ReturnType<typeof inspectLaunchRequest>>,
) {
  return createHash('sha256')
    .update(
      canonical({
        environment,
        request,
        actor: inspection.actor,
        before: inspection.before,
        cleanup:
          request.action === 'cleanup-test' ? inspection.preview : undefined,
      }),
    )
    .digest('hex');
}

function flags(argv: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--') || result.has(key))
      throw new Error('Use unique named options.');
    if (['--apply', '--dry-run', '--workers-stopped'].includes(key))
      result.set(key, 'true');
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--'))
        throw new Error(`Missing value for ${key}`);
      result.set(key, argv[++i]);
    }
  }
  for (const key of result.keys())
    if (
      ![
        '--action',
        '--season-id',
        '--actor-user-id',
        '--start-at',
        '--kind',
        '--test-user-ids',
        '--out',
        '--apply',
        '--dry-run',
        '--plan',
        '--confirm',
        '--backup-ref',
        '--workers-stopped',
      ].includes(key)
    )
      throw new Error(`Unknown option ${key}`);
  if (result.has('--apply') && result.has('--dry-run'))
    throw new Error('apply and dry-run are mutually exclusive.');
  return result;
}

async function main(argv: string[]) {
  const args = flags(argv);
  loadRuntimeEnv();
  const url = requireDatabaseUrl();
  const environment = describeDatabaseTarget(url);
  if (!environment) throw new Error('Cannot identify target DB.');
  console.log(
    `Target DB: ${formatDatabaseTarget(url)}; mode=${args.has('--apply') ? 'APPLY' : 'READ ONLY'}`,
  );
  const db = new PrismaService();
  try {
    if (!args.has('--apply')) {
      const request: LaunchRequest = {
        action: args.get('--action') ?? '',
        seasonId: args.get('--season-id')?.trim() ?? '',
        actorUserId: args.get('--actor-user-id')?.trim() ?? '',
        ...(args.has('--start-at') ? { startAt: args.get('--start-at') } : {}),
        ...(args.has('--kind')
          ? { kind: args.get('--kind') as 'test' | 'release' }
          : {}),
        ...(args.has('--test-user-ids')
          ? {
              testUserIds: args
                .get('--test-user-ids')!
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }
          : {}),
      };
      const inspection = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return inspectLaunchRequest(tx, request);
        },
        { isolationLevel: 'RepeatableRead', timeout: 60_000 },
      );
      const plan = {
        version: 1,
        environment,
        request,
        inspection,
        fingerprint: launchPlanFingerprint(environment, request, inspection),
      };
      if (!args.get('--out'))
        throw new Error('An --out plan path is required.');
      writeFileSync(args.get('--out')!, JSON.stringify(plan, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    if (!args.get('--plan') || !args.get('--backup-ref'))
      throw new Error('Apply requires the reviewed --plan and --backup-ref.');
    const approved = JSON.parse(readFileSync(args.get('--plan')!, 'utf8')) as {
      version: number;
      environment: unknown;
      request: LaunchRequest;
      fingerprint: string;
    };
    if (
      approved.version !== 1 ||
      canonical(approved.environment) !== canonical(environment)
    )
      throw new Error('Plan DB identity mismatch.');
    const request = approved.request;
    const confirmation = `${environment.host}:${environment.port}/${environment.database}/${request.seasonId}`;
    if (args.get('--confirm') !== confirmation)
      throw new Error(`Explicit --confirm must equal ${confirmation}`);
    if (request.action === 'cleanup-test' && !args.has('--workers-stopped'))
      throw new Error(
        'Cleanup requires verified worker shutdown/drain and --workers-stopped.',
      );
    const result = await db.$transaction(
      async (tx) => {
        if (request.action === 'cleanup-test')
          await lockLaunchTestCleanupQuotes(tx, request.seasonId);
        await lockSeasonAdministration(tx, request.seasonId);
        if (request.action === 'cleanup-test')
          await lockLaunchTestCleanupAccounts(tx, request.seasonId);
        const inspection = await inspectLaunchRequest(tx, request);
        if (
          launchPlanFingerprint(environment, request, inspection) !==
          approved.fingerprint
        )
          throw new Error(
            'Scope/configuration/counts changed since approval. Generate and review a fresh plan.',
          );
        const applied = await executeLaunchRequest(tx, request, true);
        await new OperatorAuditService(db).recordSuccess(
          {
            actorUserId: inspection.actor.id,
            actorRole: inspection.actor.role,
            action: `launch_season.${request.action}`,
            targetType: 'launch_season',
            targetId: request.seasonId,
            metadataJson: {
              planFingerprint: approved.fingerprint,
              backupRef: args.get('--backup-ref'),
              result: JSON.parse(canonical(applied)) as Prisma.InputJsonValue,
            },
          },
          tx,
        );
        return applied;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Launch operation failed.',
    );
    process.exitCode = 1;
  });
