/**
 * Cache abstraction layer that supports multiple backends:
 *
 * 1. **In-memory cache** (default, no external dependencies)
 * 2. **Redis** (when REDIS_URL or KV_URL is set) — compatible with Upstash, self-hosted Redis
 * 3. **Cloudflare KV** (future) — when running on Cloudflare Workers
 *
 * The cache is used primarily for skills caching and other ephemeral data.
 * It gracefully degrades to in-memory when no external cache is configured.
 */

const warnedMissingCacheFeatures = new Set<string>();

/**
 * Minimal cache client interface used by the skills cache and other consumers.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Check if an external cache backend is configured.
 */
export function isCacheConfigured(): boolean {
  return !!(process.env.REDIS_URL ?? process.env.KV_URL);
}

/**
 * Warn that a feature is disabled because no cache backend is configured.
 */
export function warnCacheDisabled(feature: string): void {
  if (warnedMissingCacheFeatures.has(feature)) {
    return;
  }

  warnedMissingCacheFeatures.add(feature);
  console.error(
    `[cache] ${feature} is disabled because no cache backend (REDIS_URL/KV_URL) is configured. Using in-memory fallback.`,
  );
}

/**
 * In-memory cache implementation with TTL support.
 */
class InMemoryCache implements CacheClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    let ttlSeconds: number | undefined;

    // Parse Redis-compatible SET arguments: "EX" <seconds>
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "EX" && typeof args[i + 1] === "number") {
        ttlSeconds = args[i + 1] as number;
        break;
      }
    }

    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });

    return "OK";
  }
}

let sharedCacheClient: CacheClient | null = null;

/**
 * Create or return the shared cache client.
 *
 * If REDIS_URL/KV_URL is set, creates an ioredis client.
 * Otherwise, returns an in-memory cache.
 */
export function getCacheClient(clientName = "cache-client"): CacheClient {
  if (sharedCacheClient) {
    return sharedCacheClient;
  }

  const redisUrl = process.env.REDIS_URL ?? process.env.KV_URL;

  if (redisUrl) {
    try {
      // Dynamically import ioredis only when needed
      // This allows the app to run without ioredis installed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require("ioredis").default ?? require("ioredis");
      const { getRedisConnectionOptions } = require("./redis");
      const client = new Redis(getRedisConnectionOptions(redisUrl));
      client.on("error", (error: Error) => {
        console.error(`[cache] ${clientName} Redis error:`, error);
      });
      sharedCacheClient = client as CacheClient;
      return sharedCacheClient;
    } catch (error) {
      console.warn(
        `[cache] Failed to create Redis client, falling back to in-memory:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  sharedCacheClient = new InMemoryCache();
  return sharedCacheClient;
}

// Re-export redis functions for backward compatibility
export {
  getRedisUrl,
  getRedisConnectionOptions,
  isRedisConfigured,
  warnRedisDisabled,
  createRedisClient,
} from "./redis";
