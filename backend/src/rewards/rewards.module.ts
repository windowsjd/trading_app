import { Module } from '@nestjs/common';
import { OperatorModule } from '../operator/operator.module';
import { OperatorRewardFulfillmentController } from './operator-reward-fulfillment.controller';
import { RewardFulfillmentService } from './reward-fulfillment.service';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [OperatorModule],
  controllers: [OperatorRewardFulfillmentController, RewardsController],
  providers: [RewardFulfillmentService, RewardsService],
})
export class RewardsModule {}
