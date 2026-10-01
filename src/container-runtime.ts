/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// ---------------------------------------------------------------------------
// Restart (the /docker-restart chat command)
// ---------------------------------------------------------------------------

const execAsync = promisify(exec);

export interface RuntimeRestartResult {
  ok: boolean;
  /** Server version reported once the daemon answered again. */
  version?: string;
  durationMs: number;
  /** What went wrong, or why it was refused. */
  error?: string;
  /** Human-readable steps taken, for the chat reply. */
  steps: string[];
}

/** Poll timeout while waiting for the daemon to answer after a relaunch. */
export const RUNTIME_RESTART_WAIT_MS = 180_000;

let restartInFlight: Promise<RuntimeRestartResult> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command, never throw — a step that fails is reported, not fatal. */
async function tryRun(cmd: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    await execAsync(cmd, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Wait until `docker version` answers, returning the server version. */
async function waitForDaemon(deadlineMs: number): Promise<string | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execAsync(
        `${CONTAINER_RUNTIME_BIN} version --format '{{.Server.Version}}'`,
        { timeout: 8_000 },
      );
      const v = stdout.trim();
      if (v) return v;
    } catch {
      // Not up yet.
    }
    await sleep(5_000);
  }
  return null;
}

/**
 * Force-restart the container runtime.
 *
 * Exists for the case where Docker Desktop's backend wedges: `docker ps` hangs
 * forever, every container spawn times out, and no agent in any group can
 * respond. A graceful quit does not recover from that — the backend process
 * survives it — so this does the full sequence: ask Docker to quit, kill
 * whatever is left, drop the stale socket, relaunch, and wait for the daemon
 * to answer. Every running agent container dies with it; the message loop
 * rolls their messages back and retries once the daemon is back.
 *
 * macOS / Docker Desktop only for the kill-and-relaunch path. On Linux it
 * falls back to `systemctl restart docker`. Concurrent calls share one
 * restart rather than stacking.
 */
export function restartContainerRuntime(): Promise<RuntimeRestartResult> {
  if (restartInFlight) return restartInFlight;
  restartInFlight = doRestart().finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

async function doRestart(): Promise<RuntimeRestartResult> {
  const startedAt = Date.now();
  const steps: string[] = [];
  const done = (ok: boolean, error?: string, version?: string) => ({
    ok,
    version,
    error,
    durationMs: Date.now() - startedAt,
    steps,
  });

  logger.warn('Container runtime restart requested');

  if (process.platform === 'linux') {
    steps.push('systemctl restart docker');
    if (!(await tryRun('systemctl restart docker', 60_000))) {
      return done(false, 'systemctl restart docker failed');
    }
  } else if (process.platform === 'darwin') {
    steps.push('asked Docker Desktop to quit');
    await tryRun(`osascript -e 'quit app "Docker"'`);
    await sleep(5_000);

    // A wedged backend ignores the quit; this is the part that matters.
    steps.push('killed leftover Docker processes');
    await tryRun(`pkill -9 -f 'com.docker.backend'`);
    await tryRun(`pkill -9 -f 'Docker Desktop.app'`);
    await tryRun(`pkill -9 -f 'Docker.app/Contents/MacOS/Docker'`);
    await sleep(3_000);

    const sock = `${os.homedir()}/.docker/run/docker.sock`;
    try {
      fs.unlinkSync(sock);
      steps.push('removed stale socket');
    } catch {
      // Already gone.
    }

    steps.push('relaunched Docker Desktop');
    if (!(await tryRun('open -a Docker'))) {
      return done(
        false,
        'could not launch Docker Desktop (open -a Docker failed)',
      );
    }
  } else {
    return done(false, `unsupported platform: ${process.platform}`);
  }

  steps.push('waited for the daemon');
  const version = await waitForDaemon(RUNTIME_RESTART_WAIT_MS);
  if (!version) {
    logger.error('Container runtime did not come back after restart');
    return done(
      false,
      `daemon did not answer within ${RUNTIME_RESTART_WAIT_MS / 1000}s`,
    );
  }
  logger.warn({ version }, 'Container runtime restarted');
  return done(true, undefined, version);
}
