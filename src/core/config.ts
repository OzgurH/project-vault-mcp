import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { VaultError } from './errors.js';
import { assertPlainAncestors, isPolicyExcluded, isSamePath, realpathNative, splitNoteId, validateRelativeSegments } from './paths.js';
import type { Limits, Project, VaultConfig } from './types.js';

export const CONFIG_FILE_NAME = 'project-vault.json';
/** Hard upper bound for the configuration file size in bytes (64 KiB). */
export const MAX_CONFIG_BYTES = 64 * 1024;

const DEFAULT_LIMITS: Limits = {
  maxFiles: 5000,
  maxFileBytes: 1048576,
  maxTotalBytes: 52428800,
  maxResponseChars: 20000,
  maxQueryChars: 500,
  rescanIntervalMs: 1000,
};

/** Root identifiers: lowercase ASCII letters, digits, '-' and '_' (no separators, no dots). */
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function defaultConfig(name = 'project'): VaultConfig {
  return {
    schemaVersion: 1,
    name,
    notesRoots: [{ id: 'docs', path: 'docs' }],
    entryNotes: ['docs/index.md'],
    exclude: [],
    sourceRoots: [],
    searchLocale: 'default',
    allowWrites: false,
    limits: { ...DEFAULT_LIMITS },
  };
}

const bounded = (min: number, max: number) => z.number().int().min(min).max(max);

const limitsSchema = z
  .object({
    maxFiles: bounded(1, 1_000_000),
    maxFileBytes: bounded(1, 256 * 1024 * 1024),
    maxTotalBytes: bounded(1, 16 * 1024 * 1024 * 1024),
    maxResponseChars: bounded(100, 5_000_000),
    maxQueryChars: bounded(1, 100_000),
    rescanIntervalMs: bounded(0, 86_400_000),
  })
  .partial()
  .strict();

const rootIdSchema = z.string().regex(ROOT_ID_PATTERN, 'root id must match [a-z0-9][a-z0-9_-]* and be at most 64 characters');
const rootPathSchema = z.string().min(1).max(1024);

const notesRootSchema = z.object({ id: rootIdSchema, path: rootPathSchema }).strict();
const sourceRootSchema = z
  .object({ id: rootIdSchema, path: rootPathSchema, include: z.array(z.string().min(1).max(512)).min(1).max(256) })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(200).optional(),
    notesRoots: z.array(notesRootSchema).min(1).max(64).optional(),
    entryNotes: z.array(z.string().min(1).max(1024)).max(256).optional(),
    exclude: z.array(z.string().min(1).max(512)).max(1024).optional(),
    sourceRoots: z.array(sourceRootSchema).max(64).optional(),
    searchLocale: z.enum(['default', 'tr']).optional(),
    allowWrites: z.boolean().optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

function invalid(message: string): VaultError {
  return new VaultError('INVALID_CONFIG', `Invalid configuration: ${message}`);
}

