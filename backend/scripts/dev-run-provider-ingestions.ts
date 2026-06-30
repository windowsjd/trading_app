import 'reflect-metadata';
import {
  Module,
  type INestApplicationContext,
  type Type,
} from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { UserRole } from '../src/generated/prisma/client';
import { BinancePublicClient } from '../src/providers/binance/binance-public.client';
import { BinancePriceIngestionService } from '../src/providers/binance/binance-price.ingestion.service';
import { ExchangeRateClient } from '../src/providers/exchange-rate/exchange-rate.client';
import { ExchangeRateIngestionService } from '../src/providers/exchange-rate/exchange-rate.ingestion.service';
import { KisAuthClient } from '../src/providers/kis/kis-auth.client';
import { KisQuoteClient } from '../src/providers/kis/kis-quote.client';
import { KisRestCurrentPriceIngestionService } from '../src/providers/kis/kis-rest-current-price.ingestion.service';
import { KoreaEximExchangeClient } from '../src/providers/korea-exim/korea-exim-exchange.client';
import { KoreaEximExchangeIngestionService } from '../src/providers/korea-exim/korea-exim-exchange.ingestion.service';
import { MarketSnapshotHealthService } from '../src/providers/market-snapshot-health.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import {
  collectProviderSecretsFromEnv,
  redactText,
} from '../src/providers/provider-secret-redaction';
import {
  ProviderTargetResolverService,
  type ProviderTargetSource,
  type ProviderTargets,
} from '../src/providers/provider-target-resolver.service';
import { ProvidersModule } from '../src/providers/providers.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env.development', quiet: true });
loadDotenv({ quiet: true });

type ProviderName = 'exchange-rate' | 'korea-exim' | 'binance' | 'kis';

type CliArgs = {
  operatorUserId?: string;
  operatorEmail?: string;
  providers: ProviderName[];
  dryRun: boolean;
  failOnUnavailable: boolean;
  maxSnapshots: number;
  targetSource: ProviderTargetSource;
  verbose: boolean;
};

type ProviderSummary = {
  provider: ProviderName;
  state: 'completed' | 'partial' | 'failed' | 'no_targets';
  dryRun: boolean;
  received: number;
  created: number;
  wouldCreate: number;
  skipped: number;
  failed: number;
  errorCode?: string;
  errorMessage?: string;
  verboseDetails: ProviderVerboseDetail[];
};

type ProviderVerboseDetail = {
  kind: 'snapshot' | 'symbol';
  symbol: string | null;
  sourceName?: string | null;
  state: string;
  reason: string | null;
};

