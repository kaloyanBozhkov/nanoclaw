/**
 * `/agents` — the dev-team roles in groups/global/agents/*.md, as the agent
 * runner registers them (container/agent-runner/src/agent-defs.ts parses the
 * same format — keep the two in step).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface AgentRole {
  name: string;
  title: string;
  kind: 'pipeline' | 'standalone' | 'orchestrator';
  description: string;
  /** Position in the pipeline (frontmatter `order`); unset sorts last. */
  order?: number;
}

const KINDS = ['pipeline', 'standalone', 'orchestrator'] as const;

export function agentsDir(): string {
  return path.join(GROUPS_DIR, 'global', 'agents');
}

export function parseAgentRole(text: string): AgentRole | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  if (!fields.name || !/^[a-z0-9][a-z0-9-]*$/.test(fields.name)) return null;
  return {
    name: fields.name,
    title: fields.title || fields.name,
    kind: (KINDS as readonly string[]).includes(fields.kind)
      ? (fields.kind as AgentRole['kind'])
      : 'standalone',
    description: fields.description || '',
    ...(fields.order && !isNaN(Number(fields.order))
      ? { order: Number(fields.order) }
      : {}),
  };
}

export function listAgentRoles(dir = agentsDir()): AgentRole[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const roles: AgentRole[] = [];
  for (const f of files.sort()) {
    try {
      const role = parseAgentRole(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (role) roles.push(role);
    } catch {
      // Unreadable — skip.
    }
  }
  return roles;
}

const SECTIONS: { kind: AgentRole['kind']; title: string; note?: string }[] = [
  { kind: 'pipeline', title: '🛠️ Pipeline' },
  { kind: 'standalone', title: '🧭 Standalone' },
  {
    kind: 'orchestrator',
    title: '🎛️ Orchestrators',
    note: 'run by the main agent itself (they spawn other roles)',
  },
];

export function formatAgents(roles: AgentRole[]): string {
  if (roles.length === 0) {
    return '🤖 No agent definitions found in groups/global/agents/.';
  }
  const lines = [`🤖 Agents (${roles.length})`];
  for (const s of SECTIONS) {
    const inSection = roles
      .filter((r) => r.kind === s.kind)
      .sort(
        (a, b) =>
          (a.order ?? Infinity) - (b.order ?? Infinity) ||
          a.name.localeCompare(b.name),
      );
    if (inSection.length === 0) continue;
    lines.push('', s.note ? `${s.title} — ${s.note}` : s.title);
    for (const r of inSection) {
      lines.push(`• ${r.title} (${r.name}) — ${r.description}`);
    }
  }
  lines.push(
    '',
    'Definitions live in groups/global/agents/*.md and are picked up when a chat’s agent starts.',
  );
  return lines.join('\n');
}
