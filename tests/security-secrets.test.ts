import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { readNoteFile } from '../src/core/files.js';
import { writeNote } from '../src/core/writes.js';
import { KnowledgeBase } from '../src/core/knowledge.js';
import type { Project } from '../src/core/types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<Project> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-credentials-'))); roots.push(root);
  await mkdir(path.join(root, 'docs')); const config = defaultConfig('credential-fixture'); config.allowWrites = true;
  const configPath = path.join(root, 'project-vault.json'); await writeFile(configPath, JSON.stringify(config));
  return { root, configPath, config };
}
const signatures = ['ghp_' + 'A'.repeat(36), 'AKIA' + 'Z'.repeat(16), ['-----BEGIN ', 'PRIVATE KEY-----'].join('')];

describe('recognized credential exposure guard', () => {
  it.each(signatures)('denies known signatures in reads, retrieval, previews and writes (%#)', async (secret) => {
    const project = await fixture(); const target = path.join(project.root, 'docs/index.md');
    await writeFile(target, '# Credentials\n\n' + secret);
    await expect(readNoteFile(project, 'docs/index.md')).rejects.toMatchObject({ code: 'CONTENT_RESTRICTED' });
    const kb = new KnowledgeBase(project);
    expect(await kb.search('Credentials')).toEqual([]);
    expect((await kb.context()).excerpts).toEqual([]);
    expect(kb.status().diagnostics.some(d => d.code === 'NOTE_UNREADABLE')).toBe(false);
    expect(JSON.stringify((await kb.check()).diagnostics)).not.toContain(secret);
    for (const dryRun of [true, false]) await expect(writeNote(project, 'docs/new.md', '# Key\n' + secret, { expectedRevision: null, dryRun })).rejects.toMatchObject({ code: 'CONTENT_RESTRICTED' });
    expect(await readFile(target, 'utf8')).toContain(secret);
  });

  it('allows ordinary technical text and a deliberate owner-configured opt-out', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'docs/index.md'), '# Design\nA credential belongs in a secret manager.');
    expect((await readNoteFile(project, 'docs/index.md')).content).toContain('secret manager');
    project.config.security!.blockSecrets = false;
    await writeFile(path.join(project.root, 'docs/index.md'), '# Example\n' + signatures[0]);
    expect((await readNoteFile(project, 'docs/index.md')).content).toContain(signatures[0]);
  });
});
