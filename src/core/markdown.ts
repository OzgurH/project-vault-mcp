/**
 * Markdown note parser.
 *
 * Produces a ParsedNote from raw note content: YAML frontmatter (safe schema,
 * bounded aliases), headings with GitHub slugs, heading-sized sections with
 * real 1-based line numbers, Markdown links and Obsidian wikilinks (text
 * nodes only, never inside code), and declared source references.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import GithubSlugger from 'github-slugger';
import YAML from 'yaml';
import type { Root, RootContent, Heading, PhrasingContent } from 'mdast';
import { VaultError } from './errors.js';
import type { NoteLink, ParsedNote, Section, SourceReference } from './types.js';

/** Sections longer than this many lines are split into consecutive chunks. */
export const MAX_SECTION_LINES = 60;
/** Upper bound for YAML alias expansion while parsing frontmatter. */
const MAX_YAML_ALIASES = 32;

const processor = unified().use(remarkParse);

interface Frontmatter { metadata: Record<string, unknown>; lineCount: number }

function parseFrontmatter(lines: string[]): Frontmatter {
  if (lines[0] !== '---') return { metadata: {}, lineCount: 0 };
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') { closing = i; break; }
  }
  if (closing < 0) throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter block is not closed');
  const source = lines.slice(1, closing).join('\n');
  let value: unknown;
  try {
    const doc = YAML.parseDocument(source, { schema: 'core', uniqueKeys: true, strict: true });
    if (doc.errors.length > 0) throw doc.errors[0];
    if (doc.warnings.length > 0) throw doc.warnings[0];
    value = doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
    preserveHashText(doc, value);
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'YAMLError';
    throw new VaultError('INVALID_FRONTMATTER', `Frontmatter YAML could not be parsed safely (${reason})`);
  }
  if (value === null || value === undefined) return { metadata: {}, lineCount: closing + 1 };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new VaultError('INVALID_FRONTMATTER', 'Frontmatter must be a YAML mapping');
  }
  return { metadata: value as Record<string, unknown>, lineCount: closing + 1 };
}

/**
 * A digit-only sha256 (for example 64 zeros) is a valid hex hash but the YAML
 * core schema resolves it as a number. Keep the author's literal text instead.
 */
function preserveHashText(doc: YAML.Document, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const sources = (value as Record<string, unknown>)['sources'];
  if (!Array.isArray(sources)) return;
  sources.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    if (typeof record['sha256'] !== 'number') return;
    const node = doc.getIn(['sources', index, 'sha256'], true);
    if (YAML.isScalar(node) && typeof node.source === 'string') record['sha256'] = node.source;
  });
}

function extractSources(metadata: Record<string, unknown>): SourceReference[] {
  const raw = metadata['sources'];
  if (!Array.isArray(raw)) return [];
  const sources: SourceReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const root = record['root'];
    const relPath = record['path'];
    if (typeof root !== 'string' || typeof relPath !== 'string' || root.length === 0 || relPath.length === 0) continue;
    const reference: SourceReference = { root, path: relPath };
    const sha = record['sha256'];
    if (typeof sha === 'string' && sha.length > 0) reference.sha256 = sha.toLowerCase();
    sources.push(reference);
  }
  return sources;
}

function phrasingText(nodes: PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        out += node.value;
        break;
      case 'break':
        out += ' ';
        break;
      default:
        if ('children' in node) out += phrasingText(node.children as PhrasingContent[]);
    }
  }
  return out;
}

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

function wikilinksInText(value: string, startLine: number, out: NoteLink[]): void {
  WIKILINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK.exec(value)) !== null) {
    const inner = match[2] ?? '';
    const target = inner.split('|')[0]?.trim() ?? '';
    if (target.length === 0) continue;
    let line = startLine;
    for (let i = 0; i < match.index; i++) if (value.charCodeAt(i) === 10) line++;
    out.push({ target, line, embed: match[1] === '!' });
  }
}

function collectLinks(node: RootContent | Root, offset: number, out: NoteLink[]): void {
  const line = (node.position?.start.line ?? 1) + offset;
  switch (node.type) {
    case 'code':
    case 'inlineCode':
    case 'html':
      return;
    case 'text':
      wikilinksInText(node.value, line, out);
      return;
    case 'link':
    case 'definition':
      if (node.url.length > 0) out.push({ target: node.url, line, embed: false });
      break;
    case 'image':
      if (node.url.length > 0) out.push({ target: node.url, line, embed: true });
      return;
    default:
      break;
  }
  if ('children' in node) {
    for (const child of node.children as RootContent[]) collectLinks(child, offset, out);
  }
}

function pushSection(sections: Section[], heading: string, line: number, endLine: number, lines: string[], offset: number): void {
  // `lines` is the body array (index 0 == real line offset + 1).
  for (let start = line; start <= endLine; start += MAX_SECTION_LINES) {
    const end = Math.min(endLine, start + MAX_SECTION_LINES - 1);
    const text = lines.slice(start - offset - 1, end - offset).join('\n');
    if (text.trim().length === 0 && heading === '') continue;
    sections.push({ heading, line: start, endLine: end, text });
  }
}

/** Parse raw note content (any newline style) into a ParsedNote. */
export function parseNote(content: string): ParsedNote {
  let normalized = content.replace(/\r\n?/g, '\n');
  if (normalized.charCodeAt(0) === 0xfeff) normalized = normalized.slice(1);
  const allLines = normalized.split('\n');
  const { metadata, lineCount: offset } = parseFrontmatter(allLines);
  const bodyLines = allLines.slice(offset);
  const body = bodyLines.join('\n');
  const tree = processor.parse(body) as Root;

  const slugger = new GithubSlugger();
  const headings: ParsedNote['headings'] = [];
  const headingNodes: { node: Heading; text: string; line: number }[] = [];
  for (const node of tree.children) {
    if (node.type !== 'heading') continue;
    const text = phrasingText(node.children).trim();
    const line = (node.position?.start.line ?? 1) + offset;
    headings.push({ text, slug: slugger.slug(text), line });
    headingNodes.push({ node, text, line });
  }

  const totalLines = allLines.length;
  const lastBodyLine = totalLines > 0 && allLines[totalLines - 1] === '' ? totalLines - 1 : totalLines;
  const sections: Section[] = [];
  const firstHeadingLine = headingNodes[0]?.line ?? lastBodyLine + 1;
  if (firstHeadingLine > offset + 1) {
    pushSection(sections, '', offset + 1, firstHeadingLine - 1, bodyLines, offset);
  }
  for (let i = 0; i < headingNodes.length; i++) {
    const current = headingNodes[i]!;
    const next = headingNodes[i + 1];
    const endLine = next ? next.line - 1 : Math.max(lastBodyLine, current.line);
    pushSection(sections, current.text, current.line, endLine, bodyLines, offset);
  }

  const links: NoteLink[] = [];
  collectLinks(tree, offset, links);
  links.sort((a, b) => a.line - b.line);

  const firstH1 = headingNodes.find((h) => h.node.depth === 1);
  const metaTitle = typeof metadata['title'] === 'string' ? metadata['title'] : '';
  const title = firstH1?.text ?? metaTitle;
  const type = typeof metadata['type'] === 'string' ? metadata['type'] : undefined;
  const status = typeof metadata['status'] === 'string' ? metadata['status'] : undefined;

  const parsed: ParsedNote = { title, metadata, headings, sections, links, sources: extractSources(metadata) };
  if (type !== undefined) parsed.type = type;
  if (status !== undefined) parsed.status = status;
  return parsed;
}
