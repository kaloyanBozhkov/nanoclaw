import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

// config resolves DATA_DIR/GROUPS_DIR from PROJECT_ROOT at import time, so
// point both at a scratch tree before importing the module under test.
vi.mock('../src/config.js', () => ({
  get DATA_DIR() {
    return path.join(tmpRoot, 'data');
  },
  get GROUPS_DIR() {
    return path.join(tmpRoot, 'groups');
  },
  EPHEMERAL_GROUP_DIRS: ['design-cache'] as const,
}));

const {
  collectResetTargets,
  previewReset,
  formatBytes,
  formatResetFileList,
  formatResetPreview,
  shouldPersistSessionId,
} = await import('../src/session-reset.js');

const GROUP = 'telegram_demo';

function write(p: string, contents: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

function sessionDir(...parts: string[]): string {
  return path.join(
    tmpRoot,
    'data',
    'sessions',
    GROUP,
    '.claude',
    'projects',
    ...parts,
  );
}

function groupDir(...parts: string[]): string {
  return path.join(tmpRoot, 'groups', GROUP, ...parts);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-reset-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('collectResetTargets', () => {
  it('reports nothing for a group with no session or cache', () => {
    expect(collectResetTargets(GROUP)).toEqual([]);
    expect(previewReset(GROUP).empty).toBe(true);
  });

  it('targets session entries but never auto-memory', () => {
    write(sessionDir('-workspace-group', 'abc-123.jsonl'), 'x'.repeat(100));
    write(sessionDir('-workspace-group', 'memory', 'notes.md'), 'keep me');

    const targets = collectResetTargets(GROUP);
    expect(targets).toHaveLength(1);
    expect(targets[0].label).toBe('conversation history');
    expect(targets[0].files).toBe(1);
    expect(targets[0].bytes).toBe(100);
    expect(targets[0].paths.some((p) => p.includes('memory'))).toBe(false);
  });

  it('targets ephemeral group dirs and sizes them recursively', () => {
    write(groupDir('design-cache', 'proj', 'a.html'), 'a'.repeat(30));
    write(groupDir('design-cache', 'proj', 'nested', 'b.jsx'), 'b'.repeat(70));

    const targets = collectResetTargets(GROUP);
    expect(targets).toHaveLength(1);
    expect(targets[0].label).toBe('design-cache');
    expect(targets[0].files).toBe(2);
    expect(targets[0].bytes).toBe(100);
  });

  it('never targets authored work — briefs and CLAUDE.md survive', () => {
    write(groupDir('CLAUDE.md'), '# memory');
    write(groupDir('design-briefs', 'screens.md'), 'brief');
    write(groupDir('design-cache', 'proj', 'a.html'), 'a');

    const labels = collectResetTargets(GROUP).map((t) => t.label);
    expect(labels).toEqual(['design-cache']);
  });

  it('rejects a traversal-shaped group folder without touching anything', () => {
    write(groupDir('design-cache', 'a.html'), 'a');
    expect(collectResetTargets('../../etc')).toEqual([]);
    expect(fs.existsSync(groupDir('design-cache', 'a.html'))).toBe(true);
  });

  it('deleting exactly the previewed paths leaves nothing behind', () => {
    write(sessionDir('-workspace-group', 'abc-123.jsonl'), 'session');
    write(sessionDir('-workspace-group', 'memory', 'notes.md'), 'keep me');
    write(groupDir('design-cache', 'proj', 'a.html'), 'cached');
    write(groupDir('design-briefs', 'screens.md'), 'brief');

    for (const target of collectResetTargets(GROUP)) {
      for (const p of target.paths) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }

    expect(previewReset(GROUP).empty).toBe(true);
    expect(
      fs.existsSync(sessionDir('-workspace-group', 'memory', 'notes.md')),
    ).toBe(true);
    expect(fs.existsSync(groupDir('design-briefs', 'screens.md'))).toBe(true);
    expect(fs.existsSync(groupDir('design-cache'))).toBe(false);
  });
});

describe('scope', () => {
  beforeEach(() => {
    write(sessionDir('-workspace-group', 'abc.jsonl'), 'x'.repeat(10));
    write(groupDir('design-cache', 'a.html'), 'y'.repeat(90));
  });

  it('tags each target as session or cache', () => {
    expect(collectResetTargets(GROUP).map((t) => [t.label, t.kind])).toEqual([
      ['conversation history', 'session'],
      ['design-cache', 'cache'],
    ]);
  });

  it("'session' keeps caches out of the target list", () => {
    const targets = collectResetTargets(GROUP, 'session');
    expect(targets.map((t) => t.label)).toEqual(['conversation history']);
    expect(previewReset(GROUP, 'session').bytes).toBe(10);
  });

  it("'all' is the default and includes caches", () => {
    expect(previewReset(GROUP).bytes).toBe(100);
    expect(previewReset(GROUP, 'all').bytes).toBe(100);
  });

  it('a session-scoped delete leaves the cache on disk', () => {
    for (const target of collectResetTargets(GROUP, 'session')) {
      for (const p of target.paths)
        fs.rmSync(p, { recursive: true, force: true });
    }
    expect(fs.existsSync(groupDir('design-cache', 'a.html'))).toBe(true);
    expect(previewReset(GROUP, 'session').empty).toBe(true);
    expect(previewReset(GROUP).empty).toBe(false);
  });
});

describe('previewReset totals', () => {
  it('sums files and bytes across targets', () => {
    write(sessionDir('-workspace-group', 'abc.jsonl'), 'x'.repeat(10));
    write(groupDir('design-cache', 'a.html'), 'y'.repeat(90));

    const preview = previewReset(GROUP);
    expect(preview.empty).toBe(false);
    expect(preview.targets).toHaveLength(2);
    expect(preview.files).toBe(2);
    expect(preview.bytes).toBe(100);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [20 * 1024, '20 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [2 * 1024 * 1024 * 1024, '2.0 GB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatResetFileList', () => {
  /** Path shape from a real session dir — long UUIDs, nested subagent files. */
  function writeRealisticSession(count: number): void {
    const uuid = '416d92e6-f422-45ca-80f3-73f87b3ed6e6';
    for (let i = 0; i < count; i++) {
      write(
        sessionDir(
          '-workspace-group',
          uuid,
          'subagents',
          `agent-a0${String(i).padStart(16, '0')}.jsonl`,
        ),
        'x'.repeat(1024),
      );
    }
  }

  it('lists files with project-relative paths, never absolute ones', () => {
    write(sessionDir('-workspace-group', 'abc.jsonl'), 'x'.repeat(2048));
    write(groupDir('design-cache', 'proj', 'a.html'), 'y');

    const text = formatResetFileList(previewReset(GROUP));
    expect(text).toContain('abc.jsonl — 2.0 KB');
    expect(text).toContain('a.html — 1 B');
    expect(text).toContain('conversation history');
    expect(text).toContain('design-cache');
    expect(text).not.toContain(tmpRoot);
  });

  it('folds a shared directory prefix onto the target line', () => {
    write(sessionDir('-workspace-group', 'deep', 'one.jsonl'), 'x');
    write(sessionDir('-workspace-group', 'deep', 'two.jsonl'), 'x');

    const text = formatResetFileList(previewReset(GROUP));
    expect(text).toContain(
      'conversation history — data/sessions/telegram_demo/.claude/projects/-workspace-group/deep/',
    );
    expect(text).toContain('  one.jsonl — 1 B');
    expect(text).toContain('  two.jsonl — 1 B');
  });

  it('keeps the full path when a single file has no shared prefix', () => {
    write(groupDir('design-cache', 'only.html'), 'x');
    expect(formatResetFileList(previewReset(GROUP))).toContain(
      'groups/telegram_demo/design-cache/only.html — 1 B',
    );
  });

  // Regression: a file-count cap does not bound a character limit. 105 real
  // session paths (~150 chars each) produced a 6623-char body and Telegram
  // rejected the edit with 400 MESSAGE_TOO_LONG.
  it('stays under the Telegram limit with a realistic 105-file session', () => {
    writeRealisticSession(105);
    const text = formatResetFileList(previewReset(GROUP));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…and \d+ more files/);
  });

  it.each([1, 20, 105, 500])('stays under the limit with %i files', (count) => {
    writeRealisticSession(count);
    expect(formatResetFileList(previewReset(GROUP)).length).toBeLessThanOrEqual(
      4096,
    );
  });

  it('respects an explicit character budget', () => {
    writeRealisticSession(40);
    expect(
      formatResetFileList(previewReset(GROUP), 1000).length,
    ).toBeLessThanOrEqual(1000);
  });

  it('uses the singular for a single omitted file', () => {
    write(groupDir('design-cache', 'aaaaaaaaaa.html'), 'x');
    write(groupDir('design-cache', 'bbbbbbbbbb.html'), 'x');
    // Budget sized to fit the target line and one entry, but not the second:
    // ~142 chars of header/footer/reserve overhead, then 49 for the target
    // line and 24 per entry.
    const text = formatResetFileList(previewReset(GROUP), 225);
    expect(text).toContain('…and 1 more file');
    expect(text).not.toContain('more files');
  });

  it('falls back to the nothing-to-do message when already fresh', () => {
    expect(formatResetFileList(previewReset(GROUP))).toContain('already fresh');
  });
});

describe('formatResetPreview', () => {
  it('says nothing-to-do when the session is already fresh', () => {
    expect(formatResetPreview(previewReset(GROUP))).toContain('already fresh');
  });

  it('lists each target and what survives', () => {
    write(sessionDir('-workspace-group', 'abc.jsonl'), 'x'.repeat(2048));
    write(groupDir('design-cache', 'a.html'), 'y');

    const text = formatResetPreview(previewReset(GROUP));
    expect(text).toContain('conversation history — 1 file, 2.0 KB');
    expect(text).toContain('design-cache — 1 file, 1 B');
    expect(text).toContain('Kept:');
    expect(text).toContain('Proceed?');
  });
});

describe('shouldPersistSessionId', () => {
  it('persists when the group has never been reset', () => {
    expect(shouldPersistSessionId(undefined, 1_000)).toBe(true);
  });

  it('persists an id from a container started after the reset', () => {
    expect(shouldPersistSessionId(1_000, 2_000)).toBe(true);
  });

  it('drops an id from a container that was already running at reset time', () => {
    // The regression: `/new` deletes the transcript, the container it asked to
    // stop exits a moment later, and its stale id would otherwise be written
    // back over the cleared row — stranding the group on a session whose
    // transcript no longer exists.
    expect(shouldPersistSessionId(2_000, 1_000)).toBe(false);
  });

  it('drops an id when reset and container start land on the same tick', () => {
    // Same millisecond means the reset cannot be proven to precede the start,
    // and resurrecting a dead session costs more than losing a live one.
    expect(shouldPersistSessionId(1_000, 1_000)).toBe(false);
  });
});
