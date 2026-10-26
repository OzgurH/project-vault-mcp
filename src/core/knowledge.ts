/**
 * Knowledge layer: in-memory index over the configured notes roots.
 *
 * All note IO and containment decisions go through the storage API
 * (files.ts / paths.ts). This module never reads note files directly; it only
 * hashes declared source files after the storage layer resolved them.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { slug as githubSlug } from 'github-slugger';
import { minimatch } from 'minimatch';
import { VaultError } from './errors.js';
import { parseNote } from './markdown.js';
import { listNoteIds, readNoteFile, readBoundedBytes } from './files.js';
import { resolveAttachment, resolveNote, resolveSource } from './paths.js';
import type { Diagnostic, KnowledgeStatus, NoteFile, NoteLink, ParsedNote, Project, SearchHit, Section } from './types.js';

/** Storage contract consumed by the knowledge layer (implemented by files.ts and paths.ts). */
export interface StorageApi {
  listNoteIds(project: Project): Promise<string[]>;
  readNoteFile(project: Project, noteId: string): Promise<NoteFile>;
  resolveNote(project: Project, noteId: string, allowMissing?: boolean): Promise<string>;
  resolveSource(project: Project, sourceRootId: string, relativePath: string): Promise<string>;
  resolveAttachment?(project: Project, referenceId: string): Promise<string>;
}

export type LinkStatus = 'ok' | 'external' | 'asset' | 'broken' | 'ambiguous' | 'missing_heading' | 'outside_root';

export interface ResolvedLink {
  target: string;
  line: number;
  embed: boolean;
  status: LinkStatus;
  /** Resolved note id when the target is a note inside a configured root. */
  noteId?: string;
  /** Requested heading anchor (slug form) when present. */
  heading?: string;
  /** Candidate note ids when the target basename is ambiguous. */
  candidates?: string[];
}

export interface Backlink { noteId: string; line: number; target: string }

