// CI-only probe: fixed markers, no paths, SIDs, descriptors or note content in output.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), 'pv-acl-probe-'));
const target = path.join(root, 'fixture.md');
await writeFile(target, '# Synthetic ACL probe\n');
const stage = path.join(root, 'staging.md');
await writeFile(stage, '');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sections = "[System.Security.AccessControl.AccessControlSections]'Owner,Group,Access'";
const minimal = {
  SystemRoot: systemRoot, windir: systemRoot, PATH: path.join(systemRoot, 'System32'), PATHEXT: '.EXE',
  TEMP: process.env.TEMP ?? systemRoot, TMP: process.env.TMP ?? systemRoot,
  USERPROFILE: process.env.USERPROFILE ?? systemRoot, PSModulePath: '', PV_PROBE_FILE: target, PV_PROBE_STAGE: stage,
};
async function probe(name, environment, direct) {
  const command = ["$ErrorActionPreference = 'Stop'", "[Console]::Out.WriteLine('started')",
    direct ? '$info = [System.IO.FileInfo]::new($env:PV_PROBE_FILE)' : '$info = New-Object System.IO.FileInfo($env:PV_PROBE_FILE)',
    "[Console]::Out.WriteLine('constructed')", `$acl = $info.GetAccessControl(${sections})`,
    "[Console]::Out.WriteLine('read')", `$beforeSddl = $acl.GetSecurityDescriptorSddlForm(${sections})`,
    '$stage = [System.IO.FileInfo]::new($env:PV_PROBE_STAGE)',
    '$desired = [System.Security.AccessControl.FileSecurity]::new()',
    `$desired.SetSecurityDescriptorSddlForm($beforeSddl, ${sections})`,
    '$stage.SetAccessControl($desired)', `$after = $stage.GetAccessControl(${sections})`,
    `$afterSddl = $after.GetSecurityDescriptorSddlForm(${sections})`,
    '$b = [System.Security.AccessControl.RawSecurityDescriptor]::new($beforeSddl)',
    '$a = [System.Security.AccessControl.RawSecurityDescriptor]::new($afterSddl)',
    "[Console]::Out.WriteLine('owner-equal=' + ($b.Owner.Value -eq $a.Owner.Value))",
    "[Console]::Out.WriteLine('group-equal=' + ($b.Group.Value -eq $a.Group.Value))",
    "[Console]::Out.WriteLine('flags-before=' + [int]$b.ControlFlags)",
    "[Console]::Out.WriteLine('flags-after=' + [int]$a.ControlFlags)",
    '$bb = [byte[]]::new($b.DiscretionaryAcl.BinaryLength)', '$b.DiscretionaryAcl.GetBinaryForm($bb, 0)',
    '$ab = [byte[]]::new($a.DiscretionaryAcl.BinaryLength)', '$a.DiscretionaryAcl.GetBinaryForm($ab, 0)',
    "[Console]::Out.WriteLine('dacl-bytes-equal=' + ([Convert]::ToBase64String($bb) -eq [Convert]::ToBase64String($ab)))",
    "[Console]::Out.WriteLine('done')"].join('\n');
  const start = performance.now();
  return await new Promise(resolve => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', command],
      { env: environment, timeout: 20000, maxBuffer: 4096, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const markers = stdout.split(/\r?\n/).filter(line => /^(started|constructed|read|done)$/.test(line));
        const metadataChecks = stdout.split(/\r?\n/).filter(line => /^(?:owner-equal|group-equal|dacl-bytes-equal)=(?:True|False)$|^flags-(?:before|after)=\d+$/.test(line));
        process.stdout.write(JSON.stringify({ probe: name, elapsedMs: Math.round(performance.now() - start),
          success: !error, timedOut: Boolean(error?.killed), markers, metadataChecks }) + '\n');
        resolve(!error);
      });
    child.stdin?.end();
  });
}
try {
  if (process.argv.includes('--compare-cmdlet')) {
    await probe('inherited-environment', { ...process.env, PV_PROBE_FILE: target, PV_PROBE_STAGE: stage }, false);
    await probe('minimal-environment-cmdlet', minimal, false);
  }
  if (!(await probe('minimal-environment-native-constructor', minimal, true))) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
