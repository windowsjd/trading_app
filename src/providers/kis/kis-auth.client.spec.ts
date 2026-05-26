import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderConfigService } from '../provider-config.service';
import { redactJsonValue } from '../provider-secret-redaction';
import {
  KisAuthClient,
  parseKisApprovalKeyResponse,
  parseKisTokenResponse,
} from './kis-auth.client';

describe('KIS auth client skeleton', () => {
  it('parses token responses without persisting token to DB', () => {
    const parsed = parseKisTokenResponse({
      access_token: 'kis-access-token',
      token_type: 'Bearer',
      expires_in: '86400',
      access_token_token_expired: '2026-05-27T00:00:00.000Z',
    });

    expect(parsed).toEqual({
      accessToken: 'kis-access-token',
      tokenType: 'Bearer',
      expiresInSeconds: 86400,
      expiresAt: new Date('2026-05-27T00:00:00.000Z'),
    });
  });

  it('parses WebSocket approval_key responses', () => {
    expect(
      parseKisApprovalKeyResponse({
        approval_key: 'kis-approval-key',
      }),
    ).toEqual({
      approvalKey: 'kis-approval-key',
    });
  });

  it('redacts KIS app key, app secret, token, and approval_key fields', () => {
    const redacted = redactJsonValue(
      {
        appkey: 'kis-app-key',
        appsecret: 'kis-app-secret',
        access_token: 'kis-token',
        approval_key: 'kis-approval',
      },
      {
        secrets: ['kis-app-key', 'kis-app-secret', 'kis-token', 'kis-approval'],
      },
    );

    expect(JSON.stringify(redacted)).not.toContain('kis-app-key');
    expect(JSON.stringify(redacted)).not.toContain('kis-app-secret');
    expect(JSON.stringify(redacted)).not.toContain('kis-token');
    expect(JSON.stringify(redacted)).not.toContain('kis-approval');
  });

  it('skips KIS live REST calls when base URL is empty', async () => {
    const client = new KisAuthClient({
      getConfig: () => ({
        common: {
          providerIngestionEnabled: true,
          httpTimeoutMs: 5000,
          rawPayloadMaxBytes: 12000,
        },
        exchangeRateApi: {
          enabled: false,
          baseUrl: 'https://example.test',
        },
        binance: {
          enabled: false,
          restBaseUrl: 'https://example.test',
          wsMarketDataBaseUrl: 'wss://example.test',
          symbols: [],
          usdtAsUsdEquivalent: true,
        },
        kis: {
          enabled: true,
          appKey: 'kis-app-key',
          appSecret: 'kis-app-secret',
          restBaseUrl: undefined,
          wsBaseUrl: undefined,
          maxWatchlistSize: 41,
          domesticSymbols: [],
          usSymbols: [],
          allSymbols: [],
          canCallRestLive: false,
          canCallWebSocketLive: false,
        },
      }),
    } as unknown as ProviderConfigService);

    await expect(
      client.requestRestToken({
        path: '/explicit-token-path',
        body: {},
      }),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'KIS_REST_BASE_URL_MISSING',
    });
  });

  it('does not add KIS real trading surface names in provider skeleton files', () => {
    const dir = join(__dirname);
    const text = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');

    expect(text).not.toMatch(
      /placeOrder|cancelOrder|accountNumber|balanceEndpoint|orderEndpoint|tradingAccount/u,
    );
  });
});
