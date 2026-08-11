/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { retry } from '@koko420/shared';
import { getNotionAccessToken } from './notion-token.js';

// Transient failures worth retrying: rate limits, overloads, and network
// blips. Permanent failures (refusal, auth, dead session) are not matched —
// retrying them just wastes attempts before the same error surfaces.
const RETRYABLE_ERROR =
  /\b(429|5\d\d)\b|rate.?limit|overloaded|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network|stream (?:error|closed)|premature close/i;

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_ERROR.test(msg);
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Image file paths (container-relative) to pass as vision input */
  images?: string[];
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Liveness ping during long tool calls — host resets idle/hard timers, no result shown to user. */
  heartbeat?: boolean;
}

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/png' | 'image/webp' | 'image/gif' | 'image/jpeg';
        data: string;
      };
    };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// The model the SDK runs on. Initialized from the spawn-time env var and
// updated live when the host sends a {type:'setmodel'} IPC signal (from the
// /model chat command). Passed as options.model to every query().
let currentModel: string | undefined = process.env.ANTHROPIC_MODEL || undefined;

// Handle to the in-flight query so a model switch can apply mid-run via
// setModel(). Null between queries; the next query() picks up currentModel.
let activeQuery: ReturnType<typeof query> | null = null;

function applyModelSwitch(model: string): void {
  currentModel = model;
  log(`Model switch requested via IPC: ${model}`);
  // Apply to a running query too, taking effect on its next model turn.
  // Fire-and-forget; between turns the next query() reads currentModel.
  activeQuery
    ?.setModel(model)
    .then(() => log(`setModel applied to running query: ${model}`))
    .catch((err) =>
      log(
        `setModel failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  pushWithImages(text: string, imagePaths: string[]): void {
    const content: ContentBlock[] = [{ type: 'text', text }];
    for (const imgPath of imagePaths) {
      try {
        if (!fs.existsSync(imgPath)) {
          log(`Image not found: ${imgPath}`);
          continue;
        }
        const data = fs.readFileSync(imgPath).toString('base64');
        const ext = path.extname(imgPath).toLowerCase();
        const mediaType =
          ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/jpeg';
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        });
        log(`Loaded image: ${imgPath} (${mediaType})`);
      } catch (err) {
        log(`Failed to load image ${imgPath}: ${err}`);
      }
    }
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Emit a liveness marker every HEARTBEAT_INTERVAL_MS while a query is running.
 * The host parses this marker and resets the container hard timeout + host idle
 * timer, so long-running tool calls (E2E tests, big builds) don't get killed.
 */
function startHeartbeat(): () => void {
  const id = setInterval(() => {
    writeOutput({ status: 'success', result: null, heartbeat: true });
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(id);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
interface IpcMessage {
  text: string;
  images?: string[];
}

function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({ text: data.text, images: data.images });
        } else if (data.type === 'setmodel' && data.model) {
          // Live model switch from the /model chat command.
          applyModelSwitch(data.model);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // Merge all drained messages into one
        const text = messages.map((m) => m.text).join('\n');
        const images = messages.flatMap((m) => m.images || []);
        resolve({ text, images: images.length > 0 ? images : undefined });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  attemptGuard?: { producedOutput: boolean },
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  if (containerInput.images?.length) {
    stream.pushWithImages(prompt, containerInput.images);
  } else {
    stream.push(prompt);
  }

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const msg of messages) {
      log(
        `Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`,
      );
      if (msg.images?.length) {
        stream.pushWithImages(msg.text, msg.images);
      } else {
        stream.push(msg.text);
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Resolve `@<file>.md` import markers in global CLAUDE.md against the shared
  // read-only /workspace/rules directory (e.g. `@CODE_BIBLE.md`). Tokens that
  // don't resolve to an existing rules file — including package names like
  // `@koko420/ai-tools` or `@t3-oss/env-nextjs`, which don't end in `.md` — are
  // left untouched. Single-level resolution only (imported files aren't scanned).
  const RULES_DIR = '/workspace/rules';
  const resolveRuleImports = (text: string): string =>
    text.replace(/@([A-Za-z0-9_\-./]+\.md)\b/g, (match, rel: string) => {
      if (rel.includes('..')) return match;
      const filePath = path.join(RULES_DIR, rel);
      if (!filePath.startsWith(RULES_DIR + path.sep)) return match;
      if (!fs.existsSync(filePath)) return match;
      return fs.readFileSync(filePath, 'utf-8');
    });

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = resolveRuleImports(
      fs.readFileSync(globalClaudeMdPath, 'utf-8'),
    );
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Refresh & load Notion access token (null if not mounted for this group).
  // Captured once per query; if the session lasts >55min the token will expire
  // mid-flight and Notion MCP calls will 401 — user can retry with a new turn.
  let notionAccessToken: string | null = null;
  try {
    notionAccessToken = await getNotionAccessToken();
    if (notionAccessToken) log('Notion MCP enabled');
  } catch (err) {
    log(
      `Notion token load/refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stopHeartbeat = startHeartbeat();
  try {
    const q = query({
      prompt: stream,
      options: {
        model: currentModel,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: globalClaudeMd,
            }
          : undefined,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
          'mcp__context7__*',
          'mcp__playwright__*',
          'mcp__pencil__*',
          'mcp__notion__*',
          'mcp__design__*',
        ],
        // Notion's hosted MCP server (v1.2.0, 2026-08) serves this tool with a
        // top-level `anyOf` in its input schema, which the Anthropic API
        // rejects — a single bad schema 400s EVERY request from the session
        // ("tools.N.custom.input_schema does not support oneOf/allOf/anyOf at
        // the top level"). Deny-listing removes it from the tool list sent to
        // the API. Revisit when Notion fixes their schema.
        disallowedTools: ['mcp__notion__notion-create-attachment'],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            },
          },
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp@latest'],
          },
          playwright: {
            command: 'npx',
            args: ['@playwright/mcp@latest', '--headless'],
          },
          ...(process.env.PENCIL_MCP_URL
            ? {
                pencil: {
                  type: 'http',
                  url: process.env.PENCIL_MCP_URL,
                } as any,
              }
            : {}),
          // Claude Design lives on api.anthropic.com, which ANTHROPIC_BASE_URL
          // already points at the host credential proxy — so the placeholder
          // Authorization below is swapped for the real OAuth token on the way
          // out and no credential ever enters the container. Requires the
          // account to have granted the `agent_design_projects` consent at
          // claude.ai/design/settings; without it every call returns
          // {"error":"needs_consent"}.
          ...(process.env.ANTHROPIC_BASE_URL
            ? {
                design: {
                  type: 'http' as const,
                  url: `${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/design/mcp`,
                  // Send the SAME routing key the host gave this container, so
                  // the proxy resolves it to this chat's Anthropic identity.
                  // Hardcoding a literal here silently authenticated every
                  // group as the default identity, regardless of /switch.
                  headers: {
                    Authorization: `Bearer ${
                      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
                      process.env.ANTHROPIC_API_KEY ||
                      'placeholder'
                    }`,
                  },
                },
              }
            : {}),
          ...(notionAccessToken
            ? {
                notion: {
                  type: 'http' as const,
                  url: 'https://mcp.notion.com/mcp',
                  headers: { Authorization: `Bearer ${notionAccessToken}` },
                },
              }
            : {}),
        },
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(containerInput.assistantName)] },
          ],
        },
      },
    });
    activeQuery = q;
    for await (const message of q) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        // The agent has started producing real work this attempt (text or
        // tool calls). From here on a retry could re-run non-idempotent tool
        // calls or double-send messages, so mark the attempt non-replayable.
        if (attemptGuard) attemptGuard.producedOutput = true;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
        });
      }
    }
  } finally {
    stopHeartbeat();
    activeQuery = null;
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(
      `Received input for group: ${containerInput.groupFolder}, images: ${JSON.stringify(containerInput.images || [])}`,
    );
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map((m) => m.text).join('\n');
    // Merge any images from pending messages into containerInput
    const pendingImages = pending.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      containerInput.images = [
        ...(containerInput.images || []),
        ...pendingImages,
      ];
    }
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      // Retry transient failures (rate limits, overloads, network blips) with
      // exponential backoff so a momentary hiccup no longer kills the session
      // mid-work. The guard makes retries safe: once the agent has produced
      // any output this turn, we stop replaying (a fresh query() could re-run
      // tool calls or double-send messages) and let the error surface.
      const attemptGuard = { producedOutput: false };
      const queryResult = await retry(
        async () => {
          if (attemptGuard.producedOutput) {
            throw new Error(
              'not retrying after partial agent output (avoids replaying tool calls)',
            );
          }
          try {
            return await runQuery(
              prompt,
              sessionId,
              mcpServerPath,
              containerInput,
              sdkEnv,
              resumeAt,
              attemptGuard,
            );
          } catch (err) {
            if (!attemptGuard.producedOutput && isRetryable(err)) {
              log(
                `Transient query error, will retry: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            throw err;
          }
        },
        3,
        true,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`,
      );
      prompt = nextMessage.text;
      // Update containerInput images for the next runQuery call
      containerInput.images = nextMessage.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    // Don't re-persist the session ID if the conversation was not found —
    // returning it would cause the host to save a dead session, creating
    // an infinite retry loop after /new clears session files.
    const isDeadSession = /no conversation found/i.test(errorMessage);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: isDeadSession ? undefined : sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
