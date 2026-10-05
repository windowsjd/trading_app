import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { CurrentUserResponse } from './auth.types';
import { ProfileImageStorageService } from './profile-image-storage.service';
import {
  type ProfileImageFile,
  profileImageError,
  validateProfileImage,
} from './profile-image.validation';

@Injectable()
export class ProfileImageService {
  private readonly logger = new Logger(ProfileImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly storage: ProfileImageStorageService,
  ) {}

  async upload(
    userId: string | undefined,
    file?: ProfileImageFile,
  ): Promise<CurrentUserResponse> {
    const current = await this.auth.me(userId);
    const owner = current.data.id;
    const bytes = validateProfileImage(file);
    this.storage.requireConfigured();
    const key = `profile-images/${owner}/${randomUUID()}.jpg`;
    const url = this.storage.publicUrl(key);
    try {
      await this.storage.upload(key, bytes);
    } catch {
      this.logFailure(owner, 'upload');
      await this.cleanup(owner, key);
      throw new ServiceUnavailableException(
        profileImageError(
          'PROFILE_IMAGE_UPLOAD_FAILED',
          'Profile image upload failed.',
        ),
      );
    }

    let changed: Awaited<ReturnType<ProfileImageService['changeUrl']>>;
    try {
      changed = await this.changeUrl(owner, url);
    } catch (error) {
      await this.cleanup(owner, key);
      throw error;
    }
    await this.cleanup(
      owner,
      this.storage.managedKey(changed.previousUrl, owner),
    );
    return changed.response;
  }

  async delete(userId: string | undefined): Promise<CurrentUserResponse> {
    const current = await this.auth.me(userId);
    this.storage.requireConfigured();
    const owner = current.data.id;
    const changed = await this.changeUrl(owner, null);
    await this.cleanup(
      owner,
      this.storage.managedKey(changed.previousUrl, owner),
    );
    return changed.response;
  }

  private async changeUrl(userId: string, url: string | null) {
    return this.prisma.$transaction(async (tx) => {
      // The id column is TEXT, matching the existing Prisma schema. Capture the
      // latest URL under this lock; multiple instances cannot orphan a winner.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      // Read through the transaction so status and URL reflect the locked row.
      const select = {
        id: true,
        email: true,
        nickname: true,
        profileImageUrl: true,
        portfolioPublic: true,
        role: true,
        status: true,
        createdAt: true,
      } as const;
      const before = await tx.user.findUnique({
        where: { id: userId },
        select,
      });
      if (!before) {
        throw new UnauthorizedException(
          profileImageError('UNAUTHORIZED', 'Unauthorized'),
        );
      }
      if (before.status !== 'active') {
        throw new ForbiddenException(
          profileImageError('USER_NOT_ACTIVE', 'User is not active.'),
        );
      }
      const user =
        before.profileImageUrl === url
          ? before
          : await tx.user.update({
              where: { id: userId },
              data: { profileImageUrl: url },
              select,
            });
      return {
        previousUrl: before.profileImageUrl,
        response: {
          success: true as const,
          data: { ...user, createdAt: user.createdAt.toISOString() },
        },
      };
    });
  }

  private async cleanup(userId: string, key: string | null) {
    if (!key) return;
    try {
      await this.storage.delete(key);
    } catch {
      this.logFailure(userId, 'cleanup');
    }
  }

  private logFailure(userId: string, operation: 'upload' | 'cleanup') {
    this.logger.warn(
      JSON.stringify({
        event: 'profile_image_storage_failed',
        userId,
        operation,
      }),
    );
  }
}
