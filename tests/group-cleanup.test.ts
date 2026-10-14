import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sweepGroupFiles } from '../src/group-cleanup.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
let groups: string;

function file(rel: string, ageDays: number): string {
  const p = path.join(groups, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  groups = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
});
afterEach(() => fs.rmSync(groups, { recursive: true, force: true }));

describe('sweepGroupFiles', () => {
  it('removes logs older than 14 days and keeps newer ones', () => {
    const old = file('linkbase/logs/container-2026-09-01.log', 30);
    const oldRun = file('linkbase/logs/run-2026-09-20-dev.log', 20);
    const fresh = file('linkbase/logs/container-2026-10-10.log', 4);
    const r = sweepGroupFiles(groups, [], NOW);
    expect(r.removed).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldRun)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('never removes the log of a run that is still going', () => {
    const live = file('linkbase/logs/run-2026-09-01-dev-remote.log', 40);
    sweepGroupFiles(groups, [live], NOW);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('removes week-old API image copies but keeps originals', () => {
    const copy = file('main/images/1-IMG.vision.jpg', 8);
    const newCopy = file('main/images/2-IMG.vision.jpg', 2);
    const original = file('main/images/1-IMG.png', 400);
    sweepGroupFiles(groups, [], NOW);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(newCopy)).toBe(true);
    expect(fs.existsSync(original)).toBe(true);
  });

  it('leaves other files in logs/ alone', () => {
    const other = file('main/logs/notes.txt', 100);
    sweepGroupFiles(groups, [], NOW);
    expect(fs.existsSync(other)).toBe(true);
  });
});
