import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The state file path and the IPC root are resolved at import time from
// config.js, so both have to be redirected before godmode.js loads.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-godmode-'));
const STATE_PATH = path.join(tmpRoot, 'godmode.json');
const DATA_DIR = path.join(tmpRoot, 'data');
const IPC_DIR = path.join(DATA_DIR, 'ipc');

vi.mock('../src/config.js', () => ({
  GODMODE_STATE_PATH: STATE_PATH,
  DATA_DIR,
}));

vi.mock('../src/group-folder.js', () => ({
  resolveGroupIpcPath: (folder: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) throw new Error('invalid folder');
    return path.join(IPC_DIR, folder);
  },
}));

vi.mock('../src/open-host.js', () => ({
  // Mirrors the real translator closely enough for these tests: host paths
  // pass through, container-only paths map to nothing.
  resolveContainerPath: (p: string) =>
    p.startsWith('/workspace/') || p.startsWith('/home/node') ? null : p,
}));

const {
  getGodModeStatus,
  handleHostExec,
  isGodModeEnabled,
  setGodMode,
  MAX_EXEC_TIMEOUT_MS,
} = await import('../src/godmode.js');

const GROUP = 'telegram_main';

function resultPath(id: string): string {
  return path.join(IPC_DIR, GROUP, 'results', `${id}.json`);
}

/** Wait for the host to write a result file, then read it. */
async function awaitResult(id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(resultPath(id), 'utf-8'));
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`no result written for ${id}`);
}

beforeEach(() => {
  fs.rmSync(STATE_PATH, { force: true });
  fs.rmSync(IPC_DIR, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(DATA_DIR, 'godmode-audit.jsonl'), { force: true });
});

describe('godmode state', () => {
  it('is off when no state file exists', () => {
    expect(isGodModeEnabled(GROUP)).toBe(false);
  });

  it('persists on/off per group', () => {
    setGodMode(GROUP, true, '12345');
    expect(isGodModeEnabled(GROUP)).toBe(true);
    expect(isGodModeEnabled('other_group')).toBe(false);

    const status = getGodModeStatus(GROUP);
    expect(status.changedBy).toBe('12345');
    expect(status.changedAt).not.toBe('');

    setGodMode(GROUP, false, '12345');
    expect(isGodModeEnabled(GROUP)).toBe(false);
  });

  it('is off when the state file is corrupt', () => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, '{not json');
    expect(isGodModeEnabled(GROUP)).toBe(false);
  });

  it('reads the switch fresh, so a mid-session /godmode off applies', () => {
    setGodMode(GROUP, true, 'owner');
    expect(isGodModeEnabled(GROUP)).toBe(true);
    // Simulate another process (the chat command) flipping it off.
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({
        groups: { [GROUP]: { enabled: false, changedAt: '', changedBy: '' } },
      }),
    );
    expect(isGodModeEnabled(GROUP)).toBe(false);
  });
});

describe('host_exec gating', () => {
  it('refuses when godmode is off', async () => {
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      handleHostExec({
        requestId: 'exec-off',
        command: 'echo hello',
        groupFolder: GROUP,
        isMain: true,
      });
      awaitResult('exec-off').then(resolve);
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('godmode is off');
    expect(result.stdout).toBe('');
  });

  it('refuses a non-main group even when godmode is on for it', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-notmain',
      command: 'echo hello',
      groupFolder: GROUP,
      isMain: false,
    });
    const result = await awaitResult('exec-notmain');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('main chat');
  });

  it('ignores a request id that could escape the results dir', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: '../../escape',
      command: 'echo hello',
      groupFolder: GROUP,
      isMain: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(path.join(IPC_DIR, GROUP, 'results'))).toBe(false);
    expect(fs.existsSync(path.join(IPC_DIR, 'escape.json'))).toBe(false);
  });

  it('refuses a cwd the host cannot see', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-badcwd',
      command: 'pwd',
      cwd: '/home/node/scratch',
      groupFolder: GROUP,
      isMain: true,
    });
    const result = await awaitResult('exec-badcwd');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('container-only');
  });

  it('refuses a cwd that does not exist on the host', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-nocwd',
      command: 'pwd',
      cwd: path.join(tmpRoot, 'nope'),
      groupFolder: GROUP,
      isMain: true,
    });
    const result = await awaitResult('exec-nocwd');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('does not exist');
  });
});

describe('host_exec execution', () => {
  it('runs a command and returns stdout, exit code, and cwd', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-ok',
      command: 'echo nanoclaw-godmode-ok',
      cwd: tmpRoot,
      groupFolder: GROUP,
      isMain: true,
    });
    const result = await awaitResult('exec-ok');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('nanoclaw-godmode-ok');
    expect(fs.realpathSync(String(result.cwd))).toBe(fs.realpathSync(tmpRoot));
  });

  it('reports a non-zero exit with stderr instead of throwing', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-fail',
      command: 'echo to-stderr >&2; exit 3',
      groupFolder: GROUP,
      isMain: true,
    });
    const result = await awaitResult('exec-fail');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(String(result.stderr)).toContain('to-stderr');
  });

  it('kills a command that outlives its timeout', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-timeout',
      command: 'sleep 30',
      timeoutMs: 1000,
      groupFolder: GROUP,
      isMain: true,
    });
    const result = await awaitResult('exec-timeout', 20_000);
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('timed out');
  }, 25_000);

  it('records every attempt in the audit log', async () => {
    setGodMode(GROUP, true, 'owner');
    handleHostExec({
      requestId: 'exec-audit',
      command: 'echo audited',
      groupFolder: GROUP,
      isMain: true,
    });
    await awaitResult('exec-audit');
    const audit = fs.readFileSync(
      path.join(DATA_DIR, 'godmode-audit.jsonl'),
      'utf-8',
    );
    expect(audit).toContain('echo audited');
    expect(audit).toContain('exec-audit');
  });

  it('caps the timeout a caller can ask for', async () => {
    // Guards the constant the tool description advertises.
    expect(MAX_EXEC_TIMEOUT_MS).toBe(600_000);
  });
});
