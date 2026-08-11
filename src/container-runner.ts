/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import {
  AGENT_MODEL,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  orgPlaceholder,
  resolveGroupOrg,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Image file paths (container-relative) to pass as vision input */
  images?: string[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Liveness ping during long tool calls — resets timers, no result for the user. */
  heartbeat?: boolean;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Shared blueprints directory (read-write for all containers)
  const blueprintsDir = path.join(os.homedir(), 'Documents', 'blueprints');
  if (fs.existsSync(blueprintsDir)) {
    mounts.push({
      hostPath: blueprintsDir,
      containerPath: '/workspace/blueprints',
      readonly: false,
    });
  }

  // Shared rules directory (read-only for all containers). Holds files like
  // CODE_BIBLE.md that global/CLAUDE.md inlines via `@<file>.md` import markers,
  // resolved by the agent-runner against /workspace/rules.
  const rulesDir = path.join(projectRoot, 'rules');
  if (fs.existsSync(rulesDir)) {
    mounts.push({
      hostPath: rulesDir,
      containerPath: '/workspace/rules',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const desiredSettings = {
    env: {
      // Enable agent swarms (subagent orchestration)
      // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      // Load CLAUDE.md from additional mounted directories
      // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      // Enable Claude's memory feature (persists user preferences between sessions)
      // https://code.claude.com/docs/en/memory#manage-auto-memory
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
    // Auto-approve project MCP servers (.mcp.json) without interactive prompt
    enableAllProjectMcpServers: true,
  };
  // Always overwrite to keep settings in sync with host configuration
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(desiredSettings, null, 2) + '\n',
  );

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Notion OAuth credentials (RW so the container can refresh expiring access tokens
  // under flock — see container/agent-runner/src/notion-token.ts). The whole
  // directory is mounted (not just the JSON) so the lockfile lands on a shared
  // host path and serializes refreshes across concurrent containers. Bypasses
  // additionalMounts allowlist because it's internal nanoclaw infra, not user data.
  if (group.containerConfig?.enableNotion) {
    const notionDir = path.join(os.homedir(), '.config', 'nanoclaw', 'notion');
    const notionTokenFile = path.join(notionDir, 'oauth.json');
    if (fs.existsSync(notionTokenFile)) {
      mounts.push({
        hostPath: notionDir,
        containerPath: '/workspace/secrets/notion',
        readonly: false,
      });
    } else {
      logger.warn(
        { group: group.name },
        'enableNotion=true but ~/.config/nanoclaw/notion/oauth.json missing — run `npm run notion-auth`',
      );
    }
  }

  return mounts;
}

// ---------------------------------------------------------------------------
// Container-side build artifacts (node_modules, .next, pnpm store)
//
// The container never shares these with the host: macOS and Linux need
// different native binaries, so each side owns a full tree materialized from
// the same lockfile. The bind-mounted lockfile (plain text) is the sync point,
// exactly as between two developers on different OSes — a container-side
// install updates package.json/pnpm-lock.yaml in the real repo (reviewable in
// git) while its binaries stay in the container's own tree.
//
// The Linux trees live in one named Docker volume (native ext4 inside the VM),
// mounted over each project's artifact paths via volume subpaths. Compared to
// the bind-mounted shadow directories this replaces, installs run at native
// filesystem speed instead of crossing VirtioFS — which is what turns a
// "lockfile changed, re-link" self-heal from minutes into seconds.
// ---------------------------------------------------------------------------

/** Named volume holding every container-side artifact tree + package caches. */
export const ARTIFACTS_VOLUME = 'nanoclaw-artifacts';

/** Where the shared pnpm store is mounted inside every container. */
export const PNPM_STORE_PATH = '/home/node/.pnpm-store';

export interface ArtifactMount {
  /** Path inside ARTIFACTS_VOLUME (POSIX, relative). */
  subpath: string;
  /** Absolute path inside the container to mount it over. */
  containerPath: string;
}

// Volume-backed caches every container gets regardless of repo layout, so
// package downloads survive across ephemeral containers.
export const FIXED_ARTIFACT_MOUNTS: ArtifactMount[] = [
  { subpath: 'pnpm-store', containerPath: PNPM_STORE_PATH },
  { subpath: 'npm-cache', containerPath: '/home/node/.npm' },
];

// Per-project paths that must never be shared between host and container.
// node_modules holds native binaries; .next is build output that only matches
// the OS that produced it; .pnpm-store is pnpm's same-filesystem fallback
// store — left unshadowed, a pnpm that ignores store-dir (pnpm 11 with
// npm_config_* env) writes gigabytes of cache into the user's checkout.
const ISOLATED_ARTIFACTS = ['node_modules', '.next', '.pnpm-store'];

// Find every project root (dir with a package.json) under a mounted directory,
// so each gets its own isolated artifacts. Skips node_modules/.next/hidden dirs.
//
// This does NOT stop at the first package.json it finds: a workspace monorepo
// has a real node_modules in every package (and in non-workspace subprojects
// like a nested admin SPA that installs itself), and any root we miss stays
// bind-mounted from the host, where the container's linux install then lands.
// Over-shadowing is cheap and safe — an empty node_modules doesn't shadow
// module resolution, since Node keeps walking up when a lookup misses.
export function findProjectRoots(root: string, maxDepth = 4): string[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      roots.push(dir);
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.next') continue;
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return roots;
}

// Keep a configured extra artifact path inside its project (no absolute paths,
// no `..` escapes) so a group's config can't shadow arbitrary host directories.
function safeArtifactPath(rel: string): string | null {
  if (!rel || path.posix.isAbsolute(rel) || path.isAbsolute(rel)) return null;
  const normalized = path.posix.normalize(rel).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..'))
    return null;
  return normalized;
}

// Artifact mounts for one project root. Unconditional — the path is claimed
// even when the host has no such directory yet, otherwise the container's
// first install *creates* it in the user's checkout, which is the exact leak
// this prevents.
function projectArtifactMounts(
  containerProjectDir: string,
  storeKey: string,
  extraArtifacts: string[] = [],
): ArtifactMount[] {
  const names = [...ISOLATED_ARTIFACTS];
  for (const extra of extraArtifacts) {
    const safe = safeArtifactPath(extra);
    if (!safe) {
      logger.warn(
        { artifact: extra, storeKey },
        'Ignoring unsafe isolatedArtifacts entry',
      );
      continue;
    }
    if (!names.includes(safe)) names.push(safe);
  }
  return names.map((name) => ({
    subpath: `${storeKey}/${name}`,
    containerPath: `${containerProjectDir}/${name}`,
  }));
}

// The full artifact-mount set for a container: every project root under the
// user's repos (/workspace/extra/*) and under the group folder gets its own
// container-side artifacts, plus the fixed shared caches. Walking every
// project root matters: a workspace monorepo has a real node_modules in every
// package, and any root missed stays bind-mounted from the host, where the
// container's Linux install would land.
export function collectArtifactMounts(
  mounts: VolumeMount[],
  groupFolder: string,
  extraArtifacts: string[] = [],
): ArtifactMount[] {
  const entries: ArtifactMount[] = [...FIXED_ARTIFACT_MOUNTS];
  const safeGroup = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  for (const mount of mounts) {
    if (mount.readonly) continue;
    const isExtra = mount.containerPath.startsWith('/workspace/extra/');
    const isGroup = mount.containerPath === '/workspace/group';
    if (!isExtra && !isGroup) continue;
    for (const projectDir of findProjectRoots(mount.hostPath)) {
      const rel = path.relative(mount.hostPath, projectDir);
      const relPosix = rel.split(path.sep).join('/');
      const containerProjectDir = relPosix
        ? path.posix.join(mount.containerPath, relPosix)
        : mount.containerPath;
      const storeKey = isExtra
        ? path.posix.join(
            'extra',
            safeGroup,
            path.basename(mount.hostPath),
            relPosix,
          )
        : path.posix.join('groups', safeGroup, relPosix);
      entries.push(
        ...projectArtifactMounts(
          containerProjectDir,
          storeKey,
          // Configured extras are relative to the mounted repo root only.
          isExtra && !rel ? extraArtifacts : [],
        ),
      );
    }
  }
  return entries;
}

// Subpath mounts fail unless the directory already exists inside the volume,
// and the runtime user must own it — so each new subpath gets a one-shot
// mkdir+chown container before first use. Memoized per host process; mkdir -p
// is idempotent, so a restart just re-runs it once.
const ensuredSubpaths = new Set<string>();

export async function ensureArtifactSubpaths(
  entries: ArtifactMount[],
): Promise<void> {
  const pending = entries.filter((e) => !ensuredSubpaths.has(e.subpath));
  if (pending.length === 0) return;

  // Match the ownership the real container runs under (see buildContainerArgs):
  // host uid when it isn't root/node, otherwise the image's node user.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const owner =
    uid != null && uid !== 0 && uid !== 1000 ? `${uid}:${gid}` : '1000:1000';
  const dirs = pending.map((e) => `'/artifacts/${e.subpath}'`).join(' ');
  const script = `mkdir -p ${dirs} && chown ${owner} ${dirs}`;
  // --user 0:0: the image defaults to the node user, which can't mkdir/chown
  // in the root-owned volume top level.
  const cmd = `${CONTAINER_RUNTIME_BIN} run --rm --user 0:0 -v ${ARTIFACTS_VOLUME}:/artifacts --entrypoint bash ${CONTAINER_IMAGE} -c ${JSON.stringify(script)}`;

  await new Promise<void>((resolve, reject) => {
    exec(cmd, { timeout: 60000 }, (err) => (err ? reject(err) : resolve()));
  });
  for (const e of pending) ensuredSubpaths.add(e.subpath);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  model: string,
  artifactMounts: ArtifactMount[] = [],
  orgName?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Model the SDK runs the agent on (read by @anthropic-ai/claude-agent-sdk).
  args.push('-e', `ANTHROPIC_MODEL=${model}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  // The container is handed a routing key, never a credential: the proxy maps
  // `nanoclaw:<org>` to the secret for the identity this chat runs as. Which
  // header carries it depends on that org's auth mode, not the host's.
  const org = resolveGroupOrg(orgName);
  const orgAuthMode = org?.authMode ?? detectAuthMode();
  const credential = org ? orgPlaceholder(org.name) : 'placeholder';
  if (orgAuthMode === 'api-key') {
    args.push('-e', `ANTHROPIC_API_KEY=${credential}`);
  } else {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${credential}`);
  }

  // Pass GitHub token for git/gh CLI access inside containers
  // Prefer live token from `gh auth token` so scope refreshes propagate automatically,
  // fall back to static .env value if gh CLI is unavailable.
  const envSecrets = readEnvFile([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'VERCEL_TOKEN',
    'NPM_TOKEN',
    'GITLAB_TOKEN',
  ]);
  let ghToken = '';
  try {
    ghToken = execSync('gh auth token', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    ghToken = envSecrets.GH_TOKEN || envSecrets.GITHUB_TOKEN || '';
  }
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
  }

  // Pass Vercel token for vercel CLI access inside containers
  const vercelToken = envSecrets.VERCEL_TOKEN || '';
  if (vercelToken) {
    args.push('-e', `VERCEL_TOKEN=${vercelToken}`);
  }

  // Pass npm token for authenticated npm publish/install inside containers
  const npmToken = envSecrets.NPM_TOKEN || '';
  if (npmToken) {
    args.push('-e', `NPM_TOKEN=${npmToken}`);
  }

  // Pass GitLab token for glab CLI access inside containers
  const gitlabToken = envSecrets.GITLAB_TOKEN || '';
  if (gitlabToken) {
    args.push('-e', `GITLAB_TOKEN=${gitlabToken}`);
  }

  // Pass Pencil MCP URL so container agents can connect to host Pencil MCP server
  args.push('-e', `PENCIL_MCP_URL=http://${CONTAINER_HOST_GATEWAY}:3102/mcp`);

  // pnpm 10+ can verify node_modules against the lockfile before `pnpm run`
  // and install when they diverge. With the container's tree on a native-speed
  // volume this IS the sync mechanism: deps change on the host, and the next
  // script run re-links the container tree from the lockfile in seconds.
  args.push('-e', 'npm_config_verify_deps_before_run=install');

  // Keep pnpm's store on the shared artifacts volume, not its same-filesystem
  // fallback (<repo>/.pnpm-store — inside the user's checkout).
  args.push('-e', `npm_config_store_dir=${PNPM_STORE_PATH}`);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Container-side artifact trees (see collectArtifactMounts): volume subpaths
  // mounted over every project's node_modules/.next/.pnpm-store so Linux
  // binaries and caches never land in the user's checkout.
  for (const m of artifactMounts) {
    args.push(
      '--mount',
      `type=volume,src=${ARTIFACTS_VOLUME},dst=${m.containerPath},volume-subpath=${m.subpath}`,
    );
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  // Called once with a fn that reschedules this container's hard runtime cap.
  // `capMs === null` removes the cap. Lets the host live-apply nosleep/yessleep.
  onReschedule?: (reschedule: (capMs: number | null) => void) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Per-group model override (set via /model), falling back to the global default.
  const model = group.containerConfig?.model || AGENT_MODEL;
  // Per-group Anthropic identity (set via /switch); resolved to a routing key
  // inside buildContainerArgs — the secret itself never reaches the container.
  const orgName = group.containerConfig?.org;
  if (orgName && !resolveGroupOrg(orgName)) {
    // Pinned to an identity that is no longer in .env. Refuse rather than fall
    // back — running this chat on a different account is worse than not
    // running it.
    logger.error(
      { group: group.name, org: orgName },
      'Configured Anthropic org is missing from .env — refusing to spawn',
    );
    return {
      status: 'error',
      result: null,
      error: `This chat is set to the Anthropic org "${orgName}", which is no longer configured in .env. Run /org to see what is available, then /switch to one of them.`,
    };
  }
  const artifactMounts = collectArtifactMounts(
    mounts,
    group.folder,
    group.containerConfig?.isolatedArtifacts ?? [],
  );
  // Volume subpaths must exist before the mounts can bind to them.
  await ensureArtifactSubpaths(artifactMounts);
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    model,
    artifactMounts,
    orgName,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // CONTAINER_TIMEOUT is now a HARD CAP — we no longer reset it
            // on activity, so runaway tool-call loops can't keep the
            // container alive beyond its configured max runtime. IDLE_TIMEOUT
            // in index.ts still resets on activity for graceful stdin-close.
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // (CONTAINER_TIMEOUT is now a hard cap; no timer reset happens
      // anywhere, neither here nor on stdout activity.)
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    // Hard cap on total runtime — never reset on activity (see comment in the
    // stdout handler). It IS rescheduable at runtime via `onReschedule`, so the
    // "nosleep"/"yessleep" chat commands can lift or restore the cap on a
    // container that is already running. `capMs === null` means no hard cap at
    // all; only the host idle timeout can then reap the container.
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const rescheduleHardTimer = (capMs: number | null) => {
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (capMs === null) {
        logger.info(
          { group: group.name, containerName },
          'Hard runtime cap disabled (nosleep) — idle timeout still applies',
        );
        return;
      }
      // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
      // graceful _close sentinel has time to trigger before the hard kill fires.
      const ms = Math.max(capMs, IDLE_TIMEOUT + 30_000);
      hardTimer = setTimeout(killOnTimeout, ms);
    };

    const initialCap = group.containerConfig?.noSleep
      ? null
      : group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    rescheduleHardTimer(initialCap);
    onReschedule?.(rescheduleHardTimer);

    container.on('close', (code) => {
      if (hardTimer) clearTimeout(hardTimer);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${duration}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      if (hardTimer) clearTimeout(hardTimer);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
