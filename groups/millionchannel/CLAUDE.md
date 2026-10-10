# Million Channel

## Project

- Repo: https://github.com/kaloyanBozhkov/milliondollarchannel (private)
- Path: /workspace/extra/milliondollarytchannel
- Stack: Next.js 15 (App Router) + Prisma (Postgres) + Tailwind v4, deployed on Vercel
- Package manager: pnpm
- Default branch: main

## Project Context

million$channel (MDC) — a platform built around YouTube videos: owners claim, upload and list videos, buy/sell seconds on a market, and watch a feed. Integrations: NextAuth v4 magic-link auth (Resend), Stripe Checkout + webhook, S3 presigned uploads, AWS MediaConvert / Rekognition / Lambda (YouTube upload), YouTube API.

## Read these before building UI or pages

- `README.md` — setup, folder structure (Code Bible §17), env
- `BUILD_CONTEXT.md` — the contract for wiring pages + organisms: golden rules, existing atoms / molecules / queries / actions. **Don't rebuild what exists — import it.**
- `DESIGN_SYSTEM.md` — visual tokens
- `ORGANISMS.md` — per-page organism map
- `designs/*.dc.html` — Claude Design exports per screen (Feed, Watch, Market, Claim, Upload, Account, Onboarding, …)

## Layout

```
src/
  app/
    (site)/ (auth)/ dashboard/ checkout/ ui-library/
    _components/{atoms,molecules,organisms,shadcn}
    _stores/  api/
  server/
    auth/ queries/ actions/ email/ s3/ stripe/
    youtube/ lambda/ mediaconvert/ rekognition/ monitoring/
    db.ts
  pages/api/stripe/        # checkout_sessions + webhook (raw body)
  utils/{macros,stripe,youtube,market,grid,types}/
prisma/{schema.prisma,migrations/,seed.ts}
lambda/youtube-upload/     # separate package (AWS Lambda)
```

## Scripts

- `pnpm dev` / `pnpm build` (`prisma generate && next build`) / `pnpm typecheck` / `pnpm lint`
- `pnpm generate` — `prisma generate` (safe; use this when the client is stale)
- ⚠️ `pnpm db:generate` is **`prisma migrate dev`**, not generate — it changes the database. Owner-run only; never run it unless the owner asks.
- `pnpm db:migrate` (deploy), `pnpm db:push`, `pnpm seed` — also owner-only.

## Conventions (from BUILD_CONTEXT.md)

- Pages are Server Components; any page reading the DB is `export const dynamic = "force-dynamic"` with `<Suspense>` + skeletons.
- Interactive organisms are `"use client"`, receive data as props, call server actions returning `ActionResult`.
- Prisma models are snake_case, singular. No `any`, no barrel files, `cn()` for classNames, paths via `@/utils/macros/urlPaths`.
