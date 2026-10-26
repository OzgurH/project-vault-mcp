import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../src/core/config.js';
import { VaultError } from '../src/core/errors.js';
import { applyWindowsSecurity, captureFileSecurity, captureWindowsSecurity } from '../src/core/file-security.js';
import { readNoteFile } from '../src/core/files.js';
import { lockPathFor, writeNote } from '../src/core/writes.js';
import type { Project } from '../src/core/types.js';

const isWindows = process.platform === 'win32';
const isRoot = !isWindows && typeof process.getuid === 'function' && process.getuid() === 0;

let tmpBase: string;
let projectDir: string;
let fakeHome: string;

async function setupProject(): Promise<Project> {
  await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'docs', 'index.md'), '# Index\n', 'utf8');
  await fs.writeFile(path.join(projectDir, 'project-vault.json'), JSON.stringify({ schemaVersion: 1, name: 'test', allowWrites: true }), 'utf8');
  return loadProject(projectDir);
}

async function expectVaultError(promise: Promise<unknown>, code: string): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe(code);
    return error as VaultError;
  }
  throw new Error(`Expected VaultError ${code} but the call succeeded`);
}

const modeOf = async (p: string): Promise<number> => (await fs.stat(p)).mode & 0o777;

/**
 * Runs `inspect` each time the writer re-opens the target for reading inside its lock. The first
 * re-read happens after the lock JSON is written, the second after the staging file is flushed, so
 * the inspection points are deterministic rather than timing-based.
 */
function onTargetReopen(target: string, inspect: (reopenIndex: number) => Promise<void>): void {
  const realOpen = fs.open.bind(fs);
  let reopens = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
    if (p === target && flags === 'r') await inspect(reopens++);
    return realOpen(p as string, flags as never, mode as never);
  });
}

async function tempFilesIn(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.includes('.pv-tmp-')).map((name) => path.join(dir, name));
}

function powershell(script: string, env: Record<string, string>): Promise<string> {
  const exe = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...env }, timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

/** Gives a file a protected DACL with a single full-control ACE for the current user. */
async function restrictToCurrentUser(filePath: string): Promise<void> {
  await powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      '$info = New-Object System.IO.FileInfo($env:PV_TEST_PATH)',
      "$acl = $info.GetAccessControl('Access')",
      '$acl.SetAccessRuleProtection($true, $false)',
      'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }',
      '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))",
      '$info.SetAccessControl($acl)',
    ].join('\n'),
    { PV_TEST_PATH: filePath },
  );
}

beforeEach(async () => {
  tmpBase = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-security-')));
  projectDir = path.join(tmpBase, 'project');
  fakeHome = path.join(tmpBase, 'home');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(fakeHome, { recursive: true });
  const real = os.userInfo();
  vi.spyOn(os, 'userInfo').mockReturnValue({ ...real, homedir: fakeHome });
  if (!isWindows) process.umask(0o022);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpBase, { recursive: true, force: true });
});

