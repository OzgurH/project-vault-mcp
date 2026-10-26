import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Project, VaultConfig } from '../src/core/types.js';
import { createServer } from '../src/mcp/server.js';
import { initProject } from '../src/cli/init.js';
import { main } from '../src/cli.js';
import * as publicApi from '../src/index.js';

const READ_TOOLS = ['search_notes', 'read_note', 'get_note_links', 'get_project_context', 'get_knowledge_status', 'get_note_template'];
const WRITE_TOOLS = ['create_note', 'update_note'];

function fixtureConfig(allowWrites: boolean): VaultConfig {
  return {
    schemaVersion: 1,
    name: 'fixture',
    notesRoots: [{ id: 'docs', path: 'docs' }],
    entryNotes: ['docs/index.md'],
    exclude: [],
    sourceRoots: [],
    searchLocale: 'default',
    allowWrites,
    limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1048576, maxResponseChars: 20000, maxQueryChars: 200, rescanIntervalMs: 0 }
  };
}

async function makeVault(allowWrites: boolean): Promise<Project> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-transport-')));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const config = fixtureConfig(allowWrites);
  const configPath = path.join(root, 'project-vault.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'index.md'), '# Fixture index\n\nThe payment gateway handles checkout.\n', 'utf8');
  return { root, configPath, config };
}

async function connect(project: Project, allowWrite?: boolean) {
  const server = createServer(project, allowWrite === undefined ? undefined : { allowWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'transport-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

type Call = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Call> {
  return (await client.callTool({ name, arguments: args })) as Call;
}

function textJson(result: Call): Record<string, unknown> {
  const text = result.content.find((c) => c.type === 'text')?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true });
});

describe('createServer tool registration', () => {
  it('registers only read tools with read-only annotations by default', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.description).toMatch(/untrusted/i);
    }
    await close();
  });

  it('does not register writes when the flag is set but config forbids writes', async () => {
    const project = await makeVault(false); temps.push(project.root);
    const { client, close } = await connect(project, true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('create_note');
    expect(names).not.toContain('update_note');
    await close();
  });

  it('does not register writes when config allows but the flag is absent', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project, false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => WRITE_TOOLS.includes(n))).toBe(false);
    await close();
  });

  it('registers truthful mutation annotations when both gates allow writes', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project, true);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const create = tools.find((t) => t.name === 'create_note')!;
    const update = tools.find((t) => t.name === 'update_note')!;
    expect(create.annotations?.readOnlyHint).toBe(false);
    expect(create.annotations?.destructiveHint).toBe(false);
    expect(create.annotations?.idempotentHint).toBe(false);
    expect(update.annotations?.readOnlyHint).toBe(false);
    expect(update.annotations?.destructiveHint).toBe(true);
    expect(update.annotations?.idempotentHint).toBe(false);
    expect(Object.keys(create.inputSchema.properties ?? {}).sort()).toEqual(['apply', 'content', 'note_id']);
    expect(Object.keys(update.inputSchema.properties ?? {}).sort()).toEqual(['apply', 'content', 'expected_revision', 'note_id']);
    await close();
  });
});

describe('read tools', () => {
  it('returns an escaped long line within the serialized response budget', async () => {
    const project = await makeVault(false); temps.push(project.root);
    project.config.limits.maxResponseChars = 300;
    await writeFile(path.join(project.root, 'docs/index.md'), '# Escapes\n' + '\t'.repeat(1000), 'utf8');
    const { client, close } = await connect(project);
    const result = await call(client, 'read_note', { note_id: 'docs/index.md', start_line: 2, line_count: 1 });
    expect(result.isError).toBeFalsy();
    const body = textJson(result);
    expect(body.truncated).toBe(true);
    expect(String(body.content).length).toBeGreaterThan(0);
    expect(result.content[0]!.text!.length).toBeLessThanOrEqual(600);
    expect(body.endLine).toBe(2);
    await close();
  });

  it('read_note returns bounded JSON text plus structuredContent', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project);
    const result = await call(client, 'read_note', { note_id: 'docs/index.md' });
    expect(result.isError).toBeFalsy();
    const body = textJson(result);
    expect(body.noteId).toBe('docs/index.md');
    expect(String(body.content)).toContain('payment gateway');
    expect(String(body.diskRevision)).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent?.noteId).toBe('docs/index.md');
    await close();
  });

  it('search_notes finds a note and respects schema bounds', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project);
    const ok = await call(client, 'search_notes', { query: 'payment', limit: 5 });
    expect(ok.isError).toBeFalsy();
    const hits = textJson(ok).hits as { noteId: string }[];
    expect(hits.some((h) => h.noteId === 'docs/index.md')).toBe(true);
    for (const bad of [{ query: 'x', limit: 500 }, { query: 'q'.repeat(201) }, { query: '' }]) {
      const rejected = await call(client, 'search_notes', bad).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
      expect(rejected.isError).toBe(true);
    }
    await close();
  });

  it('missing note yields a typed VaultError code and no stack trace', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project);
    const result = await call(client, 'read_note', { note_id: 'docs/missing.md' });
    expect(result.isError).toBe(true);
    const body = textJson(result) as { error: { code: string; message: string } };
    expect(body.error.code).toMatch(/^[A-Z_]+$/);
    expect(body.error.message).not.toMatch(/\bat\s+\S+:\d+/);
    expect(body.error.message).not.toContain(project.root);
    await close();
  });

  it('template, links, context and status tools answer', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project);
    const tpl = textJson(await call(client, 'get_note_template', { type: 'adr' }));
    expect(tpl.type).toBe('adr');
    expect(String(tpl.template).length).toBeGreaterThan(0);
    const badTpl = await call(client, 'get_note_template', { type: 'shell' }).catch(() => ({ isError: true, content: [] }));
    expect(badTpl.isError).toBe(true);
    const links = await call(client, 'get_note_links', { note_id: 'docs/index.md' });
    expect(links.isError).toBeFalsy();
    expect(textJson(links).noteId).toBe('docs/index.md');
    const missingLinks = await call(client, 'get_note_links', { note_id: 'docs/absent.md' });
    expect(missingLinks.isError).toBe(true);
    const ctx = await call(client, 'get_project_context', { topic: 'payment', max_chars: 2000 });
    expect(ctx.isError).toBeFalsy();
    const status = textJson(await call(client, 'get_knowledge_status', {}));
    expect(status.project).toBe('fixture');
    expect(typeof status.files).toBe('number');
    await close();
  });
});

