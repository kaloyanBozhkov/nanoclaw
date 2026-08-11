export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Hard-cap runtime in ms. Falls back to CONTAINER_TIMEOUT.
  enableNotion?: boolean;
  // Per-group model override (set via /model). Falls back to AGENT_MODEL.
  // Must be one of AVAILABLE_MODELS' ids.
  model?: string;
  // Anthropic identity this chat authenticates and bills as (set via /switch).
  // Just the org NAME — the credential itself never leaves .env. Falls back to
  // DEFAULT_ORG_NAME.
  org?: string;
  // When true, the container has NO hard runtime cap ("nosleep" via chat).
  // Only the idle timeout can reap it. Set false / cleared by "yessleep".
  noSleep?: boolean;
  // Extra project-relative paths to isolate between host and container, on top
  // of the always-isolated ISOLATED_ARTIFACTS (node_modules, .next). Use for
  // generated output that holds platform-specific binaries but lives outside
  // node_modules — e.g. a Prisma client emitted to `packages/prisma/client`,
  // which otherwise overwrites the host's darwin query engine with a linux one.
  // Paths are relative to each mounted project root; `..` and absolute paths
  // are rejected.
  isolatedArtifacts?: string[];
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  /** Absolute paths to image files attached to this message */
  images?: string[];
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

/**
 * How a channel should present an outbound file.
 * 'auto'     — pick the richest inline presentation the file's type allows.
 * 'document' — send the raw bytes untouched. Required when re-encoding would
 *              destroy something the user cares about (e.g. a GIF's alpha
 *              channel, which is lost the moment Telegram transcodes to MP4).
 */
export type MediaMode = 'auto' | 'document';

export interface SendMediaOptions {
  caption?: string;
  as?: MediaMode;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: send any file type. Preferred over sendPhoto — channels
  // implementing this can send video, audio, documents and animations.
  sendMedia?(
    jid: string,
    filePath: string,
    options?: SendMediaOptions,
  ): Promise<void>;
  // Optional: send a photo/image. Legacy — channels that only do images
  // implement this, and the host falls back to it when sendMedia is absent.
  sendPhoto?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
