import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dir, Dirent } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { VaultError } from './errors.js';
import { assertContentPolicy } from './content-policy.js';
import { isDirectoryExcluded, matchesConfiguredExclude, realRootPath, resolveNote, splitNoteId } from './paths.js';
import type { NoteFile, Project } from './types.js';

/** Maximum size of a YAML frontmatter block in characters. */
export const MAX_FRONTMATTER_CHARS = 32 * 1024;
const MAX_YAML_ALIASES = 32;

const UTF8_BOM = '﻿';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Strips a UTF-8 BOM and converts CRLF and lone CR to LF. */
export function normalizeText(text: string): string {
  const withoutBom = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, '\n');
}

function ioCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'EIO';
}

/**
 * Extracts and parses a leading YAML frontmatter block from LF-normalized content.
 * Returns null when there is no frontmatter. Throws INVALID_FRONTMATTER for malformed,
 * oversized, custom-tagged or alias-heavy YAML.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---\n') && content !== '---') return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter block is not closed');
  const after = content.charAt(end + 4);
  if (after !== '' && after !== '\n') throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter block is not closed');
  const yamlText = content.slice(4, end);
  if (yamlText.length > MAX_FRONTMATTER_CHARS) {
    throw new VaultError('INVALID_FRONTMATTER', `Frontmatter exceeds ${MAX_FRONTMATTER_CHARS} characters`);
  }
  if (yamlText.trim().length === 0) return {};
  let value: unknown;
  try {
    const doc = parseDocument(yamlText, { uniqueKeys: true, strict: true, logLevel: 'silent', version: '1.2', schema: 'core' });
    if (doc.errors.length > 0 || doc.warnings.length > 0) {
      const first = doc.errors[0] ?? doc.warnings[0]!;
      throw new VaultError('INVALID_FRONTMATTER', `Frontmatter YAML is invalid (${first.code})`);
    }
    value = doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter YAML could not be parsed safely');
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter must be a YAML mapping');
  }
  return value as Record<string, unknown>;
}

/** Classification values that restrict access, compared case-insensitively after trimming. */
const RESTRICTED_CLASSIFICATIONS: ReadonlySet<string> = new Set(['confidential', 'restricted']);

// Strict ISO 8601: date only (UTC midnight) or date-time with an explicit "Z" or ±hh:mm offset.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2}))?$/;

/**
 * Parses a strict ISO 8601 timestamp into epoch milliseconds, or returns null when the value is
 * not a string, is malformed, has impossible components (for example February 30) or is a
 * date-time without an explicit UTC offset. Local-time guesses are never made.
 */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, second, millis);
  const utc = check.getTime();
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const zone = match[8];
  if (zone === undefined || zone === 'Z' || zone === 'z') return utc;
  const sign = zone.charAt(0) === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offsetHours = Number(digits.slice(0, 2));
  const offsetMinutes = Number(digits.slice(2, 4));
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  return utc - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
}

/**
 * Returns the reason a note's frontmatter restricts access, or null when the note is readable.
 * Deny-by-default: every recognised privacy flag must have its exact expected type, so the
 * strings "false"/"true", numbers or lists never silently grant access. Flags that are absent do
 * not restrict anything; `now` is injectable for deterministic expiry tests.
 */
export function frontmatterAccessRestriction(data: Record<string, unknown> | null, now: number = Date.now()): string | null {
  if (!data) return null;
  const isPrivate = data['private'];
  if (isPrivate !== undefined) {
    if (isPrivate !== false) return isPrivate === true ? 'private is true' : 'private must be a boolean';
  }
  const visibility = data['visibility'];
  if (visibility !== undefined) {
    if (typeof visibility !== 'string') return 'visibility must be a string';
    if (visibility.trim().toLowerCase() === 'private') return 'visibility is private';
  }
  const aiAccess = data['ai_access'];
  if (aiAccess !== undefined) {
    if (aiAccess !== true) return aiAccess === false ? 'ai_access is false' : 'ai_access must be a boolean';
  }
  const personalData = data['personal_data'];
  if (personalData !== undefined) {
    if (personalData !== false) return personalData === true ? 'personal_data is true' : 'personal_data must be a boolean';
  }
  const classification = data['classification'];
  if (classification !== undefined) {
    if (typeof classification !== 'string') return 'classification must be a string';
    if (RESTRICTED_CLASSIFICATIONS.has(classification.trim().toLowerCase())) return 'classification is restricted';
  }
  const expiresAt = data['expires_at'];
  if (expiresAt !== undefined) {
    const expiry = parseIsoTimestamp(expiresAt);
    if (expiry === null) return 'expires_at must be an ISO 8601 timestamp with an explicit UTC offset';
    if (expiry <= now) return 'expires_at has passed';
  }
  return null;
}

/**
 * True when frontmatter restricts access: private: true, visibility: private, ai_access: false,
 * personal_data: true, classification confidential/restricted, an expired or malformed expires_at,
 * or any of these flags present with the wrong type.
 */
export function isPrivateFrontmatter(data: Record<string, unknown> | null): boolean {
  return frontmatterAccessRestriction(data) !== null;
}

