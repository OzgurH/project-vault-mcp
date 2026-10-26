/**
 * Retrieval must never disclose note data whose authorization cannot be
 * re-established right now: a failed scan discards the whole cache, and every
 * search/context/links response re-reads the notes it is about to expose
 * through the storage policy, even inside the rescan interval.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadProject } from '../src/core/config.js';
import { KnowledgeBase, type StorageApi } from '../src/core/knowledge.js';
import type { NoteFile, Project } from '../src/core/types.js';

const SECRET = 'ORBITAL-LAUNCH-CODE-7731';
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FixtureOptions { rescanIntervalMs?: number; maxFiles?: number }

/** Real project on disk served through the real storage policy (no injected storage). */
async function realFixture(options: FixtureOptions = {}): Promise<Project> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-security-')));
  temporary.push(root);
  await mkdir(join(root, 'docs/sub'), { recursive: true });
  const config = defaultConfig('Security retrieval');
  config.limits.rescanIntervalMs = options.rescanIntervalMs ?? 0;
  if (options.maxFiles !== undefined) config.limits.maxFiles = options.maxFiles;
  await writeFile(join(root, 'project-vault.json'), JSON.stringify(config));
  await writeFile(join(root, 'docs/index.md'), '# Knowledge\n\nEntry note about rockets.\n\n[Launch](sub/launch.md#procedure)\n');
  await writeFile(join(root, 'docs/sub/launch.md'), `# Launch\n\n## Procedure\n\nThe rockets launch with ${SECRET} in the payload.\n\n[Home](../index.md)\n`);
  return loadProject(root);
}

function text(value: unknown): string {
  return JSON.stringify(value);
}

async function allResponses(kb: KnowledgeBase, topic: string): Promise<string> {
  const search = await kb.search(topic);
  const context = await kb.context(topic);
  const status = kb.status();
  return text({ search, context, status });
}

