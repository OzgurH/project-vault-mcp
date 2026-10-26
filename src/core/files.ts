import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { VaultError } from './errors.js';
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

/** True when frontmatter marks the note as private (private: true or visibility: private). */
export function isPrivateFrontmatter(data: Record<string, unknown> | null): boolean {
  if (!data) return false;
  if (data['private'] === true) return true;
  const visibility = data['visibility'];
  return typeof visibility === 'string' && visibility.trim().toLowerCase() === 'private';
}

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
 */
export async function listNoteIds(project: Project): Promise<string[]> {
  const ids: string[] = [];
  const maxFiles = project.config.limits.maxFiles;
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
      const dir = path.join(rootReal, ...segments);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        throw new VaultError('IO_ERROR', `Failed to read directory in notes root "${root.id}" (${ioCode(error)})`);
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childSegments = [...segments, entry.name];
        if (entry.isDirectory()) {
          if (!isDirectoryExcluded(project, root.id, childSegments)) pending.push(childSegments);
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
  if (isPrivateFrontmatter(frontmatter)) {
    throw new VaultError('PRIVATE_NOTE', `Note "${noteId}" is marked private and cannot be read`);
  }
  return { noteId, content, revision: sha256Hex(raw), bytes: raw.length };
}
