/**
 * Prime a group's container-side dependency trees.
 *
 * Optional: containers self-heal (pnpm auto-installs when the lockfile and the
 * container's tree diverge), but the very first install of a big repo means
 * minutes of downloads — running it here keeps that out of the chat request
 * path. Uses the exact same volume mounts as real agent containers, so what
 * this warms is what they use.
 *
 *   npx tsx scripts/warm-container.ts telegram_linkbase [...]
 *   npx tsx scripts/warm-container.ts --all [--dry-run]
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CONTAINER_IMAGE } from '../src/config.js';
import {
  ARTIFACTS_VOLUME,
  PNPM_STORE_PATH,
  collectArtifactMounts,
  ensureArtifactSubpaths,
  findProjectRoots,
  VolumeMount,
} from '../src/container-runner.js';
import { validateAdditionalMounts } from '../src/mount-security.js';
import type { ContainerConfig } from '../src/types.js';

// Resolved from this file, not process.cwd(), so the script works from anywhere.
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);

const LOCKFILE_PM: Array<{ file: string; install: string }> = [
  // Order is precedence — some repos carry a vestigial second lockfile.
  { file: 'pnpm-lock.yaml', install: 'pnpm install' },
  { file: 'yarn.lock', install: 'yarn install' },
  { file: 'package-lock.json', install: 'npm install' },
  { file: 'bun.lockb', install: 'bun install' },
  { file: 'bun.lock', install: 'bun install' },
];

function installCommand(dir: string, isMountRoot: boolean): string | null {
  for (const { file, install } of LOCKFILE_PM) {
    if (fs.existsSync(path.join(dir, file))) return install;
  }
  // No lockfile: only the mount root gets a fallback install. Nested dirs
  // without their own lockfile are workspace members (covered by the root's
  // install) — running `npm install` in one CREATES a package-lock.json in
  // the user's checkout, which is exactly the kind of write this script must
  // never make.
  return isMountRoot && fs.existsSync(path.join(dir, 'package.json'))
    ? 'npm install'
    : null;
}

interface GroupRow {
  name: string;
  folder: string;
  container_config: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const wanted = argv.filter((a) => !a.startsWith('--'));

  if (!all && wanted.length === 0) {
    console.error(
      'usage: warm-container.ts [--all | <group-folder>...] [--dry-run]',
    );
    process.exit(1);
  }

  const db = new Database(path.join(PROJECT_ROOT, 'store', 'messages.db'), {
    readonly: true,
  });
  const rows = db
    .prepare('SELECT name, folder, container_config FROM registered_groups')
    .all() as GroupRow[];
  db.close();

  const groups = rows.filter((r) =>
    all
      ? r.container_config?.includes('additionalMounts')
      : wanted.includes(r.folder),
  );
  if (groups.length === 0) {
    console.error('no matching groups');
    process.exit(1);
  }

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  let warmed = 0;
  let failed = 0;

  for (const group of groups) {
    const config: ContainerConfig = group.container_config
      ? JSON.parse(group.container_config)
      : {};
    const repoMounts: VolumeMount[] = validateAdditionalMounts(
      config.additionalMounts ?? [],
      group.name,
      false,
    );

    for (const mount of repoMounts) {
      // Install once per project root that has its own manifest; a workspace
      // root's install covers its members, and re-running in a member is a
      // cheap no-op, so precision doesn't matter here.
      const steps = findProjectRoots(mount.hostPath)
        .map((dir) => {
          const cmd = installCommand(dir, dir === mount.hostPath);
          if (!cmd) return null;
          const rel = path.relative(mount.hostPath, dir);
          const cdir = rel
            ? path.posix.join(
                mount.containerPath,
                rel.split(path.sep).join('/'),
              )
            : mount.containerPath;
          return `echo "--- ${cdir}: ${cmd}"; (cd '${cdir}' && ${cmd} 2>&1 | tail -6)`;
        })
        .filter((s): s is string => Boolean(s));

      if (steps.length === 0) {
        console.log(
          `skip  ${group.folder}: ${mount.containerPath} (not a node project)`,
        );
        continue;
      }
      console.log(
        `warm  ${group.folder}: ${mount.containerPath} (${steps.length} install target(s))`,
      );
      if (dryRun) continue;

      const artifactMounts = collectArtifactMounts(
        [mount],
        group.folder,
        config.isolatedArtifacts ?? [],
      );
      await ensureArtifactSubpaths(artifactMounts);

      const args = [
        'run',
        '--rm',
        ...(uid !== 0 && uid !== 1000 ? ['--user', `${uid}:${gid}`] : []),
        '-e',
        'HOME=/home/node',
        '-e',
        `npm_config_store_dir=${PNPM_STORE_PATH}`,
        '-v',
        `${mount.hostPath}:${mount.containerPath}`,
        ...artifactMounts.flatMap((m) => [
          '--mount',
          `type=volume,src=${ARTIFACTS_VOLUME},dst=${m.containerPath},volume-subpath=${m.subpath}`,
        ]),
        '--entrypoint',
        'bash',
        CONTAINER_IMAGE,
        '-lc',
        steps.join('\n'),
      ];

      try {
        const out = execFileSync('docker', args, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        for (const line of out.trimEnd().split('\n'))
          console.log(`      ${line}`);
        warmed++;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        for (const line of `${err.stdout ?? ''}${err.stderr ?? ''}`
          .trimEnd()
          .split('\n'))
          console.log(`      ${line}`);
        console.log(`      FAILED (exit ${err.status})`);
        failed++;
      }
    }
  }

  console.log(`\nwarmed ${warmed}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

void main();
