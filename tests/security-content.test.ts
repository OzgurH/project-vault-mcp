import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../src/core/config.js';
import { VaultError } from '../src/core/errors.js';
import { frontmatterAccessRestriction, isPrivateFrontmatter, listNoteIds, parseIsoTimestamp, readNoteFile } from '../src/core/files.js';
import { DEFAULT_MAX_LINKS_PER_NOTE, LINK_OPENER_BUDGET_FACTOR, parseNote, scanWikilinks } from '../src/core/markdown.js';
import { writeNote } from '../src/core/writes.js';
import type { Project, VaultConfig } from '../src/core/types.js';

const MIB = 1024 * 1024;

let tmpBase: string;
let projectDir: string;

async function setupProject(extra: Partial<VaultConfig> & Record<string, unknown> = {}): Promise<Project> {
  await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'docs', 'index.md'), '# Index\n', 'utf8');
  await fs.writeFile(path.join(projectDir, 'project-vault.json'), JSON.stringify({ schemaVersion: 1, name: 'security', ...extra }), 'utf8');
  return loadProject(projectDir);
}

/** The limits schema is owned by the integration branch; set traversal limits directly on the loaded project. */
function withLimits(project: Project, limits: Record<string, number>): Project {
  Object.assign(project.config.limits as unknown as Record<string, number>, limits);
  return project;
}

async function expectVaultError(run: () => unknown | Promise<unknown>, code: string): Promise<VaultError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe(code);
    return error as VaultError;
  }
  throw new Error(`Expected VaultError ${code} but the call succeeded`);
}

beforeEach(async () => {
  tmpBase = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-security-')));
  projectDir = path.join(tmpBase, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 5 });
});

// ---------------------------------------------------------------------------
// parseNote: linear wikilink scanning and per-note link cap
// ---------------------------------------------------------------------------

