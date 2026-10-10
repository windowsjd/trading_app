import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type Screen =
  | 'market'
  | 'detail'
  | 'spot'
  | 'futures'
  | 'home'
  | 'historyFx';
export type Manifest = {
  version: 1;
  runId: string;
  expectedGitSha: string;
  allowDirtyLocalSmoke: boolean;
  cloudExecutionApproved: boolean;
  profile: 'smoke' | 'baseline' | 'diagnostic';
  target: {
    apiOrigin: string;
    databaseHost: string;
    databasePort: number;
    databaseName: string;
    databaseUser: string;
    valkeyHost: string;
    valkeyPort: number;
    databaseObserverHost?: string;
    databaseObserverPort?: number;
    valkeyObserverHost?: string;
    valkeyObserverPort?: number;
    apiResourceId: string;
    databaseResourceId: string;
    valkeyResourceId: string;
  };
  users: number;
  rampSeconds: number;
  holdSeconds: number;
  drainSeconds: number;
  seed: number;
  accessTokenTtl: string;
  screenWeights: Record<Screen, number>;
  accountWeights: { general: number; season: number; beginner: number };
  dwellSeconds: Record<Screen, [number, number]>;
  spot: {
    marketRatio: number;
    buyRatio: number;
    thinkSeconds: [number, number];
  };
  futures: {
    marketRatio: number;
    traderRatio: number;
    crossRatio: number;
    thinkSeconds: [number, number];
  };
  cancelRatio: number;
  protectionRatio: number;
  fixture: {
    historyRounds: number;
    spotHoldings: number;
    futuresPositions: number;
    pendingRatio: number;
    candleDays: number;
  };
  replay: {
    tickMs: number;
    tickerEveryTicks: number;
    bookEveryTicks: number;
    candleEveryTicks: number;
    lastEveryTicks: number;
    markEveryTicks: number;
    fxIntervalSeconds: number;
  };
  assumptions: string[];
  generator: {
    shardIndex: number;
    shardCount: number;
    cpuCores: number;
    memoryBytes: number;
    maxLagP99Ms: number;
    maxScheduledDelayP99Ms: number;
  };
  maxReceivedBytes: number;
};
export type Credentials = {
  databaseUrl: string;
  valkeyUrl: string;
  jwtSecret: string;
  userPassword: string;
  controlSecret: string;
  renderApiKey?: string;
  databaseObserverUrl?: string;
  valkeyObserverUrl?: string;
};

export const ROOT = existsSync(resolve(__dirname, '../../package.json'))
  ? resolve(__dirname, '../..')
  : resolve(__dirname, '../../..');
export const SCREENS: Screen[] = [
  'market',
  'detail',
  'spot',
  'futures',
  'home',
  'historyFx',
];
export const PRODUCTION_IDS = [
  'srv-da84cg8u01pc73cjasa0',
  'dpg-da7ac0e1egvs73e2sv20-a',
  'red-da7alead0e5s73dusbs0',
  'dpg-dattqaou01pc73agrsr0-a',
];
export const PRODUCTION_HOSTS = [
  'trading-app-qtsw.onrender.com',
  ...PRODUCTION_IDS,
];
const loopback = (host: string) =>
  ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
export const isLocal = (m: Manifest) =>
  [
    new URL(m.target.apiOrigin).hostname,
    m.target.databaseHost,
    m.target.valkeyHost,
  ].every(loopback);
const fail = (reason: string): never => {
  throw new Error(`LOAD_TEST_GUARD:${reason}`);
};

