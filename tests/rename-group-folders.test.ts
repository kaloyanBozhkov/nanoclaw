import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { renameGroupFolders } from '../scripts/rename-group-folders.js';

let tmp: string;
let groupsDir: string;
let configFile: string;
let db: Database.Database;

function seed(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT NOT NULL UNIQUE);
    CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL);
    CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO registered_groups VALUES ('mx:!a:x', 'telegram_main'), ('mx:!b:x', 'telegram_linkbase');
    INSERT INTO scheduled_tasks VALUES ('t1', 'telegram_linkbase');
    INSERT INTO sessions VALUES ('telegram_main', 's1');
    INSERT INTO router_state VALUES ('consumed_docs', '{"telegram_main":{"items":[]}}');
  `);
  return d;
}

function run(dryRun = false) {
  return renameGroupFolders({
    db,
    folderDirs: [groupsDir],
    configFiles: [configFile],
    dryRun,
    log: () => {},
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  groupsDir = path.join(tmp, 'groups');
  for (const f of ['telegram_main', 'telegram_linkbase']) {
    fs.mkdirSync(path.join(groupsDir, f), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, f, 'CLAUDE.md'), f);
  }
  configFile = path.join(tmp, 'godmode.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({ groups: { telegram_main: { enabled: true } } }),
  );
  db = seed();
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('renameGroupFolders', () => {
  it('renames DB rows, directories and config keys', () => {
    expect(run()).toEqual([
      ['telegram_linkbase', 'linkbase'],
      ['telegram_main', 'main'],
    ]);
    expect(
      db.prepare('SELECT folder FROM registered_groups ORDER BY folder').all(),
    ).toEqual([{ folder: 'linkbase' }, { folder: 'main' }]);
    expect(
      db.prepare('SELECT group_folder FROM scheduled_tasks').get(),
    ).toEqual({ group_folder: 'linkbase' });
    expect(db.prepare('SELECT group_folder FROM sessions').get()).toEqual({
      group_folder: 'main',
    });
    const consumed = db
      .prepare(`SELECT value FROM router_state WHERE key = 'consumed_docs'`)
      .get() as { value: string };
    expect(Object.keys(JSON.parse(consumed.value))).toEqual(['main']);
    expect(fs.readdirSync(groupsDir).sort()).toEqual(['linkbase', 'main']);
    expect(
      fs.readFileSync(path.join(groupsDir, 'main', 'CLAUDE.md'), 'utf-8'),
    ).toBe('telegram_main');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))).toEqual({
      groups: { main: { enabled: true } },
    });
  });

  it('replaces an empty target directory', () => {
    fs.mkdirSync(path.join(groupsDir, 'main'));
    run();
    expect(fs.readdirSync(groupsDir).sort()).toEqual(['linkbase', 'main']);
  });

  it('aborts before changing anything when a target directory has content', () => {
    fs.mkdirSync(path.join(groupsDir, 'main'));
    fs.writeFileSync(path.join(groupsDir, 'main', 'CLAUDE.md'), 'template');
    expect(() => run()).toThrow(/main already exists/);
    expect(
      db
        .prepare(
          `SELECT count(*) n FROM registered_groups WHERE folder LIKE 'telegram_%'`,
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(fs.existsSync(path.join(groupsDir, 'telegram_main'))).toBe(true);
  });

  it('changes nothing on a dry run', () => {
    run(true);
    expect(fs.readdirSync(groupsDir).sort()).toEqual([
      'telegram_linkbase',
      'telegram_main',
    ]);
    expect(
      db
        .prepare(
          `SELECT count(*) n FROM registered_groups WHERE folder LIKE 'telegram_%'`,
        )
        .get(),
    ).toEqual({ n: 2 });
  });
});
