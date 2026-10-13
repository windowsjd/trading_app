import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isFuturesOnlyAsset } from '../providers/binance/binance-product-catalog';

export const WATCHLIST_LIMIT = 50;
const SELECT = {
  assetId: true,
  createdAt: true,
  asset: {
    select: {
      name: true,
      symbol: true,
      market: true,
      assetType: true,
      isActive: true,
    },
  },
} satisfies Prisma.WatchlistEntrySelect;
type Entry = Prisma.WatchlistEntryGetPayload<{ select: typeof SELECT }>;

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      status,
    );
  }

  private owner(userId: string | undefined): string {
    if (!userId)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    return userId;
  }

  private assetId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_ASSET_ID',
        'Asset ID is invalid.',
      );
    }
    return value;
  }

  private view(row: Entry) {
    return {
      assetId: row.assetId,
      ...row.asset,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(userId: string | undefined) {
    const rows = await this.prisma.watchlistEntry.findMany({
      where: { userId: this.owner(userId) },
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { assetId: 'asc' }],
    });
    return {
      success: true as const,
      data: { items: rows.map((row) => this.view(row)) },
    };
  }

  // NO KEY UPDATE serializes count + writes without conflicting with ordinary
  // foreign-key KEY SHARE reads of User in unrelated domains. All watchlist
  // writers use this boundary, including DELETE. Read only AFTER locking.
  private async lockOwner(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "users" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
    if (!rows.length)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
  }

  async add(userId: string | undefined, input: unknown) {
    const owner = this.owner(userId);
    const assetId = this.assetId(input);
    const row = await this.prisma.$transaction(
      async (tx) => {
        await this.lockOwner(tx, owner);
        const key = { userId_assetId: { userId: owner, assetId } };
        const existing = await tx.watchlistEntry.findUnique({
          where: key,
          select: SELECT,
        });
        // Replay precedes active/limit validation: preserve historical records.
        if (existing) return existing;
        await tx.$queryRaw`SELECT "id" FROM "assets" WHERE "id" = ${assetId} FOR SHARE`;
        const asset = await tx.asset.findUnique({ where: { id: assetId } });
        if (!asset)
          this.fail(
            HttpStatus.NOT_FOUND,
            'ASSET_NOT_FOUND',
            'Asset was not found.',
          );
        if (isFuturesOnlyAsset(asset))
          this.fail(
            HttpStatus.BAD_REQUEST,
            'WATCHLIST_SPOT_ONLY',
            'Only Spot assets can be registered.',
          );
        if (!asset.isActive)
          this.fail(
            HttpStatus.CONFLICT,
            'ASSET_INACTIVE',
            'Inactive assets cannot be registered.',
          );
        const count = await tx.watchlistEntry.count({
          where: { userId: owner },
        });
        if (count >= WATCHLIST_LIMIT)
          this.fail(
            HttpStatus.CONFLICT,
            'WATCHLIST_LIMIT_REACHED',
            'A watchlist can contain at most 50 assets.',
          );
        return tx.watchlistEntry.create({
          data: { userId: owner, assetId },
          select: SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return { success: true as const, data: { item: this.view(row) } };
  }

  async remove(userId: string | undefined, input: unknown) {
    const owner = this.owner(userId);
    const assetId = this.assetId(input);
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOwner(tx, owner);
        await tx.watchlistEntry.deleteMany({
          where: { userId: owner, assetId },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return {
      success: true as const,
      data: { assetId, registered: false as const },
    };
  }
}
