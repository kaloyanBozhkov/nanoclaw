/**
 * Telegram relay — a Telegram bot that feeds a project's Matrix room.
 *
 * `/telegram link <token>` in a room ties a BotFather bot to it. Whatever
 * anyone sends that bot is posted into the room so the people there can see
 * it, and — when the sender is approved — handed to the agent exactly like a
 * message typed in Element. The agent's answers to those messages go back to
 * the Telegram chat they came from as well as the room.
 *
 * A bot is reachable by anyone who finds its username, and the agent behind it
 * can edit the project, so a new link starts locked: unknown senders are shown
 * in the room but the agent never sees them until the owner runs
 * `/telegram allow <id>` (or `allow all`).
 *
 * Links live at ~/.config/nanoclaw/telegram-links.json, outside every
 * container mount: a bot token is a credential, and the approved-sender list
 * is a permission an agent must not be able to grant itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TELEGRAM_LINKS_PATH } from './config.js';
import { prepareForVision } from './image-prep.js';
import { logger } from './logger.js';
import { transcribeVoice } from './transcribe.js';
import { NewMessage, RegisteredGroup } from './types.js';

const API_BASE = 'https://api.telegram.org';
/** Long-poll window for getUpdates, in seconds. */
const POLL_TIMEOUT_S = 30;
const MAX_BACKOFF_MS = 60_000;
/** Telegram's per-message text limit. */
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
/** Bot API ceilings: getFile downloads up to 20MB, uploads up to 50MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const ID_PREFIX = 'tg:';
/** How the owner's own messages are signed on Telegram. */
export const OWNER_LABEL = 'koko-human';
/** Room posts remembered for reply routing; older ones fall back to lastChat. */
const MAX_REMEMBERED_POSTS = 1000;
/** Attachment placeholders the channels write — not worth relaying as text. */
const ATTACHMENT_TEXT = /^\[(Photo|Document|Video|Audio|Voice|Location)\b/;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }
}

