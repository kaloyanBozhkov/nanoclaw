import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  return readEnvMatching((key) => keys.includes(key));
}

/**
 * Every `.env` entry whose key starts with `prefix`.
 *
 * `readEnvFile` needs the caller to name each key up front, which can't
 * discover a set that is defined by convention — the org credentials
 * (`ANTHROPIC_ORG_<NAME>_OAUTH_TOKEN`) are declared by simply existing, so
 * there is no second list to keep in sync.
 */
export function readEnvPrefixed(prefix: string): Record<string, string> {
  return readEnvMatching((key) => key.startsWith(prefix));
}

function readEnvMatching(
  wanted: (key: string) => boolean,
): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
