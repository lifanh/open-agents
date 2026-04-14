import type { Sandbox, SandboxHooks } from "../interface";
import type { CloudflareSandboxConfig } from "./config";
import { CloudflareSandbox } from "./sandbox";
import type { CloudflareState } from "./state";

interface ConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  resume?: boolean;
}

function getRemainingTimeout(
  expiresAt: number | undefined,
): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

function getSandboxName(state: CloudflareState): string | undefined {
  if (typeof state.sandboxName === "string" && state.sandboxName.length > 0) {
    return state.sandboxName;
  }
  return undefined;
}

function buildCreateConfig(
  state: CloudflareState,
  options?: ConnectOptions,
): CloudflareSandboxConfig {
  const sandboxName = getSandboxName(state);
  const accountId =
    state.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  return {
    ...(sandboxName ? { name: sandboxName } : {}),
    ...(state.source
      ? {
          source: {
            url: state.source.repo,
            branch: state.source.branch,
            token: state.source.token,
            newBranch: state.source.newBranch,
          },
        }
      : {}),
    env: options?.env,
    githubToken: options?.githubToken,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.ports && { ports: options.ports }),
    accountId,
    apiToken,
  };
}

async function connectNamedSandbox(
  state: CloudflareState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);
  if (!sandboxName) {
    throw new Error("Persistent sandbox name is required");
  }

  const remainingTimeout = getRemainingTimeout(state.expiresAt);
  const accountId =
    state.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  try {
    return await CloudflareSandbox.connect(sandboxName, {
      env: options?.env,
      githubToken: options?.githubToken,
      hooks: options?.hooks,
      remainingTimeout,
      ports: options?.ports,
      resume: options?.resume,
      accountId,
      apiToken,
    });
  } catch (error) {
    // If connection fails, try creating a new sandbox
    console.warn(
      "[CloudflareSandbox] Failed to connect to existing sandbox, creating new one:",
      error instanceof Error ? error.message : error,
    );
  }

  return CloudflareSandbox.create(buildCreateConfig(state, options));
}

/**
 * Connect to the Cloudflare-backed sandbox based on the provided state.
 *
 * - If `sandboxName` is present, reconnects to the named persistent sandbox
 * - If `source` is present, creates a new sandbox and prepares the repo
 * - Otherwise, creates an empty sandbox
 */
export async function connectCloudflare(
  state: CloudflareState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);

  if (sandboxName) {
    return connectNamedSandbox(state, options);
  }

  return CloudflareSandbox.create(buildCreateConfig(state, options));
}
