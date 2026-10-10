import { defineConfig } from 'prisma/config';
import { resolve } from 'node:path';
import { readInputs, ROOT, observerCredentials } from './manifest';

// Explicit --config entry; never imports the repository dotenv loader.
const { c } = readInputs(
  process.env.LOAD_TEST_MANIFEST!,
  process.env.LOAD_TEST_CREDENTIALS!,
);
export default defineConfig({
  schema: resolve(ROOT, 'prisma/schema.prisma'),
  migrations: { path: resolve(ROOT, 'prisma/migrations') },
  datasource: { url: observerCredentials(c).databaseUrl },
});
