/**
 * Git safety — per-group switch, host-side.
 *
 * When on (the default for every group), the container agent works in the
 * user's real checkout on whatever branch is checked out there: no worktrees,
 * no branch switching, nothing that hides or discards the user's uncommitted
 * work. The rules are injected into the agent's system prompt and enforced by
 * a PreToolUse hook in the agent runner (container/agent-runner/src/git-safety.ts).
 *
 * The switch lives at ~/.config/nanoclaw/git-safety.json — outside the project
 * root, never mounted into a container — so the agent cannot turn its own
 * guard off. It is read when a container starts; `/git-safety on|off` closes
 * the running container so the next message picks up the new setting.
 */
import fs from 'fs';
import path from 'path';

import { GIT_SAFETY_STATE_PATH } from './config.js';
import { logger } from './logger.js';

/** Per-group git-safety record. */
export interface GitSafetyEntry {
  enabled: boolean;
  /** ISO timestamp of the last change ('' when never changed). */
  changedAt: string;
  /** Sender ID that made the last change. */
  changedBy: string;
}

interface GitSafetyState {
  groups: Record<string, GitSafetyEntry>;
}

function readState(): GitSafetyState {
  try {
    const raw = JSON.parse(fs.readFileSync(GIT_SAFETY_STATE_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.groups !== 'object') {
      return { groups: {} };
    }
    const groups: Record<string, GitSafetyEntry> = {};
    for (const [folder, value] of Object.entries(
      raw.groups as Record<string, unknown>,
    )) {
      const e = value as Partial<GitSafetyEntry> | null;
      if (!e || typeof e !== 'object') continue;
      groups[folder] = {
        // Only an explicit `false` turns it off.
        enabled: e.enabled !== false,
        changedAt: typeof e.changedAt === 'string' ? e.changedAt : '',
        changedBy: typeof e.changedBy === 'string' ? e.changedBy : '',
      };
    }
    return { groups };
  } catch {
    // Missing or unreadable state means on — the safe direction to fail.
    return { groups: {} };
  }
}

export function getGitSafetyStatus(groupFolder: string): GitSafetyEntry {
  return (
    readState().groups[groupFolder] ?? {
      enabled: true,
      changedAt: '',
      changedBy: '',
    }
  );
}

export function isGitSafetyEnabled(groupFolder: string): boolean {
  return getGitSafetyStatus(groupFolder).enabled;
}

/** Flip the switch for one group. Throws if the state file can't be written. */
export function setGitSafety(
  groupFolder: string,
  enabled: boolean,
  changedBy: string,
): GitSafetyEntry {
  const state = readState();
  const entry: GitSafetyEntry = {
    enabled,
    changedAt: new Date().toISOString(),
    changedBy,
  };
  state.groups[groupFolder] = entry;

  fs.mkdirSync(path.dirname(GIT_SAFETY_STATE_PATH), { recursive: true });
  const tmp = `${GIT_SAFETY_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, GIT_SAFETY_STATE_PATH);

  logger.warn(
    { groupFolder, enabled, changedBy },
    enabled ? 'Git safety enabled' : 'Git safety DISABLED',
  );
  return entry;
}
