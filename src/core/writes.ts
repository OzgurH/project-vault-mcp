import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultError } from './errors.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, applyFileSecurity, captureFileSecurity, verifyBeforeReplace, type FileSecurity } from './file-security.js';
import { decodeNoteBytes, isPrivateFrontmatter, normalizeText, parseFrontmatter, readBoundedBytes, sha256Hex } from './files.js';
import { resolveNote } from './paths.js';
import { assertContentPolicy } from './content-policy.js';
import type { Project, WriteOptions, WriteResult } from './types.js';

/**
 * Threat model: cooperating Project Vault processes on a trusted local account serialize through
 * these locks. External editors do not honor them; the revision check inside the lock narrows but
 * cannot eliminate the race with an external editor that writes between read_note and update.
 */

const LOCK_DIR_NAME = '.project-vault-mcp';
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const MAX_LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 25;
const RENAME_RETRIES = 8;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Returns the lock file path for a canonical target path. Exported for cooperating tooling and tests. */
export function lockPathFor(targetPath: string): string {
  const key = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const hash = createHash('sha256').update(key).digest('hex');
  // The OS account home is stable across clients with different TMP/TEMP environments.
  return path.join(os.userInfo().homedir, LOCK_DIR_NAME, 'locks', `${hash}.lock`);
}

function ioCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'EIO';
}

