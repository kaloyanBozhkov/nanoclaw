/**
 * `/tools` — per-chat on/off switches for the optional MCP servers the agent
 * runner wires up (container/agent-runner/src/index.ts, `mcpServers`).
 *
 * Stored in the group's containerConfig.tools (persisted like /model). Notion
 * keeps its older `enableNotion` flag as the fallback so existing chats keep
 * their state, and the flag also gates its credential mount. The nanoclaw
 * server itself is core (chat I/O) and can't be turned off.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { RegisteredGroup } from './types.js';

export interface McpToolInfo {
  /** Server key in the runner's mcpServers, and the /tools argument. */
  id: string;
  label: string;
  description: string;
  defaultOn: boolean;
  /**
   * Approximate tokens for all of the server's tool schemas, measured from
   * session transcripts on 2026-10-07 when every schema was sent up front
   * (~3.5 chars/token, calibrated against the API's reported usage). With
   * tool search on, this is only paid for the tools the agent actually loads.
   */
  approxTokens: number;
}

export const TOGGLEABLE_MCP: McpToolInfo[] = [
  {
    id: 'notion',
    label: 'Notion',
    description: 'pages, databases, comments',
    defaultOn: false,
    approxTokens: 77000,
  },
  {
    id: 'design',
    label: 'Claude Design',
    description: 'design projects and assets',
    defaultOn: false,
    approxTokens: 13000,
  },
  {
    id: 'pencil',
    label: 'Pencil',
    description: '.pen design files',
    defaultOn: false,
    approxTokens: 8000,
  },
  {
    id: 'playwright',
    label: 'Playwright',
    description: 'headless browser automation',
    defaultOn: false,
    approxTokens: 7000,
  },
  {
    id: 'context7',
    label: 'Context7',
    description: 'library documentation lookup',
    defaultOn: true,
    approxTokens: 2000,
  },
];

/** The always-on nanoclaw server, measured the same way. */
const NANOCLAW_APPROX_TOKENS = 7000;

function formatTokens(n: number): string {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `~${n}`;
}

export const NOTION_TOKEN_FILE = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'notion',
  'oauth.json',
);

export function findMcpTool(id: string): McpToolInfo | undefined {
  const key = id.trim().toLowerCase();
  return TOGGLEABLE_MCP.find(
    (t) => t.id === key || t.label.toLowerCase() === key,
  );
}

export function isMcpEnabled(group: RegisteredGroup, id: string): boolean {
  const info = findMcpTool(id);
  if (!info) return true;
  const explicit = group.containerConfig?.tools?.[info.id];
  if (typeof explicit === 'boolean') return explicit;
  if (info.id === 'notion') return group.containerConfig?.enableNotion === true;
  return info.defaultOn;
}

/** Server keys the runner must leave out for this group. */
export function disabledMcpServers(group: RegisteredGroup): string[] {
  return TOGGLEABLE_MCP.filter((t) => !isMcpEnabled(group, t.id)).map(
    (t) => t.id,
  );
}

/** The group with one server switched; keeps enableNotion in step. */
export function withMcpSetting(
  group: RegisteredGroup,
  id: string,
  enabled: boolean,
): RegisteredGroup {
  const info = findMcpTool(id);
  if (!info) return group;
  const containerConfig = {
    ...group.containerConfig,
    tools: { ...group.containerConfig?.tools, [info.id]: enabled },
    ...(info.id === 'notion' ? { enableNotion: enabled } : {}),
  };
  return { ...group, containerConfig };
}

/**
 * Tools a /new session starts without — everything that's off by default, so
 * a reset returns the chat to the defaults. /tools <name> on brings one back.
 */
export const OFF_AFTER_RESET = TOGGLEABLE_MCP.filter((t) => !t.defaultOn).map(
  (t) => t.id,
);

/**
 * The group with OFF_AFTER_RESET switched off, plus the labels of the ones
 * that were on (empty when nothing changed).
 */
export function withResetToolDefaults(group: RegisteredGroup): {
  group: RegisteredGroup;
  switchedOff: string[];
} {
  let next = group;
  const switchedOff: string[] = [];
  for (const id of OFF_AFTER_RESET) {
    if (isMcpEnabled(next, id)) {
      next = withMcpSetting(next, id, false);
      switchedOff.push(findMcpTool(id)!.label);
    }
  }
  return { group: next, switchedOff };
}

/** Reminder appended to every /new confirmation. */
export function formatResetToolsNote(
  group: RegisteredGroup,
  switchedOff: string[],
): string {
  const on = TOGGLEABLE_MCP.filter((t) => isMcpEnabled(group, t.id)).map(
    (t) => t.id,
  );
  const lines = [
    '',
    `🧰 Tools are off for this new session${on.length ? ` except ${on.join(', ')}` : ''}.${
      switchedOff.length
        ? ` (Just switched off: ${switchedOff.join(', ')}.)`
        : ''
    }`,
    'Check /tools and turn on what you need, e.g. /tools notion on.',
  ];
  return lines.join('\n');
}

/** Why a server can't be turned on right now, or null. */
export function mcpUnavailableReason(id: string): string | null {
  if (findMcpTool(id)?.id === 'notion' && !fs.existsSync(NOTION_TOKEN_FILE)) {
    return 'Notion isn’t connected on this Mac yet — run `npm run notion-auth` in the nanoclaw folder first.';
  }
  return null;
}

export function formatToolsStatus(group: RegisteredGroup): string {
  const lines = ['🧰 Tools for this chat', ''];
  for (const t of TOGGLEABLE_MCP) {
    const on = isMcpEnabled(group, t.id);
    lines.push(
      `${on ? '🟢' : '⚪️'} ${t.id} (${formatTokens(t.approxTokens)} tokens) — ${t.label}: ${t.description}`,
    );
  }
  lines.push(
    `🔒 nanoclaw (${formatTokens(NANOCLAW_APPROX_TOKENS)} tokens) — chat & scheduling: always on`,
  );
  lines.push(
    '',
    'Token sizes are the full cost if every tool in a server is loaded. With tool search, a tool costs next to nothing until the agent actually uses it.',
    'Change with /tools <name> on|off (owner only). Applies from your next message.',
  );
  return lines.join('\n');
}
