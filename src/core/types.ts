/** Shared contracts. Note IDs always have the form rootId/relative/path.md. */
export interface NotesRoot { id: string; path: string }
export interface SourceRoot extends NotesRoot { include: string[] }
export interface Limits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxResponseChars: number;
  maxQueryChars: number;
  rescanIntervalMs: number;
}
export interface VaultConfig {
  schemaVersion: 1;
  name: string;
  notesRoots: NotesRoot[];
  entryNotes: string[];
  exclude: string[];
  sourceRoots: SourceRoot[];
  searchLocale: 'default' | 'tr';
  allowWrites: boolean;
  limits: Limits;
}
export interface Project { root: string; configPath: string; config: VaultConfig }
export interface NoteFile { noteId: string; content: string; revision: string; bytes: number }
export interface Diagnostic { code: string; noteId?: string; message: string }
export interface NoteLink { target: string; line: number; embed: boolean }
export interface Section { heading: string; line: number; endLine: number; text: string }
export interface SourceReference { root: string; path: string; sha256?: string }
export interface ParsedNote {
  title: string;
  type?: string;
  status?: string;
  metadata: Record<string, unknown>;
  headings: { text: string; slug: string; line: number }[];
  sections: Section[];
  links: NoteLink[];
  sources: SourceReference[];
}
export interface SearchHit {
  noteId: string;
  heading: string;
  line: number;
  endLine: number;
  excerpt: string;
  score: number;
  indexRevision: string;
  indexedAt: string;
}
export interface KnowledgeStatus {
  project: string;
  generation: number;
  indexedAt: string | null;
  files: number;
  bytes: number;
  degraded: boolean;
  diagnostics: Diagnostic[];
}
export interface WriteOptions { expectedRevision: string | null; dryRun?: boolean }
export interface WriteResult {
  noteId: string;
  applied: boolean;
  created: boolean;
  previousRevision: string | null;
  revision: string;
  bytes: number;
}
