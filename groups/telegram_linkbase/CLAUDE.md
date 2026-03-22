# Linkbase

## Project

- Repo: https://github.com/kaloyanBozhkov/linkbase
- Path: /workspace/extra/linkbase
- Stack: Monorepo (pnpm workspaces) — backend + mobile app + shared packages
- Package manager: pnpm
- Structure: `backend/`, `linkbase/` (mobile app), `packages/prisma`, `packages/linkbase-shared`

## Project Context
Linkbase is a full-stack TypeScript monorepo: a **React Native mobile app** (Expo) backed by a **Node.js Express API** with PostgreSQL. It's a personal CRM for managing people you meet — storing connections, memories, social links, and using AI for search and voice commands.

## Monorepo Layout

```
linkbase/
├── backend/             # Express API server (tRPC + REST)
│   ├── src/
│   │   ├── trpc/        # tRPC init, routers, procedures
│   │   ├── router/      # Express routes, middleware
│   │   ├── queries/     # Business logic by domain (connections/, users/, ai/, memories/, subscriptions/)
│   │   ├── services/    # External integrations (email, etc.)
│   │   ├── ai/          # Vector search, embeddings, prompts
│   │   ├── s3/          # AWS S3 upload/download
│   │   ├── helpers/     # Logger, utilities (infiniteResponse, etc.)
│   │   └── env.ts       # Env validation (@t3-oss/env-core + Zod)
│   └── _app/            # Admin SPA (React 19 + Tailwind, served at /app/*)
├── linkbase/            # React Native mobile app (Expo)
│   └── src/
│       ├── pages/       # Screens (HomeScreen, AddConnectionScreen, etc.)
│       ├── components/  # Atomic Design (atoms/, molecules/, organisms/, layouts/)
│       ├── hooks/       # Custom hooks (useSubscription, getInfiniteQueryItems, etc.)
│       ├── providers/   # TRPCProvider, etc.
│       ├── utils/       # trpc client, helpers
│       ├── i18n/        # i18next translations (12 locales)
│       └── config/      # API config, app constants
├── packages/
│   ├── prisma/          # Prisma schema, migrations, client generation
│   ├── linkbase-shared/ # Shared TS utilities, API config, pricing
│   └── prompt-tests/    # AI prompt validation (promptfoo)
└── package.json         # Root workspace scripts
```

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 22, pnpm workspaces |
| Backend | Express, tRPC v11, Webpack + SWC |
| Database | PostgreSQL + Prisma 6 + pgvector |
| Frontend | React Native 0.81, Expo 54, NativeWind (Tailwind) |
| State | Zustand |
| Data fetching | tRPC + React Query v5 |
| Serialization | superjson (both ends) |
| Validation | Zod |
| AI | OpenAI, OpenRouter, Langfuse, 512D vector embeddings |
| Storage | AWS S3 (presigned URLs) |
| Email | Resend |
| Monitoring | Sentry (mobile), structured logging (backend) |
| IAP | expo-iap (iOS/Android subscriptions) |
| i18n | i18next (12 locales, GPT-powered translation scripts) |
| CI/CD | GitHub Actions → Docker → VPS deploy |

## Common Commands

```bash
# Install
pnpm install

# Development
cd backend && pnpm dev          # API + admin SPA (port 3000)
cd linkbase && pnpm dev         # Expo dev server (auto-detects local IP)

# Database
pnpm db:generate                # Generate Prisma client from schema
pnpm db:push                    # Push schema changes to DB
pnpm db:migrate                 # Run migrations
pnpm db:studio                  # Open Prisma Studio GUI
pnpm db:seed                    # Seed initial data

# Quality
pnpm lint                       # ESLint across backend + app
pnpm type-check                 # tsc --noEmit across backend + app
cd backend && pnpm lint:fix     # Auto-fix lint issues
cd linkbase && pnpm lint:fix

# Build
pnpm build                      # Full production build (packages → backend → iOS)
pnpm build:backend              # Backend only
pnpm build:packages             # Shared packages only (prisma + linkbase-shared)

# Mobile builds (EAS)
cd linkbase && pnpm build-ios           # Cloud iOS build
cd linkbase && pnpm build-android       # Cloud Android build
cd linkbase && pnpm build-ios-local     # Local iOS build
cd linkbase && pnpm release-ios-local   # Submit to App Store

# Translations
pnpm translate                  # Generate all translations via GPT
pnpm translate:missing          # Only missing keys

# Prompt tests
pnpm test:prompts               # Run promptfoo tests
pnpm test:prompts:view          # View results in browser
```

## Environment Variables

Backend requires a `.env` file in `backend/`. Validated at startup via `@t3-oss/env-core`:

