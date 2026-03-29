# Beauty Bot

## Project

- Repo: ~/Documents/koko/beauty-bot (local)
- Path: /workspace/extra/beauty-bot
- Stack: Node.js + TypeScript + WhatsApp (Baileys) + Google APIs
- Package manager: pnpm
- Description: WhatsApp appointment bot for an Italian beauty center

## Structure

```
beauty-bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── env.ts                # Environment config
│   ├── agents/               # AI agent definitions
│   │   ├── orchestrator/     # Main routing agent
│   │   ├── booking/          # Appointment booking
│   │   ├── faq/              # FAQ handling
│   │   ├── escalation/       # Human escalation
│   │   └── reminders/        # Appointment reminders
│   ├── tools/                # Agent tools
│   │   ├── calendar/         # Google Calendar integration
│   │   ├── conversation/     # Conversation management
│   │   ├── readMarkdown.ts
│   │   ├── shouldIgnoreContact.ts
│   │   └── transcribeAudio.ts
│   └── utils/
│       ├── constants/
│       ├── macros/
│       └── types/
├── auth/                     # WhatsApp auth credentials
├── data/                     # Runtime data
├── memory/                   # Bot memory/context
└── package.json
```

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js, TypeScript, tsx (dev) |
| Messaging | Baileys (WhatsApp Web API) |
| AI | @koko420/ai-tools (OpenRouter) |
| Calendar | Google APIs (googleapis) |
| Validation | Zod |
| Logging | Pino |

## Common Commands

```bash
pnpm install       # Install dependencies
pnpm dev           # Run with hot reload (tsx watch)
pnpm build         # Compile TypeScript
pnpm start         # Run production build
```

## Blueprints

Reusable blueprints are at `/workspace/blueprints/` (read-only).
