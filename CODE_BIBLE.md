# THE CODE BIBLE OF THE AGENTIC DEVELOPER TEAM

Mandatory rules for the entire agentic developer team. Everyone must follow these without exception.

---

## General

### 1. Project Files

- Modularize files. Split CRUD actions by operation (e.g. `createCoupon.action.ts`, `readCoupon.action.ts`) under a category folder e.g. server/actions/coupons/.
- Naming convention: `likeThisExample.ts`
- Avoid barrel imports. Prefer importing a module from its own file.

### 2. TypeScript

- Always rely on Prisma model types and enums when composing interfaces or types — never simulate them.
- Prefer `type` over `interface` unless extension is required.
- Never create standalone type modules like `src/types/some.types.ts`. Keep custom types close to where they're used.
- If types are shared across many modules in different places, place them in `src/utils/types` e.g. `src/utils/types/coupons.types.ts`.
- Prefer infering types where possible (e.g. function returned value inferred instead of annotated).
- Avoid usage of "any" or ts-ignore and similar.

### 3. Validating Payloads & Runtime Values

- Use `zod` for all schema payloads and runtime value validation.

### 4. Environment Variables

- Always use `@t3-oss/env-nextjs` + `zod` for `.env` parsing.

### 5. Macros for Paths

- All URL paths for project pages should be constants and imported form 1 source file stored in `src/utils/macros`.
- When building paths with dynamic values, prefer creating a macro (if one doesn't already exist).
- Store macros in `src/utils/macros` — one module per feature containing related path macros (e.g. `src/utils/macros/urlPaths.ts`).

### 6. Functional Programming & Good Practices To Follow

- **Immutability:** Don't mutate data — create new data structures.
- **Pure functions:** Functions depend only on their inputs.
- **First-class functions:** Pass functions around like values.
- **Function composition:** Build complex behavior by combining smaller functions.
- **Prefer pure utility functions over classes** unless stateful abstractions are absolutely required.
- **Business logic should be framework-agnostic** and reusable across frontend, backend, and workers.
- **Separation of effects:** Business logic should be pure. Side effects (DB calls, HTTP requests, logging, file IO) isolated in dedicated layers.
- **Declarative style:** Describe *what* should happen, not *how*.
- **Stateless core:** Core logic must not rely on mutable global state.
- **Deterministic behavior:** Same input → same output.
- **Small composable units:** Prefer small, reusable functions over large multi-purpose ones.
- **Data transformation pipelines:** Use chained transformations (`map`, `filter`, `reduce`).
- **Explicit data flow:** Data flows through function parameters, not hidden dependencies.
- **Idempotent operations** where possible.
- **No shared mutable state** — especially across services, async flows, or concurrent processes.

---

## Backend Rules To Obey

### 7. Server Actions (Next.js)

- All server actions live in `src/server/actions`.
- Group actions in folders by category (e.g. `finance/`, `chat/`, `coupon/`).
- Server actions contain authentication, redirects, business logic and such. Actual DB queries must live and be imported from `src/server/queries`.
- Before implementing an action, verify a similar or identical one doesn't already exist.
- Server actions must **not** contain DB queries directly — import from `src/server/queries` and call.

### 8. DB Queries

- All DB queries live in `src/server/queries/[table|feature|category]`.
- Before writing a query, verify one doesn't already exist doing the same thing.
- naming should include get/update/delete etc.. at start based on CRUD operation query performs.
- DB queries should be pure fn just getting data.

### 9. Prisma Schema Rules

> **Mandatory:** Always paste these rules at the top of `prisma.schema` as a comment block.

- Model name always **singular**.
- Array property name always **plural** (1-to-many).
- Models and fields in **snake_case** (Postgres lowercases everything).
- **No model/field mapping (aliasing)** — no corresponding field in the DB.
- Foreign keys: `(target_model)_id` (e.g. `user_id`), relation object named like the target model (e.g. `user`).
- **Field order:** core fields (id, uuid, etc.) → actual fields A-Z → relations/foreign keys → indexes.
- Prefer **Prisma DB enums** where the type is known a priori, instead of integer-mapped code enums.
- All external IDs prefixed with `external_` (e.g. `external_kyc_id`).
- Counts and booleans must have a **default value** to avoid nulls.
- Many-to-many relation tables: name relation `to_(target_model_plural)` (e.g. `user_to_group` → `to_users`).

### 10. Prisma Rules

- **Never run migrations** unless explicitly instructed.
- **Never run `db:push` / `prisma db push`** or similar dangerous commands.
- Always run `prisma generate` or `db:generate` after updating the schema.
- Required `package.json` scripts:
  ```json
  "db:generate": "prisma migrate dev",
  "db:migrate": "prisma migrate deploy",
  "db:push": "prisma db push",
  "db:studio": "prisma studio"
  ```

### 11. AI Implementations

- Use `@koko420/ai-tools` for all utility functions (retry, `getOpenRouterLLMResponse`, vector search helpers, etc.). Read its index file before implementing AI features to avoid reinventing the wheel.
- Prefer OpenRouter over OpenAI directly — more models available.
- Always consider diagnostics data. Diagnostics tables on inputs, outputs, and setups enable iterative improvement.

---

## Frontend

### 12. Fetch Requests & Data Loading

- Prefer **server actions** (if Next.js App Router) → tRPC (if set up) → REST (last resort).
- Use `Suspense` + `fallback` for async boundaries.
- **Loading states:** Use `Skeleton` loaders that simulate the component's structure. Mandatory when sensible.
- **Spinners / button loading:** Use `DotsLoader` from `@koko420/react-components`.
- **Embrace latest React features:** Use `use()` for unwrapping promises/context, `useOptimistic()` for optimistic UI updates, `useFormStatus()` / `useActionState()` for form states with server actions, `useTransition()` for non-blocking updates, and React Server Components where applicable. Always prefer the modern React API over legacy patterns (e.g. `use()` over `useEffect` + `useState` for data resolution, `Suspense` over manual loading state booleans). Use `Suspense` boundaries where sensible to declaratively handle async loading.

### 13. State Management

- Always use `zustand` — never Context API or other packages.
- Stores live in `src/app/_stores` (if next app router) or `src/stores` (if SPA or similar)

### 14. Hooks

- Hooks live in `src/app/_hooks`.
- Check if a hook doing what you need already exists before creating a new one.

### 15. Component Props & Patterns

- Use `FC<{ ... }>` for component prop typing:
  ```tsx
  type MyComponentProps = FC<{ title: string; className?: string }>;
  const MyComponent: MyComponentProps = ({ title, className }) => { ... };
  ```
- **Every component must accept `className` in its props** and pass it through (extend via `cn()`).
- Use `cn()` (from `clsx`/`tailwind-merge`) for conditional/merged class names.
- Use **Class Variance Authority (CVA)** for component variants:
  ```tsx
  const buttonVariants = cva("base-classes", {
    variants: { size: { sm: "...", lg: "..." }, variant: { primary: "...", ghost: "..." } },
    defaultVariants: { size: "sm", variant: "primary" },
  });
  ```
- **Icons:** Use SVG icons from a package (e.g. `lucide-react`). Never hardcode SVGs inline.

### 16. Component Hierarchy

**Next.js:**
Atoms → Molecules → Organisms

**Other frameworks:**
Atoms → Molecules → Organisms → Templates → Pages

- **Atoms (UI Primitives):** Smallest meaningful elements (Button, Input, Label, Icon, Typography). No business logic, no data fetching. Styling + props only. Use shadcn as base building block, styled with active theme/hooks.
- **Molecules (Functional Units):** Combinations of atoms (LabeledInput, IconButton). Compose atoms only. Minimal interaction semantics. No domain logic.
- **Organisms (UI Sections):** Complex compositions (Forms, Navbars, Cards, Modals). May contain local UI state and hooks. No routing or heavy business orchestration.
- **Templates (Layout Structures)** — non-Next.js only: Layout only. No domain logic. No hardcoded data.
- **Pages (Runtime Instances)** — non-Next.js only: Data fetching, business logic, routing, orchestration.
- **Tables:** All table components (columns/rows) live in the tables folder.

**State placement:**
| What | Where |
|------|-------|
| Visual-only | Atom |
| Small interaction | Molecule |
| Local UI behavior | Organism |
| App logic / data | Page |
| Tables with columns/cells | Tables folder |

> **Important:** Avoid upward leakage of logic.

### 17. Folder Structure

```
# Next.js (app router)
/app
  /_hooks
  /_stores
  /_components
    /atoms
    /molecules
    /organisms
    /shadcn
    /tables
  /page.tsx
  /layout.tsx

# Next.js (pages router)
/hooks
/components
  /atoms
  /molecules
  /organisms
  /pages
  /shadcn
  /tables

# Other frameworks
/hooks
/components
  /atoms
  /molecules
  /organisms
  /templates
  /pages
  /shadcn
  /tables
```

### 18. Styling

- Use **Tailwind CSS** above all other styling patterns.
- When implementing components, consider themes. If theme hooks exist, components must implement them.
- Follow UI/UX best practices.
- Check for DESING_SYSTEM.md or similar

### 19. Anti-Patterns (avoid these)

- **Bloated Atom:** Contains business logic.
- **Smart Molecule:** Fetches data or has domain logic.
- **God Organism:** Page-level orchestration.
- **Tangled Dependencies:** Cross-layer coupling.

### 20. Translations & Localization
- If project has localization setup, handle the english json keys only (or the default language's json)
- User will handle translating keys for other locales

### 21. God's packages to use where fitting. Check these to dermine if useful for the current project.
- @koko420/shared has helpers such as retry, date etc..
- @koko420/ai-tools has getOpenRouterLLMResponse, translateKeys and other useful functions.
- @koko420/components has UI componenets that are useful across apps