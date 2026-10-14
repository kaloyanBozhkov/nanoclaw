import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  activeRuns,
  findScript,
  HostRun,
  isValidScriptName,
  listScripts,
  packageManagerFor,
  projectRoots,
  startRun,
  stopRun,
  urlsIn,
} from '../src/host-run.js';

let root: string;
function pkg(rel: string, scripts: Record<string, string>) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
}

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'run-')), 'linkbase');
  fs.mkdirSync(root);
  pkg('.', { build: 'turbo build', dev: 'turbo dev' });
  pkg('backend', {
    dev: 'tsx watch',
    'deploy:vps': 'bash scripts/deploy-vps.sh',
  });
  pkg('linkbase', { dev: 'expo start', 'dev:remote': 'node dev-remote.mjs' });
  pkg('node_modules/junk', { 'deploy:vps': 'nope' });
  pkg('landing/.next', { dev: 'nope' });
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
});
afterEach(() =>
  fs.rmSync(path.dirname(root), { recursive: true, force: true }),
);

describe('finding scripts', () => {
  it('finds a unique script and skips node_modules and dot folders', () => {
    const found = findScript([root], 'deploy:vps');
    expect(found).toEqual([
      {
        dir: path.join(root, 'backend'),
        label: 'linkbase/backend',
        command: 'bash scripts/deploy-vps.sh',
      },
    ]);
  });

  it('returns every package for a duplicate name', () => {
    expect(
      findScript([root], 'dev')
        .map((f) => f.label)
        .sort(),
    ).toEqual(['linkbase', 'linkbase/backend', 'linkbase/linkbase']);
  });

  it('lists scripts grouped by folder', () => {
    const byPkg = listScripts([root]);
    expect(byPkg.get('linkbase')).toEqual(['build', 'dev']);
    expect(byPkg.get('linkbase/backend')).toEqual(['dev', 'deploy:vps']);
    expect([...byPkg.keys()]).not.toContain('linkbase/node_modules/junk');
  });

  it('uses only writable mounts that exist', () => {
    expect(
      projectRoots([
        { hostPath: root, readonly: false },
        { hostPath: '/nope/missing', readonly: false },
        { hostPath: root, readonly: true },
      ]),
    ).toEqual([root]);
  });

  it('detects the package manager from the nearest lockfile', () => {
    expect(packageManagerFor(path.join(root, 'backend'), root)).toBe('pnpm');
    fs.writeFileSync(path.join(root, 'linkbase', 'yarn.lock'), '');
    expect(packageManagerFor(path.join(root, 'linkbase'), root)).toBe('yarn');
  });

  it('rejects names that are not script names', () => {
    expect(isValidScriptName('deploy:vps')).toBe(true);
    expect(isValidScriptName('build:@scope/pkg')).toBe(true);
    expect(isValidScriptName('x; rm -rf ~')).toBe(false);
    expect(isValidScriptName('$(whoami)')).toBe(false);
  });
});

describe('running', () => {
  function run(code: string): Promise<HostRun> {
    return new Promise((resolve) => {
      startRun({
        chatJid: 'mx:!r:x',
        script: 'test',
        label: 'linkbase',
        cwd: root,
        logFile: path.join(root, 'logs', 'run.log'),
        command: [process.execPath, '-e', code],
        onExit: resolve,
      });
    });
  }

  it('captures output, the exit code and a log file', async () => {
    const r = await run(
      "console.log('one'); console.error('two'); process.exit(3)",
    );
    expect(r.exitCode).toBe(3);
    expect(r.tail).toEqual(['one', 'two']);
    expect(fs.readFileSync(r.logFile, 'utf-8')).toContain('one');
    expect(activeRuns()).toHaveLength(0);
  });

  it('stops a long-running process', async () => {
    let started!: HostRun;
    const exited = new Promise<HostRun>((resolve) => {
      started = startRun({
        chatJid: 'mx:!r:x',
        script: 'dev',
        label: 'linkbase',
        cwd: root,
        logFile: path.join(root, 'logs', 'dev.log'),
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        onExit: resolve,
      });
    });
    expect(activeRuns('mx:!r:x').map((r) => r.id)).toContain(started.id);
    stopRun(started, 1000);
    const r = await exited;
    expect(r.signal).toBe('SIGTERM');
  });
});

describe('urlsIn', () => {
  it('pulls dev-server links out of output', () => {
    expect(
      urlsIn(
        '› Metro waiting on exp://192.168.1.26:8081, web http://localhost:3000.',
      ),
    ).toEqual(['exp://192.168.1.26:8081', 'http://localhost:3000']);
    expect(urlsIn('nothing here')).toEqual([]);
  });
});
