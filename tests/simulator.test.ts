import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// State path, data dir and group dir are resolved at import time from
// config.js / group-folder.js, so redirect them before simulator.js loads.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sim-'));
const STATE_PATH = path.join(tmpRoot, 'simulator.json');
const DATA_DIR = path.join(tmpRoot, 'data');
const IPC_DIR = path.join(DATA_DIR, 'ipc');
const GROUPS_DIR = path.join(tmpRoot, 'groups');
const FAKE_BIN = path.join(tmpRoot, 'fake-maestro');
const FAKE_SDK = path.join(tmpRoot, 'android-sdk');

vi.mock('../src/config.js', () => ({
  SIMULATOR_STATE_PATH: STATE_PATH,
  DATA_DIR,
}));

vi.mock('../src/group-folder.js', () => ({
  resolveGroupIpcPath: (folder: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) throw new Error('invalid folder');
    return path.join(IPC_DIR, folder);
  },
  resolveGroupFolderPath: (folder: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) throw new Error('invalid folder');
    return path.join(GROUPS_DIR, folder);
  },
}));

// A stand-in "maestro" that echoes its argv and, for `test`, drops a PNG into
// the output dir the way the real one does (nested run folder).
fs.writeFileSync(
  FAKE_BIN,
  `#!/bin/sh
echo "argv: $*"
if [ "$1" = "test" ] || [ "$3" = "test" ]; then
  shift; [ "$1" = "--test-output-dir" ] || shift 2
  shift; out="$1"
  mkdir -p "$out/2026-01-01_000000/flow/takeScreenshot"
  printf 'PNG' > "$out/2026-01-01_000000/flow/takeScreenshot/home.png"
fi
exit 0
`,
  { mode: 0o755 },
);
process.env.MAESTRO_BIN = FAKE_BIN;