describe('write tools', () => {
  it('create_note previews without writing and applies on request; update requires exact revision', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const { client, close } = await connect(project, true);
    const target = path.join(project.root, 'docs', 'new.md');
    const preview = await call(client, 'create_note', { note_id: 'docs/new.md', content: '# New\n\nBody.\n' });
    expect(preview.isError).toBeFalsy();
    expect(textJson(preview).applied).toBe(false);
    await expect(stat(target)).rejects.toThrow();

    const applied = textJson(await call(client, 'create_note', { note_id: 'docs/new.md', content: '# New\n\nBody.\n', apply: true }));
    expect(applied.applied).toBe(true);
    expect(applied.created).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('# New\n\nBody.\n');
    const revision = applied.revision as string;
    expect(revision).toBe(sha256('# New\n\nBody.\n'));

    const duplicate = await call(client, 'create_note', { note_id: 'docs/new.md', content: 'x', apply: true });
    expect(duplicate.isError).toBe(true);

    const search = textJson(await call(client, 'search_notes', { query: 'Body' })).hits as { noteId: string }[];
    expect(search.some((h) => h.noteId === 'docs/new.md')).toBe(true);

    const malformed = await call(client, 'update_note', { note_id: 'docs/new.md', content: 'y', expected_revision: 'not-a-sha' }).catch(() => ({ isError: true, content: [] }));
    expect(malformed.isError).toBe(true);
    const stale = await call(client, 'update_note', { note_id: 'docs/new.md', content: 'y', expected_revision: 'a'.repeat(64) });
    expect(stale.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('# New\n\nBody.\n');

    const updPreview = textJson(await call(client, 'update_note', { note_id: 'docs/new.md', content: '# New\n\nChanged.\n', expected_revision: revision }));
    expect(updPreview.applied).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('# New\n\nBody.\n');
    const upd = textJson(await call(client, 'update_note', { note_id: 'docs/new.md', content: '# New\n\nChanged.\n', expected_revision: revision, apply: true }));
    expect(upd.applied).toBe(true);
    expect(upd.previousRevision).toBe(revision);
    expect(await readFile(target, 'utf8')).toBe('# New\n\nChanged.\n');
    await close();
  });
});

