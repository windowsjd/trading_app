import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

/**
 * Shared runtime environment loader for DB-touching dev/recovery scripts.
 *
 * Why this exists: the NestJS backend boots with
 * `ConfigModule.forRoot({ envFilePath: ['.env.local', '.env.development', '.env'] })`
 * (see `src/app.module.ts`). @nestjs/config resolves a variable with the
 * precedence
 *
 *   process.env  >  .env.local  >  .env.development  >  .env
 *
 * and never overrides a value that is already set (earlier file wins, real
 * process env wins over every file). Scripts that instead used
 * `import 'dotenv/config'` only read `.env`, so if any higher-precedence file
 * ever defined a different `DATABASE_URL` the script would silently write to a
 * DIFFERENT database than the running backend. This module reproduces the
 * backend precedence exactly so every recovery/seed script targets the same DB.
 *
 * The precedence math is factored into the pure {@link mergeRuntimeEnv} so it
 * can be unit-tested without mutating the real `process.env`.
 */

export type EnvMap = Record<string, string | undefined>;

/**
 * Env filenames in DESCENDING precedence order — index 0 wins over index 1,
 * etc. Mirrors `envFilePath` in `src/app.module.ts`; keep the two in sync.
 */
export const RUNTIME_ENV_FILENAMES = [
  '.env.local',
  '.env.development',
  '.env',
] as const;

/**
 * Merge a base env (real `process.env`) with parsed env files, replicating the
 * @nestjs/config resolution: base wins over all files, and among files the one
 * earlier in `parsedFilesInPrecedenceOrder` wins. "First writer wins" (never
 * override) is applied so the result is deterministic and matches the backend.
 */
export function mergeRuntimeEnv(
  base: EnvMap,
  parsedFilesInPrecedenceOrder: ReadonlyArray<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  // Real process env has highest precedence over every file value.
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Files earlier in the array win; first writer for a key wins (no override).
  for (const parsed of parsedFilesInPrecedenceOrder) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

export type RuntimeEnvFileInfo = {
  filename: string;
  path: string;
  present: boolean;
};

export type RuntimeEnvLoadResult = {
  cwd: string;
  files: RuntimeEnvFileInfo[];
  appliedKeys: string[];
};

/**
 * Load `.env.local`, `.env.development`, `.env` (in that precedence) into
 * `process.env`, exactly like the NestJS backend, without overriding any value
 * already present in `process.env`. Missing files are skipped silently.
 */
export function loadRuntimeEnv(
  options: { cwd?: string } = {},
): RuntimeEnvLoadResult {
  const cwd = options.cwd ?? process.cwd();
  const parsed: Array<{
    info: RuntimeEnvFileInfo;
    values: Record<string, string>;
  }> = RUNTIME_ENV_FILENAMES.map((filename) => {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) {
      return { info: { filename, path, present: false }, values: {} };
    }

    return {
      info: { filename, path, present: true },
      values: parseDotenv(readFileSync(path)),
    };
  });

  const merged = mergeRuntimeEnv(
    process.env,
    parsed.map((entry) => entry.values),
  );

  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env)) {
      process.env[key] = value;
      appliedKeys.push(key);
    }
  }

  return {
    cwd,
    files: parsed.map((entry) => entry.info),
    appliedKeys,
  };
}

export type DatabaseTarget = {
  user: string;
  host: string;
  port: string;
  database: string;
};

/**
 * Parse a connection string into a SAFE identity for logging. The password is
 * never read or returned, and an unparseable string returns `null` rather than
 * echoing raw (possibly secret-bearing) text.
 */
export function describeDatabaseTarget(
  databaseUrl: string | undefined,
): DatabaseTarget | null {
  if (!databaseUrl || databaseUrl.trim() === '') {
    return null;
  }

  try {
    const url = new URL(databaseUrl);
    return {
      user: url.username ? decodeURIComponent(url.username) : '(none)',
      host: url.hostname || '(unknown)',
      port: url.port || '(default)',
      database: url.pathname.replace(/^\//u, '') || '(unknown)',
    };
  } catch {
    return null;
  }
}

/**
 * A one-line, password-free description of the DB a script is about to touch.
 * Safe to print; never includes the password or the full URL.
 */
export function formatDatabaseTarget(databaseUrl: string | undefined): string {
  const target = describeDatabaseTarget(databaseUrl);
  if (!target) {
    return 'DATABASE_URL missing or unparseable (details withheld for safety)';
  }

  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

/**
 * Return `process.env.DATABASE_URL` or throw. Call {@link loadRuntimeEnv} first.
 */
export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error(
      'DATABASE_URL is required. Ensure loadRuntimeEnv() ran and an env file defines it.',
    );
  }

  return databaseUrl;
}
