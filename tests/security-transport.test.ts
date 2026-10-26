import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { defaultConfig, loadProject } from '../src/core/config.js';
import { VaultError } from '../src/core/errors.js';
import { RequestSecurity, type AuditEvent } from '../src/mcp/security.js';
import { createServer } from '../src/mcp/server.js';
import type { Project } from '../src/core/types.js';
import { initProject } from '../src/cli/init.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<Project> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-security-'))); roots.push(root);
  await mkdir(path.join(root, 'docs'));
  const config = defaultConfig('security-fixture'); config.allowWrites = true;
  const configPath = path.join(root, 'project-vault.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(root, 'docs/index.md'), '# Index\n\nSensitive fixture text.\n');
  return { root, configPath, config };
}

describe('request capability boundary', () => {
  it('pins the configuration used by loadProject even if changed before server construction', async () => {
    const project = await fixture(); const loaded = await loadProject(project.root);
    await writeFile(project.configPath, JSON.stringify({ ...project.config, allowWrites: false }));
    const security = new RequestSecurity(loaded, () => {});
    await expect(security.run('update_note', async () => 'must not execute')).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
  });

  it.skipIf(process.platform === 'win32')('creates owner-only scaffold files and directories on POSIX', async () => {
    const project = await fixture(); const newRoot = path.join(project.root, 'new-project');
    const result = await initProject(newRoot, true);
    for (const item of result.created) {
      const entry = await stat(path.join(newRoot, item));
      expect(entry.mode & 0o777).toBe(entry.isDirectory() ? 0o700 : 0o600);
    }
  });

  it('denies every operation after policy change or loss, without running its body', async () => {
    const project = await fixture(); const events: AuditEvent[] = [];
    const security = new RequestSecurity(project, e => events.push(e));
    expect(await security.run('read_note', async () => 1)).toBe(1);
    await writeFile(project.configPath, JSON.stringify({ ...project.config, allowWrites: false }));
    let executed = false;
    await expect(security.run('update_note', async () => { executed = true; })).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    expect(executed).toBe(false);
    await rm(project.configPath);
    await expect(security.run('get_note_template', async () => 'template')).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    expect(events.slice(1).every(e => e.outcome === 'denied')).toBe(true);
  });

  it('bounds concurrent work and releases capacity after a failed body', async () => {
    const project = await fixture(); project.config.security!.maxConcurrentRequests = 1;
    const security = new RequestSecurity(project, () => {});
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const first = security.run('read_note', async () => { started(); await blocked; });
    await entered;
    await expect(security.run('read_note', async () => 2)).rejects.toMatchObject({ code: 'SERVER_BUSY' });
    release(); await first;
    await expect(security.run('read_note', async () => { throw new Error('internal'); })).rejects.toThrow('internal');
    expect(await security.run('read_note', async () => 3)).toBe(3);
  });

  it('bounds requests and audit volume without retaining argument or error text', async () => {
    const project = await fixture(); project.config.security!.maxRequestsPerMinute = 2;
    const events: AuditEvent[] = []; const security = new RequestSecurity(project, e => events.push(e));
    await expect(security.run('read_note', async () => { throw new VaultError('PRIVATE_NOTE', 'never-log-secret-query-or-path'); })).rejects.toThrow();
    await security.run('update_note', async () => ({ applied: true }));
    for (let i = 0; i < 20; i++) await expect(security.run('search_notes', async () => 'never-run')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(events).toHaveLength(4);
    expect(events[1]!.outcome).toBe('applied');
    expect(JSON.stringify(events)).not.toContain('never-log');
    expect(JSON.stringify(events)).not.toContain(project.root);
    expect(Object.keys(events[0]!).sort()).toEqual(['code', 'durationMs', 'event', 'outcome', 'requestId', 'timestamp', 'tool']);
  });

  it('allows audit opt-out and isolates a failing diagnostic sink from applied work', async () => {
    const project = await fixture(); project.config.security!.audit = false;
    let calls = 0;
    const disabled = new RequestSecurity(project, () => { calls++; });
    await disabled.run('read_note', async () => 1); expect(calls).toBe(0);
    project.config.security!.audit = true;
    const broken = new RequestSecurity(project, () => { throw new Error('collector down'); });
    expect(await broken.run('update_note', async () => ({ applied: true }))).toEqual({ applied: true });
  });

  it('enforces revocation through real SDK tools and keeps audit events metadata-only', async () => {
    const project = await fixture(); const events: AuditEvent[] = [];
    const server = createServer(project, { allowWrite: true, auditSink: e => events.push(e) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'security-regression', version: '1.0.0' });
    await server.connect(st); await client.connect(ct);
    try {
      const read = await client.callTool({ name: 'read_note', arguments: { note_id: 'docs/index.md' } });
      expect(read.isError).toBeFalsy();
      const created = await client.callTool({ name: 'create_note', arguments: { note_id: 'docs/created.md', content: '# Safe\n', apply: true } });
      expect(created.isError).toBeFalsy();
      expect(events.at(-1)?.outcome).toBe('applied');
      await writeFile(project.configPath, JSON.stringify({ ...project.config, exclude: ['**'] }));
      for (const [name, args] of [['search_notes', { query: 'Sensitive' }], ['get_project_context', {}], ['create_note', { note_id: 'docs/blocked.md', content: '# Blocked', apply: true }]] as const) {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response.content)).toContain('POLICY_CHANGED');
        expect(JSON.stringify(response.content)).not.toContain('Sensitive fixture text');
      }
      expect(JSON.stringify(events)).not.toContain('docs/');
      expect(JSON.stringify(events)).not.toContain('Sensitive');
      expect(await readFile(path.join(project.root, 'docs/created.md'), 'utf8')).toBe('# Safe\n');
    } finally { await client.close(); await server.close(); }
  });

  it('rejects unknown security keys and unsafe budget values in configuration', async () => {
    const project = await fixture();
    for (const security of [{ audit: 'false' }, { maxConcurrentRequests: 0 }, { maxRequestsPerMinute: 10001 }, { secret: true }]) {
      await writeFile(project.configPath, JSON.stringify({ ...project.config, security }));
      await expect(loadProject(project.root)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  it('rejects an applied mutation before writing when its acknowledgement cannot fit', async () => {
    const project = await fixture(); project.config.limits.maxResponseChars = 100;
    const server = createServer(project, { allowWrite: true, auditSink: () => {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'small-budget', version: '1.0.0' });
    await server.connect(st); await client.connect(ct);
    try {
      const id = 'docs/' + 'long-name-'.repeat(12) + '.md';
      const response = await client.callTool({ name: 'create_note', arguments: { note_id: id, content: '# Safe', apply: true } });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('RESPONSE_TOO_LARGE');
      await expect(stat(path.join(project.root, id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await client.close(); await server.close(); }
  });
});
