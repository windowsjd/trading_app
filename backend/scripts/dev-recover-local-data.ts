import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  AssetType,
  CurrencyCode,
} from '../src/generated/prisma/client';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import { parseRecoveryArgs } from './lib/recovery-args';
import {
  buildBinanceReadiness,
  formatBinanceReadinessLines,
} from './lib/market-readiness';
import {
  ensureDevBaselineParticipant,
  ensureDevSeasonOpen,
} from './lib/dev-baseline';
import {
  describeAssetUniverseResult,
  verifyAssetUniverse,
} from './lib/asset-universe-apply';
import {
  buildKisDesiredUniverse,
  seedKisFixedAssetUniverse,
} from './seed-kis-fixed-asset-universe';
import {
  buildBinanceDesiredUniverse,
  seedBinanceFixedAssetUniverse,
} from './seed-binance-fixed-asset-universe';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import {
  ProviderTargetResolverService,
  toBinanceUsdtSymbol,
} from '../src/providers/provider-target-resolver.service';
import { MarketSnapshotHealthService } from '../src/providers/market-snapshot-health.service';
import { runProviderIngestionCheck } from './dev-run-provider-ingestions';

/**
 * One-command, safe, repeatable recovery for a reset local dev DB.
 *
 * Does ONLY additive, idempotent work: keeps the dev season open, creates the
 * dev user/participant/wallets/grant when absent (never resetting existing
 * balances or ledgers), and registers the fixed 40 KIS stocks + 10 Binance
 * crypto assets. It never drops, truncates, deletes, or resets anything.
 *
 * `--dry-run` (default) plans without writing; `--apply` writes;
 * `--skip-provider-validation` is an offline-only escape for the Binance check.
 */

