/**
 * `/run <script>` — run a project's package.json script on the host, outside
 * the agent container, the way the owner would from their own terminal.
 *
 * Scripts are found in every package.json under the group's mounted project
 * folders. Each run is a detached process group (so a stop takes its children
 * too) with stdin closed, its full output in the group's logs/ folder and the
 * last lines kept for the chat.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';
import { AdditionalMount } from './types.js';

/** Directories never searched for package.json. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.expo',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.pnpm-store',
  'Pods',
]);
const MAX_DEPTH = 4;
const TAIL_LINES = 40;
/** A dev server can run for days; past this the file stops growing. */
export const RUN_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** Script names are passed as arguments, but keep them to sane characters. */
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.@/+-]*$/;

export function isValidScriptName(name: string): boolean {
  return SCRIPT_NAME.test(name) && name.length <= 100;
}

const MAX_ARGS_LENGTH = 2000;

/**
 * Split `/run` input into the script name and its arguments, shell-style:
 * "double" and 'single' quotes group words, backslash escapes the next
 * character. Phone keyboards' curly double quotes count as straight ones. A leading
 * `--` before the arguments is dropped (it's added back where npm needs it).
 */
export function parseRunInput(
  input: string,
): { script: string; args: string[] } | { error: string } {
  if (input.length > MAX_ARGS_LENGTH) return { error: 'Arguments too long.' };
  // Curly double quotes are quotes; curly apostrophes stay literal — phones
  // put them in ordinary words (it’s), where they must not open a quote.
  const text = input.replace(/[\u201C\u201D\u201E]/g, '"');
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length)
        cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      cur += text[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) {
    return {
      error:
        quote === "'"
          ? 'Unclosed \' quote. Wrap text containing an apostrophe in "double quotes".'
          : 'Unclosed " quote.',
    };
  }
  if (inToken) tokens.push(cur);
  const [script = '', ...args] = tokens;
  if (args[0] === '--') args.shift();
  return { script, args };
}

/** `<pm> run <script> [args]` argv; npm needs `--` before script arguments. */
export function runArgv(pm: string, script: string, args: string[]): string[] {
  if (args.length === 0) return [pm, 'run', script];
  return pm === 'npm'
    ? [pm, 'run', script, '--', ...args]
    : [pm, 'run', script, ...args];
}

