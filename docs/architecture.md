---
type: architecture
status: active
---
# Architecture

Project Vault has one project configuration and one in-memory knowledge index per stdio server process. Markdown remains the durable storage format. Clients do not need Obsidian running, an embedding model, or a separate database.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `core/config` | Validate configuration and anchor relative roots to the project. |
| `core/paths` | Resolve allowed note/source paths and enforce containment/exclusions. |
| `core/files` | Bounded, revision-tagged reads and note discovery. |
| `core/writes` | Preview/create/update with preconditions and cooperating writer locks. |
| `core/markdown` | Frontmatter, sections, headings, and links. |
| `core/knowledge` | Index generations, ranking, context, link and source checks. |
| `core/templates` | Generic English knowledge templates. |
| `mcp/server` | Typed MCP tools and explicit mutation registration. |
| `mcp/security` | Current policy digest, bounded admission and minimized audit events. |
| `cli` | Initialization, validation, client configuration, and stdio lifecycle. |

The transport consumes core APIs. Retrieval and link resolution cannot bypass the path policy. Source checks can hash explicitly allowed source files; they do not return source text or infer code structure.

## Evidence and freshness

Search returns the revision used by an index generation. `read_note` returns a current disk revision. Retrieval rechecks access and revision before returning cached material; changed notes may be omitted until rescanning. Failed discovery invalidates cached retrieval. A source hash proves equality to recorded bytes, not semantic correctness, deployment, or runtime acceptance.

## Updates

Mutation registration requires configuration and a startup flag. Each tool call previews unless `apply=true`. Updates compare an expected raw-byte revision, serialize cooperating processes, and replace the file atomically. External editors do not share that lock; see the [security model](https://github.com/OzgurH/project-vault-mcp/blob/main/SECURITY.md).

## Tradeoffs

In-memory indexing avoids index migrations and shared database writers. Full directory rescans are bounded and simple, with a cost proportional to the allowed note set. The first release favors predictable retrieval over semantic search and language-specific code analysis.

See [configuration](configuration.md) and [the foundational decision](decisions/0001-local-markdown-and-stdio.md).

The [threat model](threat-model.md), [control map](security-controls.md), [privacy lifecycle](privacy.md) and [security operations](security-operations.md) describe the security boundaries and owner responsibilities.
