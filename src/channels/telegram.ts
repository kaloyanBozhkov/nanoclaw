import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

import {
  Api,
  Bot,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
} from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  formatBytes,
  formatResetFileList,
  formatResetPreview,
  ResetPreview,
  TELEGRAM_MAX_CHARS,
} from '../session-reset.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMediaOptions,
} from '../types.js';

const WHISPER_MODEL_PATH = path.join(
  process.cwd(),
  'data',
  'models',
  'ggml-base.en.bin',
);

/**
 * Download a Telegram file to a temporary path.
 */
async function downloadTelegramFile(
  api: Api,
  fileId: string,
  destPath: string,
): Promise<void> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error('No file_path returned from Telegram');

  const url = `https://api.telegram.org/file/bot${api.token}/${filePath}`;
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        res.pipe(out);
        out.on('finish', () => {
          out.close();
          resolve();
        });
      })
      .on('error', reject);
  });
}

/**
 * Transcribe an OGG voice file using local whisper-cli.
 * Telegram voice notes are OGG/Opus — convert to 16kHz WAV first.
 */
function transcribeVoice(oggPath: string): string {
  const wavPath = oggPath.replace(/\.ogg$/, '.wav');
  try {
    // Convert OGG/Opus to 16kHz mono WAV (required by whisper-cli)
    execSync(
      `/opt/homebrew/bin/ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`,
      { timeout: 15000, stdio: 'pipe' },
    );

    const output = execSync(
      `/opt/homebrew/bin/whisper-cli -m "${WHISPER_MODEL_PATH}" -f "${wavPath}" --no-timestamps -np`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    return output.trim();
  } finally {
    try {
      fs.unlinkSync(oggPath);
    } catch {}
    try {
      fs.unlinkSync(wavPath);
    } catch {}
  }
}

/**
 * Telegram rejects a whole send when a caption's Markdown doesn't parse —
 * an unclosed entity from a stray `_` or `*` (e.g. "see file_name.png").
 */
function isCaptionParseError(err: unknown): boolean {
  return err instanceof Error && /can't parse entities/i.test(err.message);
}

/** Telegram Bot API upload ceiling for uploaded files. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Telegram compresses photos and caps them well below other file types. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

type MediaKind =
  | 'photo'
  | 'animation'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document';

/**
 * Pick the Telegram send method for a file, by extension.
 *
 * Every typed method re-encodes: sendPhoto flattens animation to one JPEG
 * frame, sendAnimation/sendVideo transcode to MP4 (dropping any alpha
 * channel). sendDocument is the only lossless option, and the only one that
 * accepts arbitrary types — Telegram's typed methods each take a narrow
 * format list and reject the rest, so anything unrecognised goes as a
 * document rather than a guess that errors.
 */
function mediaKindFor(filePath: string): MediaKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.webp':
      return 'photo';
    case '.gif':
      return 'animation';
    case '.mp4':
      return 'video';
    case '.mp3':
    case '.m4a':
      return 'audio';
    case '.ogg':
    case '.oga':
    case '.opus':
      return 'voice';
    default:
      return 'document';
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onResetSession: (groupFolder: string) => void;
  onPreviewReset: (groupFolder: string) => ResetPreview;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Unpack a Telegram failure into something greppable.
 *
 * A bare `err.message` on a GrammyError drops the method, error code, and
 * description — which is how a 400 MESSAGE_TOO_LONG once presented itself as a
 * button that simply did nothing.
 */
function describeTelegramError(err: unknown): Record<string, unknown> {
  if (err instanceof GrammyError) {
    return {
      err: err.message,
      method: err.method,
      errorCode: err.error_code,
      description: err.description,
    };
  }
  if (err instanceof HttpError) {
    return { err: err.message, cause: String(err.error) };
  }
  return { err: err instanceof Error ? err.message : String(err) };
}

/**
 * Edit a message, falling back to a fresh reply when the edit is rejected.
 *
 * A swallowed edit failure is indistinguishable from a dead button, so this
 * never fails silently: it truncates to Telegram's limit, and if the edit is
 * still refused it posts the text as a new message.
 */
async function editOrReply(
  ctx: {
    editMessageText: (text: string, extra?: object) => Promise<unknown>;
    reply: (text: string, extra?: object) => Promise<unknown>;
  },
  text: string,
  extra?: object,
): Promise<void> {
  const body =
    text.length > TELEGRAM_MAX_CHARS
      ? `${text.slice(0, TELEGRAM_MAX_CHARS - 1)}…`
      : text;
  try {
    await ctx.editMessageText(body, extra);
  } catch (err) {
    logger.warn(
      describeTelegramError(err),
      'editMessageText failed — replying instead',
    );
    try {
      await ctx.reply(body, extra);
    } catch (replyErr) {
      logger.error(
        describeTelegramError(replyErr),
        'Fallback reply also failed',
      );
    }
  }
}

/** Acknowledge a callback; never let the ack itself break the handler. */
async function safeAnswer(
  ctx: { answerCallbackQuery: (arg?: object) => Promise<unknown> },
  text?: string,
  showAlert = false,
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(
      text ? { text, show_alert: showAlert } : undefined,
    );
  } catch (err) {
    logger.debug(describeTelegramError(err), 'answerCallbackQuery failed');
  }
}

