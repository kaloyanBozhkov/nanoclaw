import type { RunningAgent } from '../restart.js';
import { ResetPreview, ResetScope } from '../session-reset.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onResetSession: (groupFolder: string, scope?: ResetScope) => void;
  /** What `onResetSession` would delete, for a confirmation prompt. */
  onPreviewReset: (groupFolder: string, scope?: ResetScope) => ResetPreview;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Register a new chat as a group (channels that can create chats). */
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  /** Agent containers a restart would interrupt. */
  listRunningAgents?: () => RunningAgent[];
  /** Exit cleanly so the service manager restarts us; `jid` hears when we're back. */
  restartService?: (jid: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
