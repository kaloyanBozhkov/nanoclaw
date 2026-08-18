import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MODEL,
  ASSISTANT_NAME,
  AVAILABLE_MODELS,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  EPHEMERAL_GROUP_DIRS,
  IDLE_TIMEOUT,
  isOwnerSender,
  listOrgs,
  modelLabel,
  POLL_INTERVAL,
  resolveGroupOrg,
  resolveModelChoice,
  resolveOrg,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { stopContainer } from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { getGodModeStatus, setGodMode } from './godmode.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  collectResetTargets,
  previewReset,
  type ResetScope,
} from './session-reset.js';
import { addPin, formatPinList, listPins, removePin } from './pinned.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Collect image paths from messages and translate to container paths
  const groupDir = resolveGroupFolderPath(group.folder);
  const rawImages = missedMessages.flatMap((m) => m.images || []);
  const allImages = rawImages
    .filter((p) => fs.existsSync(p))
    .map((hostPath) => {
      // Translate host path (groups/{folder}/images/...) to container path (/workspace/group/images/...)
      const rel = path.relative(groupDir, hostPath);
      return `/workspace/group/${rel}`;
    });
  if (rawImages.length > 0) {
    logger.info(
      { group: group.name, rawImages, allImages },
      'Image attachments found',
    );
  }

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Heartbeat from a long tool call — keep the idle timer alive but
      // don't send anything to the user and don't notify the queue as idle.
      if (result.heartbeat) {
        resetIdleTimer();
        return;
      }
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    allImages.length > 0 ? allImages : undefined,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

/**
 * Read the most recent assistant activity from the SDK transcript so we can
 * tell the user what the agent was doing when /stop hit. Returns null when no
 * transcript exists for the group's current session.
 */
function extractLastActivity(
  groupFolder: string,
  sessionId: string,
): {
  lastText: string | null;
  lastTool: { name: string; input: unknown } | null;
} | null {
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  if (!fs.existsSync(projectsDir)) return null;

  let transcriptPath: string | null = null;
  for (const project of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcriptPath = candidate;
      break;
    }
  }
  if (!transcriptPath) return null;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  let lastText: string | null = null;
  let lastTool: { name: string; input: unknown } | null = null;

  // Walk the tail of the transcript so we always pick up the most recent
  // text + tool_use blocks regardless of how many turns happened.
  for (const line of lines.slice(-100)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || !entry.message?.content) continue;
      const blocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          lastText = block.text;
        } else if (block.type === 'tool_use') {
          lastTool = { name: block.name, input: block.input };
        }
      }
    } catch {
      /* skip malformed line */
    }
  }

  return { lastText, lastTool };
}

function formatStopSummary(
  activity: ReturnType<typeof extractLastActivity>,
): string {
  const parts: string[] = ['⛔ Stopped.'];
  if (activity?.lastText) {
    const snippet = activity.lastText.slice(0, 400);
    parts.push(
      `\n*Last message:*\n${snippet}${activity.lastText.length > 400 ? '…' : ''}`,
    );
  }
  if (activity?.lastTool) {
    const inputStr = JSON.stringify(activity.lastTool.input).slice(0, 200);
    parts.push(
      `\n*Last action:* \`${activity.lastTool.name}\`\n\`${inputStr}\``,
    );
  }
  parts.push('\nReply with what to do next, or send new instructions.');
  return parts.join('\n');
}

interface SubagentActivity {
  agentId: string;
  teammateId: string | null;
  summary: string | null;
  lastText: string | null;
  lastTool: { name: string; input: unknown } | null;
}

/**
 * Walk subagent JSONLs for a session and return their last activity.
 * Subagents persist under <sessionId>/subagents/agent-*.jsonl.
 */
