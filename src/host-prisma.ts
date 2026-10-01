/**
 * Regenerate Prisma clients on the host (the user's Mac) after agent work.
 *
 * Container-side, generated Prisma clients are isolated in the artifacts
 * volume (container-runner.ts), so the agent's `prisma generate` never touches
 * the Mac copy. What's left is the agent *changing schema.prisma*: then the
 * Mac client is stale. After each finished agent turn the host checks every
 * schema in the chat's writable repos and, if its content changed since the
 * host last generated, runs `prisma generate` for it.
 *
 * The agent can't make this do anything but that:
 *  - It never asks: the host decides, after a turn ends. No IPC, no arguments.
 *  - Fixed argv: `<node> <repo>/node_modules/prisma/build/index.js generate
 *    --schema <file>`, via execFile (no shell). Never a package.json script.
 *  - The Prisma CLI comes from the Mac's node_modules, which the container
 *    can't see or write (it gets its own volume-backed node_modules).
 *  - Schemas can run code two ways, both refused: a generator `provider` that
 *    names a program (only prisma-client / prisma-client-js run), and a
 *    prisma.config.* file (executed by the CLI; any one present → refuse).
 *    Generator outputs must stay inside the repo.
 *  - Prisma loads the repo's .env files, which the agent can edit, and env
 *    vars there can redirect the engine binary or its download mirror. Every
 *    such var is pinned (to empty) in a minimal env; dotenv never overrides a
 *    var that's already set, so the .env values are ignored.
 *  - Timeout, one run per schema at a time.
 */
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { HOST_PRISMA_STATE_PATH } from './config.js';
import { logger } from './logger.js';
import {
  generatorOutputDir,
  PRISMA_CONFIG_FILES,
  PrismaSchema,
  readPrismaSchemas,
} from './prisma-schema.js';

export const ALLOWED_PRISMA_PROVIDERS = ['prisma-client-js', 'prisma-client'];
const GENERATE_TIMEOUT_MS = 180_000;
const DEBOUNCE_MS = 3_000;
const MAX_ERROR_CHARS = 600;

/** A writable repo mounted into the chat's containers. */
export interface HostRepo {
  /** Name the agent sees: /workspace/extra/<name>. */
  name: string;
  /** Repo root on the host. */
  repoRoot: string;
  /** Project roots (dirs with package.json) under repoRoot. */
  projectDirs: string[];
}

type Notifier = (chatJid: string, text: string) => void;
let notifier: Notifier | null = null;

/** Where sync results go (a chat message). Set once at startup. */
export function setHostPrismaNotifier(fn: Notifier): void {
  notifier = fn;
}

// ---------------------------------------------------------------------------
// State: schema hash at last successful host generate
// ---------------------------------------------------------------------------

interface HostPrismaState {
  schemas: Record<string, { hash: string; generatedAt: string }>;
}

function readState(): HostPrismaState {
  try {
    const raw = JSON.parse(fs.readFileSync(HOST_PRISMA_STATE_PATH, 'utf-8'));
    if (raw && typeof raw.schemas === 'object') return raw;
  } catch {
    // Missing → everything counts as changed, which just means one generate.
  }
  return { schemas: {} };
}

function recordGenerated(schemaPath: string, hash: string): void {
  const state = readState();
  state.schemas[schemaPath] = { hash, generatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(HOST_PRISMA_STATE_PATH), { recursive: true });
  const tmp = `${HOST_PRISMA_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, HOST_PRISMA_STATE_PATH);
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why this schema must not be generated on the host, or null if it's safe. */
export function refusalReason(
  schema: PrismaSchema,
  repoRoot: string,
): string | null {
  for (const gen of schema.generators) {
    if (!gen.provider || !ALLOWED_PRISMA_PROVIDERS.includes(gen.provider)) {
      return `generator "${gen.name}" uses provider ${gen.provider ? `"${gen.provider}"` : '(not a plain string)'} — only ${ALLOWED_PRISMA_PROVIDERS.join(' / ')} are run on your Mac`;
    }
    if (gen.outputDynamic) {
      return `generator "${gen.name}" has a non-literal output path`;
    }
    const out = generatorOutputDir(schema.schemaPath, gen);
    if (out && !isInside(repoRoot, out)) {
      return `generator "${gen.name}" writes outside the repo (${gen.output})`;
    }
  }
  const dirs = new Set([
    schema.projectDir,
    path.dirname(schema.schemaPath),
    repoRoot,
  ]);
  for (const dir of dirs) {
    for (const name of PRISMA_CONFIG_FILES) {
      if (fs.existsSync(path.join(dir, name))) {
        return `${path.relative(repoRoot, path.join(dir, name)) || name} exists — the Prisma CLI runs it as code, so it's never run automatically`;
      }
    }
  }
  return null;
}

