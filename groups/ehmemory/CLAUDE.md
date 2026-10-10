# EH Memory

## Project

- Repo: ~/Documents/eh/eh-memory
- Path: /workspace/extra/eh-memory
- Stack: Next.js (App Router) + Prisma + TypeScript
- Package manager: pnpm
- Description: Memory/knowledge management app

## Structure

```
eh-memory/
├── src/
│   ├── app/              # Next.js App Router pages & layouts
│   ├── ai/               # AI features
│   ├── components/       # UI components
│   ├── env.ts            # Environment config (@t3-oss/env-nextjs)
│   ├── lib/              # Shared libraries
│   ├── mcp/              # MCP server
│   ├── middleware.ts      # Next.js middleware
│   ├── providers/        # React providers
│   ├── queries/          # DB queries
│   ├── server-actions/   # Next.js server actions
│   └── types/            # TypeScript types
├── prisma/               # Prisma schema & migrations
├── public/               # Static assets
└── package.json
```

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js (App Router) |
| ORM | Prisma |
| Auth | @auth/prisma-adapter |
| Storage | AWS S3 |
| AI | @koko420/ai-tools |
| UI | @koko420/react-components, CVA, Lucide icons |
| Validation | Zod, @t3-oss/env-nextjs |
| Email | @react-email/components |

## Common Commands

```bash
pnpm install        # Install dependencies
pnpm dev            # Dev server
pnpm build          # Production build
pnpm lint           # ESLint
pnpm db:generate    # Generate Prisma client
pnpm db:push        # Push schema to DB
pnpm db:migrate     # Run migrations
pnpm db:studio      # Prisma Studio GUI
```

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
