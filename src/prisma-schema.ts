/**
 * Read-only Prisma schema discovery, shared by the container-side artifact
 * isolation (container-runner.ts) and the host-side regeneration
 * (host-prisma.ts). Parses just enough of schema.prisma to know which
 * generators run and where they write — never executes anything.
 */
import fs from 'fs';
import path from 'path';

export interface PrismaGenerator {
  name: string;
  /** Literal provider, or null when it isn't a plain string (e.g. env("X")). */
  provider: string | null;
  /** Literal output path as written, or null when absent or not a plain string. */
  output: string | null;
  /** True when `output` is set but isn't a plain string literal. */
  outputDynamic: boolean;
}

export interface PrismaSchema {
  /** Absolute path of the schema file. */
  schemaPath: string;
  /** Project root (dir with package.json) the schema belongs to. */
  projectDir: string;
  generators: PrismaGenerator[];
}

/** Prisma config files the CLI executes as code. */
export const PRISMA_CONFIG_FILES = [
  'prisma.config.ts',
  'prisma.config.mts',
  'prisma.config.cts',
  'prisma.config.js',
  'prisma.config.mjs',
  'prisma.config.cjs',
];

function stripComments(text: string): string {
  // Prisma only has line comments (`//` and `///`). Strings in generator
  // blocks never contain `//` in practice except URLs, which don't appear in
  // provider/output, so a plain strip is safe here.
  return text.replace(/\/\/.*$/gm, '');
}

function stringField(
  body: string,
  field: string,
): {
  present: boolean;
  value: string | null;
} {
  const m = new RegExp(`^\\s*${field}\\s*=\\s*(.+?)\\s*$`, 'm').exec(body);
  if (!m) return { present: false, value: null };
  const lit = /^"([^"]*)"$/.exec(m[1]);
  return { present: true, value: lit ? lit[1] : null };
}

export function parseGenerators(schemaText: string): PrismaGenerator[] {
  const text = stripComments(schemaText);
  const out: PrismaGenerator[] = [];
  const re = /\bgenerator\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const provider = stringField(m[2], 'provider');
    const output = stringField(m[2], 'output');
    out.push({
      name: m[1],
      provider: provider.value,
      output: output.value,
      outputDynamic: output.present && output.value === null,
    });
  }
  return out;
}

/** Schema files for one project root: package.json `prisma.schema`, then the conventional spots. */
export function findSchemaFiles(projectDir: string): string[] {
  const candidates: string[] = [];
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'),
    );
    if (typeof pkg?.prisma?.schema === 'string') {
      candidates.push(path.resolve(projectDir, pkg.prisma.schema));
    }
  } catch {
    // No or unreadable package.json — fall through to the conventions.
  }
  candidates.push(
    path.join(projectDir, 'prisma', 'schema.prisma'),
    path.join(projectDir, 'schema.prisma'),
  );
  const seen = new Set<string>();
  const found: string[] = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    // Must stay inside the project and be a regular file (not a symlink out).
    const rel = path.relative(projectDir, c);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (fs.lstatSync(c).isFile()) found.push(c);
    } catch {
      // Not there.
    }
  }
  return found;
}

export function readPrismaSchemas(projectDir: string): PrismaSchema[] {
  const schemas: PrismaSchema[] = [];
  for (const schemaPath of findSchemaFiles(projectDir)) {
    try {
      schemas.push({
        schemaPath,
        projectDir,
        generators: parseGenerators(fs.readFileSync(schemaPath, 'utf-8')),
      });
    } catch {
      // Unreadable — skip.
    }
  }
  return schemas;
}

/** Absolute output dir of a generator, or null when it uses the default (node_modules). */
export function generatorOutputDir(
  schemaPath: string,
  gen: PrismaGenerator,
): string | null {
  return gen.output ? path.resolve(path.dirname(schemaPath), gen.output) : null;
}

/**
 * Custom generator output dirs under `projectDir`, as POSIX paths relative to
 * it — candidates for container-side isolation. Default outputs land in
 * node_modules, which is isolated already.
 */
export function prismaOutputDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  for (const schema of readPrismaSchemas(projectDir)) {
    for (const gen of schema.generators) {
      const abs = generatorOutputDir(schema.schemaPath, gen);
      if (!abs) continue;
      const rel = path.relative(projectDir, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!dirs.includes(rel)) dirs.push(rel);
    }
  }
  return dirs;
}
