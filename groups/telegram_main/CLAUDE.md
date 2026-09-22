# Main (Koko)

This is the **admin group** for NanoClaw itself, not a product project. Unlike
the other groups, it does not get `groups/global/CLAUDE.md` in its system
prompt — that file is ~19K tokens and main runs constantly. See Consumables
below for how to pull it in when you need it.

## Where things are

| Path | What |
|---|---|
| `/workspace/project` | The NanoClaw repo, **read-only**. Host code — `src/`, `container/`, `docs/`. `.env` is shadowed. |
| `/workspace/group` | This group's folder, writable. Scratch, screenshots, notes, side projects. Your working directory. |
| `/workspace/blueprints` | Shared reusable blueprints, writable. |
| `/workspace/rules` | Shared rules (`CODE_BIBLE.md`), read-only. |

Changing NanoClaw's own code means editing on the host — the mount is read-only
by design so an agent can't rewrite the host application it runs inside.

## Consumables

Reference documents are **not** loaded here by default. Send `/consume` (or
`/consumables`, or `/consumed`) to see the menu with what's already loaded.

| Name | What it gives you |
|---|---|
| `agents` | The full agent roster and dev pipeline — 🦉 Triage Lead, 🎨 UI/UX Designer, 🦫 Full-Stack Engineer, review loops, 📐 Claude Design Briefer, Blueprint Extractor, E2E QA, GitHub PM. Includes the Code Bible. |
| `bible` | Coding standards and review rules on their own. |

**Ask for one when the task needs it — don't improvise around a missing doc.**
Specifically:

- A `claude.ai/design/p/...` link that will inform code, specs, or issues →
  say *"run `/consume agents` and I'll use the 📐 Claude Design Briefer"*.
  The Briefer reads designs through `mcp__design__*`. Never drive a browser or
  scrape cookies at a `claude.ai/design` URL — that route hits Cloudflare and
  fails, and it is explicitly forbidden.
- A multi-stage build that wants the review pipeline → `/consume agents`.
- A code-quality or review question → `/consume bible`.

If you find yourself inventing a process that sounds like it should already
exist, it probably does — ask for `agents` rather than guessing.

## When `mcp__design__*` is missing

It is **not** uninstalled. The design MCP server is wired into every container
by the agent-runner whenever `ANTHROPIC_BASE_URL` is set — it is not read from
the host's `~/.claude.json`, so grepping there proves nothing. An absent tool
means the server **failed to connect and was silently dropped**.

Do not conclude "the tool doesn't exist in your setup", and do not fall back to
agent-browser, Chrome profiles, or cookie scraping on a `claude.ai/design` URL.
Run the probe and report the actual error:

```
curl -s -X POST "$ANTHROPIC_BASE_URL/v1/design/mcp" \
  -H "Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

| Response | What it means | What to tell the owner |
|---|---|---|
| `needs_design_scopes` | The OAuth token predates design access. Consent at claude.ai/design/settings is **not** enough, and re-signing-in won't fix it. | Run `/design-login` in Claude Code, re-mint with `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, restart nanoclaw. |
| `needs_consent` | Account hasn't granted design access. | Enable it at claude.ai/design/settings. |
| `HTTP 200` | Access is fine — the failure is something else. Report the real symptom, don't guess. | — |

The host also probes this at startup; `Claude Design UNAVAILABLE` in the log
means the same thing.

## Message formatting

NEVER use markdown. Telegram formatting only:

- `*single asterisks*` for bold — **never** double asterisks
- `_underscores_` for italic
- `•` for bullets
- ` ```triple backticks``` ` for code

No `##` headings. No `[links](url)`.

## Memory

`conversations/` holds searchable history of past sessions. At the start of a
new conversation, check for `/workspace/group/session-context.md` — if it
exists, read it to restore context, then delete it.
