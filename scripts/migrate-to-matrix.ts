#!/usr/bin/env tsx
/**
 * One-way move of every Telegram group to its own Matrix room.
 *
 * For each `tg:` registered group: the bot creates a private, unencrypted room
 * named after the group and invites the owner, then — in one transaction — the
 * group's registration, message history, scheduled tasks and router cursor are
 * re-keyed from `tg:<id>` to `mx:<room id>`. Folders, sessions and memory are
 * keyed by folder and don't move.
 *
 * Stop the service first: it caches registered groups in memory and would keep
 * routing to the old JIDs.
 *
 *   npx tsx scripts/migrate-to-matrix.ts --owner @koko:koko.internal [--dry-run]
 *
 * Rooms are created before the transaction, so a failure leaves at most an
 * empty room behind; rerunning skips groups that already moved.
 */
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { MatrixClient } from '../src/channels/matrix-client.js';

/** The main chat was a Telegram DM named after the owner; give it a clearer name. */
const MAIN_ROOM_NAME = 'Main';

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  is_main: number;
}

export interface MigrateOptions {
  db: Database.Database;
  client: Pick<MatrixClient, 'createRoom'>;
  owner: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface MigratedGroup {
  folder: string;
  from: string;
  to: string;
  roomName: string;
}

/** Re-key one group from its Telegram JID to a Matrix JID, atomically. */
export function rekeyGroup(
  db: Database.Database,
  from: string,
  to: string,
): void {
  db.transaction(() => {
    const chat = db
      .prepare('SELECT name, last_message_time FROM chats WHERE jid = ?')
      .get(from) as { name: string; last_message_time: string } | undefined;
    // messages.chat_jid references chats(jid): the new row must exist first.
    db.prepare(
      `INSERT OR REPLACE INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES (?, ?, ?, 'matrix', 1)`,
    ).run(to, chat?.name ?? null, chat?.last_message_time ?? null);
    db.prepare('UPDATE registered_groups SET jid = ? WHERE jid = ?').run(
      to,
      from,
    );
    db.prepare('UPDATE messages SET chat_jid = ? WHERE chat_jid = ?').run(
      to,
      from,
    );
    db.prepare(
      'UPDATE scheduled_tasks SET chat_jid = ? WHERE chat_jid = ?',
    ).run(to, from);

    // Per-chat "agent has seen up to here" cursor — without it the group
    // would replay its whole history to the agent on the first new message.
    const row = db
      .prepare(
        `SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`,
      )
      .get() as { value: string } | undefined;
    if (row) {
      const cursors = JSON.parse(row.value) as Record<string, string>;
      if (from in cursors) {
        cursors[to] = cursors[from];
        delete cursors[from];
        db.prepare(
          `UPDATE router_state SET value = ? WHERE key = 'last_agent_timestamp'`,
        ).run(JSON.stringify(cursors));
      }
    }

    db.prepare('DELETE FROM chats WHERE jid = ?').run(from);
  })();
}

export async function migrateToMatrix(
  opts: MigrateOptions,
): Promise<MigratedGroup[]> {
  const log = opts.log ?? console.log;
  const groups = opts.db
    .prepare(
      `SELECT jid, name, folder, is_main FROM registered_groups
       WHERE jid LIKE 'tg:%' ORDER BY is_main DESC, name`,
    )
    .all() as GroupRow[];

  const moved: MigratedGroup[] = [];
  for (const g of groups) {
    const roomName = g.is_main ? MAIN_ROOM_NAME : g.name;
    if (opts.dryRun) {
      log(`[dry run] ${g.jid} (${g.folder}) → new room "${roomName}"`);
      continue;
    }
    const { room_id } = await opts.client.createRoom(roomName, [opts.owner]);
    const to = `mx:${room_id}`;
    rekeyGroup(opts.db, g.jid, to);
    moved.push({ folder: g.folder, from: g.jid, to, roomName });
    log(`${g.jid} (${g.folder}) → ${to} "${roomName}"`);
  }
  return moved;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ownerIdx = args.indexOf('--owner');
  const owner = ownerIdx >= 0 ? args[ownerIdx + 1] : undefined;
  if (!owner?.startsWith('@')) {
    console.error(
      'Usage: tsx scripts/migrate-to-matrix.ts --owner @you:server [--dry-run]',
    );
    process.exit(1);
  }

  const env = readEnvFile(['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN']);
  const homeserver = process.env.MATRIX_HOMESERVER || env.MATRIX_HOMESERVER;
  const token = process.env.MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN;
  if (!homeserver || !token) {
    console.error('MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN must be set');
    process.exit(1);
  }

  const db = new Database(path.join(STORE_DIR, 'messages.db'));
  const moved = await migrateToMatrix({
    db,
    client: new MatrixClient(homeserver, token),
    owner,
    dryRun: args.includes('--dry-run'),
  });
  db.close();
  if (!args.includes('--dry-run')) {
    console.log(`\nMoved ${moved.length} group(s) to Matrix.`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