function extractSubagentActivity(
  groupFolder: string,
  sessionId: string,
): SubagentActivity[] {
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  if (!fs.existsSync(projectsDir)) return [];

  let subagentsDir: string | null = null;
  for (const project of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, project, sessionId, 'subagents');
    if (fs.existsSync(candidate)) {
      subagentsDir = candidate;
      break;
    }
  }
  if (!subagentsDir) return [];

  const out: SubagentActivity[] = [];
  for (const file of fs.readdirSync(subagentsDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const fullPath = path.join(subagentsDir, file);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    const lines = fs
      .readFileSync(fullPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    if (lines.length === 0) continue;

    let teammateId: string | null = null;
    let summary: string | null = null;
    try {
      const first = JSON.parse(lines[0]);
      const content =
        typeof first?.message?.content === 'string'
          ? first.message.content
          : '';
      const m = content.match(
        /<teammate-message[^>]*teammate_id="([^"]+)"[^>]*summary="([^"]+)"/,
      );
      if (m) {
        teammateId = m[1];
        summary = m[2];
      }
    } catch {
      /* skip */
    }

    let lastText: string | null = null;
    let lastTool: { name: string; input: unknown } | null = null;
    for (const line of lines.slice(-50)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant' || !entry.message?.content) continue;
        const blocks = Array.isArray(entry.message.content)
          ? entry.message.content
          : [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) lastText = block.text;
          else if (block.type === 'tool_use')
            lastTool = { name: block.name, input: block.input };
        }
      } catch {
        /* skip */
      }
    }

    out.push({
      agentId: file.replace(/\.jsonl$/, ''),
      teammateId,
      summary,
      lastText,
      lastTool,
    });
  }
  return out;
}

/**
 * Parse the millisecond timestamp suffix from container names like
 * "nanoclaw-telegram-main-1777208528560". Returns null on parse failure.
 */
