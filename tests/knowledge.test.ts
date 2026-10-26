import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { parseNote } from '../src/core/markdown.js';
import { getTemplate, TEMPLATE_TYPES } from '../src/core/templates.js';
import { KnowledgeBase, type StorageApi } from '../src/core/knowledge.js';
import { VaultError } from '../src/core/errors.js';
import type { NoteFile, Project, VaultConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Test-only storage fake. It implements the storage contract (list/read/resolve)
// over a temporary directory. The real storage modules are owned by another
// worker and are injected by the integration owner; nothing here is copied
// into src/.
// ---------------------------------------------------------------------------

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function splitNoteId(noteId: string): { rootId: string; rel: string } {
  const slash = noteId.indexOf('/');
  if (slash <= 0) throw new VaultError('INVALID_NOTE_ID', 'Note id must be rootId/relative/path.md');
  return { rootId: noteId.slice(0, slash), rel: noteId.slice(slash + 1) };
}

function assertContained(rootPath: string, rel: string, code: string): string {
  if (rel.length === 0 || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes('\\') || rel.includes(':')) {
    throw new VaultError(code, 'Target is outside the configured root');
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    throw new VaultError(code, 'Target is outside the configured root');
  }
  const abs = path.resolve(rootPath, rel);
  const relative = path.relative(rootPath, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new VaultError(code, 'Target is outside the configured root');
  }
  return abs;
}

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
  }
}

const fakeStorage: StorageApi = {
  async listNoteIds(project: Project): Promise<string[]> {
    const ids: string[] = [];
    for (const root of project.config.notesRoots) {
      const found: string[] = [];
      await walk(root.path, '', found);
      for (const rel of found) {
        if (project.config.exclude.some((pattern) => rel.startsWith(pattern))) continue;
        ids.push(`${root.id}/${rel}`);
      }
    }
    return ids.sort();
  },
  async readNoteFile(project: Project, noteId: string): Promise<NoteFile> {
    const abs = await fakeStorage.resolveNote(project, noteId, false);
    const raw = await fs.readFile(abs);
    if (raw.length > project.config.limits.maxFileBytes) throw new VaultError('FILE_TOO_LARGE', 'Note exceeds maxFileBytes');
    let content = raw.toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    content = content.replace(/\r\n/g, '\n');
    if (content.startsWith('---\n')) {
      const end = content.indexOf('\n---', 4);
      if (end > 0) {
        let meta: unknown;
        try {
          meta = YAML.parse(content.slice(4, end), { schema: 'core' });
        } catch {
          throw new VaultError('INVALID_FRONTMATTER', `Invalid YAML frontmatter in ${noteId}`);
        }
        if (meta && typeof meta === 'object' && (meta as Record<string, unknown>)['private'] === true) {
          throw new VaultError('PRIVATE_NOTE', `Note ${noteId} is private`);
        }
      }
    }
    return { noteId, content, revision: sha256(raw), bytes: raw.length };
  },
  async resolveNote(project: Project, noteId: string, allowMissing = false): Promise<string> {
    const { rootId, rel } = splitNoteId(noteId);
    const root = project.config.notesRoots.find((r) => r.id === rootId);
    if (!root) throw new VaultError('UNKNOWN_ROOT', `Unknown notes root ${rootId}`);
    const abs = assertContained(root.path, rel, 'OUTSIDE_ROOT');
    if (!allowMissing) {
      try {
        await fs.access(abs);
      } catch {
        throw new VaultError('NOTE_NOT_FOUND', `Note ${noteId} does not exist`);
      }
    }
    return abs;
  },
  async resolveSource(project: Project, sourceRootId: string, relativePath: string): Promise<string> {
    const root = project.config.sourceRoots.find((r) => r.id === sourceRootId);
    if (!root) throw new VaultError('UNKNOWN_ROOT', `Unknown source root ${sourceRootId}`);
    return assertContained(root.path, relativePath, 'OUTSIDE_ROOT');
  },
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture { dir: string; project: Project; kb: KnowledgeBase }

function makeConfig(dir: string, overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    schemaVersion: 1,
    name: 'fixture',
    notesRoots: [{ id: 'docs', path: path.join(dir, 'docs') }],
    entryNotes: ['docs/index.md'],
    exclude: [],
    sourceRoots: [{ id: 'src', path: path.join(dir, 'src'), include: ['**/*.ts'] }],
    searchLocale: 'default',
    allowWrites: false,
    limits: {
      maxFiles: 500,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 50_000_000,
      maxResponseChars: 20_000,
      maxQueryChars: 200,
      rescanIntervalMs: 60_000,
    },
    ...overrides,
  };
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

const tempDirs: string[] = [];

async function makeFixture(files: Record<string, string>, overrides: Partial<VaultConfig> = {}): Promise<Fixture> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-knowledge-')));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFiles(dir, files);
  const config = makeConfig(dir, overrides);
  const project: Project = { root: dir, configPath: path.join(dir, 'project-vault.json'), config };
  return { dir, project, kb: new KnowledgeBase(project, fakeStorage) };
}

