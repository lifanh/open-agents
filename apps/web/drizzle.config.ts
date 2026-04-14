import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  ...((process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.HYPERDRIVE_URL) && {
    dbCredentials: {
      url: (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.HYPERDRIVE_URL)!,
    },
  }),
});
