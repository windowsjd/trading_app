import { AuthEmailService } from './auth-email.service';
import { EmailVerificationService } from './email-verification.service';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AccessTokenGuard } from './access-token.guard';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProfileImageCleanupService } from './profile-image-cleanup.service';
import { ProfileImageCleanupWorker } from './profile-image-cleanup.worker';
import { ProfileImageController } from './profile-image.controller';
import { ProfileImageService } from './profile-image.service';
import { ProfileImageStorageService } from './profile-image-storage.service';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  controllers: [
    AuthController,
    ProfileImageController,
    AccountDeletionController,
  ],
  providers: [
    AuthService,
    AuthEmailService,
    EmailVerificationService,
    ProfileImageService,
    ProfileImageStorageService,
    ProfileImageCleanupService,
    ProfileImageCleanupWorker,
    AccountDeletionService,
    // Lease and run records of the cleanup worker (same as NotificationsModule).
    OpsJobLockService,
    OpsJobRunService,
    AccessTokenGuard,
    {
      provide: APP_GUARD,
      useExisting: AccessTokenGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
