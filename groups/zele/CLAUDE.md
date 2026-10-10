# Sayzele (zele)

## Project

- Repo: https://github.com/kaloyanBozhkov/sayzele
- Path: /workspace/extra/sayzele
- Stack: Next.js, TypeScript, Prisma, Tailwind CSS, Stripe
- Package manager: pnpm
## Project Context

Sayzele is a multi-language event management SaaS. Event organizers create events, generate QR codes, and manage media galleries/timelines. Guests scan QR codes to upload photos/videos, comment, and like content.

Three main flows:
- **Admin/Owner** — Dashboard at `/dashboard/events` for event CRUD, QR branding, gallery management, timeline customization, tent card design, shared gallery links
- **Guest** — Scan QR → upload media at `/upload/[code]`, view gallery at `/event/[code]`, view shared gallery at `/shared/[token]`, view timeline at `/timeline/[token]`
- **Landing page** — SEO + product info with sign-up/sign-in CTAs

## Tech stack

| Layer | Tech |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5.7 |
| Styling | Tailwind CSS v4, tailwind-merge |
| State | Zustand 5 (event-form, timeline-form stores) |
| Database | PostgreSQL 15 via Prisma 6 |
| Auth | NextAuth v4 (JWT strategy) — Google OAuth + email magic links |
| Storage | S3 (AWS prod, MinIO local) |
| Payments | Stripe |
| Email | Resend + React Email templates |
| i18n | i18next (23 languages) |
| Validation | Zod + @t3-oss/env-core |
| IDs | CUID2 |
| Package manager | pnpm |

## Quick start

```bash
make setup    # copies .env.example → .env, starts Docker (Postgres + MinIO), pushes schema, creates bucket
make up       # start services (app at :3000, MinIO console at :9001)
make down     # stop services
```

For local dev without Docker: `pnpm install && pnpm dev` (requires Postgres and MinIO running separately).

Dev login: use any email with the Dev Login credentials provider (dev only). Magic links are logged to the console.

## Key commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm db:generate` | `prisma migrate dev` |
| `pnpm db:push` | Push schema (no migration) |
| `pnpm db:studio` | Prisma Studio GUI |
| `pnpm email:dev` | React Email dev server |
| `pnpm stripe:webhook` | Stripe CLI webhook listener |
| `pnpm translate` | GPT-powered translation for missing i18n keys |
| `make db-shell` | psql into local Postgres |
| `make db-studio` | Prisma Studio in Docker at :5555 |
| `make clean` | Remove containers, volumes, build cache |

## Project structure

```
src/
├── app/
│   ├── [lng]/                  # i18n dynamic segment
│   │   ├── (auth)/             # login, join, verify
│   │   ├── (dashboard)/        # owner dashboard
│   │   └── (guest)/            # guest flows (event, upload, shared, timeline)
│   ├── api/                    # API routes (auth, content, events, upload, stripe, etc.)
│   ├── globals.css             # Tailwind v4 @theme (typography, spacing, radius tokens)
│   └── layout.tsx              # Root layout
├── components/
│   ├── atoms/                  # Pure UI building blocks (button, card, input, etc.)
│   ├── molecules/              # Composed atoms with UI state (nav-bar, modal, media-grid-card)
│   ├── organisms/              # Feature-complete sections, can fetch data (event-form, gallery-tab)
│   └── emails/                 # React Email templates
├── lib/
│   ├── auth.ts                 # NextAuth config
│   ├── db.ts                   # Prisma client singleton
│   ├── s3.ts                   # S3/MinIO client
│   ├── stripe.ts               # Stripe client
│   ├── resend.ts               # Email client
│   ├── i18n/                   # i18next setup (server + client)
│   ├── queries/                # Server data fetching functions
│   ├── stores/                 # Zustand stores
│   ├── utils/                  # Helper functions (cn, formatDate, download, etc.)
│   ├── types/                  # TypeScript types
│   ├── qr/                     # QR code generation
│   └── tent-card/              # Tent card templates
├── providers/                  # React context (i18n, session)
├── schemas/                    # Zod validation schemas (event, content)
├── env.ts                      # Type-safe env validation (@t3-oss/env-core)
└── fonts/                      # Custom fonts
prisma/
├── schema.prisma               # Database schema
└── migrations/                 # Migration history
```

## Component rules (atomic design)

- **atoms/** — Smallest UI units (button, card, input). No data fetching. No business logic.
- **molecules/** — Composed from atoms. UI-related state only. No data fetching.
- **organisms/** — Feature-complete. Can include data fetching and business logic.
- **emails/** — React Email templates for transactional emails.

The `Card` atom has **no default padding** — consumers must specify their own (`p-6` standard, `p-3` compact).

## Prisma schema conventions

All rules are documented at the top of `prisma/schema.prisma`:
- Model names: singular, snake_case
- Array properties: plural
- Foreign keys: `{target_model}_id` (e.g. `user_id`), relation object named like target model
- Field order: core (id, timestamps) → domain fields A-Z → relations → indexes
- Prefer DB enums over integer codes
- External IDs prefixed `external_`
- Counts and booleans always have defaults

## i18n

- Translation files live in `src/lib/i18n/`
- 23 languages supported
- **Only add English keys** when adding new text. Run `pnpm translate` to auto-translate remaining languages via GPT.
- Use `t('key')` from `react-i18next` on the client, server translation helpers for SSR.
- Only worry about the english keys in en.json
- User will translate keys for the other locales

## Tailwind v4 gotchas

Read `DESIGN-SYSTEM.md` for the full guide. Critical rules:

1. **Use numeric spacing** (`p-4`, `gap-6`, `py-20`) — never named sizes (`p-lg`, `gap-xl`). Named `--spacing-*` tokens collide with Tailwind v4's width scale.
2. **Font size tokens are safe** — `text-sm`, `text-2xl`, etc. work fine via `--font-size-*`.
3. **Never define `--container-*` in `@theme`** — `container` is reserved for container queries and causes webpack crashes.
4. **Container pattern**: `max-w-7xl mx-auto px-section-x md:px-section-x-lg`
5. Custom radius tokens: `rounded-card` (1.5rem), `rounded-button` (2rem), `rounded-input` (0.75rem)

## Environment variables
Defined and validated in `src/env.ts`.
Most have safe defaults for local dev. See `.env.example` for the full list.

## Path alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

## Auth flow

- **Dev**: Credentials provider (any email, no password) or email magic link (logged to console)
- **Prod**: Google OAuth or email magic link via Resend
- JWT session strategy (no DB session storage)
- Custom auth pages: `/login`, `/login/verify`, `/login/error`

## Docker services

| Service | Container | Port |
|---|---|---|
| App | zele-app | 3000 |
| Postgres | zele-postgres | 6432 → 5432 |
| MinIO (S3) | zele-minio | 9000 (API), 9001 (console) |

MinIO console credentials: `minioadmin` / `minioadmin`

## No test framework

There is currently no automated test setup (no Jest, Vitest, Playwright, etc.).

## AI agent rules
- never handle translations of locales. Just handle adding any english keys in the right json file.

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