function parseContainerStartedAt(containerName: string): Date | null {
  const m = containerName.match(/-(\d{13})$/);
  if (!m) return null;
  const ms = parseInt(m[1], 10);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function formatUptime(startedAt: Date): string {
  const elapsedSec = Math.max(
    0,
    Math.floor((Date.now() - startedAt.getTime()) / 1000),
  );
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const min = Math.floor(elapsedSec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function formatToolLine(tool: { name: string; input: unknown }): string {
  const inputStr = JSON.stringify(tool.input).slice(0, 140);
  return `\`${tool.name}\` ${inputStr}`;
}

function formatInfoSummary(
  containerName: string,
  mainActivity: ReturnType<typeof extractLastActivity>,
  subagents: SubagentActivity[],
): string {
  const parts: string[] = ['ℹ️ *Status*'];
  const startedAt = parseContainerStartedAt(containerName);
  if (startedAt) {
    parts.push(`Container running for ${formatUptime(startedAt)}.`);
  }

  parts.push('\n*Main agent:*');
  if (mainActivity?.lastTool) {
    parts.push(formatToolLine(mainActivity.lastTool));
  }
  if (mainActivity?.lastText) {
    const snippet = mainActivity.lastText.slice(0, 220);
    parts.push(`"${snippet}${mainActivity.lastText.length > 220 ? '…' : ''}"`);
  }
  if (!mainActivity?.lastTool && !mainActivity?.lastText) {
    parts.push('_(no activity in transcript yet)_');
  }

  if (subagents.length === 0) {
    parts.push('\n_No subagents running._');
  } else {
    parts.push(`\n*Subagents (${subagents.length}):*`);
    for (const sa of subagents) {
      const label = sa.teammateId ?? sa.agentId;
      const summary = sa.summary ? ` — ${sa.summary}` : '';
      parts.push(`\n• *${label}*${summary}`);
      if (sa.lastTool) parts.push(`  ↳ ${formatToolLine(sa.lastTool)}`);
      if (sa.lastText) {
        const snippet = sa.lastText.slice(0, 180);
        parts.push(`  ↳ "${snippet}${sa.lastText.length > 180 ? '…' : ''}"`);
      }
      if (!sa.lastTool && !sa.lastText) {
        parts.push('  ↳ _(no activity yet)_');
      }
    }
  }

  return parts.join('\n');
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: string[],
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        images,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      (reschedule) => queue.registerHardTimer(chatJid, reschedule),
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // If the session was not found, clear it so the next attempt starts fresh
      // instead of retrying the dead session forever.
      if (
        output.error &&
        /no conversation found/i.test(output.error) &&
        sessions[group.folder]
      ) {
        logger.warn(
          { group: group.name, sessionId: sessions[group.folder] },
          'Clearing dead session after "No conversation found" error',
        );
        deleteSession(group.folder);
        delete sessions[group.folder];
      }
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Collect images from piped messages and translate to container paths
          const pipeGroup = registeredGroups[chatJid];
          const pipedImages = pipeGroup
            ? messagesToSend
                .flatMap((m) => m.images || [])
                .filter((p) => fs.existsSync(p))
                .map((hostPath) => {
                  const gDir = resolveGroupFolderPath(pipeGroup.folder);
                  const rel = path.relative(gDir, hostPath);
                  return `/workspace/group/${rel}`;
                })
            : [];

          if (
            queue.sendMessage(
              chatJid,
              formatted,
              pipedImages.length > 0 ? pipedImages : undefined,
            )
          ) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /stop command — hard-kill the running container and tell the user
  // where the agent was, so they can resume by sending the next message.
  async function handleStop(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const info = queue.getActiveContainer(chatJid);
    if (!info) {
      await channel.sendMessage(chatJid, '⚠️ Nothing running to stop.');
      return;
    }

    // Read transcript BEFORE killing so we have the agent's most recent state.
    const sessionId = sessions[group.folder];
    const activity = sessionId
      ? extractLastActivity(group.folder, sessionId)
      : null;

    logger.info(
      { chatJid, containerName: info.containerName },
      '/stop received, killing container',
    );

    // Graceful runtime stop first, force-kill the host child as a fallback.
    exec(stopContainer(info.containerName), { timeout: 10000 }, (err) => {
      if (err && !info.proc.killed) {
        logger.warn(
          { chatJid, containerName: info.containerName, err },
          'Graceful stop failed, force-killing host process',
        );
        info.proc.kill('SIGKILL');
      }
    });

    await channel.sendMessage(chatJid, formatStopSummary(activity));
  }

  // /info — non-destructive status report. Shows what the main agent and any
  // running subagents are currently doing so the user can tell if a long run
  // is making progress or stuck.
  async function handleInfo(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const info = queue.getActiveContainer(chatJid);
    if (!info) {
      await channel.sendMessage(chatJid, 'ℹ️ Bot is idle. Nothing running.');
      return;
    }

    const sessionId = sessions[group.folder];
    const mainActivity = sessionId
      ? extractLastActivity(group.folder, sessionId)
      : null;
    const subagents = sessionId
      ? extractSubagentActivity(group.folder, sessionId)
      : [];

    await channel.sendMessage(
      chatJid,
      formatInfoSummary(info.containerName, mainActivity, subagents),
    );
  }

  // "nosleep" / "yessleep" — configure this group's hard container runtime cap.
  //   nosleep  → no cap (only the idle timeout can reap the container)
  //   yessleep → restore the default cap (CONTAINER_TIMEOUT)
  // Persists per-group and live-applies to a container that is already running,
  // so it can rescue an in-progress long task.
  async function handleSleepConfig(
    chatJid: string,
    noSleep: boolean,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const containerConfig = { ...group.containerConfig, noSleep };
    if (!noSleep) delete containerConfig.timeout; // yessleep → default cap
    const updated = { ...group, containerConfig };

    try {
      setRegisteredGroup(chatJid, updated);
      registeredGroups[chatJid] = updated;
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to persist sleep config');
      await channel.sendMessage(chatJid, '⚠️ Failed to save sleep setting.');
      return;
    }

    // Live-apply to the running container, if any.
    const capMs = noSleep ? null : CONTAINER_TIMEOUT;
    const applied = queue.rescheduleHardTimer(chatJid, capMs);

    const hours = Math.round((CONTAINER_TIMEOUT / 3_600_000) * 10) / 10;
    const scope = applied ? ' (applied to the running agent too)' : '';
    await channel.sendMessage(
      chatJid,
      noSleep
        ? `🌙 nosleep: this chat's agent will run with no time cap${scope}. Send "yessleep" to restore the ${hours}h cap.`
        : `😴 yessleep: this chat's agent is capped at ${hours}h again${scope}.`,
    );
  }

  // "/godmode" (status), "/godmode on", "/godmode off" — host terminal access.
  //
  // Main chat only, and only the owner may flip it: while it is on, the agent
  // can run commands on this Mac as the user, outside the container sandbox.
  // The state file lives in ~/.config/nanoclaw and is re-read on every command
  // the agent asks for, so "off" revokes a container that is already running.
  async function handleGodModeCommand(
    chatJid: string,
    arg: string,
    isOwner: boolean,
    sender: string,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (!group.isMain) {
      await channel.sendMessage(
        chatJid,
        '⚠️ godmode is only available in the main chat.',
      );
      return;
    }

    const status = getGodModeStatus(group.folder);
    const describe = () => {
      const since = status.changedAt
        ? ` since ${new Date(status.changedAt).toLocaleString('en-GB', { timeZone: TIMEZONE })}`
        : '';
      return status.enabled
        ? `🔓 godmode is ON${since} — I can run terminal commands on this machine. Send /godmode off to revoke.`
        : `🔒 godmode is OFF${since ? ` (last change${since})` : ''} — terminal commands on this machine are refused. Send /godmode on to allow them.`;
    };

    // No argument → report status. Anyone in the main chat may ask.
    if (!arg) {
      await channel.sendMessage(chatJid, describe());
      return;
    }

    if (arg !== 'on' && arg !== 'off') {
      await channel.sendMessage(
        chatJid,
        'Usage: /godmode (status), /godmode on, /godmode off.',
      );
      return;
    }

    if (!isOwner) {
      await channel.sendMessage(
        chatJid,
        '⚠️ Only the owner can change godmode.',
      );
      return;
    }

    const enabled = arg === 'on';
    if (enabled === status.enabled) {
      await channel.sendMessage(chatJid, `Already ${arg}. ${describe()}`);
      return;
    }

    try {
      setGodMode(group.folder, enabled, sender);
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to persist godmode state');
      await channel.sendMessage(chatJid, '⚠️ Failed to save godmode setting.');
      return;
    }

    await channel.sendMessage(
      chatJid,
      enabled
        ? '🔓 godmode ON. I can now run terminal commands on this machine — as your user, outside the container sandbox, with whatever access you have. ' +
            'Ask me in plain language ("check what\'s on port 3000", "restart the service") and I\'ll run it and report back. Send /godmode off when you\'re done.'
        : '🔒 godmode OFF. Terminal commands on this machine are refused again, including from an agent that is still running.',
    );
  }

  // The model this chat's next container will run on: per-group override
  // (set via /model) or the global default.
  function currentModelId(chatJid: string): string {
    return registeredGroups[chatJid]?.containerConfig?.model || AGENT_MODEL;
  }

  // "/models" — list the models this chat can switch to, numbered, with the
  // current one marked. Read-only, so allowed for anyone in the chat.
  async function handleModelsList(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const active = currentModelId(chatJid);
    const lines = AVAILABLE_MODELS.map(
      (m, i) => `${i + 1}. ${m.label}${m.id === active ? '  ← current' : ''}`,
    );
    await channel.sendMessage(
      chatJid,
      `Available models — switch with /model <number|name>:\n${lines.join('\n')}`,
    );
  }

  // "/org" — which Anthropic identity this chat runs as, and what else is
  // available. Read-only, so anyone in the chat may ask.
  async function handleOrgCommand(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const orgs = listOrgs();
    if (orgs.length === 0) {
      await channel.sendMessage(
        chatJid,
        '⚠️ No Anthropic identity configured. Set CLAUDE_CODE_OAUTH_TOKEN (or an ANTHROPIC_ORG_<NAME>_OAUTH_TOKEN) in .env.',
      );
      return;
    }

    const active = resolveGroupOrg(
      registeredGroups[chatJid]?.containerConfig?.org,
    );
    const lines = orgs.map((o) => {
      const mode = o.authMode === 'oauth' ? 'OAuth' : 'API key';
      const note =
        o.authMode === 'api-key' ? '    (no Claude Design access)' : '';
      const marker = o.name === active?.name ? '  ← active' : '';
      return `  ${o.name} — ${mode}${note}${marker}`;
    });

    await channel.sendMessage(
      chatJid,
      `This chat: ${active?.name ?? 'none'}` +
        `${active ? ` (${active.authMode === 'oauth' ? 'OAuth' : 'API key'})` : ''}\n\n` +
        `${lines.join('\n')}\n\nSwitch with /switch <name>`,
    );
  }

  // "/switch <org>" — change the identity this chat authenticates as.
  // Owner only. Applies on the next container: the running one already holds a
  // token scoped to the old org and cannot be re-scoped in place.
  async function handleSwitchCommand(
    chatJid: string,
    arg: string,
    isOwner: boolean,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (!arg) {
      await channel.sendMessage(
        chatJid,
        'Usage: /switch <org>. Run /org to see what is available.',
      );
      return;
    }

    if (!isOwner) {
      await channel.sendMessage(
        chatJid,
        '⚠️ Only the owner can switch the Anthropic identity.',
      );
      return;
    }

    const org = resolveOrg(arg);
    if (!org) {
      const names = listOrgs()
        .map((o) => o.name)
        .join(', ');
      await channel.sendMessage(
        chatJid,
        `⚠️ Unknown org "${arg}". Available: ${names || 'none configured'}.`,
      );
      return;
    }

    const current = resolveGroupOrg(group.containerConfig?.org);
    if (current?.name === org.name) {
      await channel.sendMessage(
        chatJid,
        `Already on ${org.name}. Nothing to do.`,
      );
      return;
    }

    const containerConfig = { ...group.containerConfig, org: org.name };
    const updated = { ...group, containerConfig };
    try {
      setRegisteredGroup(chatJid, updated);
      registeredGroups[chatJid] = updated;
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to persist org switch');
      await channel.sendMessage(chatJid, '⚠️ Failed to save org setting.');
      return;
    }

    // End the current session: it holds a credential scoped to the old
    // identity, and carrying that conversation across accounts is exactly what
    // switching is meant to prevent. Org-scoped caches go with it.
    queue.closeStdin(chatJid);
    for (const target of collectResetTargets(group.folder)) {
      if (target.kind !== 'cache') continue; // history is not identity-scoped
      for (const p of target.paths) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch (err) {
          logger.warn(
            { err, chatJid, target: target.label },
            'Failed to clear org-scoped cache on switch',
          );
        }
      }
    }

    logger.info(
      { chatJid, org: org.name, authMode: org.authMode },
      'Anthropic identity switched via /switch',
    );
    const designNote =
      org.authMode === 'api-key'
        ? ' Note: API-key identities cannot read Claude Design files.'
        : '';
    await channel.sendMessage(
      chatJid,
      `Switched to ${org.name} (${org.authMode === 'oauth' ? 'OAuth' : 'API key'}). ` +
        `The next message starts a fresh session on that account.${designNote}`,
    );
  }

  // "/model" (show current) and "/model <number|name>" (switch — owner only).
  async function handleModelCommand(
    chatJid: string,
    arg: string,
    isOwner: boolean,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // No argument → report the current model.
    if (!arg) {
      const id = currentModelId(chatJid);
      await channel.sendMessage(
        chatJid,
        `Current model for this chat: ${modelLabel(id)} (${id}). Use /models to see options.`,
      );
      return;
    }

    // Switching is owner-only.
    if (!isOwner) {
      await channel.sendMessage(
        chatJid,
        '⚠️ Only the owner can switch the model.',
      );
      return;
    }

    const choice = resolveModelChoice(arg);
    if (!choice) {
      const list = AVAILABLE_MODELS.map((m, i) => `${i + 1}. ${m.label}`).join(
        '\n',
      );
      await channel.sendMessage(
        chatJid,
        `⚠️ Unknown model "${arg}". Pick one:\n${list}`,
      );
      return;
    }

    const containerConfig = { ...group.containerConfig, model: choice.id };
    const updated = { ...group, containerConfig };
    try {
      setRegisteredGroup(chatJid, updated);
      registeredGroups[chatJid] = updated;
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to persist model switch');
      await channel.sendMessage(chatJid, '⚠️ Failed to save model setting.');
      return;
    }

    // Apply live to a running container via IPC (agent-runner calls
    // query.setModel), else it applies on the next spawn from the persisted
    // per-group config.
    const applied = queue.sendModelSwitch(chatJid, choice.id);
    const note = applied
      ? ' Applied to the running agent — takes effect from its next turn.'
      : ' Applies to your next message.';
    await channel.sendMessage(
      chatJid,
      `✅ Model set to ${choice.label} (${choice.id}) for this chat.${note}`,
    );
  }

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // /pin <text>, 📌 <text>, /pins, /unpin <n> — manage durable pinned
  // instructions for this group. Intercepted before storage so the bot's
  // conversation isn't polluted; pins are written to groups/<folder>/CLAUDE.md
  // under a dedicated section and become part of the system prompt on every
  // future container run, surviving compactions and restarts.
  async function handlePinCommand(
    chatJid: string,
    rawText: string,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const text = rawText.trim();
    if (text === '/pins') {
      await channel.sendMessage(chatJid, formatPinList(listPins(group.folder)));
      return;
    }
    const unpinMatch = /^\/unpin\s+(\d+)\s*$/.exec(text);
    if (unpinMatch) {
      const result = removePin(group.folder, parseInt(unpinMatch[1], 10));
      await channel.sendMessage(chatJid, result.message);
      return;
    }
    // /pin <text> or 📌 <text>
    let payload: string | null = null;
    if (text.startsWith('/pin ')) payload = text.slice(5);
    else if (text.startsWith('📌')) payload = text.slice('📌'.length);
    if (payload === null) return;
    const result = addPin(group.folder, payload);
    await channel.sendMessage(chatJid, result.message);
  }

  function isPinCommand(text: string): boolean {
    if (text === '/pins' || /^\/unpin\s+\d+\s*$/.test(text)) return true;
    if (text.startsWith('/pin ')) return true;
    if (text.startsWith('📌')) return true;
    return false;
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // /stop — manual cancel of the active container, intercepted before
      // storage so it never reaches the agent or the message log.
      if (trimmed === '/stop') {
        handleStop(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Stop command error'),
        );
        return;
      }

      // /info — non-destructive status report on the active container,
      // intercepted before storage so it never reaches the agent.
      if (trimmed === '/info') {
        handleInfo(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Info command error'),
        );
        return;
      }

      // nosleep / yessleep — toggle this group's hard container runtime cap.
      // Intercepted before storage so it never reaches the agent.
      const sleepCmd = trimmed.toLowerCase();
      if (sleepCmd === 'nosleep' || sleepCmd === 'yessleep') {
        handleSleepConfig(chatJid, sleepCmd === 'nosleep').catch((err) =>
          logger.error({ err, chatJid }, 'Sleep config command error'),
        );
        return;
      }

      // /models — list selectable models. /model [number|name] — show current
      // or switch (switching is owner-only). Intercepted before storage.
      if (sleepCmd === '/models') {
        handleModelsList(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Models list command error'),
        );
        return;
      }
      if (sleepCmd === '/model' || sleepCmd.startsWith('/model ')) {
        const arg = trimmed.slice('/model'.length).trim();
        const isOwner = isOwnerSender(msg.sender, msg.is_from_me === true);
        handleModelCommand(chatJid, arg, isOwner).catch((err) =>
          logger.error({ err, chatJid }, 'Model command error'),
        );
        return;
      }
      if (sleepCmd === '/org') {
        handleOrgCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Org command error'),
        );
        return;
      }
      if (sleepCmd === '/switch' || sleepCmd.startsWith('/switch ')) {
        const arg = trimmed.slice('/switch'.length).trim();
        const isOwner = isOwnerSender(msg.sender, msg.is_from_me === true);
        handleSwitchCommand(chatJid, arg, isOwner).catch((err) =>
          logger.error({ err, chatJid }, 'Switch command error'),
        );
        return;
      }

      // /godmode [on|off] — host terminal access for the main chat.
      // Intercepted before storage so it never reaches the agent: the switch
      // must not be something a conversation can talk its way into.
      const godMatch = /^\/godmode(?:@\S+)?\b(.*)$/i.exec(trimmed);
      if (godMatch) {
        const arg = godMatch[1].trim().toLowerCase();
        const isOwner = isOwnerSender(msg.sender, msg.is_from_me === true);
        handleGodModeCommand(chatJid, arg, isOwner, msg.sender).catch((err) =>
          logger.error({ err, chatJid }, 'Godmode command error'),
        );
        return;
      }

      // /pin /unpin /pins / 📌 — pin management
      if (isPinCommand(trimmed)) {
        handlePinCommand(chatJid, trimmed).catch((err) =>
          logger.error({ err, chatJid }, 'Pin command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onResetSession: (groupFolder: string, scope: ResetScope = 'all') => {
      deleteSession(groupFolder);
      delete sessions[groupFolder];

      // Kill the running container so it doesn't resume the dead session.
      // Find the JID for this group folder and signal the container to stop.
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === groupFolder) {
          queue.closeStdin(jid);
          break;
        }
      }

      // Delete exactly what `/new`'s confirmation prompt described — the target
      // list comes from the same collector the preview used, so the two can't
      // drift. Claude session files (UUID dirs/files, never memory/) plus any
      // derived group caches; container-runner.ts recreates .claude/ next run.
      for (const target of collectResetTargets(groupFolder, scope)) {
        for (const p of target.paths) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch (err) {
            logger.warn(
              { groupFolder, target: target.label, path: p, err },
              'Failed to clear reset target',
            );
          }
        }
        logger.info(
          { groupFolder, target: target.label, files: target.files },
          'Cleared reset target via /new',
        );
      }
    },
    onPreviewReset: (groupFolder: string, scope: ResetScope = 'all') =>
      previewReset(groupFolder, scope),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendMedia: async (jid, filePath, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendMedia) return channel.sendMedia(jid, filePath, options);
      // Legacy channels only do images — better a flattened send than none.
      if (channel.sendPhoto)
        return channel.sendPhoto(jid, filePath, options?.caption);
      logger.warn({ jid }, 'Channel does not support sending media');
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
