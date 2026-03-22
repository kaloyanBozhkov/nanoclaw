# Hive-Fam / EventWoo Platform

## Project
- Repo: https://github.com/kaloyanBozhkov/hive-fam
- Path: /workspace/extra/hive-fam
- Stack: Next.js (App Router), TypeScript, Prisma, Tailwind CSS, Stripe, Ably Chat
- Package manager: npm (package-lock.json)
- Testing: check package.json for test scripts

## Project Context
Multi-tenant event & ticketing SaaS platform built with Next.js App Router. Each organization gets its own domain (mapped in `src/server/config.ts`). The platform dashboard lives on `eventwoo.com` (and `localhost` in dev). Organizations manage events, sell tickets, create coupons, scan QR codes, handle payments via Stripe, and more.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) + Pages Router for API routes |
| Language | TypeScript 5.6, strict mode |
| Database | PostgreSQL via Prisma 5.21 |
| Styling | Tailwind CSS 3.4 + shadcn/ui + Radix primitives |
| State | Zustand (stores in `src/app/_stores/`) |
| Forms | React Hook Form + Zod validation |
| Data fetching | Server Actions (primary), tRPC (secondary), REST (last resort) |
| Payments | Stripe (webhooks at `/api/stripe/webhook`) |
| Email | Resend + React Email templates |
| Real-time | Ably (chat & notifications) |
| Storage | AWS S3 (`kems-bucket`) |
| Auth | JWT via jose — two separate auth systems (see below) |
| AI | OpenRouter via `@koko420/ai-tools` |
| Package manager | pnpm |

## Quick start

```bash
pnpm install          # also runs prisma generate via postinstall
pnpm dev              # start dev server
pnpm stripe:webhook   # forward Stripe webhooks locally (separate terminal)
pnpm db:studio        # open Prisma Studio
pnpm email:dev        # preview email templates
```

## Key scripts

| Script | Command | Notes |
|--------|---------|-------|
| `dev` | `next dev` | |
| `build` | `next build` | |
| `lint` | `eslint ./src` | Flat config (eslint.config.mjs) |
| `db:generate` | `prisma migrate dev` | Creates + applies migration |
| `db:migrate` | `prisma migrate deploy` | Applies pending migrations (prod) |
| `db:push` | `prisma db push` | **NEVER run this without explicit instruction** |
| `db:studio` | `prisma studio` | |

## Architecture overview

```
src/
  app/                          # Next.js App Router
    (platform)/                 # Platform routes (eventwoo.com)
      dashboard/                # Org dashboard (events, staff, coupons, etc.)
      auth/                     # Platform auth (magic links)
    api/                        # API routes (ably, github, health, qr, s3, stripe, trpc)
    staff/                      # Staff portal (legacy JWT auth)
    event/, order/, coupon/     # Public-facing pages
    _components/                # All UI components (atomic pattern)
      atoms/                    # Primitives — no logic
      molecules/                # Functional units — compose atoms only
      organisms/                # Complex UI sections — local state OK
      shadcn/                   # shadcn base components
      tables/                   # All data table components go here
      layouts/                  # Layout components
      templates/                # Template components
      emails/                   # React Email templates
    _hooks/                     # Custom React hooks
    _stores/                    # Zustand stores
  server/
    actions/                    # Server actions (grouped by category)
      platform/                 # Platform-specific actions (dashboard auth, orgs, staff)
      chat/, coupon.ts, stripe/ # Feature-specific actions
    queries/                    # DB queries (actions call these, not db directly)
      invoice/, tickets/, user/ # Query modules by domain
      platform/                 # Platform query modules
    auth/                       # Auth utilities (JWT, role gates)
    email/                      # Email sending service
    stripe/                     # Stripe client + helpers
    qr/                         # QR code generation
    s3/                         # S3 file operations
    ai/                         # AI features
    db.ts                       # Prisma client singleton
    config.ts                   # Domain config, ISR revalidation times
  utils/
    common.ts                   # capitalizeSentence, createUUID, moveItemInArray, isValidURL
    date.ts                     # formatDateToTimezone, UTCToLocalDate, getDisplayDateFormatter, formatDate
    frontEnd.ts                 # handleVideoVisibility, forceDownload (browser-only)
    network.ts                  # fetchPostJSON, fetchDeleteJSON, encodeGetParams, fetchFileFromUrlFE
    pricing.ts                  # Pricing calculations
    qr.ts                       # QR code display utilities
    specific.ts                 # Feature-specific utils
    utils.ts                    # cn() (tailwind-merge), isEmptyRender
    types/                      # Shared type modules
      coupon.types.ts           # Coupon feature types
      types.common.ts           # Common shared types (EventTicketType)
    macros/                     # Path/URL builder functions
      common.ts                 # getBaseUrl()
      tickets.ts                # formatTicketSignedUrls, getTicketShareUrl
    stripe/                     # Stripe client-side helpers
    s3/                         # S3 service class
  trpc/                         # tRPC client (react.tsx) and server (server.ts) setup
  pages/api/                    # Legacy API routes (Stripe checkout sessions)
```

