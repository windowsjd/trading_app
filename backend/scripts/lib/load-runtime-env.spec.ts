import {
  RUNTIME_ENV_FILENAMES,
  describeDatabaseTarget,
  formatDatabaseTarget,
  mergeRuntimeEnv,
} from './load-runtime-env';

describe('mergeRuntimeEnv precedence (must match NestJS ConfigModule)', () => {
  // Files are passed in DESCENDING precedence order: .env.local, .env.development, .env
  const asOrderedFiles = (files: {
    local?: Record<string, string>;
    development?: Record<string, string>;
    env?: Record<string, string>;
  }) => [files.local ?? {}, files.development ?? {}, files.env ?? {}];

  it('resolves DATABASE_URL from .env.local over .env.development and .env', () => {
    const merged = mergeRuntimeEnv(
      {},
      asOrderedFiles({
        local: { DATABASE_URL: 'postgresql://u:p@localhost:5432/local_db' },
        development: { DATABASE_URL: 'postgresql://u:p@localhost:5432/dev_db' },
        env: { DATABASE_URL: 'postgresql://u:p@localhost:5432/env_db' },
      }),
    );

    // Guards the historical "seed wrote to the wrong DB" bug: a script that read
    // only .env would target env_db while the backend targets local_db.
    expect(merged.DATABASE_URL).toBe(
      'postgresql://u:p@localhost:5432/local_db',
    );
  });

  it('falls back to .env.development when .env.local omits the key', () => {
    const merged = mergeRuntimeEnv(
      {},
      asOrderedFiles({
        local: { OTHER: 'x' },
        development: { DATABASE_URL: 'postgresql://u:p@localhost:5432/dev_db' },
        env: { DATABASE_URL: 'postgresql://u:p@localhost:5432/env_db' },
      }),
    );

    expect(merged.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/dev_db');
  });

  it('falls back to .env only when no higher-precedence file defines the key', () => {
    const merged = mergeRuntimeEnv(
      {},
      asOrderedFiles({
        env: { DATABASE_URL: 'postgresql://u:p@localhost:5432/env_db' },
      }),
    );

    expect(merged.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/env_db');
  });

  it('lets real process.env win over every file (never overridden)', () => {
    const merged = mergeRuntimeEnv(
      { DATABASE_URL: 'postgresql://u:p@localhost:5432/shell_db' },
      asOrderedFiles({
        local: { DATABASE_URL: 'postgresql://u:p@localhost:5432/local_db' },
        env: { DATABASE_URL: 'postgresql://u:p@localhost:5432/env_db' },
      }),
    );

    expect(merged.DATABASE_URL).toBe(
      'postgresql://u:p@localhost:5432/shell_db',
    );
  });

  it('ignores undefined base values so files can still supply the key', () => {
    const merged = mergeRuntimeEnv(
      { DATABASE_URL: undefined },
      asOrderedFiles({
        local: { DATABASE_URL: 'postgresql://u:p@localhost:5432/local_db' },
      }),
    );

    expect(merged.DATABASE_URL).toBe(
      'postgresql://u:p@localhost:5432/local_db',
    );
  });

  it('keeps the documented filename precedence order', () => {
    expect(RUNTIME_ENV_FILENAMES).toEqual([
      '.env.local',
      '.env.development',
      '.env',
    ]);
  });
});

describe('describeDatabaseTarget / formatDatabaseTarget (no secret leakage)', () => {
  it('extracts a password-free identity', () => {
    const target = describeDatabaseTarget(
      'postgresql://trading_app:sup3r-secret@db.internal:5432/trading_app?schema=public',
    );

    expect(target).toEqual({
      user: 'trading_app',
      host: 'db.internal',
      port: '5432',
      database: 'trading_app',
    });
  });

  it('never includes the password in the formatted string', () => {
    const formatted = formatDatabaseTarget(
      'postgresql://trading_app:sup3r-secret@db.internal:5432/trading_app',
    );

    expect(formatted).toBe('trading_app@db.internal:5432/trading_app');
    expect(formatted).not.toContain('sup3r-secret');
  });

  it('returns null / safe text for missing or unparseable URLs without echoing them', () => {
    expect(describeDatabaseTarget(undefined)).toBeNull();
    expect(describeDatabaseTarget('   ')).toBeNull();
    const formatted = formatDatabaseTarget('not a url with :secret@ in it');
    expect(formatted).toContain('withheld');
    expect(formatted).not.toContain('secret');
  });
});
