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

import { OPEN_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

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
}

export interface OpenHostResult {
  ok: boolean;
  reason?: string;
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
