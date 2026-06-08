import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OpsJobName, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type OpsJobLockAcquireResult =
  | {
      acquired: true;
      lockKey: string;
      ownerId: string;
      expiresAt: Date;
    }
  | {
      acquired: false;
      lockKey: string;
      ownerId: null;
      activeOwnerId: string | null;
      expiresAt: Date | null;
    };

@Injectable()
export class OpsJobLockService {
  constructor(private readonly prisma: PrismaService) {}

  acquireLock(input: {
    jobName: OpsJobName;
    lockKey: string;
    ttlSeconds: number;
    now?: Date;
    ownerId?: string;
  }): Promise<OpsJobLockAcquireResult> {
    const now = input.now ?? new Date();
    const lockKey = this.requiredString(input.lockKey, 'lockKey');
    const ownerId = input.ownerId ?? randomUUID();
    const ttlSeconds = Number.isSafeInteger(input.ttlSeconds)
      ? Math.max(1, input.ttlSeconds)
      : 1;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.opsJobLock.findUnique({
        where: {
          lockKey,
        },
      });

      if (
        existing &&
        existing.releasedAt === null &&
        existing.expiresAt.getTime() > now.getTime()
      ) {
        return {
          acquired: false,
          lockKey,
          ownerId: null,
          activeOwnerId: existing.ownerId,
          expiresAt: existing.expiresAt,
        };
      }

      if (existing) {
        const takeover = await tx.opsJobLock.updateMany({
          where: {
            id: existing.id,
            OR: [
              {
                releasedAt: {
                  not: null,
                },
              },
              {
                expiresAt: {
                  lte: now,
                },
              },
            ],
          },
          data: {
            jobName: input.jobName,
            ownerId,
            acquiredAt: now,
            expiresAt,
            releasedAt: null,
          },
        });

        if (takeover.count !== 1) {
          return {
            acquired: false,
            lockKey,
            ownerId: null,
            activeOwnerId: existing.ownerId,
            expiresAt: existing.expiresAt,
          };
        }

        return {
          acquired: true,
          lockKey,
          ownerId,
          expiresAt,
        };
      }

      try {
        await tx.opsJobLock.create({
          data: {
            lockKey,
            jobName: input.jobName,
            ownerId,
            acquiredAt: now,
            expiresAt,
            releasedAt: null,
          },
        });

        return {
          acquired: true,
          lockKey,
          ownerId,
          expiresAt,
        };
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return {
            acquired: false,
            lockKey,
            ownerId: null,
            activeOwnerId: null,
            expiresAt: null,
          };
        }

        throw error;
      }
    });
  }

  async releaseLock(input: {
    lockKey: string;
    ownerId: string;
    releasedAt?: Date;
  }): Promise<boolean> {
    const result = await this.prisma.opsJobLock.updateMany({
      where: {
        lockKey: this.requiredString(input.lockKey, 'lockKey'),
        ownerId: this.requiredString(input.ownerId, 'ownerId'),
        releasedAt: null,
      },
      data: {
        releasedAt: input.releasedAt ?? new Date(),
      },
    });

    return result.count === 1;
  }

  private requiredString(value: string, fieldName: string) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${fieldName} is required`);
    }

    return value.trim();
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
