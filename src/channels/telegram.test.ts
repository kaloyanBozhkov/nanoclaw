import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendAnimation: vi.fn().mockResolvedValue(undefined),
      sendVideo: vi.fn().mockResolvedValue(undefined),
      sendAudio: vi.fn().mockResolvedValue(undefined),
      sendVoice: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
  InputFile: class MockInputFile {
    constructor(public path: string) {}
  },
  InlineKeyboard: class MockInlineKeyboard {
    buttons: { label: string; data: string }[] = [];
    text(label: string, data: string) {
      this.buttons.push({ label, data });
      return this;
    }
    row() {
      return this;
    }
  },
  GrammyError: class MockGrammyError extends Error {
    constructor(
      message: string,
      public method = '',
      public error_code = 0,
      public description = '',
    ) {
      super(message);
    }
  },
  HttpError: class MockHttpError extends Error {
    constructor(
      message: string,
      public error: unknown = null,
    ) {
      super(message);
    }
  },
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    onResetSession: vi.fn(),
    onPreviewReset: vi.fn(() => ({
      targets: [],
      files: 0,
      bytes: 0,
      empty: true,
    })),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      photo: [{ file_id: 'test-photo-id', width: 100, height: 100 }],
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- /new confirmation helpers ---

function nonEmptyPreview(files = 2, bytes = 32768) {
  return {
    targets: [
      {
        label: 'conversation history',
        paths: ['/abs/a.jsonl'],
        entries: [{ path: '/abs/a.jsonl', display: 'data/a.jsonl', bytes }],
        files,
        bytes,
      },
    ],
    files,
    bytes,
    empty: false,
  };
}

