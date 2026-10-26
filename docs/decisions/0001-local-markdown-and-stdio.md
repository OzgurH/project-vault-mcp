---
type: adr
status: accepted
---
# ADR 0001: Local Markdown and stdio

## Context

Architecture knowledge should travel with a project and remain useful without a particular AI vendor or editor. A server that only returns files misses useful context relationships; an autonomous documentation writer introduces unreviewable claims and broader trust.

## Decision

Use plain UTF-8 Markdown with optional YAML frontmatter and existing Markdown/Obsidian links. Serve one explicitly configured project per local stdio process. Expose bounded retrieval and revision-checked create/update primitives. Keep mutation tools behind two explicit write gates and previews. All product material is English; note contents can use any language.

## Consequences

Notes are editable in existing tools and reviewable in Git. No server account, model, embedding service, or database migration is required. Independent client processes rebuild their own small indices. Filesystem/editor races remain a documented limitation, and no byte hash is promoted into a claim of architectural truth.

Remote access, language-specific source analysis, and semantic retrieval are separate future designs.
