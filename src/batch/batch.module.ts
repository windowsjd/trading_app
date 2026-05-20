import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchService } from './batch.service';

@Module({
  imports: [PrismaModule],
  providers: [BatchService],
  exports: [BatchService],
})
export class BatchModule {}
