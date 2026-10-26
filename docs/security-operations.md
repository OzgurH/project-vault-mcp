---
type: runbook
status: active
---
# Security operations

## Before connecting a vault

1. Use a pinned tested release and an unprivileged OS account. Protect the account session and the vault directory with OS ACLs; use BitLocker, FileVault or LUKS and encrypted backups as appropriate to your deployment.
2. Expose only necessary roots. Review exclusions, privacy flags, optional sources and the host's forwarding/retention policy. Do not connect live credentials or raw personal records.
3. Keep `allowWrites: false` unless needed. If enabled, give the host only the tool permissions the workflow needs; preview and review before applying.
4. Run `project-vault check --root /path/to/project`. Investigate degraded status instead of raising limits without understanding the cause.
5. Set an organization-owned retention period and collector access policy for stderr audit. Audit events contain operational metadata; they are not anonymous simply because note text is omitted.

## Policy change or privacy revocation

Mark a note restricted, move it outside the exposed root, or remove it through an authorized filesystem workflow. Future retrieval rechecks current access. A configuration change causes `POLICY_CHANGED` on subsequent tool requests; stop and restart the process to adopt it. Changes do not revoke content already returned to the host.

For strict containment stop the server, correct the policy/data, review downstream recipients, then restart and verify read/search/context/link denial using the actual client. Do not copy protected content into a test log while verifying denial.

## Rectification and erasure

Confirm request identity and scope outside this server. Use a revision-aware update for allowed note corrections or your approved filesystem workflow for restricted notes/deletion. Check Git history, backups, sync versions, crash dumps, hidden staging residue, host histories and provider copies. Resolve legal holds and retention requirements before deleting retained copies. Neither note expiry nor removing the current file proves complete erasure. Record an outcome without unnecessary personal details and verify future retrieval is blocked.

## Abandoned lock or staging file

Locks are under the account home's `.project-vault-mcp/locks`. A stale timestamp alone is not permission to delete a lock. Verify the PID's start time/command and that no active writer owns the target. Stop the owning process gracefully if necessary. Only then remove the exact abandoned lock or hidden `.NAME.md.pv-tmp-*` file through normal filesystem maintenance. Never print or publish replacement-file contents during cleanup. Keep vault permissions restrictive even when no server is running.

## Suspected disclosure or compromise

Stop the process and revoke the host's access. Preserve only the necessary evidence with restricted access. Rotate any exposed credentials at their issuer, determine which notes/recipients were affected, and involve the organization's incident/privacy owner for notification and transfer assessment. A clean dependency scan does not prove the incident is resolved.

Report product vulnerabilities through [private vulnerability reporting](https://github.com/OzgurH/project-vault-mcp/security/advisories/new). Public issues must not contain private notes, personal records, credentials or working exploit details. Retest the relevant boundaries and use a patched release before reconnecting.
