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
import { parseApplyDryRunFlags } from './lib/cli-flags';
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
  const flags = parseApplyDryRunFlags(argv, {
    allowSkipProviderValidation: true,
  });
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
    console.log('\n[1/4] Development season');
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
    console.log('\n[2/4] Dev baseline (user / participant / wallets / grant)');
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
    console.log('\n[3/4] KIS fixed asset universe');
    const kis = await seedKisFixedAssetUniverse({ prisma, apply: flags.apply });
    for (const line of describeAssetUniverseResult('  KIS', kis)) {
      console.log(line);
    }

    // 4) Binance fixed universe (10) — validated against exchangeInfo first.
    console.log('\n[4/4] Binance fixed asset universe');
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

    // Final verification.
    console.log('\n=== Final verification ===');
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

    const overallOk =
      binance.ok &&
      (flags.apply
        ? kisVerify.verified === kisVerify.total &&
          binanceVerify.verified === binanceVerify.total
        : true);

    console.log(
      `\nRecovery ${overallOk ? 'OK' : 'INCOMPLETE'} (mode=${flags.mode}).` +
        (flags.apply ? '' : ' Re-run with --apply to write.'),
    );
    if (!overallOk) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
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
