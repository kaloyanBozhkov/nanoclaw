/**
 * iOS Simulator access via Maestro — per-group, host-side.
 *
 * The container agent runs in a Linux VM and can never see the iOS Simulator,
 * which only exists on the Mac host. This module is the bridge: a container
 * writes a `simulator` IPC request, the host runs the matching Maestro or
 * simctl command against the booted simulator, and writes the result back
 * under the group's IPC namespace (`ipc/results/<requestId>.json`), the same
 * request/response shape godmode uses.
 *
 * Unlike godmode this is NOT a shell. The agent picks from a fixed set of
 * actions (list devices, dump the view hierarchy, screenshot, run a flow) and
 * every action is a fixed argv — nothing from the request is ever
 * shell-interpolated. Flow YAML is written to a file and handed to Maestro.
 *
 * Any group may be enabled, not just main: the blast radius is one simulator,
 * not the user's machine. The switch lives at ~/.config/nanoclaw/simulator.json
 * — outside the project root, never mounted into a container — and is re-read
 * on every request, so `/simulator off` revokes a running container.
 *
 * All output for a group lands in `groups/<folder>/maestro/`, which the
 * container sees as `/workspace/group/maestro/`, so the agent can read a
 * screenshot with its vision tool or hand it straight to `send_image`.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, SIMULATOR_STATE_PATH } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

/** Per-group simulator record. */
export interface SimulatorEntry {
  enabled: boolean;
  /** ISO timestamp of the last change. */
  changedAt: string;
  /** Sender ID that made the last change. */
  changedBy: string;
}

interface SimulatorState {
  groups: Record<string, SimulatorEntry>;
}

function readState(): SimulatorState {
  try {
    const raw = JSON.parse(fs.readFileSync(SIMULATOR_STATE_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.groups !== 'object') {
      return { groups: {} };
    }
    const groups: Record<string, SimulatorEntry> = {};
    for (const [folder, value] of Object.entries(
      raw.groups as Record<string, unknown>,
    )) {
      const e = value as Partial<SimulatorEntry> | null;
      if (!e || typeof e !== 'object') continue;
      groups[folder] = {
        enabled: e.enabled === true,
        changedAt: typeof e.changedAt === 'string' ? e.changedAt : '',
        changedBy: typeof e.changedBy === 'string' ? e.changedBy : '',
      };
    }
    return { groups };
  } catch {
    // Missing or unreadable state means off — the safe direction to fail.
    return { groups: {} };
  }
}

/** Never cached: `/simulator off` must bite on the very next request. */
export function getSimulatorStatus(groupFolder: string): SimulatorEntry {
  return (
    readState().groups[groupFolder] ?? {
      enabled: false,
      changedAt: '',
      changedBy: '',
    }
  );
}

export function isSimulatorEnabled(groupFolder: string): boolean {
  return getSimulatorStatus(groupFolder).enabled;
}

/** Flip the switch for one group. Throws if the state file can't be written. */
export function setSimulator(
  groupFolder: string,
  enabled: boolean,
  changedBy: string,
): SimulatorEntry {
  const state = readState();
  const entry: SimulatorEntry = {
    enabled,
    changedAt: new Date().toISOString(),
    changedBy,
  };
  state.groups[groupFolder] = entry;

  fs.mkdirSync(path.dirname(SIMULATOR_STATE_PATH), { recursive: true });
  const tmp = `${SIMULATOR_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SIMULATOR_STATE_PATH);

  logger.warn(
    { groupFolder, enabled, changedBy },
    enabled ? 'Simulator access ENABLED' : 'Simulator access disabled',
  );
  return entry;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const SIMULATOR_ACTIONS = [
  'list_devices',
  'hierarchy',
  'screenshot',
  'run_flow',
] as const;
export type SimulatorAction = (typeof SIMULATOR_ACTIONS)[number];

export const DEFAULT_SIM_TIMEOUT_MS = 120_000;
export const MAX_SIM_TIMEOUT_MS = 600_000;
/** Per-stream capture cap. Output beyond this is dropped and flagged. */
const MAX_STREAM_CHARS = 200_000;
const RESULT_TTL_MS = 60 * 60 * 1000;

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Simulator UDIDs and screenshot names: no separators, no traversal. */
const SAFE_DEVICE = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Where the maestro dir shows up inside the container. */
const CONTAINER_GROUP_DIR = '/workspace/group';

export interface SimulatorRequest {
  requestId?: string;
  action?: string;
  /** Simulator UDID. Defaults to the booted device. */
  device?: string;
  /** For `screenshot`: file stem under groups/<folder>/maestro/. */
  name?: string;
  /** For `run_flow`: full Maestro flow YAML. */
  flowYaml?: string;
  timeoutMs?: number;
  /** Verified from the IPC directory the request arrived in. */
  groupFolder: string;
}

export interface SimulatorResult {
  requestId: string;
  action?: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Container-visible paths of every screenshot this action produced. */
  screenshots: string[];
  /** Container-visible path of the flow file or run directory, if any. */
  outputDir?: string;
  /** Set when the request was refused or never started. */
  error?: string;
}

function auditLine(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DATA_DIR, 'simulator-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to append simulator audit line');
  }
}

function sweepStaleResults(dir: string): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > RESULT_TTL_MS) fs.unlinkSync(p);
      } catch {
        // Raced with the container collecting it.
      }
    }
  } catch {
    // Directory not there yet; the write below creates it.
  }
}

function writeResult(groupFolder: string, result: SimulatorResult): void {
  let dir: string;
  try {
    dir = path.join(resolveGroupIpcPath(groupFolder), 'results');
  } catch (err) {
    logger.error(
      { err, groupFolder },
      'Cannot resolve IPC results dir for simulator',
    );
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    sweepStaleResults(dir);
    const target = path.join(dir, `${result.requestId}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.error(
      { err, groupFolder, requestId: result.requestId },
      'Failed to write simulator result',
    );
  }
}

