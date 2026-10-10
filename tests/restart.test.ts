import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  formatRunningAgents,
  takeRestartNotice,
  writeRestartNotice,
} from '../src/restart.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('restart notice', () => {
  it('hands the requesting chat to the next process exactly once', () => {
    writeRestartNotice('mx:!room:x', dir);
    expect(takeRestartNotice(dir)).toBe('mx:!room:x');
    expect(takeRestartNotice(dir)).toBeNull();
  });

  it('is null when there was no restart request or the file is garbage', () => {
    expect(takeRestartNotice(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'restart-notice.json'), 'nope');
    expect(takeRestartNotice(dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'restart-notice.json'))).toBe(false);
  });
});

describe('formatRunningAgents', () => {
  it('lists each agent with its state and uptime', () => {
    expect(
      formatRunningAgents([
        {
          name: 'Linkbase',
          folder: 'linkbase',
          idle: false,
          isTask: false,
          uptime: '3m',
        },
        { name: 'Main', folder: 'main', idle: true, isTask: false },
        { name: 'Zele', folder: 'zele', idle: false, isTask: true },
      ]),
    ).toBe(
      '- **Linkbase** — busy, up 3m\n- **Main** — idle\n- **Zele** — running a task',
    );
  });
});
