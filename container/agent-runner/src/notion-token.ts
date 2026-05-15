/**
 * Notion OAuth token loader/refresher for the container.
 *
 * Reads ~/.config/nanoclaw/notion/oauth.json (mounted at /workspace/secrets/notion/)
 * and returns a fresh access_token. Concurrent containers coordinate via a
 * sibling lockfile + atomic rename so refresh-token rotation can't race.
 *
 * The token file is read/write because access tokens expire (~1h) and we
 * persist the rotated refresh_token back. Re-run `npm run notion-auth` on
 * the host only if the refresh chain breaks (e.g. revoked from Notion UI).
 */

import fs from 'node:fs';

const TOKEN_FILE = '/workspace/secrets/notion/oauth.json';
const LOCK_FILE = '/workspace/secrets/notion/oauth.json.lock';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const STALE_LOCK_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: string;
  scope?: string;
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
  registered_at: string;
  refreshed_at: string;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}

export function notionTokenFileExists(): boolean {
  return fs.existsSync(TOKEN_FILE);
}

function readTokens(): StoredTokens {
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as StoredTokens;
}

function writeTokensAtomic(tokens: StoredTokens): void {
  const tmp = `${TOKEN_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, TOKEN_FILE);
}

function isExpiringSoon(tokens: StoredTokens): boolean {
  if (!tokens.expires_at) return false;
  const expiresMs = new Date(tokens.expires_at).getTime();
  return Date.now() + REFRESH_BUFFER_MS >= expiresMs;
}

async function refresh(tokens: StoredTokens): Promise<StoredTokens> {
  if (!tokens.refresh_token) {
    throw new Error(
      'Notion token has no refresh_token — re-run `npm run notion-auth` on host',
    );
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (tokens.client_secret) {
    const basic = Buffer.from(
      `${tokens.client_id}:${tokens.client_secret}`,
    ).toString('base64');
    headers['authorization'] = `Basic ${basic}`;
  }
  const res = await fetch(tokens.token_endpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Notion token refresh failed: ${res.status} ${res.statusText}\n${text}`,
    );
  }
  const data = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  const now = new Date();
  const expiresAt =
    typeof data.expires_in === 'number'
      ? new Date(now.getTime() + data.expires_in * 1000).toISOString()
      : tokens.expires_at;
  return {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    token_type: data.token_type ?? tokens.token_type,
    expires_at: expiresAt,
    scope: data.scope ?? tokens.scope,
    refreshed_at: now.toISOString(),
  };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let fd: number;
  while (true) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Break stale locks (process crashed before unlinking)
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(LOCK_FILE);
          } catch {
            /* race, retry */
          }
          continue;
        }
      } catch {
        /* race */
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Notion token lock timeout: ${LOCK_FILE}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Returns a current access_token, refreshing under flock if expired/near-expired.
 * Returns null when the token file is absent (Notion not configured for this group).
 */
export async function getNotionAccessToken(): Promise<string | null> {
  if (!notionTokenFileExists()) return null;

  const initial = readTokens();
  if (!isExpiringSoon(initial)) return initial.access_token;

  return withLock(async () => {
    // Re-read inside the lock — another container may have refreshed already
    const fresh = readTokens();
    if (!isExpiringSoon(fresh)) return fresh.access_token;
    const refreshed = await refresh(fresh);
    writeTokensAtomic(refreshed);
    return refreshed.access_token;
  });
}
