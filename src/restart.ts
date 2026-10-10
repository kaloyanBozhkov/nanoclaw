/**
 * `/restart-nanoclaw` support: remember which chat asked, so the next process
 * can say it is back. The restart itself is a clean exit — the service manager
 * (launchd KeepAlive / systemd Restart=always) starts NanoClaw again.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/** An agent container a restart would interrupt. */
export interface RunningAgent {
  name: string;
  folder: string;
  idle: boolean;
  isTask: boolean;
  uptime?: string;
}

const NOTICE_FILE = 'restart-notice.json';

function noticePath(dataDir: string): string {
  return path.join(dataDir, NOTICE_FILE);
}

export function writeRestartNotice(jid: string, dataDir = DATA_DIR): void {
  fs.writeFileSync(
    noticePath(dataDir),
    JSON.stringify({ jid, requestedAt: new Date().toISOString() }),
  );
}

/** The chat that requested the last restart, consumed so it's told only once. */
export function takeRestartNotice(dataDir = DATA_DIR): string | null {
  const file = noticePath(dataDir);
  try {
    const { jid } = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jid?: unknown;
    };
    return typeof jid === 'string' ? jid : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function formatRunningAgents(agents: RunningAgent[]): string {
  return agents
    .map((a) => {
      const state = a.idle ? 'idle' : a.isTask ? 'running a task' : 'busy';
      return `- **${a.name}** — ${state}${a.uptime ? `, up ${a.uptime}` : ''}`;
    })
    .join('\n');
}
