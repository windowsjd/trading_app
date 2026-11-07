import type { PrismaService } from '../prisma/prisma.service';
import { ADMOB_PROVIDER, ADMOB_SESSION_EXPIRY_GRACE_MS } from './admob.config';
import type {
  AdRewardVerificationRequest,
  AdRewardVerificationResult,
  AdRewardVerifier,
} from './ad-reward-verifier';

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The AdMob adapter (2026-11-07). The proof is an ad session id; the
 * evidence is the Google-signed SSV callback the session recorded
 * (admob-reward-session.service.ts), never the app's EARNED_REWARD event.
 *
 * Verified: the session exists, is AdMob's, belongs to the expected member
 * and general account, was opened for THIS command (its key), and has its
 * reward event recorded. The session's own purpose is reported, so the
 * caller refuses a top-up session on a reset and a reset session on a
 * top-up. The event id is Google's transaction_id: (provider, event) is
 * unique across both purposes, so one ad pays or resets at most once.
 *
 * Not yet recorded and not expired is `retryable` (AD_REWARD_VERIFICATION_
 * PENDING, nothing written); expired without a record is final once the
 * grace after the callback deadline has passed (ADMOB_SESSION_EXPIRY_GRACE_MS).
 */
export class AdMobRewardVerifier implements AdRewardVerifier {
  readonly provider = ADMOB_PROVIDER;

  constructor(
    private readonly prisma: Pick<PrismaService, 'adRewardSession'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(
    request: AdRewardVerificationRequest,
  ): Promise<AdRewardVerificationResult> {
    if (request.provider !== this.provider || !SESSION_ID.test(request.proof))
      return failure('INVALID_PROOF', 'The proof is not an ad session.');
    const session = await this.prisma.adRewardSession.findUnique({
      where: { id: request.proof },
    });
    if (!session || session.provider !== this.provider)
      return failure('SESSION_NOT_FOUND', 'No such ad session.');
    if (
      session.userId !== request.expectedUserId ||
      session.tradingAccountId !== request.expectedTradingAccountId ||
      (request.commandKey !== undefined &&
        session.idempotencyKey !== request.commandKey)
    )
      return failure(
        'SESSION_MISMATCH',
        'The ad session belongs to another member, account or command.',
      );
    if (!session.ssvTransactionId || !session.ssvVerifiedAt) {
      // Final only past the callback's own deadline plus a grace, so a
      // callback still committing is never contradicted (admob.config.ts).
      if (
        this.now().getTime() >
        session.expiresAt.getTime() + ADMOB_SESSION_EXPIRY_GRACE_MS
      )
        return failure(
          'SESSION_EXPIRED',
          'The ad session ended without a confirmed reward.',
        );
      return {
        ok: false,
        retryable: true,
        reasonCode: 'SSV_PENDING',
        reason: 'The ad network has not confirmed the reward yet.',
      };
    }
    return {
      ok: true,
      provider: this.provider,
      purpose: session.purpose,
      providerEventId: session.ssvTransactionId,
      occurredAt: session.ssvRewardedAt ?? session.ssvVerifiedAt,
      // Identifiers only: never the signature, the raw callback or user_id.
      metadata: {
        sessionId: session.id,
        platform: session.platform,
        adUnit: session.ssvAdUnit,
        keyId: session.ssvKeyId,
        rewardItem: session.ssvRewardItem,
        rewardAmount: session.ssvRewardAmount,
      },
    };
  }
}

function failure(
  reasonCode: string,
  reason: string,
): AdRewardVerificationResult {
  return { ok: false, reasonCode, reason };
}