export function hash(value: unknown): string {
  // JSONB reorders object keys. Idempotent financial responses are compared
  // by canonical contents, preserving array order and every scalar value.
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(
      typeof value === 'string' ? value : JSON.stringify(canonical(value)),
    )
    .digest('hex');
}
export function workloadHash(m: Manifest) {
  const {
    target,
    runId,
    cloudExecutionApproved,
    allowDirtyLocalSmoke,
    maxReceivedBytes,
    generator,
    ...workload
  } = m;
  return hash(workload);
}
export function gitIdentity() {
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  return {
    sha: run('rev-parse', 'HEAD'),
    dirty: run('status', '--porcelain').length > 0,
    lockHash: hash(readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8')),
    schemaHash: hash(
      readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8'),
    ),
  };
}
export function validateManifest(m: Manifest): void {
  if (m.generator.shardCount !== 1 || m.generator.shardIndex !== 0)
    fail(
      'single generator only; distributed phase coordination is not implemented',
    );
  if (
    m.version !== 1 ||
    !/^[a-z0-9-]{4,64}$/.test(m.runId) ||
    !/^[a-f0-9]{40}$/.test(m.expectedGitSha)
  )
    fail('manifest identity');
  const u = new URL(m.target.apiOrigin);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    !['http:', 'https:'].includes(u.protocol)
  )
    fail('API origin');
  for (const v of Object.values(m.target)) {
    if (
      typeof v === 'string' &&
      PRODUCTION_HOSTS.some((p) => v.toLowerCase().includes(p))
    )
      fail('production target');
  }
  if (
    !/^[a-z0-9_]+_load_test$/.test(m.target.databaseName) ||
    !/^load_test_[a-z0-9_]+$/.test(m.target.databaseUser)
  )
    fail('dedicated database and role required');
  if (
    !isLocal(m) &&
    (!m.cloudExecutionApproved ||
      u.protocol !== 'https:' ||
      m.allowDirtyLocalSmoke)
  )
    fail('cloud approval / TLS / clean tree required');
  if (
    ![
      m.target.apiResourceId,
      m.target.databaseResourceId,
      m.target.valkeyResourceId,
    ].every((v) => typeof v === 'string' && v.length >= 4)
  )
    fail('approved physical resource identities required');
  for (const [v, min, max] of [
    [m.users, 10, 1000],
    [m.rampSeconds, 1, 600],
    [m.holdSeconds, 30, 3600],
    [m.drainSeconds, 1, 600],
    [m.generator.shardCount, 1, 8],
    [m.fixture.historyRounds, 1, 20],
    [m.fixture.candleDays, 1, 35],
    [m.replay.tickMs, 100, 1000],
  ] as number[][]) {
    if (!Number.isSafeInteger(v) || v < min || v > max) fail('manifest bounds');
  }
  if (!['smoke', 'baseline', 'diagnostic'].includes(m.profile)) fail('profile');
  if (m.profile === 'smoke' && m.users > 20) fail('smoke maximum 20');
  if (
    m.profile === 'baseline' &&
    (m.users !== 1000 ||
      m.rampSeconds !== 300 ||
      m.holdSeconds !== 3600 ||
      m.drainSeconds !== 300 ||
      m.accessTokenTtl !== '15m')
  )
    fail('baseline must be 1000 / 300 / 3600 / 300 / 15m');
  if (
    !Number.isInteger(m.generator.shardIndex) ||
    m.generator.shardIndex < 0 ||
    m.generator.shardIndex >= m.generator.shardCount
  )
    fail('shard');
  const ratios = [
    ...Object.values(m.screenWeights),
    ...Object.values(m.accountWeights),
    m.spot.marketRatio,
    m.spot.buyRatio,
    m.futures.marketRatio,
    m.futures.traderRatio,
    m.futures.crossRatio,
    m.cancelRatio,
    m.protectionRatio,
    m.fixture.pendingRatio,
  ];
  if (ratios.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) fail('ratio');
  if (
    Math.abs(SCREENS.reduce((a, s) => a + m.screenWeights[s], 0) - 1) > 1e-9 ||
    Math.abs(Object.values(m.accountWeights).reduce((a, v) => a + v, 0) - 1) >
      1e-9
  )
    fail('weights');
  for (const range of [
    ...Object.values(m.dwellSeconds),
    m.spot.thinkSeconds,
    m.futures.thinkSeconds,
  ]) {
    if (
      range.length !== 2 ||
      range.some((v) => !Number.isFinite(v) || v < 1 || v > 600) ||
      range[0] > range[1]
    )
      fail('dwell / think time');
  }
  if (
    !/^\d+[smh]$/.test(m.accessTokenTtl) ||
    !Number.isSafeInteger(m.seed) ||
    m.seed < 1
  )
    fail('TTL / seed');
  if (
    m.fixture.spotHoldings < 1 ||
    m.fixture.spotHoldings > 5 ||
    m.fixture.futuresPositions < 1 ||
    m.fixture.futuresPositions > 3
  )
    fail('fixture holdings');
  if (
    Object.entries(m.replay).some(
      ([k, v]) => k !== 'tickMs' && (!Number.isInteger(v) || v < 1 || v > 100),
    )
  )
    fail('replay cadence');
  if (!(m.replay.fxIntervalSeconds >= 10 && m.replay.fxIntervalSeconds <= 30))
    fail(
      'replay FX cadence must preserve the existing 60-second execution freshness policy',
    );
  if (
    !(m.maxReceivedBytes > 0 && m.maxReceivedBytes <= 100_000_000_000) ||
    !m.assumptions.length ||
    !(m.generator.cpuCores > 0) ||
    !(m.generator.memoryBytes > 0)
  )
    fail('budget / assumptions / generator');
}
export function validateCredentials(m: Manifest, c: Credentials): void {
  validateManifest(m);
  for (const [raw, host, port, protocol] of [
    [
      c.databaseUrl,
      m.target.databaseHost,
      m.target.databasePort,
      'postgresql:',
    ],
    [c.valkeyUrl, m.target.valkeyHost, m.target.valkeyPort, 'redis:'],
  ] as const) {
    const u = new URL(raw);
    if (PRODUCTION_HOSTS.some((p) => raw.toLowerCase().includes(p)))
      fail('production credential target');
    if (
      u.hostname !== host ||
      Number(u.port || (protocol === 'redis:' ? 6379 : 5432)) !== port ||
      ![protocol, protocol === 'redis:' ? 'rediss:' : 'postgres:'].includes(
        u.protocol,
      )
    )
      fail('credential target mismatch');
    if (
      protocol === 'postgresql:' &&
      (decodeURIComponent(u.pathname.slice(1)) !== m.target.databaseName ||
        decodeURIComponent(u.username) !== m.target.databaseUser ||
        u.searchParams.has('host') ||
        u.searchParams.has('options') ||
        (u.searchParams.get('schema') ?? 'public') !== 'public')
    )
      fail('database credential scope');
    if (
      protocol === 'postgresql:' &&
      [...u.searchParams.keys()].some((k) => !['schema', 'sslmode'].includes(k))
    )
      fail('database query parameter override');
    if (protocol === 'redis:' && !['', '/', '/0'].includes(u.pathname))
      fail('Valkey must be a separate physical instance, DB 0');
    if (protocol === 'redis:' && u.search)
      fail('Valkey query parameter override');
  }
  if (
    ![c.jwtSecret, c.userPassword, c.controlSecret].every(
      (v) =>
        typeof v === 'string' && v.startsWith('load-test-') && v.length >= 24,
    )
  )
    fail('test-only secrets required');
}
export function readInputs(manifestFile: string, credentialFile: string) {
  if (statSync(credentialFile).mode & 0o077)
    fail('credential file must have mode 0600');
  const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
  const c = JSON.parse(readFileSync(credentialFile, 'utf8')) as Credentials;
  validateCredentials(m, c);
  if (c.databaseObserverUrl || c.valkeyObserverUrl)
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
      {
        ...c,
        databaseUrl: c.databaseObserverUrl ?? c.databaseUrl,
        valkeyUrl: c.valkeyObserverUrl ?? c.valkeyUrl,
      },
    );
  const git = gitIdentity();
  if (
    git.sha !== m.expectedGitSha ||
    (git.dirty &&
      !(isLocal(m) && m.profile === 'smoke' && m.allowDirtyLocalSmoke))
  )
    fail('Git SHA / dirty tree');
  return {
    m,
    c,
    git,
    manifestHash: hash({ ...m, generator: { ...m.generator, shardIndex: 0 } }),
  };
}
export function defaultManifest(sha: string, smoke = false): Manifest {
  return {
    version: 1,
    runId: 'trading-class-baseline',
    expectedGitSha: sha,
    allowDirtyLocalSmoke: smoke,
    cloudExecutionApproved: false,
    profile: smoke ? 'smoke' : 'baseline',
    target: {
      apiOrigin: 'http://127.0.0.1:3301',
      databaseHost: '127.0.0.1',
      databasePort: 55431,
      databaseName: 'trading_load_test',
      databaseUser: 'load_test_runner',
      valkeyHost: '127.0.0.1',
      valkeyPort: 56381,
      apiResourceId: 'local-load-api',
      databaseResourceId: 'local-load-pg',
      valkeyResourceId: 'local-load-valkey',
    },
    users: smoke ? 10 : 1000,
    rampSeconds: smoke ? 5 : 300,
    holdSeconds: smoke ? 90 : 3600,
    drainSeconds: smoke ? 10 : 300,
    seed: 20261011,
    accessTokenTtl: smoke ? '30s' : '15m',
    screenWeights: {
      market: 0.3,
      detail: 0.25,
      spot: 0.1,
      futures: 0.15,
      home: 0.15,
      historyFx: 0.05,
    },
    accountWeights: { general: 0.6, season: 0.25, beginner: 0.15 },
    dwellSeconds: {
      market: [30, 90],
      detail: [30, 60],
      spot: [60, 180],
      futures: [60, 180],
      home: [30, 90],
      historyFx: [30, 90],
    },
    spot: { marketRatio: 0.7, buyRatio: 0.6, thinkSeconds: [60, 180] },
    futures: {
      marketRatio: 0.7,
      traderRatio: 0.3,
      crossRatio: 0.3,
      thinkSeconds: [120, 240],
    },
    cancelRatio: 0.2,
    protectionRatio: 0.1,
    fixture: {
      historyRounds: smoke ? 1 : 12,
      spotHoldings: 3,
      futuresPositions: 2,
      pendingRatio: 0.2,
      candleDays: smoke ? 2 : 7,
    },
    replay: {
      tickMs: 200,
      tickerEveryTicks: 5,
      bookEveryTicks: 3,
      candleEveryTicks: 5,
      lastEveryTicks: 1,
      markEveryTicks: 5,
      fxIntervalSeconds: 30,
    },
    assumptions: [
      'Initial workload assumptions, not production analytics',
      'First WS subscription dispatched 100ms after transport open to model UI/WAN delay; current gateway asynchronous authentication can miss immediate local frames',
      'One shared authenticated WS/user; at least one valid ticker subscription retained explicitly for 1000-WS stress',
      'Mounted market subscriptions retained until Futures market selection; focus-gated detail subscriptions removed on navigation',
      'Single baseline run; intermediate sizes and repetitions are optional diagnostics',
      'Synthetic wire-format provider observations; no external provider traffic',
      'Synthetic FX ingestion runs through the existing Ops job every 30 seconds; the production hourly schedule cannot maintain the existing 60-second execution freshness requirement',
    ],
    generator: {
      shardIndex: 0,
      shardCount: 1,
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      maxLagP99Ms: 50,
      maxScheduledDelayP99Ms: 500,
    },
    maxReceivedBytes: 90_000_000_000,
  };
}

/** Generator uses approved external observer URLs; API retains private URLs. */
export function observerCredentials(c: Credentials): Credentials {
  return {
    ...c,
    databaseUrl: c.databaseObserverUrl ?? c.databaseUrl,
    valkeyUrl: c.valkeyObserverUrl ?? c.valkeyUrl,
  };
}
