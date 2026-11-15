import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-relay-'));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: path.join(tmpRoot, 'groups'),
  TELEGRAM_LINKS_PATH: path.join(tmpRoot, 'unused.json'),
}));
vi.mock('../src/image-prep.js', () => ({ prepareForVision: (p: string) => p }));
vi.mock('../src/transcribe.js', () => ({ transcribeVoice: () => 'hello' }));

const { TelegramRelay, TelegramBotApi, chunkText, OWNER_LABEL } =
  await import('../src/telegram-relay.js');
import type { TgMessage } from '../src/telegram-relay.js';
import type { NewMessage, RegisteredGroup } from '../src/types.js';

const ROOM = 'mx:!room:koko.internal';
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOT_ID = 123456789;

const group: RegisteredGroup = {
  name: 'Project',
  folder: 'project',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
  requiresTrigger: false,
};

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Fake Bot API: records calls, answers getMe, never yields updates. */
function fakeFetch(calls: Call[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === 'getUpdates') {
      // Hang like a long poll until aborted.
      await new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      );
    }
    const result =
      method === 'getMe'
        ? { id: BOT_ID, is_bot: true, username: 'project_bot' }
        : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch;
}

function textMessage(text: string, userId = 42, id = 7): TgMessage {
  return {
    message_id: id,
    date: 1_800_000_000,
    chat: { id: userId, type: 'private' },
    from: { id: userId, first_name: 'Alice' },
    text,
  };
}

let calls: Call[];
let posts: string[];
let delivered: NewMessage[];
let relay: InstanceType<typeof TelegramRelay>;

beforeEach(async () => {
  calls = [];
  posts = [];
  delivered = [];
  relay?.stop();
  relay = new TelegramRelay({
    registeredGroups: () => ({ [ROOM]: group }),
    deliver: (m) => delivered.push(m),
    post: async (_jid, text) => {
      posts.push(text);
      return `$post${posts.length}`;
    },
    fetchImpl: fakeFetch(calls),
    statePath: path.join(fs.mkdtempSync(path.join(tmpRoot, 's-')), 'l.json'),
  });
  relay.start();
});

async function link(): Promise<string> {
  return relay.handleCommand(ROOM, `link ${TOKEN}`, true, '@owner:koko');
}

function incoming(msg: TgMessage) {
  const l = relay.getLink(ROOM)!;
  return relay.handleIncoming(
    ROOM,
    l,
    new TelegramBotApi(TOKEN, fakeFetch(calls)),
    msg,
  );
}

describe('TelegramRelay commands', () => {
  it('links a bot, clears its webhook and starts locked', async () => {
    const reply = await link();
    expect(reply).toContain('Linked @project_bot');
    expect(reply).toContain('starts locked');
    expect(calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['getMe', 'deleteWebhook']),
    );
    expect(relay.getLink(ROOM)).toMatchObject({
      botId: BOT_ID,
      allowAll: false,
      allowed: {},
    });
  });

  it('rejects malformed tokens without calling Telegram', async () => {
    const reply = await relay.handleCommand(ROOM, 'link nope', true, 'o');
    expect(reply).toContain('doesn’t look like a bot token');
    expect(calls).toHaveLength(0);
  });

  it('only lets the owner change the link', async () => {
    const reply = await relay.handleCommand(ROOM, `link ${TOKEN}`, false, 'x');
    expect(reply).toContain('Only the owner');
    expect(relay.getLink(ROOM)).toBeUndefined();
  });

  it('persists links with owner-only permissions', async () => {
    await link();
    const statePath = (relay as unknown as { statePath: string }).statePath;
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(fs.readFileSync(statePath, 'utf-8')).links[ROOM].token,
    ).toBe(TOKEN);
  });
});

describe('TelegramRelay inbound', () => {
  beforeEach(async () => {
    await link();
  });

  it('shows unapproved senders in the room but keeps them from the agent', async () => {
    await incoming(textMessage('hi there'));
    expect(delivered).toHaveLength(0);
    expect(posts.at(-1)).toContain('not approved');
    expect(posts.at(-1)).toContain('/telegram allow 42');
    expect(relay.getLink(ROOM)!.pending).toEqual({ '42': 'Alice' });
  });

  it('delivers approved senders to the agent and the room', async () => {
    await relay.handleCommand(ROOM, 'allow 42', true, 'o');
    await incoming(textMessage('the login page is broken'));
    expect(delivered).toEqual([
      expect.objectContaining({
        id: `tg:${BOT_ID}:42:7`,
        chat_jid: ROOM,
        sender: 'tg:42',
        sender_name: 'Alice (Telegram)',
        content: 'the login page is broken',
      }),
    ]);
    expect(posts.at(-1)).toBe(
      '📨 **Alice** · Telegram: the login page is broken',
    );
  });

  it('adds the trigger in rooms that wait for one', async () => {
    group.requiresTrigger = true;
    try {
      await relay.handleCommand(ROOM, 'allow all', true, 'o');
      await incoming(textMessage('ping'));
      expect(delivered[0].content).toBe('@Andy ping');
    } finally {
      group.requiresTrigger = false;
    }
  });

  it('does not hand /start to the agent', async () => {
    await relay.handleCommand(ROOM, 'allow all', true, 'o');
    await incoming(textMessage('/start'));
    expect(delivered).toHaveLength(0);
  });
});

