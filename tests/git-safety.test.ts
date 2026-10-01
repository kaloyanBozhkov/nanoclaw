import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  checkGitCommand,
  checkGitSafetyToolUse,
} from '../container/agent-runner/src/git-safety.js';

// The state file path is resolved at import time from config.js, so it has to
// be redirected before git-safety.js loads.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-git-safety-'));
const STATE_PATH = path.join(tmpRoot, 'git-safety.json');

vi.mock('../src/config.js', () => ({ GIT_SAFETY_STATE_PATH: STATE_PATH }));

const { getGitSafetyStatus, isGitSafetyEnabled, setGitSafety } =
  await import('../src/git-safety.js');

describe('git safety switch (host)', () => {
  beforeEach(() => fs.rmSync(STATE_PATH, { force: true }));

  it('defaults to on when no state file exists', () => {
    expect(isGitSafetyEnabled('telegram_linkbase')).toBe(true);
  });

  it('defaults to on when the state file is corrupt', () => {
    fs.writeFileSync(STATE_PATH, '{not json');
    expect(isGitSafetyEnabled('telegram_linkbase')).toBe(true);
  });

  it('persists off per group without touching other groups', () => {
    setGitSafety('telegram_linkbase', false, 'owner');
    expect(isGitSafetyEnabled('telegram_linkbase')).toBe(false);
    expect(isGitSafetyEnabled('telegram_main')).toBe(true);
    expect(getGitSafetyStatus('telegram_linkbase').changedBy).toBe('owner');
  });

  it('turns back on', () => {
    setGitSafety('telegram_linkbase', false, 'owner');
    setGitSafety('telegram_linkbase', true, 'owner');
    expect(isGitSafetyEnabled('telegram_linkbase')).toBe(true);
  });

  it('treats only an explicit false as off', () => {
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ groups: { a: { enabled: 'no' }, b: {} } }),
    );
    expect(isGitSafetyEnabled('a')).toBe(true);
    expect(isGitSafetyEnabled('b')).toBe(true);
  });
});

describe('checkGitCommand (container hook)', () => {
  const blocked = [
    'git worktree add /workspace/group/wt-x -b feat/x',
    'cd /workspace/extra/linkbase && git worktree add ../wt-y',
    'git -C /workspace/extra/linkbase worktree add wt',
    'git switch main',
    'git switch -c feat/new',
    'git checkout main',
    'git checkout -b feat/new',
    'git checkout -B feat/new origin/main',
    'git checkout --orphan gh-pages',
    'git checkout .',
    'git checkout -- .',
    'git restore .',
    'git stash',
    'git stash push -m wip',
    'git stash pop',
    'git reset --hard',
    'git reset --hard origin/main',
    'git clean -fd',
    'git clean -f',
    'git rebase main',
    'git pull && git rebase -i HEAD~3',
    'git push --force',
    'git push -f origin feat/x',
    'git push --force-with-lease',
    'git push origin +feat/x',
    'git branch -D feat/old',
    'git branch -m new-name',
    'git --no-pager checkout main',
    'sh -c "git switch main"',
    'echo $(git checkout main)',
    '/usr/bin/git switch main',
    'git status; git checkout main',
  ];
  it.each(blocked)('blocks %s', (cmd) => {
    expect(checkGitCommand(cmd)).toEqual(expect.any(String));
  });

  const allowed = [
    'git status',
    'git branch --show-current',
    'git branch',
    'git branch -a',
    'git diff HEAD~1',
    'git log --oneline -5',
    'git add -A && git commit -m "fix: header button"',
    'git commit -m "fix git switch bug in docs"',
    'git push -u origin HEAD',
    'git push',
    'git pull',
    'git fetch origin',
    'git checkout -- src/app.ts',
    'git checkout HEAD -- src/app.ts',
    'git restore src/app.ts',
    'git restore --staged .',
    'git reset src/app.ts',
    'git reset HEAD~1',
    'git stash list',
    'git clean -n',
    'git clean -nd',
    'git worktree list',
    'git worktree remove ../wt-old',
    'git worktree prune',
    'pnpm install && pnpm test',
    'ls -la',
  ];
  it.each(allowed)('allows %s', (cmd) => {
    expect(checkGitCommand(cmd)).toBeNull();
  });
});

describe('checkGitSafetyToolUse (container hook)', () => {
  it('blocks EnterWorktree', () => {
    expect(checkGitSafetyToolUse('EnterWorktree', {})).toEqual(
      expect.any(String),
    );
  });

  it('blocks sub-agents in worktree isolation', () => {
    expect(
      checkGitSafetyToolUse('Agent', { prompt: 'x', isolation: 'worktree' }),
    ).toEqual(expect.any(String));
    expect(
      checkGitSafetyToolUse('Task', { prompt: 'x', isolation: 'worktree' }),
    ).toEqual(expect.any(String));
  });

  it('allows ordinary sub-agents', () => {
    expect(checkGitSafetyToolUse('Agent', { prompt: 'x' })).toBeNull();
  });

  it('checks Bash commands', () => {
    expect(
      checkGitSafetyToolUse('Bash', { command: 'git switch main' }),
    ).toEqual(expect.any(String));
    expect(checkGitSafetyToolUse('Bash', { command: 'git status' })).toBeNull();
  });

  it('ignores other tools', () => {
    expect(checkGitSafetyToolUse('Read', { file_path: '/x' })).toBeNull();
  });
});
