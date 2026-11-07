import { Module } from '@nestjs/common';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { AdRewardController } from './ad-reward.controller';
import { AdRewardService } from './ad-reward.service';
import { GeneralAccountResetController } from './general-account-reset.controller';
import { GeneralAccountResetService } from './general-account-reset.service';
import {
  AD_REWARD_VERIFICATION_REGISTRY,
  AdRewardVerificationRegistry,
} from './ad-reward-verifier';
import { AdMobRewardVerifier } from './admob-reward-verifier';
import { AdMobRewardSessionService } from './admob-reward-session.service';
import { AdMobSsvController } from './admob-ssv.controller';
import { AdMobSsvKeyStore } from './admob-ssv-keys';

/**
 * Rewarded-ad module.
 *
 * The registry holds ONE adapter: AdMob (2026-11-07), whose evidence is
 * Google's signed SSV callback recorded on an ad session — never the app's
 * own "reward earned" event, and never a fake verifier. Whether a claim can
 * be paid is still decided by AD_REWARD_ENABLED and AD_REWARD_PROVIDER=admob
 * (default off), and boot refuses that combination without a rewarded ad
 * unit (admob.config.ts). Any other provider key resolves to nothing, so its
 * claims answer 503 AD_REWARD_PROVIDER_UNAVAILABLE.
 *
 * Tests inject deterministic fakes by constructing
 * `new AdRewardVerificationRegistry([fake])` and passing it to the services
 * directly (or by overriding this provider in a testing module).
 */
@Module({
  // GeneralPerformanceModule supplies the external-funding boundary snapshots
  // written inside the payout transaction (작업 7).
  imports: [GeneralPerformanceModule, TradingAccountsModule],
  // The general-account reset (2026-10-20) redeems a verified ad completion
  // through the SAME registry. The SSV callback is public (Google signs it).
  controllers: [
    AdRewardController,
    GeneralAccountResetController,
    AdMobSsvController,
  ],
  providers: [
    AdRewardService,
    GeneralAccountResetService,
    AdMobRewardSessionService,
    { provide: AdMobSsvKeyStore, useFactory: () => new AdMobSsvKeyStore() },
    {
      provide: AD_REWARD_VERIFICATION_REGISTRY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new AdRewardVerificationRegistry([new AdMobRewardVerifier(prisma)]),
    },
  ],
})
export class AdRewardsModule {}
