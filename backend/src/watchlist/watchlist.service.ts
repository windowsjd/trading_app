import { Injectable } from '@nestjs/common';
import { AssetType, Prisma } from '../generated/prisma/client';
import { AssetsService } from '../assets/assets.service';
import { createApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  SPOT_ASSET_WHERE,
  isFuturesOnlyAsset,
} from '../providers/binance/binance-product-catalog';

/** Per user, counting items whose asset was deactivated after it was added. */
export const WATCHLIST_LIMIT = 50;
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ASSET_TYPES: readonly string[] = Object.values(AssetType);

export type WatchlistAssetsQuery = { assetType?: string };

const ITEM_SELECT = {
  createdAt: true,
  asset: {
    select: {
      id: true,
      symbol: true,
      name: true,
      market: true,
      assetType: true,
      isActive: true,
    },
  },
} satisfies Prisma.WatchlistItemSelect;

// Newest first; the asset id orders items added in the same millisecond.
const NEWEST_FIRST = [
  { createdAt: 'desc' },
  { assetId: 'desc' },
] satisfies Prisma.WatchlistItemOrderByWithRelationInput[];

function view({
  asset,
  createdAt,
}: Prisma.WatchlistItemGetPayload<{ select: typeof ITEM_SELECT }>) {
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    market: asset.market,
    assetType: asset.assetType,
    isActive: asset.isActive,
    addedAt: createdAt.toISOString(),
  };
}

/**
 * The authenticated user's Spot watchlist. Add and remove each name a target
 * state (PUT/DELETE), so a retried request or a second device converges
 * instead of flipping it. Watching never touches accounts, wallets, orders or
 * rankings.
 */
@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
  ) {}

  async list(userId: string | undefined) {
    const owner = this.owner(userId);
    const rows = await this.prisma.watchlistItem.findMany({
      where: { userId: owner },
      orderBy: NEWEST_FIRST,
      select: ITEM_SELECT,
    });
    return {
      success: true as const,
      data: { items: rows.map(view), limit: WATCHLIST_LIMIT },
    };
  }

  /** The watched Spot assets of one market as market-list rows, in watchlist
   * order and priced by the same policy as GET /assets. Deactivated assets
   * stay listed (their rows say so) until the user removes them. */
  async listAssets(userId: string | undefined, query: WatchlistAssetsQuery) {
    const owner = this.owner(userId);
    const assetType = this.assetType(query.assetType);
    const rows = await this.prisma.watchlistItem.findMany({
      where: {
        userId: owner,
        asset: { ...SPOT_ASSET_WHERE, ...(assetType ? { assetType } : {}) },
      },
      orderBy: NEWEST_FIRST,
      select: { assetId: true },
    });
    const listed = await this.assets.getListItemsByIds(
      rows.map((row) => row.assetId),
    );
    return {
      success: true as const,
      data: {
        state: 'available' as const,
        assets: listed.assets,
        priceErrors: listed.priceErrors,
      },
    };
  }

  async add(userId: string | undefined, rawAssetId: string | undefined) {
    const owner = this.owner(userId);
    const assetId = this.assetId(rawAssetId);
    const data = await this.prisma.$transaction(
      async (tx) => {
        // Every add of this user queues on the user row, so the count below
        // already includes a concurrent add from another device (READ
        // COMMITTED reads after the wait). NO KEY UPDATE still lets other
        // tables' foreign-key checks on this user proceed.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "users" WHERE "id" = ${owner} FOR NO KEY UPDATE`;
        if (!locked.length) throw this.unauthorized();
        const existing = await tx.watchlistItem.findUnique({
          where: { userId_assetId: { userId: owner, assetId } },
          select: ITEM_SELECT,
        });
        // Already the target state: keep the original time and order, even
        // when the asset has been deactivated since.
        if (existing) return { item: view(existing), created: false };
        const asset = await tx.asset.findUnique({
          where: { id: assetId },
          select: {
            symbol: true,
            market: true,
            assetType: true,
            isActive: true,
          },
        });
        if (!asset)
          throw createApiError('ASSET_NOT_FOUND', 'Asset not found.', 404);
        if (isFuturesOnlyAsset(asset))
          throw createApiError(
            'ASSET_NOT_TRADABLE',
            'Asset is not a Spot product.',
            400,
          );
        if (!asset.isActive)
          throw createApiError(
            'ASSET_NOT_TRADABLE',
            'Asset is not active.',
            409,
          );
        const count = await tx.watchlistItem.count({
          where: { userId: owner },
        });
        if (count >= WATCHLIST_LIMIT)
          throw createApiError(
            'WATCHLIST_LIMIT_EXCEEDED',
            'The watchlist is full.',
            409,
          );
        const row = await tx.watchlistItem.create({
          data: { userId: owner, assetId },
          select: ITEM_SELECT,
        });
        return { item: view(row), created: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return { success: true as const, data };
  }

  async remove(userId: string | undefined, rawAssetId: string | undefined) {
    const owner = this.owner(userId);
    const assetId = this.assetId(rawAssetId);
    // Removing only lowers the count, so it takes no lock. An item that is
    // not there is already the target state.
    const { count } = await this.prisma.watchlistItem.deleteMany({
      where: { userId: owner, assetId },
    });
    return { success: true as const, data: { assetId, removed: count > 0 } };
  }

  private owner(userId: string | undefined): string {
    if (!userId) throw this.unauthorized();
    return userId;
  }

  private unauthorized() {
    return createApiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  private assetId(value: string | undefined): string {
    if (typeof value !== 'string' || !ASSET_ID.test(value))
      throw createApiError('INVALID_ASSET_ID', 'Invalid asset id.', 400);
    return value;
  }

  private assetType(value: string | undefined): AssetType | undefined {
    if (value === undefined || value === '') return undefined;
    if (!ASSET_TYPES.includes(value))
      throw createApiError('INVALID_ASSET_TYPE', 'Invalid assetType.', 400);
    return value as AssetType;
  }
}
