import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeAll, vi } from 'vitest';

import type { RegisteredGroup } from '../src/types.js';

// Pass mounts through untouched: the allowlist is not what's under test.
vi.mock('../src/mount-security.js', () => ({
  validateAdditionalMounts: (
    mounts: { hostPath: string; containerPath?: string; readonly?: boolean }[],
  ) =>
    mounts.map((m) => ({
      hostPath: m.hostPath,
      containerPath: `/workspace/extra/${m.containerPath ?? path.basename(m.hostPath)}`,
      readonly: m.readonly ?? true,
    })),
}));
vi.mock('../src/git-safety.js', () => ({ isGitSafetyEnabled: () => true }));

const { collectGitInfo, formatGitInfo } = await import('../src/git-info.js');
const { formatHelp } = await import('../src/help.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-git-info-'));
const repo = path.join(tmp, 'app');
const plain = path.join(tmp, 'notes');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();

function group(): RegisteredGroup {
  return {
    name: 'Test',
    folder: 'test',
    trigger: '@Andy',
    added_at: '',
    containerConfig: {
      additionalMounts: [
        { hostPath: repo, containerPath: 'app', readonly: false },
        { hostPath: plain, containerPath: 'notes' },
      ],
    },
  } as RegisteredGroup;
}

beforeAll(() => {
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-qb', 'feat/x');
  git(repo, 'worktree', 'add', '-q', path.join(tmp, 'wt-y'), '-b', 'fix/y');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
});

describe('git info', () => {
  it('reports branch, dirty state and worktrees; skips non-repos', async () => {
    const repos = await collectGitInfo(group(), false);
    expect(repos).toHaveLength(1);
    const [r] = repos;
    expect(r.name).toBe('app');
    expect(r.branch).toBe('feat/x');
    expect(r.dirty).toBe(1);
    expect(r.ahead).toBeNull();
    expect(r.worktrees).toEqual([
      expect.objectContaining({ name: 'wt-y', branch: 'fix/y' }),
    ]);
  });

  it('formats a chat summary', async () => {
    const text = formatGitInfo(await collectGitInfo(group(), false), true);
    expect(text).toContain('Your machine: feat/x — 1 uncommitted change,');
    expect(text).toContain('Agent: feat/x (same checkout)');
    expect(text).toContain('wt-y → fix/y');
    expect(text).toContain('git safety ON');
  });

  it('says so when no repos are mounted', () => {
    expect(formatGitInfo([], false)).toContain('No git repos');
  });
});

describe('help', () => {
  it('lists the git commands and itself', () => {
    const text = formatHelp();
    for (const cmd of ['/git-info', '/git-safety', '/help', '/stop', '/info']) {
      expect(text).toContain(cmd);
    }
  });
});
