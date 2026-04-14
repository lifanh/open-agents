import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Database client using Drizzle ORM with the postgres-js driver.
 *
 * This is provider-agnostic and works with any PostgreSQL-compatible database:
 * - Neon Postgres (original open-agents default)
 * - Cloudflare Hyperdrive + any Postgres (recommended for Cloudflare deployments)
 * - Supabase Postgres
 * - Self-hosted PostgreSQL
 * - Any other Postgres-compatible database
 *
 * Set the DATABASE_URL or POSTGRES_URL environment variable to your connection string.
 */
type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleClient | null = null;

function getDatabaseUrl(): string {
  const url =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.HYPERDRIVE_URL;

  if (!url) {
    throw new Error(
      "Database connection URL is required. Set DATABASE_URL, POSTGRES_URL, or HYPERDRIVE_URL.",
    );
  }

  return url;
}

export const db = new Proxy({} as DrizzleClient, {
  get(_, prop) {
    if (!_db) {
      const url = getDatabaseUrl();
      const client = postgres(url);
      _db = drizzle(client, { schema });
    }
    return Reflect.get(_db, prop);
  },
});
