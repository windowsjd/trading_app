import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminUserStatusController } from './admin-user-status.controller';
import { AdminUserManagementController } from './admin-user-management.controller';
import { OperatorAccountManagementService } from './operator-account-management.service';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorController } from './operator.controller';
import { AdminGuard, OperatorGuard } from './operator.guard';
import { OperatorSeasonModerationController } from './operator-season-moderation.controller';
import { OperatorSeasonModerationService } from './operator-season-moderation.service';
import { OperatorService } from './operator.service';
import { OperatorUserStatusService } from './operator-user-status.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    AdminUserManagementController,
    AdminUserStatusController,
    OperatorController,
    OperatorSeasonModerationController,
  ],
  providers: [
    AdminGuard,
    OperatorAccountManagementService,
    OperatorAuditService,
    OperatorGuard,
    OperatorSeasonModerationService,
    OperatorService,
    OperatorUserStatusService,
  ],
  exports: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
})
export class OperatorModule {}