function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Validates a configured root path (relative to the project root) and returns its canonical real path. */
async function resolveRootPath(projectRoot: string, kind: string, id: string, configured: string): Promise<string> {
  if (path.isAbsolute(configured) || /^[A-Za-z]:/.test(configured) || configured.startsWith('\\') || configured.startsWith('/')) {
    throw invalid(`${kind} root "${id}" path must be relative to the project root`);
  }
  if (configured.includes('\\')) {
    throw invalid(`${kind} root "${id}" path must use forward slashes`);
  }
  const segments = configured === '.' ? [] : configured.split('/');
  if (segments.length > 0) {
    const problem = validateRelativeSegments(segments);
    if (problem) throw invalid(`${kind} root "${id}" path is not allowed: ${problem}`);
    if (isPolicyExcluded([...segments, 'note.md'])) throw invalid(`${kind} root "${id}" is hidden or excluded`);
  }
  const absolute = path.join(projectRoot, ...segments);
  let real: string;
  try {
    await assertPlainAncestors(absolute);
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) throw invalid(`${kind} root "${id}" is not a directory`);
    real = await realpathNative(absolute);
  } catch (error) {
    if (error instanceof VaultError) throw invalid(error.message);
    throw invalid(`${kind} root "${id}" does not exist or is not readable (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!isWithin(projectRoot, real)) {
    throw invalid(`${kind} root "${id}" resolves outside the project root`);
  }
  return real;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function checkDistinctRoots(kind: string, roots: { id: string; real: string }[]): void {
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const a = roots[i]!;
      const b = roots[j]!;
      if (isSamePath(a.real, b.real)) {
        throw invalid(`${kind} roots "${a.id}" and "${b.id}" resolve to the same directory`);
      }
      if (isWithin(a.real, b.real) || isWithin(b.real, a.real)) {
        throw invalid(`${kind} roots "${a.id}" and "${b.id}" are nested`);
      }
    }
  }
}

/**
 * Loads and validates project-vault.json from a project directory or an explicit config file path.
 * The returned root and configPath are canonical absolute paths.
 */
export async function loadProject(rootOrConfig: string): Promise<Project> {
  if (typeof rootOrConfig !== 'string' || rootOrConfig.length === 0) {
    throw invalid('a project directory or configuration file path is required');
  }
  const given = path.resolve(rootOrConfig);
  let configCandidate: string;
  try {
    const stat = await fs.stat(given);
    configCandidate = stat.isDirectory() ? path.join(given, CONFIG_FILE_NAME) : given;
  } catch (error) {
    throw invalid(`path does not exist: ${given} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }

  let lstat;
  try {
    lstat = await fs.lstat(configCandidate);
  } catch (error) {
    throw invalid(`configuration file not found: ${configCandidate} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (lstat.isSymbolicLink()) throw invalid('configuration file must not be a symbolic link');
  if (!lstat.isFile()) throw invalid('configuration path is not a regular file');
  if (lstat.size > MAX_CONFIG_BYTES) throw invalid(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`);

  const projectRoot = await realpathNative(path.dirname(configCandidate));
  const configPath = path.join(projectRoot, path.basename(configCandidate));
  const realConfigPath = await realpathNative(configCandidate);
  if (!isSamePath(realConfigPath, configPath)) throw invalid('configuration file path resolves through a link');

  const raw = await fs.readFile(configPath);
  if (raw.length > MAX_CONFIG_BYTES) throw invalid(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw invalid('configuration file is not valid UTF-8');
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw invalid(`configuration file is not valid JSON (${(error as Error).message})`);
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    throw invalid('configuration must be a JSON object');
  }
  const parsed = configSchema.safeParse(parsedJson);
  if (!parsed.success) throw invalid(describeZodIssues(parsed.error));
  const data = parsed.data;

  const defaults = defaultConfig(data.name ?? path.basename(projectRoot) ?? 'project');
  const config: VaultConfig = {
    schemaVersion: 1,
    name: data.name ?? defaults.name,
    notesRoots: (data.notesRoots ?? defaults.notesRoots).map((root) => ({ id: root.id, path: root.path })),
    entryNotes: data.entryNotes ?? defaults.entryNotes,
    exclude: data.exclude ?? [],
    sourceRoots: (data.sourceRoots ?? []).map((root) => ({ id: root.id, path: root.path, include: [...root.include] })),
    searchLocale: data.searchLocale ?? 'default',
    allowWrites: data.allowWrites ?? false,
    limits: { ...DEFAULT_LIMITS, ...(data.limits ?? {}) },
  };

  const notesIds = new Set<string>();
  const notesReal: { id: string; real: string }[] = [];
  for (const root of config.notesRoots) {
    if (notesIds.has(root.id)) throw invalid(`duplicate notes root id "${root.id}"`);
    notesIds.add(root.id);
    notesReal.push({ id: root.id, real: await resolveRootPath(projectRoot, 'notes', root.id, root.path) });
  }
  checkDistinctRoots('notes', notesReal);

  const sourceIds = new Set<string>();
  const sourceReal: { id: string; real: string }[] = [];
  for (const root of config.sourceRoots) {
    if (sourceIds.has(root.id)) throw invalid(`duplicate source root id "${root.id}"`);
    sourceIds.add(root.id);
    sourceReal.push({ id: root.id, real: await resolveRootPath(projectRoot, 'source', root.id, root.path) });
  }
  checkDistinctRoots('source', sourceReal);

  for (const entry of config.entryNotes) {
    const split = splitNoteId(entry);
    if (!split.ok) throw invalid(`entry note "${entry}" is not a valid note id (${split.problem})`);
    if (!notesIds.has(split.rootId)) throw invalid(`entry note "${entry}" refers to unknown notes root "${split.rootId}"`);
  }
  for (const pattern of config.exclude) {
    if (pattern.includes('\u0000')) throw invalid('exclude patterns must not contain NUL characters');
  }

  return { root: projectRoot, configPath, config };
}
