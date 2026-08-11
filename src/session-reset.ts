/**
 * What `/new` destroys, described before it happens.
 *
 * The target list lives here so the preview shown to the user and the deletion
 * that follows are computed by the same function — a confirmation prompt that
 * can drift from the action it describes is worse than no prompt at all.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, EPHEMERAL_GROUP_DIRS } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface ResetFile {
  /** Absolute path on disk. */
  path: string;
  /** Path shown to the user — relative to the project root, never $HOME. */
  display: string;
  bytes: number;
}

export interface ResetTarget {
  /** Human label for the chat summary. */
  label: string;
  /** Absolute paths removed when the reset runs. */
  paths: string[];
  /** Every file under those paths, collected during the same walk. */
  entries: ResetFile[];
  files: number;
  bytes: number;
}

export interface ResetPreview {
  targets: ResetTarget[];
  files: number;
  bytes: number;
  /** True when there is nothing to delete — the session is already fresh. */
  empty: boolean;
}

/**
 * Project root for display purposes. DATA_DIR and GROUPS_DIR are siblings under
 * it, so paths render as `data/sessions/…` and `groups/…` rather than leaking
 * the operator's home directory into a chat message.
 */
function displayRoot(): string {
  return path.dirname(DATA_DIR);
}

/** Every file under `target`, depth-first and name-sorted for stable output. */
function walkFiles(target: string): ResetFile[] {
  const out: ResetFile[] = [];
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return; // vanished mid-walk; nothing to report
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(p).sort();
      } catch {
        return;
      }
      for (const e of entries) walk(path.join(p, e));
      return;
    }
    out.push({
      path: p,
      display: path.relative(displayRoot(), p),
      bytes: st.size,
    });
  };
  walk(target);
  return out;
}

function makeTarget(label: string, paths: string[]): ResetTarget | null {
  const present = paths.filter((p) => fs.existsSync(p));
  if (present.length === 0) return null;
  const entries = present.flatMap(walkFiles);
  return {
    label,
    paths: present,
    entries,
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}

/**
 * Everything `/new` would remove for this group, in deletion order.
 *
 * Claude session files: the UUID dirs/files under each project directory,
 * excluding `memory/` (auto-memory is durable). Then any derived group caches
 * listed in EPHEMERAL_GROUP_DIRS. Authored work — design briefs, memory — is
 * never a target.
 */
export function collectResetTargets(groupFolder: string): ResetTarget[] {
  const targets: ResetTarget[] = [];

  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  const sessionPaths: string[] = [];
  try {
    if (fs.existsSync(projectsDir)) {
      for (const projectDir of fs.readdirSync(projectsDir)) {
        const fullProjectDir = path.join(projectsDir, projectDir);
        if (!fs.statSync(fullProjectDir).isDirectory()) continue;
        for (const entry of fs.readdirSync(fullProjectDir)) {
          if (entry === 'memory') continue; // preserve auto-memory
          sessionPaths.push(path.join(fullProjectDir, entry));
        }
      }
    }
  } catch {
    // Unreadable session dir — report nothing rather than guessing.
  }
  const sessionTarget = makeTarget('conversation history', sessionPaths);
  if (sessionTarget) targets.push(sessionTarget);

  try {
    const groupPath = resolveGroupFolderPath(groupFolder);
    for (const dirName of EPHEMERAL_GROUP_DIRS) {
      const t = makeTarget(dirName, [path.join(groupPath, dirName)]);
      if (t) targets.push(t);
    }
  } catch {
    // Invalid group folder — resolveGroupFolderPath already rejected it, and
    // the reset path will reject it identically. Nothing to preview.
  }

  return targets;
}

export function previewReset(groupFolder: string): ResetPreview {
  const targets = collectResetTargets(groupFolder);
  const files = targets.reduce((n, t) => n + t.files, 0);
  const bytes = targets.reduce((n, t) => n + t.bytes, 0);
  return { targets, files, bytes, empty: targets.length === 0 };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Telegram rejects a sendMessage/editMessageText body over this length. */
export const TELEGRAM_MAX_CHARS = 4096;

/** Longest directory prefix shared by every path, '' when there isn't one. */
function commonDirPrefix(paths: string[]): string {
  if (paths.length < 2) return '';
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0];
  let i = 0;
  while (
    i < first.length &&
    split.every((parts) => parts[i] === first[i])
  ) {
    i += 1;
  }
  return first.slice(0, i).join('/');
}

/**
 * Per-file breakdown for the "List files" expansion.
 *
 * Budgeted in **characters**, not files: a session directory can hold a hundred
 * entries whose paths run past 150 chars each, so a file-count cap does not
 * bound the message and Telegram answers 400 MESSAGE_TOO_LONG. Paths are also
 * folded against their common directory so each line carries only what differs.
 */
export function formatResetFileList(
  preview: ResetPreview,
  maxChars: number = TELEGRAM_MAX_CHARS,
): string {
  if (preview.empty) return formatResetPreview(preview);

  const footer = [
    '',
    'Kept: auto-memory, design briefs, and this group’s CLAUDE.md.',
    '',
    'Proceed?',
  ];
  const header = 'This will permanently delete:';
  // Reserve room for the footer, the header, and a worst-case "…and N more" line.
  const overhead =
    header.length + footer.join('\n').length + 40 + preview.targets.length;
  const budget = Math.max(0, maxChars - overhead);

  const lines: string[] = [];
  let used = 0;
  let omitted = 0;

  const push = (line: string): boolean => {
    if (used + line.length + 1 > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const target of preview.targets) {
    const prefix = commonDirPrefix(target.entries.map((e) => e.display));
    const headline = prefix
      ? `${target.label} — ${prefix}/`
      : `${target.label}:`;

    if (!push(headline)) {
      omitted += target.entries.length;
      continue;
    }

    for (const entry of target.entries) {
      const rel = prefix
        ? entry.display.slice(prefix.length + 1)
        : entry.display;
      if (!push(`  ${rel} — ${formatBytes(entry.bytes)}`)) {
        omitted += 1;
      }
    }
  }

  if (omitted > 0) {
    lines.push(`  …and ${omitted} more file${omitted === 1 ? '' : 's'}`);
  }

  return [header, ...lines, ...footer].join('\n');
}

/** Plain-text summary for the confirmation prompt. */
export function formatResetPreview(preview: ResetPreview): string {
  if (preview.empty) {
    return 'Nothing to clear — this session is already fresh.';
  }
  const lines = preview.targets.map(
    (t) =>
      `• ${t.label} — ${t.files} file${t.files === 1 ? '' : 's'}, ${formatBytes(t.bytes)}`,
  );
  return [
    'This will permanently delete:',
    ...lines,
    '',
    'Kept: auto-memory, design briefs, and this group’s CLAUDE.md.',
    '',
    'Proceed?',
  ].join('\n');
}
