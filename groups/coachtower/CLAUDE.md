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
