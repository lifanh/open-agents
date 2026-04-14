import type { SandboxHooks } from "../interface";

export interface CloudflareSandboxConfig {
  /**
   * Optional persistent sandbox name.
   * When provided, repeated creates target the same durable container.
   */
  name?: string;
  /**
   * Optional GitHub repository source to clone into the sandbox.
   * If not provided, the sandbox starts empty.
   */
  source?: {
    /** GitHub repository URL (e.g., "https://github.com/owner/repo") */
    url: string;
    /** Branch to clone (defaults to "main") */
    branch?: string;
    /** Token for authenticated git access (e.g., GitHub PAT). Enables push operations. */
    token?: string;
    /**
     * Create and checkout a new branch after cloning.
     * Useful for isolating agent changes from the main branch.
     */
    newBranch?: string;
  };
  /**
   * Git user configuration for commits.
   * Required if you want the agent to make commits.
   */
  gitUser?: {
    /** Name for git commits (e.g., "AI Agent") */
    name: string;
    /** Email for git commits (e.g., "agent@example.com") */
    email: string;
  };
  /**
   * Environment variables to make available to all commands in the sandbox.
   */
  env?: Record<string, string>;
  /** GitHub token used for credential brokering; never exposed inside the sandbox. */
  githubToken?: string;
  /**
   * Sandbox timeout in milliseconds.
   * @default 300_000 (5 minutes)
   */
  timeout?: number;
  /**
   * Ports to expose from the sandbox.
   */
  ports?: number[];
  /**
   * Cloudflare account ID for API calls.
   */
  accountId?: string;
  /**
   * Cloudflare API token for authentication.
   */
  apiToken?: string;
  /**
   * Lifecycle hooks for setup and teardown.
   */
  hooks?: SandboxHooks;
}

/**
 * Configuration for reconnecting to an existing Cloudflare sandbox.
 */
export interface CloudflareSandboxConnectConfig {
  /** The persistent sandbox name to reconnect to */
  sandboxName: string;
  /** Environment variables to make available to commands */
  env?: Record<string, string>;
  /** GitHub token used for credential brokering */
  githubToken?: string;
  /** Lifecycle hooks for setup and teardown */
  hooks?: SandboxHooks;
  /**
   * Remaining timeout in milliseconds for the current session.
   */
  remainingTimeout?: number;
  /** Ports that were declared at creation time */
  ports?: number[];
  /** Whether a stopped sandbox should be explicitly resumed */
  resume?: boolean;
  /** Cloudflare account ID */
  accountId?: string;
  /** Cloudflare API token */
  apiToken?: string;
}
