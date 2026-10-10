import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import IORedis from 'ioredis';
import {
  hash,
  validateCredentials,
  type Manifest,
  type Credentials,
} from './manifest';

export function controlKey(m: Manifest, suffix: string) {
  return `load-test:${m.runId}:${suffix}`;
}
export function identitySignature(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
) {
  return createHmac('sha256', c.controlSecret)
    .update(
      JSON.stringify({ manifestHash, sha: m.expectedGitSha, target: m.target }),
    )
    .digest('hex');
}
export async function preflight(
  m: Manifest,
  c: Credentials,
  claim = false,
  beforeMigration = false,
) {
  validateCredentials(
    claim
      ? m
      : {
          ...m,
          target: {
            ...m.target,
            databaseHost:
              m.target.databaseObserverHost ?? m.target.databaseHost,
            databasePort:
              m.target.databaseObserverPort ?? m.target.databasePort,
            valkeyHost: m.target.valkeyObserverHost ?? m.target.valkeyHost,
            valkeyPort: m.target.valkeyObserverPort ?? m.target.valkeyPort,
          },
        },
    c,
  );
  const pg = new Client({
    connectionString: c.databaseUrl,
    application_name: 'load-test-observer',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const redis = new IORedis(c.valkeyUrl, {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on('error', () => {});
  try {
    await pg.connect();
    await redis.connect();
    const row = (
      await pg.query(
        "SELECT current_database() AS name, current_user AS role, version() AS version, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0];
    if (
      row.name !== m.target.databaseName ||
      row.role !== m.target.databaseUser
    )
      throw new Error('LOAD_TEST_DB_IDENTITY_MISMATCH');
    if ((await pg.query('SHOW TimeZone')).rows[0].TimeZone !== 'UTC')
      throw new Error('LOAD_TEST_DB_TIMEZONE_MUST_BE_UTC');
    const usersExists = (
      await pg.query(
        "SELECT to_regclass('public.users') IS NOT NULL AS present",
      )
    ).rows[0].present;
    const userCount = usersExists
      ? Number((await pg.query('SELECT count(*) AS n FROM users')).rows[0].n)
      : 0;
    if (beforeMigration && userCount !== 0)
      throw new Error('LOAD_TEST_MIGRATE_REQUIRES_EMPTY_USERS');
    const marker = `load-test-only:${hash({ resourceId: m.target.databaseResourceId, db: row.name, role: row.role })}`;
    if (row.marker !== marker) {
      if ((!claim && !beforeMigration) || row.marker || userCount !== 0)
        throw new Error('LOAD_TEST_DB_NOT_EMPTY_OR_NOT_CLAIMED');
      if (!beforeMigration)
        await pg.query(
          `COMMENT ON DATABASE "${m.target.databaseName}" IS '${marker}'`,
        );
    }
    const info = await redis.info();
    const serverId = /^run_id:(\S+)/m.exec(info)?.[1];
    const redisIdentity = hash({
      resourceId: m.target.valkeyResourceId,
      host: m.target.valkeyHost,
      port: m.target.valkeyPort,
    });
    const previous = await redis.get('load-test:physical-identity');
    if (previous !== redisIdentity) {
      if (
        (!claim && !beforeMigration) ||
        previous ||
        (await redis.dbsize()) !== 0
      )
        throw new Error('LOAD_TEST_VALKEY_NOT_EMPTY_OR_NOT_CLAIMED');
      if (
        !beforeMigration &&
        (await redis.set(
          'load-test:physical-identity',
          redisIdentity,
          'NX',
        )) !== 'OK'
      )
        throw new Error('LOAD_TEST_VALKEY_CLAIM_RACE');
    }
    return {
      databaseVersion: row.version as string,
      valkeyVersion: /^redis_version:(\S+)/m.exec(info)?.[1],
      valkeyServerId: serverId,
      maxMemory: Number(/^maxmemory:(\d+)/m.exec(info)?.[1] ?? 0),
      maxMemoryPolicy: /^maxmemory_policy:(\S+)/m.exec(info)?.[1],
    };
  } finally {
    await pg.end().catch(() => undefined);
    redis.disconnect();
  }
}
export async function verifyApi(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
) {
  const r = await fetch(`${m.target.apiOrigin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (
    !r.ok ||
    r.headers.get('x-load-test-identity') !==
      identitySignature(m, c, manifestHash)
  )
    throw new Error('LOAD_TEST_API_IDENTITY_MISMATCH');
}
