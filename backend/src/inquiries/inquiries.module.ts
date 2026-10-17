import { Module } from '@nestjs/common';
import { OperatorAuditService } from '../operator/operator-audit.service';
import { OperatorGuard } from '../operator/operator.guard';
import {
  InquiriesController,
  OperatorInquiriesController,
} from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { OperatorInquiriesService } from './operator-inquiries.service';

@Module({
  controllers: [InquiriesController, OperatorInquiriesController],
  providers: [
    InquiriesService,
    OperatorInquiriesService,
    OperatorAuditService,
    OperatorGuard,
  ],
})
export class InquiriesModule {}
