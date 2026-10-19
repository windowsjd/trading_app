import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(AuthEmailService.name);
  constructor(private readonly config: ConfigService) {}

  configuration() {
    let config: ReturnType<typeof readEmailAuthConfig>;
    try {
      config = readEmailAuthConfig(
        Object.fromEntries(
          EMAIL_AUTH_ENV_KEYS.map((key) => [key, this.config.get(key)]),
        ),
      );
    } catch {
      this.diagnostic('auth_email_configuration', 'invalid');
      throw this.unavailable();
    }
    if (!config) {
      this.diagnostic('auth_email_configuration', 'disabled');
      throw this.unavailable();
    }
    return config;
  }

  private unavailable() {
    return createApiError(
      'EMAIL_UNAVAILABLE',
      'Email verification is temporarily unavailable.',
      503,
    );
  }

  private diagnostic(
    event: 'auth_email_configuration' | 'auth_email_delivery',
    outcome:
      | 'disabled'
      | 'invalid'
      | 'accepted'
      | 'rejected'
      | 'timeout'
      | 'network_error',
  ) {
    try {
      const message = JSON.stringify({ event, outcome });
      if (outcome === 'accepted') this.logger.log(message);
      else this.logger.warn(message);
    } catch {
      // Observability must never turn acceptance into a failed challenge.
    }
  }

  /*
    Configuration is checked separately from provider failures so disabled or
    invalid settings cannot be reported as a provider acceptance/failure.
  */

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
    const signal = AbortSignal.timeout(4_000);
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal,
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
    } catch {
      this.diagnostic(
        'auth_email_delivery',
        signal.aborted ? 'timeout' : 'network_error',
      );
      throw this.unavailable();
    }
    // Never parse or propagate provider bodies. A stream cancellation failure
    // after HTTP acceptance does not change the provider's outcome.
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      /* no body is retained */
    }
    this.diagnostic(
      'auth_email_delivery',
      response.ok ? 'accepted' : 'rejected',
    );
    if (!response.ok) throw this.unavailable();
  }
}
