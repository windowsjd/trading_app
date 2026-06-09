import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminUserManagementController } from './admin-user-management.controller';
import { OperatorAccountManagementService } from './operator-account-management.service';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorController } from './operator.controller';
import { AdminGuard, OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminUserManagementController, OperatorController],
  providers: [
    AdminGuard,
    OperatorAccountManagementService,
    OperatorAuditService,
    OperatorGuard,
    OperatorService,
  ],
  exports: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
})
export class OperatorModule {}
