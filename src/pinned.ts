/**
 * Pinned-context helpers.
 *
 * Pins are durable user instructions that survive compaction, restarts, and
 * new sessions. They live in a dedicated section of the group's CLAUDE.md
 * so they're always part of the bot's system prompt at every turn.
 *
 * Section format in groups/<folder>/CLAUDE.md:
 *
 *   ## 📌 Pinned context
 *
 *   Durable user instructions — always honor these over conversation context.
 *
 *   1. {pin one}
 *   2. {pin two}
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

const SECTION_HEADING = '## 📌 Pinned context';
const SECTION_PREAMBLE =
  'Durable user instructions — always honor these over conversation context.';

interface ParsedClaudeMd {
  before: string; // content before the pinned section (incl. trailing newlines)
  pins: string[]; // pin lines without numbering
  after: string; // content after the pinned section
}

function readClaudeMd(folder: string): { path: string; content: string } {
  const filePath = path.join(resolveGroupFolderPath(folder), 'CLAUDE.md');
  const content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';
  return { path: filePath, content };
}

function parsePinnedSection(md: string): ParsedClaudeMd {
  const lines = md.split('\n');
  const headingIdx = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  if (headingIdx === -1) return { before: md, pins: [], after: '' };

  // Find next `## ` heading after the section
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(headingIdx + 1, endIdx);
  const pins: string[] = [];
  for (const line of sectionLines) {
    const m = /^\s*\d+\.\s+(.*\S.*)$/.exec(line);
    if (m) pins.push(m[1].trim());
  }

  const before = lines.slice(0, headingIdx).join('\n').replace(/\n+$/, '');
  const after = lines.slice(endIdx).join('\n');
  return { before, pins, after };
}

function renderClaudeMd(parsed: ParsedClaudeMd): string {
  const beforePart = parsed.before ? parsed.before + '\n\n' : '';
  const afterPart = parsed.after ? '\n' + parsed.after : '';

  if (parsed.pins.length === 0) {
    // Drop the section entirely if no pins remain.
    const trimmedBefore = parsed.before.replace(/\n+$/, '');
    const out =
      (trimmedBefore ? trimmedBefore + (parsed.after ? '\n' : '') : '') +
      (parsed.after || '');
    return out.endsWith('\n') ? out : out + '\n';
  }

  const numbered = parsed.pins.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const section = `${SECTION_HEADING}\n\n${SECTION_PREAMBLE}\n\n${numbered}\n`;

  const out = `${beforePart}${section}${afterPart}`;
  return out.endsWith('\n') ? out : out + '\n';
}

function writeClaudeMd(folder: string, parsed: ParsedClaudeMd): void {
  const { path: filePath } = readClaudeMd(folder);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderClaudeMd(parsed));
}

export interface PinResult {
  ok: boolean;
  message: string;
}

export function addPin(folder: string, text: string): PinResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: 'Empty pin — nothing to add.' };
  if (trimmed.length > 1000) {
    return {
      ok: false,
      message: 'Pin too long (max 1000 chars). Break it into smaller pins.',
    };
  }
  const { content } = readClaudeMd(folder);
  const parsed = parsePinnedSection(content);
  // De-dupe: if an identical pin already exists, no-op.
  if (parsed.pins.includes(trimmed)) {
    return { ok: true, message: `Already pinned (#${parsed.pins.indexOf(trimmed) + 1}).` };
  }
  parsed.pins.push(trimmed);
  writeClaudeMd(folder, parsed);
  return { ok: true, message: `📌 Pinned (#${parsed.pins.length}): ${trimmed}` };
}

export function listPins(folder: string): string[] {
  const { content } = readClaudeMd(folder);
  return parsePinnedSection(content).pins;
}

export function removePin(folder: string, indexOneBased: number): PinResult {
  const { content } = readClaudeMd(folder);
  const parsed = parsePinnedSection(content);
  if (parsed.pins.length === 0) {
    return { ok: false, message: 'No pins to remove.' };
  }
  if (
    !Number.isInteger(indexOneBased) ||
    indexOneBased < 1 ||
    indexOneBased > parsed.pins.length
  ) {
    return {
      ok: false,
      message: `Invalid index. Use a number between 1 and ${parsed.pins.length}.`,
    };
  }
  const removed = parsed.pins.splice(indexOneBased - 1, 1)[0];
  writeClaudeMd(folder, parsed);
  return { ok: true, message: `🗑️ Unpinned: ${removed}` };
}

export function formatPinList(pins: string[]): string {
  if (pins.length === 0) return 'No pins set. Pin with `/pin <text>` or `📌 <text>`.';
  return (
    '📌 *Pinned context:*\n' +
    pins.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\n\n_Remove with_ \`/unpin <n>\``
  );
}
