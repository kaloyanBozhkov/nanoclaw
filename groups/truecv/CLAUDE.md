# TrueCV

## Project

- Stack: Next.js (App Router), TypeScript, Prisma, Tailwind CSS
- Package manager: bun (with pnpm-lock.yaml present — use bun)
- Testing: Vitest

## Project Context
- Repo: https://github.com/kaloyanBozhkov/cv
- Path: /workspace/extra/cv

Full-stack CV (resume) builder at **cv.kaloyanbozhkov.com**. Users sign in via passwordless magic-link email, create and manage multiple CVs, and export them as PDFs. The author's own portfolio is served as a static showcase at `/portfolio`.

Tech stack: **Next.js (Pages Router) · TypeScript · Prisma + PostgreSQL · NextAuth.js · Zustand · TailwindCSS · @react-pdf/renderer · Three.js**

---

## Scripts

```bash
bun dev            # Start dev server
bun build          # Production build
bun start          # Start production server
bun lint           # ESLint (zero warnings enforced)
bun test           # Vitest (watch mode)
bun test:run       # Vitest (single run)
bun test:coverage  # Vitest with coverage report
bun db:generate    # prisma migrate dev (create + apply migration)
bun db:migrate     # prisma migrate deploy (apply existing migrations)
bun db:push        # prisma db push (no migration file, use for prototyping)
bun db:studio      # Open Prisma Studio GUI
```

---

## App Sections

### Public
| Route | Description |
|-------|-------------|
| `/` | Landing page — feature highlights, language selector |
| `/login` | Magic-link email auth. Dev mode exposes quick-login credentials |
| `/login/verify` | Confirmation screen shown after magic link is sent |
| `/verify-email` | Prompt for users who haven't confirmed their email yet |
| `/portfolio` | Author's personal CV showcase (static, no auth) |
| `/pdf` | PDF viewer page (uses `@react-pdf/renderer`) |
| `/three` | Standalone 3D profile viewer |

### Protected (requires auth + verified email)
| Route | Description |
|-------|-------------|
| `/dashboard` | List all CVs, create new, delete existing |
| `/profile` | Edit user profile settings |
| `/cv/[cvId]/edit` | Tabbed CV editor: Personal Info · Experience · Education · Skills |
| `/cv/[cvId]/view` | Read-only CV preview |

### API Routes (`src/pages/api/`)
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/cv` | GET, POST | List / create CVs |
| `/api/cv/[cvId]` | GET, PUT, DELETE | Fetch / update / delete a CV |
| `/api/auth/[...nextauth]` | POST | NextAuth magic-link handlers |
| `/api/auth/resend-verification` | POST | Resend email verification token |
| `/api/auth/verify-email` | POST | Consume email verification token |
| `/api/user/profile` | GET | Fetch current user's profile |

---

## Architecture

### Atomic Design Components (`src/components/`)
- **atoms/** — primitive UI: `FormInput`, `CVCard`, `SkillTag`, `DotsLoader`, `CuteLink`
- **molecules/** — composed: `CVList`, `PersonalInfoForm`, `ExperienceSection`, `Person`, `WorkPlace`
- **organisms/** — feature-level: `CVDashboard`, `CVPreview`, `Profile3D`
- **templates/** — layout shells: `PageTemplate`, `Center.layout`, `Stack.layout`
- **dynamic/** — heavy components loaded via dynamic import (e.g. `Profile3D` with Three.js)

### Server Layer (`src/server/`)
- **queries/cv/** — read operations (`getCvById`, `getCvsByUserId`)
- **actions/cv/** — write operations (`createCv`, `updateCv`, `deleteCv`)
- All inputs validated with **Zod** schemas before touching Prisma
- API routes guard with `getServerSession()` — consistent `{ success, data?, error? }` response shape

### State Management (`src/store/`)
- **`cvEditor.store.ts`** — Zustand + Immer + Persist. Holds CV form state, dirty flag, auto-save status. Persists draft to `localStorage` under key `cv-editor-draft`
- **`luffy.store.ts`** — minimal state for the 3D model animation

### Auto-Save (`src/hooks/useAutoSave.ts`)
Watches the Zustand dirty flag, debounces 1 s, syncs to server. Cancels in-flight requests when a new save is triggered.

### Auth (`src/lib/auth.ts`)
NextAuth with a custom memory adapter. Email magic links delivered via **Resend**. Dev mode adds a credentials provider for quick login without email.

### Route Protection (`src/middleware.ts`)
- Unauthenticated → redirect `/login`
- Authenticated but unverified → redirect `/verify-email`
- Covers `/dashboard`, `/profile`, `/cv/**`

### PDF (`src/pages/pdf.tsx` + `@react-pdf/renderer`)
`MyCVDocument` is a static component using the author's hardcoded constants. It renders inside `PDFDownloadLink` on the CV view page and in the `/pdf` route.
**Important:** only `View`, `Text`, `Link`, `Image` from `@react-pdf/renderer` are valid inside a PDF document — no native HTML elements.

---

## Database (Prisma + PostgreSQL)

Schema uses **snake_case** throughout. All mutable records support **soft deletes** via `deleted_at`. Always filter `deleted_at: null` in queries; use `findFirst` (not `findUnique`) when combining a unique field with non-unique filters like `deleted_at`.

### Key Models
| Model | Notes |
|-------|-------|
| `User` | Email-based, soft-deletable, has `locale` and `email_verified` |
| `CV` | Belongs to User; `[user_id, slug]` unique; `is_published` draft/publish flag |
| `PersonalInfo` | 1:1 with CV |
| `Experience` | 1:many with CV; `display_order`, `is_current` |
| `Education` | 1:many with CV; `display_order` |
| `Skill` | 1:many with CV; `category` + `proficiency` enums; `display_order` |

---

## Testing

Tests live in `src/__tests__/` mirroring the source tree. Uses **Vitest** + **React Testing Library** + **jsdom**. No database mocking — Zod schema tests validate against real schemas.

---

## i18n

Supported locales: `en`, `bg`, `de`, `fr`, `es`, `it`. Configured via **i18next**; locale auto-detected from the router; falls back to `en`. Locale JSON files live in `public/locales/`. 

## AI agent rules
- never handle translations of locales. Just handle adding any english keys in the right json file.

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
