import { promises as fs, realpath as realpathCallback } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import { VaultError } from './errors.js';
import type { Project } from './types.js';

/** Directory names that are always excluded from note roots and source roots, matched case-insensitively. */
export const POLICY_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'generated',
  'templates',
  'private',
  'secrets',
]);

const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Control characters and characters that are separators, alternate data stream markers or wildcards on some platforms.
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

const IS_WINDOWS = process.platform === 'win32';

/** Native canonical path (resolves links and junctions, restores on-disk casing on Windows). */
export const realpathNative: (target: string) => Promise<string> = promisify(realpathCallback.native);

/** Compares two already-resolved paths, case-insensitively on Windows. */
export function isSamePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Validates path segments for use below a root. Returns a problem description or null. */
export function validateRelativeSegments(segments: string[]): string | null {
  if (segments.length === 0) return 'path is empty';
  let total = 0;
  for (const segment of segments) {
    total += segment.length + 1;
    if (segment.length === 0) return 'empty path segment';
    if (segment === '.' || segment === '..') return 'relative segments "." and ".." are not allowed';
    if (segment.length > MAX_SEGMENT_LENGTH) return 'path segment is too long';
    if (FORBIDDEN_CHARS.test(segment)) return 'path segment contains a forbidden character';
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'path segment must not end with a dot or a space';
    if (segment.startsWith(' ')) return 'path segment must not start with a space';
    if (WINDOWS_RESERVED.test(segment)) return 'path segment is a reserved device name';
    if (/^~\d*$/.test(segment)) return 'path segment is not allowed';
  }
  if (total > MAX_PATH_LENGTH) return 'path is too long';
  return null;
}

export type SplitNoteId = { ok: true; rootId: string; segments: string[]; relativePath: string } | { ok: false; problem: string };

/** Splits "rootId/relative/path.md" into its parts, validating syntax only (no filesystem access). */
export function splitNoteId(noteId: unknown, markdownOnly = true): SplitNoteId {
  if (typeof noteId !== 'string') return { ok: false, problem: 'note id must be a string' };
  if (noteId.length === 0) return { ok: false, problem: 'note id is empty' };
  if (noteId.length > MAX_PATH_LENGTH) return { ok: false, problem: 'note id is too long' };
  if (noteId.includes('\\')) return { ok: false, problem: 'note id must use forward slashes' };
  if (noteId.startsWith('/')) return { ok: false, problem: 'note id must not start with a slash' };
  const parts = noteId.split('/');
  if (parts.length < 2) return { ok: false, problem: 'note id must have the form rootId/relative/path.md' };
  const rootId = parts[0]!;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rootId)) return { ok: false, problem: 'invalid root id' };
  const segments = parts.slice(1);
  const problem = validateRelativeSegments(segments);
  if (problem) return { ok: false, problem };
  const last = segments[segments.length - 1]!;
  if (markdownOnly && (!last.endsWith('.md') || last.length <= 3)) return { ok: false, problem: 'note id must end with ".md"' };
  if (last.includes(' .md')) return { ok: false, problem: 'note file name must not end with a space before ".md"' };
  return { ok: true, rootId, segments, relativePath: segments.join('/') };
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/** Returns true when any segment is hidden or a policy-excluded directory name. */
export function isPolicyExcluded(segments: string[]): boolean {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (isHiddenName(segment)) return true;
    if (i < segments.length - 1 && POLICY_EXCLUDED_NAMES.has(segment.toLowerCase())) return true;
  }
  return false;
}

/**
 * Returns true when a configured exclude glob matches the note id or its root-relative path.
 * Matching is always case-insensitive: case-insensitive filesystems (Windows, default macOS) would
 * otherwise let "docs/Drafts/x.md" reach a file excluded by "docs/drafts/**", and over-excluding
 * is the safe direction on every platform.
 */
export function matchesConfiguredExclude(project: Project, rootId: string, relativePath: string): boolean {
  const options = { dot: true, nocase: true, nocomment: true, nonegate: true, windowsPathsNoEscape: true } as const;
  const noteId = `${rootId}/${relativePath}`;
  for (const pattern of project.config.exclude) {
    if (minimatch(noteId, pattern, options) || minimatch(relativePath, pattern, options)) return true;
  }
  return false;
}

/** Returns true when a directory (root-relative path) should not be scanned. */
export function isDirectoryExcluded(project: Project, rootId: string, segments: string[]): boolean {
  const name = segments[segments.length - 1]!;
  if (isHiddenName(name) || POLICY_EXCLUDED_NAMES.has(name.toLowerCase())) return true;
  const relativePath = segments.join('/');
  return matchesConfiguredExclude(project, rootId, relativePath) || matchesConfiguredExclude(project, rootId, `${relativePath}/`);
}

export async function realRootPath(project: Project, rootPath: string): Promise<string> {
  const segments = rootPath === '.' ? [] : rootPath.split('/');
  const configured = path.join(project.root, ...segments);
  await assertPlainAncestors(configured);
  const real = await realpathNative(configured);
  const relative = path.relative(project.root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new VaultError('PATH_ESCAPE', 'Configured root resolves outside the project');
  }
  return real;
}

/** Re-check roots at use time: an editor or sync client may replace a directory after startup. */
export async function assertPlainAncestors(absolute: string): Promise<void> {
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new VaultError('PATH_ESCAPE', 'Configured root passes through a symbolic link or junction');
    if (!info.isDirectory()) throw new VaultError('PATH_ESCAPE', 'Configured root ancestor is not a directory');
  }
}

function ioCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'EIO';
}

/**
 * Walks from the real root down to the target, rejecting any link or reparse point, and verifies
 * that the native real path stays inside the root. Returns the absolute target path.
 */
async function resolveContained(rootReal: string, segments: string[], label: string, allowMissing: boolean): Promise<string> {
  let current = rootReal;
  for (let i = 0; i < segments.length; i += 1) {
    const isLast = i === segments.length - 1;
    current = path.join(current, segments[i]!);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      const code = ioCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (isLast && allowMissing) {
          return current;
        }
        throw new VaultError('NOT_FOUND', isLast ? `${label} does not exist` : `${label} parent directory does not exist`);
      }
      throw new VaultError('IO_ERROR', `Failed to inspect ${label} (${code})`);
    }
    if (stat.isSymbolicLink()) {
      throw new VaultError('PATH_ESCAPE', `${label} passes through a symbolic link, junction or reparse point`);
    }
    if (!isLast && !stat.isDirectory()) {
      throw new VaultError('NOT_FOUND', `${label} parent is not a directory`);
    }
    if (isLast && !stat.isFile()) {
      throw new VaultError('NOT_FOUND', `${label} is not a regular file`);
    }
  }
  let real: string;
  try {
    real = await realpathNative(current);
  } catch (error) {
    throw new VaultError('IO_ERROR', `Failed to resolve ${label} (${ioCode(error)})`);
  }
  if (!isSamePath(real, current)) {
    throw new VaultError('PATH_ESCAPE', `${label} resolves to a different location than its declared path`);
  }
  const relative = path.relative(rootReal, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new VaultError('PATH_ESCAPE', `${label} resolves outside its root`);
  }
  return current;
}

/**
 * Resolves a note id to a contained absolute path. With allowMissing the final file may be absent,
 * but its parent directory must exist and the whole chain must be free of links.
 */
export async function resolveNote(project: Project, noteId: string, allowMissing = false): Promise<string> {
  return resolveNotePath(project, noteId, allowMissing, true);
}

/** Resolve an attachment reference for existence metadata only; no attachment contents are read. */
export async function resolveAttachment(project: Project, referenceId: string): Promise<string> {
  return resolveNotePath(project, referenceId, false, false);
}

async function resolveNotePath(project: Project, noteId: string, allowMissing: boolean, markdownOnly: boolean): Promise<string> {
  const split = splitNoteId(noteId, markdownOnly);
  if (!split.ok) throw new VaultError('INVALID_NOTE_ID', `Invalid note id: ${split.problem}`);
  const root = project.config.notesRoots.find((candidate) => candidate.id === split.rootId);
  if (!root) throw new VaultError('INVALID_NOTE_ID', `Unknown notes root "${split.rootId}"`);
  if (isPolicyExcluded(split.segments)) {
    throw new VaultError('PATH_EXCLUDED', 'Note path is hidden or inside an excluded directory');
  }
  if (matchesConfiguredExclude(project, split.rootId, split.relativePath)) {
    throw new VaultError('PATH_EXCLUDED', 'Note path matches a configured exclude pattern');
  }
  let rootReal: string;
  try {
    rootReal = await realRootPath(project, root.path);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('IO_ERROR', `Notes root "${root.id}" is not accessible (${ioCode(error)})`);
  }
  return resolveContained(rootReal, split.segments, 'Note', allowMissing);
}

/**
 * Resolves a source reference to a contained absolute path. The file must exist, must be inside the
 * declared source root, must not be hidden or policy excluded and must match an include glob.
 */
export async function resolveSource(project: Project, sourceRootId: string, relativePath: string): Promise<string> {
  const root = project.config.sourceRoots.find((candidate) => candidate.id === sourceRootId);
  if (!root) throw new VaultError('INVALID_PATH', `Unknown source root "${String(sourceRootId)}"`);
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > MAX_PATH_LENGTH) {
    throw new VaultError('INVALID_PATH', 'Source path must be a non-empty relative path');
  }
  if (relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new VaultError('INVALID_PATH', 'Source path must be relative and use forward slashes');
  }
  const segments = relativePath.split('/');
  const problem = validateRelativeSegments(segments);
  if (problem) throw new VaultError('INVALID_PATH', `Invalid source path: ${problem}`);
  if (isPolicyExcluded(segments)) {
    throw new VaultError('PATH_EXCLUDED', 'Source path is hidden or inside an excluded directory');
  }
  const normalized = segments.join('/');
  if (matchesConfiguredExclude(project, sourceRootId, normalized)) {
    throw new VaultError('PATH_EXCLUDED', 'Source path matches a configured exclude pattern');
  }
  // Include globs stay case-sensitive: that is the restrictive direction, so a case alias can never widen access.
  const options = { dot: false, nocomment: true, nonegate: true, windowsPathsNoEscape: true } as const;
  if (!root.include.some((pattern) => minimatch(normalized, pattern, options))) {
    throw new VaultError('PATH_EXCLUDED', `Source path does not match the include patterns of root "${root.id}"`);
  }
  let rootReal: string;
  try {
    rootReal = await realRootPath(project, root.path);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('IO_ERROR', `Source root "${root.id}" is not accessible (${ioCode(error)})`);
  }
  return resolveContained(rootReal, segments, 'Source file', false);
}