/** How long a pending `/new` confirmation stays answerable. */
const RESET_CONFIRM_TTL_MS = 2 * 60 * 1000;

interface PendingReset {
  groupFolder: string;
  /** Only the user who ran `/new` may answer it. */
  senderId: number;
  expiresAt: number;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  /** Unanswered `/new` confirmations, keyed by chat JID. */
  private pendingResets = new Map<string, PendingReset>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to reset conversation — deletion is irreversible, so summarize
    // what goes and wait for an explicit yes.
    this.bot.command('new', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.reply('This chat is not registered.');
        return;
      }

      const preview = this.opts.onPreviewReset(group.folder);
      if (preview.empty) {
        await ctx.reply(formatResetPreview(preview));
        return;
      }

      const senderId = ctx.from?.id;
      if (senderId === undefined) {
        await ctx.reply("Couldn't identify who sent that — try again.");
        return;
      }

      this.pendingResets.set(chatJid, {
        groupFolder: group.folder,
        senderId,
        expiresAt: Date.now() + RESET_CONFIRM_TTL_MS,
      });

      await ctx.reply(formatResetPreview(preview), {
        reply_markup: new InlineKeyboard()
          .text('Yes, clear it', 'new:yes')
          .text('Cancel', 'new:no')
          .row()
          .text('List files', 'new:list'),
      });
    });

    // Answer to the /new confirmation above.
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data !== 'new:yes' && data !== 'new:no' && data !== 'new:list') {
        return;
      }

      const chatJid = `tg:${ctx.chat?.id}`;

      // A throw anywhere below would otherwise surface as a button that does
      // nothing — always leave the user with an answer.
      try {
        const pending = this.pendingResets.get(chatJid);

        if (!pending || Date.now() > pending.expiresAt) {
          this.pendingResets.delete(chatJid);
          await safeAnswer(ctx, 'That prompt expired.');
          await editOrReply(ctx, 'Reset prompt expired — nothing was deleted.');
          return;
        }

        // Anyone can tap a button in a group chat; only the asker decides.
        if (ctx.from.id !== pending.senderId) {
          await safeAnswer(ctx, 'Only whoever ran /new can answer this.', true);
          return;
        }

        // Expand the summary into per-file paths. The decision is still
        // pending, so keep the entry alive and leave Yes/Cancel on the message.
        if (data === 'new:list') {
          const listed = this.opts.onPreviewReset(pending.groupFolder);
          await safeAnswer(ctx);
          await editOrReply(ctx, formatResetFileList(listed), {
            reply_markup: new InlineKeyboard()
              .text('Yes, clear it', 'new:yes')
              .text('Cancel', 'new:no'),
          });
          return;
        }

        this.pendingResets.delete(chatJid);

        if (data === 'new:no') {
          await safeAnswer(ctx, 'Cancelled.');
          await editOrReply(ctx, 'Cancelled — nothing was deleted.');
          return;
        }

        // Re-read now: the container has been running since the prompt was
        // shown, so report what actually goes rather than the stale preview.
        const preview = this.opts.onPreviewReset(pending.groupFolder);
        this.opts.onResetSession(pending.groupFolder);
        logger.info(
          {
            chatJid,
            group: pending.groupFolder,
            files: preview.files,
            bytes: preview.bytes,
          },
          'Session reset via /new (confirmed)',
        );
        // Deletion already happened — the confirmation text is cosmetic, so a
        // failure here must not read as "the reset failed".
        await safeAnswer(ctx, 'Cleared.');
        await editOrReply(
          ctx,
          `Cleared ${preview.files} file${preview.files === 1 ? '' : 's'} ` +
            `(${formatBytes(preview.bytes)}). Next message starts a fresh conversation.`,
        );
      } catch (err) {
        logger.error(
          { ...describeTelegramError(err), chatJid, data },
          'Reset callback failed',
        );
        await safeAnswer(
          ctx,
          'Something went wrong handling that — check the logs.',
          true,
        );
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping', 'new']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Download the largest photo size to the group's images folder
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      let images: string[] | undefined;

      try {
        const imagesDir = path.join(GROUPS_DIR, group.folder, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        const filename = `${Date.now()}-${ctx.message.message_id}.jpg`;
        const destPath = path.join(imagesDir, filename);
        await downloadTelegramFile(this.bot!.api, largest.file_id, destPath);
        images = [destPath];
        logger.info({ chatJid, destPath }, 'Photo downloaded');
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download photo');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `[Photo]${caption}`,
        timestamp,
        is_from_me: false,
        images,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    // Voice messages: download, transcribe locally with whisper-cli, deliver as text
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content: string;
      try {
        const fileId = ctx.message.voice.file_id;
        const tmpDir = os.tmpdir();
        const oggPath = path.join(tmpDir, `tg-voice-${Date.now()}.ogg`);

        await downloadTelegramFile(this.bot!.api, fileId, oggPath);
        const transcript = transcribeVoice(oggPath);
        content = `[Voice: ${transcript}]${caption}`;
        logger.info(
          { chatJid, senderName, transcriptLength: transcript.length },
          'Voice message transcribed',
        );
      } catch (err) {
        logger.error({ chatJid, err }, 'Voice transcription failed');
        content = `[Voice message - transcription failed]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error(
        {
          ...describeTelegramError(err.error),
          update: err.ctx?.update?.update_id,
          stack: err.stack,
        },
        'Telegram bot error',
      );
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Send any file type. Errors propagate: a swallowed failure here is how a
   * GIF could be reported as delivered while the user received a flattened
   * JPEG, so callers need to be able to see the send fail.
   */
  async sendMedia(
    jid: string,
    filePath: string,
    options: SendMediaOptions = {},
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const { size } = fs.statSync(filePath);
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${path.basename(filePath)} is ${(size / 1024 / 1024).toFixed(1)}MB — over Telegram's ${MAX_UPLOAD_BYTES / 1024 / 1024}MB bot upload limit`,
      );
    }

    let kind: MediaKind =
      options.as === 'document' ? 'document' : mediaKindFor(filePath);
    // Telegram rejects oversized photos outright; as a document it still arrives.
    if (kind === 'photo' && size > MAX_PHOTO_BYTES) kind = 'document';

    // A fresh InputFile per attempt — the underlying stream is single-use.
    const send = (as: MediaKind, markdown: boolean) => {
      const file = new InputFile(filePath);
      const opts = options.caption
        ? {
            caption: options.caption,
            ...(markdown ? { parse_mode: 'Markdown' as const } : {}),
          }
        : {};
      switch (as) {
        case 'photo':
          return this.bot!.api.sendPhoto(numericId, file, opts);
        case 'animation':
          return this.bot!.api.sendAnimation(numericId, file, opts);
        case 'video':
          return this.bot!.api.sendVideo(numericId, file, opts);
        case 'audio':
          return this.bot!.api.sendAudio(numericId, file, opts);
        case 'voice':
          return this.bot!.api.sendVoice(numericId, file, opts);
        case 'document':
          return this.bot!.api.sendDocument(numericId, file, opts);
      }
    };

    // Mirrors sendTelegramMessage: retry without Markdown when the caption
    // fails to parse. Losing the formatting beats losing the file.
    const sendWithCaption = async (as: MediaKind) => {
      try {
        return await send(as, true);
      } catch (err) {
        if (!options.caption || !isCaptionParseError(err)) throw err;
        logger.debug(
          { jid, filePath, as },
          'Markdown caption rejected, retrying as plain text',
        );
        return await send(as, false);
      }
    };

    try {
      await sendWithCaption(kind);
      logger.info({ jid, filePath, kind }, 'Telegram media sent');
    } catch (err) {
      if (kind === 'document') throw err;
      // Typed methods are picky about codecs and dimensions beyond what the
      // extension reveals. Document accepts anything, so retry there before
      // giving up — delivered-as-a-file beats not delivered.
      logger.warn(
        { jid, filePath, kind, err },
        'Typed Telegram send failed, retrying as document',
      );
      await sendWithCaption('document');
      logger.info(
        { jid, filePath, kind: 'document' },
        'Telegram media sent (document fallback)',
      );
    }
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    return this.sendMedia(jid, filePath, { caption });
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