afterAll(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

const baseNotes: Record<string, string> = {
  'docs/index.md': [
    '---',
    'title: Fixture Index',
    'type: index',
    '---',
    '# Fixture Index',
    '',
    'Entry point for the fixture vault.',
    '',
    '- [Overview](architecture/overview.md)',
    '- [[modules/payments|Payments module]]',
    '',
  ].join('\n'),
  'docs/architecture/overview.md': [
    '---',
    'type: architecture',
    'status: accepted',
    'sources:',
    '  - root: src',
    '    path: gateway.ts',
    '---',
    '# Architecture Overview',
    '',
    'The payment gateway talks to the ledger over gRPC.',
    '',
    '## Deployment',
    '',
    'Deployment uses blue-green rollouts. See [the index](../index.md#fixture-index).',
    'Also see [[payments#Retries]] and [[overview#Deployment]].',
    '',
  ].join('\n'),
  'docs/modules/payments.md': [
    '---',
    'type: module',
    '---',
    '# Payments',
    '',
    'Handles card payments and refunds through the gateway.',
    '',
    '## Retries',
    '',
    'Retries use exponential backoff. Back to [overview](../architecture/overview.md).',
    '',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// parseNote
// ---------------------------------------------------------------------------

describe('parseNote', () => {
  it('parses frontmatter, preserves unknown keys and extracts sources', () => {
    const note = parseNote([
      '---',
      'title: Meta Title',
      'type: adr',
      'status: proposed',
      'owner: team-a',
      'tags: [one, two]',
      'sources:',
      '  - root: src',
      '    path: a.ts',
      '    sha256: abc',
      '  - root: src',
      '    path: b.ts',
      '  - path: missing-root.ts',
      '---',
      'Body text without a heading.',
      '',
    ].join('\n'));
    expect(note.title).toBe('Meta Title');
    expect(note.type).toBe('adr');
    expect(note.status).toBe('proposed');
    expect(note.metadata['owner']).toBe('team-a');
    expect(note.metadata['tags']).toEqual(['one', 'two']);
    expect(note.sources).toEqual([
      { root: 'src', path: 'a.ts', sha256: 'abc' },
      { root: 'src', path: 'b.ts' },
    ]);
    expect(note.headings).toEqual([]);
    expect(note.sections).toHaveLength(1);
    expect(note.sections[0]?.line).toBe(15);
    expect(note.sections[0]?.text).not.toContain('Meta Title');
  });

  it('keeps digit-only sha256 values as text instead of YAML numbers', () => {
    const digits = '1234567890'.repeat(6) + '1234';
    const note = parseNote(`---\nsources:\n  - root: src\n    path: a.ts\n    sha256: ${digits}\n  - root: src\n    path: b.ts\n    sha256: 1e5\n---\n`);
    expect(note.sources).toEqual([
      { root: 'src', path: 'a.ts', sha256: digits },
      { root: 'src', path: 'b.ts', sha256: '1e5' },
    ]);
  });

  it('prefers the first H1 over the metadata title and tolerates missing frontmatter', () => {
    const note = parseNote('---\ntitle: Meta\n---\n\n# Real Title\n\n## Second\n');
    expect(note.title).toBe('Real Title');
    const bare = parseNote('# Bare\n\nText');
    expect(bare.title).toBe('Bare');
    expect(bare.metadata).toEqual({});
    expect(bare.type).toBeUndefined();
    const untitled = parseNote('just text');
    expect(untitled.title).toBe('');
  });

  it('reports headings with GitHub slugs and real 1-based lines including the frontmatter offset', () => {
    const note = parseNote('---\ntype: module\n---\n# Title\n\n## Retry Policy\n\ntext\n\n## Retry Policy\n\n### Ünicode Başlık\n');
    expect(note.headings).toEqual([
      { text: 'Title', slug: 'title', line: 4 },
      { text: 'Retry Policy', slug: 'retry-policy', line: 6 },
      { text: 'Retry Policy', slug: 'retry-policy-1', line: 10 },
      { text: 'Ünicode Başlık', slug: 'ünicode-başlık', line: 12 },
    ]);
  });

  it('builds heading-sized sections with exact bounds and splits oversized sections', () => {
    const big = Array.from({ length: 150 }, (_, i) => `line ${i + 1} of the long section`).join('\n');
    const note = parseNote(`Preamble\n\n# A\n\na text\n\n## B\n\n${big}\n`);
    const [preamble, a, ...b] = note.sections;
    expect(preamble).toMatchObject({ heading: '', line: 1, endLine: 2 });
    expect(a).toMatchObject({ heading: 'A', line: 3, endLine: 6 });
    expect(a?.text).toContain('a text');
    expect(b.length).toBeGreaterThan(1);
    expect(b[0]?.line).toBe(7);
    expect(b.every((s) => s.heading === 'B')).toBe(true);
    for (let i = 1; i < b.length; i++) expect(b[i]?.line).toBe((b[i - 1]?.endLine ?? 0) + 1);
    expect(b[b.length - 1]?.endLine).toBe(9 + 149);
  });

  it('extracts Markdown links, wikilinks and embeds but ignores fenced and inline code', () => {
    const note = parseNote([
      '# Links',
      '',
      'See [overview](../architecture/overview.md#deployment) and [[payments#Retries|alias text]].',
      'Embedded: ![[diagram.png]] and ![alt](img.png).',
      '',
      '```md',
      '[[not-a-link]] [nope](nope.md)',
      '```',
      '',
      'Inline `[[also-not]]` and `[x](y.md)` are ignored.',
      'Multi-line paragraph continues',
      'with [[second-line]] here.',
      '',
      '[ref]: https://example.com/ref',
      '',
    ].join('\n'));
    expect(note.links).toEqual([
      { target: '../architecture/overview.md#deployment', line: 3, embed: false },
      { target: 'payments#Retries', line: 3, embed: false },
      { target: 'diagram.png', line: 4, embed: true },
      { target: 'img.png', line: 4, embed: true },
      { target: 'second-line', line: 12, embed: false },
      { target: 'https://example.com/ref', line: 14, embed: false },
    ]);
  });

  it('normalizes CRLF and keeps Unicode text intact', () => {
    const note = parseNote('---\r\ntype: runbook\r\n---\r\n# Çalıştırma\r\n\r\nİstanbul ve 東京 notları.\r\n');
    expect(note.type).toBe('runbook');
    expect(note.headings[0]).toMatchObject({ text: 'Çalıştırma', line: 4 });
    expect(note.sections[0]?.text).toContain('東京');
  });

  it('rejects unsafe YAML tags and unbounded alias expansion', () => {
    expect(() => parseNote('---\nx: !!js/function "function(){}"\n---\n# T\n')).toThrowError(VaultError);
    try {
      parseNote('---\nx: !custom value\n---\n');
    } catch (error) {
      expect((error as VaultError).code).toBe('INVALID_FRONTMATTER');
    }
    const bomb = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x]', 'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]', 'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]', 'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]', '---', ''].join('\n');
    expect(() => parseNote(bomb)).toThrowError(VaultError);
    expect(() => parseNote('---\nnot: [valid\n---\n')).toThrowError(VaultError);
    expect(() => parseNote('---\n- a list\n---\n')).toThrowError(VaultError);
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe('getTemplate', () => {
  it('returns fixed English templates for every supported type and rejects unknown types', () => {
    expect(TEMPLATE_TYPES).toEqual(['index', 'architecture', 'module', 'adr', 'runbook']);
    for (const type of TEMPLATE_TYPES) {
      const text = getTemplate(type);
      expect(text.startsWith('---\n')).toBe(true);
      const parsed = parseNote(text);
      expect(parsed.type).toBe(type);
      expect(parsed.title.length).toBeGreaterThan(0);
    }
    expect(() => getTemplate('secret')).toThrowError(VaultError);
    expect(() => getTemplate('../index')).toThrowError(VaultError);
  });

  it('only emits relative links that resolve inside the initialized layout', async () => {
    const layout: Record<string, string> = {
      'docs/index.md': getTemplate('index'),
      'docs/architecture/overview.md': getTemplate('architecture'),
      'docs/modules/index.md': getTemplate('module'),
      'docs/decisions/index.md': getTemplate('adr'),
      'docs/runbooks/index.md': getTemplate('runbook'),
    };
    const indexLinks = parseNote(layout['docs/index.md'] ?? '').links.map((l) => l.target);
    expect(indexLinks).toEqual(['architecture/overview.md', 'modules/index.md', 'decisions/index.md', 'runbooks/index.md']);
    const fixture = await makeFixture(layout, { entryNotes: ['docs/index.md'] });
    for (const [rel, content] of Object.entries(layout)) {
      for (const link of parseNote(content).links) {
        const target = path.resolve(fixture.dir, path.dirname(rel), link.target);
        await expect(fs.access(target)).resolves.toBeUndefined();
      }
    }
    const check = await fixture.kb.check();
    expect(check.diagnostics.filter((d) => d.code.startsWith('LINK_'))).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: scan and status
// ---------------------------------------------------------------------------

describe('KnowledgeBase scan and status', () => {
  it('is degraded before the first scan and clean after a complete scan', async () => {
    const { kb } = await makeFixture(baseNotes);
    const before = kb.status();
    expect(before.degraded).toBe(true);
    expect(before.generation).toBe(0);
    expect(before.indexedAt).toBeNull();
    await kb.refresh();
    const after = kb.status();
    expect(after).toMatchObject({ project: 'fixture', generation: 1, files: 3, degraded: false, diagnostics: [] });
    expect(after.bytes).toBeGreaterThan(0);
    expect(typeof after.indexedAt).toBe('string');
  });

  it('honours the rescan interval unless forced', async () => {
    const { kb, dir } = await makeFixture(baseNotes);
    await kb.refresh();
    await writeFiles(dir, { 'docs/new.md': '# New\n\nFresh note.\n' });
    await kb.refresh();
    expect(kb.status().generation).toBe(1);
    expect(kb.status().files).toBe(3);
    await kb.refresh(true);
    expect(kb.status().generation).toBe(2);
    expect(kb.status().files).toBe(4);
  });

  it('rescans on content hash changes when the interval elapsed', async () => {
    const { kb, dir } = await makeFixture(baseNotes, {
      limits: { ...makeConfig('x').limits, rescanIntervalMs: 0 },
    });
    await kb.refresh();
    await writeFiles(dir, { 'docs/modules/payments.md': '# Payments\n\nNow about zebras.\n' });
    const hits = await kb.search('zebras');
    expect(hits.map((h) => h.noteId)).toEqual(['docs/modules/payments.md']);
  });

  it('skips private notes silently and marks malformed frontmatter as degraded without leaking content', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'docs/secret.md': '---\nprivate: true\n---\n# Secret\n\nTOPSECRET-TOKEN\n',
      'docs/broken.md': '---\nkey: [unterminated\n---\n# Broken\n\nBROKEN-BODY\n',
    });
    await kb.refresh();
    const status = kb.status();
    expect(status.degraded).toBe(true);
    expect(status.files).toBe(3);
    expect(status.diagnostics).toHaveLength(1);
    expect(status.diagnostics[0]).toMatchObject({ code: 'INVALID_FRONTMATTER', noteId: 'docs/broken.md' });
    expect(JSON.stringify(status)).not.toContain('TOPSECRET');
    expect(JSON.stringify(status)).not.toContain('BROKEN-BODY');
    expect(JSON.stringify(status)).not.toContain('secret.md');
    expect(await kb.search('TOPSECRET')).toEqual([]);
    expect(await kb.search('BROKEN-BODY')).toEqual([]);
    const check = await kb.check();
    expect(check.ok).toBe(false);
  });

  it('never reports clean when the scan exceeds limits or the listing fails', async () => {
    const limited = await makeFixture(baseNotes, { limits: { ...makeConfig('x').limits, maxFiles: 2 } });
    await limited.kb.refresh();
    expect(limited.kb.status().degraded).toBe(true);
    expect(limited.kb.status().diagnostics.some((d) => d.code === 'SCAN_LIMIT_EXCEEDED')).toBe(true);
    expect((await limited.kb.check()).ok).toBe(false);

    const failing = await makeFixture(baseNotes);
    const brokenStorage: StorageApi = { ...fakeStorage, listNoteIds: async () => { throw new Error('disk gone'); } };
    const kb = new KnowledgeBase(failing.project, brokenStorage);
    await kb.refresh();
    expect(kb.status().degraded).toBe(true);
    expect(kb.status().diagnostics[0]?.code).toBe('SCAN_FAILED');
  });

  it('reports missing entry notes without any fallback', async () => {
    const { kb } = await makeFixture(baseNotes, { entryNotes: ['docs/index.md', 'docs/nope.md'] });
    await kb.refresh();
    expect(kb.status().diagnostics).toEqual([
      expect.objectContaining({ code: 'ENTRY_NOTE_MISSING', noteId: 'docs/nope.md' }),
    ]);
    expect((await kb.check()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: search
// ---------------------------------------------------------------------------

describe('KnowledgeBase search', () => {
  it('ranks heading matches above body matches deterministically with real lines and bounded excerpts', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'docs/other.md': '# Other\n\nSomething mentions retries once in passing.\n',
    });
    const hits = await kb.search('retries');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatchObject({ noteId: 'docs/modules/payments.md', heading: 'Retries', line: 8, endLine: 10 });
    expect(hits[0]?.excerpt).toContain('Retries');
    expect(hits[0]?.excerpt).not.toContain('type: module');
    expect(hits[0]?.indexRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(hits[0]?.indexedAt).toBe(kb.status().indexedAt);
    const again = await kb.search('retries');
    expect(again).toEqual(hits);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });

  it('matches path tokens, Unicode words and supports type filters', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'docs/runbooks/İstanbul-oncall.md': '---\ntype: runbook\n---\n# On-call\n\n東京 ofisi için nöbet rehberi.\n',
    });
    expect((await kb.search('payments')).map((h) => h.noteId)).toContain('docs/modules/payments.md');
    expect((await kb.search('東京')).map((h) => h.noteId)).toEqual(['docs/runbooks/İstanbul-oncall.md']);
    expect((await kb.search('nöbet', { type: 'runbook' })).map((h) => h.noteId)).toEqual(['docs/runbooks/İstanbul-oncall.md']);
    expect(await kb.search('gateway', { type: 'runbook' })).toEqual([]);
    expect((await kb.search('gateway', { type: 'module' })).map((h) => h.noteId)).toEqual(['docs/modules/payments.md']);
  });

  it('folds Turkish dotted and dotless I only when searchLocale is tr', async () => {
    const notes = { 'docs/a.md': '# Irmak\n\nILICA kaplıcası.\n', 'docs/b.md': '# İzmir\n\nİZMİR limanı.\n' };
    const neutral = await makeFixture(notes);
    expect((await neutral.kb.search('izmir')).map((h) => h.noteId)).toEqual([]);
    expect((await neutral.kb.search('ılıca')).map((h) => h.noteId)).toEqual([]);
    const turkish = await makeFixture(notes, { searchLocale: 'tr' });
    expect((await turkish.kb.search('izmir')).map((h) => h.noteId)).toEqual(['docs/b.md']);
    expect((await turkish.kb.search('ılıca')).map((h) => h.noteId)).toEqual(['docs/a.md']);
  });

  it('enforces query, limit and response budgets', async () => {
    const { kb } = await makeFixture(baseNotes, { limits: { ...makeConfig('x').limits, maxQueryChars: 10, maxResponseChars: 400 } });
    await expect(kb.search('a'.repeat(11))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(await kb.search('   ')).toEqual([]);
    await expect(kb.search('gateway', { limit: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.search('gateway', { limit: 1.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.search('gateway', { limit: 10_000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const one = await kb.search('gateway', { limit: 1 });
    expect(one).toHaveLength(1);
    const all = await kb.search('gateway');
    expect(all.reduce((n, h) => n + h.excerpt.length, 0)).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: read
// ---------------------------------------------------------------------------

describe('KnowledgeBase read', () => {
  it('reads current bytes through storage with line windows and revision', async () => {
    const { kb, project, dir } = await makeFixture(baseNotes);
    const full = await kb.read('docs/modules/payments.md');
    expect(full).toMatchObject({ noteId: 'docs/modules/payments.md', startLine: 1, totalLines: 10, truncated: false });
    expect(full.endLine).toBe(10);
    expect(full.diskRevision).toBe((await fakeStorage.readNoteFile(project, 'docs/modules/payments.md')).revision);
    const window = await kb.read('docs/modules/payments.md', 4, 2);
    expect(window.content).toBe('# Payments\n\n');
    expect(window).toMatchObject({ startLine: 4, endLine: 5, truncated: true });
    await writeFiles(dir, { 'docs/modules/payments.md': '# Changed\n' });
    const changed = await kb.read('docs/modules/payments.md');
    expect(changed.content).toBe('# Changed\n');
    expect(changed.diskRevision).not.toBe(full.diskRevision);
  });

  it('validates arguments and enforces the response budget', async () => {
    const { kb } = await makeFixture(baseNotes, { limits: { ...makeConfig('x').limits, maxResponseChars: 40 } });
    await expect(kb.read('docs/index.md', 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.read('docs/index.md', 1, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.read('docs/index.md', 2.5)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.read('docs/index.md', 999)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(kb.read('docs/missing.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await expect(kb.read('docs/../index.md')).rejects.toBeInstanceOf(VaultError);
    const budgeted = await kb.read('docs/index.md');
    expect(budgeted.content.length).toBeLessThanOrEqual(40);
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.endLine).toBeLessThan(budgeted.totalLines);
  });

  it('refuses private notes through storage', async () => {
    const { kb } = await makeFixture({ ...baseNotes, 'docs/secret.md': '---\nprivate: true\n---\n# S\n' });
    await expect(kb.read('docs/secret.md')).rejects.toMatchObject({ code: 'PRIVATE_NOTE' });
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: links
// ---------------------------------------------------------------------------

describe('KnowledgeBase links', () => {
  it('resolves relative links, aliases, anchors and reports backlinks with lines', async () => {
    const { kb } = await makeFixture(baseNotes);
    const overview = await kb.links('docs/architecture/overview.md');
    expect(overview.outgoing).toEqual([
      expect.objectContaining({ target: '../index.md#fixture-index', line: 14, status: 'ok', noteId: 'docs/index.md', heading: 'fixture-index' }),
      expect.objectContaining({ target: 'payments#Retries', line: 15, status: 'ok', noteId: 'docs/modules/payments.md' }),
      expect.objectContaining({ target: 'overview#Deployment', line: 15, status: 'ok', noteId: 'docs/architecture/overview.md' }),
    ]);
    expect(overview.backlinks).toEqual([
      expect.objectContaining({ noteId: 'docs/architecture/overview.md', line: 15 }),
      expect.objectContaining({ noteId: 'docs/index.md', line: 9 }),
      expect.objectContaining({ noteId: 'docs/modules/payments.md', line: 10 }),
    ]);
    const index = await kb.links('docs/index.md');
    expect(index.outgoing[1]).toMatchObject({ target: 'modules/payments', status: 'ok', noteId: 'docs/modules/payments.md' });
    await expect(kb.links('docs/missing.md')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
  });

  it('classifies broken, ambiguous, missing-heading, same-note, external and outside-root links', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'docs/a/dup.md': '# Dup A\n',
      'docs/b/dup.md': '# Dup B\n',
      'docs/probe.md': [
        '# Probe',
        '',
        '## Known',
        '',
        '[[dup]]',
        '[[nowhere]]',
        '[missing](nope.md)',
        '[[payments#No Such Heading]]',
        '[same](#known)',
        '[same-missing](#unknown-heading)',
        '[web](https://example.com/x.md)',
        '[mail](mailto:someone@example.com)',
        '[up](../../../etc/passwd)',
        '[abs](/etc/passwd)',
        '[drive](C:/Windows/win.ini)',
        '[enc](..%2F..%2Fproject-vault.json)',
        '[[../../outside]]',
        '[asset](diagram.png)',
        '',
      ].join('\n'),
    });
    const result = await kb.links('docs/probe.md');
    const byTarget = Object.fromEntries(result.outgoing.map((l) => [(l as { target: string }).target, (l as { status: string }).status]));
    expect(byTarget).toEqual({
      'dup': 'ambiguous',
      'nowhere': 'broken',
      'nope.md': 'broken',
      'payments#No Such Heading': 'missing_heading',
      '#known': 'ok',
      '#unknown-heading': 'missing_heading',
      'https://example.com/x.md': 'external',
      'mailto:someone@example.com': 'external',
      '../../../etc/passwd': 'outside_root',
      '/etc/passwd': 'outside_root',
      'C:/Windows/win.ini': 'outside_root',
      '..%2F..%2Fproject-vault.json': 'outside_root',
      '../../outside': 'outside_root',
      'diagram.png': 'asset',
    });
    const ambiguous = result.outgoing.find((l) => (l as { target: string }).target === 'dup') as { candidates?: string[] };
    expect(ambiguous.candidates).toEqual(['docs/a/dup.md', 'docs/b/dup.md']);
    const check = await kb.check();
    expect(check.ok).toBe(false);
    const codes = check.diagnostics.map((d) => d.code);
    expect(codes).toContain('LINK_BROKEN');
    expect(codes).toContain('LINK_AMBIGUOUS');
    expect(codes).toContain('LINK_MISSING_HEADING');
    expect(codes).toContain('LINK_OUTSIDE_ROOT');
    expect(JSON.stringify(check)).not.toContain('passwd');
  });

  it('handles link cycles without recursion problems', async () => {
    const { kb } = await makeFixture({
      'docs/index.md': '# Index\n\n[[loop-a]]\n',
      'docs/loop-a.md': '# Loop A\n\n[[loop-b]]\n',
      'docs/loop-b.md': '# Loop B\n\n[[loop-a]] and [[loop-b]]\n',
    });
    const a = await kb.links('docs/loop-a.md');
    expect(a.backlinks.map((b) => (b as { noteId: string }).noteId)).toEqual(['docs/index.md', 'docs/loop-b.md']);
    const b = await kb.links('docs/loop-b.md');
    expect(b.backlinks.map((x) => (x as { noteId: string }).noteId)).toEqual(['docs/loop-a.md', 'docs/loop-b.md']);
    expect((await kb.check()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: context
// ---------------------------------------------------------------------------

describe('KnowledgeBase context', () => {
  it('returns entry notes first in configured order, then topic hits without duplicates', async () => {
    const { kb } = await makeFixture(baseNotes, { entryNotes: ['docs/modules/payments.md', 'docs/index.md'] });
    const plain = await kb.context();
    expect(plain.project).toBe('fixture');
    expect(plain.excerpts.map((e) => e.noteId)).toEqual(['docs/modules/payments.md', 'docs/index.md']);
    expect(plain.excerpts[0]?.excerpt).toContain('Handles card payments');
    expect(plain.excerpts[0]?.excerpt).not.toContain('type: module');
    expect(plain.truncated).toBe(false);
    const topical = await kb.context('deployment rollouts');
    expect(topical.excerpts.slice(0, 2).map((e) => e.noteId)).toEqual(['docs/modules/payments.md', 'docs/index.md']);
    expect(topical.excerpts.some((e) => e.noteId === 'docs/architecture/overview.md' && e.heading === 'Deployment')).toBe(true);
    const keys = topical.excerpts.map((e) => `${e.noteId}:${e.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies the global character budget and marks truncation', async () => {
    const { kb } = await makeFixture(baseNotes);
    const tiny = await kb.context('gateway', 120);
    const total = tiny.excerpts.reduce((n, e) => n + e.excerpt.length, 0);
    expect(total).toBeLessThanOrEqual(120);
    expect(tiny.truncated).toBe(true);
    await expect(kb.context('gateway', 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const capped = await kb.context(undefined, 10_000_000);
    expect(capped.excerpts.reduce((n, e) => n + e.excerpt.length, 0)).toBeLessThanOrEqual(20_000);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeBase: check and source evidence
// ---------------------------------------------------------------------------

describe('KnowledgeBase check', () => {
  it('treats sources without hashes as unknown and verifies declared hashes', async () => {
    const gateway = 'export const gateway = 1;\n';
    const { kb } = await makeFixture({
      ...baseNotes,
      'src/gateway.ts': gateway,
      'docs/verified.md': `---\nsources:\n  - root: src\n    path: gateway.ts\n    sha256: ${sha256(Buffer.from(gateway))}\n---\n# Verified\n`,
    });
    const result = await kb.check();
    expect(result.ok).toBe(true);
    const unknown = result.diagnostics.find((d) => d.code === 'SOURCE_UNVERIFIED');
    expect(unknown).toMatchObject({ noteId: 'docs/architecture/overview.md' });
    const verified = result.diagnostics.find((d) => d.code === 'SOURCE_VERIFIED');
    expect(verified).toMatchObject({ noteId: 'docs/verified.md' });
    expect(verified?.message).toMatch(/does not prove/i);
    expect(JSON.stringify(result)).not.toContain('export const gateway');
  });

  it('fails on changed, missing, inaccessible or out-of-scope declared hashes', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'src/gateway.ts': 'changed bytes\n',
      'src/notes.md': 'not included by globs\n',
      'docs/changed.md': `---\nsources:\n  - root: src\n    path: gateway.ts\n    sha256: ${'0'.repeat(64)}\n---\n# Changed\n`,
      'docs/missing.md': `---\nsources:\n  - root: src\n    path: ghost.ts\n    sha256: ${'0'.repeat(64)}\n---\n# Missing\n`,
      'docs/traversal.md': `---\nsources:\n  - root: src\n    path: ../project-vault.json\n    sha256: ${'0'.repeat(64)}\n---\n# Traversal\n`,
      'docs/unknown-root.md': `---\nsources:\n  - root: nowhere\n    path: gateway.ts\n    sha256: ${'0'.repeat(64)}\n---\n# Unknown root\n`,
      'docs/excluded.md': `---\nsources:\n  - root: src\n    path: notes.md\n    sha256: ${'0'.repeat(64)}\n---\n# Excluded\n`,
    });
    const result = await kb.check();
    expect(result.ok).toBe(false);
    const byNote = (id: string) => result.diagnostics.filter((d) => d.noteId === id).map((d) => d.code);
    expect(byNote('docs/changed.md')).toEqual(['SOURCE_CHANGED']);
    expect(byNote('docs/missing.md')).toEqual(['SOURCE_MISSING']);
    expect(byNote('docs/traversal.md')).toEqual(['SOURCE_INACCESSIBLE']);
    expect(byNote('docs/unknown-root.md')).toEqual(['SOURCE_INACCESSIBLE']);
    expect(byNote('docs/excluded.md')).toEqual(['SOURCE_INACCESSIBLE']);
    expect(JSON.stringify(result)).not.toContain('changed bytes');
  });

  it('does not fail on unverified sources alone but fails on hashes over the byte limit', async () => {
    const { kb } = await makeFixture({
      ...baseNotes,
      'src/big.ts': 'x'.repeat(2_000),
      'docs/big.md': `---\nsources:\n  - root: src\n    path: big.ts\n    sha256: ${'0'.repeat(64)}\n---\n# Big\n`,
    }, { limits: { ...makeConfig('x').limits, maxFileBytes: 1_000 } });
    const result = await kb.check();
    expect(result.diagnostics.filter((d) => d.noteId === 'docs/big.md').map((d) => d.code)).toEqual(['SOURCE_INACCESSIBLE']);
    expect(result.ok).toBe(false);
  });
});
