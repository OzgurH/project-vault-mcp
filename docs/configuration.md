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
    "rescanIntervalMs": 1000,
    "maxDirectoryEntries": 50000,
    "maxDepth": 32,
    "maxLinksPerNote": 2048
  },
  "security": {
    "audit": true,
    "blockSecrets": true,
    "maxConcurrentRequests": 4,
    "maxRequestsPerMinute": 120
  }
}
```

`sourceRoots` is optional. Do not copy the example source root into a project without a matching `src` directory. `init` starts with no source scanning configured. Omitted optional fields receive defaults; invalid fields, limits, roots, and configuration versions are rejected.

## Note identity

`docs/architecture/overview.md` consists of root ID `docs` plus relative path `architecture/overview.md`. IDs are stable and explicit even when multiple roots contain files with the same basename. Root paths must remain within the explicitly configured project. Notes roots must exist when serving a project.

## Frontmatter

Existing notes need no rigid schema. Templates use optional `type` and `status` fields. Unknown metadata is retained. Access is denied for `private: true`, `visibility: private`, `ai_access: false`, `personal_data: true`, `classification: confidential` or `classification: restricted`. Classification values are case-insensitive. Malformed privacy metadata fails closed; use actual YAML booleans rather than quoted strings.

`expires_at` accepts an ISO timestamp with an explicit timezone, for example `2030-01-01T00:00:00Z`, or a date such as `2030-01-01` interpreted as UTC midnight. Fractional seconds are evaluated at millisecond precision. A past timestamp denies access; an invalid value also denies access. Expiry restricts retrieval and tool writes; it does not delete the note or downstream copies. Labels are owner-supplied and cannot detect every unlabelled personal record. See [privacy](privacy.md).

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

`maxDirectoryEntries` counts all encountered directory entries across notes roots, including non-Markdown files. `maxDepth` bounds nested traversal. `maxLinksPerNote` bounds Markdown and wikilink collection; an over-budget note is rejected rather than partially parsed. Default limits apply when fields are omitted.

Before Markdown parsing, a linear structural guard rejects bodies with more than `4 × maxLinksPerNote` opening square brackets (8192 by default). Brackets inside code/HTML count toward this early budget because the parser must process them too. This deliberately rejects extreme markup before dependency parsing can monopolize the event loop; the subsequent link collector still enforces the exact link count.

`maxResponseChars` bounds retrieved text; a serialized tool payload may use up to twice that budget for JSON escaping and metadata. Long reads are truncated with explicit line bounds and `truncated: true`; if metadata or a non-read result alone exceeds the envelope, the tool returns `RESPONSE_TOO_LARGE`.

## Search locale

`default` uses locale-neutral Unicode case handling. Set `searchLocale` to `tr` for Turkish dotted/dotless-I folding. Project documentation remains English; this setting controls matching of your own note content.

## Writes

Set `allowWrites: true` and start `serve --allow-write` to expose `create_note` and `update_note`. Calls preview by default. Applying requires `apply: true`; updates additionally require the exact revision from `read_note`. Client tool permissions should reflect your intended workflow.

The direct library `writeNote` API checks project configuration and revision/privacy policy; its trusted caller owns invocation authority. `--allow-write` is an additional MCP registration gate, not a flag in the library API. Applying is not proof of human approval.

## Request policy and audit

`security` is optional. Its defaults are audit enabled, four concurrent tool executions and 120 validated tool requests per minute per process. Bounds are 1–32 for concurrency and 1–10000 for requests per minute. Busy work is rejected without queuing; exhausted budgets return `RATE_LIMITED`. These controls operate after SDK schema validation, not at the raw stdio/OS boundary.

Validated attempts rejected as `SERVER_BUSY` still consume the minute budget. This deliberately bounds retry floods as well as admitted work; use client backoff instead of immediate concurrent retries.

`blockSecrets: true` rejects note reads and candidate writes containing recognized private-key headers, GitHub token shapes or AWS access-key IDs. The error is `CONTENT_RESTRICTED` and never includes the matched value. This narrow guard cannot recognize all credentials or personal data. An owner may deliberately set `blockSecrets: false` for synthetic training material; keep actual secrets outside exposed roots regardless.

Audit writes one JSON event to stderr with only tool name, random request ID, timestamp, outcome, typed error code and duration. It omits arguments, note IDs, project paths and raw errors. At most twice the request budget is logged per minute; excess events are suppressed. Events are best effort. Set `audit: false` to disable them; trusted library hosts can supply `createServer(..., { auditSink })` for a custom collector. The collector's retention, transport security and access controls are deployment responsibilities.

Every MCP tool checks the configuration digest and plain ancestor chain. If the startup configuration changes, disappears or becomes inaccessible, requests return `POLICY_CHANGED`. Restart to load the new policy. No automatic reload expands an existing process's authority.