describe('initProject', () => {
  it('preview creates nothing and lists the plan', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-init-'))); temps.push(parent);
    const root = path.join(parent, 'fresh');
    const r = await initProject(root);
    expect(r.applied).toBe(false);
    expect(r.created).toEqual([]);
    expect(r.planned).toContain('project-vault.json');
    expect(r.planned).toContain('docs/architecture/overview.md');
    await expect(stat(root)).rejects.toThrow();
  });

  it('apply creates the layout exclusively and never overwrites', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-init-'))); temps.push(parent);
    const root = path.join(parent, 'fresh');
    const r = await initProject(root, true);
    expect(r.applied).toBe(true);
    expect(r.created).toContain('project-vault.json');
    expect(r.created).toContain('docs/index.md');
    for (const d of ['docs/architecture', 'docs/modules', 'docs/decisions', 'docs/runbooks']) expect((await stat(path.join(root, d))).isDirectory()).toBe(true);
    const cfg = JSON.parse(await readFile(path.join(root, 'project-vault.json'), 'utf8')) as VaultConfig;
    expect(cfg.name).toBe('fresh');
    expect(cfg.schemaVersion).toBe(1);
    const again = await initProject(root, true);
    expect(again.created).toEqual([]);
    expect(again.existing).toContain('project-vault.json');
    expect(again.planned).toEqual([]);
  });

  it('adopts an existing custom config without creating guessed defaults', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-adopt-'))); temps.push(root);
    const custom = '{ "schemaVersion": 1, "name": "custom", "notesRoots": [{ "id": "wiki", "path": "wiki" }] }\n';
    await writeFile(path.join(root, 'project-vault.json'), custom, 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'keep me\n', 'utf8');
    const r = await initProject(root, true);
    expect(r.applied).toBe(false);
    expect(r.created).toEqual([]);
    expect(r.existing).toEqual(['project-vault.json']);
    expect(await readFile(path.join(root, 'project-vault.json'), 'utf8')).toBe(custom);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('keep me\n');
    expect((await readdir(root)).sort()).toEqual(['AGENTS.md', 'project-vault.json']);
  });

  it('keeps existing files untouched and only fills gaps', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-gap-'))); temps.push(root);
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'index.md'), '# Mine\n', 'utf8');
    const r = await initProject(root, true);
    expect(r.existing).toContain('docs/index.md');
    expect(r.created).not.toContain('docs/index.md');
    expect(await readFile(path.join(root, 'docs', 'index.md'), 'utf8')).toBe('# Mine\n');
  });

  it('rejects a symlinked root', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-sym-'))); temps.push(parent);
    const real = path.join(parent, 'real');
    await mkdir(real);
    const link = path.join(parent, 'link');
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(initProject(link, true)).rejects.toMatchObject({ name: 'VaultError' });
    expect(await readdir(real)).toEqual([]);
  });
});

describe('CLI main', () => {
  let out: string[]; let err: string[];
  beforeEach(() => {
    out = []; err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write);
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints help and version', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main(['help'])).toBe(0);
    expect(out.join('')).toMatch(/serve --root/);
  });

  it('fails on unknown commands, options and stray arguments', async () => {
    const project = await makeVault(true); temps.push(project.root);
    expect(await main(['frobnicate'])).not.toBe(0);
    expect(await main(['check', '--root', project.root, '--bogus'])).not.toBe(0);
    expect(await main(['check', '--root', project.root, 'extra'])).not.toBe(0);
    expect(await main(['init'])).not.toBe(0);
    expect(await main(['serve', '--root', project.root, '--apply'])).not.toBe(0);
    expect(err.join('')).toMatch(/--bogus/);
    expect(out.join('')).toBe('');
  });

  it('init previews via CLI without creating files', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'pv-cli-'))); temps.push(parent);
    const root = path.join(parent, 'proj');
    expect(await main(['init', '--root', root])).toBe(0);
    expect(out.join('')).toMatch(/preview/i);
    await expect(stat(root)).rejects.toThrow();
  });

  it('check prints JSON on stdout and exits 1 on diagnostics', async () => {
    const project = await makeVault(true); temps.push(project.root);
    expect(await main(['check', '--root', project.root, '--json'])).toBe(0);
    const parsed = JSON.parse(out.join('')) as { ok: boolean; diagnostics: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
    out.length = 0;
    expect(await main(['check', '--root', project.configPath])).toBe(0);
    expect(out.join('')).toMatch(/ok/i);
    const broken = await makeVault(true); temps.push(broken.root);
    await writeFile(path.join(broken.root, 'docs', 'index.md'), '# Broken\n\n[[nowhere]]\n', 'utf8');
    out.length = 0;
    expect(await main(['check', '--root', broken.root, '--json'])).toBe(1);
    expect((JSON.parse(out.join('')) as { ok: boolean }).ok).toBe(false);
  });

  it('client-config prints the launch command without touching any config', async () => {
    const project = await makeVault(true); temps.push(project.root);
    const before = await readFile(project.configPath, 'utf8');
    expect(await main(['client-config', '--root', project.root])).toBe(0);
    const text = out.join('');
    expect(text).toContain(process.execPath);
    expect(text).toContain(path.join('dist', 'src', 'cli.js'));
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = Object.values(parsed.mcpServers)[0]!;
    expect(entry.command).toBe(process.execPath);
    expect(path.isAbsolute(entry.args[0]!)).toBe(true);
    expect(entry.args.slice(1)).toEqual(['serve', '--root', project.configPath]);
    expect(entry.args).not.toContain('--allow-write');
    expect(await readFile(project.configPath, 'utf8')).toBe(before);
  });
});

describe('public index', () => {
  it('re-exports the documented surface', () => {
    for (const name of ['VaultError', 'loadProject', 'defaultConfig', 'KnowledgeBase', 'createServer', 'writeNote', 'readNoteFile', 'initProject']) {
      expect(typeof (publicApi as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
