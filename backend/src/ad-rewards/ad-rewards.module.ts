import { Module } from '@nestjs/common';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { AdRewardController } from './ad-reward.controller';
import { AdRewardService } from './ad-reward.service';
import { GeneralAccountResetController } from './general-account-reset.controller';
import { GeneralAccountResetService } from './general-account-reset.service';
import {
  AD_REWARD_VERIFICATION_REGISTRY,
  AdRewardVerificationRegistry,
} from './ad-reward-verifier';

/**
 * Rewarded-ad module.
 *
 * THE PRODUCTION REGISTRY IS EMPTY ON PURPOSE. No ad network has been chosen,
 * so no provider adapter — and above all NO fake/test verifier — is wired
 * here. With no adapter registered, every claim is refused with 503
 * AD_REWARD_PROVIDER_UNAVAILABLE, so an ad completion can never be accepted
 * on trust.
 *
 * Tests inject a deterministic fake by constructing
 * `new AdRewardVerificationRegistry([fake])` and passing it to AdRewardService
 * directly (or by overriding this provider in a testing module). Adding a real
 * adapter later is an additive change: implement AdRewardVerifier and list it
 * in the factory below.
 */
@Module({
  // GeneralPerformanceModule supplies the external-funding boundary snapshots
  // written inside the payout transaction (작업 7).
  imports: [GeneralPerformanceModule, TradingAccountsModule],
  // The general-account reset (2026-10-20) redeems a verified ad completion
  // through the SAME registry, so it lives here and shares its emptiness.
  controllers: [AdRewardController, GeneralAccountResetController],
  providers: [
    AdRewardService,
    GeneralAccountResetService,
    {
      provide: AD_REWARD_VERIFICATION_REGISTRY,
      useFactory: () => new AdRewardVerificationRegistry([]),
    },
  ],
})
export class AdRewardsModule {}