/**
 * The Mac's own Prisma CLI entry point: nearest node_modules/prisma walking up
 * from the project to the repo root. Must resolve inside the repo.
 */
export function findPrismaCli(
  projectDir: string,
  repoRoot: string,
): string | null {
  let dir = projectDir;
  for (;;) {
    const candidate = path.join(
      dir,
      'node_modules',
      'prisma',
      'build',
      'index.js',
    );
    try {
      const real = fs.realpathSync(candidate);
      if (isInside(fs.realpathSync(repoRoot), real)) return real;
    } catch {
      // Not here.
    }
    if (dir === repoRoot || !isInside(repoRoot, dir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Env vars a repo .env could use to make the CLI load or fetch other code. */
const PINNED_EMPTY = [
  'PRISMA_QUERY_ENGINE_LIBRARY',
  'PRISMA_QUERY_ENGINE_BINARY',
  'PRISMA_SCHEMA_ENGINE_BINARY',
  'PRISMA_MIGRATION_ENGINE_BINARY',
  'PRISMA_FMT_BINARY',
  'PRISMA_ENGINES_MIRROR',
  'PRISMA_BINARIES_MIRROR',
  'PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING',
  'PRISMA_CLI_BINARY_TARGETS',
  'PRISMA_CLI_QUERY_ENGINE_TYPE',
  'PRISMA_CLIENT_ENGINE_TYPE',
  'PRISMA_SCHEMA_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
];

export function generateEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    CHECKPOINT_DISABLE: '1',
  };
  for (const key of PINNED_EMPTY) env[key] = '';
  return env;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function runGenerate(
  cli: string,
  schemaPath: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, 'generate', '--schema', schemaPath],
      {
        cwd,
        env: generateEnv(),
        timeout: GENERATE_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() }),
    );
  });
}

const running = new Set<string>();
// Refusals repeat every turn until the user acts — say it once per content.
const notifiedRefusals = new Set<string>();

function notify(chatJid: string, text: string): void {
  try {
    notifier?.(chatJid, text);
  } catch (err) {
    logger.warn({ err }, 'Host Prisma notifier failed');
  }
}

export type SyncStatus =
  | 'generated'
  | 'unchanged'
  | 'refused'
  | 'no-cli'
  | 'failed'
  | 'busy';

export interface SyncOutcome {
  /** `<repo>/<project path>`, as shown in chat. */
  label: string;
  status: SyncStatus;
  /** Refusal reason or the tail of the CLI's output on failure. */
  detail?: string;
}

export interface SyncOptions {
  /**
   * Manual run (/prisma-db-generate): generate even when the schema is
   * unchanged, and leave reporting to the caller instead of the notifier.
   */
  force?: boolean;
}

/**
 * Check every schema in the chat's repos and generate the ones that changed
 * (or all of them, with `force`). Same checks either way.
 */
