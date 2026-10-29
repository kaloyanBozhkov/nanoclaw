/**
 * `/mounts`, `/mount <path>`, `/unmount <path|name>` — the extra host folders
 * a chat's container gets at /workspace/extra/<name>.
 *
 * Stored in the group's containerConfig.additionalMounts and read at container
 * start, so a change only lands in the next container. Every path still goes
 * through the allowlist in mount-security.ts, which lives outside every
 * container and is never written from chat. /unmount only removes mounts that
 * /mount added: the project folder and anything registered by hand stay put.
 */
import path from 'path';

import { expandPath, validateMount } from './mount-security.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

export interface MountChange {
  ok: boolean;
  message: string;
  updated?: RegisteredGroup;
}

function mountName(m: AdditionalMount): string {
  return m.containerPath || path.basename(m.hostPath);
}

/** Expanded and without a trailing slash, so `~/x/` and `/Users/me/x` compare equal. */
function normalizeHostPath(p: string): string {
  const expanded = expandPath(p.trim());
  return expanded.length > 1 ? expanded.replace(/\/+$/, '') : expanded;
}

function withMounts(
  group: RegisteredGroup,
  additionalMounts: AdditionalMount[],
): RegisteredGroup {
  return {
    ...group,
    containerConfig: { ...group.containerConfig, additionalMounts },
  };
}

export interface MountArgs {
  hostPath: string;
  readonly: boolean;
  name?: string;
}

/** `<path> [ro|rw] [as <name>]` — read-only unless `rw` is given. */
export function parseMountArgs(arg: string): MountArgs | null {
  const m = /^(.+?)(?:\s+(ro|rw))?(?:\s+as\s+(\S+))?$/i.exec(arg.trim());
  if (!m) return null;
  return {
    hostPath: m[1].trim(),
    readonly: (m[2] ?? 'ro').toLowerCase() !== 'rw',
    name: m[3],
  };
}

export function addMount(
  group: RegisteredGroup,
  isMain: boolean,
  arg: string,
): MountChange {
  const args = parseMountArgs(arg);
  if (!args) {
    return { ok: false, message: 'Usage: /mount <path> [ro|rw] [as <name>]' };
  }

  const existing = group.containerConfig?.additionalMounts ?? [];
  const wanted = normalizeHostPath(args.hostPath);
  const same = existing.find((m) => normalizeHostPath(m.hostPath) === wanted);
  if (same) {
    return {
      ok: false,
      message: `${args.hostPath} is already mounted at /workspace/extra/${mountName(same)}.`,
    };
  }

  const mount: AdditionalMount = {
    hostPath: args.hostPath,
    readonly: args.readonly,
    addedFromChat: true,
    ...(args.name ? { containerPath: args.name } : {}),
  };
  const name = mountName(mount);
  if (existing.some((m) => mountName(m) === name)) {
    return {
      ok: false,
      message: `⚠️ /workspace/extra/${name} is already taken by another mount. Pick a name: /mount ${args.hostPath}${args.readonly ? '' : ' rw'} as <name>`,
    };
  }

  const check = validateMount(mount, isMain);
  if (!check.allowed) {
    return {
      ok: false,
      message: `❌ Can't mount ${args.hostPath}: ${check.reason}`,
    };
  }

  const forcedReadonly = !args.readonly && check.effectiveReadonly;
  const mode = check.effectiveReadonly ? 'read-only' : 'read-write';
  return {
    ok: true,
    updated: withMounts(group, [...existing, mount]),
    message: [
      `📁 Mounted ${args.hostPath} → /workspace/extra/${name} (${mode}). Applies from your next message; anything already running finishes as it was.`,
      ...(forcedReadonly
        ? [
            'Read-write isn’t allowed for that folder in the allowlist, so it’s read-only.',
          ]
        : []),
    ].join('\n'),
  };
}

export function removeMount(group: RegisteredGroup, arg: string): MountChange {
  const target = arg.trim();
  if (!target) {
    return { ok: false, message: 'Usage: /unmount <path|name> — see /mounts' };
  }

  const existing = group.containerConfig?.additionalMounts ?? [];
  const wanted = normalizeHostPath(target);
  const bare = target.replace(/^\/workspace\/extra\//, '');
  const found = existing.find(
    (m) => normalizeHostPath(m.hostPath) === wanted || mountName(m) === bare,
  );
  if (!found) {
    return {
      ok: false,
      message: `Nothing mounted matches "${target}". See /mounts.`,
    };
  }
  if (!found.addedFromChat) {
    return {
      ok: false,
      message: `📌 ${found.hostPath} is one of this chat’s own folders, not added with /mount, so it can’t be unmounted.`,
    };
  }

  return {
    ok: true,
    updated: withMounts(
      group,
      existing.filter((m) => m !== found),
    ),
    message: `🗑️ Unmounted ${found.hostPath} (/workspace/extra/${mountName(found)}). Applies from your next message; anything already running finishes as it was.`,
  };
}

export function formatMounts(group: RegisteredGroup, isMain: boolean): string {
  const lines = ['📁 Mounts for this chat', ''];
  const extra = group.containerConfig?.additionalMounts ?? [];

  if (extra.length === 0) {
    lines.push('No extra folders.');
  }
  for (const m of extra) {
    const check = validateMount(m, isMain);
    const tag = m.addedFromChat ? '' : ' 📌';
    if (check.allowed) {
      const mode = check.effectiveReadonly ? 'ro' : 'rw';
      lines.push(
        `• ${m.hostPath} → /workspace/extra/${mountName(m)} (${mode})${tag}`,
      );
    } else {
      lines.push(`• ${m.hostPath} — ⚠️ not mounted: ${check.reason}${tag}`);
    }
  }

  lines.push(
    '',
    `System: /workspace/group, ${isMain ? '/workspace/project (ro), ' : '/workspace/global, '}/workspace/blueprints, /workspace/rules, /workspace/ipc`,
    '',
    '📌 = this chat’s own folder, can’t be unmounted. Add one with /mount <path> [ro|rw] [as <name>], remove with /unmount <path|name>.',
  );
  return lines.join('\n');
}
