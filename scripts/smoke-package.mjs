/** Exercise the actual release artifact, not the development source tree. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execute = promisify(execFile);
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'project-vault-package-')));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run smoke:package.');
let client;

function data(result) {
  assert(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find(part => part.type === 'text').text);
}

try {
  const packed = await execute(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: resolve('.') });
  const [manifest] = JSON.parse(packed.stdout);
  assert(manifest.files.some(file => file.path === 'dist/src/cli.js'));
  for (const file of manifest.files) {
    assert(!/(^|\/)(?:\.local|\.worktrees|node_modules|tests|\.env)(\/|$)/u.test(file.path), `Unexpected package file: ${file.path}`);
    assert(!file.path.startsWith('src/'), 'Development TypeScript is not a release dependency.');
  }
  const install = join(scratch, 'installed');
  await execute(process.execPath, [npmCli, 'install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, manifest.filename)]);
  const cli = join(install, 'node_modules/project-vault-mcp/dist/src/cli.js');
  const project = join(scratch, 'example-project');
  await execute(process.execPath, [cli, 'init', '--root', project]);
  await assert.rejects(access(project), 'Initialization preview must not create a project directory.');
  await execute(process.execPath, [cli, 'init', '--root', project, '--apply']);
  await execute(process.execPath, [cli, 'check', '--root', project, '--json']);
  const configPath = join(project, 'project-vault.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.allowWrites = true;
  await writeFile(configPath, JSON.stringify(config));

  client = new Client({ name: 'release-package-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'serve', '--root', project, '--allow-write'],
    stderr: 'pipe',
  }));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['search_notes', 'read_note', 'create_note', 'update_note']) assert(tools.includes(name), `Missing ${name}`);
  const noteId = 'docs/decisions/0001-package.md';
  const created = data(await client.callTool({ name: 'create_note', arguments: {
    note_id: noteId, content: '# Package decision\n\nVerified from the release artifact.\n', apply: true,
  } }));
  assert(created.applied);
  const read = data(await client.callTool({ name: 'read_note', arguments: { note_id: noteId } }));
  assert.equal(read.diskRevision, created.revision);
  const updated = data(await client.callTool({ name: 'update_note', arguments: {
    note_id: noteId, content: '# Package decision\n\nUpdated through stdio.\n', expected_revision: read.diskRevision, apply: true,
  } }));
  assert(updated.applied);
  const stale = await client.callTool({ name: 'update_note', arguments: {
    note_id: noteId, content: '# Stale\n', expected_revision: read.diskRevision, apply: true,
  } });
  assert(stale.isError, 'Stale revisions must fail.');
  assert((await readFile(join(project, 'docs/decisions/0001-package.md'), 'utf8')).includes('Updated through stdio.'));
  console.log(`Package smoke passed: ${manifest.filename}; ${manifest.files.length} allowed files; SDK stdio create/read/update/conflict verified.`);
} finally {
  if (client) await client.close();
  await rm(scratch, { recursive: true, force: true });
}
