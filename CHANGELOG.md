# Changelog

## 0.2.0

Security and privacy hardening. Upgrade from 0.1.0 to close stale-cache disclosure, replacement-permission broadening and quadratic wikilink work.

- Fail-closed scan invalidation and current-access/revision checks for cached retrieval.
- Protected replacement files, preserved file security metadata, minimized writer locks and secure scaffold creation.
- Linear wikilink scanning, link budgets, streamed bounded directory traversal and request admission limits.
- Privacy/expiry frontmatter and recognized credential-signature guards on exposure and candidate writes.
- Configuration-change revocation, bounded metadata-only audit and safer startup/internal errors.
- OWASP 2025 control map, scoped zero-trust design, GDPR/KVKK responsibility and data-lifecycle documentation.
- Scheduled dependency audit/CodeQL and Dependabot configuration.

Existing JSON configurations still load with secure defaults. Privacy markers with malformed types now deny access; review metadata and adjust explicit budgets as needed. Windows updates require the built-in Windows PowerShell ACL helper; failures leave existing notes unchanged. No remote transport, automatic erasure, comprehensive DLP or regulatory certification is introduced.

## 0.1.0

Initial release of a local-first MCP knowledge layer for software projects.

- Heading-aware Markdown retrieval, links, backlinks, project context, and index status.
- Generic architecture, module, ADR, runbook, and index templates.
- Explicitly gated create/update tools with previews and revision checks.
- CLI initialization, knowledge checking, stdio serving, and client configuration output.
- English documentation, a generic example project, and cross-platform CI.

See the README and SECURITY.md for limitations, write concurrency boundaries, and installation options.