export interface ReadResult {
  noteId: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  diskRevision: string;
  truncated: boolean;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
const EXCERPT_MAX_CHARS = 300;
const MIN_EXCERPT_CHARS = 40;
const ENTRY_EXCERPT_MAX_CHARS = 1200;
const CONTEXT_TOPIC_HITS = 10;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HEADING_WEIGHT = 3;
const PATH_WEIGHT = 1.5;

/** Diagnostic codes that make check() fail. Informational codes are listed in INFO_CODES. */
const FAILING_CODES = new Set([
  'SCAN_FAILED', 'SCAN_LIMIT_EXCEEDED', 'INVALID_FRONTMATTER', 'NOTE_UNREADABLE', 'NOTE_TOO_LARGE', 'ENTRY_NOTE_MISSING',
  'LINK_BROKEN', 'LINK_AMBIGUOUS', 'LINK_MISSING_HEADING', 'LINK_OUTSIDE_ROOT',
  'SOURCE_CHANGED', 'SOURCE_MISSING', 'SOURCE_INACCESSIBLE', 'SOURCE_INVALID',
  'SOURCE_LIMIT_EXCEEDED',
]);

interface IndexedNote {
  noteId: string;
  rootId: string;
  rel: string;
  basename: string;
  parsed: ParsedNote;
  revision: string;
  bytes: number;
}

interface SourceBudget {
  bytes: number;
  references: number;
  hashes: Map<string, string>;
}

interface IndexedDoc {
  noteId: string;
  section: Section;
  terms: Map<string, number>;
  length: number;
}

interface Generation {
  number: number;
  indexedAt: string | null;
  notes: Map<string, IndexedNote>;
  docs: IndexedDoc[];
  documentFrequency: Map<string, number>;
  averageLength: number;
  files: number;
  bytes: number;
  degraded: boolean;
  diagnostics: Diagnostic[];
  resolvedLinks: Map<string, ResolvedLink[]> | null;
}

function emptyGeneration(): Generation {
  return {
    number: 0,
    indexedAt: null,
    notes: new Map(),
    docs: [],
    documentFrequency: new Map(),
    averageLength: 0,
    files: 0,
    bytes: 0,
    degraded: true,
    diagnostics: [{ code: 'NOT_SCANNED', message: 'The knowledge index has not been built yet' }],
    resolvedLinks: null,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof VaultError ? error.code : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function splitNoteId(noteId: string): { rootId: string; rel: string } {
  const slash = noteId.indexOf('/');
  return slash <= 0 ? { rootId: noteId, rel: '' } : { rootId: noteId.slice(0, slash), rel: noteId.slice(slash + 1) };
}

async function loadDefaultStorage(): Promise<StorageApi> {
  return { listNoteIds, readNoteFile, resolveNote, resolveSource, resolveAttachment };
}

const TOKEN = /[\p{L}\p{M}\p{N}_]+/gu;

export class KnowledgeBase {
  private generation: Generation = emptyGeneration();
  private lastScanAt = 0;
  private inFlight: Promise<void> | null = null;
  private storagePromise: Promise<StorageApi> | null = null;

  constructor(private readonly project: Project, storage?: StorageApi) {
    if (storage) this.storagePromise = Promise.resolve(storage);
  }

  private storage(): Promise<StorageApi> {
    if (!this.storagePromise) this.storagePromise = loadDefaultStorage();
    return this.storagePromise;
  }

  // ---------------------------------------------------------------- scanning

  async refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const interval = this.project.config.limits.rescanIntervalMs;
    if (!force && this.generation.number > 0 && Date.now() - this.lastScanAt < interval) return;
    this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  status(): KnowledgeStatus {
    const g = this.generation;
    return {
      project: this.project.config.name,
      generation: g.number,
      indexedAt: g.indexedAt,
      files: g.files,
      bytes: g.bytes,
      degraded: g.degraded,
      diagnostics: g.diagnostics.map((d) => ({ ...d })),
    };
  }

  private async scan(): Promise<void> {
    const storage = await this.storage();
    const { config } = this.project;
    const limits = config.limits;
    const diagnostics: Diagnostic[] = [];
    let degraded = false;
    const notes = new Map<string, IndexedNote>();
    let bytes = 0;

    let ids: string[];
    try {
      ids = [...(await storage.listNoteIds(this.project))].sort();
    } catch (error) {
      const previous = this.generation;
      this.install({
        ...previous,
        number: previous.number + 1,
        degraded: true,
        diagnostics: [{ code: 'SCAN_FAILED', message: errorCode(error) === 'LIMIT_EXCEEDED'
          ? 'Listing notes exceeded limits.maxFiles; narrow the configured roots or review that limit'
          : `Listing notes failed (${errorCode(error) ?? 'IO_ERROR'})` }],
        resolvedLinks: null,
      });
      return;
    }

    if (ids.length > limits.maxFiles) {
      degraded = true;
      diagnostics.push({ code: 'SCAN_LIMIT_EXCEEDED', message: `Found ${ids.length} notes but maxFiles is ${limits.maxFiles}; the index is partial` });
      ids = ids.slice(0, limits.maxFiles);
    }

    for (const noteId of ids) {
      let file: NoteFile;
      try {
        file = await storage.readNoteFile(this.project, noteId);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'PRIVATE_NOTE') continue;
        degraded = true;
        diagnostics.push({
          code: code === 'INVALID_FRONTMATTER' ? code : 'NOTE_UNREADABLE',
          noteId,
          message: code === 'INVALID_FRONTMATTER' ? 'Frontmatter is not valid YAML' : `Note could not be read (${code ?? 'IO_ERROR'})`,
        });
        continue;
      }
      if (file.bytes > limits.maxFileBytes) {
        degraded = true;
        diagnostics.push({ code: 'NOTE_TOO_LARGE', noteId, message: `Note exceeds maxFileBytes (${limits.maxFileBytes})` });
        continue;
      }
      if (bytes + file.bytes > limits.maxTotalBytes) {
        degraded = true;
        diagnostics.push({ code: 'SCAN_LIMIT_EXCEEDED', message: `Total note bytes exceed maxTotalBytes (${limits.maxTotalBytes}); the index is partial` });
        break;
      }
      let parsed: ParsedNote;
      try {
        parsed = parseNote(file.content);
      } catch (error) {
        degraded = true;
        diagnostics.push({ code: 'INVALID_FRONTMATTER', noteId, message: `Note could not be parsed (${errorCode(error) ?? 'PARSE_ERROR'})` });
        continue;
      }
      if (parsed.metadata['private'] === true) continue;
      bytes += file.bytes;
      const { rootId, rel } = splitNoteId(noteId);
      const basename = posix.basename(rel, '.md');
      notes.set(noteId, { noteId, rootId, rel, basename, parsed, revision: file.revision, bytes: file.bytes });
    }

    for (const entry of config.entryNotes) {
      if (!notes.has(entry)) diagnostics.push({ code: 'ENTRY_NOTE_MISSING', noteId: entry, message: 'Configured entry note is not in the index' });
    }

    const { docs, documentFrequency, averageLength } = this.buildIndex(notes);
    this.install({
      number: this.generation.number + 1,
      indexedAt: new Date().toISOString(),
      notes,
      docs,
      documentFrequency,
      averageLength,
      files: notes.size,
      bytes,
      degraded,
      diagnostics,
      resolvedLinks: null,
    });
  }

  private install(generation: Generation): void {
    this.generation = generation;
    this.lastScanAt = Date.now();
  }

  // ---------------------------------------------------------------- indexing

  private tokenize(text: string): string[] {
    const lowered = this.project.config.searchLocale === 'tr' ? text.toLocaleLowerCase('tr') : text.toLowerCase();
    return (lowered.normalize('NFC').match(TOKEN) ?? []) as string[];
  }

  private buildIndex(notes: Map<string, IndexedNote>): Pick<Generation, 'docs' | 'documentFrequency' | 'averageLength'> {
    const docs: IndexedDoc[] = [];
    const documentFrequency = new Map<string, number>();
    let totalLength = 0;
    for (const note of [...notes.values()].sort((a, b) => (a.noteId < b.noteId ? -1 : 1))) {
      const pathTokens = this.tokenize(note.rel.replace(/\.md$/u, ''));
      for (const section of note.parsed.sections) {
        const terms = new Map<string, number>();
        const add = (tokens: string[], weight: number): void => {
          for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + weight);
        };
        const textTokens = this.tokenize(section.text);
        const headingTokens = this.tokenize(section.heading);
        add(textTokens, 1);
        add(headingTokens, HEADING_WEIGHT);
        add(pathTokens, PATH_WEIGHT);
        const length = textTokens.length + headingTokens.length + pathTokens.length;
        totalLength += length;
        for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        docs.push({ noteId: note.noteId, section, terms, length });
      }
    }
    return { docs, documentFrequency, averageLength: docs.length > 0 ? totalLength / docs.length : 0 };
  }

  // ---------------------------------------------------------------- search

  async search(query: string, options: { limit?: number; type?: string } = {}): Promise<SearchHit[]> {
    if (typeof query !== 'string') throw new VaultError('INVALID_QUERY', 'Query must be a string');
    const { limits } = this.project.config;
    if (query.length > limits.maxQueryChars) throw new VaultError('INVALID_QUERY', `Query exceeds maxQueryChars (${limits.maxQueryChars})`);
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!isPositiveInteger(limit) || limit > MAX_SEARCH_LIMIT) {
      throw new VaultError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
    }
    if (options.type !== undefined && typeof options.type !== 'string') throw new VaultError('INVALID_ARGUMENT', 'type must be a string');
    await this.refresh();
    const ranked = this.rank(query, limit, options.type);
    const hits: SearchHit[] = [];
    let used = 0;
    for (const { doc, score } of ranked) {
      const remaining = limits.maxResponseChars - used;
      if (remaining < MIN_EXCERPT_CHARS) break;
      const excerpt = this.excerpt(doc.section, this.tokenize(query), Math.min(EXCERPT_MAX_CHARS, remaining));
      used += excerpt.length;
      hits.push(this.toHit(doc.noteId, doc.section, excerpt, score));
    }
    return hits;
  }

