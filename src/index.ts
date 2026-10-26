/** Public programmatic surface of Project Vault MCP. */
export type {
  Diagnostic, KnowledgeStatus, Limits, NoteFile, NoteLink, NotesRoot, ParsedNote, Project, SearchHit, Section,
  SourceReference, SourceRoot, SecurityPolicy, VaultConfig, WriteOptions, WriteResult
} from './core/types.js';
export { VaultError } from './core/errors.js';
export { loadProject, defaultConfig } from './core/config.js';
export { readNoteFile } from './core/files.js';
export { writeNote } from './core/writes.js';
export { KnowledgeBase } from './core/knowledge.js';
export { createServer, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export type { ServerOptions } from './mcp/server.js';
export type { AuditEvent, AuditSink } from './mcp/security.js';
export { initProject } from './cli/init.js';
export type { InitResult } from './cli/init.js';
