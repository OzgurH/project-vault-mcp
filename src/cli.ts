#!/usr/bin/env node
/**
 * Project Vault command line.
 *
 * Protocol traffic goes to stdout only while serving; every diagnostic goes to stderr.
 * `main` is exported for tests and only runs automatically when this file is the entry point.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { VaultError } from './core/errors.js';
import { loadProject } from './core/config.js';
import { KnowledgeBase } from './core/knowledge.js';
import { createServer, SERVER_VERSION } from './mcp/server.js';
import { initProject } from './cli/init.js';

const USAGE = `project-vault ${SERVER_VERSION}

Usage:
  project-vault init --root PATH [--apply]        Preview (default) or create a vault layout
  project-vault serve --root PATH [--allow-write] Run the MCP server over stdio
  project-vault check --root PATH [--json]        Scan the vault; exit 1 on diagnostics
  project-vault client-config --root PATH         Print an example MCP client configuration
  project-vault help | --help | -h                Show this help
  project-vault --version | -v                    Show the version

For serve/check/client-config, --root accepts a directory or a project-vault.json path. For init, use a directory.
`;

const out = (s: string) => { process.stdout.write(s); };
const err = (s: string) => { process.stderr.write(s); };

interface Parsed { root?: string; flags: Set<string> }

class UsageError extends Error {}

function parse(args: string[], allowedFlags: string[]): Parsed {
  const flags = new Set<string>();
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--root') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--root requires a path value.');
      if (root !== undefined) throw new UsageError('--root was given more than once.');
      root = v;
    } else if (a.startsWith('--root=')) {
      if (root !== undefined) throw new UsageError('--root was given more than once.');
      root = a.slice('--root='.length);
    } else if (a.startsWith('-')) {
      if (!allowedFlags.includes(a)) throw new UsageError(`Unknown option "${a}".`);
      flags.add(a);
    } else {
      throw new UsageError(`Unexpected argument "${a}".`);
    }
  }
  if (root === undefined) throw new UsageError('--root PATH is required.');
  return { root, flags };
}

function builtCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const base = path.basename(dir);
    if (base === 'src' || base === 'dist') { dir = path.dirname(dir); continue; }
    break;
  }
  return path.join(dir, 'dist', 'src', 'cli.js');
}

async function serve(root: string, allowWrite: boolean): Promise<number> {
  const project = await loadProject(root);
  const server = createServer(project, { allowWrite });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => { server.server.onclose = () => resolve(); });
  const stop = () => { void server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await server.connect(transport);
  err(`project-vault serving over stdio${allowWrite && project.config.allowWrites ? ' with writes enabled' : ' read-only'}\n`);
  await closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  return 0;
}

async function check(root: string, json: boolean): Promise<number> {
  const project = await loadProject(root);
  const kb = new KnowledgeBase(project);
  const result = await kb.check();
  const status = kb.status();
  const report = { ok: result.ok, project: status.project, configPath: project.configPath, files: status.files, bytes: status.bytes, degraded: status.degraded, diagnostics: result.diagnostics };
  if (json) {
    out(JSON.stringify(report, null, 2) + '\n');
  } else {
    out(`Project: ${report.project}\nConfig: ${report.configPath}\nFiles: ${report.files} (${report.bytes} bytes)\nStatus: ${report.ok ? 'ok' : 'problems found'}\n`);
    for (const d of report.diagnostics) out(`  [${d.code}] ${d.noteId ? d.noteId + ': ' : ''}${d.message}\n`);
  }
  return report.ok ? 0 : 1;
}

async function clientConfig(root: string): Promise<number> {
  const project = await loadProject(root);
  const cli = builtCliPath();
  const config = { mcpServers: { 'project-vault': { command: process.execPath, args: [cli, 'serve', '--root', project.configPath] } } };
  out(`Example MCP client configuration (add --allow-write to args only if you intend to permit note creation and updates):\n\n`);
  out(JSON.stringify(config, null, 2) + '\n\n');
  out(`Command line equivalent:\n  "${process.execPath}" "${cli}" serve --root "${project.configPath}"\n`);
  return 0;
}

async function init(root: string, apply: boolean): Promise<number> {
  const result = await initProject(root, apply);
  if (!result.applied && result.planned.length === 0 && result.existing.includes('project-vault.json')) {
    out(`Existing project-vault.json found at ${path.resolve(root)}; nothing was changed. Edit that file directly to adjust the vault.\n`);
    return 0;
  }
  if (!result.applied) {
    out(`Preview for ${path.resolve(root)} (nothing written; add --apply to create):\n`);
    for (const p of result.planned) out(`  create  ${p}\n`);
    for (const p of result.existing) out(`  keep    ${p}\n`);
    return 0;
  }
  out(`Initialized ${path.resolve(root)}\n`);
  for (const p of result.created) out(`  created ${p}\n`);
  for (const p of result.existing) out(`  kept    ${p}\n`);
  return 0;
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case undefined:
      case 'help': case '--help': case '-h':
        if (rest.length) throw new UsageError(`Unexpected argument "${rest[0]}".`);
        out(USAGE); return 0;
      case '--version': case '-v': case 'version':
        if (rest.length) throw new UsageError(`Unexpected argument "${rest[0]}".`);
        out(`${SERVER_VERSION}\n`); return 0;
      case 'init': { const p = parse(rest, ['--apply']); return await init(p.root as string, p.flags.has('--apply')); }
      case 'serve': { const p = parse(rest, ['--allow-write']); return await serve(p.root as string, p.flags.has('--allow-write')); }
      case 'check': { const p = parse(rest, ['--json']); return await check(p.root as string, p.flags.has('--json')); }
      case 'client-config': { const p = parse(rest, []); return await clientConfig(p.root as string); }
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (e) {
    if (e instanceof UsageError) { err(`error: ${e.message}\n\n${USAGE}`); return 2; }
    if (e instanceof VaultError) { err(`error [${e.code}]: ${e.message}\n`); return 1; }
    err('error: unexpected internal failure\n'); return 1;
  }
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { err('error: unexpected internal failure\n'); process.exitCode = 1; });
}