describe('TelegramRelay replies', () => {
  beforeEach(async () => {
    await link();
    await relay.handleCommand(ROOM, 'allow all', true, 'o');
    calls.length = 0;
  });

  const fromTelegram = {
    id: `tg:${BOT_ID}:42:7`,
    chat_jid: ROOM,
    sender: 'tg:42',
    sender_name: 'Alice (Telegram)',
    content: 'hi',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  const fromElement = {
    ...fromTelegram,
    id: '$event',
    sender: '@owner:koko',
    sender_name: 'Owner',
  };

  it('sends agent output back to the Telegram chat that asked', async () => {
    relay.noteBatch(ROOM, [fromTelegram]);
    await relay.mirrorText(ROOM, 'Fixed it.');
    expect(calls).toEqual([
      { method: 'sendMessage', body: { chat_id: 42, text: 'Fixed it.' } },
    ]);
  });

  it('keeps room-only conversations off Telegram', async () => {
    relay.noteBatch(ROOM, [fromTelegram]);
    relay.noteBatch(ROOM, [fromElement]);
    await relay.mirrorText(ROOM, 'internal note');
    expect(calls).toHaveLength(0);
  });

  it('ignores messages from a different bot', async () => {
    relay.noteBatch(ROOM, [{ ...fromTelegram, id: 'tg:999:42:7' }]);
    await relay.mirrorText(ROOM, 'x');
    expect(calls).toHaveLength(0);
  });
});

describe('TelegramRelay owner messages', () => {
  const ownerMessage = (content: string, reply_to?: string): NewMessage => ({
    id: '$owner',
    chat_jid: ROOM,
    sender: '@owner:koko',
    sender_name: 'Owner',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    reply_to,
  });
  const sent = () => calls.filter((c) => c.method === 'sendMessage');

  beforeEach(async () => {
    await link();
    await relay.handleCommand(ROOM, 'allow all', true, 'o');
  });

  it('signs them and sends them to whoever wrote last', async () => {
    await incoming(textMessage('hello', 42));
    await incoming(textMessage('me too', 77));
    await relay.forwardOwnerMessage(ROOM, ownerMessage('on it'));
    expect(sent()).toEqual([
      {
        method: 'sendMessage',
        body: { chat_id: 77, text: `${OWNER_LABEL}: on it` },
      },
    ]);
  });

  it('sends a reply to the chat of the message replied to', async () => {
    await incoming(textMessage('hello', 42));
    const alicePost = `$post${posts.length}`;
    await incoming(textMessage('me too', 77));
    await relay.forwardOwnerMessage(ROOM, ownerMessage('hi Alice', alicePost));
    expect(sent()[0].body.chat_id).toBe(42);
  });

  it('drops the trigger and attachment placeholders', async () => {
    await incoming(textMessage('hello', 42));
    await relay.forwardOwnerMessage(ROOM, ownerMessage('@Andy deploy it'));
    await relay.forwardOwnerMessage(
      ROOM,
      ownerMessage('[Document: a.pdf — saved to /workspace/group/files/a]'),
    );
    expect(sent().map((c) => c.body.text)).toEqual([
      `${OWNER_LABEL}: deploy it`,
    ]);
  });

  it('says once when nobody has written yet', async () => {
    await relay.forwardOwnerMessage(ROOM, ownerMessage('anyone?'));
    await relay.forwardOwnerMessage(ROOM, ownerMessage('hello?'));
    expect(sent()).toHaveLength(0);
    expect(
      posts.filter((p) => p.includes('Not sent to Telegram')),
    ).toHaveLength(1);
  });

  it('does nothing in rooms without a bot', async () => {
    await relay.forwardOwnerMessage('mx:!other:koko', ownerMessage('x'));
    expect(sent()).toHaveLength(0);
  });
});

describe('chunkText', () => {
  it('splits long text on line breaks', () => {
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`;
    expect(chunkText(text)).toEqual(['a'.repeat(3000), 'b'.repeat(3000)]);
  });

  it('hard-splits a single long line', () => {
    expect(chunkText('x'.repeat(5000)).map((c) => c.length)).toEqual([
      4096, 904,
    ]);
  });
});