/** Reads an optional numeric limit that may not be present in older configurations. */
function limitOrDefault(limits: Project['config']['limits'], key: string, fallback: number): number {
  const value = (limits as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Defaults for traversal limits until the configuration schema supplies them. */
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 50_000;
export const DEFAULT_MAX_DEPTH = 32;

/** Decodes raw note bytes strictly; rejects NUL bytes and invalid UTF-8. */
export function decodeNoteBytes(raw: Uint8Array, label: string): string {
  if (raw.includes(0)) throw new VaultError('BINARY_FILE', `${label} contains NUL bytes and is not a text note`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new VaultError('INVALID_ENCODING', `${label} is not valid UTF-8`);
  }
}

/**
 * Lists note ids under all configured notes roots. Hidden, policy-excluded and config-excluded
 * paths and links are never returned; private notes are listed (readNoteFile rejects them).
 *
 * Directories are streamed with fs.opendir so a huge directory never materialises as one array.
 * Every entry seen (files of any type, directories, links) counts towards `maxDirectoryEntries`
 * across all roots, and directory nesting is checked against `maxDepth` before a directory is
 * queued. Both limits fail closed with LIMIT_EXCEEDED, after closing the open directory handle.
 */
export async function listNoteIds(project: Project): Promise<string[]> {
  const ids: string[] = [];
  const limits = project.config.limits;
  const maxFiles = limits.maxFiles;
  const maxEntries = limitOrDefault(limits, 'maxDirectoryEntries', DEFAULT_MAX_DIRECTORY_ENTRIES);
  const maxDepth = limitOrDefault(limits, 'maxDepth', DEFAULT_MAX_DEPTH);
  let seenEntries = 0;
  for (const root of project.config.notesRoots) {
    let rootReal: string;
    try {
      rootReal = await realRootPath(project, root.path);
    } catch (error) {
      throw new VaultError('IO_ERROR', `Notes root "${root.id}" is not accessible (${ioCode(error)})`);
    }
    const pending: string[][] = [[]];
    while (pending.length > 0) {
      const segments = pending.pop()!;
      const dirPath = path.join(rootReal, ...segments);
      let dir: Dir;
      try {
        dir = await fs.opendir(dirPath);
      } catch (error) {
        throw new VaultError('IO_ERROR', `Failed to read directory in notes root "${root.id}" (${ioCode(error)})`);
      }
      try {
        for (;;) {
          let entry: Dirent | null;
          try {
            entry = await dir.read();
          } catch (error) {
            throw new VaultError('IO_ERROR', `Failed to read directory in notes root "${root.id}" (${ioCode(error)})`);
          }
          if (entry === null) break;
          seenEntries++;
          if (seenEntries > maxEntries) {
            throw new VaultError('LIMIT_EXCEEDED', `Notes roots contain more than maxDirectoryEntries (${maxEntries}) directory entries`);
          }
          if (entry.isSymbolicLink()) continue;
          const childSegments = [...segments, entry.name];
          if (entry.isDirectory()) {
            if (isDirectoryExcluded(project, root.id, childSegments)) continue;
            if (childSegments.length > maxDepth) {
              throw new VaultError('LIMIT_EXCEEDED', `Notes root "${root.id}" nests directories deeper than maxDepth (${maxDepth})`);
            }
            pending.push(childSegments);
            continue;
          }
          if (!entry.isFile()) continue;
          const relativePath = childSegments.join('/');
          const noteId = `${root.id}/${relativePath}`;
          const split = splitNoteId(noteId);
          if (!split.ok) continue;
          if (entry.name.startsWith('.')) continue;
          if (matchesConfiguredExclude(project, root.id, relativePath)) continue;
          ids.push(noteId);
          if (ids.length > maxFiles) {
            throw new VaultError('LIMIT_EXCEEDED', `Notes roots contain more than maxFiles (${maxFiles}) markdown files`);
          }
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    }
  }
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids;
}

/** Reads raw bytes of a resolved note path with the configured size bound. */
export async function readBoundedBytes(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    const code = ioCode(error);
    if (code === 'ENOENT') throw new VaultError('NOT_FOUND', `${label} does not exist`);
    throw new VaultError('IO_ERROR', `Failed to open ${label} (${code})`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new VaultError('NOT_FOUND', `${label} is not a regular file`);
    if (stat.size > maxBytes) throw new VaultError('FILE_TOO_LARGE', `${label} exceeds maxFileBytes (${maxBytes})`);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new VaultError('FILE_TOO_LARGE', `${label} exceeds maxFileBytes (${maxBytes})`);
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('IO_ERROR', `Failed to read ${label} (${ioCode(error)})`);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a note, enforcing containment, size, encoding and frontmatter policy. The revision is the
 * SHA-256 of the raw bytes; the content is returned without BOM and with LF newlines.
 */
export async function readNoteFile(project: Project, noteId: string): Promise<NoteFile> {
  const filePath = await resolveNote(project, noteId, false);
  const raw = await readBoundedBytes(filePath, project.config.limits.maxFileBytes, 'Note');
  const text = decodeNoteBytes(raw, 'Note');
  const content = normalizeText(text);
  const frontmatter = parseFrontmatter(content);
  const restriction = frontmatterAccessRestriction(frontmatter);
  if (restriction !== null) {
    throw new VaultError('PRIVATE_NOTE', `Note "${noteId}" is access restricted by its frontmatter (${restriction}) and cannot be read`);
  }
  assertContentPolicy(project, content);
  return { noteId, content, revision: sha256Hex(raw), bytes: raw.length };
}
