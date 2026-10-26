/**
 * Markdown note parser.
 *
 * Produces a ParsedNote from raw note content: YAML frontmatter (safe schema,
 * bounded aliases), headings with GitHub slugs, heading-sized sections with
 * real 1-based line numbers, Markdown links and Obsidian wikilinks (text
 * nodes only, never inside code or raw HTML), and declared source references.
 * Link extraction is linear in the note size and capped per note.
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
/** Default per-note link cap (mirrors the `maxLinksPerNote` limit default). */
export const DEFAULT_MAX_LINKS_PER_NOTE = 2048;
/** Link targets longer than a note id can ever be are dropped instead of copied around. */
export const MAX_LINK_TARGET_CHARS = 1024;
/** A note may contain at most maxLinks x this many "[" characters before parsing is refused. */
export const LINK_OPENER_BUDGET_FACTOR = 4;

export interface ParseNoteOptions {
  /** Maximum number of links (Markdown links, definitions, images and wikilinks) a note may declare. */
  maxLinks?: number;
}

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

/** Collects links with a hard per-note cap; exceeding it is an error, never a partial list. */
class LinkCollector {
  readonly links: NoteLink[] = [];
  constructor(private readonly maxLinks: number) {}

  push(target: string, line: number, embed: boolean): void {
    if (target.length === 0 || target.length > MAX_LINK_TARGET_CHARS) return;
    if (this.links.length >= this.maxLinks) {
      throw new VaultError('LIMIT_EXCEEDED', `Note contains more than maxLinksPerNote (${this.maxLinks}) links`);
    }
    this.links.push({ target, line, embed });
  }
}

const CH_NEWLINE = 10;
const CH_BANG = 33;
const CH_OPEN = 91; // [
const CH_CLOSE = 93; // ]

/**
 * Single forward pass over a text node. Every character is visited a bounded number of times:
 * an opener whose line ends (or hits a lone "]") before "]]" cannot be rescued by any later opener
 * on the same stretch, so scanning resumes after the failure point instead of one character later.
 * Line numbers are counted incrementally while advancing, never by re-scanning the prefix.
 */
export function scanWikilinks(value: string, startLine: number, maxLinks: number = DEFAULT_MAX_LINKS_PER_NOTE): NoteLink[] {
  const collector = new LinkCollector(maxLinks);
  wikilinksInText(value, startLine, collector);
  return collector.links;
}

/**
 * The Markdown parser's bracket matching is superlinear on adversarial input (a 1 MiB flood of
 * "[[x]]" or "[[a]" takes minutes). Count "[" in one linear pass and refuse notes whose link syntax
 * exceeds a conservative structural budget, before the parser ever sees them.
 */
function assertLinkSyntaxBudget(body: string, maxLinks: number): void {
  const budget = Math.max(1, maxLinks) * LINK_OPENER_BUDGET_FACTOR;
  let openers = 0;
  let index = body.indexOf('[');
  while (index !== -1) {
    openers++;
    if (openers > budget) {
      throw new VaultError(
        'LIMIT_EXCEEDED',
        `Note contains more than ${budget} link opening brackets (maxLinksPerNote ${maxLinks} x ${LINK_OPENER_BUDGET_FACTOR}) and was not parsed`,
      );
    }
    index = body.indexOf('[', index + 1);
  }
}

function wikilinksInText(value: string, startLine: number, out: LinkCollector): void {
  const length = value.length;
  let line = startLine;
  let pos = 0;
  while (pos < length) {
    const code = value.charCodeAt(pos);
    if (code === CH_NEWLINE) {
      line++;
      pos++;
      continue;
    }
    if (code !== CH_OPEN || value.charCodeAt(pos + 1) !== CH_OPEN) {
      pos++;
      continue;
    }
    // Candidate opener at pos. Find the first "]" or newline after it.
    let end = pos + 2;
    while (end < length) {
      const c = value.charCodeAt(end);
      if (c === CH_CLOSE || c === CH_NEWLINE) break;
      end++;
    }
    if (end >= length) return; // No closer anywhere ahead; the rest of the node has no wikilinks.
    if (value.charCodeAt(end) === CH_NEWLINE) {
      // Every opener before this newline fails the same way; continue on the next line.
      pos = end;
      continue;
    }
    const closes = value.charCodeAt(end + 1) === CH_CLOSE && end > pos + 2;
    if (!closes) {
      // Lone "]" (or empty "[[]]"): no opener between pos and end can succeed either.
      pos = end + 1;
      continue;
    }
    const inner = value.slice(pos + 2, end);
    const pipe = inner.indexOf('|');
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const embed = pos > 0 && value.charCodeAt(pos - 1) === CH_BANG;
    out.push(target, line, embed);
    pos = end + 2;
  }
}

/** Iterative tree walk (no recursion depth to attack) that skips code and raw HTML. */
function collectLinks(root: Root, offset: number, out: LinkCollector): void {
  const stack: (RootContent | Root)[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const line = (node.position?.start.line ?? 1) + offset;
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'html':
        continue;
      case 'text':
        wikilinksInText(node.value, line, out);
        continue;
      case 'link':
      case 'definition':
        out.push(node.url, line, false);
        break;
      case 'image':
        out.push(node.url, line, true);
        continue;
      default:
        break;
    }
    if ('children' in node) {
      const children = node.children as RootContent[];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
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

function resolveMaxLinks(options: ParseNoteOptions | undefined): number {
  const value = options?.maxLinks;
  if (value === undefined) return DEFAULT_MAX_LINKS_PER_NOTE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new VaultError('INVALID_ARGUMENT', 'maxLinks must be a non-negative integer');
  }
  return value;
}

/**
 * Parse raw note content (any newline style) into a ParsedNote. Throws LIMIT_EXCEEDED when the
 * note declares more than `maxLinks` links (default 2048); no partial link list is returned.
 */
export function parseNote(content: string, options?: ParseNoteOptions): ParsedNote {
  const maxLinks = resolveMaxLinks(options);
  let normalized = content.replace(/\r\n?/g, '\n');
  if (normalized.charCodeAt(0) === 0xfeff) normalized = normalized.slice(1);
  const allLines = normalized.split('\n');
  const { metadata, lineCount: offset } = parseFrontmatter(allLines);
  const bodyLines = allLines.slice(offset);
  const body = bodyLines.join('\n');
  assertLinkSyntaxBudget(body, maxLinks);
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

  const collector = new LinkCollector(maxLinks);
  collectLinks(tree, offset, collector);
  const links: NoteLink[] = collector.links;
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
