import { defineConfig, env } from "prisma/config";
import { loadRuntimeEnv } from "./scripts/lib/load-runtime-env";
import { assertNormalEnvironment } from "./scripts/load-test/manifest";

// Load env with the same precedence as the running backend
// (.env.local > .env.development > .env) so the Prisma CLI, `prisma db seed`,
// and `prisma migrate deploy` all resolve DATABASE_URL to the same database the
// API server uses.
loadRuntimeEnv();
// Render builds may generate a client, but test migration requires preflight.
assertNormalEnvironment(process.env, process.argv.slice(2));

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
