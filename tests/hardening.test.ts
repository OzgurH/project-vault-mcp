import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfig, loadProject } from '../src/core/config.js';
import { readNoteFile } from '../src/core/files.js';
import { lockPathFor, writeNote } from '../src/core/writes.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(maxFileBytes = 1024) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-hardening-')));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  const config = defaultConfig('Hardening');
  config.allowWrites = true;
  config.limits.maxFileBytes = maxFileBytes;
  await writeFile(join(root, 'project-vault.json'), JSON.stringify(config));
  await writeFile(join(root, 'docs/index.md'), '# Old\r\n');
  return loadProject(root);
}

describe('integration security boundaries', () => {
  it('uses the same cooperating-writer lock when clients use different temporary directories', async () => {
    const project = await fixture();
    const target = join(project.root, 'docs/index.md');
    const expected = lockPathFor(target);
    vi.spyOn(os, 'tmpdir').mockReturnValue(join(project.root, 'client-specific-temp'));
    expect(lockPathFor(target)).toBe(expected);
  });

  it('rechecks an editor save that occurs while the replacement file is being flushed', async () => {
    const project = await fixture();
    const target = join(project.root, 'docs/index.md');
    const note = await readNoteFile(project, 'docs/index.md');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).includes('.pv-tmp-')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          await writeFile(target, '# External editor save\n');
        };
      }
      return handle;
    });
    await expect(writeNote(project, 'docs/index.md', '# Server update\n', { expectedRevision: note.revision, dryRun: false }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('# External editor save\n');
  });

  it('never steals even a dead-looking lock because owner replacement is not transactional', async () => {
    const project = await fixture();
    const target = join(project.root, 'docs/index.md');
    const lockPath = lockPathFor(target);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00Z' }), { flag: 'wx' });
    const oldTimeout = process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS;
    process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS = '0';
    try {
      const note = await readNoteFile(project, 'docs/index.md');
      await expect(writeNote(project, 'docs/index.md', '# New\n', { expectedRevision: note.revision, dryRun: false }))
        .rejects.toMatchObject({ code: 'LOCK_BUSY' });
      expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(2147483647);
    } finally {
      if (oldTimeout === undefined) delete process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS;
      else process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS = oldTimeout;
      await rm(lockPath, { force: true });
    }
  });

  it('applies the byte limit after restoring CRLF rather than creating an unreadable note', async () => {
    const project = await fixture(16);
    const note = await readNoteFile(project, 'docs/index.md');
    const content = 'a\nb\nc\nd\ne\nf\ng\n';
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(16);
    await expect(writeNote(project, 'docs/index.md', content, { expectedRevision: note.revision, dryRun: false }))
      .rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
    expect(await readFile(join(project.root, 'docs/index.md'), 'utf8')).toBe('# Old\r\n');
  });

  it('revalidates a configured root replaced by an external junction after startup', async () => {
    const project = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-outside-')));
    roots.push(outside);
    await writeFile(join(outside, 'index.md'), '# Outside private data\n');
    await rename(join(project.root, 'docs'), join(project.root, 'original-docs'));
    await symlink(outside, join(project.root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readNoteFile(project, 'docs/index.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('does not allow a hidden directory to become a public note root', async () => {
    const project = await fixture();
    await mkdir(join(project.root, '.private'));
    const config = defaultConfig('Hidden root');
    config.notesRoots = [{ id: 'docs', path: '.private' }];
    await writeFile(project.configPath, JSON.stringify(config));
    await expect(loadProject(project.root)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