function lockTimeoutMs(): number {
  const raw = process.env['PROJECT_VAULT_LOCK_TIMEOUT_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOCK_TIMEOUT_MS;
  return Math.min(parsed, MAX_LOCK_TIMEOUT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Lock { release: () => Promise<void> }

/**
 * Acquires an exclusive lock file. Even a dead-looking lock fails closed: inspecting an owner
 * and renaming the pathname is not transactional with another waiter's replacement.
 */
async function acquireLock(lockPath: string, noteId: string): Promise<Lock> {
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    throw new VaultError('IO_ERROR', `Failed to create lock directory (${ioCode(error)})`);
  }
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', PRIVATE_FILE_MODE);
      // The lock names only its owner; note identifiers never leave the project directory.
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      return {
        release: async () => {
          await handle.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      if (ioCode(error) !== 'EEXIST') throw new VaultError('IO_ERROR', `Failed to create lock file (${ioCode(error)})`);
    }
    if (Date.now() >= deadline) {
      throw new VaultError('LOCK_BUSY', `Another writer currently holds the lock for "${noteId}"; retry later`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

interface ExistingState { raw: Buffer; revision: string; hasBom: boolean; crlf: boolean }

async function readExisting(targetPath: string, project: Project, noteId: string): Promise<ExistingState | null> {
  let raw: Buffer;
  try {
    raw = await readBoundedBytes(targetPath, project.config.limits.maxFileBytes, 'Note');
  } catch (error) {
    if (error instanceof VaultError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
  const text = decodeNoteBytes(raw, 'Note');
  const normalized = normalizeText(text);
  if (isPrivateFrontmatter(parseFrontmatter(normalized))) {
    throw new VaultError('PRIVATE_NOTE', `Note "${noteId}" is marked private and cannot be modified through this tool`);
  }
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfCount = (text.match(/\n/g) ?? []).length;
  const crlf = crlfCount > 0 && crlfCount * 2 >= lfCount;
  return { raw, revision: sha256Hex(raw), hasBom, crlf };
}

function validateContent(project: Project, content: unknown): string {
  if (typeof content !== 'string') throw new VaultError('INVALID_CONTENT', 'Note content must be a string');
  if (content.includes('\u0000')) throw new VaultError('INVALID_CONTENT', 'Note content must not contain NUL characters');
  if (LONE_SURROGATE.test(content)) throw new VaultError('INVALID_CONTENT', 'Note content must be well-formed Unicode text');
  const normalized = normalizeText(content);
  assertContentPolicy(project, normalized);
  if (Buffer.byteLength(normalized, 'utf8') > project.config.limits.maxFileBytes) {
    throw new VaultError('CONTENT_TOO_LARGE', `Note content exceeds maxFileBytes (${project.config.limits.maxFileBytes})`);
  }
  if (isPrivateFrontmatter(parseFrontmatter(normalized))) {
    throw new VaultError('PRIVATE_NOTE', 'Private notes cannot be created or updated through this tool');
  }
  return normalized;
}

function encodeOutput(normalized: string, existing: ExistingState | null, maxBytes: number): Buffer {
  const text = existing?.crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
  const body = Buffer.from(text, 'utf8');
  const bytes = existing?.hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
  if (bytes.length > maxBytes) throw new VaultError('CONTENT_TOO_LARGE', 'Encoded note exceeds maxFileBytes after preserving its newline style and BOM');
  return bytes;
}

function checkPrecondition(noteId: string, expectedRevision: string | null, existing: ExistingState | null): void {
  if (expectedRevision === null) {
    if (existing) throw new VaultError('NOTE_EXISTS', `Note "${noteId}" already exists; use an update with its current revision`);
    return;
  }
  if (!existing) throw new VaultError('NOT_FOUND', `Note "${noteId}" does not exist; use a create with expectedRevision null`);
  if (existing.revision !== expectedRevision) {
    throw new VaultError('REVISION_CONFLICT', `Note "${noteId}" changed since it was read; re-read it and retry with the current revision`);
  }
}

/** Creates the staging file exclusively with owner-only permissions; the caller owns the handle. */
async function openTemp(tempPath: string): Promise<fs.FileHandle> {
  try {
    return await fs.open(tempPath, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    throw new VaultError('IO_ERROR', `Failed to create temporary note file (${ioCode(error)})`);
  }
}

async function flushTemp(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    throw new VaultError('IO_ERROR', `Failed to write temporary note file (${ioCode(error)})`);
  }
}

async function replaceWithRetries(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error) {
      const code = ioCode(error);
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= RENAME_RETRIES) {
        throw new VaultError('IO_ERROR', `Failed to replace note atomically (${code}); the existing note was left unchanged`);
      }
      await sleep(20 * (attempt + 1));
    }
  }
}

async function createExclusively(tempPath: string, targetPath: string): Promise<void> {
  try {
    await fs.link(tempPath, targetPath);
    return;
  } catch (error) {
    const code = ioCode(error);
    if (code === 'EEXIST') throw new VaultError('NOTE_EXISTS', 'Note was created concurrently; re-read and retry with an update');
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EXDEV') {
      throw new VaultError('IO_ERROR', `Failed to create note (${code})`);
    }
  }
  // Filesystems without hard links: exclusive create, then remove the partial target on failure.
  let handle;
  try {
    handle = await fs.open(targetPath, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    const code = ioCode(error);
    if (code === 'EEXIST') throw new VaultError('NOTE_EXISTS', 'Note was created concurrently; re-read and retry with an update');
    throw new VaultError('IO_ERROR', `Failed to create note (${code})`);
  }
  try {
    await handle.writeFile(await fs.readFile(tempPath));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(targetPath).catch(() => undefined);
    throw new VaultError('IO_ERROR', `Failed to write new note (${ioCode(error)})`);
  }
  await handle.close();
}

/**
 * Creates (expectedRevision null) or updates (expectedRevision = exact SHA-256 of current bytes)
 * a note. dryRun defaults to true and touches nothing on disk. Applied writes serialize through an
 * exclusive lock outside the vault, re-read the target inside the lock, re-check the revision and
 * replace the file through a same-directory temp file. Nothing is ever truncated in place.
 *
 * Security metadata: staging files, lock files and newly created notes are owner-only (0600) on
 * POSIX; lock directories are 0700. Updates preserve the existing note's mode, owner and group
 * (POSIX) or owner, group and DACL (Windows) on the replacement and fail closed with
 * SECURITY_METADATA when that cannot be verified. New notes on Windows inherit the folder ACL.
 */
export async function writeNote(project: Project, noteId: string, content: string, options: WriteOptions): Promise<WriteResult> {
  if (!project.config.allowWrites) {
    throw new VaultError('WRITES_DISABLED', 'Writes are disabled: set allowWrites to true in project-vault.json and start the server with --allow-write');
  }
  if (!options || (options.expectedRevision !== null && typeof options.expectedRevision !== 'string')) {
    throw new VaultError('INVALID_REVISION', 'expectedRevision must be null for create or the current revision string for update');
  }
  const expectedRevision = options.expectedRevision;
  if (expectedRevision !== null && !/^[0-9a-f]{64}$/.test(expectedRevision)) {
    throw new VaultError('INVALID_REVISION', 'expectedRevision must be a lowercase hexadecimal SHA-256 digest');
  }
  const dryRun = options.dryRun ?? true;
  const normalized = validateContent(project, content);
  const isCreate = expectedRevision === null;
  const targetPath = await resolveNote(project, noteId, isCreate);

  if (dryRun) {
    const existing = await readExisting(targetPath, project, noteId);
    checkPrecondition(noteId, expectedRevision, existing);
    const bytes = encodeOutput(normalized, existing, project.config.limits.maxFileBytes);
    return {
      noteId,
      applied: false,
      created: existing === null,
      previousRevision: existing?.revision ?? null,
      revision: sha256Hex(bytes),
      bytes: bytes.length,
    };
  }

  const lock = await acquireLock(lockPathFor(targetPath), noteId);
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.pv-tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let tempCreated = false;
  let tempHandle: fs.FileHandle | null = null;
  try {
    // Re-resolve and re-read inside the lock so the revision check reflects the latest bytes.
    await resolveNote(project, noteId, isCreate);
    const existing = await readExisting(targetPath, project, noteId);
    checkPrecondition(noteId, expectedRevision, existing);
    const bytes = encodeOutput(normalized, existing, project.config.limits.maxFileBytes);
    // An update must not widen access: capture the note's security metadata before staging anything.
    const security: FileSecurity | null = existing ? await captureFileSecurity(targetPath) : null;
    tempHandle = await openTemp(tempPath);
    tempCreated = true;
    // Windows ACLs are inherited from the folder at creation; restore the note's own DACL before
    // any note bytes reach the staging file. POSIX staging stays owner-only until just before install.
    if (security?.kind === 'windows') await applyFileSecurity(tempHandle, tempPath, security);
    await flushTemp(tempHandle, bytes);
    // Flushing the replacement may take time; detect editor saves observed after that flush too.
    await resolveNote(project, noteId, isCreate);
    checkPrecondition(noteId, expectedRevision, await readExisting(targetPath, project, noteId));
    if (security) {
      if (security.kind === 'posix') await applyFileSecurity(tempHandle, tempPath, security);
      // Revalidate like the revision: staging must carry the metadata and the target must not have changed.
      await verifyBeforeReplace(tempPath, targetPath, security, tempHandle);
    }
    await tempHandle.close();
    tempHandle = null;
    if (existing) {
      await replaceWithRetries(tempPath, targetPath);
      tempCreated = false;
    } else {
      await createExclusively(tempPath, targetPath);
    }
    return {
      noteId,
      applied: true,
      created: existing === null,
      previousRevision: existing?.revision ?? null,
      revision: sha256Hex(bytes),
      bytes: bytes.length,
    };
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => undefined);
    if (tempCreated) await fs.unlink(tempPath).catch(() => undefined);
    await lock.release();
  }
}
