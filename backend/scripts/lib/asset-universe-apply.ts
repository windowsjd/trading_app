import {
  AssetType,
  CurrencyCode,
  type PrismaClient,
} from '../../src/generated/prisma/client';
import {
  type AssetUniverseDesired,
  type AssetUniverseExisting,
  type AssetUniversePlan,
  type AssetUniversePlanCounts,
  assetUniverseKey,
  planAssetUniverseUpserts,
  summarizeAssetUniversePlan,
} from './asset-universe-upsert';

/**
 * DB-facing apply for a fixed asset universe, built on the pure planner. Shared
 * by the KIS and Binance seeds and the recovery command.
 *
 * Idempotent and additive: it only ever creates missing `assets` rows or
 * updates the small contract field set (name/currencies/assetType/isActive) on
 * existing rows, all inside one transaction. It never deletes, and never
 * touches price snapshots, candles, orders, quotes, or positions.
 */

function toAssetType(value: string): AssetType {
  if ((Object.values(AssetType) as string[]).includes(value)) {
    return value as AssetType;
  }
  throw new Error(`Invalid assetType in fixed universe: ${value}`);
}

function toCurrency(value: string): CurrencyCode {
  if ((Object.values(CurrencyCode) as string[]).includes(value)) {
    return value as CurrencyCode;
  }
  throw new Error(`Invalid currencyCode in fixed universe: ${value}`);
}

function toCreateData(desired: AssetUniverseDesired) {
  return {
    symbol: desired.symbol,
    name: desired.name,
    market: desired.market,
    currencyCode: toCurrency(desired.currencyCode),
    priceCurrency: toCurrency(desired.priceCurrency),
    settlementCurrency: toCurrency(desired.settlementCurrency),
    assetType: toAssetType(desired.assetType),
    isActive: true,
  };
}

function toUpdateData(desired: AssetUniverseDesired) {
  return {
    name: desired.name,
    currencyCode: toCurrency(desired.currencyCode),
    priceCurrency: toCurrency(desired.priceCurrency),
    settlementCurrency: toCurrency(desired.settlementCurrency),
    assetType: toAssetType(desired.assetType),
    isActive: true,
  };
}

export async function readExistingUniverseAssets(
  prisma: PrismaClient,
  desired: readonly AssetUniverseDesired[],
): Promise<AssetUniverseExisting[]> {
  if (desired.length === 0) {
    return [];
  }

  return prisma.asset.findMany({
    where: {
      OR: desired.map((entry) => ({
        market: entry.market,
        symbol: entry.symbol,
      })),
    },
    select: {
      id: true,
      symbol: true,
      market: true,
      name: true,
      assetType: true,
      currencyCode: true,
      priceCurrency: true,
      settlementCurrency: true,
      isActive: true,
    },
  });
}

export type AssetUniverseApplyResult = {
  plan: AssetUniversePlan;
  counts: AssetUniversePlanCounts;
  applied: boolean;
  created: number;
  updated: number;
};

/**
 * Human-readable report lines for an apply/dry-run result. Pure (no I/O) so
 * callers own the printing.
 */
export function describeAssetUniverseResult(
  label: string,
  result: AssetUniverseApplyResult,
): string[] {
  const { counts, plan, applied } = result;
  const suffix = applied ? '' : ' (dry-run, no writes)';
  const lines = [
    `${label}: ${counts.total} target(s) — create=${counts.create}, update=${counts.update}, unchanged=${counts.unchanged}${suffix}`,
  ];
  for (const create of plan.creates) {
    lines.push(
      `  + create ${create.desired.market}:${create.desired.symbol} (${create.desired.name})`,
    );
  }
  for (const update of plan.updates) {
    lines.push(
      `  ~ update ${update.desired.market}:${update.desired.symbol} [${update.changedFields.join(', ')}]`,
    );
  }

  return lines;
}

export async function applyAssetUniverse(input: {
  prisma: PrismaClient;
  desired: readonly AssetUniverseDesired[];
  apply: boolean;
}): Promise<AssetUniverseApplyResult> {
  const { prisma, desired, apply } = input;

  // Fail fast on an invalid enum value in the fixed universe BEFORE any write,
  // even in dry-run, so a bad list can never reach the DB.
  for (const entry of desired) {
    toCreateData(entry);
  }

  const existing = await readExistingUniverseAssets(prisma, desired);
  const plan = planAssetUniverseUpserts(desired, existing);
  const counts = summarizeAssetUniversePlan(plan);

  if (!apply) {
    return { plan, counts, applied: false, created: 0, updated: 0 };
  }

  await prisma.$transaction(async (tx) => {
    for (const create of plan.creates) {
      await tx.asset.create({ data: toCreateData(create.desired) });
    }
    for (const update of plan.updates) {
      await tx.asset.update({
        where: { id: update.existingId },
        data: toUpdateData(update.desired),
      });
    }
  });

  return {
    plan,
    counts,
    applied: true,
    created: plan.creates.length,
    updated: plan.updates.length,
  };
}

export type AssetUniverseVerification = {
  total: number;
  verified: number;
  issues: string[];
};

/**
 * Read back the desired universe and confirm each row is present, active, and
 * carries the expected contract fields. Used as a post-apply gate and for
 * dry-run reporting of current DB state.
 */
export async function verifyAssetUniverse(
  prisma: PrismaClient,
  desired: readonly AssetUniverseDesired[],
): Promise<AssetUniverseVerification> {
  const existing = await readExistingUniverseAssets(prisma, desired);
  const byKey = new Map(
    existing.map((row) => [assetUniverseKey(row.market, row.symbol), row]),
  );
  const issues: string[] = [];
  let verified = 0;

  for (const entry of desired) {
    const row = byKey.get(assetUniverseKey(entry.market, entry.symbol));
    if (!row) {
      issues.push(`${entry.market}:${entry.symbol} missing`);
      continue;
    }
    if (
      row.isActive &&
      row.assetType === entry.assetType &&
      row.currencyCode === entry.currencyCode &&
      row.priceCurrency === entry.priceCurrency &&
      row.settlementCurrency === entry.settlementCurrency
    ) {
      verified += 1;
    } else {
      issues.push(
        `${entry.market}:${entry.symbol} present but contract mismatch`,
      );
    }
  }

  return { total: desired.length, verified, issues };
}
