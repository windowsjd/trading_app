import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  AuthEmailService,
  type EmailPurpose,
} from '../../src/auth/auth-email.service';
import { EmailVerificationService } from '../../src/auth/email-verification.service';

/** In-memory delivery boundary for DB tests. Never contacts an email provider. */
export function authEmailFixture(prisma: PrismaService) {
  const codes = new Map<string, string>();
  const emails = new Set<string>();
  const deliveries: { email: string; purpose: EmailPurpose }[] = [];
  const secret = randomBytes(32).toString('hex');
  let fail = false;
  const mail = {
    configuration: () => ({
      apiKey: 're_fixture',
      from: 'Trading Class <admin@nanghwa.com>',
      secret,
    }),
    async send(email: string, purpose: EmailPurpose, code: string, id: string) {
      if (fail) throw new Error('Fixture delivery failure');
      codes.set(id, code);
      deliveries.push({ email, purpose });
    },
  };
  const verification = new EmailVerificationService(
    prisma,
    mail as AuthEmailService,
  );
  verification.padResponse = async () => {};
  const metadata = {
    ipAddress: `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`,
  };
  async function proof(email: string, purpose: EmailPurpose) {
    emails.add(email);
    const requested = await verification.request({ email, purpose }, metadata);
    const code = codes.get(requested.data.challengeId);
    if (!code) throw new Error('Expected fixture delivery');
    const response = await verification.verify(
      { email, purpose, challengeId: requested.data.challengeId, code },
      metadata,
    );
    return response.data.verificationToken;
  }
  return {
    verification,
    codes,
    deliveries,
    metadata,
    secret,
    proof,
    cleanup: async () => {
      await prisma.emailAuthChallenge.deleteMany({
        where: { email: { in: [...emails] } },
      });
      const keys = ['send', 'verify', 'complete'].map((action) =>
        createHmac('sha256', secret)
          .update(JSON.stringify(['ip', action, metadata.ipAddress]))
          .digest('hex'),
      );
      await prisma.emailAuthRateBucket.deleteMany({
        where: { key: { in: keys } },
      });
    },
    failDelivery: (value: boolean) => {
      fail = value;
    },
  };
}
