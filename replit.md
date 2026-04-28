# Workspace

## Overview

Corn-Api / Replit2Api — an AI API gateway and management portal. Proxies OpenAI, Anthropic, Gemini, and OpenRouter APIs through a unified endpoint. Pulled from https://github.com/timigohehe-web/Corn-Api.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS (api-portal)

## Artifacts

- `artifacts/api-portal` — Management portal UI (previewPath: `/`). React + Vite.
- `artifacts/api-server` — Express API server (previewPath: `/api`). Handles AI proxy, settings, and update routes.

## Key Environment Variables

- `PROXY_API_KEY` — Required. The API key clients use to authenticate with this proxy.
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — OpenAI integration base URL (via Replit integrations)
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — Anthropic integration base URL
- `AI_INTEGRATIONS_GEMINI_BASE_URL` — Gemini integration base URL
- `AI_INTEGRATIONS_OPENROUTER_BASE_URL` — OpenRouter integration base URL
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — GCS bucket for persistent config (optional, falls back to local filesystem)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
