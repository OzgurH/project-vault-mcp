import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadProject } from '../src/core/config.js';
import { resolveNote, resolveSource } from '../src/core/paths.js';
import { listNoteIds, readNoteFile } from '../src/core/files.js';
import { lockPathFor, writeNote } from '../src/core/writes.js';
import { VaultError } from '../src/core/errors.js';
import type { Project, VaultConfig } from '../src/core/types.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

let tmpBase: string;
let projectDir: string;

async function makeTempBase(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-storage-'));
  return realpathSync.native(dir);
}

async function writeConfig(dir: string, config: Partial<VaultConfig> & Record<string, unknown>): Promise<string> {
  const file = path.join(dir, 'project-vault.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, name: 'test', ...config }), 'utf8');
  return file;
}

async function setupProject(extra: Partial<VaultConfig> & Record<string, unknown> = {}): Promise<Project> {
  await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'docs', 'index.md'), '# Index\n', 'utf8');
  await writeConfig(projectDir, extra);
  return loadProject(projectDir);
}

async function expectVaultError(promise: Promise<unknown>, code: string): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VaultError);
    const vaultError = error as VaultError;
    expect(vaultError.code).toBe(code);
    return vaultError;
  }
  throw new Error(`Expected VaultError ${code} but the call succeeded`);
}

beforeEach(async () => {
  tmpBase = await makeTempBase();
  projectDir = path.join(tmpBase, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 5 });
});

describe('defaultConfig', () => {
  it('returns documented defaults', () => {
    const config = defaultConfig('demo');
    expect(config).toEqual({
      schemaVersion: 1,
      name: 'demo',
      notesRoots: [{ id: 'docs', path: 'docs' }],
      entryNotes: ['docs/index.md'],
      exclude: [],
      sourceRoots: [],
      searchLocale: 'default',
      allowWrites: false,
      limits: {
        maxFiles: 5000,
        maxFileBytes: 1048576,
        maxTotalBytes: 52428800,
        maxResponseChars: 20000,
        maxQueryChars: 500,
        rescanIntervalMs: 1000,
      },
    });
  });
});

describe('loadProject', () => {
  it('fills defaults and returns canonical absolute paths', async () => {
    const project = await setupProject();
    expect(path.isAbsolute(project.root)).toBe(true);
    expect(project.root).toBe(projectDir);
    expect(project.configPath).toBe(path.join(projectDir, 'project-vault.json'));
    expect(project.config.allowWrites).toBe(false);
    expect(project.config.limits.maxFiles).toBe(5000);
    expect(project.config.notesRoots).toEqual([{ id: 'docs', path: 'docs' }]);
  });

  it('accepts a direct config file path', async () => {
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    const file = await writeConfig(projectDir, {});
    const project = await loadProject(file);
    expect(project.root).toBe(projectDir);
  });

  it('rejects wrong schema version', async () => {
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    await writeConfig(projectDir, { schemaVersion: 2 });
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
  });

  it('rejects malformed JSON and oversized config files', async () => {
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    const file = path.join(projectDir, 'project-vault.json');
    await fs.writeFile(file, '{ not json', 'utf8');
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, name: 'x'.repeat(70000) }), 'utf8');
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
  });

  it('rejects invalid limits, ids, paths and missing roots', async () => {
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    const cases: Record<string, unknown>[] = [
      { limits: { maxFiles: 0 } },
      { limits: { maxFileBytes: -1 } },
      { limits: { maxFiles: Number.POSITIVE_INFINITY } },
      { limits: { maxFiles: 1.5 } },
      { notesRoots: [] },
      { notesRoots: [{ id: '', path: 'docs' }] },
      { notesRoots: [{ id: 'a/b', path: 'docs' }] },
      { notesRoots: [{ id: 'docs', path: '../outside' }] },
      { notesRoots: [{ id: 'docs', path: path.join(projectDir, 'docs') }] },
      { notesRoots: [{ id: 'docs', path: 'missing' }] },
      { notesRoots: [{ id: 'docs', path: 'docs' }, { id: 'docs', path: 'docs' }] },
      { notesRoots: [{ id: 'docs', path: 'docs' }, { id: 'other', path: 'docs' }] },
      { entryNotes: ['nope/index.md'] },
      { entryNotes: ['docs/../index.md'] },
      { searchLocale: 'xx' },
      { allowWrites: 'yes' },
      { sourceRoots: [{ id: 'src', path: 'src', include: [] }] },
    ];
    for (const extra of cases) {
      await writeConfig(projectDir, extra);
      await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
    }
  });

  it('rejects nested real roots', async () => {
    await fs.mkdir(path.join(projectDir, 'docs', 'inner'), { recursive: true });
    await writeConfig(projectDir, {
      notesRoots: [
        { id: 'docs', path: 'docs' },
        { id: 'inner', path: 'docs/inner' },
      ],
    });
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
  });

  it('rejects a config file that is a symbolic link', async () => {
    const realDir = path.join(tmpBase, 'elsewhere');
    await fs.mkdir(path.join(realDir, 'docs'), { recursive: true });
    const realFile = await writeConfig(realDir, {});
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    const linkPath = path.join(projectDir, 'project-vault.json');
    try {
      await fs.symlink(realFile, linkPath, 'file');
    } catch (error) {
      // File symlinks need elevated privileges on some Windows accounts; the junction tests cover escapes.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
  });

  it('rejects a notes root that is a junction escaping the project', async () => {
    const outside = path.join(tmpBase, 'outside-docs');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(projectDir, 'docs'), 'junction');
    await writeConfig(projectDir, {});
    await expectVaultError(loadProject(projectDir), 'INVALID_CONFIG');
  });
});

