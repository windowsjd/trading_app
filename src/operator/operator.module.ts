import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorController } from './operator.controller';
import { AdminGuard, OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';

@Module({
  imports: [PrismaModule],
  controllers: [OperatorController],
  providers: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
  exports: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
})
export class OperatorModule {}
