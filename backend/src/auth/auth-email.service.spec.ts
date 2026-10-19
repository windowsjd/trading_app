import express from 'express';
import request from 'supertest';
import { Logger } from '@nestjs/common';
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
  let log: jest.SpyInstance, warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(['signup', 'password_reset', 'account_deletion'] as const)(
    'sends %s text and HTML with a bounded request and idempotency key',
    async (purpose) => {
      const cancel = jest.fn();
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        body: { cancel: cancel.mockResolvedValue(undefined) },
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
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: 'auth_email_delivery', outcome: 'accepted' }),
      );
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
      for (const output of logs) expect(output).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'auth_email_delivery',
          outcome: failure === 'reject' ? 'network_error' : 'rejected',
        }),
      );
      const recorded = JSON.stringify([log.mock.calls, warn.mock.calls]);
      expect(recorded).not.toMatch(
        /user@example|000123|re_test|password-value|challenge-id|Authorization/,
      );
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
  it('records timeouts, disabled and invalid config with fixed codes only', async () => {
    const controller = new AbortController();
    controller.abort();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('secret provider body'));
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
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth_email_delivery', outcome: 'timeout' }),
    );
    for (const [settings, outcome] of [
      [{}, 'disabled'],
      [{ ...env, EMAIL_FROM: 'bad-private-email' }, 'invalid'],
    ] as const) {
      expect(() =>
        new AuthEmailService(new ConfigService(settings)).configuration(),
      ).toThrow();
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({ event: 'auth_email_configuration', outcome }),
      );
    }
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /secret|private|user@example|000123/,
    );
    expect(log).not.toHaveBeenCalled();
  });
  it('keeps accepted delivery successful even when body cleanup or logging fails', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: {
        cancel: () => Promise.reject(new Error('private')),
      },
    } as unknown as Response);
    log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    await expect(
      new AuthEmailService(new ConfigService(env)).send(
        'user@example.com',
        'signup',
        '000123',
        'id',
      ),
    ).resolves.toBeUndefined();
    warn.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('private'));
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
  });
  it('requires an explicit bounded trusted proxy topology', () => {
    expect(readAuthTrustProxyHops(undefined)).toBe(0);
    expect(readAuthTrustProxyHops('1')).toBe(1);
    for (const input of ['true', '-1', '6', 1])
      expect(() => readAuthTrustProxyHops(input)).toThrow();
  });
});

describe('request IP trust boundary (synthetic forwarded headers)', () => {
  function app(hops: number) {
    const server = express();
    server.set('trust proxy', readAuthTrustProxyHops(String(hops)));
    server.get('/ip-test', (req, res) =>
      res.json({
        clientA: req.ip === '192.0.2.10',
        clientB: req.ip === '192.0.2.20',
        forged: req.ip === '198.51.100.66',
      }),
    );
    return server;
  }
  it('ignores arbitrary forwarding headers at the safe default', async () => {
    const server = app(0);
    for (const header of [
      'X-Forwarded-For',
      'Forwarded',
      'X-Real-IP',
      'CF-Connecting-IP',
    ]) {
      const response = await request(server)
        .get('/ip-test')
        .set(header, '198.51.100.66');
      expect(response.body).toEqual({
        clientA: false,
        clientB: false,
        forged: false,
      });
    }
  });
  it('selects the trusted suffix, separates clients, and ignores attacker-controlled prefixes in a verified one-hop topology', async () => {
    const server = app(1); // Test topology only; never a recommendation for Render.
    const a = await request(server)
      .get('/ip-test')
      .set('X-Forwarded-For', '198.51.100.66, 192.0.2.10');
    const b = await request(server)
      .get('/ip-test')
      .set('X-Forwarded-For', '198.51.100.66, 192.0.2.20');
    expect(a.body).toEqual({ clientA: true, clientB: false, forged: false });
    expect(b.body).toEqual({ clientA: false, clientB: true, forged: false });
  });
});
