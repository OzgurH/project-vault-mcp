/**
 * `project-vault init`: scaffold a vault layout without ever overwriting anything.
 *
 * Preview mode touches nothing. Apply mode creates only the missing pieces with
 * exclusive-create semantics, refuses symlinked roots or ancestors, and treats an
 * existing project-vault.json as an adopted project that must not receive guessed defaults.
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VaultError } from '../core/errors.js';
import { defaultConfig } from '../core/config.js';
import { getTemplate } from '../core/templates.js';

export interface InitResult { applied: boolean; created: string[]; existing: string[]; planned: string[] }

export class InitError extends VaultError {
  constructor(code: string, message: string, public readonly created: string[]) {
    super(code, created.length ? `${message} Created before the failure: ${created.join(', ')}.` : message);
    this.name = 'VaultError';
  }
}

export const INIT_DIRECTORIES = ['docs', 'docs/architecture', 'docs/modules', 'docs/decisions', 'docs/runbooks'] as const;
const CONFIG_FILE = 'project-vault.json';

function simpleNote(title: string, purpose: string): string {
  return `# ${title}\n\n${purpose}\n`;
}

function plannedFiles(projectName: string): Record<string, () => string> {
  return {
    [CONFIG_FILE]: () => JSON.stringify(defaultConfig(projectName), null, 2) + '\n',
    'docs/index.md': () => getTemplate('index'),
    'docs/architecture/overview.md': () => getTemplate('architecture'),
    'docs/modules/index.md': () => simpleNote('Modules', 'One note per module. Describe responsibilities, boundaries and key entry points.'),
    'docs/decisions/index.md': () => simpleNote('Architecture decisions', 'Record each significant decision as an ADR with context, decision and consequences.'),
    'docs/runbooks/index.md': () => simpleNote('Runbooks', 'Step-by-step operational procedures for building, releasing and recovering the project.')
  };
}

type Presence = 'missing' | 'file' | 'dir' | 'symlink';

async function presence(p: string): Promise<Presence> {
  try {
    const s = await lstat(p);
    if (s.isSymbolicLink()) return 'symlink';
    return s.isDirectory() ? 'dir' : 'file';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return 'missing';
    throw new VaultError('INIT_STAT_FAILED', 'A path inside the target could not be inspected.');
  }
}

async function rejectSymlinkedAncestors(root: string): Promise<void> {
  const parts: string[] = [];
  let cur = root;
  for (;;) {
    parts.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const p of parts) {
    if ((await presence(p)) === 'symlink') throw new VaultError('INIT_SYMLINK', 'The target root or one of its ancestors is a symbolic link or junction; refusing to initialize through it.');
  }
}

export async function initProject(root: string, apply = false): Promise<InitResult> {
  if (typeof root !== 'string' || root.trim() === '') throw new VaultError('INIT_INVALID_ROOT', 'A project root path is required.');
  const rootAbs = path.resolve(root);
  await rejectSymlinkedAncestors(rootAbs);
  const rootState = await presence(rootAbs);
  if (rootState === 'file') throw new VaultError('INIT_ROOT_IS_FILE', 'The target root is an existing file, not a directory.');

  const configState = rootState === 'dir' ? await presence(path.join(rootAbs, CONFIG_FILE)) : 'missing';
  if (configState !== 'missing') {
    // Adopted project: honor its configuration and do not create guessed defaults.
    return { applied: false, created: [], existing: [CONFIG_FILE], planned: [] };
  }

  const files = plannedFiles(path.basename(rootAbs) || 'project');
  const existing: string[] = [];
  const planned: string[] = [];
  const dirsToCreate: string[] = [];
  const filesToCreate: string[] = [];
  if (rootState === 'missing') planned.push('.');

  for (const rel of INIT_DIRECTORIES) {
    const state = rootState === 'dir' ? await presence(path.join(rootAbs, rel)) : 'missing';
    if (state === 'symlink') throw new VaultError('INIT_SYMLINK', `Planned directory "${rel}" is a symbolic link; refusing to continue.`);
    if (state === 'file') throw new VaultError('INIT_PATH_CONFLICT', `Planned directory "${rel}" exists as a file.`);
    if (state === 'dir') existing.push(rel);
    else { planned.push(rel); dirsToCreate.push(rel); }
  }
  for (const rel of Object.keys(files)) {
    const state = rootState === 'dir' ? await presence(path.join(rootAbs, rel)) : 'missing';
    if (state === 'missing') { planned.push(rel); filesToCreate.push(rel); }
    else existing.push(rel);
  }

  if (!apply) return { applied: false, created: [], existing, planned };

  const created: string[] = [];
  const failure = (code: string, message: string) => new InitError(code, message, created);
  if (rootState === 'missing') {
    try { await mkdir(rootAbs, { mode: 0o700 }); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw failure('INIT_ROOT_CREATE_FAILED', code === 'ENOENT' ? 'The parent of the target root does not exist; only the explicitly supplied root is created.' : 'The target root could not be created.');
    }
    created.push('.');
  }
  for (const rel of dirsToCreate) {
    try { await mkdir(path.join(rootAbs, rel), { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { existing.push(rel); continue; }
      throw failure('INIT_DIR_CREATE_FAILED', `Directory "${rel}" could not be created.`);
    }
    created.push(rel);
  }
  for (const rel of filesToCreate) {
    const target = path.join(rootAbs, rel);
    if ((await presence(path.dirname(target))) !== 'dir') throw failure('INIT_SYMLINK', `The parent of "${rel}" is not a plain directory; refusing to write through it.`);
    let content: string;
    try { content = files[rel]!(); } catch { throw failure('INIT_TEMPLATE_FAILED', `The template for "${rel}" is unavailable.`); }
    try { await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { existing.push(rel); continue; }
      throw failure('INIT_FILE_CREATE_FAILED', `File "${rel}" could not be created.`);
    }
    created.push(rel);
  }
  return { applied: true, created, existing, planned };
}
