/**
 * Host-side handler for `open_host` IPC requests.
 *
 * Lets container agents ask the host to open a desktop app or URL via the
 * macOS `open` command. Targets are validated against an allowlist stored
 * outside the project root (`~/.config/nanoclaw/open-allowlist.json`) so that
 * a compromised container cannot widen its own permissions.
 *
 * Defaults (when the file is missing) allow only the Pencil desktop app and
 * https://pencil.dev — the original motivating use case.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OPEN_ALLOWLIST_PATH } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { AdditionalMount } from './types.js';

interface OpenAllowlist {
  apps: string[];
  urls: string[];
}

const DEFAULT_ALLOWLIST: OpenAllowlist = {
  apps: ['Pencil'],
  urls: ['https://pencil.dev'],
};

let cachedAllowlist: OpenAllowlist | null = null;

function loadAllowlist(): OpenAllowlist {
  if (cachedAllowlist) return cachedAllowlist;

  try {
    if (fs.existsSync(OPEN_ALLOWLIST_PATH)) {
      const raw = JSON.parse(fs.readFileSync(OPEN_ALLOWLIST_PATH, 'utf-8'));
      const apps = Array.isArray(raw.apps)
        ? raw.apps.filter((s: unknown) => typeof s === 'string')
        : [];
      const urls = Array.isArray(raw.urls)
        ? raw.urls.filter((s: unknown) => typeof s === 'string')
        : [];
      cachedAllowlist = { apps, urls };
      logger.debug(
        { apps: apps.length, urls: urls.length, path: OPEN_ALLOWLIST_PATH },
        'Loaded open-host allowlist',
      );
      return cachedAllowlist;
    }
  } catch (err) {
    logger.warn(
      { err, path: OPEN_ALLOWLIST_PATH },
      'Failed to read open-host allowlist, using defaults',
    );
  }

  cachedAllowlist = DEFAULT_ALLOWLIST;
  return cachedAllowlist;
}

// App names: only letters, digits, spaces, dots, hyphens, underscores.
// Rejects path separators, shell metacharacters, NUL bytes.
const SAFE_APP_NAME = /^[A-Za-z0-9 ._-]+$/;

function isUrlAllowed(url: string, allowed: string[]): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const entry of allowed) {
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(entry);
    } catch {
      continue;
    }
    if (
      allowedUrl.protocol === parsed.protocol &&
      allowedUrl.hostname === parsed.hostname &&
      parsed.pathname.startsWith(allowedUrl.pathname || '/')
    ) {
      return true;
    }
  }
  return false;
}

export interface OpenHostRequest {
  app?: string;
  url?: string;
  filePath?: string;
  groupFolder?: string;
  additionalMounts?: AdditionalMount[];
}

export interface OpenHostResult {
  ok: boolean;
  reason?: string;
}

// File extensions allowed per app. Keep narrow; Pencil only handles .pen.
const APP_FILE_EXTENSIONS: Record<string, string[]> = {
  Pencil: ['.pen'],
};

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Translate a container-style filePath (e.g. /workspace/extra/repo/design.pen,
 * /workspace/group/design.pen) into a host filesystem path using the group's
 * mount table. Host-style paths (absolute or ~) are returned as-is.
 *
 * Returns null if the path can't be mapped to anything we trust.
 */
function resolveContainerPath(
  filePath: string,
  groupFolder: string | undefined,
  additionalMounts: AdditionalMount[] | undefined,
): string | null {
  // Host-style paths
  if (filePath.startsWith('~')) return path.resolve(expandTilde(filePath));

  if (filePath.startsWith('/workspace/group')) {
    if (!groupFolder) return null;
    const rest = filePath.slice('/workspace/group'.length);
    return path.join(resolveGroupFolderPath(groupFolder), rest);
  }

  if (filePath.startsWith('/workspace/blueprints')) {
    const rest = filePath.slice('/workspace/blueprints'.length);
    return path.join(os.homedir(), 'Documents', 'blueprints', rest);
  }

  if (filePath.startsWith('/workspace/extra/')) {
    const after = filePath.slice('/workspace/extra/'.length);
    const slash = after.indexOf('/');
    const subdir = slash === -1 ? after : after.slice(0, slash);
    const rest = slash === -1 ? '' : after.slice(slash);
    for (const m of additionalMounts ?? []) {
      const hostBase = path.resolve(expandTilde(m.hostPath));
      const mountSubdir =
        m.containerPath ?? path.basename(hostBase.replace(/\/+$/, ''));
      if (mountSubdir === subdir) {
        return path.join(hostBase, rest);
      }
    }
    return null;
  }

  // Reject other container-internal namespaces (/home/node, /app, /workspace/project, …).
  // These are container-scratch areas the host shouldn't be opening files from.
  if (
    filePath.startsWith('/workspace/') ||
    filePath.startsWith('/home/node') ||
    filePath.startsWith('/app/')
  ) {
    return null;
  }

  // Bare absolute host path — accept and let downstream existence check decide.
  if (filePath.startsWith('/')) return path.resolve(filePath);

  return null;
}

/**
 * Validate and execute an open-host request.
 * Only runs on macOS; other platforms refuse cleanly.
 */
export async function handleOpenHost(
  req: OpenHostRequest,
): Promise<OpenHostResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      reason: `open_host is only supported on macOS (got ${process.platform})`,
    };
  }

  if (!req.app && !req.url) {
    return { ok: false, reason: 'must provide either "app" or "url"' };
  }
  if (req.app && req.url) {
    return { ok: false, reason: 'provide only one of "app" or "url"' };
  }

  const allowlist = loadAllowlist();

  if (req.app) {
    const app = req.app.trim();
    if (!SAFE_APP_NAME.test(app)) {
      return { ok: false, reason: `unsafe app name: ${JSON.stringify(app)}` };
    }
    if (!allowlist.apps.includes(app)) {
      return {
        ok: false,
        reason: `app "${app}" not in allowlist (${allowlist.apps.join(', ') || 'empty'})`,
      };
    }

    if (req.filePath) {
      const allowedExts = APP_FILE_EXTENSIONS[app];
      if (!allowedExts) {
        return {
          ok: false,
          reason: `filePath not supported for app "${app}"`,
        };
      }
      const ext = path.extname(req.filePath).toLowerCase();
      if (!allowedExts.includes(ext)) {
        return {
          ok: false,
          reason: `file extension "${ext}" not allowed for app "${app}" (allowed: ${allowedExts.join(', ')})`,
        };
      }
      const hostPath = resolveContainerPath(
        req.filePath,
        req.groupFolder,
        req.additionalMounts,
      );
      if (!hostPath) {
        return {
          ok: false,
          reason: `could not map filePath "${req.filePath}" to a host path for group "${req.groupFolder ?? '?'}"`,
        };
      }
      if (!fs.existsSync(hostPath)) {
        return {
          ok: false,
          reason: `file does not exist on host: ${hostPath}`,
        };
      }
      return runOpen(['-a', app, hostPath]);
    }

    return runOpen(['-a', app]);
  }

  // url branch
  const url = req.url!.trim();
  if (!isUrlAllowed(url, allowlist.urls)) {
    return {
      ok: false,
      reason: `url "${url}" not in allowlist`,
    };
  }
  return runOpen([url]);
}

function runOpen(args: string[]): Promise<OpenHostResult> {
  return new Promise((resolve) => {
    // spawn with array args — no shell, no injection risk.
    const child = spawn('open', args, { stdio: 'ignore', detached: false });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `failed to spawn open: ${err.message}` });
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: `open exited with code ${code}` });
      }
    });
  });
}