describe('resolveNote', () => {
  it('resolves a valid note id to the real absolute path', async () => {
    const project = await setupProject();
    const resolved = await resolveNote(project, 'docs/index.md');
    expect(resolved).toBe(path.join(projectDir, 'docs', 'index.md'));
  });

  it('rejects traversal, absolute, drive, UNC and alias forms', async () => {
    const project = await setupProject();
    const bad = [
      '',
      'index.md',
      'docs',
      'docs/',
      'docs/../project-vault.json',
      'docs/../../x.md',
      'docs/./index.md',
      'docs//index.md',
      '/docs/index.md',
      'C:/docs/index.md',
      'docs/C:/index.md',
      'docs\\index.md',
      '\\\\server\\share\\index.md',
      'docs/index.md:stream',
      'docs/index.md::$DATA',
      'docs/CON.md',
      'docs/nul',
      'docs/index.md.',
      'docs/index.md ',
      'docs/index .md',
      'docs/sub./index.md',
      'docs/index.txt',
      'docs/index.MD',
      'docs/in\u0000dex.md',
      'nope/index.md',
      'docs2/index.md',
    ];
    for (const id of bad) {
      await expect(resolveNote(project, id), `id ${JSON.stringify(id)}`).rejects.toBeInstanceOf(VaultError);
    }
  });

  it('rejects hidden, policy-excluded and config-excluded paths', async () => {
    const project = await setupProject({ exclude: ['docs/drafts/**', 'docs/*.draft.md'] });
    for (const dir of ['.obsidian', 'node_modules', 'dist', 'build', 'coverage', 'generated', 'templates', 'private', 'secrets', 'drafts']) {
      await fs.mkdir(path.join(projectDir, 'docs', dir), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'docs', dir, 'note.md'), '# hidden\n', 'utf8');
      await expectVaultError(resolveNote(project, `docs/${dir}/note.md`), 'PATH_EXCLUDED');
    }
    await fs.writeFile(path.join(projectDir, 'docs', '.env.md'), 'SECRET=1\n', 'utf8');
    await expectVaultError(resolveNote(project, 'docs/.env.md'), 'PATH_EXCLUDED');
    await fs.writeFile(path.join(projectDir, 'docs', 'x.draft.md'), '# draft\n', 'utf8');
    await expectVaultError(resolveNote(project, 'docs/x.draft.md'), 'PATH_EXCLUDED');
    await expectVaultError(resolveNote(project, 'docs/Private/note.md'), 'PATH_EXCLUDED');
    // Case aliases must not bypass configured excludes on case-insensitive filesystems.
    await expectVaultError(resolveNote(project, 'docs/Drafts/note.md'), 'PATH_EXCLUDED');
    await expectVaultError(resolveNote(project, 'docs/X.DRAFT.md'), 'PATH_EXCLUDED');
  });

  it('rejects junction escapes in the target and its ancestors', async () => {
    const project = await setupProject();
    const outside = path.join(tmpBase, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'leak.md'), '# leak\n', 'utf8');
    await fs.symlink(outside, path.join(projectDir, 'docs', 'linked'), 'junction');
    await expectVaultError(resolveNote(project, 'docs/linked/leak.md'), 'PATH_ESCAPE');
    await expectVaultError(resolveNote(project, 'docs/linked/new.md', true), 'PATH_ESCAPE');
    // A junction that stays inside the project but points to another location is still a reparse point.
    await fs.mkdir(path.join(projectDir, 'other'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'other', 'n.md'), '# n\n', 'utf8');
    await fs.symlink(path.join(projectDir, 'other'), path.join(projectDir, 'docs', 'inside'), 'junction');
    await expectVaultError(resolveNote(project, 'docs/inside/n.md'), 'PATH_ESCAPE');
  });

  it('allows a missing target only with allowMissing and an existing safe parent', async () => {
    const project = await setupProject();
    await expectVaultError(resolveNote(project, 'docs/new.md'), 'NOT_FOUND');
    const created = await resolveNote(project, 'docs/new.md', true);
    expect(created).toBe(path.join(projectDir, 'docs', 'new.md'));
    await expectVaultError(resolveNote(project, 'docs/missing-dir/new.md', true), 'NOT_FOUND');
    await fs.mkdir(path.join(projectDir, 'docs', 'adir.md'));
    await expectVaultError(resolveNote(project, 'docs/adir.md'), 'NOT_FOUND');
  });

  it('resolves sources with include globs and never escapes', async () => {
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'src', 'a.js'), 'x', 'utf8');
    const project = await setupProject({ sourceRoots: [{ id: 'src', path: 'src', include: ['**/*.ts'] }] });
    expect(await resolveSource(project, 'src', 'a.ts')).toBe(path.join(projectDir, 'src', 'a.ts'));
    await expectVaultError(resolveSource(project, 'src', 'a.js'), 'PATH_EXCLUDED');
    await expectVaultError(resolveSource(project, 'src', '../docs/index.md'), 'INVALID_PATH');
    await expectVaultError(resolveSource(project, 'docs', 'index.md'), 'INVALID_PATH');
    await expectVaultError(resolveSource(project, 'src', 'node_modules/x.ts'), 'PATH_EXCLUDED');
  });
});