describe('lock files', () => {
  it('names only the owning process and never the note identifier', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs', 'index.md');
    const lockPath = lockPathFor(target);
    expect(lockPath.startsWith(fakeHome)).toBe(true);
    const note = await readNoteFile(project, 'docs/index.md');
    const samples: { content: string; mode: number }[] = [];
    onTargetReopen(target, async () => {
      samples.push({ content: await fs.readFile(lockPath, 'utf8'), mode: await modeOf(lockPath) });
    });
    await writeNote(project, 'docs/index.md', '# Index\n\nChanged\n', { expectedRevision: note.revision, dryRun: false });
    expect(samples.length).toBe(2);
    for (const sample of samples) {
      const parsed = JSON.parse(sample.content) as Record<string, unknown>;
      expect(parsed['pid']).toBe(process.pid);
      expect(typeof parsed['createdAt']).toBe('string');
      expect(Object.keys(parsed).sort()).toEqual(['createdAt', 'pid']);
      expect(sample.content).not.toContain('index.md');
      if (!isWindows) expect(sample.mode).toBe(0o600);
    }
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(isWindows)('creates owner-only lock directories despite a permissive umask', async () => {
    const project = await setupProject();
    await writeNote(project, 'docs/new.md', '# New\n', { expectedRevision: null, dryRun: false });
    const lockDir = path.dirname(lockPathFor(path.join(projectDir, 'docs', 'new.md')));
    expect(await modeOf(lockDir)).toBe(0o700);
    expect(await modeOf(path.dirname(lockDir))).toBe(0o700);
  });
});

describe.skipIf(isWindows)('POSIX permissions', () => {
  it('creates new notes owner-only even with umask 022', async () => {
    const project = await setupProject();
    await writeNote(project, 'docs/new.md', '# New\n', { expectedRevision: null, dryRun: false });
    expect(await modeOf(path.join(projectDir, 'docs', 'new.md'))).toBe(0o600);
  });

  it('keeps a 0600 note at 0600 and never exposes a wider staging file', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs', 'index.md');
    await fs.chmod(target, 0o600);
    const note = await readNoteFile(project, 'docs/index.md');
    const stagingModes: number[] = [];
    onTargetReopen(target, async (reopen) => {
      const temps = await tempFilesIn(path.dirname(target));
      // Before staging nothing exists; after the flush exactly one staging file must be present.
      expect(temps.length).toBe(reopen === 0 ? 0 : 1);
      for (const temp of temps) stagingModes.push(await modeOf(temp));
    });
    await writeNote(project, 'docs/index.md', '# Index\n\nChanged\n', { expectedRevision: note.revision, dryRun: false });
    expect(stagingModes).toEqual([0o600]);
    expect(await modeOf(target)).toBe(0o600);
    expect(await tempFilesIn(path.dirname(target))).toEqual([]);
  });

  it('preserves a 0640 mode and ownership that the umask would otherwise rewrite', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs', 'index.md');
    await fs.chmod(target, 0o640);
    const before = await fs.stat(target);
    const note = await readNoteFile(project, 'docs/index.md');
    const result = await writeNote(project, 'docs/index.md', '# Changed\n', { expectedRevision: note.revision, dryRun: false });
    expect(result.applied).toBe(true);
    const after = await fs.stat(target);
    expect(after.mode & 0o777).toBe(0o640);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(await fs.readFile(target, 'utf8')).toBe('# Changed\n');
  });

  it.skipIf(isRoot)('fails closed and keeps the original bytes when ownership cannot be preserved', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs', 'index.md');
    await fs.chmod(target, 0o600);
    const original = await fs.readFile(target);
    const note = await readNoteFile(project, 'docs/index.md');
    const realStat = fs.stat.bind(fs);
    // Pretend the note belongs to another account; a non-root process cannot chown to it.
    vi.spyOn(fs, 'stat').mockImplementation(async (p, opts) => {
      const stats = await realStat(p as string, opts as never);
      if (p === target) Object.defineProperty(stats, 'uid', { value: (stats as { uid: number }).uid + 1 });
      return stats;
    });
    const error = await expectVaultError(writeNote(project, 'docs/index.md', '# Hijack\n', { expectedRevision: note.revision, dryRun: false }), 'SECURITY_METADATA');
    expect(error.message).toContain('left unchanged');
    vi.restoreAllMocks();
    expect(await fs.readFile(target)).toEqual(original);
    expect(await modeOf(target)).toBe(0o600);
    expect(await tempFilesIn(path.dirname(target))).toEqual([]);
  });
});

describe.skipIf(!isWindows)('Windows DACL preservation', () => {
  it('preserves the exact inherited descriptor when staging already has the required security', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs/index.md');
    const [before] = await captureWindowsSecurity(target);
    const note = await readNoteFile(project, 'docs/index.md');
    expect((await writeNote(project, 'docs/index.md', '# Inherited update\n', { expectedRevision: note.revision, dryRun: false })).applied).toBe(true);
    const [after] = await captureWindowsSecurity(target);
    expect(after).toBe(before);
    expect(await fs.readFile(target, 'utf8')).toBe('# Inherited update\n');
  });

  it('returns a successful exit code from the standalone ACL preflight', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('scripts/diagnose-windows-acl.mjs')],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.markers).toEqual(['started', 'constructed', 'read', 'done']);
  });

  it('replaces a note with a protected DACL without inheriting the folder ACL', async () => {
    const project = await setupProject();
    const target = path.join(projectDir, 'docs', 'index.md');
    await restrictToCurrentUser(target);
    const [restricted] = await captureWindowsSecurity(target);
    expect(restricted).toMatch(/D:P/);
    // Prove the folder ACL differs, so inheriting it would have widened access.
    const sibling = path.join(projectDir, 'docs', 'sibling.md');
    await fs.writeFile(sibling, '# Sibling\n', 'utf8');
    const [inherited] = await captureWindowsSecurity(sibling);
    expect(inherited).not.toBe(restricted);

    const note = await readNoteFile(project, 'docs/index.md');
    const result = await writeNote(project, 'docs/index.md', '# Changed\n', { expectedRevision: note.revision, dryRun: false });
    expect(result.applied).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('# Changed\n');
    const [after] = await captureWindowsSecurity(target);
    expect(after).toBe(restricted);
    expect(await captureFileSecurity(target)).toEqual({ kind: 'windows', sddl: restricted });
    expect(await tempFilesIn(path.dirname(target))).toEqual([]);
  }, 60_000);

  it('rejects malformed descriptors and unreadable targets without touching files', async () => {
    const target = path.join(tmpBase, 'plain.md');
    await fs.writeFile(target, '# Plain\n', 'utf8');
    const [before] = await captureWindowsSecurity(target);
    await expectVaultError(applyWindowsSecurity(target, 'D:(A;;FA;;;WD); Remove-Item *'), 'SECURITY_METADATA');
    await expectVaultError(captureFileSecurity(path.join(tmpBase, 'missing.md')), 'SECURITY_METADATA');
    const [after] = await captureWindowsSecurity(target);
    expect(after).toBe(before);
    expect(await fs.readFile(target, 'utf8')).toBe('# Plain\n');
  }, 60_000);
});
