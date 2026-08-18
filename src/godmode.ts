/**
 * Godmode — host terminal access for the main chat.
 *
 * The container agent already has an unrestricted shell *inside* its own Linux
 * VM. Godmode is about the other side of that boundary: when it is on, the
 * agent can ask the host to run a command on the user's actual machine, as the
 * user, with no sandbox. That is the whole point, and also why it is off by
 * default and toggled only by an explicit `/godmode on` from the owner.
 *
 * The switch lives at ~/.config/nanoclaw/godmode.json — outside the project
 * root, never mounted into a container — for the same reason the mount and
 * open allowlists do: a container has write access to its group folder AND to
 * its own agent-runner source, so any flag it can reach is a flag it can flip.
 * The host is the authority, and it re-reads the file on every request: turning
 * godmode off revokes a container that is already running, mid-session.
 *
 * Requests arrive as `host_exec` IPC files. Results go back as JSON under the
 * group's own IPC namespace (`ipc/results/<requestId>.json`), which is how the
 * agent gets stdout back — every other IPC type is fire-and-forget.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GODMODE_STATE_PATH } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { resolveContainerPath } from './open-host.js';
import type { AdditionalMount } from './types.js';

/** Per-group godmode record. */
export interface GodModeEntry {
  enabled: boolean;
  /** ISO timestamp of the last change. */
  changedAt: string;
  /** Sender ID that made the last change. */
  changedBy: string;
}

interface GodModeState {
  groups: Record<string, GodModeEntry>;
}

/**
 * Read the switch from disk.
 *
 * Always builds a fresh object: setGodMode mutates what this returns, and a
 * shared fallback would carry that mutation into later reads — an "off" file
 * would then answer "on", which is the one direction this must never fail in.
 */
