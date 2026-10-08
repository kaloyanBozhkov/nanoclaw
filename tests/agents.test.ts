import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { formatAgents, listAgentRoles, parseAgentRole } from '../src/agents.js';
import {
  parseRoleFile,
  readRoleFiles,
  toSubagentDefinitions,
} from '../container/agent-runner/src/agent-defs.js';
import { formatHelp } from '../src/help.js';

const FILE = (name: string, kind: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ntitle: 🦫 ${name}\nkind: ${kind}\ndescription: when to use ${name}\n---\n\n${body}\n`;

function dir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-agents-'));
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}

describe('role files (runner)', () => {
  it('parses frontmatter and body', () => {
    expect(parseRoleFile(FILE('fse', 'pipeline', 'Line 1\n\nLine 2'))).toEqual({
      name: 'fse',
      title: '🦫 fse',
      kind: 'pipeline',
      description: 'when to use fse',
      body: 'Line 1\n\nLine 2',
    });
  });

  it('rejects files without a valid name', () => {
    expect(parseRoleFile('no frontmatter')).toBeNull();
    expect(parseRoleFile(FILE('Bad Name', 'pipeline'))).toBeNull();
  });

  it('registers every role except orchestrators, with a reporting footer', () => {
    const d = dir({
      'a.md': FILE('a', 'pipeline'),
      'b.md': FILE('b', 'orchestrator'),
      'notes.txt': 'ignored',
    });
    const defs = toSubagentDefinitions(readRoleFiles([d]));
    expect(Object.keys(defs)).toEqual(['a']);
    expect(defs.a.description).toBe('🦫 a — when to use a');
    expect(defs.a.prompt).toContain('Do the thing.');
    expect(defs.a.prompt).toContain('sender: "🦫 a"');
  });

  it('appends shared rules (Git Safety) to every role when given', () => {
    const d = dir({ 'a.md': FILE('a', 'pipeline') });
    expect(
      toSubagentDefinitions(readRoleFiles([d]), '## Git Safety (ON — enforced)')
        .a.prompt,
    ).toContain('## Git Safety (ON — enforced)');
    expect(toSubagentDefinitions(readRoleFiles([d])).a.prompt).not.toContain(
      'Git Safety',
    );
  });

  it('falls back to the next directory', () => {
    const d = dir({ 'a.md': FILE('a', 'standalone') });
    expect(readRoleFiles(['/nonexistent', d]).map((r) => r.name)).toEqual([
      'a',
    ]);
  });
});

describe('/agents (host)', () => {
  it('lists roles grouped by kind', () => {
    const d = dir({
      'a.md': FILE('a', 'pipeline'),
      'b.md': FILE('b', 'orchestrator'),
    });
    const text = formatAgents(listAgentRoles(d));
    expect(text).toContain('🤖 Agents (2)');
    expect(text).toContain('🛠️ Pipeline');
    expect(text).toContain('• 🦫 a (a) — when to use a');
    expect(text).toContain('🎛️ Orchestrators');
  });

  it('sorts pipeline roles by order', () => {
    const d = dir({
      'a.md': FILE('a', 'pipeline').replace(
        'kind: pipeline',
        'kind: pipeline\norder: 2',
      ),
      'z.md': FILE('z', 'pipeline').replace(
        'kind: pipeline',
        'kind: pipeline\norder: 1',
      ),
    });
    const text = formatAgents(listAgentRoles(d));
    expect(text.indexOf('(z)')).toBeLessThan(text.indexOf('(a)'));
  });

  it('host and runner parsers agree', () => {
    const text = FILE('x', 'standalone');
    const { body: _body, ...runner } = parseRoleFile(text)!;
    expect(parseAgentRole(text)).toEqual(runner);
  });

  it('parses the real definitions', () => {
    const roles = listAgentRoles();
    expect(roles.length).toBeGreaterThan(10);
    expect(roles.map((r) => r.name)).toContain('full-stack-engineer');
    expect(roles.every((r) => r.description.length > 0)).toBe(true);
  });

  it('is in /help', () => {
    expect(formatHelp()).toContain('/agents');
  });
});