  private rank(query: string, limit: number, type?: string): { doc: IndexedDoc; score: number }[] {
    const g = this.generation;
    const queryTerms = [...new Set(this.tokenize(query))];
    if (queryTerms.length === 0) return [];
    const total = g.docs.length;
    const scored: { doc: IndexedDoc; score: number }[] = [];
    for (const doc of g.docs) {
      if (type !== undefined && g.notes.get(doc.noteId)?.parsed.type !== type) continue;
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const df = g.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = 1 - BM25_B + BM25_B * (g.averageLength > 0 ? doc.length / g.averageLength : 1);
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
      }
      if (score > 0) scored.push({ doc, score: Math.round(score * 1e6) / 1e6 });
    }
    scored.sort((a, b) => b.score - a.score
      || (a.doc.noteId < b.doc.noteId ? -1 : a.doc.noteId > b.doc.noteId ? 1 : 0)
      || a.doc.section.line - b.doc.section.line);
    return scored.slice(0, limit);
  }

  private excerpt(section: Section, queryTerms: string[], maxChars: number): string {
    const lines = section.text.split('\n');
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const tokens = new Set(this.tokenize(lines[i] ?? ''));
      if (queryTerms.some((term) => tokens.has(term))) { start = i; break; }
    }
    let text = '';
    for (let i = start; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const candidate = text.length === 0 ? line : `${text}\n${line}`;
      if (candidate.length > maxChars) {
        if (text.length === 0) text = line.slice(0, maxChars);
        break;
      }
      text = candidate;
    }
    return text.trim().slice(0, maxChars);
  }

  private toHit(noteId: string, section: Section, excerpt: string, score: number): SearchHit {
    const note = this.generation.notes.get(noteId);
    return {
      noteId,
      heading: section.heading,
      line: section.line,
      endLine: section.endLine,
      excerpt,
      score,
      indexRevision: note?.revision ?? '',
      indexedAt: this.generation.indexedAt ?? '',
    };
  }

  // ---------------------------------------------------------------- read

  async read(noteId: string, startLine = 1, lineCount = 200): Promise<ReadResult> {
    if (typeof noteId !== 'string' || noteId.length === 0) throw new VaultError('INVALID_ARGUMENT', 'noteId must be a non-empty string');
    if (!isPositiveInteger(startLine)) throw new VaultError('INVALID_ARGUMENT', 'startLine must be an integer >= 1');
    if (!isPositiveInteger(lineCount)) throw new VaultError('INVALID_ARGUMENT', 'lineCount must be an integer >= 1');
    const storage = await this.storage();
    const file = await storage.readNoteFile(this.project, noteId);
    const endsWithNewline = file.content.endsWith('\n');
    const lines = file.content.split('\n');
    if (endsWithNewline) lines.pop();
    const totalLines = lines.length;
    if (startLine > totalLines) throw new VaultError('INVALID_ARGUMENT', `startLine ${startLine} is beyond the last line (${totalLines})`);
    const requestedEnd = Math.min(totalLines, startLine + lineCount - 1);
    const budget = this.project.config.limits.maxResponseChars;
    let content = '';
    let endLine = startLine - 1;
    let cut = false;
    for (let i = startLine; i <= requestedEnd; i++) {
      const terminated = i < totalLines || endsWithNewline;
      const piece = `${lines[i - 1] ?? ''}${terminated ? '\n' : ''}`;
      if (content.length + piece.length > budget) {
        if (content.length === 0) { content = piece.slice(0, budget); endLine = i; }
        cut = true;
        break;
      }
      content += piece;
      endLine = i;
    }
    return {
      noteId,
      content,
      startLine,
      endLine,
      totalLines,
      diskRevision: file.revision,
      truncated: cut || endLine < totalLines,
    };
  }

  // ---------------------------------------------------------------- links

  async links(noteId: string): Promise<{ noteId: string; outgoing: ResolvedLink[]; backlinks: Backlink[] }> {
    await this.refresh();
    const note = this.generation.notes.get(noteId);
    if (!note) throw new VaultError('NOTE_NOT_FOUND', 'Note is not in the index');
    const resolved = await this.resolveAllLinks();
    const outgoing = resolved.get(noteId) ?? [];
    const backlinks: Backlink[] = [];
    for (const [sourceId, links] of resolved) {
      for (const link of links) {
        if (link.noteId === noteId && (link.status === 'ok' || link.status === 'missing_heading')) {
          backlinks.push({ noteId: sourceId, line: link.line, target: link.target });
        }
      }
    }
    backlinks.sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : a.line - b.line));
    return { noteId, outgoing: outgoing.map((l) => ({ ...l })), backlinks };
  }

  private async resolveAllLinks(): Promise<Map<string, ResolvedLink[]>> {
    const g = this.generation;
    if (g.resolvedLinks) return g.resolvedLinks;
    const resolved = new Map<string, ResolvedLink[]>();
    for (const noteId of [...g.notes.keys()].sort()) {
      const note = g.notes.get(noteId)!;
      const links: ResolvedLink[] = [];
      for (const link of note.parsed.links) links.push(await this.resolveLink(note, link));
      resolved.set(noteId, links);
    }
    if (this.generation === g) g.resolvedLinks = resolved;
    return resolved;
  }

  private async resolveLink(note: IndexedNote, link: NoteLink): Promise<ResolvedLink> {
    const base: ResolvedLink = { target: link.target, line: link.line, embed: link.embed, status: 'broken' };
    const raw = link.target.trim();
    if (raw.length === 0) return base;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !/^[a-z]:[\\/]/iu.test(raw)) return { ...base, status: 'external' };

    const hash = raw.indexOf('#');
    let pathPart = hash >= 0 ? raw.slice(0, hash) : raw;
    let anchorRaw = hash >= 0 ? raw.slice(hash + 1) : '';
    try { anchorRaw = decodeURIComponent(anchorRaw); } catch { /* Preserve literal percent signs. */ }
    const anchor = anchorRaw.includes('#') ? anchorRaw.slice(anchorRaw.lastIndexOf('#') + 1) : anchorRaw;
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      // Keep the raw path; wikilinks may legitimately contain a percent sign.
    }
    pathPart = pathPart.replace(/\\/gu, '/');
    if (pathPart.length === 0) return this.withHeading({ ...base, noteId: note.noteId }, note, anchor);
    if (pathPart.startsWith('/') || /^[a-z]:/iu.test(pathPart) || pathPart.includes(':') || pathPart.includes('\0')) {
      return { ...base, status: 'outside_root' };
    }

    const storage = await this.storage();
    const g = this.generation;
    const dir = posix.dirname(note.rel);
    const relative = posix.normalize(posix.join(dir === '.' ? '' : dir, pathPart));
    const hasMd = /\.md$/iu.test(relative);
    const hasOtherExtension = !hasMd && /\.[a-z0-9]{1,8}$/iu.test(posix.basename(relative));
    const candidateRel = hasMd || hasOtherExtension ? relative : `${relative}.md`;
    const candidateId = `${note.rootId}/${candidateRel}`;

    if (relative === '..' || relative.startsWith('../') || relative.startsWith('/')) {
      return this.classifyThroughStorage(storage, base, candidateId);
    }
    if (hasOtherExtension) {
      // Obsidian note names may contain dots: [[Node.js]] addresses Node.js.md.
      const dottedId = `${note.rootId}/${relative}.md`;
      const dotted = g.notes.get(dottedId);
      if (dotted) return this.withHeading({ ...base, noteId: dottedId }, dotted, anchor);
      if (!pathPart.includes('/')) {
        const matches = [...g.notes.values()]
          .filter(candidate => candidate.rootId === note.rootId && candidate.basename.toLowerCase() === pathPart.toLowerCase())
          .map(candidate => candidate.noteId).sort();
        if (matches.length === 1) return this.withHeading({ ...base, noteId: matches[0]! }, g.notes.get(matches[0]!)!, anchor);
        if (matches.length > 1) return { ...base, status: 'ambiguous', candidates: matches };
      }
      try {
        if (storage.resolveAttachment) await storage.resolveAttachment(this.project, candidateId);
        else await storage.resolveNote(this.project, candidateId, true);
        return { ...base, status: 'asset' };
      } catch (error) {
        const missing = errorCode(error) === 'NOT_FOUND' || errorCode(error) === 'NOTE_NOT_FOUND';
        return { ...base, status: missing ? 'broken' : 'outside_root' };
      }
    }
    if (g.notes.has(candidateId)) return this.withHeading({ ...base, noteId: candidateId }, g.notes.get(candidateId)!, anchor);

    if (!pathPart.includes('/')) {
      const wanted = pathPart.replace(/\.md$/iu, '').toLowerCase();
      const matches = [...g.notes.values()]
        .filter((n) => n.rootId === note.rootId && n.basename.toLowerCase() === wanted)
        .map((n) => n.noteId)
        .sort();
      if (matches.length === 1) return this.withHeading({ ...base, noteId: matches[0]! }, g.notes.get(matches[0]!)!, anchor);
      if (matches.length > 1) return { ...base, status: 'ambiguous', candidates: matches };
    } else {
      const rootRelative = `${note.rootId}/${hasMd ? pathPart : `${pathPart}.md`}`;
      const target = g.notes.get(rootRelative);
      if (target) return this.withHeading({ ...base, noteId: rootRelative }, target, anchor);
    }
    return this.classifyThroughStorage(storage, base, candidateId);
  }

  private async classifyThroughStorage(storage: StorageApi, base: ResolvedLink, candidateId: string): Promise<ResolvedLink> {
    try {
      await storage.resolveNote(this.project, candidateId, true);
    } catch (error) {
      const missing = errorCode(error) === 'NOT_FOUND' || errorCode(error) === 'NOTE_NOT_FOUND';
      return { ...base, status: missing ? 'broken' : 'outside_root' };
    }
    return { ...base, status: 'broken' };
  }

  private withHeading(link: ResolvedLink, target: IndexedNote, anchor: string): ResolvedLink {
    if (anchor.length === 0 || anchor.startsWith('^')) return { ...link, status: 'ok' };
    const wanted = githubSlug(anchor);
    const lowered = anchor.toLowerCase();
    const found = target.parsed.headings.some((h) => h.slug === wanted || h.slug === lowered || h.text.toLowerCase() === lowered);
    return { ...link, heading: wanted, status: found ? 'ok' : 'missing_heading' };
  }

  // ---------------------------------------------------------------- context

  async context(topic?: string, maxChars?: number): Promise<{ project: string; excerpts: SearchHit[]; truncated: boolean }> {
    const { config } = this.project;
    if (maxChars !== undefined && !isPositiveInteger(maxChars)) throw new VaultError('INVALID_ARGUMENT', 'maxChars must be an integer >= 1');
    const budget = Math.min(maxChars ?? config.limits.maxResponseChars, config.limits.maxResponseChars);
    if (topic !== undefined && typeof topic !== 'string') throw new VaultError('INVALID_ARGUMENT', 'topic must be a string');
    await this.refresh();
    const excerpts: SearchHit[] = [];
    const seen = new Set<string>();
    let used = 0;
    let truncated = false;
    const fit = (hit: SearchHit): boolean => {
      const key = `${hit.noteId}:${hit.line}`;
      if (seen.has(key)) return true;
      const remaining = budget - used;
      if (hit.excerpt.length > remaining) {
        truncated = true;
        if (remaining < MIN_EXCERPT_CHARS) return false;
        hit = { ...hit, excerpt: hit.excerpt.slice(0, remaining) };
      }
      seen.add(key);
      used += hit.excerpt.length;
      excerpts.push(hit);
      return hit.excerpt.length > 0;
    };
    for (const entryId of config.entryNotes) {
      const note = this.generation.notes.get(entryId);
      if (!note) continue;
      const sections = note.parsed.sections;
      if (sections.length === 0) continue;
      let text = '';
      let endLine = sections[0]!.endLine;
      for (const section of sections) {
        const candidate = text.length === 0 ? section.text : `${text}\n${section.text}`;
        if (candidate.length > ENTRY_EXCERPT_MAX_CHARS) {
          if (text.length === 0) text = section.text.slice(0, ENTRY_EXCERPT_MAX_CHARS);
          break;
        }
        text = candidate;
        endLine = section.endLine;
      }
      const hit = this.toHit(entryId, { heading: note.parsed.title, line: sections[0]!.line, endLine, text }, text.trim(), 0);
      if (!fit(hit)) return { project: config.name, excerpts, truncated: true };
    }
    if (topic !== undefined && topic.trim().length > 0) {
      for (const hit of await this.search(topic, { limit: CONTEXT_TOPIC_HITS })) {
        if (!fit(hit)) break;
      }
    }
    return { project: config.name, excerpts, truncated };
  }

  // ---------------------------------------------------------------- check

  async check(): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    await this.refresh(true);
    const g = this.generation;
    const diagnostics: Diagnostic[] = g.diagnostics.map((d) => ({ ...d }));
    const resolved = await this.resolveAllLinks();
    for (const [noteId, links] of resolved) {
      for (const link of links) {
        if (link.status === 'broken') diagnostics.push({ code: 'LINK_BROKEN', noteId, message: `Link on line ${link.line} does not resolve to a note` });
        else if (link.status === 'ambiguous') diagnostics.push({ code: 'LINK_AMBIGUOUS', noteId, message: `Link on line ${link.line} matches ${link.candidates?.length ?? 0} notes with the same name` });
        else if (link.status === 'missing_heading') diagnostics.push({ code: 'LINK_MISSING_HEADING', noteId, message: `Link on line ${link.line} points to a heading that does not exist` });
        else if (link.status === 'outside_root') diagnostics.push({ code: 'LINK_OUTSIDE_ROOT', noteId, message: `Link on line ${link.line} points outside the configured roots` });
      }
    }
    const sourceBudget: SourceBudget = { bytes: 0, references: 0, hashes: new Map() };
    for (const noteId of [...g.notes.keys()].sort()) {
      const note = g.notes.get(noteId)!;
      for (const diagnostic of await this.checkSources(note, sourceBudget)) diagnostics.push(diagnostic);
    }
    const ok = !g.degraded && !diagnostics.some((d) => FAILING_CODES.has(d.code));
    return { ok, diagnostics };
  }

  private async checkSources(note: IndexedNote, budget: SourceBudget): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    const noteId = note.noteId;
    const declared = note.parsed.metadata['sources'];
    if (Array.isArray(declared) && declared.length !== note.parsed.sources.length) {
      out.push({ code: 'SOURCE_INVALID', noteId, message: 'One or more source entries lack a string root and path' });
    }
    const storage = await this.storage();
    const { sourceRoots, limits } = this.project.config;
    if (note.parsed.sources.length > 64) {
      return [{ code: 'SOURCE_LIMIT_EXCEEDED', noteId, message: 'A note may declare at most 64 source references' }];
    }
    for (const source of note.parsed.sources) {
      budget.references++;
      if (budget.references > limits.maxFiles) {
        out.push({ code: 'SOURCE_LIMIT_EXCEEDED', noteId, message: 'Source reference checks exceed limits.maxFiles' });
        break;
      }
      const label = `${source.root}/${source.path}`;
      if (!source.sha256) {
        out.push({ code: 'SOURCE_UNVERIFIED', noteId, message: `Source ${label} declares no sha256; its state is unknown` });
        continue;
      }
      const root = sourceRoots.find((r) => r.id === source.root);
      if (!root) {
        out.push({ code: 'SOURCE_INACCESSIBLE', noteId, message: `Source root ${source.root} is not configured` });
        continue;
      }
      if (!root.include.some((pattern) => minimatch(source.path, pattern, { dot: false, nonegate: true, nocomment: true, windowsPathsNoEscape: true }))) {
        out.push({ code: 'SOURCE_INACCESSIBLE', noteId, message: `Source ${label} is not covered by the root's include globs` });
        continue;
      }
      let absolute: string;
      try {
        absolute = await storage.resolveSource(this.project, root.id, source.path);
      } catch (error) {
        const missing = errorCode(error) === 'NOT_FOUND' || errorCode(error) === 'NOTE_NOT_FOUND';
        out.push({ code: missing ? 'SOURCE_MISSING' : 'SOURCE_INACCESSIBLE', noteId, message: `Source ${label} was rejected (${errorCode(error) ?? 'RESOLVE_ERROR'})` });
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        out.push(code === 'ENOENT'
          ? { code: 'SOURCE_MISSING', noteId, message: `Source ${label} does not exist` }
          : { code: 'SOURCE_INACCESSIBLE', noteId, message: `Source ${label} could not be inspected (${code ?? 'IO_ERROR'})` });
        continue;
      }
      if (!stat.isFile() || stat.size > limits.maxFileBytes) {
        out.push({ code: 'SOURCE_INACCESSIBLE', noteId, message: `Source ${label} is not a regular file within maxFileBytes` });
        continue;
      }
      let actual: string;
      try {
        const cached = budget.hashes.get(absolute);
        if (cached) actual = cached;
        else {
          if (budget.bytes + stat.size > limits.maxTotalBytes) {
            out.push({ code: 'SOURCE_LIMIT_EXCEEDED', noteId, message: 'Source hashing exceeds limits.maxTotalBytes' });
            continue;
          }
          const bytes = await readBoundedBytes(absolute, Math.min(limits.maxFileBytes, limits.maxTotalBytes - budget.bytes), 'Source');
          budget.bytes += bytes.length;
          actual = createHash('sha256').update(bytes).digest('hex');
          budget.hashes.set(absolute, actual);
        }
      } catch {
        out.push({ code: 'SOURCE_INACCESSIBLE', noteId, message: `Source ${label} could not be read` });
        continue;
      }
      if (actual === source.sha256.toLowerCase()) {
        out.push({ code: 'SOURCE_VERIFIED', noteId, message: `Source ${label} matches the declared sha256; this proves byte equality only and does not prove architectural correctness` });
      } else {
        out.push({ code: 'SOURCE_CHANGED', noteId, message: `Source ${label} differs from the declared sha256` });
      }
    }
    return out;
  }
}
