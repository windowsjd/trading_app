import { Prisma } from '../generated/prisma/client';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import {
  CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS,
  type ProviderAssetCandidate,
  type ProviderWorkflow,
} from './source-eligibility.policy';

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
  ) return null;
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
      sourceType: 'provider_api' as const,
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
    return (await client.assetPriceSnapshot.findMany({ ...query, take: 10 })) ?? [];
  }
  const candidates = (await Promise.all(input.sourceNames.map((sourceName) =>
    client.assetPriceSnapshot.findMany({
      ...query,
      where: { ...query.where, ...scope.where, sourceName, price: { gt: 0 } },
      take: 1,
    }),
  ))).flat();
  if (candidates.length > 0) return candidates;
  // Failure diagnostics retain the newest rejected evidence. The shared
  // selector still rejects it; this is never an older-session fallback.
  return (await client.assetPriceSnapshot.findMany({ ...query, take: 1 })) ?? [];
}
