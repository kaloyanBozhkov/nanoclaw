# Coachtower

Next.js app with Prisma (PostgreSQL), React 19, Tailwind CSS, and Zustand.

## Project Location

The project is mounted at `/workspace/extra/coachtower`.

GitHub: https://github.com/kaloyanBozhkov/coachtower

## Stack

- **Framework:** Next.js 16 (App Router, `src/app/`)
- **Language:** TypeScript
- **Database:** PostgreSQL via Prisma (`prisma/`)
- **Styling:** Tailwind CSS + CVA + tailwind-merge
- **State:** Zustand
- **Forms:** react-hook-form + zod
- **Icons:** lucide-react
- **Font:** Geist

## Commands

```bash
cd /workspace/extra/coachtower
pnpm dev          # Dev server
pnpm build        # Production build
pnpm lint         # ESLint
pnpm db:generate  # Prisma migrate dev
pnpm db:push      # Push schema to DB
pnpm db:studio    # Prisma Studio
```

## Design

Design file: `/workspace/extra/coachtower/design.pen`

IMPORTANT: Pencil MCP runs on the host machine, NOT inside this container.
When calling Pencil MCP tools, use the HOST path, not the container path:

Use Pencil MCP tools (`mcp__pencil__*`) to read it:
1. `open_document("/Users/kaloyanbozhkov/Documents/koko/coachtower/design.pen")` — NOTE: must use host path
2. `batch_get` to inspect components, layout, tokens
3. `get_variables` for design tokens
4. `get_screenshot` to validate visually

## Active work (read on every new session)
Redesign COMPLETE 2026-11-17 13:15 — merged to main, prod schema synced, deployed. See /workspace/group/redesign/CHECKPOINT.md "REDESIGN COMPLETE" for leftovers. Self check-in task paused.
Round 2 (Notion feedback from Program Builder down + live multi-athlete hub + 1RM/RPE) 2026-11-20 → PR #464 MERGED 2026-11-20 (c29c2fbd4); prod db push DONE; equipment backfill applied (105); #465 e2e fix merged; prod deployed 6dd5823bd 2026-11-20. E2E 300/0.
NEXT: per-set RPE load in live logger (coach+athlete) — spec design-briefs/live-set-rpe-load-ui.md §10 (v3, owner approved 2026-11-20: persist target RPE/%/1RM, felt-RPE prompt every set, whole numbers). PR #466 MERGED 2026-11-21 (fd2f61b66), prod db push DONE, deployed. E2E 312/0 incl. 12 new-flow tests → PR #467 MERGED 2026-11-21 (9ef803627, tests only, no redeploy needed). Round 2 + RPE load SETTLED. Follow-ups PR #468 MERGED + deployed 2026-11-21 (e778aeff2); RPE designs written to Claude Design 2026-11-21 (6 files, backups _base/2026-11-21/). E2E 314/0. DoR: design-briefs/final-mvp-iteration-round2-dor.md. Also includes live trainee switcher (A dock + C board drawer + B NEXT hint; spec design-briefs/live-trainee-switcher-ui.md), pushed to #464, tested PASS. Claude Design project f7fe228b synced to round 2 on 2026-11-20 (18 files; backups in design-edits/<id>/_base/2026-11-20/).
