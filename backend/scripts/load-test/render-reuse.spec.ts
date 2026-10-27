import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import IORedis from 'ioredis';
import {
  RENDER_REUSE,
  PRODUCTION_IDS,
  ROOT,
  defaultManifest,
  validateCredentials,
  validateManifest,
  validateCommandApproval,
  validateServerEnvironment,
  assertNormalEnvironment,
  observerCredentials,
  readInputs,
  hash,
  workloadHash,
  type Manifest,
  type Credentials,
} from './manifest';
import {
  preflight,
  migrate,
  validateMigrationProof,
  identitySignature,
} from './preflight';
import { prepare } from './prepare';
import { run } from './run';
import { Metrics } from './metrics';
import {
  serve,
  applyTestEnvironment,
  acquireServerLease,
  SERVER_LEASE_KEY,
} from './server';
import { Test } from '@nestjs/testing';
import { mergeRuntimeEnv } from '../lib/load-runtime-env';
import { getOpsSchedulerConfig } from '../../src/ops/ops-config';

function fixture() {
  const m = defaultManifest('a'.repeat(40), true);
  m.allowDirtyLocalSmoke = false;
  m.renderReuse = {
    transitionApproved: true,
    restorePlanRecorded: true,
    exclusiveApiServiceConfirmed: true,
  };
  m.target = {
    ...m.target,
    apiOrigin: RENDER_REUSE.apiOrigin,
    apiResourceId: RENDER_REUSE.apiResourceId,
    databaseResourceId: RENDER_REUSE.databaseResourceId,
    databaseHost: RENDER_REUSE.databaseResourceId,
    databaseObserverHost: `${RENDER_REUSE.databaseResourceId}.singapore-postgres.render.com`,
    databasePort: 5432,
    databaseObserverPort: 5432,
    databaseName: RENDER_REUSE.databaseName,
    databaseUser: RENDER_REUSE.databaseUser,
    valkeyResourceId: 'red-loadtestfixture01',
    valkeyHost: 'red-loadtestfixture01',
    valkeyPort: 6379,
    valkeyObserverHost: 'red-loadtestfixture01.singapore-redis.render.com',
    valkeyObserverPort: 6379,
  };
  const c: Credentials = {
    databaseUrl: `postgresql://${m.target.databaseUser}:test-only-password@${m.target.databaseHost}:5432/${m.target.databaseName}`,
    databaseObserverUrl: `postgresql://${m.target.databaseUser}:test-only-password@${m.target.databaseObserverHost}:5432/${m.target.databaseName}?sslmode=require`,
    valkeyUrl: `redis://${m.target.valkeyHost}:6379/0`,
    valkeyObserverUrl: `rediss://default:test-only-password@${m.target.valkeyObserverHost}:6379/0`,
    jwtSecret: 'load-test-' + 'j'.repeat(30),
    userPassword: 'load-test-' + 'p'.repeat(30),
    controlSecret: 'load-test-' + 'c'.repeat(30),
  };
  return { m, c };
}
const runtime = (m: Manifest, c: Credentials) => ({
  LOAD_TEST_MODE: 'render-reuse',
  RENDER_SERVICE_ID: m.target.apiResourceId,
  RENDER_GIT_COMMIT: m.expectedGitSha,
  DATABASE_URL: c.databaseUrl,
  REDIS_URL: c.valkeyUrl,
});

afterEach(() => jest.restoreAllMocks());

