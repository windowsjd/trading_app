import { Module } from '@nestjs/common';
import { ProfileImageStorageService } from '../auth/profile-image-storage.service';
import { OperatorAuditService } from '../operator/operator-audit.service';
import { OperatorGuard } from '../operator/operator.guard';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import {
  CommunityController,
  OperatorCommunityController,
} from './community.controller';
import { CommunityModerationService } from './community-moderation.service';
import { CommunityPhotoCleanupService } from './community-photo-cleanup.service';
import { CommunityPhotoCleanupWorker } from './community-photo-cleanup.worker';
import { CommunityReadService } from './community-read.service';
import { CommunityTierReader } from './community-tier.reader';
import { CommunityWriteService } from './community-write.service';

/**
 * Community (docs/community-api-contract.md). Not financial. Photo storage
 * reuses the profile image bucket and credentials through its own
 * ProfileImageStorageService instance (only a ConfigService dependency).
 * Account deletion, signup carryover and retention call this module's plain
 * functions from the Auth module; nothing here imports AuthModule.
 */
@Module({
  controllers: [CommunityController, OperatorCommunityController],
  providers: [
    CommunityReadService,
    CommunityWriteService,
    CommunityModerationService,
    CommunityTierReader,
    CommunityPhotoCleanupService,
    CommunityPhotoCleanupWorker,
    ProfileImageStorageService,
    OperatorAuditService,
    OperatorGuard,
    // Lease and run records of the cleanup worker (same as AuthModule).
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class CommunityModule {}
