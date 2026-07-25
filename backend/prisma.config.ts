import { defineConfig, env } from "prisma/config";
import { loadRuntimeEnv } from "./scripts/lib/load-runtime-env";

// Load env with the same precedence as the running backend
// (.env.local > .env.development > .env) so the Prisma CLI, `prisma db seed`,
// and `prisma migrate deploy` all resolve DATABASE_URL to the same database the
// API server uses.
loadRuntimeEnv();

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