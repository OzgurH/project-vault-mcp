/**
 * File security metadata helpers for atomic note replacement.
 *
 * A same-directory temp file that is renamed over an existing note carries its own security
 * metadata into place. Without help, the replacement would get the process umask (POSIX) or the
 * inherited folder ACL (Windows) and silently widen access to a note the user had restricted.
 * These helpers capture the target's metadata, apply it to the staging file, and verify the
 * result so that a mismatch or failure aborts the write before the original is touched.
 *
 * Windows ACLs cannot be managed through Node's fs API (chmod only toggles the read-only
 * attribute), so the Windows path runs a fixed, trusted PowerShell script through execFile with
 * an absolute interpreter path, no shell, and all inputs passed through a scoped child environment.
 * Nothing supplied by a caller is ever interpolated into the script text.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { VaultError } from './errors.js';

/** Security metadata that must survive a replacement. */
export type FileSecurity =
  | { readonly kind: 'posix'; readonly mode: number; readonly uid: number; readonly gid: number }
  | { readonly kind: 'windows'; readonly sddl: string };

/** Owner-only mode used for staging files, lock files and newly created notes on POSIX. */
export const PRIVATE_FILE_MODE = 0o600;
/** Owner-only mode for lock directories. */
export const PRIVATE_DIR_MODE = 0o700;

const POWERSHELL_TIMEOUT_MS = 20_000;
const POWERSHELL_MAX_OUTPUT = 64 * 1024;
const SDDL_PATTERN = /^O:[^:\s]+G:[^:\s]+D:(?:[A-Z]*)(?:\([^()]*\))*$/;

/**
 * Fixed script. Inputs arrive only through PV_SECURITY_* environment variables:
 *   PV_SECURITY_MODE   = capture | apply
 *   PV_SECURITY_PATH   = file whose descriptor is captured or replaced
 *   PV_SECURITY_PATH2  = optional second file to capture (capture mode only)
 *   PV_SECURITY_SDDL   = owner/group/DACL SDDL string to apply (apply mode only)
 * Output is one SDDL string per line covering owner, group and DACL (including the protection flag).
 */
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sections = [System.Security.AccessControl.AccessControlSections]'Owner,Group,Access'",
  'function Read-Sddl([string]$p) {',
  '  $info = New-Object System.IO.FileInfo($p)',
  '  if (-not $info.Exists) { throw "missing file" }',
  '  $acl = $info.GetAccessControl($sections)',
  '  return $acl.GetSecurityDescriptorSddlForm($sections)',
  '}',
  "if ($env:PV_SECURITY_MODE -eq 'capture') {",
  '  [Console]::Out.WriteLine((Read-Sddl $env:PV_SECURITY_PATH))',
  "  if ($env:PV_SECURITY_PATH2) { [Console]::Out.WriteLine((Read-Sddl $env:PV_SECURITY_PATH2)) }",
  "} elseif ($env:PV_SECURITY_MODE -eq 'apply') {",
  '  $info = New-Object System.IO.FileInfo($env:PV_SECURITY_PATH)',
  '  if (-not $info.Exists) { throw "missing file" }',
  '  $sd = New-Object System.Security.AccessControl.FileSecurity',
  '  $sd.SetSecurityDescriptorSddlForm($env:PV_SECURITY_SDDL, $sections)',
  '  $info.SetAccessControl($sd)',
  '  [Console]::Out.WriteLine((Read-Sddl $env:PV_SECURITY_PATH))',
  '} else { throw "unknown mode" }',
].join('\n');

function powershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function securityError(message: string): VaultError {
  return new VaultError('SECURITY_METADATA', message);
}

async function runPowerShell(env: Record<string, string>): Promise<string[]> {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const childEnv: Record<string, string> = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    PATH: path.join(systemRoot, 'System32'),
    PATHEXT: '.EXE',
    TEMP: process.env['TEMP'] ?? systemRoot,
    TMP: process.env['TMP'] ?? systemRoot,
    USERPROFILE: process.env['USERPROFILE'] ?? systemRoot,
    PSModulePath: '',
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', POWERSHELL_SCRIPT],
      { env: childEnv, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: POWERSHELL_MAX_OUTPUT, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(securityError(error.killed
            ? 'Windows file security helper exceeded its deadline; the note was left unchanged'
            : 'Windows file security helper failed; the note was left unchanged'));
          return;
        }
        resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
      },
    );
    // No input is expected. Headless Windows PowerShell hosts can otherwise wait
    // for EOF on the inherited pipe even after the fixed command has finished.
    child.stdin?.end();
  });
}

