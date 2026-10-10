import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';

const tmpRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('../src/channels/registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../src/env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  get DATA_DIR() {
    return tmpRoot.dir;
  },
  get GROUPS_DIR() {
    return tmpRoot.dir;
  },
  isOwnerSender: (sender: string, isFromMe: boolean) =>
    isFromMe || sender === '@owner:test',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const project = vi.hoisted(() => ({
  remote: null as string | null,
  setUp: null as unknown as Mock<(...args: unknown[]) => Promise<string>>,
}));
vi.mock('../src/project-setup.js', async () => {
  const { vi } = await import('vitest');
  project.setUp = vi.fn(async () => 'https://github.com/me/side-project');
  return {
    projectSlug: (name: string) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    projectMount: (slug: string) => ({
      hostPath: `~/Documents/koko/${slug}`,
      containerPath: slug,
      readonly: false,
    }),
    ensureProjectDir: (slug: string) => ({
      dir: `/koko/${slug}`,
      existed: false,
    }),
    gitRemote: async () => project.remote,
    setUpGitHubRepo: (...args: unknown[]) => project.setUp(...args),
  };
});
vi.mock('../src/transcribe.js', () => ({
  transcribeVoice: vi.fn(() => 'hello there'),
}));

import {
  MatrixChannel,
  MatrixChannelOpts,
  MAX_MEDIA_BYTES,
  outboundKindFor,
  renderMarkdown,
  safeFilename,
  stripReplyFallback,
} from '../src/channels/matrix.js';
import type {
  MatrixEvent,
  SyncResponse,
} from '../src/channels/matrix-client.js';

const BOT = '@bot:test';
const ROOM = '!room:test';
const JID = `mx:${ROOM}`;

function fakeClient() {
  return {
    whoami: vi.fn().mockResolvedValue({ user_id: BOT }),
    setDisplayName: vi.fn().mockResolvedValue({}),
    // After the first call the long-poll just waits for abort, like fetch —
    // tests drive processSync directly.
    sync: vi
      .fn()
      .mockResolvedValueOnce({ next_batch: 's1', rooms: {} })
      .mockImplementation(
        (_params: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            ),
          ),
      ),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$sent' }),
    setTyping: vi.fn().mockResolvedValue({}),
    joinRoom: vi.fn().mockResolvedValue({ room_id: ROOM }),
    leaveRoom: vi.fn().mockResolvedValue({}),
    createRoom: vi.fn().mockResolvedValue({ room_id: '!new:test' }),
    getStateEvent: vi.fn().mockResolvedValue({ name: 'Project room' }),
    upload: vi.fn().mockResolvedValue('mxc://test/abc'),
    download: vi.fn().mockResolvedValue(Buffer.from('bytes')),
  };
}

function makeOpts(registered = true) {
  const opts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    onResetSession: vi.fn(() => undefined),
    onPreviewReset: vi.fn(() => ({
      empty: false,
      files: 3,
      bytes: 2048,
      targets: [
        { kind: 'cache', label: 'Cache', paths: [], files: 1, entries: [] },
      ],
    })),
    registerGroup: vi.fn(),
    registeredGroups: vi.fn(() =>
      registered
        ? {
            [JID]: {
              name: 'Project',
              folder: 'project',
              trigger: '@Andy',
              added_at: '',
            },
          }
        : {},
    ),
  };
  return opts as unknown as MatrixChannelOpts & typeof opts;
}

let n = 0;
function msg(
  content: Record<string, unknown>,
  sender = '@owner:test',
): MatrixEvent {
  return {
    type: 'm.room.message',
    event_id: `$e${++n}`,
    sender,
    origin_server_ts: 1_700_000_000_000,
    content,
  };
}

function syncOf(events: MatrixEvent[]): SyncResponse {
  return {
    next_batch: 'sX',
    rooms: { join: { [ROOM]: { timeline: { events } } } },
  };
}