/** How the command reads in chat, e.g. pnpm run update:prod "release notes". */
export function displayCommand(argv: string[]): string {
  return argv
    .map((a) =>
      /^[\w:.@/=+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`,
    )
    .join(' ');
}

export interface ScriptLocation {
  /** Absolute package directory. */
  dir: string;
  /** Path shown to the user, e.g. `linkbase/backend`. */
  label: string;
  /** The script's command line, for context. */
  command: string;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

/** Writable project mounts — where a group's code lives on the host. */
export function projectRoots(mounts: AdditionalMount[] = []): string[] {
  return mounts
    .filter((m) => m.readonly === false)
    .map((m) => expandHome(m.hostPath))
    .filter((p) => fs.existsSync(p));
}

function packageJsons(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      out.push(path.join(dir, 'package.json'));
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (
        e.isDirectory() &&
        !SKIP_DIRS.has(e.name) &&
        !e.name.startsWith('.')
      ) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function scriptsOf(pkgJson: string): Record<string, string> {
  try {
    const scripts = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')).scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

function labelFor(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  return rel ? `${path.basename(root)}/${rel}` : path.basename(root);
}

/** Every package under the roots that defines `script`. */
export function findScript(roots: string[], script: string): ScriptLocation[] {
  const found: ScriptLocation[] = [];
  for (const root of roots) {
    for (const pkg of packageJsons(root)) {
      const command = scriptsOf(pkg)[script];
      if (typeof command !== 'string') continue;
      const dir = path.dirname(pkg);
      found.push({ dir, label: labelFor(root, dir), command });
    }
  }
  return found;
}

/** Every script under the roots, grouped by package label. */
export function listScripts(roots: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of roots) {
    for (const pkg of packageJsons(root)) {
      const names = Object.keys(scriptsOf(pkg));
      if (names.length) out.set(labelFor(root, path.dirname(pkg)), names);
    }
  }
  return out;
}

/** The package manager owning `dir`: nearest lockfile up to `stopAt`. */
export function packageManagerFor(dir: string, stopAt: string): string {
  let cur = dir;
  for (;;) {
    if (fs.existsSync(path.join(cur, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(cur, 'yarn.lock'))) return 'yarn';
    if (
      fs.existsSync(path.join(cur, 'bun.lock')) ||
      fs.existsSync(path.join(cur, 'bun.lockb'))
    ) {
      return 'bun';
    }
    if (fs.existsSync(path.join(cur, 'package-lock.json'))) return 'npm';
    const parent = path.dirname(cur);
    if (cur === stopAt || parent === cur || !cur.startsWith(stopAt)) break;
    cur = parent;
  }
  return 'npm';
}

export interface HostRun {
  id: number;
  chatJid: string;
  script: string;
  label: string;
  logFile: string;
  startedAt: Date;
  proc: ChildProcess;
  tail: string[];
  exitCode: number | null;
  /** Signal name when stopped rather than exited. */
  signal: string | null;
  done: boolean;
}

export interface StartRunOptions {
  chatJid: string;
  script: string;
  label: string;
  cwd: string;
  logFile: string;
  /** Executable + args. Defaults to `<pm> run <script> [args]` in a login shell. */
  command?: [string, ...string[]];
  packageManager?: string;
  /** Arguments passed through to the script. */
  args?: string[];
  onLine?: (run: HostRun, line: string) => void;
  onExit?: (run: HostRun) => void;
}

const runs = new Map<number, HostRun>();
let nextId = 1;

export function startRun(opts: StartRunOptions): HostRun {
  // A login shell gives the owner's PATH (nvm, pnpm, Homebrew) and env, as if
  // typed in their terminal. The command goes in as positional parameters
  // ($0 "$@") — never spliced into the shell string, so arguments can't inject.
  const [bin, ...args] = opts.command ?? [
    process.env.SHELL || '/bin/zsh',
    '-lc',
    'exec "$0" "$@"',
    ...runArgv(opts.packageManager ?? 'npm', opts.script, opts.args ?? []),
  ];
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const log = fs.createWriteStream(opts.logFile, { flags: 'a' });
  const proc = spawn(bin, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  // Numbering restarts once nothing is running, so ids stay small.
  if (runs.size === 0) nextId = 1;
  const run: HostRun = {
    id: nextId++,
    chatJid: opts.chatJid,
    script: opts.script,
    label: opts.label,
    logFile: opts.logFile,
    startedAt: new Date(),
    proc,
    tail: [],
    exitCode: null,
    signal: null,
    done: false,
  };
  runs.set(run.id, run);

  let partial = '';
  let logged = 0;
  const onData = (chunk: Buffer) => {
    if (logged < RUN_LOG_MAX_BYTES) {
      logged += chunk.length;
      log.write(chunk);
      if (logged >= RUN_LOG_MAX_BYTES) {
        log.write(
          `\n[log capped at ${RUN_LOG_MAX_BYTES / 1048576} MB — /inspect still shows the latest lines]\n`,
        );
      }
    }
    const text = partial + chunk.toString('utf-8');
    const lines = text.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const raw of lines) {
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      run.tail.push(line);
      if (run.tail.length > TAIL_LINES) run.tail.shift();
      opts.onLine?.(run, line);
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (run.done) return;
    if (partial) {
      run.tail.push(partial);
      if (run.tail.length > TAIL_LINES) run.tail.shift();
      partial = '';
    }
    run.done = true;
    run.exitCode = code;
    run.signal = signal;
    log.end();
    runs.delete(run.id);
    opts.onExit?.(run);
  };
  proc.on('close', finish);
  proc.on('error', (err) => {
    run.tail.push(`Failed to start: ${err.message}`);
    finish(127, null);
  });
  logger.info(
    {
      chatJid: opts.chatJid,
      script: opts.script,
      cwd: opts.cwd,
      pid: proc.pid,
    },
    'Host run started',
  );
  return run;
}

export function activeRuns(chatJid?: string): HostRun[] {
  return [...runs.values()].filter((r) => !chatJid || r.chatJid === chatJid);
}

/** SIGTERM the whole process group, then SIGKILL if it lingers. */
export function stopRun(run: HostRun, graceMs = 5000): void {
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (run.proc.pid) process.kill(-run.proc.pid, sig);
    } catch {
      /* already gone */
    }
  };
  kill('SIGTERM');
  const t = setTimeout(() => {
    if (!run.done) kill('SIGKILL');
  }, graceMs);
  t.unref();
}

export function stopAllRuns(): void {
  for (const run of runs.values()) stopRun(run, 2000);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** URLs worth surfacing from dev-server output (local, tunnels, Expo). */
export function urlsIn(line: string): string[] {
  return (line.match(/\b(?:https?|exp|exps):\/\/[^\s'"<>)\]]+/g) ?? []).map(
    (u) => u.replace(/[.,;:]+$/, ''),
  );
}
