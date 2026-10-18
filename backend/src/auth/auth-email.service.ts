import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApiError } from '../common/api-error';
import { EMAIL_AUTH_ENV_KEYS, readEmailAuthConfig } from './email-auth.config';

export type EmailPurpose = 'signup' | 'password_reset';

@Injectable()
export class AuthEmailService {
  constructor(private readonly config: ConfigService) {}

  configuration() {
    const config = readEmailAuthConfig(
      Object.fromEntries(
        EMAIL_AUTH_ENV_KEYS.map((key) => [key, this.config.get(key)]),
      ),
    );
    if (!config)
      throw createApiError(
        'EMAIL_UNAVAILABLE',
        'Email verification is temporarily unavailable.',
        503,
      );
    return config;
  }

  async send(
    email: string,
    purpose: EmailPurpose,
    code: string,
    challengeId: string,
  ) {
    const { apiKey, from } = this.configuration();
    const subject =
      purpose === 'signup'
        ? 'Trading Class 이메일 인증번호'
        : 'Trading Class 비밀번호 재설정 인증번호';
    const text = `${subject}\n\n인증번호: ${code}\n유효시간은 10분입니다.\n본인이 요청하지 않았다면 이 메일을 무시해주세요.`;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(4_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `auth-email/${challengeId}`,
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject,
          text,
          html: `<h1>${subject}</h1><p>인증번호: <strong>${code}</strong></p><p>유효시간은 10분입니다.</p><p>본인이 요청하지 않았다면 이 메일을 무시해주세요.</p>`,
        }),
      });
      // Never parse or propagate provider error bodies; they may echo secrets.
      await response.body?.cancel();
      if (!response.ok)
        throw createApiError(
          'EMAIL_UNAVAILABLE',
          'Email verification is temporarily unavailable.',
          503,
        );
    } catch {
      throw createApiError(
        'EMAIL_UNAVAILABLE',
        'Email verification is temporarily unavailable.',
        503,
      );
    }
  }
}
