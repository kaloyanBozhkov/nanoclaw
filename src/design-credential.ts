/**
 * Claude Design credential.
 *
 * `/design-login` does NOT add design scopes to the long-lived token that
 * `claude setup-token` mints — that token is issued with a fixed scope set.
 * Instead it stores a **separate** credential alongside the main login:
 *
 *   Claude Code-credentials → { claudeAiOauth: {...}, designOauth: {...} }
 *                                                     └─ user:design:read/write
 *
 * So `/v1/design/*` needs a different credential from every other API call.
 * This module sources it, and the credential proxy routes design traffic to it.
 *
 * Unlike the per-org secrets in `.env`, this is one machine-level credential:
 * design access does not vary by /switch, because the grant is per claude.ai
 * login, not per org.
 *
 * The design access token is short-lived (~8h). Claude Code only refreshes it
 * when Claude Code itself is used, so a quiet night left NanoClaw sending a dead
 * token and every container's design MCP 401'd on connect. We therefore refresh
 * it ourselves with the stored refresh token — the same OAuth request Claude
 * Code makes — and write the rotated tokens back to the keychain so Claude Code
 * keeps working off the same credential.
 */

import { execFile, execFileSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Re-read this often at most, so Claude Code's own refreshes get picked up. */
const CACHE_TTL_MS = 60_000;
/** Claude Code's OAuth token endpoint (`TOKEN_URL` in the CLI bundle). */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/**
 * Refresh this long before expiry. Claude Code refreshes only once a token is
 * (nearly) expired, so getting in well ahead means it finds a fresh token and
 * leaves it alone instead of racing us with the same refresh token.
 */
const REFRESH_MARGIN_MS = 10 * 60_000;
/** After a failed refresh, don't retry on every design request. */
const FAILURE_BACKOFF_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

export interface DesignCredential {
  accessToken: string;
  expiresAt?: number;
  scopes?: string[];
  /** Present for keychain credentials; needed to refresh. */
  refreshToken?: string;
  clientId?: string;
  /** Key of the entry inside the keychain blob (normally `designOauth`). */
  blobKey?: string;
  /** Where it came from, for logging. */
  source: 'env' | 'keychain';
}

let cache: { value: DesignCredential | null; at: number } | null = null;
let inflight: Promise<DesignCredential | null> | null = null;
let lastFailureAt = 0;

function hasDesignScope(scopes: unknown): boolean {
  return (
    Array.isArray(scopes) &&
    scopes.some((s) => typeof s === 'string' && s.startsWith('user:design:'))
  );
}

/**
 * Pull the design credential out of the credentials blob. Written defensively:
 * the design grant has lived under different keys across CLI versions, so any
 * nested object carrying a `user:design:*` scope and an access token counts.
 */
export function extractFromBlob(raw: string): DesignCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidates: Array<[string | undefined, Record<string, unknown>]> = [];
  const root = parsed as Record<string, unknown>;
  candidates.push([undefined, root]);
  for (const [key, value] of Object.entries(root)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push([key, value as Record<string, unknown>]);
    }
  }

  for (const [key, c] of candidates) {
    const token = c.accessToken;
    if (typeof token !== 'string' || !token) continue;
    if (!hasDesignScope(c.scopes)) continue;
    return {
      accessToken: token,
      expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : undefined,
      scopes: c.scopes as string[],
      refreshToken:
        typeof c.refreshToken === 'string' && c.refreshToken
          ? c.refreshToken
          : undefined,
      clientId: typeof c.clientId === 'string' ? c.clientId : undefined,
      blobKey: key,
      source: 'keychain',
    };
  }
  return null;
}

