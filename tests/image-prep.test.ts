import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sips = vi.hoisted(() => ({ outBytes: 1000, fail: false }));
vi.mock('child_process', () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    if (sips.fail) throw new Error('sips: unsupported');
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(sips.outBytes));
    return Buffer.from('');
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prepareForVision, VISION_MAX_BYTES } from '../src/image-prep.js';

let dir: string;
function image(name: string, bytes: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  sips.outBytes = 1000;
  sips.fail = false;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('prepareForVision', () => {
  it('returns a resized JPEG beside the original', () => {
    const src = image('IMG_1.png', 7_000_000);
    expect(prepareForVision(src)).toBe(path.join(dir, 'IMG_1.vision.jpg'));
    expect(fs.existsSync(src)).toBe(true);
  });

  it('falls back to a small original in a supported format', () => {
    sips.fail = true;
    const src = image('small.jpg', 200_000);
    expect(prepareForVision(src)).toBe(src);
  });

  it('gives up on a large or unsupported original it cannot convert', () => {
    sips.fail = true;
    expect(prepareForVision(image('big.jpg', VISION_MAX_BYTES + 1))).toBeNull();
    expect(prepareForVision(image('photo.heic', 100_000))).toBeNull();
  });

  it('rejects a conversion that is still too large', () => {
    sips.outBytes = VISION_MAX_BYTES + 1;
    expect(prepareForVision(image('huge.png', 9_000_000))).toBeNull();
  });
});
