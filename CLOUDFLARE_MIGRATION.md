# Cloudflare Migration Guide

This fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) replaces Vercel-specific infrastructure dependencies with provider-agnostic abstractions that support **Cloudflare** as a first-class deployment target.

## What Changed

The following table summarizes the infrastructure replacements:

| Component | Original (Vercel) | This Fork | Status |
|---|---|---|---|
| **Sandbox / Code Execution** | `@vercel/sandbox` (Firecracker MicroVMs) | Cloudflare Containers API | Implemented (interface-compatible) |
| **Durable Workflow Engine** | `workflow` SDK (Vercel Workflow) | Lightweight async runner (`lib/workflow`) | Implemented |
| **Database** | Neon Postgres (`POSTGRES_URL`) | Any PostgreSQL (`DATABASE_URL`) | Implemented |
| **Cache / KV** | Upstash Redis / ioredis (`REDIS_URL`) | In-memory cache with optional Redis | Implemented |
| **Analytics** | `@vercel/analytics` | Removed (pluggable) | Done |
| **Hosting** | Vercel (Next.js on Edge) | Any platform (Cloudflare Pages, self-hosted, etc.) | Done |
| **Metadata / URLs** | `VERCEL_URL`, `VERCEL_ENV` | `NEXT_PUBLIC_APP_URL`, `CF_PAGES_URL` (with Vercel fallback) | Done |

## Architecture

### Sandbox Abstraction (`packages/sandbox`)

The sandbox package now supports two providers behind a unified `Sandbox` interface:

```
packages/sandbox/
├── interface.ts          # Shared Sandbox interface contract
├── factory.ts            # Routes to correct provider based on state.type
├── vercel/               # Original Vercel Sandbox implementation
│   ├── sandbox.ts
│   ├── config.ts
│   ├── state.ts
│   └── connect.ts
└── cloudflare/           # NEW: Cloudflare Containers implementation
    ├── sandbox.ts        # Implements Sandbox interface via Cloudflare API
    ├── config.ts         # Cloudflare-specific configuration types
    ├── state.ts          # Cloudflare sandbox state type
    └── connect.ts        # Factory function for Cloudflare sandboxes
```

The sandbox type is determined by:
1. Explicit `sandboxType` in the API request body (`"vercel"` or `"cloudflare"`)
2. The `getDefaultSandboxType()` function, which returns `"cloudflare"` if `CLOUDFLARE_ACCOUNT_ID` is set

### Workflow Replacement (`apps/web/lib/workflow`)

The Vercel Workflow SDK provided durable execution with `"use workflow"` and `"use step"` directives. This fork replaces it with a lightweight async runner that provides the same API surface:

- `start(fn, args)` — Runs the workflow function asynchronously, returns a run handle
- `getRun(runId)` — Retrieves a run handle by ID for status checks and stream access
- `getWorkflowMetadata()` — Returns the current workflow run ID
- `getWritable()` — Returns the writable side of the workflow's output stream
- `sleep(ms)` — Pauses execution for a duration
- `withWorkflow(config)` — No-op passthrough for Next.js config

The `"use workflow"` and `"use step"` directives are treated as no-op string literals.

**Upgrade path:** For production Cloudflare deployments, this can be upgraded to use Cloudflare Durable Objects for persistent run state and Cloudflare Queues for reliable task dispatch.

### Database Layer

The database client (`apps/web/lib/db/client.ts`) now accepts connection strings from multiple environment variables in priority order:

1. `DATABASE_URL` (preferred, provider-agnostic)
2. `POSTGRES_URL` (legacy, still supported)
3. `HYPERDRIVE_URL` (Cloudflare Hyperdrive connection pooling)

The Drizzle ORM setup uses the `postgres-js` driver, which works with any PostgreSQL-compatible database.

### Cache Layer

A new cache abstraction (`apps/web/lib/cache.ts`) provides:

- **In-memory cache** (default) — No external dependencies, works everywhere
- **Redis** (optional) — When `REDIS_URL` or `KV_URL` is set
- **Cloudflare KV** (future) — Planned for Cloudflare Workers deployments

The original `lib/redis.ts` module is preserved for backward compatibility.

## Deployment

### Cloudflare Deployment

1. Set up a PostgreSQL database (e.g., Neon, Supabase, or any Postgres)
2. Configure Cloudflare Hyperdrive for connection pooling (optional but recommended)
3. Set environment variables:

```bash
DATABASE_URL=postgresql://...
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
JWE_SECRET=...
ENCRYPTION_KEY=...
# ... GitHub App credentials
```

4. Deploy to Cloudflare Pages with Next.js adapter, or run as a standalone Node.js app

### Self-Hosted Deployment

1. Set up PostgreSQL
2. Set environment variables (see `.env.example`)
3. Run with `next start` or your preferred Node.js hosting

### Vercel Deployment (still supported)

The original Vercel deployment path continues to work. Simply set `POSTGRES_URL` and the Vercel-specific environment variables as before.

## Known Limitations

1. **Cloudflare Containers API**: The sandbox implementation uses the Cloudflare Containers REST API. As of April 2025, this API is in beta and may change. The implementation includes placeholder endpoints that should be updated when the API stabilizes.

2. **Workflow Durability**: The lightweight workflow runner does not provide the same durability guarantees as Vercel Workflow. Long-running workflows may be lost if the server restarts. For production use, consider upgrading to Cloudflare Durable Objects.

3. **Snapshot/Restore**: The Cloudflare sandbox implementation includes snapshot and restore methods, but the actual Cloudflare Containers snapshot API may differ from the placeholder implementation.

4. **Vercel OAuth**: The Vercel OAuth sign-in flow is still present in the codebase. For non-Vercel deployments, use GitHub OAuth as the primary authentication method.

## Files Modified

### New Files
- `packages/sandbox/cloudflare/` — Cloudflare Containers sandbox implementation
- `apps/web/lib/workflow/index.ts` — Lightweight workflow runtime
- `apps/web/lib/cache.ts` — Cache abstraction layer
- `CLOUDFLARE_MIGRATION.md` — This document

### Modified Files
- `packages/sandbox/factory.ts` — Added Cloudflare routing
- `packages/sandbox/index.ts` — Added Cloudflare exports
- `packages/sandbox/package.json` — Added Cloudflare subpath exports
- `apps/web/next.config.ts` — Removed `withWorkflow` wrapper
- `apps/web/app/layout.tsx` — Removed `@vercel/analytics`, added multi-platform URL support
- `apps/web/app/api/sandbox/route.ts` — Added Cloudflare sandbox type support
- `apps/web/app/api/chat/route.ts` — Switched to local workflow shim
- `apps/web/app/api/chat/[chatId]/stop/route.ts` — Switched to local workflow shim
- `apps/web/app/api/chat/[chatId]/stream/route.ts` — Switched to local workflow shim
- `apps/web/app/api/sessions/[sessionId]/chats/[chatId]/messages/[messageId]/route.ts` — Switched to local workflow shim
- `apps/web/app/workflows/chat.ts` — Switched to local workflow shim
- `apps/web/app/workflows/sandbox-lifecycle.ts` — Updated for multi-provider support
- `apps/web/lib/db/client.ts` — Multi-provider database URL support
- `apps/web/lib/db/migrate.ts` — Multi-provider database URL support
- `apps/web/drizzle.config.ts` — Multi-provider database URL support
- `apps/web/lib/sandbox/lifecycle-kick.ts` — Updated for multi-provider support
- `apps/web/.env.example` — Updated with Cloudflare configuration options
