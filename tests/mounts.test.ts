import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, it, expect, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounts-'));
const allowlistPath = path.join(tmp, 'mount-allowlist.json');
const allowed = path.join(tmp, 'allowed');
const elsewhere = path.join(tmp, 'elsewhere');
for (const dir of [
  path.join(allowed, 'app'),
  path.join(allowed, 'other', 'app'),
  path.join(allowed, 'tokenizer'),
  path.join(allowed, 'project'),
  elsewhere,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAllowlist(roots: string[]): void {
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      allowedRoots: roots.map((p) => ({ path: p, allowReadWrite: true })),
      blockedPatterns: ['token'],
      nonMainReadOnly: false,
    }),
  );
}
writeAllowlist([allowed]);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  MOUNT_ALLOWLIST_PATH: allowlistPath,
}));

const { addMount, formatMounts, parseMountArgs, removeMount } =
  await import('../src/mounts.js');
const { formatHelp } = await import('../src/help.js');
type RegisteredGroup = import('../src/types.js').RegisteredGroup;
type AdditionalMount = import('../src/types.js').AdditionalMount;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const projectMount: AdditionalMount = {
  hostPath: path.join(allowed, 'project'),
  containerPath: 'project',
  readonly: false,
};
const group = (additionalMounts: AdditionalMount[] = [projectMount]) =>
  ({
    name: 'G',
    folder: 'g',
    trigger: '@Andy',
    added_at: '',
    containerConfig: { model: 'm', additionalMounts },
  }) as RegisteredGroup;

describe('parseMountArgs', () => {
  it('defaults to read-only', () => {
    expect(parseMountArgs('~/x')).toEqual({
      hostPath: '~/x',
      readonly: true,
      name: undefined,
    });
  });

  it('reads rw and a name', () => {
    expect(parseMountArgs('~/x rw as y')).toEqual({
      hostPath: '~/x',
      readonly: false,
      name: 'y',
    });
  });
});

describe('/mount', () => {
  it('adds a read-only mount marked as from chat, keeping other config', () => {
    const r = addMount(group(), false, path.join(allowed, 'app'));
    expect(r.ok).toBe(true);
    expect(r.updated!.containerConfig!.model).toBe('m');
    expect(r.updated!.containerConfig!.additionalMounts).toEqual([
      projectMount,
      {
        hostPath: path.join(allowed, 'app'),
        readonly: true,
        addedFromChat: true,
      },
    ]);
    expect(r.message).toContain('/workspace/extra/app (read-only)');
  });

  it('mounts read-write with rw', () => {
    const r = addMount(group(), false, `${path.join(allowed, 'app')} rw`);
    expect(r.message).toContain('(read-write)');
  });

  it('refuses folders outside the allowlist', () => {
    const r = addMount(group(), false, elsewhere);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not under any allowed root');
  });

  it('refuses blocked paths', () => {
    const r = addMount(group(), false, path.join(allowed, 'tokenizer'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('blocked pattern');
  });

  it('refuses a folder that is already mounted, trailing slash or not', () => {
    const r = addMount(group(), false, `${projectMount.hostPath}/ ro`);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already mounted');
  });

  it('refuses a name that is taken, and accepts it under another name', () => {
    const first = addMount(group(), false, path.join(allowed, 'app'));
    const other = path.join(allowed, 'other', 'app');
    const clash = addMount(first.updated!, false, other);
    expect(clash.ok).toBe(false);
    expect(clash.message).toContain('already taken');

    const renamed = addMount(first.updated!, false, `${other} as app2`);
    expect(renamed.ok).toBe(true);
    expect(renamed.message).toContain('/workspace/extra/app2');
  });

  it('picks up allowlist edits without a restart', () => {
    expect(addMount(group(), false, elsewhere).ok).toBe(false);
    writeAllowlist([allowed, elsewhere]);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(allowlistPath, future, future);
    expect(addMount(group(), false, elsewhere).ok).toBe(true);
    writeAllowlist([allowed]);
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(allowlistPath, later, later);
  });
});

describe('/unmount', () => {
  it('removes a mount added with /mount, by path or by name', () => {
    const added = addMount(group(), false, path.join(allowed, 'app')).updated!;
    for (const arg of [
      path.join(allowed, 'app'),
      'app',
      '/workspace/extra/app',
    ]) {
      const r = removeMount(added, arg);
      expect(r.ok).toBe(true);
      expect(r.updated!.containerConfig!.additionalMounts).toEqual([
        projectMount,
      ]);
    }
  });

  it('never removes the chat’s own folders', () => {
    for (const arg of [projectMount.hostPath, 'project']) {
      const r = removeMount(group(), arg);
      expect(r.ok).toBe(false);
      expect(r.updated).toBeUndefined();
      expect(r.message).toContain('can’t be unmounted');
    }
  });

  it('says when nothing matches', () => {
    expect(removeMount(group(), 'nope').message).toContain('Nothing mounted');
  });
});

describe('/mounts', () => {
  it('lists mounts, marks protected ones and explains rejected ones', () => {
    const g = group([
      projectMount,
      {
        hostPath: path.join(allowed, 'app'),
        readonly: true,
        addedFromChat: true,
      },
      { hostPath: elsewhere, readonly: true },
    ]);
    const out = formatMounts(g, false);
    expect(out).toContain(
      `${projectMount.hostPath} → /workspace/extra/project (rw) 📌`,
    );
    expect(out).toContain(
      `${path.join(allowed, 'app')} → /workspace/extra/app (ro)\n`,
    );
    expect(out).toContain(`${elsewhere} — ⚠️ not mounted`);
    expect(out).toContain('/workspace/global');
  });

  it('is in /help', () => {
    const help = formatHelp();
    expect(help).toContain('/mounts');
    expect(help).toContain('/mount <path>');
    expect(help).toContain('/unmount <path|name>');
  });
});
