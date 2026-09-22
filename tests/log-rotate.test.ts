import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveLogFile, trimLogIfLarge } from '../src/log-rotate.js';

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-log-'));
  logFile = path.join(dir, 'nanoclaw.log');
  delete process.env.NANOCLAW_LOG_FILE;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NANOCLAW_LOG_FILE;
});

const write = (lines: number) =>
  fs.writeFileSync(
    logFile,
    Array.from({ length: lines }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n'),
  );

describe('trimLogIfLarge', () => {
  it('leaves a log under the cap alone', () => {
    write(10);
    const before = fs.statSync(logFile).size;
    const r = trimLogIfLarge(logFile, 1_000_000, 1000);
    expect(r.trimmed).toBe(false);
    expect(fs.statSync(logFile).size).toBe(before);
  });

  it('trims a log over the cap down to the keep size', () => {
    write(5000);
    const before = fs.statSync(logFile).size;
    const r = trimLogIfLarge(logFile, 10_000, 5000);
    expect(r.trimmed).toBe(true);
    const after = fs.statSync(logFile).size;
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(5000);
  });

  it('keeps the tail, not the head — recent entries are what matter', () => {
    write(5000);
    trimLogIfLarge(logFile, 10_000, 5000);
    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('line 4999');
    expect(content).not.toContain('line 0 ');
  });

  it('starts on a clean line boundary, not mid-entry', () => {
    write(5000);
    trimLogIfLarge(logFile, 10_000, 5000);
    const first = fs.readFileSync(logFile, 'utf-8').split('\n')[0];
    // A partial leading line would not match the full "line N xxx..." shape.
    expect(first === '' || /^line \d+ x+$/.test(first)).toBe(true);
  });

  it('is a no-op for a missing file rather than throwing', () => {
    expect(() => trimLogIfLarge(path.join(dir, 'nope.log'), 10, 5)).not.toThrow();
    expect(trimLogIfLarge(path.join(dir, 'nope.log'), 10, 5).trimmed).toBe(false);
  });

  it('is a no-op when no log file can be resolved', () => {
    expect(trimLogIfLarge(null).trimmed).toBe(false);
  });
});

describe('resolveLogFile', () => {
  it('honours the env override', () => {
    process.env.NANOCLAW_LOG_FILE = '/tmp/custom-nanoclaw.log';
    expect(resolveLogFile()).toBe('/tmp/custom-nanoclaw.log');
  });

  it('returns a path or null, never throws', () => {
    const r = resolveLogFile();
    expect(r === null || typeof r === 'string').toBe(true);
  });
});