```
# Required
DATABASE_URL=postgresql://...
OPEN_AI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
RESEND_API_KEY=re_...
EMAIL_ENCRYPTION_KEY=...

# Optional
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:8081
LOGS_VIEW_KEY=...               # Enables /logs explorer
APPLE_SHARED_SECRET=...         # iOS receipt validation
GOOGLE_SERVICE_ACCOUNT_JSON=... # Android receipt validation
```

Mobile app uses `EXPO_PUBLIC_*` vars in `linkbase/.env`.

## Database

- **Schema**: `packages/prisma/prisma/schema.prisma`
- **ORM**: Prisma 6 with PostgreSQL + pgvector extension
- **Key models**: `user`, `connection`, `fact`, `social_media`, `entertainment`, `memory`, `memory_image`, `subscription`, `log`
- **Naming**: snake_case fields, singular model names, `_id` suffix for FKs
- **Vectors**: 512-dimension embeddings for AI semantic search (`ai_cached_embedding`)
- **After schema changes**: run `pnpm db:generate` then `pnpm db:push` (or `db:migrate` for production)

## tRPC

End-to-end type-safe API. See `~/Documents/blueprints/trpc-implementation.md` for the full pattern guide.

- **Server init**: `backend/src/trpc/init.ts` — context from headers, superjson transformer
- **Routers**: `backend/src/trpc/routers/` — `linkbase` (connections, memories, users, subscriptions, platform, logging) + `admin`
- **Procedure types**: `publicProcedure`, `protectedProcedure` (requires userId), `adminProcedure` (requires admin key)
- **Express mount**: `/api/trpc` via `@trpc/server/adapters/express`
- **Client**: `linkbase/src/utils/trpc.ts` — `createTRPCReact<AppRouter>()` with `httpBatchLink`
- **Provider**: `linkbase/src/providers/TRPCProvider.tsx` wraps app with tRPC + React Query
- **Pagination**: cursor-based, all paginated endpoints return `{ items, nextCursor }` via `infiniteResponse()` helper
- **Cache utils**: `updateInfiniteQueryDataOn{Delete,Edit,Add}` in `linkbase/src/utils/trpc.ts`
- **Flatten pages**: `getInfiniteQueryItems(data)` in `linkbase/src/hooks/getInfiniteQueryItems.ts`

## Code Conventions

- **Path alias**: `@/*` → `src/*` in both backend and mobile
- **Workspace imports**: `@linkbase/prisma`, `@linkbase/linkbase-shared` (workspace:* protocol)
- **Backend queries**: named `<action><Entity>Query` (e.g. `getConnectionByIdQuery`, `createUserQuery`), live in `src/queries/<domain>/`
- **Mobile screens**: PascalCase with `Screen` suffix (e.g. `AddConnectionScreen.tsx`), live in `src/pages/`
- **Components**: Atomic Design — `atoms/`, `molecules/`, `organisms/`, `layouts/`
- **State**: Zustand stores in hooks (e.g. `useSessionUserStore`)
- **Unused vars**: prefix with `_` to satisfy ESLint (pattern: `argsIgnorePattern: "^_"`)
- **No Prettier** — ESLint handles formatting rules
- **Subscriptions**: 3 tiers — `FREE`, `BASIC`, `PREMIUM`. Premium features gated via `requirePremium(userId)`

## Linting

ESLint 9 with flat config (`eslint.config.js` at root):
- `@typescript-eslint/no-unused-vars` — error, unused args/vars must be prefixed `_`
- `unused-imports/no-unused-imports` — error, auto-fixable
- Ignores: `node_modules/`, `dist/`, `.expo/`, `prisma/client/`

## Deployment

- **Backend**: Docker multi-stage build → GitHub Actions deploys to VPS via SCP + SSH
  - Triggered on push to `main` when `backend/**` or `packages/**` change
  - Health check at `GET /health`
  - Dockerfile: `backend/Dockerfile`, compose: `backend/docker-compose.yml`
- **Mobile**: EAS (Expo Application Services) for iOS/Android builds + App Store submission
- **Vercel**: `pnpm vercel-build` script available as alternative backend deployment

## Architecture Decisions

- **tRPC over REST**: full type safety from DB schema → Prisma → tRPC router → React hooks. No manual API types.
- **superjson**: handles Date, Map, Set serialization transparently across the wire.
- **httpBatchLink**: multiple concurrent tRPC calls are batched into a single HTTP request.
- **pgvector**: enables semantic search over connections/facts without external vector DB.
- **Atomic Design**: UI components organized by complexity level for consistency.
- **Domain-based query files**: business logic in `queries/<domain>/` keeps routers thin — routers only handle input validation and procedure wiring.

## AI agent rules
- never handle translations of locales. Just handle adding any english keys in the right json file.

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
