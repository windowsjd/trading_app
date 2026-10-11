import { spawnSync } from 'node:child_process';

const itDb = process.env.BEGINNER_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('Beginner full quest database safety', () => {
  it.each([
    {
      name: 'missing explicit opt-in',
      env: { BEGINNER_ACCOUNT_DB_INTEGRATION: '' },
    },
    {
      name: 'production mode even in GitHub Actions',
      env: { NODE_ENV: 'production', GITHUB_ACTIONS: 'true' },
      error: 'Explicit test DB opt-in is required.',
    },
    {
      name: 'remote test database',
      env: {
        DATABASE_URL: 'postgresql://test@db.example.com/quest_safety_test',
      },
    },
    {
      name: 'remote GitHub Actions database',
      env: {
        DATABASE_URL: 'postgresql://test@db.example.com/trading_app',
        GITHUB_ACTIONS: 'true',
      },
    },
    {
      name: 'unapproved local database name even in GitHub Actions',
      env: {
        DATABASE_URL: 'postgresql://test@127.0.0.1:1/trading_app_prod',
        GITHUB_ACTIONS: 'true',
      },
    },
    {
      name: 'trading_app outside GitHub Actions',
      env: { DATABASE_URL: 'postgresql://test@localhost:1/trading_app' },
    },
    {
      name: 'trading_app without the exact GitHub Actions marker',
      env: {
        DATABASE_URL: 'postgresql://test@localhost:1/trading_app',
        GITHUB_ACTIONS: '1',
      },
    },
  ])('rejects $name before running fixtures', ({ env, error }) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/beginner-full-quest-integration.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          BEGINNER_ACCOUNT_DB_INTEGRATION: '1',
          FUTURES_DB_INTEGRATION: '1',
          GITHUB_ACTIONS: 'false',
          DATABASE_URL: 'postgresql://test@127.0.0.1:1/quest_safety_test',
          ...env,
        },
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    expect(result.error === undefined).toBe(true);
    expect(result.status).toBe(1);
    expect(
      result.stderr.includes(
        error ?? 'Disposable local test database opt-in required',
      ),
    ).toBe(true);
    expect(
      result.stdout.includes('beginner full quest DB integration passed'),
    ).toBe(false);
  });
});

describe('Beginner PostgreSQL progress', () => {
  itDb(
    'derives progress only from committed standalone FX and transfer rows',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/beginner-quest-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `Beginner quest DB integration failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(
        result.stdout.includes('beginner quest DB integration passed'),
      ).toBe(true);
    },
    130_000,
  );
  itDb(
    'executes all ten quests and enforces staged access in PostgreSQL',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/beginner-full-quest-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Full quest integration failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      expect(
        result.stdout.includes('beginner full quest DB integration passed'),
      ).toBe(true);
    },
    130_000,
  );
});