describe('failed discovery fails closed', () => {
  it('revokes expired notes inside a long rescan interval without any file change', async () => {
    const project = await realFixture({ rescanIntervalMs: 3600000 });
    const now = Date.UTC(2030, 0, 1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await writeFile(join(project.root, 'docs/sub/launch.md'), '---\nexpires_at: "2030-01-01T00:00:01Z"\n---\n# Launch\n\nrockets ' + SECRET);
    const kb = new KnowledgeBase(project);
    expect(text(await kb.search('rockets'))).toContain(SECRET);
    clock.mockReturnValue(now + 1000);
    expect(text(await kb.search('rockets'))).not.toContain(SECRET);
    expect(text(await kb.context('rockets'))).not.toContain(SECRET);
    await expect(kb.links('docs/sub/launch.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
  });

  it('discards the warm index when listing exceeds maxFiles and recovers once discovery succeeds again', async () => {
    const project = await realFixture({ maxFiles: 3 });
    const kb = new KnowledgeBase(project);
    const warm = await kb.search('rockets');
    expect(warm.map((hit) => hit.noteId)).toContain('docs/sub/launch.md');
    expect(text(warm)).toContain(SECRET);

    await writeFile(join(project.root, 'docs/extra-one.md'), '# Extra one\n');
    await writeFile(join(project.root, 'docs/extra-two.md'), '# Extra two\n');

    const exposed = await allResponses(kb, 'rockets');
    expect(exposed).not.toContain(SECRET);
    expect(exposed).not.toContain('launch.md');
    expect(await kb.search('rockets')).toEqual([]);
    expect((await kb.context('rockets')).excerpts).toEqual([]);
    await expect(kb.links('docs/sub/launch.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    const status = kb.status();
    expect(status).toMatchObject({ degraded: true, files: 0, bytes: 0, indexedAt: null });
    expect(status.diagnostics.map((d) => d.code)).toEqual(['SCAN_FAILED']);
    const check = await kb.check();
    expect(check.ok).toBe(false);
    expect(text(check)).not.toContain(SECRET);

    await unlink(join(project.root, 'docs/extra-one.md'));
    await unlink(join(project.root, 'docs/extra-two.md'));
    await kb.refresh(true);
    expect(kb.status()).toMatchObject({ degraded: false, files: 2, diagnostics: [] });
    expect(text(await kb.search('rockets'))).toContain(SECRET);
    expect((await kb.links('docs/sub/launch.md')).backlinks.map((b) => b.noteId)).toEqual(['docs/index.md']);
  });

  it('discards the warm index when an injected listing fails with any error and keeps compatibility with injected storage', async () => {
    const project = await realFixture();
    const { listNoteIds, readNoteFile, resolveNote, resolveSource, resolveAttachment } = await import('../src/core/files.js').then(async (files) => ({
      ...files,
      ...(await import('../src/core/paths.js')),
    }));
    let listingFailure: Error | null = null;
    const storage: StorageApi = {
      listNoteIds: async (p) => { if (listingFailure) throw listingFailure; return listNoteIds(p); },
      readNoteFile,
      resolveNote,
      resolveSource,
      resolveAttachment,
    };
    const kb = new KnowledgeBase(project, storage);
    expect(text(await kb.search('rockets'))).toContain(SECRET);

    listingFailure = new Error('disk gone');
    expect(await allResponses(kb, 'rockets')).not.toContain(SECRET);
    expect(kb.status().diagnostics[0]).toMatchObject({ code: 'SCAN_FAILED' });
    expect(kb.status().files).toBe(0);

    listingFailure = null;
    await kb.refresh(true);
    expect(text(await kb.search('rockets'))).toContain(SECRET);
  });

  it('treats an unexpected scan failure like a failed listing instead of keeping the old generation', async () => {
    const project = await realFixture();
    const files = await import('../src/core/files.js');
    const paths = await import('../src/core/paths.js');
    let broken = false;
    const storage: StorageApi = {
      listNoteIds: async (p) => (broken ? (undefined as unknown as string[]) : files.listNoteIds(p)),
      readNoteFile: files.readNoteFile,
      resolveNote: paths.resolveNote,
      resolveSource: paths.resolveSource,
    };
    const kb = new KnowledgeBase(project, storage);
    expect(text(await kb.search('rockets'))).toContain(SECRET);
    broken = true;
    expect(await allResponses(kb, 'rockets')).not.toContain(SECRET);
    expect(kb.status()).toMatchObject({ degraded: true, files: 0 });
    expect(kb.status().diagnostics.map((d) => d.code)).toEqual(['SCAN_FAILED']);
  });
});

describe('per-response authorization inside the rescan interval', () => {
  it('stops serving a note that became private without waiting for the next scan', async () => {
    const project = await realFixture({ rescanIntervalMs: 3_600_000 });
    const kb = new KnowledgeBase(project);
    expect(text(await kb.search('rockets'))).toContain(SECRET);
    const links = await kb.links('docs/index.md');
    expect(links.outgoing[0]).toMatchObject({ status: 'ok', noteId: 'docs/sub/launch.md' });

    await writeFile(join(project.root, 'docs/sub/launch.md'), `---\nprivate: true\n---\n# Launch\n\n## Procedure\n\nThe rockets launch with ${SECRET}.\n\n[Home](../index.md)\n`);

    const exposed = await allResponses(kb, 'rockets');
    expect(exposed).not.toContain(SECRET);
    expect((await kb.search('rockets')).map((hit) => hit.noteId)).toEqual(['docs/index.md']);
    expect((await kb.context('rockets')).excerpts.map((hit) => hit.noteId)).toEqual(['docs/index.md']);
    await expect(kb.links('docs/sub/launch.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    const after = await kb.links('docs/index.md');
    expect(after.outgoing).toEqual([{ target: 'sub/launch.md#procedure', line: 5, embed: false, status: 'broken' }]);
    expect(after.backlinks).toEqual([]);
    const check = await kb.check();
    expect(text(check)).not.toContain(SECRET);
    expect(check.diagnostics.map((d) => d.code)).toContain('LINK_BROKEN');
  });

  it('stops serving a deleted note and its backlinks immediately', async () => {
    const project = await realFixture({ rescanIntervalMs: 3_600_000 });
    const kb = new KnowledgeBase(project);
    expect(text(await kb.context('rockets'))).toContain(SECRET);
    expect((await kb.links('docs/index.md')).backlinks.map((b) => b.noteId)).toEqual(['docs/sub/launch.md']);

    await unlink(join(project.root, 'docs/sub/launch.md'));

    expect(await allResponses(kb, 'rockets')).not.toContain(SECRET);
    await expect(kb.links('docs/sub/launch.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    expect((await kb.links('docs/index.md')).backlinks).toEqual([]);
    expect(kb.status().diagnostics.map((d) => d.code)).toEqual([]);
  });

  it('never returns excerpts for a revision that no longer exists on disk', async () => {
    const project = await realFixture({ rescanIntervalMs: 3_600_000 });
    const kb = new KnowledgeBase(project);
    const warm = await kb.search('rockets');
    const launch = warm.find((hit) => hit.noteId === 'docs/sub/launch.md');
    expect(launch?.excerpt).toContain(SECRET);

    await writeFile(join(project.root, 'docs/sub/launch.md'), '# Launch\n\n## Procedure\n\nThe rockets now launch with a public checklist.\n');

    const search = await kb.search('rockets');
    expect(text(search)).not.toContain(SECRET);
    const current = search.find((hit) => hit.noteId === 'docs/sub/launch.md');
    if (current) {
      expect(current.excerpt).toContain('public checklist');
      expect(current.indexRevision).not.toBe(launch?.indexRevision);
    }
    expect(text(await kb.context('rockets'))).not.toContain(SECRET);
    const fresh = await kb.links('docs/sub/launch.md');
    expect(fresh.outgoing).toEqual([]);
    expect(text(await kb.search('checklist'))).toContain('public checklist');
    expect(kb.status().generation).toBeGreaterThan(1);
  });

  it('deleting an entry note removes it from context without a scan', async () => {
    const project = await realFixture({ rescanIntervalMs: 3_600_000 });
    const kb = new KnowledgeBase(project);
    expect((await kb.context()).excerpts.map((e) => e.noteId)).toEqual(['docs/index.md']);
    await unlink(join(project.root, 'docs/index.md'));
    expect((await kb.context()).excerpts).toEqual([]);
  });
});

describe('revalidation cost', () => {
  it('reads each exposed note once per response and does not touch notes that are not returned', async () => {
    const project = await realFixture({ rescanIntervalMs: 3_600_000 });
    const files = await import('../src/core/files.js');
    const paths = await import('../src/core/paths.js');
    const reads: string[] = [];
    let counting = false;
    const storage: StorageApi = {
      listNoteIds: files.listNoteIds,
      readNoteFile: async (p, id): Promise<NoteFile> => { if (counting) reads.push(id); return files.readNoteFile(p, id); },
      resolveNote: paths.resolveNote,
      resolveSource: paths.resolveSource,
      resolveAttachment: paths.resolveAttachment,
    };
    const sections = Array.from({ length: 12 }, (_, i) => `## Stage ${i + 1}\n\nRockets stage ${i + 1} burns.\n`).join('\n');
    await writeFile(join(project.root, 'docs/sub/stages.md'), `# Stages\n\n${sections}`);
    await writeFile(join(project.root, 'docs/sub/unrelated.md'), '# Unrelated\n\nNothing about the topic.\n');
    const kb = new KnowledgeBase(project, storage);
    await kb.refresh();

    counting = true;
    const hits = await kb.search('rockets', { limit: 50 });
    expect(hits.filter((hit) => hit.noteId === 'docs/sub/stages.md').length).toBeGreaterThan(5);
    expect(reads.filter((id) => id === 'docs/sub/stages.md')).toHaveLength(1);
    expect(reads).not.toContain('docs/sub/unrelated.md');
    expect(new Set(reads).size).toBe(reads.length);

    reads.length = 0;
    const context = await kb.context('rockets');
    expect(context.excerpts.map((e) => e.noteId)).toContain('docs/index.md');
    expect(reads.filter((id) => id === 'docs/index.md')).toHaveLength(1);
    expect(new Set(reads).size).toBe(reads.length);
    expect(kb.status().generation).toBe(1);
  });
});