function refuse(
  groupFolder: string,
  requestId: string,
  reason: string,
  action?: string,
): void {
  logger.warn({ groupFolder, requestId, action, reason }, 'simulator refused');
  auditLine({ groupFolder, requestId, action, refused: reason });
  writeResult(groupFolder, {
    requestId,
    action,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: 0,
    screenshots: [],
    error: reason,
  });
}

/** The maestro binary. Overridable for non-default installs. */
export function maestroBin(): string {
  return (
    process.env.MAESTRO_BIN ||
    path.join(os.homedir(), '.maestro', 'bin', 'maestro')
  );
}

/** Host path of this group's maestro output dir, created on demand. */
export function groupMaestroDir(groupFolder: string): string {
  const dir = path.join(resolveGroupFolderPath(groupFolder), 'maestro');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Translate a host path under the group folder to what the container sees. */
function toContainerPath(groupFolder: string, hostPath: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  return path.posix.join(
    CONTAINER_GROUP_DIR,
    path.relative(groupDir, hostPath).split(path.sep).join('/'),
  );
}

/** Every PNG under a directory, recursively, sorted for stable output. */
function findPngs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

interface Plan {
  bin: string;
  args: string[];
  /** Directory to scan for screenshots after the command exits. */
  scanDir?: string;
  /** A single expected screenshot path (screenshot action). */
  expectFile?: string;
  outputDir?: string;
}

/**
 * Turn a request into a fixed argv. Nothing here goes through a shell, so
 * request fields can't inject flags or commands — they are validated for the
 * one role they play (a UDID, a filename stem, YAML content).
 */
function plan(
  req: SimulatorRequest,
  requestId: string,
): { ok: true; plan: Plan } | { ok: false; reason: string } {
  const action = req.action as SimulatorAction;
  const device = (req.device ?? '').trim();
  if (device && !SAFE_DEVICE.test(device)) {
    return { ok: false, reason: 'device must be a simulator UDID' };
  }
  const deviceArgs = device ? ['--device', device] : [];
  const simctlTarget = device || 'booted';

  switch (action) {
    case 'list_devices':
      return {
        ok: true,
        plan: {
          bin: 'xcrun',
          args: ['simctl', 'list', 'devices', 'available'],
        },
      };

    case 'hierarchy':
      return {
        ok: true,
        plan: { bin: maestroBin(), args: [...deviceArgs, 'hierarchy'] },
      };

    case 'screenshot': {
      const name = (req.name ?? '').trim() || `screen-${requestId}`;
      if (!SAFE_NAME.test(name)) {
        return {
          ok: false,
          reason: 'name may only contain letters, digits, "-" and "_"',
        };
      }
      const file = path.join(groupMaestroDir(req.groupFolder), `${name}.png`);
      return {
        ok: true,
        plan: {
          bin: 'xcrun',
          args: ['simctl', 'io', simctlTarget, 'screenshot', file],
          expectFile: file,
        },
      };
    }

    case 'run_flow': {
      const yaml = (req.flowYaml ?? '').trim();
      if (!yaml) return { ok: false, reason: 'run_flow needs flowYaml' };
      const runDir = path.join(
        groupMaestroDir(req.groupFolder),
        'runs',
        requestId,
      );
      fs.mkdirSync(runDir, { recursive: true });
      const flowFile = path.join(runDir, 'flow.yaml');
      fs.writeFileSync(flowFile, `${yaml}\n`);
      return {
        ok: true,
        plan: {
          bin: maestroBin(),
          args: [...deviceArgs, 'test', '--test-output-dir', runDir, flowFile],
          scanDir: runDir,
          outputDir: runDir,
        },
      };
    }

    default:
      return {
        ok: false,
        reason: `unknown action "${req.action}" — expected one of ${SIMULATOR_ACTIONS.join(', ')}`,
      };
  }
}

/**
 * Run one simulator action on behalf of a container, if the group is enabled.
 *
 * Returns as soon as the child is spawned — the IPC watcher is serial, and a
 * Maestro run can take a minute. The result lands in the group's IPC results
 * dir when the command exits; the agent-side tool polls for it.
 */
export function handleSimulatorRequest(req: SimulatorRequest): void {
  const requestId = (req.requestId ?? '').trim();
  if (!SAFE_REQUEST_ID.test(requestId)) {
    logger.warn(
      { groupFolder: req.groupFolder, requestId },
      'simulator rejected: invalid requestId',
    );
    return; // No safe filename to answer on.
  }

  const action = (req.action ?? '').trim();
  if (!action) {
    refuse(req.groupFolder, requestId, 'no action provided');
    return;
  }

  if (!isSimulatorEnabled(req.groupFolder)) {
    refuse(
      req.groupFolder,
      requestId,
      'simulator access is off for this chat — ask the user to send "/simulator on", then retry',
      action,
    );
    return;
  }

  let planned: Plan;
  try {
    const p = plan(req, requestId);
    if (!p.ok) {
      refuse(req.groupFolder, requestId, p.reason, action);
      return;
    }
    planned = p.plan;
  } catch (err) {
    refuse(
      req.groupFolder,
      requestId,
      `could not prepare action: ${err instanceof Error ? err.message : String(err)}`,
      action,
    );
    return;
  }

  const timeoutMs = Math.min(
    Math.max(
      typeof req.timeoutMs === 'number' && req.timeoutMs > 0
        ? req.timeoutMs
        : DEFAULT_SIM_TIMEOUT_MS,
      1000,
    ),
    MAX_SIM_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  logger.info(
    { groupFolder: req.groupFolder, requestId, action, args: planned.args },
    'Simulator: running action',
  );
  auditLine({ groupFolder: req.groupFolder, requestId, action });

  // Maestro is a JVM app that needs JAVA_HOME / PATH from the login shell,
  // and simctl needs the Xcode developer dir. Inherit the user's environment
  // but never a shell: argv is passed verbatim.
  const child = spawn(planned.bin, planned.args, {
    cwd: planned.outputDir ?? os.homedir(),
    env: {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:${path.dirname(maestroBin())}:/opt/homebrew/bin:/usr/local/bin`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let settled = false;

  const capture = (chunk: string, into: 'out' | 'err') => {
    const current = into === 'out' ? stdout : stderr;
    const room = MAX_STREAM_CHARS - current.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const slice = chunk.length > room ? chunk.slice(0, room) : chunk;
    if (slice.length < chunk.length) truncated = true;
    if (into === 'out') stdout += slice;
    else stderr += slice;
  };

  child.stdout.on('data', (d) => capture(d.toString(), 'out'));
  child.stderr.on('data', (d) => capture(d.toString(), 'err'));

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 5000);
  }, timeoutMs);

  const settle = (exitCode: number | null, error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    const durationMs = Date.now() - startedAt;

    const found: string[] = [];
    if (planned.expectFile && fs.existsSync(planned.expectFile)) {
      found.push(planned.expectFile);
    }
    if (planned.scanDir) found.push(...findPngs(planned.scanDir));

    const result: SimulatorResult = {
      requestId,
      action,
      ok: !error && !timedOut && exitCode === 0,
      exitCode,
      stdout,
      stderr,
      truncated,
      timedOut,
      durationMs,
      screenshots: found.map((f) => toContainerPath(req.groupFolder, f)),
      outputDir: planned.outputDir
        ? toContainerPath(req.groupFolder, planned.outputDir)
        : undefined,
      error: timedOut ? `timed out after ${timeoutMs}ms` : error,
    };
    logger.info(
      {
        groupFolder: req.groupFolder,
        requestId,
        action,
        exitCode,
        timedOut,
        durationMs,
        screenshots: result.screenshots.length,
      },
      'Simulator: action finished',
    );
    auditLine({
      groupFolder: req.groupFolder,
      requestId,
      action,
      exitCode,
      timedOut,
      durationMs,
    });
    writeResult(req.groupFolder, result);
  };

  child.on('error', (err) => settle(null, `failed to spawn: ${err.message}`));
  child.on('close', (code) => settle(code));
}