function createNewCommandCtx(chatId = 100200300, fromId = 7) {
  return {
    chat: { id: chatId, type: 'group' },
    from: { id: fromId },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createCallbackCtx(
  data: string,
  { chatId = 100200300, fromId = 7, editFails = false } = {},
) {
  return {
    callbackQuery: { data },
    chat: { id: chatId },
    from: { id: fromId },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: editFails
      ? vi.fn().mockRejectedValue(new Error('400: MESSAGE_TOO_LONG'))
      : vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

async function runNewCommand(ctx: ReturnType<typeof createNewCommandCtx>) {
  await currentBot().commandHandlers.get('new')!(ctx);
}

async function runCallback(ctx: ReturnType<typeof createCallbackCtx>) {
  const handlers = currentBot().filterHandlers.get('callback_query:data') || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel /new confirmation', () => {
  let channel: TelegramChannel;
  let opts: TelegramChannelOpts;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts({
      onPreviewReset: vi.fn(() => nonEmptyPreview()),
    });
    channel = new TelegramChannel('token', opts);
    await channel.connect();
  });

  it('asks before deleting instead of clearing immediately', async () => {
    const ctx = createNewCommandCtx();
    await runNewCommand(ctx);

    expect(opts.onResetSession).not.toHaveBeenCalled();
    const [text, extra] = ctx.reply.mock.calls[0];
    expect(text).toContain('permanently delete');
    expect(extra.reply_markup.buttons.map((b: any) => b.data)).toEqual([
      'new:yes',
      'new:no',
      'new:list',
    ]);
  });

  it('clears only after an explicit yes', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('new:yes');
    await runCallback(ctx);

    expect(opts.onResetSession).toHaveBeenCalledWith('test-group');
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('Cleared');
  });

  it('deletes nothing on cancel', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('new:no');
    await runCallback(ctx);

    expect(opts.onResetSession).not.toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0][0]).toContain(
      'nothing was deleted',
    );
  });

  it('expands the file list without deciding, keeping yes/cancel', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('new:list');
    await runCallback(ctx);

    expect(opts.onResetSession).not.toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('data/a.jsonl');
    expect(
      ctx.editMessageText.mock.calls[0][1].reply_markup.buttons.map(
        (b: any) => b.data,
      ),
    ).toEqual(['new:yes', 'new:no']);

    // Still answerable afterwards.
    const yes = createCallbackCtx('new:yes');
    await runCallback(yes);
    expect(opts.onResetSession).toHaveBeenCalledTimes(1);
  });

  it('lets only the asker answer', async () => {
    await runNewCommand(createNewCommandCtx(100200300, 7));
    const ctx = createCallbackCtx('new:yes', { fromId: 999 });
    await runCallback(ctx);

    expect(opts.onResetSession).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery.mock.calls[0][0].text).toContain(
      'Only whoever ran /new',
    );
  });

  it('refuses a stale confirmation', async () => {
    await runNewCommand(createNewCommandCtx());
    const later = Date.now() + 3 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(later);
    const ctx = createCallbackCtx('new:yes');
    await runCallback(ctx);
    nowSpy.mockRestore();

    expect(opts.onResetSession).not.toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('expired');
  });

  it('says nothing-to-do without buttons when already fresh', async () => {
    (opts.onPreviewReset as any).mockReturnValue({
      targets: [],
      files: 0,
      bytes: 0,
      empty: true,
    });
    const ctx = createNewCommandCtx();
    await runNewCommand(ctx);

    expect(ctx.reply.mock.calls[0][1]).toBeUndefined();
    expect(opts.onResetSession).not.toHaveBeenCalled();
  });

  // Regression: a rejected editMessageText once surfaced as a button that did
  // nothing at all (400 MESSAGE_TOO_LONG, swallowed by bot.catch).
  it('falls back to a reply when the edit is rejected, never silently', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('new:list', { editFails: true });
    await runCallback(ctx);

    expect(ctx.editMessageText).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toContain('data/a.jsonl');
  });

  it('still reports success when the post-delete edit fails', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('new:yes', { editFails: true });
    await runCallback(ctx);

    expect(opts.onResetSession).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][0]).toContain('Cleared');
  });

  it('answers with an alert when the handler throws outright', async () => {
    await runNewCommand(createNewCommandCtx());
    (opts.onPreviewReset as any).mockImplementation(() => {
      throw new Error('disk exploded');
    });
    const ctx = createCallbackCtx('new:yes');
    await runCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it('ignores callback data it does not own', async () => {
    await runNewCommand(createNewCommandCtx());
    const ctx = createCallbackCtx('someother:thing');
    await runCallback(ctx);

    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(opts.onResetSession).not.toHaveBeenCalled();
  });
});

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription failed]',
        }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Outbound media ---

  describe('sendMedia', () => {
    let tmpDir: string;

    async function connectedChannel() {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      return channel;
    }

    /** Real file on disk — sendMedia stats it to enforce upload limits. */
    function fixture(name: string, bytes = 16): string {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, Buffer.alloc(bytes));
      return p;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-media-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.each([
      ['still.png', 'sendPhoto'],
      ['still.jpg', 'sendPhoto'],
      ['still.webp', 'sendPhoto'],
      ['clip.gif', 'sendAnimation'],
      ['clip.mp4', 'sendVideo'],
      ['song.mp3', 'sendAudio'],
      ['note.ogg', 'sendVoice'],
      ['report.pdf', 'sendDocument'],
      ['bundle.zip', 'sendDocument'],
      ['clip.webm', 'sendDocument'],
      ['noextension', 'sendDocument'],
    ])('routes %s to %s', async (name, method) => {
      const channel = await connectedChannel();
      await channel.sendMedia('tg:100200300', fixture(name));
      expect(botRef.current.api[method]).toHaveBeenCalledTimes(1);
    });

    it('sends a GIF as animation by default', async () => {
      const channel = await connectedChannel();
      await channel.sendMedia('tg:100200300', fixture('clip.gif'));
      // The original bug: a GIF through sendPhoto arrives as one flat JPEG frame.
      expect(botRef.current.api.sendPhoto).not.toHaveBeenCalled();
      expect(botRef.current.api.sendAnimation).toHaveBeenCalledTimes(1);
    });

    it('sends raw bytes as a document when asked, preserving alpha', async () => {
      const channel = await connectedChannel();
      await channel.sendMedia('tg:100200300', fixture('transparent.gif'), {
        as: 'document',
      });
      // Animation would transcode to MP4 and drop the alpha channel.
      expect(botRef.current.api.sendAnimation).not.toHaveBeenCalled();
      expect(botRef.current.api.sendDocument).toHaveBeenCalledTimes(1);
    });

    it('passes a caption with Markdown parsing', async () => {
      const channel = await connectedChannel();
      await channel.sendMedia('tg:100200300', fixture('clip.mp4'), {
        caption: '*bold*',
      });
      expect(botRef.current.api.sendVideo).toHaveBeenCalledWith(
        '100200300',
        expect.anything(),
        { caption: '*bold*', parse_mode: 'Markdown' },
      );
    });

    it('retries with a plain caption when Markdown fails to parse', async () => {
      const channel = await connectedChannel();
      // Telegram reads the `_` in send_image as an unclosed italic entity.
      const caption = 'legacy send_image + new host router';
      botRef.current.api.sendAnimation.mockRejectedValueOnce(
        new Error(
          "Call to 'sendAnimation' failed! (400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 28)",
        ),
      );
      await channel.sendMedia('tg:100200300', fixture('clip.gif'), { caption });

      expect(botRef.current.api.sendAnimation).toHaveBeenCalledTimes(2);
      // Still an animation, not downgraded to a document — only the formatting drops.
      expect(botRef.current.api.sendAnimation).toHaveBeenLastCalledWith(
        '100200300',
        expect.anything(),
        { caption },
      );
      expect(botRef.current.api.sendDocument).not.toHaveBeenCalled();
    });

    it('falls back to document when the typed send fails', async () => {
      const channel = await connectedChannel();
      botRef.current.api.sendVideo.mockRejectedValueOnce(
        new Error('unsupported codec'),
      );
      await channel.sendMedia('tg:100200300', fixture('clip.mp4'));
      expect(botRef.current.api.sendDocument).toHaveBeenCalledTimes(1);
    });

    it('sends an oversized photo as a document rather than failing', async () => {
      const channel = await connectedChannel();
      await channel.sendMedia(
        'tg:100200300',
        fixture('huge.png', 11 * 1024 * 1024),
      );
      expect(botRef.current.api.sendPhoto).not.toHaveBeenCalled();
      expect(botRef.current.api.sendDocument).toHaveBeenCalledTimes(1);
    });

    it('throws over the 50MB upload limit', async () => {
      const channel = await connectedChannel();
      await expect(
        channel.sendMedia(
          'tg:100200300',
          fixture('huge.mp4', 51 * 1024 * 1024),
        ),
      ).rejects.toThrow(/50MB/);
    });

    it('propagates a document send failure instead of reporting success', async () => {
      const channel = await connectedChannel();
      botRef.current.api.sendDocument.mockRejectedValueOnce(
        new Error('network down'),
      );
      await expect(
        channel.sendMedia('tg:100200300', fixture('report.pdf')),
      ).rejects.toThrow('network down');
    });
  });
});
