import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-prisma-'));
const STATE_PATH = path.join(tmp, 'host-prisma.json');

vi.mock('../src/config.js', () => ({ HOST_PRISMA_STATE_PATH: STATE_PATH }));

const { parseGenerators, prismaOutputDirs } =
  await import('../src/prisma-schema.js');
const {
  findPrismaCli,
  generateEnv,
  refusalReason,
  setHostPrismaNotifier,
  syncHostPrisma,
} = await import('../src/host-prisma.js');
const { readPrismaSchemas } = await import('../src/prisma-schema.js');

const SCHEMA = (generator: string) => `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

${generator}

model a {
  id Int @id
}
`;

const SAFE_GENERATOR = `generator client {
  provider = "prisma-client" // comment
  output   = "../client"
}`;

// A fake Prisma CLI: records its argv and the env vars that matter, so the
// test can see exactly what the host ran.
const FAKE_CLI = `
const fs = require('fs');
fs.writeFileSync(process.cwd() + '/ran.json', JSON.stringify({
  argv: process.argv.slice(2),
  engine: process.env.PRISMA_QUERY_ENGINE_LIBRARY,
  nodeOptions: process.env.NODE_OPTIONS,
  secret: process.env.SECRET_TOKEN,
}));
`;

let n = 0;
function makeRepo(generator = SAFE_GENERATOR): {
  repoRoot: string;
  projectDir: string;
  schemaPath: string;
} {
  const repoRoot = path.join(tmp, `repo-${n++}`);
  const projectDir = path.join(repoRoot, 'packages', 'db');
  fs.mkdirSync(path.join(projectDir, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
  const schemaPath = path.join(projectDir, 'prisma', 'schema.prisma');
  fs.writeFileSync(schemaPath, SCHEMA(generator));
  const cliDir = path.join(repoRoot, 'node_modules', 'prisma', 'build');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'index.js'), FAKE_CLI);
  return { repoRoot, projectDir, schemaPath };
}

const notices: string[] = [];
setHostPrismaNotifier((_jid, text) => notices.push(text));

beforeEach(() => {
  notices.length = 0;
  fs.rmSync(STATE_PATH, { force: true });
});

describe('parseGenerators', () => {
  it('reads provider and output, ignoring comments', () => {
    expect(parseGenerators(SCHEMA(SAFE_GENERATOR))).toEqual([
      {
        name: 'client',
        provider: 'prisma-client',
        output: '../client',
        outputDynamic: false,
      },
    ]);
  });

  it('flags non-literal provider and output', () => {
    const [g] = parseGenerators(
      'generator x {\n provider = env("P")\n output = env("O")\n}',
    );
    expect(g.provider).toBeNull();
    expect(g.outputDynamic).toBe(true);
  });
});

describe('prismaOutputDirs', () => {
  it('lists custom outputs relative to the project', () => {
    const { projectDir } = makeRepo();
    expect(prismaOutputDirs(projectDir)).toEqual(['client']);
  });

  it('skips default (node_modules) and escaping outputs', () => {
    const a = makeRepo('generator c {\n provider = "prisma-client-js"\n}');
    expect(prismaOutputDirs(a.projectDir)).toEqual([]);
    const b = makeRepo(
      'generator c {\n provider = "prisma-client"\n output = "../../../x"\n}',
    );
    expect(prismaOutputDirs(b.projectDir)).toEqual([]);
  });
});

describe('isolatedPrismaOutputs', () => {
  it('isolates only gitignored outputs', async () => {
    const { isolatedPrismaOutputs } =
      await import('../src/container-runner.js');
    const { repoRoot, projectDir } = makeRepo();
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    expect(isolatedPrismaOutputs(projectDir)).toEqual([]);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'packages/db/client\n');
    expect(isolatedPrismaOutputs(projectDir)).toEqual(['client']);
  });
});

describe('refusalReason', () => {
  const reason = (generator: string, setup?: (projectDir: string) => void) => {
    const { repoRoot, projectDir } = makeRepo(generator);
    setup?.(projectDir);
    const [schema] = readPrismaSchemas(projectDir);
    return refusalReason(schema, repoRoot);
  };

  it('accepts the standard client generators', () => {
    expect(reason(SAFE_GENERATOR)).toBeNull();
    expect(
      reason('generator c {\n provider = "prisma-client-js"\n}'),
    ).toBeNull();
  });

  it('refuses generators that name a program', () => {
    expect(reason('generator c {\n provider = "node ./evil.js"\n}')).toMatch(
      /provider/,
    );
    expect(reason('generator c {\n provider = env("P")\n}')).toMatch(
      /provider/,
    );
  });

  it('refuses outputs outside the repo', () => {
    expect(
      reason(
        'generator c {\n provider = "prisma-client"\n output = "/etc/x"\n}',
      ),
    ).toMatch(/outside the repo/);
  });

  it('refuses when a prisma.config file exists', () => {
    expect(
      reason(SAFE_GENERATOR, (dir) =>
        fs.writeFileSync(path.join(dir, 'prisma.config.ts'), ''),
      ),
    ).toMatch(/prisma\.config\.ts/);
  });
});

