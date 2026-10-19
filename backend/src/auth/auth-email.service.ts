import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApiError } from '../common/api-error';
import { EMAIL_AUTH_ENV_KEYS, readEmailAuthConfig } from './email-auth.config';

export type EmailPurpose = 'signup' | 'password_reset' | 'account_deletion';

const SUBJECTS: Record<EmailPurpose, string> = {
  signup: 'Trading Class 이메일 인증번호',
  password_reset: 'Trading Class 비밀번호 재설정 인증번호',
  account_deletion: 'Trading Class 회원탈퇴 인증번호',
};

// Account deletion is irreversible, so its mail says so and tells an owner who
// did not ask for it to secure the account instead of only ignoring it.
const DELETION_WARNING =
  '이 인증번호로 회원탈퇴를 확정하면 계정과 가상 투자 기록이 삭제되며 복구할 수 없습니다.';
const DELETION_IGNORE =
  '본인이 요청하지 않았다면 이 메일을 무시하고 비밀번호를 변경해주세요.';
const DEFAULT_IGNORE = '본인이 요청하지 않았다면 이 메일을 무시해주세요.';

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
    const subject = SUBJECTS[purpose];
    const deletion = purpose === 'account_deletion';
    const ignore = deletion ? DELETION_IGNORE : DEFAULT_IGNORE;
    const text = `${subject}\n\n인증번호: ${code}\n유효시간은 10분입니다.\n${deletion ? `${DELETION_WARNING}\n` : ''}${ignore}`;
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
          html: `<h1>${subject}</h1><p>인증번호: <strong>${code}</strong></p><p>유효시간은 10분입니다.</p>${deletion ? `<p>${DELETION_WARNING}</p>` : ''}<p>${ignore}</p>`,
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
