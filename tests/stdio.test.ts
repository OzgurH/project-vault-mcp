import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const temporary: string[] = [];
const clients: Client[] = [];
const cli = resolve('dist/src/cli.js');

function run(...args: string[]) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

async function fixture(writable = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-stdio-')));
  temporary.push(root);
  run('init', '--root', root, '--apply');
  if (writable) {
    const configPath = join(root, 'project-vault.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.allowWrites = true;
    await writeFile(configPath, JSON.stringify(config));
  }
  return root;
}

async function connect(root: string, flag = false) {
  const client = new Client({ name: 'project-vault-acceptance', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'serve', '--root', root, ...(flag ? ['--allow-write'] : [])],
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

function payload(result: any): any {
  if (result.structuredContent) return result.structuredContent;
  const block = result.content?.find((part: any) => part.type === 'text');
  return JSON.parse(block.text);
}

beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'pipe' });
}, 60_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('compiled CLI through the official SDK stdio client', () => {
  it('initializes valid notes, discovers read tools and returns current revisions', async () => {
    const root = await fixture();
    expect(() => run('check', '--root', root, '--json')).not.toThrow();
    const client = await connect(root);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain('search_notes');
    expect(tools).toContain('read_note');
    expect(tools).not.toContain('create_note');
    const read = payload(await client.callTool({ name: 'read_note', arguments: { note_id: 'docs/index.md' } }));
    expect(read.diskRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(read.content).toContain('#');
    const result = await client.callTool({ name: 'search_notes', arguments: { query: 'architecture' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(payload(result))).toContain('docs/');
  });

  it('requires both write gates, previews then creates, updates and rejects stale revisions', async () => {
    const root = await fixture(true);
    const gated = await connect(root, false);
    expect((await gated.listTools()).tools.map(tool => tool.name)).not.toContain('update_note');
    const client = await connect(root, true);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('create_note');
    const noteId = 'docs/decisions/0001-example.md';
    const args = { note_id: noteId, content: '# Example decision\n\nA testable reason.\n' };
    const preview = payload(await client.callTool({ name: 'create_note', arguments: args }));
    expect(preview.applied).toBe(false);
    await expect(readFile(join(root, 'docs/decisions/0001-example.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const created = payload(await client.callTool({ name: 'create_note', arguments: { ...args, apply: true } }));
    expect(created.applied).toBe(true);
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
    const updated = await client.callTool({ name: 'update_note', arguments: {
      note_id: noteId, content: '# Example decision\n\nUpdated rationale.\n',
      expected_revision: created.revision, apply: true,
    } });
    expect(updated.isError).not.toBe(true);
    const stale = await client.callTool({ name: 'update_note', arguments: {
      note_id: noteId, content: '# Incorrect overwrite\n', expected_revision: created.revision, apply: true,
    } });
    expect(stale.isError).toBe(true);
    expect(await readFile(join(root, 'docs/decisions/0001-example.md'), 'utf8')).toContain('Updated rationale');
    const duplicate = await client.callTool({ name: 'create_note', arguments: { ...args, apply: true } });
    expect(duplicate.isError).toBe(true);
    const escape = await client.callTool({ name: 'read_note', arguments: { note_id: 'docs/../../project-vault.json' } });
    expect(escape.isError).toBe(true);
  });
});
