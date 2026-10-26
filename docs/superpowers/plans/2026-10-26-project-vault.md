# Project Vault MCP Implementation Plan

> **For agentic workers:** Use subagent-driven development with the user's chosen concurrent local Claude Code sessions. Codex owns integration and GitHub publication.

**Goal:** Publish an English-only, tested open-source MCP server for reading, creating and updating architecture knowledge in ordinary Markdown.

**Architecture:** One configured project per stdio process. Storage/path policy, knowledge parsing/search, and transport/CLI are independent modules using src/core/types.ts.

**Tech Stack:** Node >=22.12, TypeScript, official MCP SDK, remark/unified, YAML, Vitest.

**Spec:** docs/design.md

## Global constraints

- Every public file, error, comment and example is English; arbitrary-language note content is supported.
- Notes never escape declared roots; private content is excluded consistently.
- Writes require configuration plus startup flag, explicit apply and revision preconditions.
- No worker Git/publication actions; no unrelated/private source is copied.
- npm publication is outside this task. GitHub public creation and main push are authorized.

## Review focus

- Malicious links and Windows aliases cannot bypass direct-read restrictions (storage and link tests).
- Existing editor changes cause revision conflicts, without claiming locks coordinate external editors (write tests).
- CRLF/BOM and Unicode paths survive real writes (storage tests).
- Missing/excluded/unreadable notes never produce a false healthy scan (knowledge tests).
- Installed CLI speaks clean stdio through actual SDK client, including mutation preview/apply (transport smoke).

## Tasks

### 1. Storage and configuration

Own src/core/config.ts, paths.ts, files.ts, writes.ts and tests/storage.test.ts.
Interfaces: loadProject(rootOrConfig): Promise<Project>; defaultConfig(name?): VaultConfig; resolveNote(project,noteId,allowMissing?): Promise<string>; listNoteIds(project): Promise<string[]>; readNoteFile(project,noteId): Promise<NoteFile>; writeNote(project,noteId,content,options: WriteOptions): Promise<WriteResult>.

- [ ] Write and run failing tests for roots, limits, private/excluded files and revision writes.
- [ ] Implement safe configuration, traversal, reads and serialized atomic writes.
- [ ] Run assigned tests; receipt includes command/result and unresolved concerns.

### 2. Knowledge layer

Own src/core/markdown.ts, knowledge.ts, templates.ts and tests/knowledge.test.ts.
Interfaces: parseNote(content): ParsedNote; getTemplate(type): string; KnowledgeBase(project), refresh(force?), search(query,{limit?,type?}?), read(noteId,startLine?,lineCount?), links(noteId), context(topic?,maxChars?), status(), check(). All methods async except parseNote/getTemplate/status. Use storage APIs above; do not reimplement containment.

- [ ] Run failing parser/search/link/freshness tests, then implement.
- [ ] Cover fenced code, aliases, ambiguous basenames, anchors, partial scans, Unicode and budgets.
- [ ] Return a concise receipt; integrated tests belong to the integration owner.

### 3. MCP and CLI

Own src/mcp/server.ts, src/cli.ts, src/cli/init.ts, src/index.ts and tests/transport.test.ts.
Interfaces: createServer(project,{allowWrite?:boolean}): McpServer; CLI uses loadProject/KnowledgeBase/storage plus official stdio transport. Tools wrap the core, expose bounded JSON and typed errors; writes only registered when both gates permit. create_note uses expectedRevision=null; update_note requires revision. apply defaults false.

- [ ] Run failing tool schema/CLI tests before implementation.
- [ ] Implement init/serve/check/client-config and read/create/update tools.
- [ ] Real SDK integration tests may run only once integrated; record pending evidence accurately.

### 4. Integration, documentation and publication

Owner: Codex. Own dependencies/shared contracts, README/assets, examples, docs, LICENSE/SECURITY/CONTRIBUTING and CI.

- [ ] Integrate owned worktree files without overwriting shared files.
- [ ] Run typecheck/build/tests and actual packed-package CLI/MCP smoke; fix failures with regressions.
- [ ] Dispatch independent security and correctness reviews of the integrated tree; resolve findings.
- [ ] Verify English-only public content, package allowlist and no secrets/private artifacts.
- [ ] Commit tested intended files; create public repository and push main; verify exact remote SHA.
- [ ] Inspect CI across supported platforms and resolve failures before claiming completion.
