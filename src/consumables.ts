/**
 * Consumables — reference documents the main chat pulls into the agent's
 * context on demand, rather than carrying them in every container's system
 * prompt.
 *
 * Non-main groups get `groups/global/CLAUDE.md` (the agent roster + dev
 * pipeline, which inlines `@CODE_BIBLE.md`) appended to their system prompt
 * automatically — see the `!isMain` gate in the agent-runner. Main
 * deliberately does not: at ~19K tokens it would land on every run, and main
 * runs constantly. So main asks for what it needs, when it needs it.
 *
 * The registry is a directory scan, not a hardcoded list: dropping a new `.md`
 * into `rules/` registers it with no code change.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, RULES_DIR, TIMEZONE } from './config.js';
import { getRouterState, setRouterState } from './db.js';
import { formatBytes } from './session-reset.js';

const ROUTER_STATE_KEY = 'consumed_docs';

/** Directories scanned for consumable markdown, in menu order. */
function sourceDirs(): string[] {
  return [RULES_DIR, path.join(GROUPS_DIR, 'global')];
}

/**
 * Presentation for files we know about, keyed by `<dirname>/<filename>`.
 * Anything else still registers with a slug derived from its filename — the
 * scan is the source of truth, this only makes the menu readable.
 */
const KNOWN: Record<string, { slug: string; label: string; blurb: string }> = {
  'rules/CODE_BIBLE.md': {
    slug: 'bible',
    label: 'Code Bible',
    blurb: 'Coding standards and review rules',
  },
  'global/CLAUDE.md': {
    slug: 'agents',
    label: 'Agent roster + dev pipeline',
    blurb: '🦉 Triage · 🦫 Full-Stack · 📐 Design Briefer · review loops',
  },
};

export interface Consumable {
  slug: string;
  label: string;
  blurb?: string;
  /** Absolute path on disk. */
  filePath: string;
  /** Path shown to the user, relative to the project root. */
  relPath: string;
  bytes: number;
}

export interface ConsumedItem {
  slug: string;
  label: string;
  /** Size of the resolved text actually injected, after `@import` inlining. */
  bytes: number;
  at: string;
}

interface ConsumedState {
  [groupFolder: string]: { sessionId: string; items: ConsumedItem[] };
}

/** `CODE_BIBLE.md` -> `code-bible`. Only used for files not in KNOWN. */
function deriveSlug(fileName: string): string {
  return fileName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Every consumable currently on disk, in menu order. */
export function listConsumables(): Consumable[] {
  const out: Consumable[] = [];
  const taken = new Set<string>();

  for (const dir of sourceDirs()) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch {
      continue; // Directory missing — nothing to offer from it.
    }
    files.sort();

    for (const file of files) {
      const filePath = path.join(dir, file);
      let bytes: number;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        bytes = stat.size;
      } catch {
        continue;
      }

      const dirName = path.basename(dir);
      const known = KNOWN[`${dirName}/${file}`];
      let slug = known?.slug ?? deriveSlug(file);
      if (taken.has(slug)) slug = `${dirName}-${slug}`;
      if (taken.has(slug)) continue; // Still colliding — skip rather than shadow.
      taken.add(slug);

      out.push({
        slug,
        label: known?.label ?? file.replace(/\.md$/i, ''),
        blurb: known?.blurb,
        filePath,
        relPath: `${dirName}/${file}`,
        bytes,
      });
    }
  }

  return out;
}

/**
 * Resolve a user-typed name: exact slug, then unique case-insensitive prefix,
 * then filename. Returns undefined when nothing matches or a prefix is
 * ambiguous — the caller shows the menu either way.
 */
export function resolveConsumable(query: string): Consumable | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const items = listConsumables();

  const exact = items.find((c) => c.slug === q);
  if (exact) return exact;

  const byFile = items.find(
    (c) => path.basename(c.filePath).toLowerCase() === q,
  );
  if (byFile) return byFile;

  const prefixed = items.filter((c) => c.slug.startsWith(q));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Inline `@<file>.md` import markers against `rules/`, mirroring the
 * agent-runner's resolveRuleImports so a consumed document reads exactly as it
 * would in a non-main group's system prompt. Single-level only; unresolvable
 * tokens (package names like `@scope/pkg`) are left untouched.
 */
function resolveRuleImports(text: string): string {
  return text.replace(/@([A-Za-z0-9_\-./]+\.md)\b/g, (match, rel: string) => {
    if (rel.includes('..')) return match;
    const filePath = path.join(RULES_DIR, rel);
    if (!filePath.startsWith(RULES_DIR + path.sep)) return match;
    if (!fs.existsSync(filePath)) return match;
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return match;
    }
  });
}