describe('findPrismaCli', () => {
  it('finds the repo’s own CLI walking up from the project', () => {
    const { repoRoot, projectDir } = makeRepo();
    expect(findPrismaCli(projectDir, repoRoot)).toBe(
      fs.realpathSync(
        path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
      ),
    );
  });

  it('rejects a CLI symlinked from outside the repo', () => {
    const { repoRoot, projectDir } = makeRepo();
    const outside = path.join(tmp, `outside-${n++}.js`);
    fs.writeFileSync(outside, '');
    const cli = path.join(
      repoRoot,
      'node_modules',
      'prisma',
      'build',
      'index.js',
    );
    fs.rmSync(cli);
    fs.symlinkSync(outside, cli);
    expect(findPrismaCli(projectDir, repoRoot)).toBeNull();
  });
});

describe('generateEnv', () => {
  it('pins engine overrides empty and passes no secrets', () => {
    process.env.SECRET_TOKEN = 'shh';
    const env = generateEnv();
    expect(env.PRISMA_QUERY_ENGINE_LIBRARY).toBe('');
    expect(env.PRISMA_ENGINES_MIRROR).toBe('');
    expect(env.NODE_OPTIONS).toBe('');
    expect(env.SECRET_TOKEN).toBeUndefined();
    delete process.env.SECRET_TOKEN;
  });
});

describe('syncHostPrisma', () => {
  it('runs only `generate --schema <file>` with a pinned env, once per change', async () => {
    const { repoRoot, projectDir, schemaPath } = makeRepo();
    process.env.SECRET_TOKEN = 'shh';
    process.env.NODE_OPTIONS = '--require /evil.js';
    const repos = [{ name: 'app', repoRoot, projectDirs: [projectDir] }];
    try {
      await syncHostPrisma('tg:1', repos);
    } finally {
      delete process.env.SECRET_TOKEN;
      delete process.env.NODE_OPTIONS;
    }

    const ran = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'ran.json'), 'utf-8'),
    );
    expect(ran.argv).toEqual(['generate', '--schema', schemaPath]);
    expect(ran.engine).toBe('');
    expect(ran.nodeOptions).toBe('');
    expect(ran.secret).toBeUndefined();
    expect(notices).toEqual([
      '🔄 Regenerated the Prisma client on your Mac for app/packages/db.',
    ]);

    // Unchanged schema: nothing runs.
    fs.rmSync(path.join(projectDir, 'ran.json'));
    await syncHostPrisma('tg:1', repos);
    expect(fs.existsSync(path.join(projectDir, 'ran.json'))).toBe(false);

    // Changed schema: runs again.
    fs.appendFileSync(schemaPath, '\nmodel b {\n  id Int @id\n}\n');
    await syncHostPrisma('tg:1', repos);
    expect(fs.existsSync(path.join(projectDir, 'ran.json'))).toBe(true);
    expect(notices.at(-1)).toContain('(schema changed)');
  });

  it('refuses unsafe schemas without running anything, and says so once', async () => {
    const { repoRoot, projectDir } = makeRepo(
      'generator c {\n provider = "node ./evil.js"\n}',
    );
    const repos = [{ name: 'app', repoRoot, projectDirs: [projectDir] }];
    await syncHostPrisma('tg:1', repos);
    await syncHostPrisma('tg:1', repos);
    expect(fs.existsSync(path.join(projectDir, 'ran.json'))).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/didn't regenerate/);
  });
});

describe('manual /prisma-db-generate (force)', () => {
  it('regenerates an unchanged schema and reports instead of notifying', async () => {
    const { repoRoot, projectDir } = makeRepo();
    const repos = [{ name: 'app', repoRoot, projectDirs: [projectDir] }];
    await syncHostPrisma('tg:1', repos);
    notices.length = 0;
    fs.rmSync(path.join(projectDir, 'ran.json'));

    const outcomes = await syncHostPrisma('tg:1', repos, { force: true });
    expect(outcomes).toEqual([
      { label: 'app/packages/db', status: 'generated' },
    ]);
    expect(fs.existsSync(path.join(projectDir, 'ran.json'))).toBe(true);
    expect(notices).toEqual([]);
  });

  it('still refuses unsafe schemas, every time', async () => {
    const { repoRoot, projectDir } = makeRepo(
      'generator c {\n provider = "node ./evil.js"\n}',
    );
    const repos = [{ name: 'app', repoRoot, projectDirs: [projectDir] }];
    for (let i = 0; i < 2; i++) {
      const [o] = await syncHostPrisma('tg:1', repos, { force: true });
      expect(o.status).toBe('refused');
    }
    expect(fs.existsSync(path.join(projectDir, 'ran.json'))).toBe(false);
  });

  it('formats a summary', async () => {
    const { formatSyncOutcomes } = await import('../src/host-prisma.js');
    expect(formatSyncOutcomes([])).toContain('No Prisma schemas');
    const text = formatSyncOutcomes([
      { label: 'a/x', status: 'generated' },
      { label: 'a/y', status: 'refused', detail: 'nope' },
    ]);
    expect(text).toContain('✅ a/x — regenerated');
    expect(text).toContain('🚫 a/y — not run: nope');
  });
});
