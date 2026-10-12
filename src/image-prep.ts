/**
 * Shrink an incoming photo for the model. Element X can send full-resolution
 * originals (and iPhones produce HEIC), but the API rejects images over 5MB
 * base64 and gains nothing above ~1568px on the long edge. The original stays
 * on disk for the agent to use as a file; the model gets a JPEG copy.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/** Long edge the API already scales images down to. */
export const VISION_MAX_EDGE = 1568;
/** 5MB base64 ≈ 3.75MB raw; stay clear of it. */
export const VISION_MAX_BYTES = 3.5 * 1024 * 1024;

const PASSTHROUGH_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * Path of an image the API will accept: a resized JPEG beside the original
 * (`<name>.vision.jpg`), the original itself when it is already small and in a
 * supported format, or null when neither is possible.
 */
export function prepareForVision(src: string): string | null {
  const ext = path.extname(src).toLowerCase();
  const dest = `${src.slice(0, src.length - ext.length)}.vision.jpg`;
  try {
    execFileSync(
      'sips',
      [
        '-Z',
        String(VISION_MAX_EDGE),
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '85',
        src,
        '--out',
        dest,
      ],
      { stdio: 'pipe', timeout: 30_000 },
    );
    if (fs.statSync(dest).size <= VISION_MAX_BYTES) return dest;
    logger.warn({ src }, 'Resized image still too large for the API');
  } catch (err) {
    logger.warn(
      { src, err: err instanceof Error ? err.message : String(err) },
      'Image resize failed',
    );
  }
  const small =
    PASSTHROUGH_EXT.has(ext) && fs.statSync(src).size <= VISION_MAX_BYTES;
  return small ? src : null;
}