async function main(argv: string[]) {
  const { flags, ensureMarketSnapshots, operatorEmail, operatorUserId } =
    parseRecoveryArgs(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== dev-recover-local-data ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);
  if (flags.skipProviderValidation) {
    console.warn('Binance provider validation will be SKIPPED (offline mode).');
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    // 1) Development season kept open (non-destructive).
    console.log('\n[1/5] Development season');
    const season = await ensureDevSeasonOpen({ prisma, apply: flags.apply });
    for (const other of season.otherActiveSeasons) {
      console.warn(
        `  ! other active season left unmodified: ${other.id} / ${other.name}`,
      );
    }
    console.log(
      `  season ${season.seasonId}: ${season.action} (status=${season.status}, ${season.startAt} -> ${season.endAt})`,
    );

    // 2) Dev user / participant / wallets / grant (create-if-absent only).
    console.log('\n[2/5] Dev baseline (user / participant / wallets / grant)');
    const baseline = await ensureDevBaselineParticipant({
      prisma,
      apply: flags.apply,
    });
    console.log(
      `  user: ${baseline.userAction}; participant: ${baseline.participantAction} (walletsCreated=${baseline.walletsCreated}, grantCreated=${baseline.grantCreated})`,
    );
    for (const note of baseline.notes) {
      console.log(`  - ${note}`);
    }

    // 3) KIS fixed universe (40).
    console.log('\n[3/5] KIS fixed asset universe');
    const kis = await seedKisFixedAssetUniverse({ prisma, apply: flags.apply });
    for (const line of describeAssetUniverseResult('  KIS', kis)) {
      console.log(line);
    }

    // 4) Binance fixed universe (10) — validated against exchangeInfo first.
    console.log('\n[4/5] Binance fixed asset universe');
    const binance = await seedBinanceFixedAssetUniverse({
      prisma,
      apply: flags.apply,
      skipProviderValidation: flags.skipProviderValidation,
    });
    if (binance.validation.skipped) {
      console.log('  provider validation: SKIPPED');
    } else if (binance.validation.ok) {
      console.log('  provider validation: OK (10/10 TRADING Spot USDT)');
    } else {
      console.error('  provider validation: FAILED — Binance not registered:');
      for (const failure of binance.validation.failures) {
        console.error(
          `    x ${failure.symbol}: ${failure.reason} ${failure.detail ?? ''}`,
        );
      }
    }
    if (binance.universe) {
      for (const line of describeAssetUniverseResult(
        '  Binance',
        binance.universe,
      )) {
        console.log(line);
      }
    }

    // Data-recovery verification (asset metadata + baseline) — deliberately
    // distinct from market-data readiness reported in step [5/5].
    console.log('\n=== Data recovery verification ===');
    const kisDesired = buildKisDesiredUniverse();
    const binanceDesired = buildBinanceDesiredUniverse();
    const kisVerify = await verifyAssetUniverse(prisma, kisDesired);
    const binanceVerify = await verifyAssetUniverse(prisma, binanceDesired);

    const activeCounts = await countActiveAssetsByType(prisma);
    console.log(
      `  KIS universe active+correct: ${kisVerify.verified}/${kisVerify.total}`,
    );
    console.log(
      `  Binance universe active+correct: ${binanceVerify.verified}/${binanceVerify.total}`,
    );
    console.log(
      `  Active assets in DB — domestic_stock=${activeCounts.domestic}, us_stock=${activeCounts.us}, crypto=${activeCounts.crypto}`,
    );
    for (const issue of [...kisVerify.issues, ...binanceVerify.issues]) {
      console.log(`  ! ${issue}`);
    }

    const dataRecoveryOk =
      binance.ok &&
      (flags.apply
        ? kisVerify.verified === kisVerify.total &&
          binanceVerify.verified === binanceVerify.total
        : true);

    // 5) Market data readiness. Registering 50 assets is NOT the same as the
    // market being ready (fresh price snapshots). Report the two separately.
    console.log('\n[5/5] Market data readiness');
    await runMarketSnapshotBootstrap({
      apply: flags.apply,
      ensureMarketSnapshots,
      operatorEmail,
      operatorUserId,
    });
    const readiness = await evaluateBinanceReadiness(prisma);
    for (const line of formatBinanceReadinessLines(readiness)) {
      console.log(line);
    }

    console.log(
      `\nData recovery: ${dataRecoveryOk ? 'OK' : 'INCOMPLETE'}` +
        (flags.apply ? '' : ' (dry-run; re-run with --apply to write)'),
    );
    console.log(
      `Market data readiness: ${readiness.ready ? 'READY' : 'NOT_READY'}`,
    );

    // Fail only when the recovery itself is incomplete, or a snapshot bootstrap
    // was explicitly requested (with --apply) yet the market is still not
    // ready. A plain recovery never fails on readiness alone, since provider
    // env or network can legitimately be absent locally.
    if (
      !dataRecoveryOk ||
      (ensureMarketSnapshots && flags.apply && !readiness.ready)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Create fresh price snapshots for the registered Binance universe by reusing
 * the existing provider-ingestion runner (no second startup ingestion path).
 * Only runs on `--apply` + `--ensure-market-snapshots` with the provider gates
 * enabled; otherwise it clearly reports NOT_RUN/SKIPPED with a reason.
 */
async function runMarketSnapshotBootstrap(input: {
  apply: boolean;
  ensureMarketSnapshots: boolean;
  operatorEmail?: string;
  operatorUserId?: string;
}): Promise<void> {
  if (!input.ensureMarketSnapshots) {
    console.log(
      '  Market snapshot bootstrap: NOT_RUN (pass --ensure-market-snapshots to create snapshots)',
    );
    return;
  }
  if (!input.apply) {
    console.log(
      '  Market snapshot bootstrap: SKIPPED (dry-run; re-run with --apply)',
    );
    return;
  }

  const config = new ProviderConfigService().getConfig();
  if (!config.common.providerIngestionEnabled) {
    console.log('  Market snapshot bootstrap: NOT_RUN');
    console.log('  Reason: PROVIDER_INGESTION_DISABLED');
    return;
  }
  if (!config.binance.enabled) {
    console.log('  Market snapshot bootstrap: NOT_RUN');
    console.log('  Reason: BINANCE_PUBLIC_MARKET_DATA_DISABLED');
    return;
  }

  const providerArgs = [
    '--provider',
    'binance',
    '--target-source',
    'active_assets',
    '--no-fail-on-unavailable',
  ];
  if (config.koreaEximExchange.enabled) {
    providerArgs.push('--provider', 'korea-exim');
  } else if (config.exchangeRateApi.enabled) {
    providerArgs.push('--provider', 'exchange-rate');
  }
  if (input.operatorEmail) {
    providerArgs.push('--operator-email', input.operatorEmail);
  }
  if (input.operatorUserId) {
    providerArgs.push('--operator-user-id', input.operatorUserId);
  }

  console.log(
    '  Market snapshot bootstrap: RUNNING (Binance REST + any enabled FX provider)',
  );
  try {
    await runProviderIngestionCheck(providerArgs, {
      title: 'Market snapshot bootstrap',
    });
  } catch (error) {
    console.error(
      `  Market snapshot bootstrap: FAILED — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function evaluateBinanceReadiness(prisma: PrismaClient) {
  const prismaService = prisma as unknown as PrismaService;
  const resolver = new ProviderTargetResolverService(prismaService);
  const health = new MarketSnapshotHealthService(prismaService, resolver);
  const [targets, coverage] = await Promise.all([
    resolver.resolveProviderTargets({ targetSource: 'active_assets' }),
    health.checkActiveAssetCoverage({ targetSource: 'active_assets' }),
  ]);
  return buildBinanceReadiness({
    assets: coverage.assets,
    binanceTargetSymbols: targets.binanceSymbols,
    toProviderSymbol: (symbol) => toBinanceUsdtSymbol(symbol),
  });
}

async function countActiveAssetsByType(prisma: PrismaClient): Promise<{
  domestic: number;
  us: number;
  crypto: number;
}> {
  const [domestic, us, crypto] = await Promise.all([
    prisma.asset.count({
      where: { isActive: true, assetType: AssetType.domestic_stock },
    }),
    prisma.asset.count({
      where: { isActive: true, assetType: AssetType.us_stock },
    }),
    prisma.asset.count({
      where: {
        isActive: true,
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      },
    }),
  ]);

  return { domestic, us, crypto };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`dev-recover-local-data failed: ${error.message}`);
      return;
    }

    console.error('dev-recover-local-data failed.');
  });
}
