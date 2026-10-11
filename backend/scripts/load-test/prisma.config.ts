import { defineConfig } from 'prisma/config';
import { resolve } from 'node:path';
import { readInputs, ROOT, observerCredentials } from './manifest';
import { validateMigrationProof } from './preflight';

// Explicit --config entry; never imports the repository dotenv loader.
const { m, c, manifestHash } = readInputs(
  process.env.LOAD_TEST_MANIFEST!,
  process.env.LOAD_TEST_CREDENTIALS!,
);
const observer = observerCredentials(c);
validateMigrationProof(
  m,
  observer,
  manifestHash,
  process.env.LOAD_TEST_MIGRATION_PREFLIGHT,
);
export default defineConfig({
  schema: resolve(ROOT, 'prisma/schema.prisma'),
  migrations: { path: resolve(ROOT, 'prisma/migrations') },
  datasource: { url: observer.databaseUrl },
});
