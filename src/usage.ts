/**
 * `/usage` — how much of a subscription org's rate limits are used.
 *
 * Long-lived OAuth tokens (claude setup-token) lack the user:profile scope the
 * usage endpoint needs, but every inference response carries the unified
 * rate-limit headers. So this sends the smallest possible Claude Code-shaped
 * request (1 output token on the cheapest model) and reads them.
 */
import { AnthropicOrg } from './config.js';
import { readEnvFile } from './env.js';

const PROBE_MODEL = 'claude-haiku-5-5';
const HEADER_PREFIX = 'anthropic-ratelimit-unified-';

export interface UsageWindow {
  /** 0–1 share of the window used. */
  utilization: number;
  resetsAt: Date | null;
  status: string | null;
}

export interface OrgUsage {
  status: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Which window is currently the binding one (e.g. five_hour). */
  binding: string | null;
  overageStatus: string | null;
}

function windowFrom(h: Headers, key: string): UsageWindow | null {
  const util = h.get(`${HEADER_PREFIX}${key}-utilization`);
  if (util === null) return null;
  const reset = Number(h.get(`${HEADER_PREFIX}${key}-reset`));
  return {
    utilization: Number(util),
    resetsAt:
      Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
    status: h.get(`${HEADER_PREFIX}${key}-status`),
  };
}

export function parseUsageHeaders(h: Headers): OrgUsage | null {
  const usage: OrgUsage = {
    status: h.get(`${HEADER_PREFIX}status`),
    fiveHour: windowFrom(h, '5h'),
    sevenDay: windowFrom(h, '7d'),
    binding: h.get(`${HEADER_PREFIX}representative-claim`),
    overageStatus: h.get(`${HEADER_PREFIX}overage-status`),
  };
  return usage.status || usage.fiveHour || usage.sevenDay ? usage : null;
}

export async function fetchOrgUsage(
  org: AnthropicOrg,
  fetchImpl: typeof fetch = fetch,
): Promise<OrgUsage> {
  if (org.authMode !== 'oauth') {
    throw new Error(
      'This org uses an API key — it has no subscription limits to show.',
    );
  }
  const env = readEnvFile([org.envKey, 'ANTHROPIC_BASE_URL']);
  const token = env[org.envKey];
  if (!token) throw new Error(`${org.envKey} is not set in .env`);
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'content-type': 'application/json',
      'x-app': 'cli',
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
      ],
      messages: [{ role: 'user', content: '.' }],
    }),
  });
  // A 429 still carries the headers — that's exactly when they matter most.
  const usage = parseUsageHeaders(res.headers);
  if (!usage) {
    throw new Error(
      `No usage information returned (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return usage;
}

function pct(u: number): string {
  return `${Math.round(u * 100)}%`;
}

function bar(u: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(u * 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function untilText(when: Date, now: Date): string {
  const mins = Math.max(
    0,
    Math.round((when.getTime() - now.getTime()) / 60000),
  );
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowLine(
  label: string,
  w: UsageWindow | null,
  now: Date,
  timeZone: string,
): string {
  if (!w) return `- **${label}:** not reported`;
  const reset = w.resetsAt
    ? ` — resets in ${untilText(w.resetsAt, now)} (${w.resetsAt.toLocaleString('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' })})`
    : '';
  const limited = w.status && w.status !== 'allowed' ? ` ⚠️ ${w.status}` : '';
  return `- **${label}:** ${bar(w.utilization)} ${pct(w.utilization)} used, ${pct(Math.max(0, 1 - w.utilization))} left${reset}${limited}`;
}

export function formatUsage(
  orgName: string,
  usage: OrgUsage,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const lines = [
    `📊 **Usage — ${orgName}**`,
    windowLine('5-hour window', usage.fiveHour, now, timeZone),
    windowLine('Weekly', usage.sevenDay, now, timeZone),
  ];
  if (usage.status && usage.status !== 'allowed') {
    lines.push(`\n⚠️ Currently **${usage.status}**.`);
  }
  if (usage.overageStatus === 'allowed') {
    lines.push('Extra usage beyond the plan is enabled.');
  }
  return lines.join('\n');
}
