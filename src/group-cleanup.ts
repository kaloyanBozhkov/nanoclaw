/**
 * Hourly sweep of the per-group files nothing else bounds:
 * - logs/container-*.log and logs/run-*.log older than LOG_MAX_AGE_MS
 *   (never the log of a /run that is still going);
 * - images/*.vision.jpg, the resized copies made for the API, after
 *   VISION_COPY_MAX_AGE_MS — originals are kept.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const DAY = 24 * 60 * 60 * 1000;
export const LOG_MAX_AGE_MS = 14 * DAY;
export const VISION_COPY_MAX_AGE_MS = 7 * DAY;

const LOG_FILE = /^(container|run)-.*\.log$/;
const VISION_COPY = /\.vision\.jpg$/;

export interface SweepResult {
  removed: number;
  bytes: number;
}

function sweepDir(
  dir: string,
  pattern: RegExp,
  maxAgeMs: number,
  now: number,
  keep: Set<string>,
  result: SweepResult,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    if (keep.has(file)) continue;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(file);
      result.removed++;
      result.bytes += st.size;
    } catch {
      // Vanished or unreadable — next sweep.
    }
  }
}

/** `keep`: absolute paths in use (logs of runs still going). */
export function sweepGroupFiles(
  groupsDir: string,
  keep: Iterable<string> = [],
  now = Date.now(),
): SweepResult {
  const result: SweepResult = { removed: 0, bytes: 0 };
  const keepSet = new Set(keep);
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(groupsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const base = path.join(groupsDir, g.name);
    sweepDir(
      path.join(base, 'logs'),
      LOG_FILE,
      LOG_MAX_AGE_MS,
      now,
      keepSet,
      result,
    );
    sweepDir(
      path.join(base, 'images'),
      VISION_COPY,
      VISION_COPY_MAX_AGE_MS,
      now,
      keepSet,
      result,
    );
  }
  if (result.removed > 0) {
    logger.info(
      { removed: result.removed, freedKB: Math.round(result.bytes / 1024) },
      'Swept old group logs and image copies',
    );
  }
  return result;
}
