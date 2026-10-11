import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import IORedis from 'ioredis';
import {
  hash,
  validateCredentials,
  type Manifest,
  type Credentials,
  RENDER_REUSE,
  ROOT,
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
    if (m.renderReuse) {
      const isolation = (
        await pg.query(
          `SELECT
        r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
        r.rolbypassrls, r.rolcanlogin,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
        d.datdba=r.oid AS owns_database,
        has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
        EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS preserved_exists,
        EXISTS (SELECT 1 FROM pg_database WHERE datname=$1 AND
          (has_database_privilege(current_user, oid, 'CONNECT') OR
           has_database_privilege(current_user, oid, 'CREATE') OR
           has_database_privilege(current_user, oid, 'TEMPORARY'))) AS preserved_access,
        EXISTS (SELECT 1 FROM pg_database WHERE datname<>current_database() AND
          has_database_privilege(current_user, oid, 'CREATE')) AS foreign_create
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
        WHERE r.rolname=current_user`,
          [RENDER_REUSE.preservedDatabase],
        )
      ).rows[0];
      if (
        !isolation ||
        [
          'rolsuper',
          'rolcreatedb',
          'rolcreaterole',
          'rolreplication',
          'rolbypassrls',
          'memberships',
          'preserved_access',
          'foreign_create',
        ].some((k) => isolation[k] !== false) ||
        [
          'rolcanlogin',
          'owns_database',
          'schema_usage',
          'schema_create',
          'preserved_exists',
        ].some((k) => isolation[k] !== true)
      )
        throw new Error('LOAD_TEST_DB_ROLE_NOT_ISOLATED');
    }
    const usersExists = (
      await pg.query(
        "SELECT to_regclass('public.users') IS NOT NULL AS present",
      )
    ).rows[0].present;
    if (!beforeMigration && !usersExists)
      throw new Error('LOAD_TEST_SCHEMA_NOT_MIGRATED');
    const userCount = usersExists
      ? Number((await pg.query('SELECT count(*) AS n FROM users')).rows[0].n)
      : 0;
    if (beforeMigration && userCount !== 0)
      throw new Error('LOAD_TEST_MIGRATE_REQUIRES_EMPTY_USERS');
    const marker = `load-test-only:${hash({ resourceId: m.target.databaseResourceId, db: row.name, role: row.role })}`;
    // Verify BOTH resources before claiming either one.
    if (row.marker !== marker) {
      if ((!claim && !beforeMigration) || row.marker || userCount !== 0)
        throw new Error('LOAD_TEST_DB_NOT_EMPTY_OR_NOT_CLAIMED');
    }
    await redis.connect();
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
    }
    if (!beforeMigration && row.marker !== marker)
      await pg.query(
        `COMMENT ON DATABASE "${m.target.databaseName}" IS '${marker}'`,
      );
    if (previous !== redisIdentity) {
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

export function validateMigrationProof(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
  proof: string | undefined,
) {
  validateCredentials(
    {
      ...m,
      target: {
        ...m.target,
        databaseHost: m.target.databaseObserverHost ?? m.target.databaseHost,
        databasePort: m.target.databaseObserverPort ?? m.target.databasePort,
        valkeyHost: m.target.valkeyObserverHost ?? m.target.valkeyHost,
        valkeyPort: m.target.valkeyObserverPort ?? m.target.valkeyPort,
      },
    },
    c,
  );
  if (proof !== identitySignature(m, c, manifestHash))
    throw new Error('LOAD_TEST_MIGRATION_REQUIRES_CLI_PREFLIGHT');
}

/** The same observer credentials are checked before spawning any Prisma command. */
export async function migrate(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
  manifestFile: string,
  credentialFile: string,
) {
  await preflight(m, c, false, true);
  const config = resolve(ROOT, 'scripts/load-test/prisma.config.ts');
  for (const args of [
    ['migrate', 'deploy'],
    ['migrate', 'status'],
    [
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      resolve(ROOT, 'prisma/schema.prisma'),
      '--exit-code',
    ],
  ]) {
    execFileSync(
      resolve(ROOT, 'node_modules/.bin/prisma'),
      [...args, '--config', config],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          LOAD_TEST_MANIFEST: manifestFile,
          LOAD_TEST_CREDENTIALS: credentialFile,
          LOAD_TEST_MIGRATION_PREFLIGHT: identitySignature(m, c, manifestHash),
        },
      },
    );
  }
}
