/**
 * Service log cap.
 *
 * nanoclaw logs to stdout; launchd redirects both stdout and stderr into a
 * single file (StandardOutPath in com.nanoclaw.plist). Nothing bounds it — it
 * had reached 804 MB before this existed, on a disk that filled up and took the
 * whole service down.
 *
 * Rather than rotate (which would need the writer to reopen its fd), this
 * truncates in place and keeps the tail. launchd opens the file with O_APPEND,
 * so the running process keeps writing correctly at the new end. A handful of
 * lines written between the read and the truncate can be lost — acceptable for
 * a log, and far better than an unbounded file.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** Truncate once the log exceeds this. */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** How much of the tail to preserve when truncating. */
const DEFAULT_KEEP_BYTES = 20 * 1024 * 1024;
/** How often to re-check while running. */
export const LOG_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Where launchd is sending our output. `NANOCLAW_LOG_FILE` overrides; otherwise
 * the macOS LaunchAgent path, then the repo-local path used on Linux/systemd.
 */
export function resolveLogFile(): string | null {
  const override = process.env.NANOCLAW_LOG_FILE?.trim();
  if (override) return override;

  const candidates = [
    path.join(os.homedir(), 'Library', 'Logs', 'nanoclaw.log'),
    path.join(process.cwd(), 'logs', 'nanoclaw.log'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // Not this one.
    }
  }
  return null;
}

export interface TrimResult {
  trimmed: boolean;
  before?: number;
  after?: number;
}

/**
 * Trim the log to its last `keepBytes` if it exceeds `maxBytes`.
 * Best-effort throughout: this is housekeeping and must never throw into a
 * timer callback, where an uncaught error would exit the process — the exact
 * failure mode that motivated this file.
 */
export function trimLogIfLarge(
  filePath: string | null = resolveLogFile(),
  maxBytes: number = envBytes('NANOCLAW_LOG_MAX_BYTES', DEFAULT_MAX_BYTES),
  keepBytes: number = envBytes('NANOCLAW_LOG_KEEP_BYTES', DEFAULT_KEEP_BYTES),
): TrimResult {
  if (!filePath) return { trimmed: false };

  try {
    const before = fs.statSync(filePath).size;
    if (before <= maxBytes) return { trimmed: false, before };

    const keep = Math.min(keepBytes, before);
    const buf = Buffer.alloc(keep);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, keep, before - keep);
    } finally {
      fs.closeSync(fd);
    }

    // Drop the partial first line so the tail starts cleanly.
    const nl = buf.indexOf(0x0a);
    const tail = nl >= 0 && nl + 1 < buf.length ? buf.subarray(nl + 1) : buf;

    // Truncate to zero, then write the tail back. The appending writer
    // continues after it rather than re-inflating the file to its old size.
    fs.truncateSync(filePath, 0);
    fs.writeFileSync(filePath, tail);

    const after = fs.statSync(filePath).size;
    logger.info(
      { filePath, beforeMB: Math.round(before / 1048576), afterMB: Math.round(after / 1048576) },
      'Trimmed service log',
    );
    return { trimmed: true, before, after };
  } catch (err) {
    logger.warn({ err, filePath }, 'Could not trim service log');
    return { trimmed: false };
  }
}

/** Check at startup and hourly thereafter. Returns the timer so it can be cleared. */
export function startLogRotation(): NodeJS.Timeout {
  trimLogIfLarge();
  const timer = setInterval(() => trimLogIfLarge(), LOG_CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