// Fake Android SDK: adb echoes argv (and writes PNG bytes for screencap),
// emulator lists one AVD.
fs.mkdirSync(path.join(FAKE_SDK, 'platform-tools'), { recursive: true });
fs.mkdirSync(path.join(FAKE_SDK, 'emulator'), { recursive: true });
fs.writeFileSync(
  path.join(FAKE_SDK, 'platform-tools', 'adb'),
  `#!/bin/sh
echo "adb argv: $*" >&2
case "$*" in
  *"exec-out screencap -p"*) printf 'PNG';;
  "devices -l") echo "List of devices attached"; echo "emulator-5554 device";;
  *) echo "adb: $*";;
esac
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(FAKE_SDK, 'emulator', 'emulator'),
  `#!/bin/sh
[ "$1" = "-list-avds" ] && echo "Pixel_8"
exit 0
`,
  { mode: 0o755 },
);
process.env.ANDROID_HOME = FAKE_SDK;

const {
  getSimulatorStatus,
  handleSimulatorRequest,
  isSimulatorEnabled,
  setSimulator,
  groupMaestroDir,
} = await import('../src/simulator.js');

const GROUP = 'telegram_linkbase';

function resultPath(id: string): string {
  return path.join(IPC_DIR, GROUP, 'results', `${id}.json`);
}

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
  fs.rmSync(GROUPS_DIR, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(DATA_DIR, 'simulator-audit.jsonl'), { force: true });
});

describe('simulator state', () => {
  it('is off when no state file exists', () => {
    expect(isSimulatorEnabled(GROUP)).toBe(false);
  });

  it('persists on/off per group', () => {
    setSimulator(GROUP, true, '12345');
    expect(isSimulatorEnabled(GROUP)).toBe(true);
    expect(isSimulatorEnabled('other_group')).toBe(false);
    expect(getSimulatorStatus(GROUP).changedBy).toBe('12345');
    setSimulator(GROUP, false, '12345');
    expect(isSimulatorEnabled(GROUP)).toBe(false);
  });

  it('is off when the state file is corrupt', () => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, '{not json');
    expect(isSimulatorEnabled(GROUP)).toBe(false);
  });
});

describe('simulator gating', () => {
  it('refuses when the switch is off', async () => {
    handleSimulatorRequest({
      requestId: 'sim-off',
      action: 'hierarchy',
      groupFolder: GROUP,
    });
    const result = await awaitResult('sim-off');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('/simulator on');
  });

  it('does not require the main chat', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-any',
      action: 'hierarchy',
      groupFolder: GROUP,
    });
    const result = await awaitResult('sim-any');
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('argv: --platform ios hierarchy');
  });

  it('ignores a request id that could escape the results dir', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: '../../escape',
      action: 'hierarchy',
      groupFolder: GROUP,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(path.join(IPC_DIR, GROUP, 'results'))).toBe(false);
  });

  it('refuses an unknown action, a bad device, and a bad screenshot name', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-bad-action',
      action: 'rm_rf',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-bad-action')).error)).toContain(
      'unknown action',
    );

    handleSimulatorRequest({
      requestId: 'sim-bad-device',
      action: 'hierarchy',
      device: 'x; rm -rf /',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-bad-device')).error)).toContain(
      'UDID',
    );

    handleSimulatorRequest({
      requestId: 'sim-bad-name',
      action: 'screenshot',
      name: '../escape',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-bad-name')).error)).toContain('name');
  });
});

describe('simulator actions', () => {
  it('passes the device through as a fixed argv, never a shell', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-dev',
      action: 'hierarchy',
      device: 'ABC-123',
      groupFolder: GROUP,
    });
    const result = await awaitResult('sim-dev');
    expect(result.stdout.trim()).toBe(
      'argv: --platform ios --device ABC-123 hierarchy',
    );
  });

  it('run_flow writes the YAML under the group maestro dir and reports screenshots', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-flow',
      action: 'run_flow',
      flowYaml: 'appId: com.example\n---\n- launchApp',
      groupFolder: GROUP,
    });
    const result = await awaitResult('sim-flow');
    expect(result.ok).toBe(true);

    const runDir = path.join(groupMaestroDir(GROUP), 'runs', 'sim-flow');
    expect(fs.readFileSync(path.join(runDir, 'flow.yaml'), 'utf-8')).toContain(
      'launchApp',
    );
    expect(result.outputDir).toBe('/workspace/group/maestro/runs/sim-flow');
    expect(result.screenshots).toEqual([
      '/workspace/group/maestro/runs/sim-flow/2026-01-01_000000/flow/takeScreenshot/home.png',
    ]);
  });

  it('run_flow without YAML is refused', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-noyaml',
      action: 'run_flow',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-noyaml')).error)).toContain(
      'flowYaml',
    );
  });

  it('a mid-session /simulator off refuses the next request', async () => {
    setSimulator(GROUP, true, 'owner');
    setSimulator(GROUP, false, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-revoked',
      action: 'hierarchy',
      groupFolder: GROUP,
    });
    expect((await awaitResult('sim-revoked')).ok).toBe(false);
  });
});

describe('android platform', () => {
  it('rejects an unknown platform', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-badplat',
      action: 'hierarchy',
      platform: 'windows',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-badplat')).error)).toContain(
      'platform',
    );
  });

  it('pins maestro to the android platform for hierarchy and flows', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-and-hier',
      action: 'hierarchy',
      platform: 'android',
      device: 'emulator-5554',
      groupFolder: GROUP,
    });
    const r = await awaitResult('sim-and-hier');
    expect(r.stdout.trim()).toBe(
      'argv: --platform android --device emulator-5554 hierarchy',
    );
  });

  it('list_devices on android reports running emulators and AVDs', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-and-list',
      action: 'list_devices',
      platform: 'android',
      groupFolder: GROUP,
    });
    const r = await awaitResult('sim-and-list');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('emulator-5554 device');
    expect(r.stdout).toContain('Pixel_8');
  });

  it('screenshot on android goes through adb screencap into the maestro dir', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-and-shot',
      action: 'screenshot',
      platform: 'android',
      name: 'home',
      groupFolder: GROUP,
    });
    const r = await awaitResult('sim-and-shot');
    expect(r.ok).toBe(true);
    expect(r.screenshots).toEqual(['/workspace/group/maestro/home.png']);
    expect(
      fs.readFileSync(path.join(groupMaestroDir(GROUP), 'home.png'), 'utf-8'),
    ).toBe('PNG');
    expect(r.stderr).toContain('exec-out screencap -p');
  });

  it('boot on android requires an AVD name', async () => {
    setSimulator(GROUP, true, 'owner');
    handleSimulatorRequest({
      requestId: 'sim-and-boot',
      action: 'boot',
      platform: 'android',
      groupFolder: GROUP,
    });
    expect(String((await awaitResult('sim-and-boot')).error)).toContain('AVD');
  });
});
