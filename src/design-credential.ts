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
 */

import { execFileSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Re-read this often at most, so Claude Code's own refreshes get picked up. */
const CACHE_TTL_MS = 60_000;

export interface DesignCredential {
  accessToken: string;
  expiresAt?: number;
  scopes?: string[];
  /** Where it came from, for logging. */
  source: 'env' | 'keychain';
}

let cache: { value: DesignCredential | null; at: number } | null = null;

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
function extractFromBlob(raw: string): DesignCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidates: Array<Record<string, unknown>> = [];
  const root = parsed as Record<string, unknown>;
  candidates.push(root);
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push(value as Record<string, unknown>);
    }
  }

  for (const c of candidates) {
    const token = c.accessToken;
    if (typeof token !== 'string' || !token) continue;
    if (!hasDesignScope(c.scopes)) continue;
    return {
      accessToken: token,
      expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : undefined,
      scopes: c.scopes as string[],
      source: 'keychain',
    };
  }
  return null;
}

function readFromKeychain(): DesignCredential | null {
  if (os.platform() !== 'darwin') return null;
  try {
    const raw = execFileSync(
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
    return extractFromBlob(raw);
  } catch {
    // Item missing, or the keychain refused access — both mean "no credential".
    return null;
  }
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

  if (value?.expiresAt && value.expiresAt < now) {
    logger.warn(
      { expiredAt: new Date(value.expiresAt).toISOString() },
      'Claude Design credential has expired — run /design-login in Claude Code to refresh it',
    );
  }
  return value;
}

/** Requests that must use the design credential rather than the org secret. */
export function isDesignRequest(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('/v1/design/');
}

/** Drop the cache so the next read hits the keychain. Used by tests. */
export function _resetDesignCredentialCache(): void {
  cache = null;
}