function readState(): GodModeState {
  try {
    const raw = JSON.parse(fs.readFileSync(GODMODE_STATE_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.groups !== 'object') {
      return { groups: {} };
    }
    const groups: Record<string, GodModeEntry> = {};
    for (const [folder, value] of Object.entries(
      raw.groups as Record<string, unknown>,
    )) {
      const e = value as Partial<GodModeEntry> | null;
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

/**
 * Godmode status for a group. Never cached: `/godmode off` has to take effect
 * on the very next command, including one already queued by a live container.
 */
export function getGodModeStatus(groupFolder: string): GodModeEntry {
  return (
    readState().groups[groupFolder] ?? {
      enabled: false,
      changedAt: '',
      changedBy: '',
    }
  );
}

export function isGodModeEnabled(groupFolder: string): boolean {
  return getGodModeStatus(groupFolder).enabled;
}

/** Flip the switch for one group. Throws if the state file can't be written. */
export function setGodMode(
  groupFolder: string,
  enabled: boolean,
  changedBy: string,
): GodModeEntry {
  const state = readState();
  const entry: GodModeEntry = {
    enabled,
    changedAt: new Date().toISOString(),
    changedBy,
  };
  state.groups[groupFolder] = entry;

  fs.mkdirSync(path.dirname(GODMODE_STATE_PATH), { recursive: true });
  const tmp = `${GODMODE_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, GODMODE_STATE_PATH);

  logger.warn(
    { groupFolder, enabled, changedBy },
    enabled
      ? 'Godmode ENABLED — host shell access granted'
      : 'Godmode disabled',
  );
  return entry;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Default per-command wall clock, and the ceiling a caller can ask for. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
/** Per-stream capture cap. Output beyond this is dropped and flagged. */
export const MAX_STREAM_CHARS = 100_000;
/** Result files older than this are swept when the next result is written. */
const RESULT_TTL_MS = 60 * 60 * 1000;

/** Request ids name a file, so keep them to characters that can't traverse. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface HostExecRequest {
  requestId?: string;
  command?: string;
  /** Host path, `~`-path, or a container path this group has mounted. */
  cwd?: string;
  timeoutMs?: number;
  /** Verified from the IPC directory the request arrived in. */
  groupFolder: string;
  /** Verified from the registered-group table, not from the request. */
  isMain: boolean;
  additionalMounts?: AdditionalMount[];
}

export interface HostExecResult {
  requestId: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  cwd?: string;
  /** Set when the request was refused or never started. */
  error?: string;
}

function auditLine(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DATA_DIR, 'godmode-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to append godmode audit line');
  }
}

/** Drop result files the container never collected (it died, or timed out). */
function sweepStaleResults(dir: string): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > RESULT_TTL_MS) fs.unlinkSync(p);
      } catch {
        // Raced with the container collecting it — nothing to do.
      }
    }
  } catch {
    // Directory not there yet; the write below creates it.
  }
}

function writeResult(groupFolder: string, result: HostExecResult): void {
  let dir: string;
  try {
    dir = path.join(resolveGroupIpcPath(groupFolder), 'results');
  } catch (err) {
    logger.error(
      { err, groupFolder },
      'Cannot resolve IPC results dir for host_exec',
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
      'Failed to write host_exec result',
    );
  }
}

function refuse(
  groupFolder: string,
  requestId: string,
  reason: string,
  command?: string,
): void {
  logger.warn({ groupFolder, requestId, command, reason }, 'host_exec refused');
  auditLine({ groupFolder, requestId, command, refused: reason });
  writeResult(groupFolder, {
    requestId,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: 0,
    error: reason,
  });
}

/**
 * Resolve the working directory for a command.
 *
 * Container paths are translated through this group's mounts, so an agent can
 * pass the path it actually sees. Unlike the rest of godmode this is a
 * convenience, not a boundary: a command is free to `cd` anywhere once it runs.
 */
function resolveCwd(
  req: HostExecRequest,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!req.cwd) return { ok: true, cwd: process.cwd() };

  const resolved = resolveContainerPath(
    req.cwd,
    req.groupFolder,
    req.additionalMounts,
  );
  if (!resolved) {
    return {
      ok: false,
      reason: `cwd "${req.cwd}" is container-only — the host can't see it. Pass a host path, or a mounted /workspace/group | /workspace/extra path.`,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, reason: `cwd does not exist on host: ${resolved}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `cwd is not a directory: ${resolved}` };
  }
  return { ok: true, cwd: resolved };
}

/** The shell a command runs in — the user's own, as a login shell for PATH. */
function shellFor(): string {
  return process.env.SHELL || '/bin/zsh';
}

/**
 * Run one host command on behalf of a container, if godmode allows it.
 *
 * Returns as soon as the child is spawned — the IPC watcher processes requests
 * serially, and a five-minute build would otherwise stall every other group's
 * messages. The result lands in the group's IPC results dir when the command
 * exits; the agent-side tool polls for it.
 */
export function handleHostExec(req: HostExecRequest): void {
  const requestId = (req.requestId ?? '').trim();
  if (!SAFE_REQUEST_ID.test(requestId)) {
    logger.warn(
      { groupFolder: req.groupFolder, requestId },
      'host_exec rejected: invalid requestId',
    );
    return; // No safe filename to answer on.
  }

  const command = (req.command ?? '').trim();
  if (!command) {
    refuse(req.groupFolder, requestId, 'no command provided');
    return;
  }

  // Two independent gates: the chat must be the main one, and godmode must be
  // on for it. isMain comes from the host's registered-group table, never the
  // request body.
  if (!req.isMain) {
    refuse(
      req.groupFolder,
      requestId,
      'host commands are only available from the main chat',
      command,
    );
    return;
  }
  if (!isGodModeEnabled(req.groupFolder)) {
    refuse(
      req.groupFolder,
      requestId,
      'godmode is off — ask the user to send "/godmode on" in the main chat, then retry',
      command,
    );
    return;
  }

  const cwdResult = resolveCwd(req);
  if (!cwdResult.ok) {
    refuse(req.groupFolder, requestId, cwdResult.reason, command);
    return;
  }
  const cwd = cwdResult.cwd;

  const timeoutMs = Math.min(
    Math.max(
      typeof req.timeoutMs === 'number' && req.timeoutMs > 0
        ? req.timeoutMs
        : DEFAULT_EXEC_TIMEOUT_MS,
      1000,
    ),
    MAX_EXEC_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  logger.warn(
    { groupFolder: req.groupFolder, requestId, command, cwd, timeoutMs },
    'Godmode: running host command',
  );
  auditLine({ groupFolder: req.groupFolder, requestId, command, cwd });

  const child = spawn(shellFor(), ['-lc', command], {
    cwd,
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

  // SIGTERM first; a shell that ignores it still gets 5s to wind down.
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
    const result: HostExecResult = {
      requestId,
      ok: !error && !timedOut && exitCode === 0,
      exitCode,
      stdout,
      stderr,
      truncated,
      timedOut,
      durationMs,
      cwd,
      error: timedOut ? `timed out after ${timeoutMs}ms` : error,
    };
    logger.info(
      {
        groupFolder: req.groupFolder,
        requestId,
        exitCode,
        timedOut,
        durationMs,
      },
      'Godmode: host command finished',
    );
    auditLine({
      groupFolder: req.groupFolder,
      requestId,
      exitCode,
      timedOut,
      durationMs,
    });
    writeResult(req.groupFolder, result);
  };

  child.on('error', (err) => settle(null, `failed to spawn: ${err.message}`));
  child.on('close', (code) => settle(code));
}
