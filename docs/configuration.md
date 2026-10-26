---
type: reference
status: active
---
# Configuration

Place `project-vault.json` at the project root, or pass its absolute path as `--root`. Relative configured paths resolve from this file, not the current working directory.

```json
{
  "schemaVersion": 1,
  "name": "Example service",
  "notesRoots": [{ "id": "docs", "path": "docs" }],
  "entryNotes": ["docs/index.md", "docs/architecture/overview.md"],
  "exclude": ["**/drafts/**"],
  "sourceRoots": [{ "id": "source", "path": "src", "include": ["**/*.ts"] }],
  "searchLocale": "default",
  "allowWrites": false,
  "limits": {
    "maxFiles": 5000,
    "maxFileBytes": 1048576,
    "maxTotalBytes": 52428800,
    "maxResponseChars": 20000,
    "maxQueryChars": 500,
    "rescanIntervalMs": 1000
  }
}
```

`sourceRoots` is optional. Do not copy the example source root into a project without a matching `src` directory. `init` starts with no source scanning configured. Omitted optional fields receive defaults; invalid fields, limits, roots, and configuration versions are rejected.

## Note identity

`docs/architecture/overview.md` consists of root ID `docs` plus relative path `architecture/overview.md`. IDs are stable and explicit even when multiple roots contain files with the same basename. Root paths must remain within the explicitly configured project. Notes roots must exist when serving a project.

## Frontmatter

Existing notes need no rigid schema. Templates use optional `type` and `status` fields. Unknown metadata is retained. Private notes marked `private: true` or `visibility: private` are not exposed.

Optional source evidence:

```yaml
---
type: architecture
status: active
sources:
  - root: source
    path: auth/session.ts
    sha256: <recorded-64-character-sha256>
---
```

A hash is a digest of exact disk bytes, including line endings. Missing/inaccessible sources or changed bytes are reported; no hash is unknown evidence, never a proof of freshness. Inclusion globs are explicit; source content is not part of the note search index.

## Exclusions and limits

Built-in policy excludes hidden/private paths, dependency/generated directories, binary files, and oversized content. Your `exclude` globs add restrictions; they do not widen the root boundary. The same checks apply to tool reads, links, and writes. See [security](https://github.com/OzgurH/project-vault-mcp/blob/main/SECURITY.md).

Every scan and response is bounded. An incomplete scan produces degraded status; it must not masquerade as healthy knowledge. Lower the indexed scope if a project exceeds limits rather than disabling the boundary. A note may declare at most 64 source references; each check handles at most `maxFiles` source references and hashes at most `maxTotalBytes` of unique source files. Repeated references reuse that check's digest.

`maxResponseChars` bounds retrieved text; a serialized tool payload may use up to twice that budget for JSON escaping and metadata. Long reads are truncated with explicit line bounds and `truncated: true`; if metadata or a non-read result alone exceeds the envelope, the tool returns `RESPONSE_TOO_LARGE`.

## Search locale

`default` uses locale-neutral Unicode case handling. Set `searchLocale` to `tr` for Turkish dotted/dotless-I folding. Project documentation remains English; this setting controls matching of your own note content.

## Writes

Set `allowWrites: true` and start `serve --allow-write` to expose `create_note` and `update_note`. Calls preview by default. Applying requires `apply: true`; updates additionally require the exact revision from `read_note`. Client tool permissions should reflect your intended workflow.