/** Slugs this document pulls in via `@import`, for the menu's "includes" line. */
export function importedSlugs(c: Consumable): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(c.filePath, 'utf-8');
  } catch {
    return [];
  }
  const items = listConsumables();
  const found = new Set<string>();
  for (const m of raw.matchAll(/@([A-Za-z0-9_\-./]+\.md)\b/g)) {
    const rel = m[1];
    if (rel.includes('..')) continue;
    const abs = path.join(RULES_DIR, rel);
    if (!fs.existsSync(abs)) continue;
    const hit = items.find((i) => i.filePath === abs);
    if (hit && hit.slug !== c.slug) found.add(hit.slug);
  }
  return [...found];
}

/** The document's text with imports inlined — what actually gets injected. */
export function readConsumable(c: Consumable): string {
  return resolveRuleImports(fs.readFileSync(c.filePath, 'utf-8'));
}

/**
 * Frame the document for injection. The trailing instruction matters: without
 * it a 19K-token document invites a 19K-token summary back.
 */
export function wrapConsumable(c: Consumable, body: string): string {
  return [
    `<consumed-document slug="${c.slug}" label="${c.label}" path="${c.relPath}">`,
    body,
    '</consumed-document>',
    '',
    'The operator loaded the document above into this session with /consume.',
    'Treat it as standing instructions for the rest of this session, alongside',
    'your existing context. Acknowledge in one short line — do not summarize it back.',
  ].join('\n');
}

function readState(): ConsumedState {
  const raw = getRouterState(ROUTER_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ConsumedState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // Corrupt state is not worth failing a command over.
  }
}

/**
 * Whether stored consumed-state still belongs to the live session. An unknown
 * id on either side is treated as current rather than stale: consuming before
 * any container has run records no session id, and that entry should survive
 * into the session it was meant for instead of vanishing on first display.
 */
function isCurrentSession(stored: string, current: string): boolean {
  if (!stored || !current) return true;
  return stored === current;
}

/** What this group has consumed in the current session. */
export function getConsumed(
  groupFolder: string,
  sessionId: string,
): ConsumedItem[] {
  const entry = readState()[groupFolder];
  if (!entry) return [];
  return isCurrentSession(entry.sessionId, sessionId) ? entry.items : [];
}

/** Record a consumed document, replacing any earlier entry for the same slug. */
export function recordConsumed(
  groupFolder: string,
  sessionId: string,
  c: Consumable,
  bytes: number,
): void {
  const state = readState();
  const existing = state[groupFolder];
  const items =
    existing && isCurrentSession(existing.sessionId, sessionId)
      ? existing.items.filter((i) => i.slug !== c.slug)
      : [];

  items.push({
    slug: c.slug,
    label: c.label,
    bytes,
    at: new Date().toISOString(),
  });

  state[groupFolder] = {
    sessionId: sessionId || existing?.sessionId || '',
    items,
  };
  setRouterState(ROUTER_STATE_KEY, JSON.stringify(state));
}

function approxTokens(bytes: number): string {
  const tokens = bytes / 4;
  return tokens >= 1000 ? `~${Math.round(tokens / 1000)}K` : `~${Math.round(tokens)}`;
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * The one view behind /consume, /consumables and /consumed: everything
 * available, with what's already loaded marked. Telegram formatting — single
 * asterisks for bold, never markdown.
 */
export function formatConsumablesMenu(
  items: Consumable[],
  consumed: ConsumedItem[],
  notice?: string,
): string {
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push('🍽️ *Consumables* — this session', '');

  if (items.length === 0) {
    lines.push('Nothing available — no markdown found in rules/ or groups/global/.');
    return lines.join('\n');
  }

  for (const c of items) {
    const hit = consumed.find((i) => i.slug === c.slug);
    const mark = hit ? '✅' : '○';
    lines.push(`${mark} *${c.slug}* — ${c.label}`);

    const meta = [formatBytes(c.bytes), `${approxTokens(c.bytes)} tokens`];
    if (hit) {
      const t = shortTime(hit.at);
      if (t) meta.push(t);
    }
    lines.push(`   ${meta.join(' · ')}`);

    if (c.blurb) lines.push(`   ${c.blurb}`);
    const includes = importedSlugs(c);
    if (includes.length > 0) lines.push(`   includes: ${includes.join(', ')}`);
  }

  lines.push('', 'Send /consume <name> to load one.');
  if (consumed.length > 0) {
    lines.push('Re-consume after /compact — consumed text lives in the conversation.');
  }
  return lines.join('\n');
}

export { approxTokens };
