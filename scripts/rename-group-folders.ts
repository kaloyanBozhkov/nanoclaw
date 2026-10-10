#!/usr/bin/env tsx
/**
 * Drop the `telegram_` prefix from every group folder now that all groups live
 * in Matrix rooms (telegram_linkbase → linkbase, telegram_main → main).
 *
 * In one DB transaction: registered_groups.folder, scheduled_tasks.group_folder,
 * sessions.group_folder and the per-folder consumed-docs state. Then the
 * folder-named directories (groups/, data/sessions/, data/ipc/) and the
 * per-group switches in ~/.config/nanoclaw/*.json. The container artifacts
 * volume is keyed by folder too; the cutover shell script moves that.
 *
 * Stop the service (and its agent containers) first.
 *
 *   npx tsx scripts/rename-group-folders.ts [--dry-run]
 *
 * A target directory that already exists aborts the run before anything
 * changes, unless it is empty (e.g. groups/main after its template is removed).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from '../src/config.js';

const PREFIX = 'telegram_';

export interface RenameOptions {
  db: Database.Database;
  /** Parent dirs holding one subdirectory per group folder. */
  folderDirs: string[];
  /** JSON files whose exact "<folder>" strings are rewritten. */
  configFiles: string[];
  dryRun?: boolean;
  log?: (line: string) => void;
}

export function plannedRenames(db: Database.Database): [string, string][] {
  return (
    db
      .prepare(
        `SELECT folder FROM registered_groups WHERE folder GLOB '${PREFIX}*' ORDER BY folder`,
      )
      .all() as { folder: string }[]
  ).map(({ folder }) => [folder, folder.slice(PREFIX.length)]);
}

function isEmptyDir(p: string): boolean {
  return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
}

export function renameGroupFolders(opts: RenameOptions): [string, string][] {
  const log = opts.log ?? console.log;
  const renames = plannedRenames(opts.db);

  // Refuse up front rather than leave a half-renamed install.
  const taken = new Set(
    (
      opts.db.prepare('SELECT folder FROM registered_groups').all() as {
        folder: string;
      }[]
    ).map((r) => r.folder),
  );
  for (const [, to] of renames) {
    if (taken.has(to)) throw new Error(`Folder "${to}" is already registered`);
    for (const dir of opts.folderDirs) {
      const target = path.join(dir, to);
      if (fs.existsSync(target) && !isEmptyDir(target)) {
        throw new Error(`${target} already exists`);
      }
    }
  }

  for (const [from, to] of renames) log(`${from} → ${to}`);
  if (opts.dryRun) return renames;

  const db = opts.db;
  db.transaction(() => {
    for (const [from, to] of renames) {
      db.prepare(
        'UPDATE registered_groups SET folder = ? WHERE folder = ?',
      ).run(to, from);
      db.prepare(
        'UPDATE scheduled_tasks SET group_folder = ? WHERE group_folder = ?',
      ).run(to, from);
      db.prepare(
        'UPDATE sessions SET group_folder = ? WHERE group_folder = ?',
      ).run(to, from);
    }
    const row = db
      .prepare(`SELECT value FROM router_state WHERE key = 'consumed_docs'`)
      .get() as { value: string } | undefined;
    if (row) {
      const byFolder = JSON.parse(row.value) as Record<string, unknown>;
      for (const [from, to] of renames) {
        if (from in byFolder) {
          byFolder[to] = byFolder[from];
          delete byFolder[from];
        }
      }
      db.prepare(
        `UPDATE router_state SET value = ? WHERE key = 'consumed_docs'`,
      ).run(JSON.stringify(byFolder));
    }
  })();

  for (const dir of opts.folderDirs) {
    for (const [from, to] of renames) {
      const src = path.join(dir, from);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(dir, to);
      if (fs.existsSync(dst)) fs.rmdirSync(dst); // empty, checked above
      fs.renameSync(src, dst);
    }
  }

  for (const file of opts.configFiles) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf-8');
    for (const [from, to] of renames) {
      text = text.split(`"${from}"`).join(`"${to}"`);
    }
    fs.writeFileSync(file, text);
  }
  return renames;
}

function main(): void {
  const configDir = path.join(os.homedir(), '.config', 'nanoclaw');
  const db = new Database(path.join(STORE_DIR, 'messages.db'));
  const renames = renameGroupFolders({
    db,
    folderDirs: [
      GROUPS_DIR,
      path.join(DATA_DIR, 'sessions'),
      path.join(DATA_DIR, 'ipc'),
    ],
    configFiles: ['godmode.json', 'simulator.json', 'git-safety.json'].map(
      (f) => path.join(configDir, f),
    ),
    dryRun: process.argv.includes('--dry-run'),
  });
  db.close();
  const verb = process.argv.includes('--dry-run') ? 'Would rename' : 'Renamed';
  console.log(`\n${verb} ${renames.length} folder(s).`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