describe('reviewed Render reuse transition', () => {
  it('accepts only the approved API / logical DB / role while retaining workload identity', () => {
    const { m, c } = fixture();
    expect(() => validateCredentials(m, c)).not.toThrow();
    expect(workloadHash(m)).toBe(
      workloadHash(defaultManifest(m.expectedGitSha, true)),
    );
    delete m.renderReuse;
    expect(() => validateManifest(m)).toThrow('production target');
  });
  it.each([
    'transitionApproved',
    'restorePlanRecorded',
    'exclusiveApiServiceConfirmed',
  ] as const)(
    'requires explicit %s independently of workload approval',
    (key) => {
      const { m } = fixture();
      m.cloudExecutionApproved = true;
      m.renderReuse![key] = false;
      expect(() => validateManifest(m)).toThrow('approval required');
      (m.renderReuse as any)[key] = 'true';
      expect(() => validateManifest(m)).toThrow('approval required');
    },
  );
  it('refuses the server entry before connections when the Render switch is missing', async () => {
    const { m, c } = fixture();
    const env = process.env;
    const connect = jest.spyOn(Client.prototype, 'connect');
    try {
      process.env = { ...runtime(m, c), LOAD_TEST_MODE: undefined };
      await expect(serve(m, c, 'hash', '/unused')).rejects.toThrow(
        'runtime mode',
      );
      expect(connect.mock.calls.length).toBe(0);
    } finally {
      process.env = env;
    }
  });
  it('confines synthetic flags and credentials to the isolated server environment', () => {
    const { m, c } = fixture();
    const env = process.env,
      cwd = process.cwd();
    let isolatedDirectory: string | undefined;
    try {
      process.env = {
        ...env,
        ...runtime(m, c),
        KIS_APP_SECRET: 'original-secret',
        UNAPPROVED_PROVIDER_SECRET: 'original-secret',
        FUTURES_TRADING_MODE: 'DISABLED',
      };
      applyTestEnvironment(m, c);
      isolatedDirectory = process.cwd();
      expect(isolatedDirectory !== cwd).toBe(true);
      expect(process.env.NODE_ENV).toBe('test');
      expect(process.env.DATABASE_URL).toBe(c.databaseUrl);
      expect(process.env.REDIS_URL).toBe(c.valkeyUrl);
      expect(process.env.KIS_APP_SECRET).toBe('load-test-kis-secret');
      // The replay serves KIS REST, so the KIS job never asks for a WebSocket approval.
      expect(getOpsSchedulerConfig().providerKisPriceIngestionMode).toBe(
        'rest_current_price',
      );
      expect(process.env.UNAPPROVED_PROVIDER_SECRET === undefined).toBe(true);
      expect(process.env.RENDER_SERVICE_ID === undefined).toBe(true);
      expect(process.env.FUTURES_TRADING_MODE).toBe('ENABLED');
    } finally {
      process.chdir(cwd);
      process.env = env;
      if (isolatedDirectory)
        rmSync(isolatedDirectory, { recursive: true, force: true });
    }
  });
  it.each([
    ['databaseName', 'trading_app_fbbk'],
    ['databaseName', 'arbitrary_load_test'],
    ['databaseUser', 'trading_app_fbbk_user'],
    ['databaseUser', 'load_test_arbitrary'],
    ['databaseHost', 'unreviewed.example.com'],
    ['databasePort', 5433],
    ['apiOrigin', 'https://different-test.onrender.com'],
    ['apiResourceId', 'srv-other'],
    ['databaseResourceId', PRODUCTION_IDS[3]],
    ['databaseObserverHost', 'unreviewed.example.com'],
    ['databaseObserverPort', 5433],
    ['valkeyObserverHost', 'different-redis.render.com'],
    ['valkeyPort', 6380],
    ['valkeyHost', '127.0.0.1'],
  ])('rejects wrong %s = %s before any connection', async (key, value) => {
    const { m, c } = fixture();
    (m.target as any)[key] = value;
    const connect = jest.spyOn(Client.prototype, 'connect');
    await expect(preflight(m, c, true)).rejects.toThrow('LOAD_TEST_GUARD');
    expect(connect.mock.calls.length).toBe(0);
  });
  it('keeps the existing Valkey blocked even with all reuse approvals', () => {
    const { m } = fixture();
    m.target.valkeyResourceId = PRODUCTION_IDS[2];
    m.target.valkeyHost = PRODUCTION_IDS[2];
    expect(() => validateManifest(m)).toThrow('production target');
  });
  it.each(['migrate', 'serve', 'guard', 'audit'])(
    'permits approved transition %s without load approval',
    (command) => {
      expect(() => validateCommandApproval(fixture().m, command)).not.toThrow();
    },
  );
  it.each(['prepare', 'run'])(
    'refuses unapproved %s before opening connections or creating fixtures',
    async (command) => {
      const { m, c } = fixture();
      const connect = jest.spyOn(Client.prototype, 'connect');
      const result =
        command === 'prepare'
          ? prepare(m, c, 'manifest-hash', '/unused', new Metrics())
          : run(
              m,
              c,
              'manifest-hash',
              '/unused/fixture.json',
              '/unused',
              new Metrics(),
            );
      await expect(result).rejects.toThrow('separate cloud workload');
      expect(connect.mock.calls.length).toBe(0);
      m.cloudExecutionApproved = true;
      expect(() => validateCommandApproval(m, command)).not.toThrow();
    },
  );
  it.each([
    'LOAD_TEST_MODE',
    'RENDER_SERVICE_ID',
    'RENDER_GIT_COMMIT',
    'DATABASE_URL',
    'REDIS_URL',
  ])('refuses missing or wrong runtime %s before resource claim', (key) => {
    const { m, c } = fixture();
    const env: Record<string, string | undefined> = runtime(m, c);
    expect(() => validateServerEnvironment(m, c, env)).not.toThrow();
    delete env[key];
    expect(() => validateServerEnvironment(m, c, env)).toThrow('runtime mode');
    env[key] = 'wrong';
    expect(() => validateServerEnvironment(m, c, env)).toThrow('runtime mode');
  });
  it('rejects original DB/user credentials, missing password and URL overrides', () => {
    const { m, c } = fixture();
    for (const databaseUrl of [
      c.databaseUrl.replace(m.target.databaseName, 'trading_app_fbbk'),
      c.databaseUrl.replace(m.target.databaseUser, 'trading_app_fbbk_user'),
      c.databaseUrl.replace(':test-only-password', ''),
      c.databaseUrl + '?%68ost=other',
      c.databaseUrl + '?options=other',
      c.databaseUrl + '?schema=other',
      c.databaseUrl + '?user=other',
    ])
      expect(() => validateCredentials(m, { ...c, databaseUrl })).toThrow();
    expect(() =>
      validateCredentials(m, {
        ...c,
        valkeyUrl: c.valkeyUrl.replace('/0', '/1'),
      }),
    ).toThrow('separate physical');
    expect(() =>
      validateCredentials(m, {
        ...c,
        databaseUrl: c.databaseUrl.replace(
          'test-only-password',
          PRODUCTION_IDS[2],
        ),
      }),
    ).toThrow('production credential target');
  });
  it('requires TLS and authentication on external observer URLs', () => {
    const { m, c } = fixture();
    const observer = {
      ...m,
      target: {
        ...m.target,
        databaseHost: m.target.databaseObserverHost!,
        valkeyHost: m.target.valkeyObserverHost!,
      },
    };
    const creds = observerCredentials(c);
    expect(() => validateCredentials(observer, creds)).not.toThrow();
    expect(() =>
      validateCredentials(observer, {
        ...creds,
        databaseUrl: creds.databaseUrl.replace('?sslmode=require', ''),
      }),
    ).toThrow('TLS required');
    expect(() =>
      validateCredentials(observer, {
        ...creds,
        valkeyUrl: creds.valkeyUrl.replace('rediss:', 'redis:'),
      }),
    ).toThrow('TLS and authentication');
    expect(() =>
      validateCredentials(observer, {
        ...creds,
        valkeyUrl: creds.valkeyUrl.replace('default:test-only-password@', ''),
      }),
    ).toThrow('TLS and authentication');
  });
  it('validates both credential routes, file permissions and pinned clean Git identity', () => {
    const { m, c } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'render-reuse-inputs-'));
    const manifest = join(dir, 'manifest.json'),
      credentials = join(dir, 'credentials.json');
    const git = jest
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation(((_file: string, args: string[]) =>
        args[0] === 'rev-parse' ? m.expectedGitSha : '') as any);
    const write = () => {
      writeFileSync(manifest, JSON.stringify(m), { mode: 0o600 });
      writeFileSync(credentials, JSON.stringify(c), { mode: 0o600 });
    };
    try {
      write();
      expect(readInputs(manifest, credentials).git.sha).toBe(m.expectedGitSha);
      c.databaseObserverUrl = c.databaseObserverUrl!.replace(
        m.target.databaseName,
        'trading_app_fbbk',
      );
      write();
      expect(() => readInputs(manifest, credentials)).toThrow(
        'database credential scope',
      );
      c.databaseObserverUrl = fixture().c.databaseObserverUrl;
      write();
      chmodSync(credentials, 0o644);
      expect(() => readInputs(manifest, credentials)).toThrow('mode 0600');
      chmodSync(credentials, 0o600);
      git.mockImplementation(((_file: string, args: string[]) =>
        args[0] === 'rev-parse' ? m.expectedGitSha : ' M modified') as any);
      expect(() => readInputs(manifest, credentials)).toThrow(
        'Git SHA / dirty tree',
      );
      git.mockReturnValue('b'.repeat(40) as any);
      expect(() => readInputs(manifest, credentials)).toThrow(
        'Git SHA / dirty tree',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('uses the Render deploy SHA only for the approved server when the runtime has no Git checkout', () => {
    const { m, c } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'render-reuse-runtime-'));
    const manifest = join(dir, 'manifest.json'),
      credentials = join(dir, 'credentials.json');
    const write = (value: Manifest) => {
      writeFileSync(manifest, JSON.stringify(value), { mode: 0o600 });
      writeFileSync(credentials, JSON.stringify(c), { mode: 0o600 });
    };
    const git = jest
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });
    try {
      write(m);
      const accepted = readInputs(manifest, credentials, runtime(m, c));
      expect(accepted.git.sha).toBe(m.expectedGitSha);
      expect(accepted.git.dirty).toBe(false);
      // Generator, migrate and other commands never pass the server environment.
      expect(() => readInputs(manifest, credentials)).toThrow(
        'not a git repository',
      );
      for (const [key, value] of [
        ['LOAD_TEST_MODE', undefined],
        ['RENDER_SERVICE_ID', 'srv-other'],
        ['RENDER_GIT_COMMIT', undefined],
        ['RENDER_GIT_COMMIT', 'short'],
      ] as const)
        expect(() =>
          readInputs(manifest, credentials, {
            ...runtime(m, c),
            [key]: value,
          }),
        ).toThrow('not a git repository');
      expect(() =>
        readInputs(manifest, credentials, {
          ...runtime(m, c),
          RENDER_GIT_COMMIT: 'b'.repeat(40),
        }),
      ).toThrow('Git SHA / dirty tree');
      // A dedicated / local manifest can never substitute an ambient SHA.
      const local = defaultManifest(m.expectedGitSha, false);
      writeFileSync(manifest, JSON.stringify(local), { mode: 0o600 });
      writeFileSync(
        credentials,
        JSON.stringify({
          ...c,
          databaseUrl: `postgresql://${local.target.databaseUser}:load-test-local-only@127.0.0.1:${local.target.databasePort}/${local.target.databaseName}`,
          databaseObserverUrl: undefined,
          valkeyUrl: `redis://127.0.0.1:${local.target.valkeyPort}/0`,
          valkeyObserverUrl: undefined,
        }),
        { mode: 0o600 },
      );
      expect(() =>
        readInputs(manifest, credentials, {
          LOAD_TEST_MODE: 'render-reuse',
          RENDER_SERVICE_ID: local.target.apiResourceId,
          RENDER_GIT_COMMIT: local.expectedGitSha,
        }),
      ).toThrow('not a git repository');
      // A present checkout is never replaced by the ambient SHA.
      write(m);
      git.mockImplementation(((_file: string, args: string[]) =>
        args[0] === 'rev-parse' ? 'b'.repeat(40) : '') as any);
      expect(() => readInputs(manifest, credentials, runtime(m, c))).toThrow(
        'Git SHA / dirty tree',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normal build/start protection', () => {
  const dev = 'postgresql://trading_app_fbbk_user:secret@host/trading_app_fbbk';
  it('preserves normal runtime and ordinary migrations', () => {
    expect(() => assertNormalEnvironment({ DATABASE_URL: dev })).not.toThrow();
    expect(() =>
      assertNormalEnvironment({ DATABASE_URL: dev }, ['migrate', 'deploy']),
    ).not.toThrow();
  });
  it('protects dotenv-resolved targets and preserves explicit environment precedence', () => {
    const fromFile = mergeRuntimeEnv({}, [
      { DATABASE_URL: fixture().c.databaseUrl },
    ]);
    expect(() => assertNormalEnvironment(fromFile)).toThrow(
      'normal entry refused',
    );
    const overridden = mergeRuntimeEnv({ DATABASE_URL: dev }, [
      { DATABASE_URL: fixture().c.databaseUrl },
    ]);
    expect(() => assertNormalEnvironment(overridden)).not.toThrow();
  });
  it.each([
    { LOAD_TEST_MODE: 'render-reuse', DATABASE_URL: dev },
    { DATABASE_URL: fixture().c.databaseUrl },
    {
      DATABASE_URL: dev.replace(
        'trading_app_fbbk_user',
        'load_test_trading_class',
      ),
    },
    {
      DATABASE_URL: dev.replace(
        '@host/trading_app_fbbk',
        '@host/other_load_test',
      ),
    },
    {
      DATABASE_URL: dev.replace(
        '@host/trading_app_fbbk',
        '@host/trading_class_%6coadtest',
      ),
    },
  ])('refuses ordinary start/migration on a test transition', (env) => {
    expect(() => assertNormalEnvironment(env)).toThrow('normal entry refused');
    expect(() => assertNormalEnvironment(env, ['migrate', 'deploy'])).toThrow(
      'normal entry refused',
    );
    expect(() => assertNormalEnvironment(env, ['db', 'push'])).toThrow(
      'normal entry refused',
    );
    expect(() => assertNormalEnvironment(env, ['generate'])).not.toThrow();
  });
});

describe('database privilege and migration preflight (all transports mocked)', () => {
  let m: Manifest, c: Credentials;
  let role: Record<string, boolean>;
  let name: string,
    user: string,
    marker: string | null,
    userCount: number,
    timezone: string;
  let previous: string | null, redisSize: number;
  let usersExists: boolean;
  let sql: string[];
  beforeEach(() => {
    ({ m, c } = fixture());
    name = m.target.databaseName;
    user = m.target.databaseUser;
    marker = null;
    userCount = 0;
    timezone = 'UTC';
    previous = null;
    redisSize = 0;
    usersExists = true;
    sql = [];
    role = {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      memberships: false,
      owns_database: true,
      schema_usage: true,
      schema_create: true,
      preserved_exists: true,
      preserved_access: false,
      foreign_create: false,
    };
    jest
      .spyOn(Client.prototype, 'connect')
      .mockImplementation((async () => undefined) as any);
    jest
      .spyOn(Client.prototype, 'end')
      .mockImplementation((async () => undefined) as any);
    jest.spyOn(Client.prototype, 'query').mockImplementation((async (
      statement: string,
    ) => {
      sql.push(statement);
      if (statement.includes('current_database() AS name'))
        return {
          rows: [{ name, role: user, marker, version: 'PostgreSQL 17' }],
        };
      if (statement === 'SHOW TimeZone')
        return { rows: [{ TimeZone: timezone }] };
      if (statement.includes('r.rolsuper')) return { rows: [role] };
      if (statement.includes('to_regclass'))
        return { rows: [{ present: usersExists }] };
      if (statement.includes('count(*) AS n'))
        return { rows: [{ n: userCount }] };
      if (statement.startsWith('COMMENT')) return { rows: [] };
      throw new Error('UNEXPECTED_TEST_QUERY');
    }) as any);
    jest.spyOn(IORedis.prototype, 'connect').mockResolvedValue(undefined);
    jest
      .spyOn(IORedis.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    jest
      .spyOn(IORedis.prototype, 'info')
      .mockResolvedValue(
        'run_id:fixture\r\nredis_version:8.1.4\r\nmaxmemory:268435456\r\nmaxmemory_policy:noeviction',
      );
    jest
      .spyOn(IORedis.prototype, 'get')
      .mockImplementation(async () => previous);
    jest
      .spyOn(IORedis.prototype, 'dbsize')
      .mockImplementation(async () => redisSize);
    jest.spyOn(IORedis.prototype, 'set').mockResolvedValue('OK');
    // No child process or network is ever launched by this suite.
    jest.spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.alloc(0));
  });
  const writes = () => sql.filter((s) => s.startsWith('COMMENT')).length;
  const denied = async () => {
    await expect(preflight(m, c, true)).rejects.toThrow();
    expect(writes()).toBe(0);
    expect(jest.mocked(IORedis.prototype.set).mock.calls.length).toBe(0);
    expect(jest.mocked(execFileSync).mock.calls.length).toBe(0);
  };
  it.each([
    'rolsuper',
    'rolcreatedb',
    'rolcreaterole',
    'rolreplication',
    'rolbypassrls',
    'memberships',
    'preserved_access',
    'foreign_create',
  ])(
    'rejects actual server privilege %s before claims or Prisma',
    async (key) => {
      role[key] = true;
      await denied();
      await expect(
        migrate(m, observerCredentials(c), 'hash', '/manifest', '/credentials'),
      ).rejects.toThrow('ROLE_NOT_ISOLATED');
      expect(jest.mocked(execFileSync).mock.calls.length).toBe(0);
    },
  );
  it.each([
    'rolcanlogin',
    'owns_database',
    'schema_usage',
    'schema_create',
    'preserved_exists',
  ])('requires actual server condition %s', async (key) => {
    role[key] = false;
    await denied();
  });
  it('refuses DB identity/timezone/claim mismatches', async () => {
    name = 'trading_app_fbbk';
    await denied();
    name = m.target.databaseName;
    user = 'trading_app_fbbk_user';
    await denied();
    user = m.target.databaseUser;
    timezone = 'Asia/Seoul';
    await denied();
    timezone = 'UTC';
    marker = 'existing-database';
    await denied();
    marker = null;
    userCount = 1;
    await denied();
  });
  it('checks both resources before writing claims and never overwrites Valkey data', async () => {
    redisSize = 1;
    await denied();
    redisSize = 0;
    previous = 'other-instance';
    await denied();
    previous = null;
    await preflight(m, c, true);
    expect(writes()).toBe(1);
    expect(jest.mocked(IORedis.prototype.set).mock.calls.length).toBe(1);
  });
  it('requires migration before serving/claiming but permits a fresh empty migration target', async () => {
    usersExists = false;
    await expect(preflight(m, c, true)).rejects.toThrow('SCHEMA_NOT_MIGRATED');
    expect(writes()).toBe(0);
    expect(jest.mocked(IORedis.prototype.set).mock.calls.length).toBe(0);
    await migrate(
      m,
      observerCredentials(c),
      'hash',
      '/manifest',
      '/credentials',
    );
    expect(jest.mocked(execFileSync).mock.calls.length).toBe(3);
    expect(writes()).toBe(0);
  });
  it('runs deploy/status/diff in order after read-only preflight with matching observer config proof', async () => {
    const observer = observerCredentials(c),
      manifestHash = hash(m);
    await migrate(m, observer, manifestHash, '/manifest', '/credentials');
    expect(writes()).toBe(0);
    expect(jest.mocked(IORedis.prototype.set).mock.calls.length).toBe(0);
    const calls = jest.mocked(execFileSync).mock.calls;
    expect(calls.length).toBe(3);
    expect(
      calls
        .map((call) => (call[1] as string[]).slice(0, 2).join(' '))
        .join(','),
    ).toBe('migrate deploy,migrate status,migrate diff');
    const diff = calls[2][1] as string[];
    expect(diff.includes('--exit-code')).toBe(true);
    expect(diff.includes('--from-config-datasource')).toBe(true);
    expect(
      diff.includes(join(ROOT, 'scripts/load-test/prisma.config.ts')),
    ).toBe(true);
    const env = (calls[0][2] as any).env;
    expect(env.DATABASE_URL === undefined).toBe(true);
    expect(() =>
      validateMigrationProof(
        m,
        observer,
        manifestHash,
        env.LOAD_TEST_MIGRATION_PREFLIGHT,
      ),
    ).not.toThrow();
    expect(() =>
      validateMigrationProof(m, observer, manifestHash, undefined),
    ).toThrow('REQUIRES_CLI_PREFLIGHT');
    expect(() =>
      validateMigrationProof(
        m,
        observer,
        'changed-manifest',
        env.LOAD_TEST_MIGRATION_PREFLIGHT,
      ),
    ).toThrow('REQUIRES_CLI_PREFLIGHT');
    expect(() =>
      validateMigrationProof(
        m,
        c,
        manifestHash,
        env.LOAD_TEST_MIGRATION_PREFLIGHT,
      ),
    ).toThrow('credential target mismatch');
  });
  it('stops on migration failure and refuses migrated nonempty user data', async () => {
    const child = jest.mocked(execFileSync);
    child.mockImplementation(() => {
      throw new Error('PRISMA_DRIFT');
    });
    await expect(
      migrate(m, observerCredentials(c), 'hash', '/manifest', '/credentials'),
    ).rejects.toThrow('PRISMA_DRIFT');
    expect(child.mock.calls.length).toBe(1);
    child.mockClear();
    userCount = 1;
    await expect(
      migrate(m, observerCredentials(c), 'hash', '/manifest', '/credentials'),
    ).rejects.toThrow('EMPTY_USERS');
    expect(child.mock.calls.length).toBe(0);
  });
  it('refuses a second concurrent test server before booting or swapping the environment', async () => {
    const env = process.env,
      cwd = process.cwd();
    const out = mkdtempSync(join(tmpdir(), 'render-reuse-lease-'));
    const boot = jest.spyOn(Test, 'createTestingModule');
    const set = jest
      .mocked(IORedis.prototype.set)
      .mockImplementation((async (key: string) =>
        key === SERVER_LEASE_KEY ? null : 'OK') as any);
    const evaluate = jest.spyOn(IORedis.prototype, 'eval');
    try {
      process.env = { ...runtime(m, c) };
      await expect(serve(m, c, 'hash', out)).rejects.toThrow(
        'LOAD_TEST_SERVER_ALREADY_ACTIVE',
      );
      const leaseCall = set.mock.calls.find(
        (call) => call[0] === SERVER_LEASE_KEY,
      );
      expect(leaseCall?.slice(2).join(' ')).toBe('PX 30000 NX');
      expect(boot.mock.calls.length).toBe(0);
      expect(evaluate.mock.calls.length).toBe(0);
      expect(process.env.LOAD_TEST_MODE).toBe('render-reuse');
      expect(process.cwd()).toBe(cwd);
    } finally {
      process.env = env;
      rmSync(out, { recursive: true, force: true });
    }
  });
  it('renews only its own lease, stops on loss and releases by owner', async () => {
    jest.useFakeTimers();
    const evaluate = jest
      .spyOn(IORedis.prototype, 'eval')
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    try {
      const lease = await acquireServerLease(c, new Metrics());
      const owner = jest
        .mocked(IORedis.prototype.set)
        .mock.calls.find((call) => call[0] === SERVER_LEASE_KEY)?.[1];
      await jest.advanceTimersByTimeAsync(10_000);
      expect(lease.lost()).toBe(false);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(lease.lost()).toBe(true);
      await lease.release();
      const calls = evaluate.mock.calls;
      expect(calls.length).toBe(3);
      expect(
        calls.every(
          (call) =>
            call[1] === 1 && call[2] === SERVER_LEASE_KEY && call[3] === owner,
        ),
      ).toBe(true);
      expect(String(calls[0][0]).includes('pexpire')).toBe(true);
      expect(String(calls[2][0]).includes("redis.call('del'")).toBe(true);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(evaluate.mock.calls.length).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
  it('accepts already claimed identities without mutating them', async () => {
    marker = `load-test-only:${hash({ resourceId: m.target.databaseResourceId, db: name, role: user })}`;
    previous = hash({
      resourceId: m.target.valkeyResourceId,
      host: m.target.valkeyHost,
      port: m.target.valkeyPort,
    });
    userCount = 10;
    redisSize = 5;
    const result = await preflight(m, observerCredentials(c));
    expect(result.databaseVersion).toBe('PostgreSQL 17');
    expect(writes()).toBe(0);
    expect(jest.mocked(IORedis.prototype.set).mock.calls.length).toBe(0);
  });
});
