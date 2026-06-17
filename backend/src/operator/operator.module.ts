import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminUserStatusController } from './admin-user-status.controller';
import { AdminUserManagementController } from './admin-user-management.controller';
import { OperatorAccountManagementService } from './operator-account-management.service';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorController } from './operator.controller';
import { AdminGuard, OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';
import { OperatorUserStatusService } from './operator-user-status.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    AdminUserManagementController,
    AdminUserStatusController,
    OperatorController,
  ],
  providers: [
    AdminGuard,
    OperatorAccountManagementService,
    OperatorAuditService,
    OperatorGuard,
    OperatorService,
    OperatorUserStatusService,
  ],
  exports: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
})
export class OperatorModule {}
