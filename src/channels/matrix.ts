import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Marked } from 'marked';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  isOwnerSender,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  formatBytes,
  formatResetFileList,
  formatResetPreview,
  ResetPreview,
  ResetScope,
} from '../session-reset.js';
import { transcribeVoice } from '../transcribe.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMediaOptions,
} from '../types.js';
import { MatrixClient, MatrixEvent, SyncResponse } from './matrix-client.js';
import { registerChannel, ChannelOpts } from './registry.js';

export const MATRIX_JID_PREFIX = 'mx:';

/** Matches Synapse's max_upload_size for this install. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * Matrix events top out at 64KiB of JSON. The HTML copy roughly doubles the
 * text, so split well below that.
 */
const MAX_MESSAGE_CHARS = 16000;

/** How long a pending `/new` confirmation stays answerable. */
const RESET_CONFIRM_TTL_MS = 2 * 60 * 1000;

const SYNC_TIMEOUT_MS = 30000;
const SYNC_BACKOFF_MAX_MS = 60000;

/** Commands the channel answers itself — never forwarded to the agent. */
const CHANNEL_COMMANDS = new Set(['chatid', 'ping', 'new', 'mxroom']);

/**
 * Lazy-load members so a sync only carries the profiles of people who spoke,
 * and keep the timeline short — a long gap is summarised by `limited`, not
 * replayed in full.
 */
const SYNC_FILTER = JSON.stringify({
  room: {
    state: { lazy_load_members: true },
    timeline: { limit: 50, lazy_load_members: true },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
  },
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
});

/** First run: learn rooms and a sync position, but replay no history. */
const INITIAL_SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { limit: 0 },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
  },
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
});

const markdown = new Marked({ gfm: true, breaks: true });
// Agent output is text, not markup: a literal "<div>" in a reply should show
// up as typed, not vanish into Element's HTML sanitiser.
markdown.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Agent Markdown → the HTML Element renders as formatted_body. */
export function renderMarkdown(text: string): string {
  return (markdown.parse(text, { async: false }) as string).trim();
}

/**
 * Drop the quoted "> <@user> …" block clients prepend to a reply's body. Newer
 * clients send no fallback at all; older ones do, and it would otherwise reach
 * the agent as part of what the user said.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i === 0) return body;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

type OutboundKind = 'm.image' | 'm.video' | 'm.audio' | 'voice' | 'm.file';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
};

export function mimeTypeFor(filePath: string): string {
  return (
    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ||
    'application/octet-stream'
  );
}

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT)
    .reverse()
    .map(([ext, mime]) => [mime, ext]),
);

/**
 * Pick the Matrix msgtype for an outbound file. Unlike Telegram nothing is
 * re-encoded — every msgtype carries the original bytes — so this only decides
 * how Element presents the file. SVG goes as a file: clients won't inline it.
 */
export function outboundKindFor(filePath: string): OutboundKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.gif':
    case '.webp':
      return 'm.image';
    case '.mp4':
    case '.mov':
    case '.webm':
      return 'm.video';
    case '.mp3':
    case '.m4a':
    case '.wav':
      return 'm.audio';
    case '.ogg':
    case '.oga':
    case '.opus':
      return 'voice';
    default:
      return 'm.file';
  }
}

