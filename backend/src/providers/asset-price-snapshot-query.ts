import { Prisma } from '../generated/prisma/client';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import {
  CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS,
  type ProviderAssetCandidate,
  type ProviderWorkflow,
} from './source-eligibility.policy';

/** `source_type <> each other enum value` is `= 'provider_api'` row for row,
 * but cannot drive the (source_type, effective_at) index. With equality and a
 * session window newer than the last ANALYZE, the planner estimated ~1 row and
 * walked every provider row of the window for an asset that has none (US
 * stocks, 8 s per call in production on 2026-10-15). Only the
 * (asset_id, effective_at) index then fits. A spec pins the enum values. */
export const NON_PROVIDER_SOURCE_TYPES = [
  'admin_manual',
  'official_batch',
] as const;

/** Receipt window of the open-market per-source fallback read (every open
 * workflow rejects older receipts anyway: ≤ 300 s). */
const OPEN_MARKET_SOURCE_FALLBACK_MS = 15 * 60_000;

type PriceRead = {
  asset: ProviderAssetCandidate & { id: string };
  workflow: ProviderWorkflow;
  now: Date;
};

/** The same session bounds apply to provider prices and manual fallbacks. */
export function closedMarketPriceScope(input: PriceRead) {
  if (
    input.asset.assetType === 'crypto' ||
    !CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS.has(input.workflow)
  )
    return null;
  const marketState = resolveStockMarketSessionState(input.asset, input.now);
  if (marketState?.state === 'open') return null;
  const session = marketState?.latestCompletedSession;
  return {
    marketState,
    where: session
      ? { effectiveAt: { gte: session.openTime, lte: session.closeTime } }
      : { id: { in: [] as string[] } },
  };
}

/**
 * Bound the DB query BEFORE limiting candidates. One positive row per source
 * preserves source priority without a newer source crowding another out.
 * Open markets and crypto keep their existing candidate/freshness policy.
 */
export async function findMarketAwareAssetPriceCandidates(
  client: Pick<Prisma.TransactionClient, 'assetPriceSnapshot'>,
  input: PriceRead & { sourceNames: readonly string[] },
) {
  const query = {
    where: {
      assetId: input.asset.id,
      currencyCode: input.asset.currencyCode,
      sourceType: { notIn: [...NON_PROVIDER_SOURCE_TYPES] },
    },
    orderBy: [
      { effectiveAt: 'desc' as const },
      { capturedAt: 'desc' as const },
      { createdAt: 'desc' as const },
    ],
    select: {
      id: true,
      assetId: true,
      price: true,
      priceKrw: true,
      currencyCode: true,
      sourceType: true,
      sourceName: true,
      effectiveAt: true,
      capturedAt: true,
      createdAt: true,
    },
  } satisfies Prisma.AssetPriceSnapshotFindManyArgs;
  const scope = closedMarketPriceScope(input);
  if (!scope) {
    const recent =
      (await client.assetPriceSnapshot.findMany({ ...query, take: 10 })) ?? [];
    if (
      input.sourceNames.length === 0 ||
      recent.some(
        (row) =>
          row.sourceName !== null && input.sourceNames.includes(row.sourceName),
      )
    )
      return recent;
    // Another provider's newer rows filled the window (two providers writing
    // one asset, e.g. Tiingo collection next to KIS before a US provider
    // switch, 2026-10-17). Read each eligible source's newest recent receipt
    // through the (asset_id, captured_at) index — bounded, never a walk of
    // the asset's history — so it is never crowded out.
    const since = new Date(
      input.now.getTime() - OPEN_MARKET_SOURCE_FALLBACK_MS,
    );
    const eligible = (
      await Promise.all(
        input.sourceNames.map(
          async (sourceName) =>
            (await client.assetPriceSnapshot.findMany({
              ...query,
              where: { ...query.where, sourceName, capturedAt: { gte: since } },
              orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
              take: 1,
            })) ?? [],
        ),
      )
    ).flat();
    return eligible.length > 0 ? [...eligible, ...recent] : recent;
  }
  const candidates = (
    await Promise.all(
      input.sourceNames.map((sourceName) =>
        client.assetPriceSnapshot.findMany({
          ...query,
          where: {
            ...query.where,
            ...scope.where,
            sourceName,
            price: { gt: 0 },
          },
          take: 1,
        }),
      ),
    )
  ).flat();
  if (candidates.length > 0) return candidates;
  // Failure diagnostics retain the newest rejected evidence. The shared
  // selector still rejects it; this is never an older-session fallback.
  return (
    (await client.assetPriceSnapshot.findMany({ ...query, take: 1 })) ?? []
  );
}