function readKeychainBlob(): string | null {
  if (os.platform() !== 'darwin') return null;
  try {
    return execFileSync(
      'security',
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        os.userInfo().username,
        '-w',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
  } catch {
    // Item missing, or the keychain refused access — both mean "no credential".
    return null;
  }
}

function readFromKeychain(): DesignCredential | null {
  const raw = readKeychainBlob();
  return raw ? extractFromBlob(raw) : null;
}

/** `security -i` reads commands into a fixed line buffer. */
const SECURITY_STDIN_LIMIT = 4000;

/**
 * Overwrite the keychain blob, the same way Claude Code does: hex-encoded over
 * stdin (`security -i`) so the secret stays out of the process list, falling
 * back to argv when the payload is too long for `security -i`'s line buffer.
 */
function writeKeychainBlob(raw: string): Promise<void> {
  const hex = Buffer.from(raw, 'utf-8').toString('hex');
  const account = os.userInfo().username;
  const command = `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
  const viaStdin = command.length <= SECURITY_STDIN_LIMIT;
  const args = viaStdin
    ? ['-i']
    : [
        'add-generic-password',
        '-U',
        '-a',
        account,
        '-s',
        KEYCHAIN_SERVICE,
        '-X',
        hex,
      ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'security',
      args,
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`security failed: ${stderr || err}`));
        else if (stderr && /error/i.test(stderr))
          reject(new Error(`security: ${stderr.trim()}`));
        else resolve();
      },
    );
    child.stdin?.end(viaStdin ? command : undefined);
  });
}

/**
 * The design credential, or null when `/design-login` has never run.
 *
 * `CLAUDE_CODE_DESIGN_OAUTH_TOKEN` in the environment wins when set — an escape
 * hatch for Linux hosts and for anyone who would rather not have the service
 * touch the keychain at all.
 */
export function getDesignCredential(): DesignCredential | null {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const fromEnv = process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN?.trim();
  const value: DesignCredential | null = fromEnv
    ? { accessToken: fromEnv, source: 'env' }
    : readFromKeychain();

  cache = { value, at: now };

  if (value?.expiresAt && value.expiresAt < now && !canRefresh(value)) {
    logger.warn(
      { expiredAt: new Date(value.expiresAt).toISOString() },
      'Claude Design credential has expired — run /design-login in Claude Code to refresh it',
    );
  }
  return value;
}

function canRefresh(cred: DesignCredential): boolean {
  return (
    cred.source === 'keychain' &&
    !!cred.refreshToken &&
    !!cred.clientId &&
    !!cred.blobKey
  );
}

export function needsRefresh(
  cred: DesignCredential,
  now = Date.now(),
): boolean {
  return (
    canRefresh(cred) &&
    cred.expiresAt !== undefined &&
    cred.expiresAt - now < REFRESH_MARGIN_MS
  );
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function requestRefresh(cred: DesignCredential): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      client_id: cred.clientId,
      scope: (cred.scopes ?? []).join(' '),
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // non-JSON body; status is enough
    }
    throw new Error(
      `token refresh HTTP ${res.status}${detail ? ` (${detail})` : ''}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function refresh(
  stale: DesignCredential,
  force = false,
): Promise<DesignCredential | null> {
  // Re-read first: Claude Code may have refreshed since our cache was filled.
  // Refreshing with an already-rotated refresh token would fail, or worse.
  const current = readFromKeychain();
  if (!current) return null;
  if (!canRefresh(current)) return current;
  if (!force && !needsRefresh(current)) {
    cache = { value: current, at: Date.now() };
    return current;
  }

  const data = await requestRefresh(current);
  if (!data.access_token || !data.expires_in) {
    throw new Error('token refresh response missing access_token/expires_in');
  }
  const grantedScopes = data.scope?.split(' ').filter(Boolean);
  const scopes =
    grantedScopes && grantedScopes.length
      ? grantedScopes.filter((s) => s.startsWith('user:design:'))
      : (current.scopes ?? []);
  if (!hasDesignScope(scopes)) {
    throw new Error('token refresh response lost the design scopes');
  }

  const next: DesignCredential = {
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes,
  };

  // Compare-and-swap against the keychain: only write if nobody rotated the
  // refresh token while our request was in flight. If someone did, theirs is
  // the one of record — ours is still a valid access token for this process.
  const raw = readKeychainBlob();
  const blob = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  const entry = blob?.[current.blobKey!] as Record<string, unknown> | undefined;
  if (!blob || !entry || entry.refreshToken !== current.refreshToken) {
    logger.info(
      'Claude Design token was refreshed elsewhere mid-flight; using the stored one',
    );
    const stored = raw ? extractFromBlob(raw) : null;
    const winner = stored && !needsRefresh(stored) ? stored : next;
    cache = { value: winner, at: Date.now() };
    return winner;
  }

  blob[current.blobKey!] = {
    ...entry,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
    scopes: next.scopes,
  };
  try {
    await writeKeychainBlob(JSON.stringify(blob));
  } catch (err) {
    // The refresh token may have rotated, so Claude Code's copy could now be
    // dead. Keep serving from memory and say how to recover.
    logger.error(
      { err },
      'Claude Design token refreshed but could not be saved to the keychain — ' +
        'if Claude Code then reports design login errors, run /design-login',
    );
  }

  cache = { value: next, at: Date.now() };
  logger.info(
    {
      expiresAt: new Date(next.expiresAt!).toISOString(),
      was: stale.expiresAt,
    },
    'Claude Design token refreshed',
  );
  return next;
}

/**
 * The design credential, refreshed first if it is expired or about to be.
 * Never throws: on failure it returns whatever credential it has, so the
 * request still goes out and the upstream error reaches the caller.
 */
export async function getFreshDesignCredential(): Promise<DesignCredential | null> {
  const cred = getDesignCredential();
  if (!cred || !needsRefresh(cred)) return cred;
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return cred;

  if (!inflight) {
    inflight = refresh(cred)
      .catch((err) => {
        lastFailureAt = Date.now();
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Claude Design token refresh failed — if this persists, run /design-login in Claude Code',
        );
        return cred;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Refresh now regardless of expiry. For manual verification
 * (`npx tsx -e "import('./src/design-credential.ts').then(m => m.forceDesignRefresh())"`).
 */
export async function forceDesignRefresh(): Promise<DesignCredential | null> {
  const cred = readFromKeychain();
  return cred ? refresh(cred, true) : null;
}

/** Requests that must use the design credential rather than the org secret. */
export function isDesignRequest(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('/v1/design/');
}

/** Drop the cache so the next read hits the keychain. Used by tests. */
export function _resetDesignCredentialCache(): void {
  cache = null;
  inflight = null;
  lastFailureAt = 0;
}
