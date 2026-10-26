// CI-only probe: fixed markers, no paths, SIDs, descriptors or note content in output.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), 'pv-acl-probe-'));
const target = path.join(root, 'fixture.md');
await writeFile(target, '# Synthetic ACL probe\n');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sections = "[System.Security.AccessControl.AccessControlSections]'Owner,Group,Access'";
const minimal = {
  SystemRoot: systemRoot, windir: systemRoot, PATH: path.join(systemRoot, 'System32'), PATHEXT: '.EXE',
  TEMP: process.env.TEMP ?? systemRoot, TMP: process.env.TMP ?? systemRoot,
  USERPROFILE: process.env.USERPROFILE ?? systemRoot, PSModulePath: '', PV_PROBE_FILE: target,
};
async function probe(name, environment, direct) {
  const command = ["$ErrorActionPreference = 'Stop'", "[Console]::Out.WriteLine('started')",
    direct ? '$info = [System.IO.FileInfo]::new($env:PV_PROBE_FILE)' : '$info = New-Object System.IO.FileInfo($env:PV_PROBE_FILE)',
    "[Console]::Out.WriteLine('constructed')", `$acl = $info.GetAccessControl(${sections})`,
    "[Console]::Out.WriteLine('read')", `$null = $acl.GetSecurityDescriptorSddlForm(${sections})`,
    "[Console]::Out.WriteLine('done')"].join('\n');
  const start = performance.now();
  await new Promise(resolve => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', command],
      { env: environment, timeout: 5000, maxBuffer: 4096, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const markers = stdout.split(/\r?\n/).filter(line => /^(started|constructed|read|done)$/.test(line));
        process.stdout.write(JSON.stringify({ probe: name, elapsedMs: Math.round(performance.now() - start),
          success: !error, timedOut: Boolean(error?.killed), markers }) + '\n');
        resolve(!error);
      });
    child.stdin?.end();
  });
}
try {
  if (process.argv.includes('--compare-cmdlet')) {
    await probe('inherited-environment', { ...process.env, PV_PROBE_FILE: target }, false);
    await probe('minimal-environment-cmdlet', minimal, false);
  }
  if (!(await probe('minimal-environment-native-constructor', minimal, true))) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
