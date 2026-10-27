import { createHmac } from 'node:crypto';
import type { Credentials } from './manifest';

/**
 * Signup email verification for the fixture server, without an email provider.
 *
 * The server's real AuthEmailService sends to api.resend.com; the replay
 * (`Replay.fetch`) answers that request in-process like every other provider,
 * and keeps the code in this run's Valkey under `authEmailMailboxKey` for
 * `prepare`, which then verifies it over HTTP like the app does. Only the
 * fixture's own key and `@example.invalid` recipients are accepted; no mail
 * leaves the process.
 */
export const LOAD_TEST_EMAIL_API_KEY = 're_load_test_fixture';
const FROM = 'Trading Class <admin@nanghwa.com>';
/** The code's own validity (EmailVerificationService: 10 minutes). */
export const AUTH_EMAIL_MAILBOX_TTL_MS = 600_000;

export const authEmailMailboxKey = (challengeId: string) =>
  `load-test:auth-email:${challengeId}`;

/** The server's email settings: a fixture key the replay accepts, never a provider credential. */
export function loadTestEmailEnvironment(c: Credentials) {
  return {
    RESEND_API_KEY: LOAD_TEST_EMAIL_API_KEY,
    EMAIL_FROM: FROM,
    EMAIL_VERIFICATION_SECRET: createHmac('sha256', c.controlSecret)
      .update('load-test:email-verification')
      .digest('hex'),
  };
}

/** One AuthEmailService request, or null for anything but the fixture's own signup mail. */
export function parseFixtureEmail(
  init?: RequestInit,
): { challengeId: string; code: string } | null {
  if (init?.method !== 'POST' || typeof init.body !== 'string') return null;
  const headers = new Headers(init.headers);
  if (headers.get('authorization') !== `Bearer ${LOAD_TEST_EMAIL_API_KEY}`)
    return null;
  const challengeId = /^auth-email\/([0-9a-f-]{36})$/.exec(
    headers.get('idempotency-key') ?? '',
  )?.[1];
  let mail: { from?: unknown; to?: unknown; text?: unknown };
  try {
    mail = JSON.parse(init.body) as typeof mail;
  } catch {
    return null;
  }
  const code =
    typeof mail.text === 'string'
      ? /인증번호: (\d{6})\n/.exec(mail.text)?.[1]
      : undefined;
  const recipients = Array.isArray(mail.to) ? mail.to : [];
  if (
    !challengeId ||
    !code ||
    mail.from !== FROM ||
    recipients.length !== 1 ||
    typeof recipients[0] !== 'string' ||
    !recipients[0].endsWith('@example.invalid')
  )
    return null;
  return { challengeId, code };
}
