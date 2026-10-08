/**
 * Role definitions for the dev-team pipeline, loaded from markdown files in
 * groups/global/agents/ (mounted at /workspace/global/agents, or under
 * /workspace/project for the main group) and registered with the SDK as
 * subagent types. Only each role's one-line description rides on the
 * orchestrator's prompt; the full body becomes the subagent's own system
 * prompt when it's spawned.
 *
 * File format — plain markdown with a small frontmatter, deliberately not tied
 * to the SDK so the same files would serve another agent framework:
 *
 *   ---
 *   name: full-stack-engineer        # id, used as subagent_type
 *   title: 🦫 Full-Stack Engineer    # display name and chat `sender`
 *   kind: pipeline | standalone | orchestrator
 *   description: one line — when to use it
 *   ---
 *   <role definition>
 *
 * Orchestrators coordinate other roles, and subagents can't spawn agents, so
 * they are not registered: the main agent reads their file and runs them.
 *
 * The host parses the same format for `/agents` (src/agents.ts) — keep the
 * two parsers in step.
 */
import fs from 'fs';
import path from 'path';

export interface RoleFile {
  name: string;
  title: string;
  kind: 'pipeline' | 'standalone' | 'orchestrator';
  description: string;
  body: string;
}

export const AGENT_DIRS = [
  '/workspace/global/agents',
  '/workspace/project/groups/global/agents',
];

const KINDS = ['pipeline', 'standalone', 'orchestrator'] as const;

export function parseRoleFile(text: string): RoleFile | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(
    text.replace(/\r\n/g, '\n'),
  );
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  const name = fields.name;
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const kind = (KINDS as readonly string[]).includes(fields.kind)
    ? (fields.kind as RoleFile['kind'])
    : 'standalone';
  return {
    name,
    title: fields.title || name,
    kind,
    description: fields.description || '',
    body: m[2].trim(),
  };
}

export function readRoleFiles(dirs: string[] = AGENT_DIRS): RoleFile[] {
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    const roles: RoleFile[] = [];
    for (const f of files.sort()) {
      try {
        const role = parseRoleFile(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (role) roles.push(role);
      } catch {
        // Unreadable file — skip it rather than fail the whole session.
      }
    }
    return roles;
  }
  return [];
}

export interface SubagentDefinition {
  description: string;
  prompt: string;
}

/** SDK `agents` option: every role except orchestrators. */
export function toSubagentDefinitions(
  roles: RoleFile[],
  /** Extra session rules every subagent must see (e.g. Git Safety when on). */
  sharedRules?: string,
): Record<string, SubagentDefinition> {
  const out: Record<string, SubagentDefinition> = {};
  for (const r of roles) {
    if (r.kind === 'orchestrator') continue;
    out[r.name] = {
      description: `${r.title} — ${r.description}`,
      prompt:
        `${r.body}\n\n---\n\nYou are running as the ${r.title} subagent. ` +
        `Report progress to the chat with \`mcp__nanoclaw__send_message\`, ` +
        `using \`sender: "${r.title}"\`.` +
        (sharedRules ? `\n\n${sharedRules}` : ''),
    };
  }
  return out;
}