/** The handful of Bot API calls the relay needs, over plain fetch. */
export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const isForm = params instanceof FormData;
    const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? params : JSON.stringify(params),
      signal,
    });
    let data: {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {}
    if (!data.ok) {
      throw new TelegramApiError(
        method,
        data.error_code ?? res.status,
        data.description ?? res.statusText,
        data.parameters?.retry_after,
      );
    }
    return data.result as T;
  }

  async download(fileId: string): Promise<Buffer> {
    const file = await this.call<TgFile>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('Telegram returned no file_path');
    const res = await this.fetchImpl(
      `${API_BASE}/file/bot${this.token}/${file.file_path}`,
    );
    if (!res.ok) throw new Error(`File download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// --- Bot API shapes (only the fields read here) ---

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
}

interface TgFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  document?: TgFile;
  sticker?: { emoji?: string };
  location?: { latitude: number; longitude: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

// --- Persisted links ---

export interface TelegramLink {
  token: string;
  botId: number;
  botUsername: string;
  linkedAt: string;
  linkedBy: string;
  /** Everyone the bot hears reaches the agent. */
  allowAll: boolean;
  /** Approved senders, id → display name. */
  allowed: Record<string, string>;
  /** Senders seen but not approved, id → display name. */
  pending: Record<string, string>;
  /** Last getUpdates id handled, so a restart doesn't replay. */
  lastUpdateId: number;
  /** The approved chat that wrote last — where the owner's messages go. */
  lastChat?: { id: number; name: string };
}

interface LinkState {
  links: Record<string, TelegramLink>;
}

export interface TelegramRelayDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Hand a message to the agent, as if it had been typed in the room. */
  deliver: (msg: NewMessage) => void;
  /** Post into the linked Matrix room; resolves to the post's ID if known. */
  post: (roomJid: string, text: string) => Promise<string | void>;
  postMedia?: (
    roomJid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  fetchImpl?: typeof fetch;
  statePath?: string;
}

/** Whatever the agent should read for one Telegram message. */
interface Inbound {
  text: string;
  images?: string[];
  /** A photo to show in the room alongside the text. */
  roomMedia?: string;
}

function displayName(m: TgMessage): string {
  if (!m.from) return m.chat.title || String(m.chat.id);
  const full = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
  return full || m.from.username || String(m.from.id);
}

/** Who sent it: the user, or the channel itself for a channel post. */
function senderId(m: TgMessage): string {
  return String(m.from?.id ?? m.chat.id);
}

/** `tg:<bot>:<chat>:<message>` — the chat is what a reply goes back to. */
function messageId(botId: number, m: TgMessage): string {
  return `${ID_PREFIX}${botId}:${m.chat.id}:${m.message_id}`;
}

function chatOfMessageId(id: string, botId: number): number | null {
  const match = /^tg:(\d+):(-?\d+):\d+$/.exec(id);
  if (!match || Number(match[1]) !== botId) return null;
  return Number(match[2]);
}

/** Split on line breaks where possible so code blocks survive. */
export function chunkText(text: string, max = MAX_TEXT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isPhotoFile(filePath: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(filePath);
}

export class TelegramRelay {
  private state: LinkState = { links: {} };
  private polls = new Map<string, AbortController>();
  /**
   * Per room, the Telegram chats whose messages are in the batch the agent is
   * answering right now. Only those get the agent's output — a later batch
   * typed in Element clears it, so a room-only conversation never leaks out.
   */
  private replyTargets = new Map<string, Set<number>>();
  /** Room post ID → the Telegram chat it shows, so a reply can go back. */
  private posted = new Map<
    string,
    { roomJid: string; chatId: number; name: string }
  >();
  /** Rooms already told that the owner's message had nowhere to go. */
  private warnedNoTarget = new Set<string>();
  private readonly statePath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: TelegramRelayDeps) {
    this.statePath = deps.statePath ?? TELEGRAM_LINKS_PATH;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    this.state = this.load();
    for (const roomJid of Object.keys(this.state.links))
      this.startPoll(roomJid);
  }

  stop(): void {
    for (const ctrl of this.polls.values()) ctrl.abort();
    this.polls.clear();
  }

  getLink(roomJid: string): TelegramLink | undefined {
    return this.state.links[roomJid];
  }

  // --- Commands ---

  /**
   * `/telegram [status|link <token>|unlink|allow <id|all>|deny <id|all>]`.
   * Returns the reply for the room.
   */
  async handleCommand(
    roomJid: string,
    arg: string,
    isOwner: boolean,
    sender: string,
  ): Promise<string> {
    if (!this.deps.registeredGroups()[roomJid]) {
      return 'This chat is not registered.';
    }
    const [sub = 'status', value = ''] = arg.trim().split(/\s+/);
    const cmd = sub.toLowerCase();
    if (cmd === 'status') return this.describe(roomJid);
    if (!['link', 'unlink', 'allow', 'deny'].includes(cmd)) return USAGE;
    if (!isOwner) return '⚠️ Only the owner can change the Telegram link.';

    switch (cmd) {
      case 'link':
        return this.link(roomJid, value, sender);
      case 'unlink':
        return this.unlink(roomJid);
      default:
        return this.setAllowed(roomJid, value, cmd === 'allow');
    }
  }

  private async link(
    roomJid: string,
    token: string,
    sender: string,
  ): Promise<string> {
    if (!TOKEN_PATTERN.test(token)) {
      return '⚠️ That doesn’t look like a bot token. Create a bot with @BotFather and send `/telegram link <token>`.';
    }
    const api = new TelegramBotApi(token, this.fetchImpl);
    let me: TgUser;
    try {
      me = await api.call<TgUser>('getMe');
      // getUpdates refuses to run while a webhook is set.
      await api.call('deleteWebhook');
    } catch (err) {
      logger.warn({ err: describeError(err) }, 'Telegram link rejected');
      return `⚠️ Telegram rejected that token: ${describeError(err)}`;
    }

    const notes: string[] = [];
    for (const [otherJid, other] of Object.entries(this.state.links)) {
      if (other.botId === me.id && otherJid !== roomJid) {
        // One poller per bot — Telegram answers a second getUpdates with 409.
        this.stopPoll(otherJid);
        delete this.state.links[otherJid];
        notes.push('It was linked to another room before; that link is gone.');
        void this.deps
          .post(otherJid, `📨 @${other.botUsername} was moved to another room.`)
          .catch(() => {});
      }
    }

    const previous = this.state.links[roomJid];
    this.stopPoll(roomJid);
    const sameBot = previous?.botId === me.id;
    this.state.links[roomJid] = {
      token,
      botId: me.id,
      botUsername: me.username ?? String(me.id),
      linkedAt: new Date().toISOString(),
      linkedBy: sender,
      allowAll: sameBot ? previous.allowAll : false,
      allowed: sameBot ? previous.allowed : {},
      pending: sameBot ? previous.pending : {},
      lastUpdateId: sameBot ? previous.lastUpdateId : 0,
    };
    this.save();
    this.startPoll(roomJid);

    const username = me.username ?? String(me.id);
    return [
      `✅ Linked @${username} to this room — https://t.me/${username}`,
      ...notes,
      '',
      sameBot && (previous.allowAll || Object.keys(previous.allowed).length)
        ? 'Approved senders were kept.'
        : '🔒 It starts locked: when someone messages the bot you’ll see it here with their ID, and the agent answers them once you send `/telegram allow <id>` (or `/telegram allow all`).',
      '',
      `Everything you write here also goes to Telegram as “${OWNER_LABEL}: …” — to the person you reply to, or else whoever wrote last.`,
    ].join('\n');
  }

  private unlink(roomJid: string): string {
    const link = this.state.links[roomJid];
    if (!link) return 'No Telegram bot is linked to this room.';
    this.stopPoll(roomJid);
    delete this.state.links[roomJid];
    this.replyTargets.delete(roomJid);
    this.save();
    return `Unlinked @${link.botUsername}. Its token is forgotten — revoke it in @BotFather too if it’s no longer needed.`;
  }

  private setAllowed(roomJid: string, value: string, allow: boolean): string {
    const link = this.state.links[roomJid];
    if (!link) return 'No Telegram bot is linked to this room.';
    const verb = allow ? 'allow' : 'deny';
    if (!value) return `Usage: \`/telegram ${verb} <id|all>\``;

    if (value.toLowerCase() === 'all') {
      if (allow) {
        link.allowAll = true;
        Object.assign(link.allowed, link.pending);
        link.pending = {};
      } else {
        link.allowAll = false;
        link.allowed = {};
      }
      this.save();
      return allow
        ? `🔓 The agent now answers everyone who messages @${link.botUsername}.`
        : `🔒 Locked: the agent answers nobody on @${link.botUsername} until you \`/telegram allow <id>\`.`;
    }

    if (!/^-?\d+$/.test(value)) return `Usage: \`/telegram ${verb} <id|all>\``;
    if (allow) {
      const name = link.pending[value] ?? link.allowed[value] ?? value;
      link.allowed[value] = name;
      delete link.pending[value];
      this.save();
      return `✅ The agent will answer ${name} (${value}) on @${link.botUsername}.${link.allowAll ? ' (Everyone is allowed anyway.)' : ''}`;
    }
    const name = link.allowed[value] ?? value;
    delete link.allowed[value];
    this.save();
    return link.allowAll
      ? `Removed ${name} (${value}), but everyone is still allowed — \`/telegram deny all\` to lock.`
      : `🔒 The agent no longer answers ${name} (${value}).`;
  }

  private describe(roomJid: string): string {
    const link = this.state.links[roomJid];
    if (!link) {
      return `No Telegram bot is linked to this room.\n\n${USAGE}`;
    }
    const people = (r: Record<string, string>) =>
      Object.entries(r)
        .map(([id, name]) => `${name} (${id})`)
        .join(', ');
    const lines = [
      `📨 Linked: @${link.botUsername} — https://t.me/${link.botUsername}`,
      `Polling: ${this.polls.has(roomJid) ? 'on' : 'off'}`,
      link.allowAll
        ? 'Agent answers: everyone'
        : `Agent answers: ${people(link.allowed) || 'nobody yet'}`,
    ];
    const waiting = people(link.pending);
    if (waiting) lines.push(`Waiting for approval: ${waiting}`);
    return lines.join('\n');
  }

  // --- Agent output back to Telegram ---

  /**
   * Record which batch the agent is about to answer. Called with every batch
   * handed to the agent, so output always goes to whoever asked last.
   */
  noteBatch(roomJid: string, messages: NewMessage[]): void {
    const link = this.state.links[roomJid];
    if (!link) return;
    const chats = new Set<number>();
    for (const m of messages) {
      const chat = chatOfMessageId(m.id, link.botId);
      if (chat !== null) chats.add(chat);
    }
    if (chats.size > 0) this.replyTargets.set(roomJid, chats);
    else this.replyTargets.delete(roomJid);
  }

  /** Send agent output to the Telegram chats it is answering. */
  async mirrorText(roomJid: string, text: string): Promise<void> {
    const targets = this.targetsFor(roomJid);
    if (!targets) return;
    for (const chatId of targets.chats) {
      for (const chunk of chunkText(text)) {
        await targets.api
          .call('sendMessage', { chat_id: chatId, text: chunk })
          .catch((err) =>
            logger.warn(
              { roomJid, chatId, err: describeError(err) },
              'Telegram relay: reply failed',
            ),
          );
      }
    }
  }

  async mirrorMedia(
    roomJid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const targets = this.targetsFor(roomJid);
    if (!targets) return;
    const { size } = fs.statSync(filePath);
    if (size > MAX_UPLOAD_BYTES) {
      logger.warn({ roomJid, filePath, size }, 'Telegram relay: file too big');
      return;
    }
    const asPhoto = isPhotoFile(filePath) && size <= MAX_PHOTO_BYTES;
    const data = fs.readFileSync(filePath);
    for (const chatId of targets.chats) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(
        asPhoto ? 'photo' : 'document',
        new Blob([data]),
        path.basename(filePath),
      );
      if (caption) form.append('caption', caption.slice(0, MAX_CAPTION));
      await targets.api
        .call(asPhoto ? 'sendPhoto' : 'sendDocument', form)
        .catch((err) =>
          logger.warn(
            { roomJid, chatId, err: describeError(err) },
            'Telegram relay: file reply failed',
          ),
        );
    }
  }

  private targetsFor(
    roomJid: string,
  ): { api: TelegramBotApi; chats: Set<number> } | null {
    const link = this.state.links[roomJid];
    const chats = this.replyTargets.get(roomJid);
    if (!link || !chats?.size) return null;
    return { api: new TelegramBotApi(link.token, this.fetchImpl), chats };
  }

  // --- The owner's messages out to Telegram ---

  /**
   * Send something the owner wrote in the room to Telegram, signed
   * `koko-human:`. A reply to a relayed message goes to that message's chat;
   * anything else goes to the approved chat that wrote last. Commands never
   * reach here — index.ts intercepts them before storage.
   */
  async forwardOwnerMessage(roomJid: string, msg: NewMessage): Promise<void> {
    const link = this.state.links[roomJid];
    if (!link) return;
    const replied = msg.reply_to ? this.posted.get(msg.reply_to) : undefined;
    const target =
      replied && replied.roomJid === roomJid
        ? { id: replied.chatId, name: replied.name }
        : link.lastChat;
    if (!target) {
      if (!this.warnedNoTarget.has(roomJid)) {
        this.warnedNoTarget.add(roomJid);
        await this.deps.post(
          roomJid,
          `📨 Not sent to Telegram — nobody approved has messaged @${link.botUsername} yet.`,
        );
      }
      return;
    }

    const api = new TelegramBotApi(link.token, this.fetchImpl);
    const text = msg.content
      .replace(new RegExp(`^@${ASSISTANT_NAME}\\b\\s*`, 'i'), '')
      .trim();
    try {
      const photos = (msg.images ?? []).filter((p) => fs.existsSync(p));
      if (photos.length > 0) {
        const caption = text.replace(/^\[Photo[^\]]*\]\s*/, '');
        for (const photo of photos) {
          const form = new FormData();
          form.append('chat_id', String(target.id));
          form.append('photo', new Blob([fs.readFileSync(photo)]), 'photo.jpg');
          form.append(
            'caption',
            `${OWNER_LABEL}:${caption ? ` ${caption}` : ''}`.slice(
              0,
              MAX_CAPTION,
            ),
          );
          await api.call('sendPhoto', form);
        }
        return;
      }
      if (!text || ATTACHMENT_TEXT.test(text)) return;
      for (const chunk of chunkText(`${OWNER_LABEL}: ${text}`)) {
        await api.call('sendMessage', { chat_id: target.id, text: chunk });
      }
    } catch (err) {
      logger.warn(
        { roomJid, chatId: target.id, err: describeError(err) },
        'Telegram relay: owner message failed',
      );
      await this.deps.post(
        roomJid,
        `⚠️ Couldn’t send that to ${target.name} on Telegram: ${describeError(err)}`,
      );
    }
  }

  private remember(
    postId: string | void,
    roomJid: string,
    chatId: number,
    name: string,
  ): void {
    if (!postId) return;
    this.posted.set(postId, { roomJid, chatId, name });
    if (this.posted.size > MAX_REMEMBERED_POSTS) {
      this.posted.delete(this.posted.keys().next().value!);
    }
  }

  // --- Polling ---

  private startPoll(roomJid: string): void {
    const ctrl = new AbortController();
    this.polls.set(roomJid, ctrl);
    void this.poll(roomJid, ctrl.signal);
  }

  private stopPoll(roomJid: string): void {
    this.polls.get(roomJid)?.abort();
    this.polls.delete(roomJid);
  }

  private async poll(roomJid: string, signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      const link = this.state.links[roomJid];
      if (!link) return;
      const api = new TelegramBotApi(link.token, this.fetchImpl);
      try {
        const updates = await api.call<TgUpdate[]>(
          'getUpdates',
          {
            offset: link.lastUpdateId + 1,
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ['message', 'channel_post'],
          },
          signal,
        );
        backoff = 1000;
        for (const update of updates) {
          if (signal.aborted) return;
          link.lastUpdateId = update.update_id;
          const msg = update.message ?? update.channel_post;
          if (!msg) continue;
          try {
            await this.handleIncoming(roomJid, link, api, msg);
          } catch (err) {
            logger.error(
              { roomJid, err: describeError(err) },
              'Telegram relay: failed to handle message',
            );
          }
        }
        if (updates.length > 0) this.save();
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramApiError && err.code === 401) {
          logger.warn({ roomJid }, 'Telegram relay: token revoked');
          this.polls.delete(roomJid);
          await this.deps
            .post(
              roomJid,
              `⚠️ Telegram no longer accepts the token for @${link.botUsername} — it was probably revoked. Send \`/telegram link <new token>\` to reconnect.`,
            )
            .catch(() => {});
          return;
        }
        const wait = (err as TelegramApiError).retryAfter
          ? (err as TelegramApiError).retryAfter! * 1000
          : backoff;
        logger.warn(
          { roomJid, err: describeError(err), waitMs: wait },
          'Telegram relay: poll failed, retrying',
        );
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await sleep(wait, signal);
      }
    }
  }

  // --- Inbound ---

  async handleIncoming(
    roomJid: string,
    link: TelegramLink,
    api: TelegramBotApi,
    msg: TgMessage,
  ): Promise<void> {
    if (msg.from?.is_bot) return;
    const group = this.deps.registeredGroups()[roomJid];
    if (!group) return;

    const id = senderId(msg);
    const name = displayName(msg);
    const approved = link.allowAll || id in link.allowed;
    const isStart = /^\/start(@\S+)?(\s|$)/.test(msg.text ?? '');

    if (!approved) {
      const isNew = !(id in link.pending);
      link.pending[id] = name;
      this.save();
      const summary = isStart ? 'started the bot' : describeBrief(msg);
      const postId = await this.deps.post(
        roomJid,
        `📨 **${name}** · Telegram (not approved): ${summary}` +
          (isNew
            ? `\n\nThe agent won’t see messages from ${name} until you send \`/telegram allow ${id}\`.`
            : ''),
      );
      this.remember(postId, roomJid, msg.chat.id, name);
      return;
    }

    // Approved senders opening the chat don't need an answer from the agent.
    if (isStart) return;

    link.lastChat = { id: msg.chat.id, name };
    this.save();
    this.warnedNoTarget.delete(roomJid);
    const inbound = await this.readMessage(group, api, msg);
    const postId = await this.deps
      .post(roomJid, `📨 **${name}** · Telegram: ${inbound.text}`)
      .catch((err) =>
        logger.warn({ roomJid, err }, 'Telegram relay: room post failed'),
      );
    this.remember(postId, roomJid, msg.chat.id, name);
    if (inbound.roomMedia && this.deps.postMedia) {
      await this.deps
        .postMedia(roomJid, inbound.roomMedia)
        .catch((err) =>
          logger.warn({ roomJid, err }, 'Telegram relay: room media failed'),
        );
    }

    // Every Telegram message should get an answer, so it carries the trigger
    // in rooms that otherwise wait for one.
    const needsTrigger = !group.isMain && group.requiresTrigger !== false;
    this.deps.deliver({
      id: messageId(link.botId, msg),
      chat_jid: roomJid,
      sender: `${ID_PREFIX}${id}`,
      sender_name: `${name} (Telegram)`,
      content: needsTrigger
        ? `@${ASSISTANT_NAME} ${inbound.text}`
        : inbound.text,
      // Arrival time, not Telegram's send time: the message loop only reads
      // rows newer than its cursor, so an update queued while NanoClaw was
      // down would otherwise be skipped for good.
      timestamp: new Date().toISOString(),
      is_from_me: false,
      images: inbound.images,
    });
    logger.info(
      { roomJid, sender: name, bot: link.botUsername },
      'Telegram relay: message delivered',
    );
  }

  private async readMessage(
    group: RegisteredGroup,
    api: TelegramBotApi,
    msg: TgMessage,
  ): Promise<Inbound> {
    const caption = msg.caption ? ` ${msg.caption}` : '';
    if (msg.text) return { text: msg.text };

    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      try {
        const dest = await this.saveFile(group, 'images', api, largest, '.jpg');
        const original = `/workspace/group/images/${path.basename(dest)}`;
        const vision = prepareForVision(dest);
        const note = !vision
          ? ` (couldn't be shown — saved to ${original})`
          : vision !== dest
            ? ` (full resolution: ${original})`
            : '';
        return {
          text: `[Photo${note}]${caption}`,
          images: vision ? [vision] : undefined,
          roomMedia: dest,
        };
      } catch (err) {
        logger.error({ err: describeError(err) }, 'Telegram photo failed');
        return { text: `[Photo — download failed]${caption}` };
      }
    }

    if (msg.voice) {
      try {
        const data = await api.download(msg.voice.file_id);
        const tmp = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);
        fs.writeFileSync(tmp, data);
        return { text: `[Voice: ${transcribeVoice(tmp)}]${caption}` };
      } catch (err) {
        logger.error({ err: describeError(err) }, 'Telegram voice failed');
        return { text: `[Voice message - transcription failed]${caption}` };
      }
    }

    const attachment: [string, TgFile | undefined][] = [
      ['Document', msg.document],
      ['Video', msg.video ?? msg.video_note],
      ['Audio', msg.audio],
    ];
    for (const [label, file] of attachment) {
      if (!file) continue;
      const name = file.file_name ?? label.toLowerCase();
      if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
        return {
          text: `[${label}: ${name} — over Telegram's 20MB bot download limit]${caption}`,
        };
      }
      try {
        const dest = await this.saveFile(group, 'files', api, file);
        return {
          text: `[${label}: ${name} — saved to /workspace/group/files/${path.basename(dest)}]${caption}`,
        };
      } catch (err) {
        logger.error({ err: describeError(err) }, 'Telegram file failed');
        return { text: `[${label}: ${name} — download failed]${caption}` };
      }
    }

    if (msg.sticker) return { text: `[Sticker ${msg.sticker.emoji ?? ''}]` };
    if (msg.location) {
      return {
        text: `[Location: ${msg.location.latitude},${msg.location.longitude}]`,
      };
    }
    return { text: '[Unsupported Telegram message]' };
  }

  private async saveFile(
    group: RegisteredGroup,
    subdir: string,
    api: TelegramBotApi,
    file: TgFile,
    fallbackExt = '',
  ): Promise<string> {
    const dir = path.join(GROUPS_DIR, group.folder, subdir);
    fs.mkdirSync(dir, { recursive: true });
    const base = (file.file_name ?? `file${fallbackExt}`).replace(
      /[^\w.-]+/g,
      '_',
    );
    const dest = path.join(dir, `tg-${Date.now()}-${base}`);
    fs.writeFileSync(dest, await api.download(file.file_id));
    return dest;
  }

  // --- State file ---

  private load(): LinkState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      if (raw && typeof raw.links === 'object' && raw.links) {
        return { links: raw.links as Record<string, TelegramLink> };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'Telegram relay: unreadable links file');
      }
    }
    return { links: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }
}

const USAGE = [
  '`/telegram link <token>` — link a @BotFather bot to this room',
  '`/telegram allow <id|all>` · `/telegram deny <id|all>` — who the agent answers',
  '`/telegram unlink` — disconnect the bot',
  '`/telegram` — status',
].join('\n');

/** What an unapproved message was, without downloading anything from it. */
function describeBrief(msg: TgMessage): string {
  if (msg.text) return msg.text;
  const kind = msg.photo
    ? 'Photo'
    : msg.voice
      ? 'Voice message'
      : msg.document
        ? `Document: ${msg.document.file_name ?? 'file'}`
        : msg.video || msg.video_note
          ? 'Video'
          : msg.audio
            ? 'Audio'
            : msg.sticker
              ? `Sticker ${msg.sticker.emoji ?? ''}`
              : 'Message';
  return `[${kind}]${msg.caption ? ` ${msg.caption}` : ''}`;
}

/** Never includes the token: fetch errors don't carry the URL. */
function describeError(err: unknown): string {
  if (err instanceof TelegramApiError) return err.description;
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
