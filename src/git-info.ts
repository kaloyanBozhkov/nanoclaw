/**
 * `/git-info` — which branch each of a chat's mounted repos is on, on the
 * user's machine and for the agent.
 *
 * Read entirely host-side from the repos' own git metadata, so it works with
 * no container running. The agent shares the user's checkout (it is
 * bind-mounted), so its branch is the user's branch — except in worktrees,
 * which git records under `<repo>/.git/worktrees/<name>/` whether they were
 * created on the host or inside a container.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { isGitSafetyEnabled } from './git-safety.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  name: string;
  /** Branch name, or `detached @<sha>`. */
  branch: string;
  /** Worktree location as git recorded it (a container path if the agent made it). */
  location: string;
}

export interface RepoInfo {
  /** Name the agent sees: /workspace/extra/<name>. */
  name: string;
  hostPath: string;
  readonly: boolean;
  /** Branch name, or `detached @<sha>`. */
  branch: string;
  /** Uncommitted entries (tracked changes + untracked files). */
  dirty: number;
  /** Commits ahead/behind upstream; null when there's no upstream. */
  ahead: number | null;
  behind: number | null;
  worktrees: WorktreeInfo[];
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function describeHead(head: string): string {
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head.trim());
  if (ref) return ref[1];
  return `detached @${head.trim().slice(0, 7)}`;
}

function readWorktrees(commonDir: string): WorktreeInfo[] {
  const dir = path.join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: WorktreeInfo[] = [];
  for (const name of names.sort()) {
    try {
      const head = fs.readFileSync(path.join(dir, name, 'HEAD'), 'utf-8');
      const gitdir = fs
        .readFileSync(path.join(dir, name, 'gitdir'), 'utf-8')
        .trim();
      out.push({
        name,
        branch: describeHead(head),
        location: gitdir.replace(/\/\.git$/, ''),
      });
    } catch {
      // Half-written or pruned entry — not a usable worktree.
    }
  }
  return out;
}

async function inspectRepo(
  name: string,
  hostPath: string,
  readonly: boolean,
): Promise<RepoInfo | null> {
  let commonDir: string;
  try {
    commonDir = path.resolve(
      hostPath,
      await git(hostPath, 'rev-parse', '--git-common-dir'),
    );
  } catch {
    return null; // Not a git repo.
  }

  const branch =
    (await git(hostPath, 'branch', '--show-current').catch(() => '')) ||
    `detached @${await git(hostPath, 'rev-parse', '--short', 'HEAD').catch(() => '?')}`;

  const status = await git(hostPath, 'status', '--porcelain').catch(() => '');
  const dirty = status ? status.split('\n').length : 0;

  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const counts = await git(
      hostPath,
      'rev-list',
      '--left-right',
      '--count',
      '@{upstream}...HEAD',
    );
    const [b, a] = counts.split(/\s+/).map(Number);
    behind = b;
    ahead = a;
  } catch {
    // No upstream configured.
  }

  return {
    name,
    hostPath,
    readonly,
    branch,
    dirty,
    ahead,
    behind,
    worktrees: readWorktrees(commonDir),
  };
}

/** Inspect every git repo mounted into this group's containers. */
export async function collectGitInfo(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<RepoInfo[]> {
  const mounts = validateAdditionalMounts(
    group.containerConfig?.additionalMounts ?? [],
    group.name,
    isMain,
  );
  const repos = await Promise.all(
    mounts.map((m) =>
      inspectRepo(
        m.containerPath.replace(/^\/workspace\/extra\//, ''),
        m.hostPath,
        m.readonly,
      ),
    ),
  );
  return repos.filter((r): r is RepoInfo => r !== null);
}

function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep)
    ? `~${p.slice(home.length)}`
    : p;
}

function syncLabel(r: RepoInfo): string {
  if (r.ahead === null || r.behind === null) return 'no upstream';
  if (r.ahead === 0 && r.behind === 0) return 'in sync with upstream';
  const parts: string[] = [];
  if (r.ahead) parts.push(`${r.ahead} ahead`);
  if (r.behind) parts.push(`${r.behind} behind`);
  return parts.join(', ');
}

/** Chat-ready summary. */
export function formatGitInfo(repos: RepoInfo[], gitSafety: boolean): string {
  const safety = gitSafety
    ? '🛡️ git safety ON — the agent stays on your checked-out branch.'
    : '⚠️ git safety OFF — the agent may create worktrees and switch branches.';

  if (repos.length === 0) {
    return `🌿 No git repos are mounted in this chat.\n${safety}`;
  }

  const lines = ['🌿 Git info', ''];
  for (const r of repos) {
    lines.push(
      `📁 ${r.name} (${tildify(r.hostPath)})${r.readonly ? ' — read-only' : ''}`,
    );
    const dirty = r.dirty
      ? `${r.dirty} uncommitted change${r.dirty === 1 ? '' : 's'}`
      : 'clean';
    lines.push(`💻 Your machine: ${r.branch} — ${dirty}, ${syncLabel(r)}`);
    lines.push(
      `🤖 Agent: ${r.branch} (same checkout${r.readonly ? ', read-only' : ''})`,
    );
    if (r.worktrees.length > 0) {
      lines.push(`🌲 Worktrees (${r.worktrees.length}):`);
      for (const w of r.worktrees) {
        lines.push(`   • ${w.name} → ${w.branch}  (${tildify(w.location)})`);
      }
    }
    lines.push('');
  }
  lines.push(safety);
  return lines.join('\n');
}

export async function describeGitInfo(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<string> {
  const repos = await collectGitInfo(group, isMain);
  return formatGitInfo(repos, isGitSafetyEnabled(group.folder));
}
