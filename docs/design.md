# Design

Project Vault MCP is an independent, local-first knowledge layer for any software repository. Markdown is the durable format; Obsidian is an optional editor. Notes record architecture, modules, ADRs and runbooks. MCP provides bounded, cited retrieval and explicitly enabled revision-checked creation/update. No model, embedding service, Obsidian plugin or application framework is required.

The server handles one explicitly configured project per process over stdio. A schema-versioned project-vault.json defines notes roots, optional source-hash roots, entry notes, exclusions, locale, limits and write policy. All note IDs are rootId/relative/path.md, independent of process cwd. Source hashes prove byte equality only, never architectural correctness.

Core layers: configuration/path policy; bounded filesystem reads and writes; Markdown parsing/search/link/freshness; MCP/CLI. Storage is ordinary UTF-8 Markdown. Search/index snapshots are in process memory. Notes are untrusted source material, not instructions to the server. All public material is English. Non-English notes remain supported.

Writes require configuration allowWrites=true AND serve --allow-write. Calls use create_note or update_note and explicit apply=true; otherwise they return a preview. Updates require the exact SHA-256 revision from read_note. Creates require the target to be absent. Never delete or move notes. Serialize cooperating server writers with exclusive locks outside the vault, re-read inside the lock, then same-directory atomic replacement. Never truncate an existing file as fallback. Preserve UTF-8 BOM and existing newline style on updates. External editors do not honor locks: a last revision check narrows but cannot eliminate their race; document it honestly. Trusted local filesystem/account, untrusted content/arguments is the threat model.

Containment uses native real paths and component-wise checks. Reject traversal, symlink/junction/reparse escapes, Windows ADS/device/drive-relative aliases, hidden/private/excluded paths and oversized/binary files. Apply identical rules to links and source references. YAML custom tags are forbidden and alias expansion bounded. No shell, arbitrary file tool, telemetry, model call or HTTP service is exposed.

CLI commands: init (preview unless --apply; create missing files exclusively), serve, check (--json and nonzero for knowledge errors), client-config (print only). MCP: search_notes, read_note, get_note_links, get_project_context, get_knowledge_status, get_note_template, and create_note/update_note when explicitly enabled. Every response is bounded; protocol only on stdout, diagnostics on stderr.

Independent sessions implement storage, knowledge and transport in disjoint worktrees. The integration owner controls dependencies, docs, CI, Git and publication. Separate sessions review the integrated implementation for correctness and security. Acceptance includes behavioral tests, real official-SDK stdio calls, packed-package smoke and Windows/Linux/macOS CI. GitHub public publication is authorized; npm registry publication is a later task.

Deferred: semantic search, automatic source-language architecture extraction, code intelligence adapters, remote HTTP/OAuth, team sync and graphical UI.