function sentBodies(client: ReturnType<typeof fakeClient>): string[] {
  return client.sendEvent.mock.calls.map((c) => c[2].body as string);
}

describe('helpers', () => {
  it('renders Markdown and keeps literal tags as text', () => {
    expect(renderMarkdown('**hi** <b>x</b>')).toBe(
      '<p><strong>hi</strong> &lt;b&gt;x&lt;/b&gt;</p>',
    );
  });

  it('strips a reply fallback quote', () => {
    expect(stripReplyFallback('> <@a:test> earlier\n> more\n\nmy answer')).toBe(
      'my answer',
    );
    expect(stripReplyFallback('no quote')).toBe('no quote');
  });

  it('picks msgtypes by extension', () => {
    expect(outboundKindFor('a.PNG')).toBe('m.image');
    expect(outboundKindFor('a.mp4')).toBe('m.video');
    expect(outboundKindFor('a.ogg')).toBe('voice');
    expect(outboundKindFor('a.svg')).toBe('m.file');
  });

  it('keeps filenames inside the target folder', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('weird/na$me?.pdf')).toBe('na_me_.pdf');
    expect(safeFilename('')).toBe('file');
  });
});

describe('MatrixChannel', () => {
  let client: ReturnType<typeof fakeClient>;
  let opts: ReturnType<typeof makeOpts>;
  let ch: MatrixChannel;

  beforeEach(async () => {
    tmpRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-test-'));
    client = fakeClient();
    opts = makeOpts();
    ch = new MatrixChannel(
      client as any,
      opts,
      path.join(tmpRoot.dir, 'sync.json'),
    );
    await ch.connect();
  });

  afterEach(async () => {
    await ch.disconnect();
    fs.rmSync(tmpRoot.dir, { recursive: true, force: true });
  });

  describe('connect', () => {
    it('takes a sync position without replaying history on first run', () => {
      expect(client.sync).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 0 }),
      );
      const saved = JSON.parse(
        fs.readFileSync(path.join(tmpRoot.dir, 'sync.json'), 'utf-8'),
      );
      expect(saved.since).toBe('s1');
      expect(ch.isConnected()).toBe(true);
    });

    it('resumes from the saved position on restart', async () => {
      const again = fakeClient();
      const ch2 = new MatrixChannel(
        again as any,
        opts,
        path.join(tmpRoot.dir, 'sync.json'),
      );
      await ch2.connect();
      expect(again.sync).toHaveBeenCalledWith(
        expect.objectContaining({ since: 's1' }),
        expect.anything(),
      );
      await ch2.disconnect();
    });
  });

  describe('invites', () => {
    const invite = (sender: string): SyncResponse => ({
      next_batch: 'sX',
      rooms: {
        invite: {
          [ROOM]: {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  state_key: BOT,
                  sender,
                  event_id: '$i',
                  origin_server_ts: 0,
                  content: { membership: 'invite' },
                },
              ],
            },
          },
        },
      },
    });

    it('joins when the owner invites', async () => {
      await ch.processSync(invite('@owner:test'), { deliver: true });
      expect(client.joinRoom).toHaveBeenCalledWith(ROOM);
    });

    it('declines anyone else', async () => {
      await ch.processSync(invite('@stranger:test'), { deliver: true });
      expect(client.joinRoom).not.toHaveBeenCalled();
      expect(client.leaveRoom).toHaveBeenCalledWith(ROOM);
    });
  });

  describe('inbound messages', () => {
    it('delivers text for a registered room', async () => {
      await ch.processSync(syncOf([msg({ msgtype: 'm.text', body: 'hi' })]), {
        deliver: true,
      });
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        JID,
        expect.any(String),
        'Project room',
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          chat_jid: JID,
          sender: '@owner:test',
          sender_name: 'owner',
          content: 'hi',
          is_from_me: false,
        }),
      );
    });

    it('uses member display names from room state', async () => {
      await ch.processSync(
        {
          next_batch: 'sX',
          rooms: {
            join: {
              [ROOM]: {
                state: {
                  events: [
                    {
                      type: 'm.room.member',
                      state_key: '@owner:test',
                      sender: '@owner:test',
                      event_id: '$m',
                      origin_server_ts: 0,
                      content: { membership: 'join', displayname: 'Koko' },
                    },
                  ],
                },
                timeline: { events: [msg({ msgtype: 'm.text', body: 'hi' })] },
              },
            },
          },
        },
        { deliver: true },
      );
      expect(opts.onMessage.mock.calls[0][1].sender_name).toBe('Koko');
    });

    it('ignores its own messages, edits and redactions', async () => {
      await ch.processSync(
        syncOf([
          msg({ msgtype: 'm.text', body: 'echo' }, BOT),
          msg({
            msgtype: 'm.text',
            body: '* fixed',
            'm.relates_to': { rel_type: 'm.replace', event_id: '$x' },
          }),
          msg({}),
        ]),
        { deliver: true },
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not deliver during the initial catch-up sync', async () => {
      await ch.processSync(syncOf([msg({ msgtype: 'm.text', body: 'old' })]), {
        deliver: false,
      });
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('only emits metadata for unregistered rooms', async () => {
      opts.registeredGroups.mockReturnValue({});
      await ch.processSync(syncOf([msg({ msgtype: 'm.text', body: 'hi' })]), {
        deliver: true,
      });
      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('turns a mention of the bot into the trigger', async () => {
      await ch.processSync(
        syncOf([
          msg({
            msgtype: 'm.text',
            body: 'Andy can you check',
            'm.mentions': { user_ids: [BOT] },
          }),
        ]),
        { deliver: true },
      );
      expect(opts.onMessage.mock.calls[0][1].content).toBe(
        '@Andy Andy can you check',
      );
    });

    it('strips reply fallbacks before delivering', async () => {
      await ch.processSync(
        syncOf([msg({ msgtype: 'm.text', body: '> <@x:test> q\n\nanswer' })]),
        { deliver: true },
      );
      expect(opts.onMessage.mock.calls[0][1].content).toBe('answer');
    });

    it('downloads images into the group folder with the caption', async () => {
      await ch.processSync(
        syncOf([
          msg({
            msgtype: 'm.image',
            body: 'look',
            filename: 'pic.png',
            url: 'mxc://test/img',
            info: { mimetype: 'image/png' },
          }),
        ]),
        { deliver: true },
      );
      const delivered = opts.onMessage.mock.calls[0][1];
      expect(delivered.content).toBe('[Photo] look');
      expect(delivered.images[0]).toMatch(/project\/images\/\d+-pic\.png$/);
      expect(fs.readFileSync(delivered.images[0], 'utf-8')).toBe('bytes');
    });

    it('transcribes voice notes', async () => {
      await ch.processSync(
        syncOf([
          msg({
            msgtype: 'm.audio',
            body: 'Voice message',
            url: 'mxc://test/voice',
            'org.matrix.msc3245.voice': {},
          }),
        ]),
        { deliver: true },
      );
      expect(opts.onMessage.mock.calls[0][1].content).toBe(
        '[Voice: hello there]',
      );
    });

    it('saves files and tells the agent the container path', async () => {
      await ch.processSync(
        syncOf([
          msg({
            msgtype: 'm.file',
            body: 'spec.pdf',
            url: 'mxc://test/f',
            info: { size: 5 },
          }),
        ]),
        { deliver: true },
      );
      expect(opts.onMessage.mock.calls[0][1].content).toMatch(
        /^\[Document: spec\.pdf — saved to \/workspace\/group\/files\/\d+-spec\.pdf\]$/,
      );
    });

    it('skips downloading files over the size limit', async () => {
      await ch.processSync(
        syncOf([
          msg({
            msgtype: 'm.video',
            body: 'big.mp4',
            url: 'mxc://test/v',
            info: { size: MAX_MEDIA_BYTES + 1 },
          }),
        ]),
        { deliver: true },
      );
      expect(client.download).not.toHaveBeenCalled();
      expect(opts.onMessage.mock.calls[0][1].content).toMatch(/too large/);
    });
  });

  describe('commands', () => {
    const say = (body: string, sender = '@owner:test') =>
      ch.processSync(syncOf([msg({ msgtype: 'm.text', body }, sender)]), {
        deliver: true,
      });

    it('answers /chatid and /ping without forwarding them', async () => {
      await say('/chatid');
      await say('/ping');
      expect(sentBodies(client)[0]).toContain(`\`${JID}\``);
      expect(sentBodies(client)[1]).toBe('Andy is online.');
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('passes other slash commands through to the core', async () => {
      await say('/model opus');
      expect(opts.onMessage.mock.calls[0][1].content).toBe('/model opus');
    });

    it('/new asks first and clears only after yes', async () => {
      await say('/new');
      expect(opts.onResetSession).not.toHaveBeenCalled();
      expect(sentBodies(client)[0]).toContain('*keep*');
      await say('yes');
      expect(opts.onResetSession).toHaveBeenCalledWith('project', 'all');
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('/new keep clears the session but not caches', async () => {
      await say('/new');
      await say('keep');
      expect(opts.onResetSession).toHaveBeenCalledWith('project', 'session');
      expect(sentBodies(client).at(-1)).toContain('Caches kept.');
    });

    it('/new cancel deletes nothing', async () => {
      await say('/new');
      await say('cancel');
      expect(opts.onResetSession).not.toHaveBeenCalled();
      expect(sentBodies(client).at(-1)).toContain('nothing was deleted');
    });

    it('only the asker can answer /new', async () => {
      await say('/new');
      await say('yes', '@other:test');
      expect(opts.onResetSession).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalled(); // just a normal message
    });

    it('/mxroom is owner-only and invites the asker', async () => {
      await say('/mxroom Side project', '@other:test');
      expect(client.createRoom).not.toHaveBeenCalled();
      await say('/mxroom Side project');
      expect(client.createRoom).toHaveBeenCalledWith('Side project', [
        '@owner:test',
      ]);
      expect(sentBodies(client).join('\n')).toContain('mx:!new:test');
    });

    it('/mxroom registers the room as a project with its folder mounted', async () => {
      await say('/mxroom Side project');
      expect(opts.registerGroup).toHaveBeenCalledWith(
        'mx:!new:test',
        expect.objectContaining({
          name: 'Side project',
          folder: 'side-project',
          requiresTrigger: false,
          containerConfig: {
            additionalMounts: [
              {
                hostPath: '~/Documents/koko/side-project',
                containerPath: 'side-project',
                readonly: false,
              },
            ],
          },
        }),
      );
    });

    it('/mxroom refuses a folder that is already registered', async () => {
      await say('/mxroom Project');
      expect(client.createRoom).not.toHaveBeenCalled();
      expect(opts.registerGroup).not.toHaveBeenCalled();
      expect(sentBodies(client).at(-1)).toContain('already exists');
    });

    describe('git setup question in the new room', () => {
      const NEW_ROOM = '!new:test';
      const answer = (body: string, sender = '@owner:test') =>
        ch.processSync(
          {
            next_batch: 'sY',
            rooms: {
              join: {
                [NEW_ROOM]: {
                  timeline: {
                    events: [msg({ msgtype: 'm.text', body }, sender)],
                  },
                },
              },
            },
          },
          { deliver: true },
        );
      const roomBodies = () =>
        client.sendEvent.mock.calls
          .filter((c) => c[0] === NEW_ROOM)
          .map((c) => c[2].body as string);

      beforeEach(() => {
        project.remote = null;
        project.setUp.mockClear();
      });

      it('asks in the new room and sets up GitHub on yes', async () => {
        await say('/mxroom Side project');
        expect(roomBodies().at(-1)).toContain('Reply **yes** or **no**');

        await answer('maybe', '@other:test'); // not the asker: ignored
        await answer('yes');
        expect(project.setUp).toHaveBeenCalledWith(
          '/koko/side-project',
          'side-project',
          'Side project',
        );
        expect(roomBodies().at(-1)).toContain(
          'https://github.com/me/side-project',
        );
        expect(opts.onMessage).not.toHaveBeenCalledWith(
          'mx:!new:test',
          expect.objectContaining({ content: 'yes' }),
        );
      });

      it('does nothing on no, and only asks once', async () => {
        await say('/mxroom Side project');
        await answer('no');
        await answer('yes');
        expect(project.setUp).not.toHaveBeenCalled();
        expect(roomBodies()).toContain('OK, no git setup.');
      });

      it('skips the question when the folder already has a remote', async () => {
        project.remote = 'git@github.com:me/side-project.git';
        await say('/mxroom Side project');
        expect(roomBodies().at(-1)).toContain('already a git repo');
        await answer('yes');
        expect(project.setUp).not.toHaveBeenCalled();
      });

      it('reports a failed setup', async () => {
        project.setUp.mockRejectedValueOnce(new Error('name already exists'));
        await say('/mxroom Side project');
        await answer('yes');
        expect(roomBodies().at(-1)).toContain('name already exists');
      });
    });
  });

  describe('outbound', () => {
    it('sends text with an HTML copy', async () => {
      await ch.sendMessage(JID, '**hi**');
      expect(client.sendEvent).toHaveBeenCalledWith(ROOM, 'm.room.message', {
        msgtype: 'm.text',
        body: '**hi**',
        format: 'org.matrix.custom.html',
        formatted_body: '<p><strong>hi</strong></p>',
      });
    });

    it('splits very long messages', async () => {
      await ch.sendMessage(JID, 'x'.repeat(40000));
      expect(client.sendEvent).toHaveBeenCalledTimes(3);
    });

    it('swallows send failures', async () => {
      client.sendEvent.mockRejectedValueOnce(new Error('boom'));
      await expect(ch.sendMessage(JID, 'hi')).resolves.toBeUndefined();
    });

    it('uploads media and marks voice notes', async () => {
      const file = path.join(tmpRoot.dir, 'note.ogg');
      fs.writeFileSync(file, 'ogg');
      await ch.sendMedia(JID, file, { caption: 'listen' });
      expect(client.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        'note.ogg',
        'audio/ogg',
      );
      const content = client.sendEvent.mock.calls[0][2];
      expect(content).toMatchObject({
        msgtype: 'm.audio',
        body: 'listen',
        filename: 'note.ogg',
        url: 'mxc://test/abc',
        'org.matrix.msc3245.voice': {},
      });
    });

    it('sends as a plain file when asked to', async () => {
      const file = path.join(tmpRoot.dir, 'anim.gif');
      fs.writeFileSync(file, 'gif');
      await ch.sendMedia(JID, file, { as: 'document' });
      expect(client.sendEvent.mock.calls[0][2].msgtype).toBe('m.file');
    });

    it('refuses files over the upload limit', async () => {
      const file = path.join(tmpRoot.dir, 'big.bin');
      fs.writeFileSync(file, '');
      fs.truncateSync(file, MAX_MEDIA_BYTES + 1);
      await expect(ch.sendMedia(JID, file)).rejects.toThrow(/upload limit/);
      expect(client.upload).not.toHaveBeenCalled();
    });

    it('sets and clears typing', async () => {
      await ch.setTyping(JID, true);
      await ch.setTyping(JID, false);
      expect(client.setTyping).toHaveBeenNthCalledWith(1, ROOM, BOT, true);
      expect(client.setTyping).toHaveBeenNthCalledWith(2, ROOM, BOT, false);
    });

    it('owns only mx: JIDs', () => {
      expect(ch.ownsJid(JID)).toBe(true);
      expect(ch.ownsJid('tg:123')).toBe(false);
    });
  });
});
