# Security

## Scope and trust

Project Vault MCP runs locally as the account that starts it. It assumes that account, the configured project root, and the underlying filesystem are trusted. Note contents, links, frontmatter, and tool arguments are untrusted data. Instructions found inside a note do not change server policy.

The server is not an OS sandbox. It does not defend against a malicious process running as the same user, filesystem replacement races controlled by that user, compromised dependencies, or a compromised MCP client. Do not run it with elevated privileges or connect a client to a project it should not access.

## Filesystem boundary

- Note tools operate within explicitly configured roots inside the project.
- Symlinks/junctions, traversal, hidden paths, private notes, Windows path aliases, and excluded paths are rejected according to the path policy.
- Links and source references use the same policy. External URLs are not fetched.
- Binary/oversized files and scan/response limits are enforced. YAML parsing is bounded.
- Source references are optional and require explicit source roots and inclusion globs; source contents are never returned as note excerpts.

Privacy labels and exclusions are not comprehensive data classification. The default credential guard blocks recognized private-key headers, GitHub token shapes and AWS access-key IDs; unrecognized credentials or personal data can still be exposed. Do not store secrets in the exposed knowledge layer. The server does not make network/model calls or send telemetry, but your MCP host may send tool responses to a remote model provider.

Cached retrieval rechecks current access and revision. Failed discovery discards cached retrievable material. Private, restricted, personal-data and expired-note markers deny access; malformed privacy metadata fails closed. See [configuration](docs/configuration.md).

## Mutation boundary

Mutation tools are absent unless the project enables writes **and** startup uses `--allow-write`. Calls preview by default; applying requires an explicit tool argument. Creation requires absence. Updating requires the exact current raw-byte SHA-256 revision. Unknown metadata is preserved because updates replace caller-supplied Markdown, not a lossy metadata projection.

Cooperating server processes use exclusive locks in `.project-vault-mcp/locks` under the OS account's home, independent of client temporary-directory settings. A stale lock fails closed rather than being stolen based only on elapsed time; investigate an abandoned lock before removing it. Updates revalidate under the lock and use a same-directory atomic replacement. No fallback truncates the original file. A process crash may leave a hidden `.NAME.md.pv-tmp-*` replacement file; tools exclude it. After confirming no writer owns it, it can be removed through normal filesystem maintenance.

External editors do not honor these locks. A revision precondition is not a transaction with Obsidian or another editor: a noncooperating process may save between the last check and replacement or overwrite the server's result later. Keep notes in version control and review changes. Network filesystems, unusual case-sensitive Windows directories, and cloud-sync race behavior are not certified.

On POSIX, new notes/staging/locks use mode `0600`, newly created lock/scaffold directories use `0700`, and replacement preserves the existing mode, UID and GID or aborts. Special mode bits are not propagated. POSIX extended ACLs, security labels and other xattrs are not copied; where those define access beyond mode/ownership, use a dedicated restrictive directory/account and validate the filesystem policy separately. On Windows, updates capture and apply owner/group/DACL metadata to empty staging before writing note bytes, then verify target/staging before replacement. The helper invokes built-in Windows PowerShell by absolute path with a fixed script and bounded execution, passing paths in a scoped environment. Inability to preserve metadata returns `SECURITY_METADATA` and leaves the target unchanged. New Windows files inherit directory ACLs; secure those directories before use. The server does not configure disk encryption or change existing folder ACLs.

Windows preservation supports ordinary owner/group/DACL descriptors. Foreign-owned files may need privileges the process does not have; NULL DACLs and conditional ACE descriptors outside the helper's supported grammar are rejected. Use appropriately owned notes with ordinary restrictive ACLs and run unprivileged. Do not elevate the server merely to bypass a `SECURITY_METADATA` error or silently transfer ownership to make an update succeed.

## Process policy and audit

Each validated MCP tool checks that the configuration digest still matches startup and that ancestors remain plain directories. Changed, missing or inaccessible policy denies requests until restart. The direct library API is for trusted callers and has no separate startup flag gate.

Concurrent/request and parser/traversal budgets bound normal tool work. Metadata-only JSON audit goes to stderr by default, with a bounded event rate and optional opt-out/custom sink. It contains tool names, random request IDs, timestamps, outcomes, typed codes and durations, never arguments, note IDs, content or raw exception text. Audit delivery is best effort; the host owns collection, alerting and retention. No claim of tamper-proof logging is made.

## Security and privacy references

- [OWASP 2025 and zero-trust implementation map](docs/security-controls.md)
- [Threat model and residual risks](docs/threat-model.md)
- [GDPR/KVKK data lifecycle and shared responsibilities](docs/privacy.md)
- [Incident, retention and erasure runbook](docs/security-operations.md)

These controls support deployment security; they do not certify regulatory compliance or a complete enterprise zero-trust architecture.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/OzgurH/project-vault-mcp/security/advisories/new) if available. If private reporting is unavailable, open an issue that requests a private contact channel without including exploit details, secrets, or private note contents. Do not publish working exploit details before maintainers can assess the report.

The `0.2.x` line is the supported release line. Upgrade from `0.1.0`: it can retain revoked notes after failed rescans, broaden POSIX permissions on replacement, and perform quadratic wikilink work. Security fixes require a new tested release; a README change alone is not remediation.