describe('listNoteIds and readNoteFile', () => {
  it('lists markdown notes excluding hidden, policy and config-excluded files but including private notes', async () => {
    const project = await setupProject({ exclude: ['docs/skip/**'] });
    const docs = path.join(projectDir, 'docs');
    await fs.mkdir(path.join(docs, 'adr'), { recursive: true });
    await fs.mkdir(path.join(docs, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(docs, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(docs, 'skip'), { recursive: true });
    await fs.writeFile(path.join(docs, 'adr', '0001-ünïcode.md'), '# ADR\n', 'utf8');
    await fs.writeFile(path.join(docs, 'private.md'), '---\nprivate: true\n---\n# secret\n', 'utf8');
    await fs.writeFile(path.join(docs, '.hidden.md'), '# hidden\n', 'utf8');
    await fs.writeFile(path.join(docs, '.obsidian', 'x.md'), '# x\n', 'utf8');
    await fs.writeFile(path.join(docs, 'node_modules', 'x.md'), '# x\n', 'utf8');
    await fs.writeFile(path.join(docs, 'skip', 'x.md'), '# x\n', 'utf8');
    await fs.writeFile(path.join(docs, 'notes.txt'), 'text', 'utf8');
    const outside = path.join(tmpBase, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'leak.md'), '# leak\n', 'utf8');
    await fs.symlink(outside, path.join(docs, 'junction'), 'junction');
    const ids = await listNoteIds(project);
    expect(ids).toEqual(['docs/adr/0001-ünïcode.md', 'docs/index.md', 'docs/private.md']);
  });

  it('enforces maxFiles during scan and surfaces I/O failures', async () => {
    const project = await setupProject({ limits: { maxFiles: 1 } });
    await fs.writeFile(path.join(projectDir, 'docs', 'two.md'), '# two\n', 'utf8');
    await expectVaultError(listNoteIds(project), 'LIMIT_EXCEEDED');
    const healthy = await setupProject();
    await fs.rm(path.join(projectDir, 'docs'), { recursive: true, force: true });
    await expect(listNoteIds(healthy)).rejects.toBeInstanceOf(VaultError);
  });

  it('reads UTF-8 with BOM and CRLF, normalizing content but hashing raw bytes', async () => {
    const project = await setupProject();
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Başlık\r\n\r\nSatır\r\n', 'utf8')]);
    await fs.writeFile(path.join(projectDir, 'docs', 'crlf.md'), raw);
    const note = await readNoteFile(project, 'docs/crlf.md');
    expect(note.noteId).toBe('docs/crlf.md');
    expect(note.content).toBe('# Başlık\n\nSatır\n');
    expect(note.revision).toBe(sha256(raw));
    expect(note.bytes).toBe(raw.length);
  });

  it('rejects binary, invalid UTF-8 and oversized files', async () => {
    const project = await setupProject({ limits: { maxFileBytes: 64 } });
    const docs = path.join(projectDir, 'docs');
    await fs.writeFile(path.join(docs, 'binary.md'), Buffer.from([0x23, 0x20, 0x00, 0x41]));
    await expectVaultError(readNoteFile(project, 'docs/binary.md'), 'BINARY_FILE');
    await fs.writeFile(path.join(docs, 'bad.md'), Buffer.from([0x23, 0xff, 0xfe, 0x41]));
    await expectVaultError(readNoteFile(project, 'docs/bad.md'), 'INVALID_ENCODING');
    await fs.writeFile(path.join(docs, 'big.md'), '#'.repeat(65), 'utf8');
    await expectVaultError(readNoteFile(project, 'docs/big.md'), 'FILE_TOO_LARGE');
    await expectVaultError(readNoteFile(project, 'docs/absent.md'), 'NOT_FOUND');
  });

  it('rejects private notes and malformed frontmatter with typed errors', async () => {
    const project = await setupProject();
    const docs = path.join(projectDir, 'docs');
    await fs.writeFile(path.join(docs, 'p1.md'), '---\nprivate: true\n---\n# s\n', 'utf8');
    await fs.writeFile(path.join(docs, 'p2.md'), '\ufeff---\r\nvisibility: private\r\n---\r\n# s\r\n', 'utf8');
    await fs.writeFile(path.join(docs, 'p3.md'), '---\nprivate: false\nvisibility: public\n---\n# ok\n', 'utf8');
    await fs.writeFile(path.join(docs, 'bad.md'), '---\ntitle: [unclosed\n---\n# s\n', 'utf8');
    await fs.writeFile(path.join(docs, 'tag.md'), '---\nx: !!js/function "function(){}"\n---\n# s\n', 'utf8');
    await fs.writeFile(path.join(docs, 'alias.md'), '---\na: &a [1,2]\nb: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nd: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\ne: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nf: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\ng: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nh: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\ni: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nj: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nk: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nl: [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n---\n# s\n', 'utf8');
    const p1 = await expectVaultError(readNoteFile(project, 'docs/p1.md'), 'PRIVATE_NOTE');
    expect(p1.message).not.toContain('# s');
    await expectVaultError(readNoteFile(project, 'docs/p2.md'), 'PRIVATE_NOTE');
    expect((await readNoteFile(project, 'docs/p3.md')).content).toContain('# ok');
    await expectVaultError(readNoteFile(project, 'docs/bad.md'), 'INVALID_FRONTMATTER');
    await expectVaultError(readNoteFile(project, 'docs/tag.md'), 'INVALID_FRONTMATTER');
    await expectVaultError(readNoteFile(project, 'docs/alias.md'), 'INVALID_FRONTMATTER');
  });
});

describe('writeNote', () => {
  it('refuses writes when the configuration disables them', async () => {
    const project = await setupProject();
    await expectVaultError(writeNote(project, 'docs/new.md', '# New\n', { expectedRevision: null, dryRun: false }), 'WRITES_DISABLED');
    await expectVaultError(writeNote(project, 'docs/new.md', '# New\n', { expectedRevision: null }), 'WRITES_DISABLED');
  });

  it('dry run by default previews without creating lock, temp or target', async () => {
    const project = await setupProject({ allowWrites: true });
    const target = path.join(projectDir, 'docs', 'new.md');
    const result = await writeNote(project, 'docs/new.md', '# New\r\nBody\r\n', { expectedRevision: null });
    expect(result).toEqual({
      noteId: 'docs/new.md',
      applied: false,
      created: true,
      previousRevision: null,
      revision: sha256('# New\nBody\n'),
      bytes: Buffer.byteLength('# New\nBody\n'),
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(lockPathFor(target))).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await fs.readdir(path.join(projectDir, 'docs'));
    expect(entries).toEqual(['index.md']);
    await expectVaultError(writeNote(project, 'docs/nested/new.md', '# New\n', { expectedRevision: null }), 'NOT_FOUND');
  });

  it('creates new files with LF and no BOM and refuses to create over an existing note', async () => {
    const project = await setupProject({ allowWrites: true });
    const result = await writeNote(project, 'docs/created.md', '\ufeff# Yeni\r\nİçerik\r\n', { expectedRevision: null, dryRun: false });
    const raw = await fs.readFile(path.join(projectDir, 'docs', 'created.md'));
    expect(raw.toString('utf8')).toBe('# Yeni\nİçerik\n');
    expect(result).toEqual({
      noteId: 'docs/created.md',
      applied: true,
      created: true,
      previousRevision: null,
      revision: sha256(raw),
      bytes: raw.length,
    });
    await expectVaultError(writeNote(project, 'docs/created.md', '# Again\n', { expectedRevision: null, dryRun: false }), 'NOTE_EXISTS');
    await expectVaultError(writeNote(project, 'docs/created.md', '# Again\n', { expectedRevision: null }), 'NOTE_EXISTS');
    expect(await fs.readdir(path.join(projectDir, 'docs'))).toEqual(['created.md', 'index.md']);
  });

  it('updates with exact revision, preserving BOM, CRLF and unknown frontmatter', async () => {
    const project = await setupProject({ allowWrites: true });
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\r\ncustom: keep\r\n---\r\n# Old\r\n', 'utf8')]);
    const target = path.join(projectDir, 'docs', 'upd.md');
    await fs.writeFile(target, original);
    const note = await readNoteFile(project, 'docs/upd.md');
    const newContent = '---\ncustom: keep\nstatus: accepted\n---\n# New\nLine\n';
    const result = await writeNote(project, 'docs/upd.md', newContent, { expectedRevision: note.revision, dryRun: false });
    const raw = await fs.readFile(target);
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(raw.subarray(3).toString('utf8')).toBe('---\r\ncustom: keep\r\nstatus: accepted\r\n---\r\n# New\r\nLine\r\n');
    expect(result).toEqual({
      noteId: 'docs/upd.md',
      applied: true,
      created: false,
      previousRevision: note.revision,
      revision: sha256(raw),
      bytes: raw.length,
    });
    expect((await readNoteFile(project, 'docs/upd.md')).revision).toBe(result.revision);
  });

  it('rejects stale revisions, missing update targets and private or oversized content', async () => {
    const project = await setupProject({ allowWrites: true, limits: { maxFileBytes: 64 } });
    const target = path.join(projectDir, 'docs', 'index.md');
    const note = await readNoteFile(project, 'docs/index.md');
    await fs.writeFile(target, '# Edited externally\n', 'utf8');
    await expectVaultError(writeNote(project, 'docs/index.md', '# Mine\n', { expectedRevision: note.revision, dryRun: false }), 'REVISION_CONFLICT');
    expect(await fs.readFile(target, 'utf8')).toBe('# Edited externally\n');
    await expectVaultError(writeNote(project, 'docs/absent.md', '# x\n', { expectedRevision: note.revision, dryRun: false }), 'NOT_FOUND');
    const fresh = await readNoteFile(project, 'docs/index.md');
    await expectVaultError(writeNote(project, 'docs/index.md', '---\nprivate: true\n---\n# x\n', { expectedRevision: fresh.revision, dryRun: false }), 'PRIVATE_NOTE');
    await expectVaultError(writeNote(project, 'docs/index.md', '---\nvisibility: private\n---\n# x\n', { expectedRevision: fresh.revision }), 'PRIVATE_NOTE');
    await expectVaultError(writeNote(project, 'docs/index.md', '#'.repeat(65), { expectedRevision: fresh.revision }), 'CONTENT_TOO_LARGE');
    await expectVaultError(writeNote(project, 'docs/index.md', '# a\u0000b', { expectedRevision: fresh.revision }), 'INVALID_CONTENT');
    await expectVaultError(writeNote(project, 'docs/index.md', '---\nbad: [\n---\n', { expectedRevision: fresh.revision }), 'INVALID_FRONTMATTER');
    // Existing private notes cannot be overwritten through the tool, even with the right revision.
    await fs.writeFile(path.join(projectDir, 'docs', 'secret.md'), '---\nprivate: true\n---\n# s\n', 'utf8');
    const secretRevision = sha256(await fs.readFile(path.join(projectDir, 'docs', 'secret.md')));
    await expectVaultError(writeNote(project, 'docs/secret.md', '# public now\n', { expectedRevision: secretRevision, dryRun: false }), 'PRIVATE_NOTE');
    await expectVaultError(writeNote(project, 'docs/.hidden.md', '# h\n', { expectedRevision: null, dryRun: false }), 'PATH_EXCLUDED');
    expect(await fs.readFile(target, 'utf8')).toBe('# Edited externally\n');
  });

  it('lets exactly one of two concurrent cooperating writers succeed', async () => {
    const project = await setupProject({ allowWrites: true });
    const note = await readNoteFile(project, 'docs/index.md');
    const results = await Promise.allSettled([
      writeNote(project, 'docs/index.md', '# Writer A\n', { expectedRevision: note.revision, dryRun: false }),
      writeNote(project, 'docs/index.md', '# Writer B\n', { expectedRevision: note.revision, dryRun: false }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as VaultError).code).toBe('REVISION_CONFLICT');
    const final = await fs.readFile(path.join(projectDir, 'docs', 'index.md'), 'utf8');
    expect(['# Writer A\n', '# Writer B\n']).toContain(final);
    expect(await fs.readdir(path.join(projectDir, 'docs'))).toEqual(['index.md']);
    await expect(fs.stat(lockPathFor(path.join(projectDir, 'docs', 'index.md')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns LOCK_BUSY when a live foreign lock holds the target and never steals it', async () => {
    const project = await setupProject({ allowWrites: true });
    const target = path.join(projectDir, 'docs', 'index.md');
    const lockPath = lockPathFor(target);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, target }), { flag: 'wx' });
    const previous = process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS;
    process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS = '200';
    try {
      const note = await readNoteFile(project, 'docs/index.md');
      await expectVaultError(writeNote(project, 'docs/index.md', '# Blocked\n', { expectedRevision: note.revision, dryRun: false }), 'LOCK_BUSY');
      expect(await fs.readFile(target, 'utf8')).toBe('# Index\n');
      await expect(fs.stat(lockPath)).resolves.toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS;
      else process.env.PROJECT_VAULT_LOCK_TIMEOUT_MS = previous;
      await fs.rm(lockPath, { force: true });
    }
  });
});
