---
type: reference
status: active
---
# Security controls and verification

This is an implementation map, not a certification. Project Vault is a local stdio service. Web-specific controls are mapped to its actual filesystem and process boundaries. Read the [threat model](threat-model.md), [privacy guide](privacy.md), and [security policy](https://github.com/OzgurH/project-vault-mcp/blob/main/SECURITY.md) together.

## OWASP Top 10:2025

The category names below follow the [official OWASP 2025 list](https://top10.owasp.org/2025/). Applicability does not mean every risk is eliminated.

| Risk | Implemented control | Verification and deployment responsibility |
| --- | --- | --- |
| A01 Broken Access Control | Explicit contained roots, exclusions, link rejection, frontmatter restrictions, fresh retrieval authorization, two MCP write gates. | Storage, retrieval, transport and content regressions; run under a dedicated unprivileged OS account. |
| A02 Security Misconfiguration | Strict configuration schema, read-only default, policy-change revocation, preview-first writes. | Configuration and transport regressions; review roots and client launch permissions. |
| A03 Software Supply Chain Failures | Exact dependency versions, integrity lockfile, SHA-pinned Actions, Dependabot and scheduled dependency audit/CodeQL. | CI runs `npm ci`, `npm audit --audit-level=moderate`, and static analysis. Review update PRs; do not auto-trust a green badge. |
| A04 Cryptographic Failures | SHA-256 content revisions and release checksums; no secret storage or proprietary encryption scheme. | A digest is not authentication or encryption. Protect vaults, swaps, crash dumps and backups with OS disk encryption and appropriate ACLs. |
| A05 Injection | Typed bounded tool arguments, safe YAML, filesystem containment; note content stays data and external links are not fetched. | Parser/storage tests. MCP hosts must resist prompt injection in retrieved notes. The Windows ACL helper uses a fixed script and separate path parameters. |
| A06 Insecure Design | Documented trust boundaries, least privilege, byte/file/directory/depth/link budgets and request admission limits. | Adversarial content and transport tests; one stdio process represents one granted project capability. |
| A07 Authentication Failures | No remote listener or built-in password/token service. Authentication is the OS account and the host's authority to launch/connect the process. | Configure OS login/session protection and host tool approval. Do not expose stdio through an unauthenticated network bridge. Remote/multi-tenant service would require a separate design. |
| A08 Software or Data Integrity Failures | Raw-byte revision preconditions, cooperating writer locks, exclusive create, safe replacement and metadata checks. | Write regressions plus installed-package smoke. External editors are outside the lock protocol. |
| A09 Security Logging and Alerting Failures | Bounded JSON stderr audit events for admitted tool execution and rejected requests; no note bodies, paths, arguments or raw errors. | Transport tests verify minimization. Operators own collection, alerting, retention and sink availability. Events are best effort, not a tamper-proof journal. |
| A10 Mishandling of Exceptional Conditions | Failed discovery invalidates retrievable cache; privacy errors deny access, unexpected errors are generic, bounded retries, no unsafe truncation fallback. | Failure, concurrency and revocation regressions. A failed collector cannot change the reported outcome of an applied write. |

## Zero-trust application

[NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final) treats location and ownership as insufficient reasons for implicit trust. In this local service that principle means:

- A connected client receives only the configured project capability. Being local does not grant access outside roots, to private notes, or to write tools.
- Every tool checks that its configuration still matches the startup policy. A changed, missing or unreadable configuration returns `POLICY_CHANGED`; restart to adopt the new policy.
- Retrieval rechecks the current note access/revision instead of treating a cached generation as an authorization grant. Privacy/deletion changes revoke future retrieval; content already delivered to a host cannot be recalled.
- Writes need configuration permission, the startup flag, `apply: true`, and a matching revision for updates. The apply flag is a client instruction, not verified human identity or consent.
- Request work and metadata-only audit volume are bounded. Roots and note bytes are checked again at use time.

This implements resource-oriented checks within a trusted OS session. It is not an enterprise identity, device-attestation, EDR, tenant-isolation or full zero-trust platform.

## Verification commands

```sh
npm ci
npm run check
npm run smoke:package
npm audit --audit-level=moderate
node dist/src/cli.js check --root . --json
```

CI runs behavioral tests on Windows, Linux and macOS with Node 22 and 24. POSIX permission and Windows DACL assertions execute on their relevant platforms. A platform-specific branch is not evidence for another operating system. See [configuration](configuration.md) for exact limits and [operations](security-operations.md) for response and retention procedures.

Windows integration tests have a 90-second harness deadline to cover three ACL subprocesses with individual 20-second limits and runner overhead. This keeps teardown from deleting fixtures while a security operation is still running. Product subprocess limits and adversarial parser timing assertions remain unchanged.

The fixed Windows helper receives no stdin data; its input pipe is closed immediately so headless hosts receive EOF. ACL operations remain fail closed on a helper failure or deadline.

`scripts/diagnose-windows-acl.mjs` verifies fixed ACL operations in a minimal child environment in Windows CI. It prints only phase markers and elapsed/outcome fields for a synthetic temporary file; no paths or security descriptors are logged. The helper uses native .NET constructors to avoid cmdlet/module discovery in that environment. For investigation, `--compare-cmdlet` also runs the original cmdlet under inherited/minimal environments; CI evidence showed the minimal cmdlet stalled before construction while native construction completed in 153–212 ms.

Before applying Windows metadata, the helper checks the empty staging file's full owner/group/DACL descriptor. If it already exactly matches, it avoids an unnecessary rewrite that can trigger inheritance processing. The same exact post-copy and pre-replacement checks remain mandatory; no inheritance flags or ACEs are stripped to make a comparison pass. The synthetic probe may also report component-equality booleans/control-flag numbers without printing identities or ACL contents.

The 0.2.0 security review addressed three concrete 0.1.0 weaknesses: retained content after failed discovery (`security-retrieval.test.ts`), POSIX replacement-mode broadening (`security-writes.test.ts`) and quadratic wikilink processing (`security-content.test.ts`). Tests also cover privacy/expiry revocation, credential signatures, policy changes, admission limits and acknowledgement budgets. Windows owner/DACL grammar restrictions and POSIX extended-ACL exclusions remain explicit deployment limitations in the security policy.
