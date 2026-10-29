// Controllers are only inspected, never run: the generated client (which
// Jest cannot load) is replaced by its enums plus inert Prisma members.
jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  const inert = new Proxy(
    { Decimal },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : new Proxy(class {}, { get: () => ({}) }),
    },
  );
  return {
    ...jest.requireActual<Record<string, unknown>>('../generated/prisma/enums'),
    Prisma: inert,
    PrismaClient: class PrismaClient {},
  };
});

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  IS_OPTIONAL_AUTH_ROUTE_KEY,
  IS_PUBLIC_ROUTE_KEY,
} from './auth.decorators';

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'generated' ? [] : controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

type Route = { access: 'public' | 'optional'; route: string };

/** Every handler the global AccessTokenGuard lets through without a token. */
function tokenlessRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      const controller = value as { prototype: Record<string, unknown> };
      const base = Reflect.getMetadata(PATH_METADATA, controller) as
        | string
        | undefined;
      if (base === undefined) continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (path === undefined || method === undefined) continue;
        // The guard's own precedence: handler metadata, then the class.
        const flag = (key: string) =>
          (Reflect.getMetadata(key, handler) as boolean | undefined) ??
          (Reflect.getMetadata(key, controller) as boolean | undefined);
        const access = flag(IS_PUBLIC_ROUTE_KEY)
          ? 'public'
          : flag(IS_OPTIONAL_AUTH_ROUTE_KEY)
            ? 'optional'
            : null;
        if (!access) continue;
        const url = `/${base}/${path}`
          .replace(/\/+/gu, '/')
          .replace(/(.)\/$/u, '$1');
        routes.push({ access, route: `${RequestMethod[method]} ${url}` });
      }
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

describe('routes reachable without an access token', () => {
  it('are exactly the reviewed public and optional-auth routes', () => {
    // Guest browsing (2026-10-30) added only account-free market reads, which
    // serve GUEST_MARKET_DATA_ASSET_TYPES alone: the three spot reads, and for
    // crypto_futures the contract list, the contract candles and the USD/KRW
    // display rate. Every account, portfolio, wallet, order, position,
    // account-scoped futures, FX quote/execute, record, ranking and operator
    // route keeps requiring a token: adding one here is a review.
    expect(tokenlessRoutes()).toEqual([
      { access: 'optional', route: 'GET /api/v1/assets' },
      { access: 'optional', route: 'GET /api/v1/assets/:assetId' },
      { access: 'optional', route: 'GET /api/v1/assets/:assetId/candles' },
      { access: 'optional', route: 'GET /api/v1/futures/instruments' },
      {
        access: 'optional',
        route: 'GET /api/v1/futures/instruments/:instrumentId/candles',
      },
      { access: 'optional', route: 'GET /api/v1/fx/rates/current' },
      { access: 'optional', route: 'GET /api/v1/seasons' },
      { access: 'optional', route: 'GET /api/v1/seasons/current' },
      // Pre-existing: health checks, sign-in/recovery, deletion receipts and
      // releasing a device's push registration at logout.
      { access: 'public', route: 'GET /health' },
      { access: 'public', route: 'GET /health/db' },
      { access: 'public', route: 'GET /readiness' },
      { access: 'public', route: 'GET /readiness/alerts' },
      { access: 'public', route: 'POST /api/v1/auth/account-deletion' },
      { access: 'public', route: 'POST /api/v1/auth/account-deletion/status' },
      { access: 'public', route: 'POST /api/v1/auth/email/request' },
      { access: 'public', route: 'POST /api/v1/auth/email/verify' },
      { access: 'public', route: 'POST /api/v1/auth/login' },
      { access: 'public', route: 'POST /api/v1/auth/logout' },
      { access: 'public', route: 'POST /api/v1/auth/password/reset' },
      { access: 'public', route: 'POST /api/v1/auth/refresh' },
      { access: 'public', route: 'POST /api/v1/auth/signup' },
      { access: 'public', route: 'POST /api/v1/notifications/devices/release' },
    ]);
  });
});
