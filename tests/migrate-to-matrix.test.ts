import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import { migrateToMatrix, rekeyGroup } from '../scripts/migrate-to-matrix.js';

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER DEFAULT 0);
    CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT,
      PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid));
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, is_main INTEGER DEFAULT 0);
    CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL);
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  for (const [jid, name, folder, main] of [
    ['tg:1', 'Koko', 'telegram_main', 1],
    ['tg:-2', 'Linkbase', 'telegram_linkbase', 0],
  ] as const) {
    db.prepare(
      `INSERT INTO chats VALUES (?, ?, '2026-10-01', 'telegram', 1)`,
    ).run(jid, name);
    db.prepare(
      `INSERT INTO registered_groups VALUES (?, ?, ?, '@Andy', '', ?)`,
    ).run(jid, name, folder, main);
    db.prepare(
      `INSERT INTO messages VALUES (?, ?, 's', 'hi', '2026-10-01')`,
    ).run(`m${jid}`, jid);
  }
  db.prepare(
    `INSERT INTO scheduled_tasks VALUES ('t1', 'telegram_linkbase', 'tg:-2')`,
  ).run();
  db.prepare(`INSERT INTO router_state VALUES ('last_agent_timestamp', ?)`).run(
    JSON.stringify({ 'tg:1': 'a', 'tg:-2': 'b' }),
  );
  return db;
}

describe('rekeyGroup', () => {
  it('moves registration, history, tasks and cursor to the new JID', () => {
    const db = seed();
    rekeyGroup(db, 'tg:-2', 'mx:!r:x');

    expect(
      db
        .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
        .get('mx:!r:x'),
    ).toEqual({
      folder: 'telegram_linkbase',
    });
    expect(
      db.prepare('SELECT chat_jid FROM messages WHERE id = ?').get('mtg:-2'),
    ).toEqual({
      chat_jid: 'mx:!r:x',
    });
    expect(db.prepare('SELECT chat_jid FROM scheduled_tasks').get()).toEqual({
      chat_jid: 'mx:!r:x',
    });
    expect(
      db
        .prepare('SELECT channel, name FROM chats WHERE jid = ?')
        .get('mx:!r:x'),
    ).toEqual({
      channel: 'matrix',
      name: 'Linkbase',
    });
    expect(
      db.prepare('SELECT 1 FROM chats WHERE jid = ?').get('tg:-2'),
    ).toBeUndefined();
    const cursors = JSON.parse(
      (db.prepare(`SELECT value FROM router_state`).get() as { value: string })
        .value,
    );
    expect(cursors).toEqual({ 'tg:1': 'a', 'mx:!r:x': 'b' });
  });
});

describe('migrateToMatrix', () => {
  let db: Database.Database;
  let createRoom: Mock<
    (name: string, invite: string[]) => Promise<{ room_id: string }>
  >;
  let client: {
    createRoom: typeof createRoom;
    joinedRooms: Mock<() => Promise<{ joined_rooms: string[] }>>;
    getStateEvent: Mock<(roomId: string, type: string) => Promise<any>>;
  };

  beforeEach(() => {
    db = seed();
    let i = 0;
    createRoom = vi.fn(async () => ({ room_id: `!room${++i}:x` }));
    client = {
      createRoom,
      joinedRooms: vi.fn(async () => ({ joined_rooms: [] })),
      getStateEvent: vi.fn(async () => ({})),
    };
  });

  it('creates a room per group, inviting the owner, main first and renamed', async () => {
    const moved = await migrateToMatrix({
      db,
      client,
      owner: '@koko:x',
      log: () => {},
    });
    expect(createRoom.mock.calls).toEqual([
      ['Main', ['@koko:x']],
      ['Linkbase', ['@koko:x']],
    ]);
    expect(moved.map((m) => m.to)).toEqual(['mx:!room1:x', 'mx:!room2:x']);
    expect(
      db
        .prepare(
          `SELECT count(*) n FROM registered_groups WHERE jid LIKE 'tg:%'`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('changes nothing on a dry run', async () => {
    await migrateToMatrix({
      db,
      client,
      owner: '@koko:x',
      dryRun: true,
      log: () => {},
    });
    expect(createRoom).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT count(*) n FROM registered_groups WHERE jid LIKE 'tg:%'`,
        )
        .get(),
    ).toEqual({ n: 2 });
  });

  it('skips groups that already moved when rerun', async () => {
    await migrateToMatrix({
      db,
      client,
      owner: '@koko:x',
      log: () => {},
    });
    createRoom.mockClear();
    const again = await migrateToMatrix({
      db,
      client,
      owner: '@koko:x',
      log: () => {},
    });
    expect(again).toEqual([]);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('reuses a leftover room from a failed run instead of creating another', async () => {
    client.joinedRooms.mockResolvedValue({
      joined_rooms: ['!old:x', '!other:x'],
    });
    client.getStateEvent.mockImplementation(async (roomId: string) =>
      roomId === '!old:x' ? { name: 'Main' } : { name: 'Something else' },
    );
    const moved = await migrateToMatrix({
      db,
      client,
      owner: '@koko:x',
      log: () => {},
    });
    expect(moved.map((m) => [m.roomName, m.to])).toEqual([
      ['Main', 'mx:!old:x'],
      ['Linkbase', 'mx:!room1:x'],
    ]);
    expect(createRoom.mock.calls).toEqual([['Linkbase', ['@koko:x']]]);
  });
});
