import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadProject } from '../src/core/config.js';
import { KnowledgeBase } from '../src/core/knowledge.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-real-')));
  temporary.push(root);
  await mkdir(join(root, 'docs/sub'), { recursive: true });
  await mkdir(join(root, 'src'));
  const config = defaultConfig('Real storage');
  config.sourceRoots = [{ id: 'source', path: 'src', include: ['**/*.ts'] }];
  config.limits.rescanIntervalMs = 0;
  await writeFile(join(root, 'project-vault.json'), JSON.stringify(config));
  await writeFile(join(root, 'docs/index.md'), '# Knowledge\n\n[Architecture](sub/architecture.md#boundary)\n');
  await writeFile(join(root, 'docs/sub/architecture.md'), '# Architecture\n\n## Boundary\n\nA stable service boundary.\n\n[Home](../index.md)\n');
  return loadProject(root);
}

describe('knowledge with the real filesystem policy', () => {
  it('resolves ordinary relative links and anchors without fake storage', async () => {
    const project = await fixture();
    const kb = new KnowledgeBase(project);
    expect(await kb.check()).toEqual({ ok: true, diagnostics: [] });
    expect((await kb.links('docs/index.md')).outgoing[0]).toMatchObject({ status: 'ok', noteId: 'docs/sub/architecture.md' });
    expect((await kb.search('service'))[0]?.noteId).toBe('docs/sub/architecture.md');
    expect((await kb.read('docs/index.md')).diskRevision).toHaveLength(64);
  });

  it('accepts encoded headings and dotted Obsidian note names', async () => {
    const project = await fixture();
    await writeFile(join(project.root, 'docs/sub/Node.js.md'), '# Node.js\n\n## Data Flow\n');
    await writeFile(join(project.root, 'docs/index.md'), '# Knowledge\n\n[Flow](sub/Node.js.md#Data%20Flow)\n\n[[Node.js]]\n');
    const kb = new KnowledgeBase(project);
    const links = (await kb.links('docs/index.md')).outgoing;
    expect(links).toHaveLength(2);
    expect(links.every(link => link.status === 'ok')).toBe(true);
    expect((await kb.links('docs/sub/Node.js.md')).backlinks).toHaveLength(2);
    expect((await kb.check()).ok).toBe(true);
  });

  it('bounds aggregate source hashing even when every individual source is small', async () => {
    const project = await fixture();
    project.config.limits.maxTotalBytes = 300;
    const first = 'a'.repeat(160);
    const second = 'b'.repeat(160);
    await writeFile(join(project.root, 'src/first.ts'), first);
    await writeFile(join(project.root, 'src/second.ts'), second);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await writeFile(join(project.root, 'docs/index.md'), `---\nsources:\n- root: source\n  path: first.ts\n  sha256: ${digest(first)}\n- root: source\n  path: second.ts\n  sha256: ${digest(second)}\n---\n# Knowledge\n`);
    // The note's metadata fits this separate byte budget; source bytes exceed it.
    project.config.limits.maxTotalBytes = Math.max(300, (await readFile(join(project.root, 'docs/index.md'))).length + 1);
    await writeFile(join(project.root, 'docs/sub/architecture.md'), '');
    const checked = await new KnowledgeBase(project).check();
    expect(checked.ok).toBe(false);
    expect(checked.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_LIMIT_EXCEEDED' })]));
  });

  it('rejects excessive source declarations before hashing them', async () => {
    const project = await fixture();
    const sources = Array.from({ length: 65 }, () => '- root: source\n  path: boundary.ts').join('\n');
    await writeFile(join(project.root, 'docs/index.md'), `---\nsources:\n${sources}\n---\n# Knowledge\n`);
    const checked = await new KnowledgeBase(project).check();
    expect(checked.ok).toBe(false);
    expect(checked.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_LIMIT_EXCEEDED' })]));
  });

  it('classifies a contained image reference without reading binary contents', async () => {
    const project = await fixture();
    await writeFile(join(project.root, 'docs/diagram.png'), Buffer.from([137, 80, 78, 71, 0, 0]));
    await writeFile(join(project.root, 'docs/index.md'), '# Knowledge\n\n![Diagram](diagram.png)\n');
    const kb = new KnowledgeBase(project);
    expect((await kb.links('docs/index.md')).outgoing[0]).toMatchObject({ status: 'asset' });
    expect((await kb.check()).ok).toBe(true);
  });

  it('checks byte hashes, detects drift and distinguishes a missing source', async () => {
    const project = await fixture();
    const source = 'export const boundary = true;\n';
    await writeFile(join(project.root, 'src/boundary.ts'), source);
    const sha = createHash('sha256').update(source).digest('hex');
    await writeFile(join(project.root, 'docs/index.md'), `---\nsources:\n  - root: source\n    path: boundary.ts\n    sha256: ${sha}\n---\n# Knowledge\n`);
    const kb = new KnowledgeBase(project);
    const verified = await kb.check();
    expect(verified.ok).toBe(true);
    expect(verified.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_VERIFIED' })]));
    await writeFile(join(project.root, 'src/boundary.ts'), 'export const boundary = false;\n');
    expect((await kb.check()).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_CHANGED' })]));
    await rm(join(project.root, 'src/boundary.ts'));
    expect((await kb.check()).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_MISSING' })]));
  });

  it('excludes private note contents from a real scan and reports broken references', async () => {
    const project = await fixture();
    await writeFile(join(project.root, 'docs/private-note.md'), '---\nprivate: true\n---\n# Secret unicorn payload\n');
    const kb = new KnowledgeBase(project);
    expect(await kb.search('unicorn')).toEqual([]);
    await expect(kb.read('docs/private-note.md')).rejects.toMatchObject({ code: 'PRIVATE_NOTE' });
    await writeFile(join(project.root, 'docs/index.md'), '# Knowledge\n\n[Missing](missing.md)\n');
    const checked = await kb.check();
    expect(checked.ok).toBe(false);
    expect(checked.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LINK_BROKEN' })]));
    expect(await readFile(join(project.root, 'docs/private-note.md'), 'utf8')).toContain('unicorn');
  });
});
