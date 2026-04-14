import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface";
import type { SandboxStatus } from "../types";
import type {
  CloudflareSandboxConfig,
  CloudflareSandboxConnectConfig,
} from "./config";
import type { CloudflareState } from "./state";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_WORKING_DIRECTORY = "/home/user";
const TIMEOUT_BUFFER_MS = 30_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 300_000;

/**
 * Cloudflare Sandbox implementation.
 *
 * This implementation uses the Cloudflare Containers / Sandbox API to run
 * code in isolated environments. It implements the same `Sandbox` interface
 * as the Vercel implementation, allowing it to be used as a drop-in replacement.
 *
 * The Cloudflare Sandbox API is accessed via REST calls to the Cloudflare API.
 * See: https://developers.cloudflare.com/containers/
 *
 * NOTE: This is an initial scaffold. The actual Cloudflare Containers API
 * integration will need to be filled in once the API is finalized and
 * accessible. For now, this provides the structural foundation and
 * local-execution fallback for development.
 */
export class CloudflareSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly name: string;
  readonly id: string;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;

  private isStopped = false;
  private _expiresAt?: number;
  private _timeout?: number;
  private _ports?: number[];
  private timeoutTimer?: ReturnType<typeof setTimeout>;

  // Cloudflare-specific fields
  private accountId?: string;
  private apiToken?: string;
  private containerId?: string;

  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  get timeout(): number | undefined {
    return this._timeout;
  }

  private constructor(
    name: string,
    id: string,
    workingDirectory: string,
    env?: Record<string, string>,
    currentBranch?: string,
    hooks?: SandboxHooks,
    timeout?: number,
    startTime?: number,
    ports?: number[],
    accountId?: string,
    apiToken?: string,
    containerId?: string,
  ) {
    this.name = name;
    this.id = id;
    this.workingDirectory = workingDirectory;
    this.env = env;
    this.currentBranch = currentBranch;
    this.hooks = hooks;
    this._ports = ports;
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.containerId = containerId;

    if (timeout !== undefined && startTime !== undefined) {
      this._timeout = timeout;
      this._expiresAt = startTime + timeout;
      this.scheduleProactiveStop();
    }
  }

  private scheduleProactiveStop(): void {
    if (this._expiresAt === undefined) return;

    const msUntilTimeout = this._expiresAt - Date.now();
    if (msUntilTimeout <= 0) return;

    this.timeoutTimer = setTimeout(async () => {
      try {
        if (this.isStopped) return;
        if (this.hooks?.onTimeout) {
          try {
            await this.hooks.onTimeout(this);
          } catch (error) {
            console.error(
              "[CloudflareSandbox] onTimeout hook failed:",
              error instanceof Error ? error.message : error,
            );
          }
        }
      } catch (error) {
        console.warn(
          "[CloudflareSandbox] onTimeout handler failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }, msUntilTimeout);
  }

  private rescheduleProactiveStop(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    this.scheduleProactiveStop();
  }

  /**
   * Make an authenticated request to the Cloudflare API.
   */
  private async cfApiRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    return fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * Execute a command inside the Cloudflare container via the API.
   * Falls back to local execution for development when no container is available.
   */
  private async runCommand(
    cmd: string,
    args: string[],
    cwd?: string,
    envOverride?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // If we have a container ID and API credentials, use the Cloudflare API
    if (this.containerId && this.accountId && this.apiToken) {
      return this.runCommandViaApi(cmd, args, cwd, envOverride, timeoutMs);
    }

    // Fallback: local execution for development
    return this.runCommandLocal(cmd, args, cwd, envOverride, timeoutMs);
  }

  /**
   * Execute a command via the Cloudflare Containers API.
   */
  private async runCommandViaApi(
    cmd: string,
    args: string[],
    cwd?: string,
    envOverride?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const fullCommand = [cmd, ...args].join(" ");
    const wrappedCommand = cwd
      ? `cd "${cwd}" && ${fullCommand}`
      : fullCommand;

    try {
      const response = await this.cfApiRequest(
        "POST",
        `/containers/${this.containerId}/exec`,
        {
          command: ["bash", "-c", wrappedCommand],
          env: { ...this.env, ...envOverride },
          timeout: timeoutMs ? Math.ceil(timeoutMs / 1000) : undefined,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Cloudflare API error: ${response.status} ${errorText}`,
        };
      }

      const result = (await response.json()) as {
        result?: { exit_code?: number; stdout?: string; stderr?: string };
      };
      return {
        exitCode: result.result?.exit_code ?? 1,
        stdout: result.result?.stdout ?? "",
        stderr: result.result?.stderr ?? "",
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a command locally (development fallback).
   */
  private async runCommandLocal(
    cmd: string,
    args: string[],
    cwd?: string,
    _envOverride?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { execSync } = await import("child_process");
    const fullCommand = `${cmd} ${args.join(" ")}`;

    try {
      const result = execSync(fullCommand, {
        cwd: cwd ?? this.workingDirectory,
        timeout: timeoutMs ?? 30_000,
        encoding: "utf-8",
        env: { ...process.env, ...this.env, ..._envOverride },
        maxBuffer: MAX_OUTPUT_LENGTH * 2,
      });

      return {
        exitCode: 0,
        stdout: typeof result === "string" ? result : "",
        stderr: "",
      };
    } catch (error: unknown) {
      const execError = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        exitCode: execError.status ?? 1,
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? execError.message ?? String(error),
      };
    }
  }

  /**
   * Create a new Cloudflare Sandbox.
   */
  static async create(config: CloudflareSandboxConfig): Promise<CloudflareSandbox> {
    const {
      name,
      source,
      gitUser,
      env,
      githubToken,
      timeout = 300_000,
      ports,
      hooks,
      accountId,
      apiToken,
    } = config;

    const sandboxName = name ?? `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workingDirectory = DEFAULT_WORKING_DIRECTORY;
    let containerId: string | undefined;

    // If Cloudflare credentials are provided, create a real container
    if (accountId && apiToken) {
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify({
              name: sandboxName,
              image: "node:22-bookworm",
              memory_mb: 2048,
              timeout_seconds: Math.ceil(timeout / 1000),
              ...(ports ? { ports: ports.map((p) => ({ port: p, protocol: "tcp" })) } : {}),
            }),
          },
        );

        if (response.ok) {
          const data = (await response.json()) as {
            result?: { id?: string };
          };
          containerId = data.result?.id;
        } else {
          console.warn(
            `[CloudflareSandbox] Failed to create container via API: ${response.status}. Falling back to local mode.`,
          );
        }
      } catch (error) {
        console.warn(
          "[CloudflareSandbox] Failed to create container:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const sandbox = new CloudflareSandbox(
      sandboxName,
      containerId ?? sandboxName,
      workingDirectory,
      env,
      undefined,
      hooks,
      timeout,
      Date.now(),
      ports,
      accountId,
      apiToken,
      containerId,
    );

    // Clone repository if source is provided
    if (source) {
      const cloneUrl = source.token
        ? buildAuthenticatedGitHubUrl(source.url, source.token) ?? source.url
        : source.url;

      const cloneArgs = ["clone"];
      if (source.branch) {
        cloneArgs.push("--branch", source.branch);
      }
      cloneArgs.push(cloneUrl, ".");

      const cloneResult = await sandbox.runCommand(
        "git",
        cloneArgs,
        workingDirectory,
      );

      if (cloneResult.exitCode !== 0) {
        throw new Error(
          `Failed to clone repository '${source.url}': ${cloneResult.stderr}`,
        );
      }

      // Configure git remote with token for push operations
      if (source.token) {
        const authenticatedUrl = buildAuthenticatedGitHubUrl(
          source.url,
          source.token,
        );
        if (authenticatedUrl) {
          await sandbox.runCommand(
            "git",
            ["remote", "set-url", "origin", authenticatedUrl],
            workingDirectory,
          );
        }
      }
    } else {
      // Initialize empty git repo
      await sandbox.runCommand("git", ["init"], workingDirectory);
    }

    // Configure git user for commits
    if (gitUser) {
      await sandbox.runCommand(
        "git",
        ["config", "user.name", gitUser.name],
        workingDirectory,
      );
      await sandbox.runCommand(
        "git",
        ["config", "user.email", gitUser.email],
        workingDirectory,
      );
    }

    // Create initial empty commit for empty sandboxes
    if (!source && gitUser) {
      await sandbox.runCommand(
        "git",
        ["commit", "--allow-empty", "-m", "Initial commit"],
        workingDirectory,
      );
    }

    // Create and checkout new branch if specified
    let currentBranch: string | undefined;
    if (source?.newBranch) {
      const checkoutResult = await sandbox.runCommand(
        "git",
        ["checkout", "-b", source.newBranch],
        workingDirectory,
      );
      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `Failed to create branch '${source.newBranch}': ${checkoutResult.stderr}`,
        );
      }
      currentBranch = source.newBranch;
    } else if (source?.branch) {
      currentBranch = source.branch;
    }

    // Recreate with currentBranch set
    const finalSandbox = new CloudflareSandbox(
      sandboxName,
      containerId ?? sandboxName,
      workingDirectory,
      env,
      currentBranch,
      hooks,
      timeout,
      Date.now(),
      ports,
      accountId,
      apiToken,
      containerId,
    );

    if (hooks?.afterStart) {
      await hooks.afterStart(finalSandbox);
    }

    return finalSandbox;
  }

  /**
   * Connect to an existing Cloudflare Sandbox by name.
   */
  static async connect(
    sandboxName: string,
    options: {
      env?: Record<string, string>;
      githubToken?: string;
      hooks?: SandboxHooks;
      remainingTimeout?: number;
      ports?: number[];
      resume?: boolean;
      accountId?: string;
      apiToken?: string;
    } = {},
  ): Promise<CloudflareSandbox> {
    const remainingTimeout =
      options.remainingTimeout ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    const startTime = Date.now();

    // If Cloudflare credentials are available, try to find the existing container
    let containerId: string | undefined;
    if (options.accountId && options.apiToken) {
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/containers?name=${encodeURIComponent(sandboxName)}`,
          {
            headers: {
              Authorization: `Bearer ${options.apiToken}`,
            },
          },
        );

        if (response.ok) {
          const data = (await response.json()) as {
            result?: Array<{ id?: string; status?: string }>;
          };
          const container = data.result?.[0];
          if (container?.id) {
            containerId = container.id;

            // Resume if requested and container is stopped
            if (options.resume && container.status === "stopped") {
              await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/containers/${containerId}/start`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${options.apiToken}`,
                  },
                },
              );
            }
          }
        }
      } catch (error) {
        console.warn(
          "[CloudflareSandbox] Failed to look up container:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const sandbox = new CloudflareSandbox(
      sandboxName,
      containerId ?? sandboxName,
      DEFAULT_WORKING_DIRECTORY,
      options.env,
      undefined,
      options.hooks,
      remainingTimeout,
      startTime,
      options.ports,
      options.accountId,
      options.apiToken,
      containerId,
    );

    if (options.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  // --- Sandbox interface implementation ---

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    const result = await this.runCommand("cat", [path]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file: ${path}`);
    }
    return result.stdout;
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    const parentDir = path.substring(0, path.lastIndexOf("/"));
    if (parentDir) {
      await this.mkdir(parentDir, { recursive: true });
    }

    // Use base64 encoding to safely handle special characters
    const base64Content = Buffer.from(content, "utf-8").toString("base64");
    const result = await this.runCommand(
      "bash",
      ["-c", `echo '${base64Content}' | base64 -d > '${path}'`],
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file: ${path} - ${result.stderr}`);
    }
  }

  async stat(path: string): Promise<SandboxStats> {
    const result = await this.runCommand(
      "stat",
      ["-c", "%F\t%s\t%Y", path],
    );

    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    const output = result.stdout.trim();
    const [fileType, sizeStr, mtimeStr] = output.split("\t");

    const isDir = fileType === "directory";
    const size = parseInt(sizeStr ?? "0", 10);
    const mtimeMs = parseInt(mtimeStr ?? "0", 10) * 1000;

    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      size,
      mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.runCommand("test", ["-e", path]);
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const args = options?.recursive ? ["-p", path] : [path];
    const result = await this.runCommand("mkdir", args);
    if (result.exitCode !== 0 && !(options?.recursive)) {
      throw new Error(`Failed to create directory: ${path}`);
    }
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const result = await this.runCommand(
      "bash",
      ["-c", `find "${path}" -maxdepth 1 -mindepth 1 -printf "%y %f\\n"`],
    );

    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const output = result.stdout.trim();
    if (!output) {
      return [];
    }

    const entries: Dirent[] = output.split("\n").map((line) => {
      const [type, ...nameParts] = line.split(" ");
      const name = nameParts.join(" ");
      const isDir = type === "d";
      const isFile = type === "f";
      const isSymlink = type === "l";

      return {
        name,
        parentPath: path,
        path: path,
        isDirectory: () => isDir,
        isFile: () => isFile,
        isSymbolicLink: () => isSymlink,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      } as Dirent;
    });

    return entries;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    try {
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const result = await this.runCommand(
        "bash",
        ["-c", `cd "${cwd}" && ${command}`],
        undefined,
        this.getCommandEnv(),
        timeoutMs,
      );

      let stdout = result.stdout;
      let truncated = false;

      if (stdout.length > MAX_OUTPUT_LENGTH) {
        stdout = stdout.slice(0, MAX_OUTPUT_LENGTH);
        truncated = true;
      }

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout,
        stderr: result.stderr,
        truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Run the command in the background using nohup
    await this.runCommand(
      "bash",
      ["-c", `cd "${cwd}" && nohup ${command} > /tmp/${commandId}.log 2>&1 &`],
      undefined,
      this.getCommandEnv(),
    );

    return { commandId };
  }

  domain(port: number): string {
    // For Cloudflare containers, the domain format depends on the deployment
    if (this.containerId && this.accountId) {
      return `https://${this.containerId}-${port}.containers.cloudflare.com`;
    }
    // Local fallback
    return `http://localhost:${port}`;
  }

  async snapshot(): Promise<SnapshotResult> {
    // Cloudflare containers don't have native snapshot support like Vercel.
    // We can implement this via container image commits or R2 state storage.
    const snapshotId = `cf-snap-${this.name}-${Date.now()}`;

    this.isStopped = true;
    this._expiresAt = undefined;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    return { snapshotId };
  }

  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;
    this._expiresAt = undefined;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (error) {
        console.error(
          "[CloudflareSandbox] beforeStop hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Stop the Cloudflare container if we have one
    if (this.containerId && this.accountId && this.apiToken) {
      try {
        await this.cfApiRequest(
          "POST",
          `/containers/${this.containerId}/stop`,
        );
      } catch (error) {
        console.warn(
          "[CloudflareSandbox] Failed to stop container:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    if (this.isStopped) {
      throw new Error("Cannot extend timeout on stopped sandbox");
    }
    if (this._expiresAt === undefined) {
      throw new Error("Timeout tracking not enabled for this sandbox");
    }

    this._expiresAt += additionalMs;
    this.rescheduleProactiveStop();

    if (this.hooks?.onTimeoutExtended) {
      try {
        await this.hooks.onTimeoutExtended(this, additionalMs);
      } catch (error) {
        console.error(
          "[CloudflareSandbox] onTimeoutExtended hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { expiresAt: this._expiresAt };
  }

  get status(): SandboxStatus {
    if (this.isStopped) return "stopped";
    return "ready";
  }

  getState(): { type: "cloudflare" } & CloudflareState {
    return {
      type: "cloudflare",
      sandboxName: this.name,
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
      ...(this.accountId ? { accountId: this.accountId } : {}),
    };
  }

  private getCommandEnv(): Record<string, string> {
    return { ...this.env };
  }
}

function buildAuthenticatedGitHubUrl(
  repoUrl: string,
  token: string,
): string | null {
  const githubUrlMatch = repoUrl.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/,
  );

  if (!githubUrlMatch) {
    return null;
  }

  const [, owner, repo] = githubUrlMatch;
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Connect to a Cloudflare Sandbox - either create a new one or reconnect to an existing one.
 */
export async function connectCloudflareSandbox(
  config: CloudflareSandboxConfig | CloudflareSandboxConnectConfig = {},
): Promise<CloudflareSandbox> {
  const connectConfig = config as CloudflareSandboxConnectConfig;

  if (connectConfig.sandboxName) {
    return CloudflareSandbox.connect(connectConfig.sandboxName, {
      env: connectConfig.env,
      githubToken: connectConfig.githubToken,
      hooks: connectConfig.hooks,
      remainingTimeout: connectConfig.remainingTimeout,
      ports: connectConfig.ports,
      resume: connectConfig.resume,
      accountId: connectConfig.accountId,
      apiToken: connectConfig.apiToken,
    });
  }

  return CloudflareSandbox.create(config as CloudflareSandboxConfig);
}