export async function syncHostPrisma(
  chatJid: string,
  repos: HostRepo[],
  { force = false }: SyncOptions = {},
): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  const state = readState();
  for (const repo of repos) {
    for (const projectDir of repo.projectDirs) {
      for (const schema of readPrismaSchemas(projectDir)) {
        if (schema.generators.length === 0) continue;
        const { schemaPath } = schema;
        const label = path.posix.join(
          repo.name,
          path.relative(repo.repoRoot, projectDir).split(path.sep).join('/'),
        );

        if (running.has(schemaPath)) {
          outcomes.push({ label, status: 'busy' });
          continue;
        }

        let hash: string;
        try {
          hash = hashFile(schemaPath);
        } catch {
          continue;
        }
        if (!force && state.schemas[schemaPath]?.hash === hash) {
          outcomes.push({ label, status: 'unchanged' });
          continue;
        }

        const refusal = refusalReason(schema, repo.repoRoot);
        if (refusal) {
          outcomes.push({ label, status: 'refused', detail: refusal });
          logger.warn({ schemaPath, refusal }, 'Host Prisma generate refused');
          const key = `${schemaPath}:${hash}`;
          if (!force && !notifiedRefusals.has(key)) {
            notifiedRefusals.add(key);
            notify(
              chatJid,
              `⚠️ The Prisma schema in ${label} changed, but I didn't regenerate it on your Mac: ${refusal}. Run db:generate yourself if you trust it.`,
            );
          }
          continue;
        }

        const cli = findPrismaCli(projectDir, repo.repoRoot);
        if (!cli) {
          outcomes.push({ label, status: 'no-cli' });
          logger.debug(
            { schemaPath },
            'No host Prisma CLI (deps not installed on the Mac) — skipping',
          );
          continue;
        }

        running.add(schemaPath);
        try {
          const firstSync = !state.schemas[schemaPath];
          logger.info(
            { schemaPath, force },
            'Regenerating Prisma client on host',
          );
          const result = await runGenerate(cli, schemaPath, projectDir);
          if (result.ok) {
            recordGenerated(schemaPath, hash);
            outcomes.push({ label, status: 'generated' });
            if (!force) {
              notify(
                chatJid,
                `🔄 Regenerated the Prisma client on your Mac for ${label}${firstSync ? '' : ' (schema changed)'}.`,
              );
            }
          } else {
            const detail = result.output.slice(-MAX_ERROR_CHARS);
            outcomes.push({ label, status: 'failed', detail });
            logger.warn(
              { schemaPath, output: result.output.slice(-2000) },
              'Host Prisma generate failed',
            );
            if (!force) {
              notify(
                chatJid,
                `⚠️ Couldn't regenerate the Prisma client on your Mac for ${label}:\n${detail}`,
              );
            }
          }
        } finally {
          running.delete(schemaPath);
        }
      }
    }
  }
  return outcomes;
}

/** Chat summary for a manual /prisma-db-generate run. */
export function formatSyncOutcomes(outcomes: SyncOutcome[]): string {
  if (outcomes.length === 0) {
    return '🔍 No Prisma schemas found in the repos mounted in this chat.';
  }
  const lines = ['🔄 Prisma generate on your Mac', ''];
  for (const o of outcomes) {
    switch (o.status) {
      case 'generated':
        lines.push(`✅ ${o.label} — regenerated`);
        break;
      case 'unchanged':
        lines.push(`➖ ${o.label} — unchanged`);
        break;
      case 'busy':
        lines.push(`⏳ ${o.label} — already running, try again in a moment`);
        break;
      case 'no-cli':
        lines.push(
          `⚠️ ${o.label} — Prisma isn't installed on your Mac (run pnpm install there first)`,
        );
        break;
      case 'refused':
        lines.push(`🚫 ${o.label} — not run: ${o.detail}`);
        break;
      case 'failed':
        lines.push(`❌ ${o.label} — failed:\n${o.detail}`);
        break;
    }
  }
  return lines.join('\n');
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced sync after an agent turn ends. `repos` is a thunk so the
 * filesystem walk happens once per burst, not per streamed result.
 */
export function scheduleHostPrismaSync(
  chatJid: string,
  repos: () => HostRepo[],
): void {
  const existing = timers.get(chatJid);
  if (existing) clearTimeout(existing);
  timers.set(
    chatJid,
    setTimeout(() => {
      timers.delete(chatJid);
      syncHostPrisma(chatJid, repos()).catch((err) =>
        logger.error({ err, chatJid }, 'Host Prisma sync failed'),
      );
    }, DEBOUNCE_MS),
  );
}
