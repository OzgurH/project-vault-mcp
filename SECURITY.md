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

Exclusions are not secret detection. A credential pasted into an otherwise allowed Markdown note may be returned to the client. Do not store secrets in the exposed knowledge layer. The server does not make network/model calls or send telemetry, but your MCP host may send tool responses to a remote model provider.

## Mutation boundary

Mutation tools are absent unless the project enables writes **and** startup uses `--allow-write`. Calls preview by default; applying requires an explicit tool argument. Creation requires absence. Updating requires the exact current raw-byte SHA-256 revision. Unknown metadata is preserved because updates replace caller-supplied Markdown, not a lossy metadata projection.

Cooperating server processes use exclusive locks in `.project-vault-mcp/locks` under the OS account's home, independent of client temporary-directory settings. A stale lock fails closed rather than being stolen based only on elapsed time; investigate an abandoned lock before removing it. Updates revalidate under the lock and use a same-directory atomic replacement. No fallback truncates the original file. A process crash may leave a hidden `.NAME.md.pv-tmp-*` replacement file; tools exclude it. After confirming no writer owns it, it can be removed through normal filesystem maintenance.

External editors do not honor these locks. A revision precondition is not a transaction with Obsidian or another editor: a noncooperating process may save between the last check and replacement or overwrite the server's result later. Keep notes in version control and review changes. Network filesystems, unusual case-sensitive Windows directories, and cloud-sync race behavior are not certified.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/OzgurH/project-vault-mcp/security/advisories/new) if available. If private reporting is unavailable, open an issue that requests a private contact channel without including exploit details, secrets, or private note contents. Do not publish working exploit details before maintainers can assess the report.

The initial `0.1.x` line is the supported release line. Security fixes require a new tested release; a README change alone is not remediation.