const DEFAULT_PROVIDERS: ProviderName[] = ['korea-exim', 'binance', 'kis'];
const DEFAULT_MAX_SNAPSHOTS = 500;
const SCRIPT_SECRET_ENV_KEY_PATTERN =
  /(database_url|jwt.*secret|api[_-]?key|auth[_-]?key|app[_-]?key|app[_-]?secret|authorization|approval[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const OPERATOR_REQUIRED_MESSAGE = [
  'Operator user is required.',
  'Pass --operator-email <email> or --operator-user-id <id>, or set LOCAL_OPERATOR_EMAIL / LOCAL_OPERATOR_USER_ID.',
  'The user must have role=operator or role=admin.',
].join('\n');

@Module({
  imports: [PrismaModule, ProvidersModule],
  providers: [
    ProviderConfigService,
    ProviderHttpClient,
    {
      provide: ProviderTargetResolverService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new ProviderTargetResolverService(prisma),
    },
    {
      provide: ExchangeRateClient,
      inject: [ProviderConfigService, ProviderHttpClient],
      useFactory: (
        configService: ProviderConfigService,
        httpClient: ProviderHttpClient,
      ) => new ExchangeRateClient(configService, httpClient),
    },
    {
      provide: ExchangeRateIngestionService,
      inject: [PrismaService, ProviderConfigService, ExchangeRateClient],
      useFactory: (
        prisma: PrismaService,
        configService: ProviderConfigService,
        client: ExchangeRateClient,
      ) => new ExchangeRateIngestionService(prisma, configService, client),
    },
    {
      provide: KoreaEximExchangeClient,
      inject: [ProviderConfigService, ProviderHttpClient],
      useFactory: (
        configService: ProviderConfigService,
        httpClient: ProviderHttpClient,
      ) => new KoreaEximExchangeClient(configService, httpClient),
    },
    {
      provide: KoreaEximExchangeIngestionService,
      inject: [PrismaService, ProviderConfigService, KoreaEximExchangeClient],
      useFactory: (
        prisma: PrismaService,
        configService: ProviderConfigService,
        client: KoreaEximExchangeClient,
      ) => new KoreaEximExchangeIngestionService(prisma, configService, client),
    },
    {
      provide: BinancePublicClient,
      inject: [ProviderConfigService, ProviderHttpClient],
      useFactory: (
        configService: ProviderConfigService,
        httpClient: ProviderHttpClient,
      ) => new BinancePublicClient(configService, httpClient),
    },
    {
      provide: BinancePriceIngestionService,
      inject: [PrismaService, ProviderConfigService, BinancePublicClient],
      useFactory: (
        prisma: PrismaService,
        configService: ProviderConfigService,
        client: BinancePublicClient,
      ) => new BinancePriceIngestionService(prisma, configService, client),
    },
    {
      provide: KisAuthClient,
      inject: [ProviderConfigService],
      useFactory: (configService: ProviderConfigService) =>
        new KisAuthClient(configService),
    },
    {
      provide: KisQuoteClient,
      inject: [ProviderConfigService],
      useFactory: (configService: ProviderConfigService) =>
        new KisQuoteClient(configService),
    },
    {
      provide: KisRestCurrentPriceIngestionService,
      inject: [
        PrismaService,
        ProviderConfigService,
        KisAuthClient,
        KisQuoteClient,
      ],
      useFactory: (
        prisma: PrismaService,
        configService: ProviderConfigService,
        authClient: KisAuthClient,
        quoteClient: KisQuoteClient,
      ) =>
        new KisRestCurrentPriceIngestionService(
          prisma,
          configService,
          authClient,
          quoteClient,
        ),
    },
    {
      provide: MarketSnapshotHealthService,
      inject: [PrismaService, ProviderTargetResolverService],
      useFactory: (
        prisma: PrismaService,
        providerTargetResolver: ProviderTargetResolverService,
      ) => new MarketSnapshotHealthService(prisma, providerTargetResolver),
    },
  ],
})
class ProviderIngestionScriptModule {}

export async function runProviderIngestionCheck(
  argv: string[],
  options: { title?: string } = {},
) {
  requireDatabaseUrl();
  const args = parseCliArgs(argv);
  const app = await NestFactory.createApplicationContext(
    ProviderIngestionScriptModule,
    {
      logger: ['error', 'warn'],
    },
  );

  try {
    const scriptContext = app.select(ProviderIngestionScriptModule);
    const prisma = app.get(PrismaService);
    const actor = await findOperatorActor(prisma, args);
    const targetResolver = getScriptProvider(
      scriptContext,
      ProviderTargetResolverService,
    );
    const healthService = getScriptProvider(
      scriptContext,
      MarketSnapshotHealthService,
    );
    const targets = await targetResolver.resolveProviderTargets({
      targetSource: args.targetSource,
    });

    printHeader(options.title ?? 'Provider ingestion check result');
    printProviderTargetSummary(targets);

    const summaries = await runProviders({
      app: scriptContext,
      actor,
      providers: args.providers,
      dryRun: args.dryRun,
      maxSnapshots: args.maxSnapshots,
      targets,
    });
    printProviderSummary(summaries, { verbose: args.verbose });

    const health = await healthService.checkActiveAssetCoverage({
      targetSource: args.targetSource,
    });
    printSnapshotStatus(health.snapshotCounts);
    printCoverageSummary(health);
    printUnavailableAssets(health.unavailableAssets);

    const providerFailed = summaries.some(
      (summary) => summary.state === 'failed',
    );
    if (providerFailed) {
      process.exitCode = 1;
    }

    if (health.coverage.activeAssets === 0) {
      console.warn('Failure: active assets count is 0.');
      process.exitCode = 1;
    }

    if (args.failOnUnavailable && health.status === 'fail') {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    providers: [],
    dryRun: false,
    failOnUnavailable: true,
    maxSnapshots: DEFAULT_MAX_SNAPSHOTS,
    targetSource: 'merged',
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }

    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    if (option === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (option === '--verbose') {
      args.verbose = true;
      continue;
    }

    if (option === '--fail-on-unavailable') {
      args.failOnUnavailable = true;
      continue;
    }

    if (option === '--no-fail-on-unavailable') {
      args.failOnUnavailable = false;
      continue;
    }

    if (
      option !== '--operator-user-id' &&
      option !== '--operator-email' &&
      option !== '--provider' &&
      option !== '--target-source' &&
      option !== '--max-snapshots'
    ) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    if (option === '--operator-user-id') {
      args.operatorUserId = value.trim();
    } else if (option === '--operator-email') {
      args.operatorEmail = value.trim();
    } else if (option === '--provider') {
      args.providers.push(...parseProviders(value));
    } else if (option === '--target-source') {
      args.targetSource = parseTargetSource(value);
    } else {
      args.maxSnapshots = parseMaxSnapshots(value);
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const cliOperatorUserId = args.operatorUserId?.trim();
  const cliOperatorEmail = args.operatorEmail?.trim();
  const envOperatorUserId = process.env.LOCAL_OPERATOR_USER_ID?.trim();
  const envOperatorEmail = process.env.LOCAL_OPERATOR_EMAIL?.trim();
  const operatorUserId =
    cliOperatorUserId || (!cliOperatorEmail ? envOperatorUserId : undefined);
  const operatorEmail = cliOperatorUserId
    ? undefined
    : cliOperatorEmail || (!envOperatorUserId ? envOperatorEmail : undefined);

  return {
    ...args,
    operatorUserId: operatorUserId || undefined,
    operatorEmail: operatorEmail || undefined,
    providers: args.providers.length > 0 ? args.providers : DEFAULT_PROVIDERS,
  };
}

function parseProviders(value: string): ProviderName[] {
  return value
    .split(',')
    .map((item) => normalizeProvider(item))
    .filter(
      (provider, index, providers) => providers.indexOf(provider) === index,
    );
}

function normalizeProvider(value: string): ProviderName {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  switch (normalized) {
    case 'exchange-rate':
    case 'exchange-rate-api':
      return 'exchange-rate';
    case 'korea-exim':
    case 'korea-exim-exchange':
      return 'korea-exim';
    case 'binance':
      return 'binance';
    case 'kis':
      return 'kis';
    default:
      throw new Error(
        'Provider must be exchange-rate, korea-exim, binance, or kis.',
      );
  }
}

function parseTargetSource(value: string): ProviderTargetSource {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'active_assets' ||
    normalized === 'env' ||
    normalized === 'merged'
  ) {
    return normalized;
  }

  throw new Error('target-source must be active_assets, env, or merged.');
}

function parseMaxSnapshots(value: string): number {
  const parsed = Number(value.trim());
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > DEFAULT_MAX_SNAPSHOTS
  ) {
    throw new Error(
      `max-snapshots must be an integer between 1 and ${DEFAULT_MAX_SNAPSHOTS}.`,
    );
  }

  return parsed;
}

async function findOperatorActor(
  prisma: PrismaService,
  args: CliArgs,
): Promise<AuthenticatedUser> {
  if (!args.operatorUserId && !args.operatorEmail) {
    throw new Error(OPERATOR_REQUIRED_MESSAGE);
  }

  const user = args.operatorUserId
    ? await prisma.user.findUnique({
        where: {
          id: args.operatorUserId,
        },
        select: {
          id: true,
          role: true,
        },
      })
    : await prisma.user.findUnique({
        where: {
          email: args.operatorEmail,
        },
        select: {
          id: true,
          role: true,
        },
      });

  if (!user || !hasOperatorRole(user.role)) {
    throw new Error(OPERATOR_REQUIRED_MESSAGE);
  }

  return {
    userId: user.id,
    role: user.role,
  };
}

function hasOperatorRole(role: UserRole) {
  return role === UserRole.operator || role === UserRole.admin;
}

async function runProviders(input: {
  app: INestApplicationContext;
  actor: AuthenticatedUser;
  providers: ProviderName[];
  dryRun: boolean;
  maxSnapshots: number;
  targets: ProviderTargets;
}) {
  const summaries: ProviderSummary[] = [];

  for (const provider of orderProviders(input.providers)) {
    const summary = await runOneProvider({ ...input, provider });
    summaries.push(summary);

    if (
      provider === 'korea-exim' &&
      !input.providers.includes('exchange-rate') &&
      summary.state === 'failed'
    ) {
      summaries.push(
        await runOneProvider({
          ...input,
          provider: 'exchange-rate',
        }),
      );
    }
  }

  return summaries;
}

function orderProviders(providers: ProviderName[]) {
  const priority: ProviderName[] = [
    'korea-exim',
    'exchange-rate',
    'binance',
    'kis',
  ];
  return priority.filter((provider) => providers.includes(provider));
}

async function runOneProvider(input: {
  app: INestApplicationContext;
  actor: AuthenticatedUser;
  provider: ProviderName;
  dryRun: boolean;
  maxSnapshots: number;
  targets: ProviderTargets;
}): Promise<ProviderSummary> {
  try {
    switch (input.provider) {
      case 'exchange-rate':
        return normalizeProviderSummary(
          input.provider,
          input.dryRun,
          await getScriptProvider(
            input.app,
            ExchangeRateIngestionService,
          ).ingestUsdKrw({
            dryRun: input.dryRun,
            requestedBy: input.actor.userId,
          }),
        );
      case 'korea-exim':
        return normalizeProviderSummary(
          input.provider,
          input.dryRun,
          await getScriptProvider(
            input.app,
            KoreaEximExchangeIngestionService,
          ).ingestUsdKrw({
            dryRun: input.dryRun,
            requestedBy: input.actor.userId,
          }),
        );
      case 'binance':
        if (input.targets.binanceSymbols.length === 0) {
          return noTargetsSummary(input.provider, input.dryRun);
        }

        return normalizeProviderSummary(
          input.provider,
          input.dryRun,
          await getScriptProvider(
            input.app,
            BinancePriceIngestionService,
          ).ingestPrices({
            dryRun: input.dryRun,
            requestedBy: input.actor.userId,
            symbols: input.targets.binanceSymbols,
          }),
        );
      case 'kis':
        if (
          input.targets.kisDomesticSymbols.length === 0 &&
          input.targets.kisUsSymbols.length === 0
        ) {
          return noTargetsSummary(input.provider, input.dryRun);
        }

        return normalizeProviderSummary(
          input.provider,
          input.dryRun,
          await getScriptProvider(
            input.app,
            KisRestCurrentPriceIngestionService,
          ).ingestCurrentPrices({
            dryRun: input.dryRun,
            requestedBy: input.actor.userId,
            domesticSymbols: input.targets.kisDomesticSymbols,
            usSymbols: input.targets.kisUsSymbols,
            maxSnapshots: input.maxSnapshots,
          }),
        );
    }
  } catch (error) {
    const safeError = readSafeError(error);
    return {
      provider: input.provider,
      state: 'failed',
      dryRun: input.dryRun,
      received: 0,
      created: 0,
      wouldCreate: 0,
      skipped: 0,
      failed: 1,
      errorCode: safeError.errorCode,
      errorMessage: safeError.errorMessage,
      verboseDetails: [],
    };
  }
}

function getScriptProvider<T>(app: INestApplicationContext, token: Type<T>): T {
  return app.get(token, { strict: true });
}

function normalizeProviderSummary(
  provider: ProviderName,
  dryRun: boolean,
  result: unknown,
): ProviderSummary {
  const record = readRecord(result) ?? {};
  const failed =
    readNumber(record.failed) ?? (record.success === false ? 1 : 0);
  const created = readNumber(record.created) ?? 0;
  const wouldCreate = readNumber(record.wouldCreate) ?? 0;
  const skipped = readNumber(record.skipped) ?? 0;
  const errorCode = readString(record.errorCode);

  return {
    provider,
    state:
      failed > 0
        ? created + wouldCreate + skipped > 0
          ? 'partial'
          : 'failed'
        : 'completed',
    dryRun,
    received:
      readNumber(record.received) ??
      readNumber(record.symbolCount) ??
      readArray(record.snapshots)?.length ??
      0,
    created,
    wouldCreate,
    skipped,
    failed,
    errorCode,
    errorMessage: sanitizeOutputText(readString(record.errorMessage)),
    verboseDetails: readProviderVerboseDetails(provider, record),
  };
}

function noTargetsSummary(
  provider: ProviderName,
  dryRun: boolean,
): ProviderSummary {
  return {
    provider,
    state: 'no_targets',
    dryRun,
    received: 0,
    created: 0,
    wouldCreate: 0,
    skipped: 0,
    failed: 0,
    errorCode: 'NO_PROVIDER_TARGET',
    errorMessage: 'No provider targets resolved for this provider.',
    verboseDetails: [],
  };
}

function readProviderVerboseDetails(
  provider: ProviderName,
  record: Record<string, unknown>,
): ProviderVerboseDetail[] {
  if (provider === 'kis') {
    return readFailedOrSkippedVerboseDetails({
      kind: 'snapshot',
      items: readArray(record.snapshots),
      includeSourceName: true,
    });
  }

  if (provider === 'binance') {
    return readFailedOrSkippedVerboseDetails({
      kind: 'symbol',
      items: readArray(record.symbols),
      includeSourceName: false,
    });
  }

  return [];
}

function readFailedOrSkippedVerboseDetails(input: {
  kind: ProviderVerboseDetail['kind'];
  items: unknown[] | undefined;
  includeSourceName: boolean;
}): ProviderVerboseDetail[] {
  const details: ProviderVerboseDetail[] = [];

  for (const item of input.items ?? []) {
    const record = readRecord(item);
    const state = sanitizeOutputText(readString(record?.state));
    if (state !== 'failed' && state !== 'skipped') {
      continue;
    }

    details.push({
      kind: input.kind,
      symbol: sanitizeOutputText(readString(record?.symbol)) ?? null,
      ...(input.includeSourceName
        ? {
            sourceName:
              sanitizeOutputText(readString(record?.sourceName)) ?? null,
          }
        : {}),
      state,
      reason: sanitizeOutputText(readString(record?.reason)) ?? null,
    });
  }

  return details;
}

function printHeader(title: string) {
  console.log(title);
}

function printProviderTargetSummary(targets: ProviderTargets) {
  console.log('');
  console.log('Provider target summary');
  console.log(`- target source: ${targets.targetSource}`);
  console.log(`- active assets: ${targets.activeAssetCount}`);
  console.log(`- binance symbols: ${formatSymbols(targets.binanceSymbols)}`);
  console.log(
    `- kis domestic symbols: ${formatSymbols(targets.kisDomesticSymbols)}`,
  );
  console.log(`- kis us symbols: ${formatSymbols(targets.kisUsSymbols)}`);
  if (targets.unsupportedAssets.length > 0) {
    console.log('- unsupported active assets:');
    for (const asset of targets.unsupportedAssets) {
      console.log(
        `  - assetId=${asset.assetId}, symbol=${asset.symbol}, assetType=${asset.assetType}, market=${asset.market}, reason=${asset.reason}`,
      );
    }
  }
}

function printProviderSummary(
  summaries: ProviderSummary[],
  options: { verbose?: boolean } = {},
) {
  console.log('');
  console.log('Provider run summary');
  for (const summary of summaries) {
    const details = [
      `${summary.provider}: ${summary.state}`,
      `created=${summary.created}`,
      `skipped=${summary.skipped}`,
      `failed=${summary.failed}`,
      `wouldCreate=${summary.wouldCreate}`,
      summary.errorCode ? `errorCode=${summary.errorCode}` : null,
      summary.errorMessage ? `errorMessage=${summary.errorMessage}` : null,
    ].filter(Boolean);

    console.log(`- ${details.join(', ')}`);
    if (options.verbose) {
      printProviderVerboseDetails(summary);
    }
  }
}

function printProviderVerboseDetails(summary: ProviderSummary) {
  if (summary.verboseDetails.length === 0) {
    return;
  }

  for (const detail of summary.verboseDetails) {
    const fields = [
      `symbol=${detail.symbol ?? 'unknown'}`,
      detail.sourceName ? `sourceName=${detail.sourceName}` : null,
      `state=${detail.state}`,
      detail.reason ? `reason=${detail.reason}` : null,
    ].filter(Boolean);

    console.log(`  - ${detail.kind}: ${fields.join(', ')}`);
  }
}

function printSnapshotStatus(input: {
  assetPriceSnapshotsTotal: number;
  fxRateSnapshotsTotal: number;
}) {
  console.log('');
  console.log('Snapshot status');
  console.log(
    `- asset_price_snapshots total: ${input.assetPriceSnapshotsTotal}`,
  );
  console.log(`- fx_rate_snapshots total: ${input.fxRateSnapshotsTotal}`);
}

function printCoverageSummary(
  health: Awaited<
    ReturnType<MarketSnapshotHealthService['checkActiveAssetCoverage']>
  >,
) {
  console.log('');
  console.log('Coverage summary');
  console.log(
    `- price available: ${health.coverage.priceAvailable}/${health.coverage.activeAssets}`,
  );
  console.log(
    `- price unavailable: ${health.coverage.priceUnavailable}/${health.coverage.activeAssets}`,
  );
  console.log(
    `- USD/KRW FX: ${health.fxUsdKrw.state}${health.fxUsdKrw.reason ? ` reason=${health.fxUsdKrw.reason}` : ''}`,
  );
}

function printUnavailableAssets(
  unavailableAssets: Awaited<
    ReturnType<MarketSnapshotHealthService['checkActiveAssetCoverage']>
  >['unavailableAssets'],
) {
  console.log('');
  console.log('Unavailable assets');
  if (unavailableAssets.length === 0) {
    console.log('- none');
    return;
  }

  for (const asset of unavailableAssets) {
    console.log(
      `- assetId=${asset.assetId}, symbol=${asset.symbol}, reason=${asset.reason ?? 'UNKNOWN'}`,
    );
  }
}

function formatSymbols(symbols: string[]) {
  return symbols.length > 0 ? symbols.join(', ') : 'none';
}

function readSafeError(error: unknown) {
  if (error instanceof Error) {
    return {
      errorCode: error.name || 'ERROR',
      errorMessage: redactScriptErrorText(error.message),
    };
  }

  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: 'Unknown provider ingestion error.',
  };
}

function sanitizeOutputText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactScriptErrorText(value);
}

export function printScriptFailure(prefix: string, error: unknown) {
  console.error(`${prefix}: ${formatScriptError(error)}`);
}

function formatScriptError(error: unknown) {
  if (error instanceof Error) {
    return redactScriptErrorText(
      error.stack ?? `${error.name || 'Error'}: ${error.message}`,
    );
  }

  const record = readRecord(error);
  const stack = readString(record?.stack);
  const message = readString(record?.message);
  if (stack || message) {
    return redactScriptErrorText(stack ?? message ?? 'Unknown error.');
  }

  return 'Unknown non-Error thrown.';
}

function redactScriptErrorText(text: string) {
  return redactText(text, {
    secrets: collectScriptSecretsFromEnv(),
  });
}

function collectScriptSecretsFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  const secrets = collectProviderSecretsFromEnv(env);

  for (const [key, value] of Object.entries(env)) {
    const secret = value?.trim();
    if (
      secret &&
      SCRIPT_SECRET_ENV_KEY_PATTERN.test(key) &&
      !secrets.includes(secret)
    ) {
      secrets.push(secret);
    }
  }

  return secrets;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

if (require.main === module) {
  runProviderIngestionCheck(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    printScriptFailure('dev provider ingestion failed', error);
  });
}
