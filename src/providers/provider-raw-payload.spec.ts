import { Buffer } from 'node:buffer';
import { buildProviderRawPayloadJson } from './provider-raw-payload';

describe('provider raw payload', () => {
  it('redacts secrets before storing raw payload JSON', () => {
    const payload = buildProviderRawPayloadJson({
      payload: {
        result: 'success',
        echoedKey: 'secret-key',
      },
      maxBytes: 1000,
      secrets: ['secret-key'],
    });

    expect(payload.truncated).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('secret-key');
    expect(JSON.stringify(payload)).toContain('[REDACTED]');
  });

  it('truncates oversized payloads by max byte size', () => {
    const payload = buildProviderRawPayloadJson({
      payload: {
        value: 'x'.repeat(200),
      },
      maxBytes: 50,
    });

    expect(payload.truncated).toBe(true);
    if (payload.truncated) {
      expect(payload.originalBytes).toBeGreaterThan(50);
      expect(Buffer.byteLength(payload.payloadPreview, 'utf8')).toBeLessThanOrEqual(
        50,
      );
    }
  });
});
