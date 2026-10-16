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
  RUN_LOG_MAX_BYTES,
  parseRunInput,
  runArgv,
  displayCommand,
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

  it('restarts numbering at 1 once nothing is running', async () => {
    const first = await run('0');
    const second = await run('0');
    expect(first.id).toBe(1);
    expect(second.id).toBe(1);
  });

  it('numbers concurrent runs upward', async () => {
    const start = (script: string) =>
      new Promise<HostRun>((resolve) => {
        const r = startRun({
          chatJid: 'mx:!r:x',
          script,
          label: 'linkbase',
          cwd: root,
          logFile: path.join(root, 'logs', `${script}.log`),
          command: [process.execPath, '-e', 'setTimeout(() => {}, 300)'],
          onExit: resolve,
        });
        ids.push(r.id);
      });
    const ids: number[] = [];
    await Promise.all([start('a'), start('b'), start('c')]);
    expect(ids).toEqual([1, 2, 3]);
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

describe('run log cap', () => {
  it('stops growing the file past the cap but keeps the tail live', async () => {
    const r = await new Promise<HostRun>((resolve) => {
      startRun({
        chatJid: 'mx:!r:x',
        script: 'spam',
        label: 'linkbase',
        cwd: root,
        logFile: path.join(root, 'logs', 'spam.log'),
        command: [
          process.execPath,
          '-e',
          "process.stdout.write(('x'.repeat(1023) + '\\n').repeat(21 * 1024)); console.log('last line')",
        ],
        onExit: resolve,
      });
    });
    const size = fs.statSync(r.logFile).size;
    expect(size).toBeLessThan(RUN_LOG_MAX_BYTES + 128 * 1024);
    expect(fs.readFileSync(r.logFile, 'utf-8')).toContain(
      '[log capped at 20 MB',
    );
    expect(r.tail.at(-1)).toBe('last line');
  });
});

describe('parseRunInput', () => {
  it('splits the script from quoted arguments', () => {
    expect(parseRunInput('update:prod "message of update"')).toEqual({
      script: 'update:prod',
      args: ['message of update'],
    });
    expect(parseRunInput("test -- --watch -t 'login flow'")).toEqual({
      script: 'test',
      args: ['--watch', '-t', 'login flow'],
    });
  });

  it('treats curly double quotes as quotes but keeps curly apostrophes', () => {
    expect(
      parseRunInput('update:prod \u201Cfix: don\u2019t crash\u201D'),
    ).toEqual({
      script: 'update:prod',
      args: ['fix: don\u2019t crash'],
    });
    expect(parseRunInput('update:prod it\u2019s done')).toEqual({
      script: 'update:prod',
      args: ['it\u2019s', 'done'],
    });
  });

  it('keeps spacing inside quotes and handles escapes and empty strings', () => {
    expect(parseRunInput('x "a  b" c\\ d ""')).toEqual({
      script: 'x',
      args: ['a  b', 'c d', ''],
    });
  });

  it('reports an unclosed quote', () => {
    expect(parseRunInput('x "oops')).toEqual({ error: 'Unclosed " quote.' });
  });
});

describe('runArgv / displayCommand', () => {
  it('adds -- only for npm', () => {
    expect(runArgv('pnpm', 'test', ['-t', 'x'])).toEqual([
      'pnpm',
      'run',
      'test',
      '-t',
      'x',
    ]);
    expect(runArgv('npm', 'test', ['-t', 'x'])).toEqual([
      'npm',
      'run',
      'test',
      '--',
      '-t',
      'x',
    ]);
    expect(runArgv('npm', 'build', [])).toEqual(['npm', 'run', 'build']);
  });

  it('quotes arguments that need it', () => {
    expect(
      displayCommand(['pnpm', 'run', 'update:prod', 'message of update']),
    ).toBe('pnpm run update:prod "message of update"');
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