function parseSddlLines(lines: string[], expected: number): string[] {
  if (lines.length !== expected || lines.some((line) => !SDDL_PATTERN.test(line))) {
    throw securityError('Windows file security descriptor could not be read; the note was left unchanged');
  }
  return lines;
}

/** Reads the owner, group and DACL (as SDDL) of one or two existing Windows files. */
export async function captureWindowsSecurity(filePath: string, secondPath?: string): Promise<string[]> {
  const env: Record<string, string> = { PV_SECURITY_MODE: 'capture', PV_SECURITY_PATH: filePath };
  if (secondPath !== undefined) env['PV_SECURITY_PATH2'] = secondPath;
  return parseSddlLines(await runPowerShell(env), secondPath === undefined ? 1 : 2);
}

/** Applies an SDDL descriptor to a Windows file and returns the descriptor read back afterwards. */
export async function applyWindowsSecurity(filePath: string, sddl: string): Promise<string> {
  if (!SDDL_PATTERN.test(sddl)) throw securityError('Refusing to apply a malformed Windows security descriptor');
  const [readBack] = parseSddlLines(await runPowerShell({ PV_SECURITY_MODE: 'apply', PV_SECURITY_PATH: filePath, PV_SECURITY_SDDL: sddl }), 1);
  return readBack as string;
}

function posixOf(stats: { mode: number; uid: number; gid: number }): FileSecurity {
  // Special bits (setuid/setgid/sticky) have no meaning for a Markdown note and are never propagated.
  return { kind: 'posix', mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
}

/** Captures the security metadata of an existing, already-validated regular file. */
export async function captureFileSecurity(filePath: string): Promise<FileSecurity> {
  if (process.platform === 'win32') {
    const [sddl] = await captureWindowsSecurity(filePath);
    return { kind: 'windows', sddl: sddl as string };
  }
  try {
    return posixOf(await fs.stat(filePath));
  } catch {
    throw securityError('Existing note security metadata could not be read; the note was left unchanged');
  }
}

export function sameSecurity(a: FileSecurity, b: FileSecurity): boolean {
  if (a.kind === 'posix' && b.kind === 'posix') return a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
  if (a.kind === 'windows' && b.kind === 'windows') return a.sddl === b.sddl;
  return false;
}

/**
 * Applies captured metadata to a staging file through its open handle (POSIX) or by path
 * (Windows) and verifies what the filesystem reports afterwards. Any failure or mismatch throws
 * and leaves the caller responsible for discarding the staging file.
 */
export async function applyFileSecurity(handle: FileHandle, filePath: string, security: FileSecurity): Promise<void> {
  if (security.kind === 'windows') {
    if (process.platform !== 'win32') throw securityError('Windows security metadata cannot be applied on this platform');
    const readBack = await applyWindowsSecurity(filePath, security.sddl);
    if (readBack !== security.sddl) throw securityError('Replacement file security does not match the existing note; the note was left unchanged');
    return;
  }
  try {
    const current = await handle.stat();
    if (current.uid !== security.uid || current.gid !== security.gid) await handle.chown(security.uid, security.gid);
    await handle.chmod(security.mode);
  } catch {
    throw securityError('Existing note ownership or permissions could not be preserved; the note was left unchanged');
  }
  await verifyFileSecurity(filePath, security, handle);
}

/** Re-reads metadata and throws unless it matches exactly. */
export async function verifyFileSecurity(filePath: string, security: FileSecurity, handle?: FileHandle): Promise<void> {
  let actual: FileSecurity;
  if (security.kind === 'windows') {
    actual = await captureFileSecurity(filePath);
  } else {
    try {
      actual = posixOf(handle ? await handle.stat() : await fs.stat(filePath));
    } catch {
      throw securityError('File security metadata could not be verified; the note was left unchanged');
    }
  }
  if (!sameSecurity(actual, security)) {
    throw securityError('File security metadata changed or could not be preserved; the note was left unchanged');
  }
}

/**
 * Verifies in one pass that the staging file carries the captured metadata and that the target's
 * own metadata is still what was captured, so a concurrent permission change aborts the replace.
 */
export async function verifyBeforeReplace(tempPath: string, targetPath: string, security: FileSecurity, tempHandle?: FileHandle): Promise<void> {
  if (security.kind === 'windows') {
    const [tempSddl, targetSddl] = await captureWindowsSecurity(tempPath, targetPath);
    if (tempSddl !== security.sddl || targetSddl !== security.sddl) {
      throw securityError('File security metadata changed or could not be preserved; the note was left unchanged');
    }
    return;
  }
  await verifyFileSecurity(tempPath, security, tempHandle);
  await verifyFileSecurity(targetPath, security);
}
