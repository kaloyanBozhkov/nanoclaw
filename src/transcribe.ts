import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WHISPER_MODEL_PATH = path.join(
  process.cwd(),
  'data',
  'models',
  'ggml-base.en.bin',
);

/**
 * Transcribe a voice note using local whisper-cli.
 * Telegram and Element X both send OGG/Opus — convert to 16kHz WAV first.
 * Deletes the input file and the intermediate WAV either way.
 */
export function transcribeVoice(audioPath: string): string {
  const wavPath = audioPath.replace(/\.[^./]+$/, '') + '.wav';
  try {
    // Convert to 16kHz mono WAV (required by whisper-cli)
    execSync(
      `/opt/homebrew/bin/ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`,
      { timeout: 15000, stdio: 'pipe' },
    );

    const output = execSync(
      `/opt/homebrew/bin/whisper-cli -m "${WHISPER_MODEL_PATH}" -f "${wavPath}" --no-timestamps -np`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    return output.trim();
  } finally {
    try {
      fs.unlinkSync(audioPath);
    } catch {}
    try {
      fs.unlinkSync(wavPath);
    } catch {}
  }
}