/** Image dimensions via macOS `sips`; Element sizes the bubble before loading. */
function imageSize(filePath: string): { w: number; h: number } | undefined {
  try {
    const out = execFileSync(
      '/usr/bin/sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const w = Number(/pixelWidth: (\d+)/.exec(out)?.[1]);
    const h = Number(/pixelHeight: (\d+)/.exec(out)?.[1]);
    return w && h ? { w, h } : undefined;
  } catch {
    return undefined;
  }
}

/** Keep a sender-chosen filename from escaping the target directory. */
export function safeFilename(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .trim();
  return base.slice(-120) || 'file';
}

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  /** Returns an extra note for the confirmation (e.g. tools switched off). */
  onResetSession: (
    groupFolder: string,
    scope?: ResetScope,
  ) => string | undefined | void;
  onPreviewReset: (groupFolder: string, scope?: ResetScope) => ResetPreview;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface PendingReset {
  groupFolder: string;
  /** Only the user who ran `/new` may answer it. */
  senderId: string;
  expiresAt: number;
  hasCache: boolean;
}

/** The typed answers to a `/new` prompt, standing in for Telegram's buttons. */
const RESET_ANSWERS: Record<string, 'all' | 'session' | 'no' | 'list'> = {
  yes: 'all',
  y: 'all',
  all: 'all',
  keep: 'session',
  cancel: 'no',
  no: 'no',
  n: 'no',
  list: 'list',
};

function resetChoices(hasCache: boolean, withList: boolean): string {
  const opts = hasCache
    ? ['*yes* — clear everything', '*keep* — clear but keep caches']
    : ['*yes* — clear it'];
  opts.push('*cancel*');
  if (withList) opts.push('*list* — show the files');
  return `Reply ${opts.join(', ')}.`;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private userId: string | null = null;
  private since: string | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private roomNames = new Map<string, string>();
  private memberNames = new Map<string, Map<string, string>>();
  /** Unanswered `/new` confirmations, keyed by chat JID. */
  private pendingResets = new Map<string, PendingReset>();

  constructor(
    private client: MatrixClient,
    private opts: MatrixChannelOpts,
    private statePath: string = path.join(DATA_DIR, 'matrix-sync.json'),
    private displayName: string = ASSISTANT_NAME,
  ) {}

  async connect(): Promise<void> {
    const me = await this.client.whoami();
    this.userId = me.user_id;

    try {
      await this.client.setDisplayName(this.userId, this.displayName);
    } catch (err) {
      logger.debug({ err }, 'Matrix: could not set display name');
    }

    this.since = this.loadSince();
    if (!this.since) {
      // Fresh install: take a sync position without replaying old rooms, so
      // the bot doesn't answer every message it was ever sent.
      const initial = await this.client.sync({
        timeout: 0,
        filter: INITIAL_SYNC_FILTER,
      });
      await this.processSync(initial, { deliver: false });
      this.saveSince(initial.next_batch);
    }

    this.abort = new AbortController();
    this.loop = this.runSyncLoop(this.abort.signal);

    logger.info({ userId: this.userId }, 'Matrix bot connected');
    console.log(`\n  Matrix bot: ${this.userId}`);
    console.log(`  Send /chatid in a room to get its registration ID\n`);
  }

  private loadSince(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      return typeof raw.since === 'string' ? raw.since : null;
    } catch {
      return null;
    }
  }

  private saveSince(since: string): void {
    this.since = since;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ since }));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      logger.error({ err }, 'Matrix: failed to save sync position');
    }
  }

  private async runSyncLoop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const res = await this.client.sync(
          {
            since: this.since ?? undefined,
            timeout: SYNC_TIMEOUT_MS,
            filter: SYNC_FILTER,
          },
          signal,
        );
        await this.processSync(res, { deliver: true });
        // Saved only after processing: a crash mid-batch replays it rather
        // than silently dropping messages.
        this.saveSince(res.next_batch);
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) return;
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Matrix sync failed — retrying',
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, SYNC_BACKOFF_MAX_MS);
      }
    }
  }

  /** Visible for tests. */
  async processSync(
    res: SyncResponse,
    { deliver }: { deliver: boolean },
  ): Promise<void> {
    for (const [roomId, invited] of Object.entries(res.rooms?.invite ?? {})) {
      await this.handleInvite(roomId, invited.invite_state?.events ?? []);
    }

    for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
      for (const ev of room.state?.events ?? []) this.applyState(roomId, ev);
      for (const ev of room.timeline?.events ?? []) {
        if (ev.state_key !== undefined) {
          this.applyState(roomId, ev);
          continue;
        }
        if (!deliver || ev.type !== 'm.room.message') continue;
        if (ev.sender === this.userId) continue;
        try {
          await this.handleMessage(roomId, ev);
        } catch (err) {
          logger.error(
            { err, roomId, eventId: ev.event_id },
            'Matrix: failed to handle message',
          );
        }
      }
    }
  }

  private applyState(roomId: string, ev: MatrixEvent): void {
    if (ev.type === 'm.room.name' && typeof ev.content.name === 'string') {
      this.roomNames.set(roomId, ev.content.name);
    } else if (ev.type === 'm.room.member' && ev.state_key) {
      let members = this.memberNames.get(roomId);
      if (!members) {
        members = new Map();
        this.memberNames.set(roomId, members);
      }
      if (typeof ev.content.displayname === 'string') {
        members.set(ev.state_key, ev.content.displayname);
      }
    }
  }

  /** Join only when an owner invites — anyone else gets declined. */
  private async handleInvite(
    roomId: string,
    events: MatrixEvent[],
  ): Promise<void> {
    const invite = events.find(
      (e) =>
        e.type === 'm.room.member' &&
        e.state_key === this.userId &&
        e.content.membership === 'invite',
    );
    const inviter = invite?.sender ?? '';
    try {
      if (isOwnerSender(inviter, false)) {
        await this.client.joinRoom(roomId);
        logger.info({ roomId, inviter }, 'Matrix: joined room on invite');
      } else {
        await this.client.leaveRoom(roomId);
        logger.warn(
          { roomId, inviter },
          'Matrix: declined invite from non-owner',
        );
      }
    } catch (err) {
      logger.error({ err, roomId }, 'Matrix: failed to answer invite');
    }
  }

  private senderName(roomId: string, userId: string): string {
    return (
      this.memberNames.get(roomId)?.get(userId) ||
      userId.replace(/^@/, '').split(':')[0]
    );
  }

  private async roomName(roomId: string): Promise<string | undefined> {
    const cached = this.roomNames.get(roomId);
    if (cached) return cached;
    try {
      const { name } = await this.client.getStateEvent<{ name?: string }>(
        roomId,
        'm.room.name',
      );
      if (name) this.roomNames.set(roomId, name);
      return name;
    } catch {
      return undefined;
    }
  }

  private async handleMessage(roomId: string, ev: MatrixEvent): Promise<void> {
    const content = ev.content;
    // Edits re-send the whole message; the original already reached the agent.
    if (content['m.relates_to']?.rel_type === 'm.replace') return;
    if (typeof content.msgtype !== 'string') return; // redacted

    const chatJid = `${MATRIX_JID_PREFIX}${roomId}`;
    const timestamp = new Date(ev.origin_server_ts).toISOString();
    const senderName = this.senderName(roomId, ev.sender);
    const chatName = (await this.roomName(roomId)) || chatJid;

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'matrix', true);

    const msgtype: string = content.msgtype;
    if (
      msgtype === 'm.text' ||
      msgtype === 'm.notice' ||
      msgtype === 'm.emote'
    ) {
      const body = stripReplyFallback(String(content.body ?? '')).trim();
      if (await this.handleChannelText(chatJid, roomId, ev.sender, body)) {
        return;
      }
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Matrix room',
      );
      return;
    }

    let text: string;
    let images: string[] | undefined;

    switch (msgtype) {
      case 'm.text':
      case 'm.notice':
      case 'm.emote':
        text = this.withTrigger(
          stripReplyFallback(String(content.body ?? '')),
          content,
        );
        if (msgtype === 'm.emote') text = `* ${senderName} ${text}`;
        break;
      case 'm.image': {
        const caption = captionOf(content);
        try {
          const dest = await this.saveAttachment(group, 'images', content);
          images = [dest];
          logger.info({ chatJid, dest }, 'Photo downloaded');
        } catch (err) {
          logger.error({ chatJid, err }, 'Failed to download photo');
        }
        text = `[Photo]${caption ? ` ${caption}` : ''}`;
        break;
      }
      case 'm.audio':
        text = isVoice(content)
          ? await this.transcribe(chatJid, content)
          : await this.attachmentText(group, 'Audio', content);
        break;
      case 'm.video':
        text = await this.attachmentText(group, 'Video', content);
        break;
      case 'm.file':
        text = await this.attachmentText(group, 'Document', content);
        break;
      case 'm.location':
        text = `[Location: ${content.geo_uri ?? content.body ?? ''}]`;
        break;
      default:
        text = `[${msgtype.replace(/^m\./, '')}]`;
    }

    this.opts.onMessage(chatJid, {
      id: ev.event_id,
      chat_jid: chatJid,
      sender: ev.sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      images,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Matrix message stored',
    );
  }

  /**
   * Translate a mention of the bot into TRIGGER_PATTERN form. Element X sends
   * mentions as `m.mentions.user_ids` with the display name in the body, which
   * the trigger regex (e.g. ^@Andy\b) won't otherwise match.
   */
  private withTrigger(body: string, content: Record<string, any>): string {
    const mentioned =
      (Array.isArray(content['m.mentions']?.user_ids) &&
        content['m.mentions'].user_ids.includes(this.userId)) ||
      (this.userId !== null && body.includes(this.userId));
    if (mentioned && !TRIGGER_PATTERN.test(body)) {
      return `@${ASSISTANT_NAME} ${body}`;
    }
    return body;
  }

  private async transcribe(
    chatJid: string,
    content: Record<string, any>,
  ): Promise<string> {
    const caption = captionOf(content);
    const suffix = caption ? ` ${caption}` : '';
    try {
      const data = await this.client.download(content.url);
      const tmp = path.join(os.tmpdir(), `mx-voice-${Date.now()}.ogg`);
      fs.writeFileSync(tmp, data);
      const transcript = transcribeVoice(tmp);
      logger.info(
        { chatJid, transcriptLength: transcript.length },
        'Voice message transcribed',
      );
      return `[Voice: ${transcript}]${suffix}`;
    } catch (err) {
      logger.error({ chatJid, err }, 'Voice transcription failed');
      return `[Voice message - transcription failed]${suffix}`;
    }
  }

  /**
   * Save an incoming file into the group folder and tell the agent where it
   * landed — the container mounts the folder at /workspace/group.
   */
  private async attachmentText(
    group: RegisteredGroup,
    label: string,
    content: Record<string, any>,
  ): Promise<string> {
    const name = filenameOf(content);
    const caption = captionOf(content);
    const suffix = caption ? ` ${caption}` : '';
    const size = Number(content.info?.size ?? 0);
    if (size > MAX_MEDIA_BYTES) {
      return `[${label}: ${name} — ${formatBytes(size)}, too large to download]${suffix}`;
    }
    try {
      const dest = await this.saveAttachment(group, 'files', content);
      const inContainer = `/workspace/group/files/${path.basename(dest)}`;
      return `[${label}: ${name} — saved to ${inContainer}]${suffix}`;
    } catch (err) {
      logger.error({ err, name }, 'Failed to download Matrix attachment');
      return `[${label}: ${name} — download failed]${suffix}`;
    }
  }

  private async saveAttachment(
    group: RegisteredGroup,
    subdir: string,
    content: Record<string, any>,
  ): Promise<string> {
    if (typeof content.url !== 'string') {
      throw new Error(
        'Attachment has no url (encrypted rooms are unsupported)',
      );
    }
    const dir = path.join(GROUPS_DIR, group.folder, subdir);
    fs.mkdirSync(dir, { recursive: true });
    let name = safeFilename(filenameOf(content));
    if (!path.extname(name)) {
      name += EXT_BY_MIME[content.info?.mimetype] ?? '';
    }
    const dest = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(dest, await this.client.download(content.url));
    return dest;
  }

  /**
   * Channel-level commands and `/new` answers. Returns true when the text was
   * consumed here and must not reach the agent.
   */
  private async handleChannelText(
    chatJid: string,
    roomId: string,
    sender: string,
    body: string,
  ): Promise<boolean> {
    const pending = this.pendingResets.get(chatJid);
    if (pending && pending.senderId === sender) {
      const answer = RESET_ANSWERS[body.toLowerCase().replace(/[.!]+$/, '')];
      if (answer) {
        await this.answerReset(chatJid, pending, answer);
        return true;
      }
    }

    if (!body.startsWith('/')) return false;
    const [rawCmd, ...rest] = body.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    if (!CHANNEL_COMMANDS.has(cmd)) return false;

    switch (cmd) {
      case 'chatid': {
        const name = (await this.roomName(roomId)) || 'Unnamed room';
        await this.sendMessage(
          chatJid,
          `Chat ID: \`${chatJid}\`\nName: ${name}`,
        );
        break;
      }
      case 'ping':
        await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
        break;
      case 'new':
        await this.startReset(chatJid, sender);
        break;
      case 'mxroom':
        await this.createRoomFor(chatJid, sender, rest.join(' ').trim());
        break;
    }
    return true;
  }

  private async startReset(chatJid: string, sender: string): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await this.sendMessage(chatJid, 'This chat is not registered.');
      return;
    }
    const preview = this.opts.onPreviewReset(group.folder);
    if (preview.empty) {
      await this.sendMessage(chatJid, formatResetPreview(preview));
      return;
    }
    const hasCache = preview.targets.some((t) => t.kind === 'cache');
    this.pendingResets.set(chatJid, {
      groupFolder: group.folder,
      senderId: sender,
      expiresAt: Date.now() + RESET_CONFIRM_TTL_MS,
      hasCache,
    });
    await this.sendMessage(
      chatJid,
      `${formatResetPreview(preview)}\n\n${resetChoices(hasCache, true)}`,
    );
  }

  private async answerReset(
    chatJid: string,
    pending: PendingReset,
    answer: 'all' | 'session' | 'no' | 'list',
  ): Promise<void> {
    if (Date.now() > pending.expiresAt) {
      this.pendingResets.delete(chatJid);
      await this.sendMessage(
        chatJid,
        'That /new prompt expired — nothing was deleted. Send /new again.',
      );
      return;
    }

    if (answer === 'list') {
      const listed = this.opts.onPreviewReset(pending.groupFolder);
      await this.sendMessage(
        chatJid,
        `${formatResetFileList(listed)}\n\n${resetChoices(pending.hasCache, false)}`,
      );
      return;
    }

    this.pendingResets.delete(chatJid);
    if (answer === 'no') {
      await this.sendMessage(chatJid, 'Cancelled — nothing was deleted.');
      return;
    }

    // "keep" only means something when there is a cache to keep.
    const scope: ResetScope =
      answer === 'session' && pending.hasCache ? 'session' : 'all';
    // Re-read now: the container may have written more since the prompt.
    const preview = this.opts.onPreviewReset(pending.groupFolder, scope);
    const resetNote = this.opts.onResetSession(pending.groupFolder, scope);
    logger.info(
      {
        chatJid,
        group: pending.groupFolder,
        scope,
        files: preview.files,
        bytes: preview.bytes,
      },
      'Session reset via /new (confirmed)',
    );
    const kept = scope === 'session' ? ' Caches kept.' : '';
    await this.sendMessage(
      chatJid,
      `Cleared ${preview.files} file${preview.files === 1 ? '' : 's'} ` +
        `(${formatBytes(preview.bytes)}).${kept} ` +
        'Next message starts a fresh conversation.' +
        (resetNote ? `\n${resetNote}` : ''),
    );
  }

  /** `/mxroom <name>` — a new unencrypted room with the asker invited. */
  private async createRoomFor(
    chatJid: string,
    sender: string,
    name: string,
  ): Promise<void> {
    if (!isOwnerSender(sender, false)) {
      await this.sendMessage(chatJid, '⚠️ Only the owner can create rooms.');
      return;
    }
    if (!name) {
      await this.sendMessage(chatJid, 'Usage: /mxroom <name>');
      return;
    }
    const { room_id } = await this.client.createRoom(name, [sender]);
    this.roomNames.set(room_id, name);
    await this.sendMessage(
      chatJid,
      `Created *${name}* and invited you. Chat ID: \`${MATRIX_JID_PREFIX}${room_id}\``,
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.userId) {
      logger.warn('Matrix bot not connected');
      return;
    }
    const roomId = jid.slice(MATRIX_JID_PREFIX.length);
    try {
      for (let i = 0; i < text.length; i += MAX_MESSAGE_CHARS) {
        const chunk = text.slice(i, i + MAX_MESSAGE_CHARS);
        await this.client.sendEvent(roomId, 'm.room.message', {
          msgtype: 'm.text',
          body: chunk,
          format: 'org.matrix.custom.html',
          formatted_body: renderMarkdown(chunk),
        });
      }
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error(
        { jid, err: err instanceof Error ? err.message : String(err) },
        'Failed to send Matrix message',
      );
    }
  }

  /**
   * Upload a file and post it. Errors propagate so callers can report a
   * failed delivery instead of claiming success.
   */
  async sendMedia(
    jid: string,
    filePath: string,
    options: SendMediaOptions = {},
  ): Promise<void> {
    if (!this.userId) {
      logger.warn('Matrix bot not connected');
      return;
    }
    const roomId = jid.slice(MATRIX_JID_PREFIX.length);
    const { size } = fs.statSync(filePath);
    if (size > MAX_MEDIA_BYTES) {
      throw new Error(
        `${path.basename(filePath)} is ${(size / 1024 / 1024).toFixed(1)}MB — over the ${MAX_MEDIA_BYTES / 1024 / 1024}MB upload limit`,
      );
    }

    const filename = path.basename(filePath);
    const mimetype = mimeTypeFor(filePath);
    const kind: OutboundKind =
      options.as === 'document' ? 'm.file' : outboundKindFor(filePath);
    const url = await this.client.upload(
      fs.readFileSync(filePath),
      filename,
      mimetype,
    );

    const info: Record<string, unknown> = { mimetype, size };
    if (kind === 'm.image') {
      const dims = imageSize(filePath);
      if (dims) Object.assign(info, dims);
    }

    // MSC2530: `body` is the caption when it differs from `filename`.
    const content: Record<string, unknown> = {
      msgtype: kind === 'voice' ? 'm.audio' : kind,
      body: options.caption || filename,
      filename,
      url,
      info,
    };
    if (options.caption) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = renderMarkdown(options.caption);
    }
    if (kind === 'voice') {
      content['org.matrix.msc3245.voice'] = {};
      content['org.matrix.msc1767.audio'] = {};
    }

    await this.client.sendEvent(roomId, 'm.room.message', content);
    logger.info({ jid, filePath, kind }, 'Matrix media sent');
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    return this.sendMedia(jid, filePath, { caption });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.userId) return;
    try {
      await this.client.setTyping(
        jid.slice(MATRIX_JID_PREFIX.length),
        this.userId,
        isTyping,
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }

  isConnected(): boolean {
    return this.userId !== null && this.abort !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MATRIX_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.abort) {
      this.abort.abort();
      await this.loop?.catch(() => {});
      this.abort = null;
      this.loop = null;
      logger.info('Matrix bot stopped');
    }
  }
}

function filenameOf(content: Record<string, any>): string {
  return String(content.filename || content.body || 'file');
}

/** MSC2530: a media event's body is a caption only when a filename is set apart. */
function captionOf(content: Record<string, any>): string {
  return content.filename && content.body && content.body !== content.filename
    ? String(content.body)
    : '';
}

function isVoice(content: Record<string, any>): boolean {
  return (
    content['org.matrix.msc3245.voice'] !== undefined ||
    content['org.matrix.msc3245.voice.v2'] !== undefined
  );
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'MATRIX_HOMESERVER',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_DISPLAY_NAME',
  ]);
  const homeserver = process.env.MATRIX_HOMESERVER || env.MATRIX_HOMESERVER;
  const token = process.env.MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN;
  if (!homeserver || !token) {
    logger.warn('Matrix: MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN not set');
    return null;
  }
  return new MatrixChannel(
    new MatrixClient(homeserver, token),
    opts,
    undefined,
    process.env.MATRIX_DISPLAY_NAME ||
      env.MATRIX_DISPLAY_NAME ||
      ASSISTANT_NAME,
  );
});
