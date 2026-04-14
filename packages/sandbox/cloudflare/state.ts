import type { Source } from "../types";

/**
 * State configuration for creating, reconnecting, or restoring a Cloudflare sandbox.
 * Used with the unified `connectSandbox()` API.
 */
export interface CloudflareState {
  /** Where to clone from (omit for empty sandbox or when reconnecting) */
  source?: Source;
  /** Durable container/sandbox name used for reconnecting/resuming sessions */
  sandboxName?: string;
  /** Timestamp (ms) when the current runtime session expires */
  expiresAt?: number;
  /** Cloudflare account ID */
  accountId?: string;
}
