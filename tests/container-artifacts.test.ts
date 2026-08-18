import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  collectArtifactMounts,
  findProjectRoots,
} from '../src/container-runner.js';

let tmp: string;

function write(rel: string, content: string): void {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-artifacts-'));

  // A pnpm workspace monorepo shaped like the real Linkbase repo.
  write('monorepo/pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('monorepo/package.json', '{"name":"root"}');
  write('monorepo/backend/package.json', '{"name":"backend"}');
  write('monorepo/backend/_app/package.json', '{"name":"admin-spa"}');
  write('monorepo/linkbase/package.json', '{"name":"app"}');
  write('monorepo/packages/prisma/package.json', '{"name":"prisma"}');
  write('monorepo/packages/shared/package.json', '{"name":"shared"}');
  // Must never be descended into.
  write('monorepo/node_modules/left-pad/package.json', '{"name":"left-pad"}');

  // A plain (non-workspace) project with a nested package.json.
  write('plain/package.json', '{"name":"plain"}');
  write('plain/vendored/package.json', '{"name":"vendored"}');

  // An npm-workspaces root, to cover the non-pnpm form.
  write('npmws/package.json', '{"name":"root","workspaces":["pkgs/*"]}');
  write('npmws/pkgs/a/package.json', '{"name":"a"}');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function relRoots(root: string): string[] {
  return findProjectRoots(root)
    .map((p) => path.relative(root, p) || '.')
    .sort();
}

describe('findProjectRoots', () => {
  it('descends into every package of a pnpm workspace', () => {
    // Each of these has its own real node_modules on disk, so each needs its
    // own shadow — this is the bug that leaked linux installs onto the host.
    // backend/_app matters specifically: it is not a declared workspace member,
    // but `backend`'s build runs `cd _app && pnpm install`, so it has one too.
    expect(relRoots(path.join(tmp, 'monorepo'))).toEqual([
      '.',
      'backend',
      'backend/_app',
      'linkbase',
      'packages/prisma',
      'packages/shared',
    ]);
  });

  it('never descends into node_modules', () => {
    expect(relRoots(path.join(tmp, 'monorepo'))).not.toContain(
      'node_modules/left-pad',
    );
  });

  it('shadows nested projects rather than assuming they share the parent store', () => {
    expect(relRoots(path.join(tmp, 'plain'))).toEqual(['.', 'vendored']);
  });

  it('descends into npm/yarn workspaces too', () => {
    expect(relRoots(path.join(tmp, 'npmws'))).toEqual(['.', 'pkgs/a']);
  });
});

describe('collectArtifactMounts', () => {
  const mount = (
    hostPath: string,
    containerPath: string,
    readonly = false,
  ) => ({
    hostPath,
    containerPath,
    readonly,
  });

  it('claims artifacts for every project root plus the shared caches', () => {
    const entries = collectArtifactMounts(
      [mount(path.join(tmp, 'monorepo'), '/workspace/extra/monorepo')],
      'telegram_test',
    );
    const subpaths = entries.map((e) => e.subpath);
    // Fixed caches always present
    expect(subpaths).toContain('pnpm-store');
    expect(subpaths).toContain('npm-cache');
    // Root and nested workspace packages each get their own tree
    expect(subpaths).toContain('extra/telegram-test/monorepo/node_modules');
    expect(subpaths).toContain(
      'extra/telegram-test/monorepo/backend/_app/node_modules',
    );
    expect(subpaths).toContain(
      'extra/telegram-test/monorepo/packages/prisma/.pnpm-store',
    );
    const dsts = entries.map((e) => e.containerPath);
    expect(dsts).toContain('/workspace/extra/monorepo/backend/node_modules');
    expect(dsts).toContain('/home/node/.pnpm-store');
  });

  it('applies configured isolatedArtifacts at the repo root only', () => {
    const entries = collectArtifactMounts(
      [mount(path.join(tmp, 'monorepo'), '/workspace/extra/monorepo')],
      'telegram_test',
      ['packages/prisma/client'],
    );
    const subpaths = entries.map((e) => e.subpath);
    expect(subpaths).toContain(
      'extra/telegram-test/monorepo/packages/prisma/client',
    );
    // Path-escape attempts are rejected, not mounted
    const escaped = collectArtifactMounts(
      [mount(path.join(tmp, 'monorepo'), '/workspace/extra/monorepo')],
      'telegram_test',
      ['../outside', '/abs'],
    );
    expect(
      escaped.every(
        (e) => !e.subpath.includes('..') && !e.containerPath.includes('..'),
      ),
    ).toBe(true);
  });

  it('ignores readonly and non-project mounts', () => {
    const entries = collectArtifactMounts(
      [
        mount(path.join(tmp, 'monorepo'), '/workspace/extra/monorepo', true),
        mount(path.join(tmp, 'monorepo'), '/workspace/rules'),
      ],
      'telegram_test',
    );
    // Only the fixed caches remain
    expect(entries.every((e) => !e.subpath.startsWith('extra/'))).toBe(true);
  });
});
