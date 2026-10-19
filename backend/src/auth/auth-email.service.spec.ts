import { ConfigService } from '@nestjs/config';
import { AuthEmailService } from './auth-email.service';
import {
  readAuthTrustProxyHops,
  readEmailAuthConfig,
} from './email-auth.config';
import { validateEnv } from '../common/env-validation';

const env = {
  RESEND_API_KEY: 're_test_backend_secret',
  EMAIL_FROM: 'Trading Class <admin@nanghwa.com>',
  EMAIL_VERIFICATION_SECRET: 'a'.repeat(64),
};

describe('Resend authentication delivery', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['signup', 'password_reset', 'account_deletion'] as const)(
    'sends %s text and HTML with a bounded request and idempotency key',
    async (purpose) => {
      const cancel = jest.fn();
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({
          ok: true,
          body: { cancel },
        } as unknown as Response);
      await new AuthEmailService(new ConfigService(env)).send(
        'user@example.com',
        purpose,
        '000123',
        'challenge-id',
      );
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init?.signal instanceof AbortSignal).toBe(true);
      expect(init?.headers).toMatchObject({
        'Idempotency-Key': 'auth-email/challenge-id',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      });
      const body = JSON.parse(init?.body as string) as Record<string, string>;
      expect(body.from).toBe(env.EMAIL_FROM);
      expect(body.subject).toBe(
        {
          signup: 'Trading Class 이메일 인증번호',
          password_reset: 'Trading Class 비밀번호 재설정 인증번호',
          account_deletion: 'Trading Class 회원탈퇴 인증번호',
        }[purpose],
      );
      // Only the irreversible purpose warns and asks to secure the account.
      for (const part of [body.text, body.html])
        expect(
          part.includes('복구할 수 없습니다') &&
            part.includes('비밀번호를 변경'),
        ).toBe(purpose === 'account_deletion');
      expect(body.text).toContain('000123');
      expect(body.html).toContain('000123');
      expect(body.text).toContain('10분');
      expect(body.text).toContain('무시');
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['reject', 'http-error'])(
    'sanitizes %s without reading provider errors or logging secrets',
    async (failure) => {
      const fetchMock = jest.spyOn(global, 'fetch');
      if (failure === 'reject')
        fetchMock.mockRejectedValue(
          new Error('re_test_backend_secret 000123 password-value'),
        );
      else
        fetchMock.mockResolvedValue({
          ok: false,
          body: { cancel: async () => {} },
          json: () => {
            throw new Error('must not parse');
          },
        } as unknown as Response);
      const logs = [
        jest.spyOn(console, 'log'),
        jest.spyOn(console, 'warn'),
        jest.spyOn(console, 'error'),
      ];
      await expect(
        new AuthEmailService(new ConfigService(env)).send(
          'user@example.com',
          'signup',
          '000123',
          'id',
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'EMAIL_UNAVAILABLE' } },
      });
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );
  it('fails closed without config and rejects partial or malformed settings without echoing values', () => {
    expect(readEmailAuthConfig({}) === null).toBe(true);
    expect(() =>
      new AuthEmailService(new ConfigService({})).configuration(),
    ).toThrow();
    expect(() => validateEnv(env)).not.toThrow();
    for (const patch of [
      { EMAIL_VERIFICATION_SECRET: '' },
      { EMAIL_VERIFICATION_SECRET: 'short' },
      { EMAIL_FROM: 'attacker <other@example.com>' },
      { RESEND_API_KEY: '\r\ninjected-secret' },
    ]) {
      expect(() => validateEnv({ ...env, ...patch })).toThrow();
      try {
        validateEnv({ ...env, ...patch });
      } catch (error) {
        expect((error as Error).message).not.toMatch(
          /injected-secret|attacker|re_test_backend_secret/,
        );
      }
    }
  });
  it('requires an explicit bounded trusted proxy topology', () => {
    expect(readAuthTrustProxyHops(undefined)).toBe(0);
    expect(readAuthTrustProxyHops('1')).toBe(1);
    for (const input of ['true', '-1', '6', 1])
      expect(() => readAuthTrustProxyHops(input)).toThrow();
  });
});
