/**
 * Host-side setup for a project created with `/mxroom`: its working folder
 * under ~/Documents/koko (mounted into the agent container) and, on request,
 * a git repo pushed to a new private GitHub repo via the `gh` CLI.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { AdditionalMount } from './types.js';

const run = promisify(execFile);

/** Where project working folders live; ~/Documents/koko is mount-allowlisted. */
export const PROJECTS_DIR_TILDE = '~/Documents/koko';

export function projectsDir(): string {
  return path.join(os.homedir(), 'Documents', 'koko');
}

/** "Tide App!" → "tide-app": a valid group folder, repo and directory name. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** The read-write mount that puts the project folder at /workspace/extra/<slug>. */
export function projectMount(slug: string): AdditionalMount {
  return {
    hostPath: `${PROJECTS_DIR_TILDE}/${slug}`,
    containerPath: slug,
    readonly: false,
  };
}

/** Create the project folder if needed; reports whether it already existed. */
export function ensureProjectDir(slug: string): {
  dir: string;
  existed: boolean;
} {
  const dir = path.join(projectsDir(), slug);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, existed };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir });
  return stdout.trim();
}

/** The folder's origin remote URL, or null when it isn't a repo / has none. */
export async function gitRemote(dir: string): Promise<string | null> {
  try {
    return (await git(dir, 'remote', 'get-url', 'origin')) || null;
  } catch {
    return null;
  }
}

/**
 * git init (if needed), an initial commit (if there is none), then create a
 * private GitHub repo named after the project and push. Returns its URL.
 */
export async function setUpGitHubRepo(
  dir: string,
  repoName: string,
  title: string,
): Promise<string> {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, 'init', '-b', 'main');
  }
  let hasCommit = true;
  try {
    await git(dir, 'rev-parse', '--verify', 'HEAD');
  } catch {
    hasCommit = false;
  }
  if (!hasCommit) {
    if (fs.readdirSync(dir).filter((f) => f !== '.git').length === 0) {
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${title}\n`);
    }
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'Initial commit');
  }
  await run(
    'gh',
    [
      'repo',
      'create',
      repoName,
      '--private',
      '--source',
      dir,
      '--remote',
      'origin',
      '--push',
    ],
    { cwd: dir },
  );
  const { stdout } = await run(
    'gh',
    ['repo', 'view', '--json', 'url', '-q', '.url'],
    {
      cwd: dir,
    },
  );
  return stdout.trim();
}