## Two auth systems

This project has **two separate authentication systems**. Understanding which one applies is critical.

### 1. Staff auth (legacy)
- JWT stored in cookie `hive-fam-jwt`
- Used by `/staff/*` routes and `src/server/actions/coupon.ts`, etc.
- Auth check: `getJWTUser()` from `src/server/auth/getJWTUser.ts`
- Role gates: `isManagerOrAbove()`, `isAdminOrAbove()` from `src/server/auth/roleGates.ts`
- Roles: Prisma `Role` enum — `KOKO`, `ADMIN`, `EVENT_MANAGER`, `TICKET_SCANNER`

### 2. Platform auth (dashboard)
- JWT stored in cookie `platform-auth-token`
- Magic link login flow (email → verify → JWT)
- Used by `/dashboard/*` routes
- Auth check: `getPlatformUser()` + `getDashboardUser(orgId)` from `src/server/actions/platform/`
- Roles: `DashboardUserRole` = `"OWNER" | Role` — includes org ownership
- Permission groups: `ADMIN_PLUS`, `MANAGER_PLUS`, `ALL_ROLES` from `src/server/actions/platform/rolePermissions.ts`

**Important:** `getDashboardUser()` supports BOTH auth systems — it checks platform auth first, then falls back to staff JWT. When writing dashboard server actions, always use `getDashboardUser()`, never `getJWTUser()` directly, or platform-only users will get redirected to `/staff/login`.

## Environment variables

Defined via `@t3-oss/env-nextjs` + Zod in `src/env.js`. Required vars include:
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET`, `TMP_ORG_ID`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_BUCKET_NAME`
- `RESEND_API_KEY`, `ABLY_API_KEY`, `OPENROUTER_API_KEY`

See `src/env.js` for full schema with optional vars (Apple Wallet, Google Wallet, etc.).

## Path alias

`@/*` maps to `./src/*` (tsconfig.json)

## Rules and conventions

### File naming
- `likeThisExample.ts` (camelCase)
- Components: `ComponentName.atom.tsx`, `ComponentName.molecule.tsx`, `ComponentName.organism.tsx`
- Tables: `TableName.table.tsx`

### Server actions & queries
- Actions live in `src/server/actions/`, grouped by feature folder
- Actions should NOT contain raw DB queries — import from `src/server/queries/` instead
- Queries live in `src/server/queries/`, one file per operation or folder per domain
- CRUD operations for a category should be split into separate files with an index export
- Always check if an existing action/query does what you need before creating a new one

### Dashboard server actions
- Dashboard-specific actions go in page-level `_actions.ts` files (e.g., `src/app/(platform)/dashboard/.../coupons/_actions.ts`)
- These use `getDashboardUser()` for auth, NOT `isManagerOrAbove()`
- Use `.bind(null, orgId)` to create serializable server actions for client components
- Never pass plain arrow functions as props from server to client components

### Frontend components (Atomic pattern)
- **Atoms:** No business logic, no data fetching. Styling + props only.
- **Molecules:** Compose atoms. No domain logic.
- **Organisms:** May have local UI state. No routing or heavy business logic.
- **Tables:** All `<DataTable>` column/cell definitions go in `src/app/_components/tables/`
- **shadcn** as base building block for new atoms/molecules
- **Anti-patterns to avoid:** Bloated atoms with business logic, smart molecules fetching data, god organisms doing page-level orchestration

### State management
- Zustand only (never React Context for state)
- Stores in `src/app/_stores/`

### TypeScript
- Use Prisma model types and enums — don't simulate them
- Prefer `type` over `interface`
- Keep types close to where they're used
- Shared types go in `src/utils/types/[feature].types.ts`

### Prisma schema
- Models: singular, snake_case
- Fields: snake_case
- Foreign keys: `{target_model}_id`
- Field order: core fields (id) → actual fields (A-Z) → relations → indexes
- Booleans and counts must have defaults
- External IDs: prefix with `external_`
- Many-to-many relations: `to_{target_plural}`
- **Never run migrations without explicit instruction**
- **Never run `db:push`**
- Always run `prisma generate` after schema changes

### Data fetching (client)
- Prefer server actions > tRPC > REST
- Use `<Suspense>` + fallback with skeleton loaders
- Use `DotsLoader` from `@koko420/react-components` for spinners
- Use React `use()` hook where sensible

### Validation
- Zod for all schema validation, payloads, runtime values

### Path macros
- Dynamic path builders go in `src/utils/macros/`
- One module per feature

### Styling
- Tailwind CSS exclusively
- Respect theme hooks when they exist

### AI features
- Use `@koko420/ai-tools` (retry, getOpenRouterLLMResponse, vector search helpers)
- Prefer OpenRouter over direct OpenAI
- Include diagnostics tables for iterative improvement

### Functional programming
- Pure functions, immutability, explicit data flow
- Isolate side effects (DB, HTTP, IO) in dedicated layers
- Small composable units over large multi-purpose functions
- No shared mutable state

## AI agent rules
- never handle translations of locales. Just handle adding any english keys in the right json file.

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