describe('parseNote link extraction', () => {
  it('reports correct lines for wikilinks spread over multi-line paragraphs after frontmatter', () => {
    const note = parseNote([
      '---',
      'title: Links',
      '---',
      '# Heading',
      '',
      'First paragraph line',
      'second line with [[alpha|Alias]] and ![[image.png]]',
      'third line [[beta#Section]] plus [md](gamma.md) and ![img](pic.png)',
      '',
      '<div>[[inside-html]]</div>',
      '',
      '```',
      '[[fenced]]',
      '```',
      '',
      'Inline `[[code]]` is skipped but [[delta]] is not.',
      '',
      '[ref]: https://example.com/x',
    ].join('\n'));
    expect(note.links).toEqual([
      { target: 'alpha', line: 7, embed: false },
      { target: 'image.png', line: 7, embed: true },
      { target: 'beta#Section', line: 8, embed: false },
      { target: 'gamma.md', line: 8, embed: false },
      { target: 'pic.png', line: 8, embed: true },
      { target: 'delta', line: 16, embed: false },
      { target: 'https://example.com/x', line: 18, embed: false },
    ]);
  });

  it('ignores empty, whitespace-only, unterminated and newline-spanning wikilinks', () => {
    const note = parseNote('[[]] [[   ]] [[open\nclosed]] [[lone]bracket]] [[ok]]\n');
    expect(note.links).toEqual([{ target: 'ok', line: 2, embed: false }]);
  });

  it('allows exactly the cap and rejects one more without returning partial links', async () => {
    const atCap = Array.from({ length: 5 }, (_, i) => `[[n${i}]]`).join(' ');
    expect(parseNote(atCap, { maxLinks: 5 }).links).toHaveLength(5);
    await expectVaultError(() => parseNote(`${atCap} [[extra]]`, { maxLinks: 5 }), 'LIMIT_EXCEEDED');
  });

  it('counts Markdown links, images and definitions towards the cap too', async () => {
    const markdown = '[a](a.md) ![b](b.png) [[c]]\n\n[d]: https://example.com/d\n';
    expect(parseNote(markdown, { maxLinks: 4 }).links).toHaveLength(4);
    await expectVaultError(() => parseNote(markdown, { maxLinks: 3 }), 'LIMIT_EXCEEDED');
    await expectVaultError(() => parseNote('[a](a.md)', { maxLinks: 0 }), 'LIMIT_EXCEEDED');
  });

  it('applies the default cap of 2048 links and fails fast on a 1 MiB note of repeated links', async () => {
    const unit = '[[x]] ';
    const content = unit.repeat(Math.floor(MIB / unit.length));
    expect(content.length).toBeLessThanOrEqual(MIB);
    const started = performance.now();
    const error = await expectVaultError(() => parseNote(content), 'LIMIT_EXCEEDED');
    expect(error.message).toContain(String(DEFAULT_MAX_LINKS_PER_NOTE));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(parseNote(unit.repeat(DEFAULT_MAX_LINKS_PER_NOTE)).links).toHaveLength(DEFAULT_MAX_LINKS_PER_NOTE);
    // Under the opener budget but over the link cap: the parser runs and the collector rejects the note.
    const underBudget = unit.repeat(DEFAULT_MAX_LINKS_PER_NOTE + 1);
    await expectVaultError(() => parseNote(underBudget), 'LIMIT_EXCEEDED');
  }, 30_000);

  it('rejects an invalid maxLinks option', async () => {
    await expectVaultError(() => parseNote('x', { maxLinks: -1 }), 'INVALID_ARGUMENT');
    await expectVaultError(() => parseNote('x', { maxLinks: 1.5 }), 'INVALID_ARGUMENT');
  });

  it('refuses bracket floods before the Markdown parser runs, within the opener budget', async () => {
    const budget = DEFAULT_MAX_LINKS_PER_NOTE * LINK_OPENER_BUDGET_FACTOR;
    for (const flood of ['[['.repeat(MIB / 2), '[[a]'.repeat(MIB / 4), '['.repeat(MIB)]) {
      const started = performance.now();
      const error = await expectVaultError(() => parseNote(`${flood}\n`), 'LIMIT_EXCEEDED');
      expect(error.message).toContain(String(budget));
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    // Exactly the budget is still parsed; brackets inside code count too because the parser sees them.
    expect(parseNote(`${'[ '.repeat(budget)}\n`).links).toEqual([]);
    await expectVaultError(() => parseNote('```\n' + '['.repeat(budget + 1) + '\n```\n'), 'LIMIT_EXCEEDED');
  }, 120_000);

  it('scans 1 MiB of unmatched openers in linear time without scanning back', () => {
    const inputs = ['[['.repeat(MIB / 2), '[[a]'.repeat(MIB / 4), '[[a\n'.repeat(MIB / 4), `${'[[ \n'.repeat(MIB / 4 - 2)}[[last]]`];
    for (const text of inputs) {
      const started = performance.now();
      const links = scanWikilinks(text, 1);
      const elapsed = performance.now() - started;
      expect(elapsed, `scan of ${text.slice(0, 4)}... took ${elapsed}ms`).toBeLessThan(5_000);
      if (text.endsWith('[[last]]')) expect(links).toEqual([{ target: 'last', line: MIB / 4 - 1, embed: false }]);
      else expect(links).toEqual([]);
    }
  }, 60_000);

  it('scanWikilinks enforces the cap without returning partial results', async () => {
    const text = '[[a]] [[b]] [[c]]';
    expect(scanWikilinks(text, 1, 3)).toHaveLength(3);
    await expectVaultError(() => scanWikilinks(text, 1, 2), 'LIMIT_EXCEEDED');
  });

  it('handles many short lines of openers under the budget without quadratic newline counting', () => {
    const count = DEFAULT_MAX_LINKS_PER_NOTE * LINK_OPENER_BUDGET_FACTOR / 2 - 1;
    const lines = Array.from({ length: count }, () => '[[ ').join('\n');
    const started = performance.now();
    const note = parseNote(`${lines}\n[[last]]\n`);
    expect(note.links).toEqual([{ target: 'last', line: count + 1, embed: false }]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Frontmatter privacy decision
// ---------------------------------------------------------------------------

describe('frontmatterAccessRestriction', () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);

  it('keeps the legacy private/visibility semantics', () => {
    expect(isPrivateFrontmatter(null)).toBe(false);
    expect(isPrivateFrontmatter({})).toBe(false);
    expect(isPrivateFrontmatter({ private: true })).toBe(true);
    expect(isPrivateFrontmatter({ private: false })).toBe(false);
    expect(isPrivateFrontmatter({ visibility: ' Private ' })).toBe(true);
    expect(isPrivateFrontmatter({ visibility: 'public' })).toBe(false);
  });

  it('denies the new deny-by-default flags', () => {
    expect(frontmatterAccessRestriction({ ai_access: false }, now)).toBe('ai_access is false');
    expect(frontmatterAccessRestriction({ ai_access: true }, now)).toBeNull();
    expect(frontmatterAccessRestriction({ personal_data: true }, now)).toBe('personal_data is true');
    expect(frontmatterAccessRestriction({ personal_data: false }, now)).toBeNull();
    expect(frontmatterAccessRestriction({ classification: 'Confidential' }, now)).toBe('classification is restricted');
    expect(frontmatterAccessRestriction({ classification: ' RESTRICTED ' }, now)).toBe('classification is restricted');
    expect(frontmatterAccessRestriction({ classification: 'internal' }, now)).toBeNull();
  });

  it('denies privacy flags of the wrong type instead of guessing', () => {
    const wrongTypes: Record<string, unknown>[] = [
      { private: 'false' },
      { private: 'true' },
      { private: 0 },
      { private: null },
      { visibility: ['private'] },
      { visibility: true },
      { ai_access: 'true' },
      { ai_access: 1 },
      { personal_data: 'false' },
      { personal_data: 'no' },
      { classification: ['confidential'] },
      { classification: 7 },
      { expires_at: 1_800_000_000_000 },
      { expires_at: true },
    ];
    for (const data of wrongTypes) {
      expect(frontmatterAccessRestriction(data, now), JSON.stringify(data)).not.toBeNull();
    }
  });

  it('denies expired, malformed, ambiguous and impossible expires_at values', () => {
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T11:59:59Z' }, now)).toBe('expires_at has passed');
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T12:00:00Z' }, now)).toBe('expires_at has passed');
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T12:00:01Z' }, now)).toBeNull();
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-27' }, now)).toBeNull();
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26' }, now)).toBe('expires_at has passed');
    // Offsets are honoured: 14:00 at +03:00 is 11:00Z (expired); 09:00 at -05:00 is 14:00Z (valid).
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T14:00:00+03:00' }, now)).toBe('expires_at has passed');
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T09:00:00-05:00' }, now)).toBeNull();
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T09:00:00-0500' }, now)).toBeNull();
    const invalid = ['', 'tomorrow', '2026-10-26T12:00:00', '2026-13-01', '2026-02-30', '2026-10-26T25:00:00Z', '2026-10-26T10:00:00+25:00', '26/10/2026', 'Mon Oct 26 2026'];
    for (const value of invalid) {
      expect(frontmatterAccessRestriction({ expires_at: value }, now), value).toBe('expires_at must be an ISO 8601 timestamp with an explicit UTC offset');
    }
  });

  it('parses strict ISO timestamps only', () => {
    expect(parseIsoTimestamp('2026-01-01T00:00:00.999Z')).toBe(Date.UTC(2026, 0, 1) + 999);
    expect(parseIsoTimestamp('2026-01-01T02:30:00.123456789+02:30')).toBe(Date.UTC(2026, 0, 1) + 123);
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T12:00:00.999Z' }, now + 998)).toBeNull();
    expect(frontmatterAccessRestriction({ expires_at: '2026-10-26T12:00:00.999Z' }, now + 999)).toBe('expires_at has passed');
    expect(parseIsoTimestamp('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1));
    expect(parseIsoTimestamp('2026-01-01T02:30:00+02:30')).toBe(Date.UTC(2026, 0, 1));
    expect(parseIsoTimestamp('2026-01-01T00:00:00.123456789Z')).toBe(Date.UTC(2026, 0, 1) + 123);
    expect(parseIsoTimestamp('2026-01-01T00:00:00')).toBeNull();
    expect(parseIsoTimestamp(20260101)).toBeNull();
  });
});

describe('frontmatter privacy on the real filesystem', () => {
  async function writeDoc(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(projectDir, 'docs', name), content, 'utf8');
  }

  it('readNoteFile denies restricted notes with an access-restricted message and reads the rest', async () => {
    const project = await setupProject();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await writeDoc('ai.md', '---\nai_access: false\n---\n# Hidden\n');
    await writeDoc('pii.md', '---\npersonal_data: true\n---\n# Hidden\n');
    await writeDoc('class.md', '---\nclassification: CONFIDENTIAL\n---\n# Hidden\n');
    await writeDoc('expired.md', '---\nexpires_at: 2000-01-01T00:00:00Z\n---\n# Hidden\n');
    await writeDoc('baddate.md', '---\nexpires_at: 2030-01-01T00:00:00\n---\n# Hidden\n');
    await writeDoc('stringflag.md', '---\nprivate: "false"\n---\n# Hidden\n');
    await writeDoc('open.md', `---\nai_access: true\npersonal_data: false\nclassification: internal\nexpires_at: ${future}\nprivate: false\n---\n# Open\n`);

    for (const name of ['ai.md', 'pii.md', 'class.md', 'expired.md', 'baddate.md', 'stringflag.md']) {
      const error = await expectVaultError(() => readNoteFile(project, `docs/${name}`), 'PRIVATE_NOTE');
      expect(error.message).toContain('access restricted');
    }
    const open = await readNoteFile(project, 'docs/open.md');
    expect(open.content).toContain('# Open');
    // Restricted notes are still listed; only their content is protected.
    expect(await listNoteIds(project)).toContain('docs/ai.md');
  });

  it('writeNote refuses to create or overwrite access-restricted notes', async () => {
    const project = await setupProject({ allowWrites: true });
    await expectVaultError(
      () => writeNote(project, 'docs/new.md', '---\nai_access: false\n---\n# New\n', { expectedRevision: null, dryRun: false }),
      'PRIVATE_NOTE',
    );
    await expectVaultError(
      () => writeNote(project, 'docs/new.md', '---\nclassification: restricted\n---\n# New\n', { expectedRevision: null, dryRun: false }),
      'PRIVATE_NOTE',
    );
    await expect(fs.stat(path.join(projectDir, 'docs', 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    await writeDoc('pii.md', '---\npersonal_data: true\n---\n# Keep\n');
    const before = await fs.readFile(path.join(projectDir, 'docs', 'pii.md'), 'utf8');
    await expectVaultError(
      () => writeNote(project, 'docs/pii.md', '# Overwritten\n', { expectedRevision: 'a'.repeat(64), dryRun: false }),
      'PRIVATE_NOTE',
    );
    expect(await fs.readFile(path.join(projectDir, 'docs', 'pii.md'), 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// listNoteIds: bounded streaming traversal
// ---------------------------------------------------------------------------

describe('listNoteIds traversal limits', () => {
  it('counts every directory entry, including non-markdown files and directories', async () => {
    const project = await setupProject();
    const docs = path.join(projectDir, 'docs');
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(docs, `asset-${i}.png`), 'x');
    await fs.mkdir(path.join(docs, 'empty-dir'));
    // index.md + 6 assets + 1 directory = 8 entries
    expect(await listNoteIds(withLimits(project, { maxDirectoryEntries: 8 }))).toEqual(['docs/index.md']);
    const error = await expectVaultError(() => listNoteIds(withLimits(project, { maxDirectoryEntries: 7 })), 'LIMIT_EXCEEDED');
    expect(error.message).toContain('maxDirectoryEntries');
  });

  it('counts entries across all notes roots', async () => {
    await fs.mkdir(path.join(projectDir, 'wiki'));
    await fs.writeFile(path.join(projectDir, 'wiki', 'a.md'), '# A\n');
    await fs.writeFile(path.join(projectDir, 'wiki', 'b.md'), '# B\n');
    const project = await setupProject({ notesRoots: [{ id: 'docs', path: 'docs' }, { id: 'wiki', path: 'wiki' }] });
    expect(await listNoteIds(withLimits(project, { maxDirectoryEntries: 3 }))).toEqual(['docs/index.md', 'wiki/a.md', 'wiki/b.md']);
    await expectVaultError(() => listNoteIds(withLimits(project, { maxDirectoryEntries: 2 })), 'LIMIT_EXCEEDED');
  });

  it('rejects directory nesting deeper than maxDepth before descending into it', async () => {
    const project = await setupProject();
    const deep = path.join(projectDir, 'docs', 'l1', 'l2', 'l3');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'deep.md'), '# Deep\n');
    expect(await listNoteIds(withLimits(project, { maxDepth: 3 }))).toEqual(['docs/index.md', 'docs/l1/l2/l3/deep.md']);
    const error = await expectVaultError(() => listNoteIds(withLimits(project, { maxDepth: 2 })), 'LIMIT_EXCEEDED');
    expect(error.message).toContain('maxDepth');
  });

  it('does not count deep nesting inside excluded directories against maxDepth', async () => {
    const project = await setupProject();
    await fs.mkdir(path.join(projectDir, 'docs', 'node_modules', 'a', 'b', 'c', 'd'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'docs', '.hidden', 'a', 'b', 'c', 'd'), { recursive: true });
    expect(await listNoteIds(withLimits(project, { maxDepth: 2 }))).toEqual(['docs/index.md']);
  });

  it('still enforces maxFiles and returns sorted ids under default traversal limits', async () => {
    const project = await setupProject({ limits: { maxFiles: 2 } });
    await fs.writeFile(path.join(projectDir, 'docs', 'b.md'), '# B\n');
    expect(await listNoteIds(project)).toEqual(['docs/b.md', 'docs/index.md']);
    await fs.writeFile(path.join(projectDir, 'docs', 'c.md'), '# C\n');
    await expectVaultError(() => listNoteIds(project), 'LIMIT_EXCEEDED');
  });

  it('releases directory handles after a limit failure so the tree can be removed', async () => {
    const project = await setupProject();
    const docs = path.join(projectDir, 'docs');
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(docs, `f-${i}.txt`), 'x');
    await expectVaultError(() => listNoteIds(withLimits(project, { maxDirectoryEntries: 5 })), 'LIMIT_EXCEEDED');
    // On Windows an open directory handle would make this removal fail with EBUSY/EPERM.
    await fs.rm(docs, { recursive: true, force: false });
    await expect(fs.stat(docs)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
