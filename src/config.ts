import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'CONTAINER_IMAGE',
  'CREDENTIAL_PROXY_PORT',
  'ANTHROPIC_MODEL',
  'OWNER_IDS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const OPEN_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'open-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ||
  envConfig.CONTAINER_IMAGE ||
  'nanoclaw-agent:latest';
// HARD CAP on container runtime in ms. 30 min default. Unlike IDLE_TIMEOUT,
// this does NOT reset on activity — a runaway agent loop producing constant
// output still gets killed at exactly this duration from container start.
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || envConfig.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    envConfig.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3101',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || envConfig.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_CONTAINERS ||
      envConfig.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Model the container agent runs on. Override via ANTHROPIC_MODEL in .env;
// defaults to the latest Claude Fable. Passed to the SDK as a container env var.
export const AGENT_MODEL =
  process.env.ANTHROPIC_MODEL ||
  envConfig.ANTHROPIC_MODEL ||
  'claude-fable-5';

// Sender IDs treated as the owner for privileged chat commands (e.g. switching
// the model). Comma-separated in OWNER_IDS. For Telegram this is the numeric
// user ID (ctx.from.id) — NOT the @username. Telegram bot messages are always
// is_from_me:false, so owner MUST be identified by sender ID, not is_from_me.
export const OWNER_IDS = new Set(
  (process.env.OWNER_IDS || envConfig.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** True if a message is from the owner (own-account message, or an OWNER_IDS sender). */
export function isOwnerSender(sender: string, isFromMe: boolean): boolean {
  return isFromMe || OWNER_IDS.has(sender);
}

// Models selectable per-chat via the /models and /model commands. The list
// order is stable — the numbers shown by /models are 1-based indexes into it.
// Keep only known-good model IDs here so a switch can't set an invalid model.
export interface ModelChoice {
  alias: string; // short handle, e.g. "opus"
  id: string; // exact API model ID passed to the SDK
  label: string; // human-friendly name shown in chat
}

export const AVAILABLE_MODELS: ModelChoice[] = [
  { alias: 'opus', id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { alias: 'opus-1m', id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { alias: 'fable', id: 'claude-fable-5', label: 'Fable 5' },
  { alias: 'sonnet', id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { alias: 'haiku', id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/**
 * Resolve a /model argument to a known model. Accepts a 1-based index
 * ("2"), an alias ("fable"), an exact ID, or a label (case-insensitive,
 * prefix match). Returns null if nothing matches.
 */
export function resolveModelChoice(arg: string): ModelChoice | null {
  const a = arg.trim();
  if (!a) return null;
  if (/^\d+$/.test(a)) {
    return AVAILABLE_MODELS[parseInt(a, 10) - 1] ?? null;
  }
  const lower = a.toLowerCase();
  return (
    AVAILABLE_MODELS.find(
      (m) =>
        m.alias.toLowerCase() === lower ||
        m.id.toLowerCase() === lower ||
        m.label.toLowerCase() === lower,
    ) ??
    AVAILABLE_MODELS.find(
      (m) =>
        m.alias.toLowerCase().startsWith(lower) ||
        m.label.toLowerCase().startsWith(lower),
    ) ??
    null
  );
}

/** Label for a model ID, falling back to the raw ID if not in the list. */
export function modelLabel(id: string): string {
  return AVAILABLE_MODELS.find((m) => m.id === id)?.label ?? id;
}
