import type { CorsOptions, CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';
import { createCorsOptions } from './cors.config';

function resolveOrigin(options: CorsOptions, requestOrigin?: string) {
  return new Promise<boolean | string | RegExp | (string | RegExp)[] | undefined>(
    (resolve, reject) => {
      const origin = options.origin as CustomOrigin;
      origin(requestOrigin, (error, allowedOrigin) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(allowedOrigin);
      });
    },
  );
}

describe('createCorsOptions', () => {
  it('allows requests without an Origin header for native apps and server-to-server calls', async () => {
    const options = createCorsOptions({ NODE_ENV: 'production' });

    await expect(resolveOrigin(options)).resolves.toBe(true);
  });

  it.each([
    'http://localhost:8081',
    'http://127.0.0.1:19006',
    'http://10.0.2.2:8081',
    'http://192.168.0.10:8081',
    'http://172.16.0.5:8081',
  ])('allows local development origin %s outside production', async (origin) => {
    const options = createCorsOptions({ NODE_ENV: 'development' });

    await expect(resolveOrigin(options, origin)).resolves.toBe(true);
  });

  it('blocks arbitrary browser origins in production when no origins are configured', async () => {
    const options = createCorsOptions({ NODE_ENV: 'production' });

    await expect(resolveOrigin(options, 'https://example.com')).resolves.toBe(
      false,
    );
  });

  it('allows explicitly configured production origins', async () => {
    const options = createCorsOptions({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    });

    await expect(
      resolveOrigin(options, 'https://app.example.com'),
    ).resolves.toBe(true);
    await expect(
      resolveOrigin(options, 'https://admin.example.com'),
    ).resolves.toBe(true);
    await expect(
      resolveOrigin(options, 'https://evil.example.com'),
    ).resolves.toBe(false);
  });

  it('keeps auth and idempotency headers available for preflight requests', () => {
    const options = createCorsOptions();

    expect(options.allowedHeaders).toEqual([
      'Authorization',
      'Content-Type',
      'X-Idempotency-Key',
    ]);
  });
});
