/**
 * Lightweight workflow runtime that replaces Vercel Workflow.
 *
 * Vercel Workflow provides durable execution with "use workflow" and "use step"
 * directives, automatic retries, and persistent run state. This shim provides
 * a compatible API surface using simple async execution:
 *
 * - `start()` runs the workflow function asynchronously and returns a run handle
 * - `getRun()` retrieves a run handle by ID for status checks and stream access
 * - `getWorkflowMetadata()` returns the current workflow run ID
 * - `getWritable()` returns the writable side of the workflow's output stream
 * - `sleep()` pauses execution for a duration (using setTimeout)
 * - `withWorkflow()` is a no-op passthrough for Next.js config wrapping
 *
 * The "use workflow" and "use step" directives are treated as no-ops by this
 * runtime — they are simply ignored as string literals in function bodies.
 *
 * For production use with Cloudflare, this can be upgraded to use:
 * - Cloudflare Durable Objects for persistent run state
 * - Cloudflare Queues for reliable task dispatch
 * - Cloudflare Workers for the execution environment
 */

import { nanoid } from "nanoid";

// --- Types ---

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowRun<T = unknown> {
  runId: string;
  status: Promise<WorkflowRunStatus>;
  cancel(): void;
  getReadable<C = T>(): ReadableStream<C>;
}

interface InternalRun {
  runId: string;
  status: WorkflowRunStatus;
  abortController: AbortController;
  readable: ReadableStream<unknown>;
  writable: WritableStream<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

// --- Global run registry ---

const runRegistry = new Map<string, InternalRun>();

// --- Context for the currently executing workflow ---

let currentRunId: string | null = null;
let currentWritable: WritableStream<unknown> | null = null;

// --- Public API: workflow/api ---

/**
 * Start a workflow function asynchronously.
 * Compatible with: `import { start } from "workflow/api"`
 */
export async function start<TArgs extends unknown[], TResult>(
  workflowFn: (...args: TArgs) => Promise<TResult>,
  args: TArgs,
): Promise<WorkflowRun<TResult>> {
  const runId = `run_${nanoid()}`;

  const { readable, writable } = new TransformStream<unknown, unknown>();

  let resolve: (value: unknown) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const abortController = new AbortController();

  const internalRun: InternalRun = {
    runId,
    status: "pending",
    abortController,
    readable,
    writable,
    resolve: resolve!,
    reject: reject!,
    promise,
  };

  runRegistry.set(runId, internalRun);

  // Execute the workflow asynchronously
  void executeWorkflow(internalRun, workflowFn, args);

  return createRunHandle<TResult>(internalRun);
}

/**
 * Get a handle to an existing workflow run by ID.
 * Compatible with: `import { getRun } from "workflow/api"`
 */
export function getRun<T = unknown>(runId: string): WorkflowRun<T> {
  const internalRun = runRegistry.get(runId);
  if (!internalRun) {
    throw new Error(`Workflow run not found: ${runId}`);
  }
  return createRunHandle<T>(internalRun);
}

// --- Public API: workflow ---

/**
 * Get metadata about the currently executing workflow.
 * Compatible with: `import { getWorkflowMetadata } from "workflow"`
 */
export function getWorkflowMetadata(): { workflowRunId: string } {
  if (!currentRunId) {
    throw new Error(
      "getWorkflowMetadata() called outside of a workflow context",
    );
  }
  return { workflowRunId: currentRunId };
}

/**
 * Get the writable stream for the currently executing workflow.
 * Compatible with: `import { getWritable } from "workflow"`
 */
export function getWritable<T>(): WritableStream<T> {
  if (!currentWritable) {
    throw new Error("getWritable() called outside of a workflow context");
  }
  return currentWritable as WritableStream<T>;
}

/**
 * Sleep for a specified duration.
 * Compatible with: `import { sleep } from "workflow"`
 */
export function sleep(dateOrMs: Date | number): Promise<void> {
  const ms =
    dateOrMs instanceof Date
      ? Math.max(0, dateOrMs.getTime() - Date.now())
      : dateOrMs;

  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --- Public API: workflow/next ---

/**
 * No-op Next.js config wrapper.
 * Compatible with: `import { withWorkflow } from "workflow/next"`
 */
export function withWorkflow<T>(config: T): T {
  return config;
}

// --- Internal helpers ---

function createRunHandle<T>(internalRun: InternalRun): WorkflowRun<T> {
  return {
    runId: internalRun.runId,
    get status(): Promise<WorkflowRunStatus> {
      return Promise.resolve(internalRun.status);
    },
    cancel() {
      if (
        internalRun.status === "running" ||
        internalRun.status === "pending"
      ) {
        internalRun.status = "cancelled";
        internalRun.abortController.abort();
        // Close the writable stream to signal completion
        try {
          internalRun.writable.close().catch(() => {});
        } catch {
          // Already closed
        }
      }
    },
    getReadable<C = T>(): ReadableStream<C> {
      return internalRun.readable as ReadableStream<C>;
    },
  };
}

async function executeWorkflow<TArgs extends unknown[], TResult>(
  internalRun: InternalRun,
  workflowFn: (...args: TArgs) => Promise<TResult>,
  args: TArgs,
): Promise<void> {
  // Set up the workflow context
  const previousRunId = currentRunId;
  const previousWritable = currentWritable;

  currentRunId = internalRun.runId;
  currentWritable = internalRun.writable;
  internalRun.status = "running";

  try {
    const result = await workflowFn(...args);
    internalRun.status = "completed";
    internalRun.resolve(result);
  } catch (error) {
    if (internalRun.status === "cancelled") {
      // Already cancelled — don't overwrite status
      internalRun.reject(error);
    } else {
      internalRun.status = "failed";
      internalRun.reject(error);
    }
  } finally {
    // Restore previous context
    currentRunId = previousRunId;
    currentWritable = previousWritable;

    // Close the writable stream
    try {
      await internalRun.writable.close();
    } catch {
      // Already closed or errored
    }

    // Clean up the registry after a delay to allow status checks
    setTimeout(() => {
      runRegistry.delete(internalRun.runId);
    }, 5 * 60 * 1000); // Keep for 5 minutes
  }
}
