import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(packageDir, "../../.env"), quiet: true });
config({ path: resolve(packageDir, ".env"), override: true, quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations"
  },
  datasource: {
    url: process.env.DIRECT_URL?.trim() || env("DATABASE_URL")
  }
});
