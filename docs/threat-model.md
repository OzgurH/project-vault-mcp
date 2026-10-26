---
type: architecture
status: active
---
# Threat model

## Assets and boundaries

Assets are note confidentiality, note and configuration integrity, availability of the stdio process, revision provenance and release integrity. The application runs as one unprivileged OS account for one explicitly selected project. It is not a multi-tenant service.

Trusted components are the OS identity/session, project configuration owner, installed runtime/package, filesystem primitives and the host's authority to start the process. Untrusted inputs include note bodies, YAML, links, file names, client arguments, source references and external edits. The host is a data recipient; it is not trusted to redefine root/privacy/write policy.

| Boundary | Enforcement |
| --- | --- |
| Client to stdio tool | Typed bounded schema, request admission, unchanged startup policy, tool registration gates. |
| Tool to local filesystem | Configured roots, canonical IDs, exclusions, ancestor/link checks, bounded reads and current frontmatter. |
| Cached index to response | Current note access and revision checks; discovery failure invalidates cached retrieval. |
| Candidate Markdown to durable note | Content/privacy validation, preview default, explicit apply, lock, revision and metadata checks, protected staging. |
| Project to optional source root | Explicit inclusion globs; bounded hashing, no source-body excerpts or external URL fetches. |
| Server to host | Bounded JSON reference data, never executable instructions. Host owns provider forwarding. |
| Build to public release | Locked dependencies, pinned workflows, tests, installed-package smoke and release checksums. |

## Attacks considered

Consider malicious Markdown seeking excessive CPU/memory, private/deleted-note recovery through stale caches, traversal/ADS/device names, symlink/junction escapes, unsafe YAML, stale-revision overwrites, cooperating writer races, permission broadening during replacement, misleading configuration reload, log-content leakage and compromised dependencies. Each maps to controls and regressions in [security controls](security-controls.md).

## Limits and residual risks

- A malicious same-account process or administrator can alter memory, binaries, files or the client. This service is not an OS sandbox.
- External editors do not honor writer locks. The final revision and metadata checks narrow races but cannot provide a shared transaction with every editor.
- Disk encryption, inherited Windows folder permissions, backups, ACL administration and crash-dump handling remain deployment concerns. Network filesystems and cloud-sync semantics need separate acceptance.
- Returned Markdown can contain prompt injection. Clients must treat it as evidence and use their own tool permissions; an `apply` argument is not proof of human consent.
- Privacy markers cannot identify every unlabelled personal record or credential. Do not expose unnecessary data.
- Rate/concurrency limits apply per process to validated tool execution; they are not a network firewall or an OS memory quota. Stop an abusive host/process at the OS boundary.
- Metadata-only audit is best effort and bounded. It provides neither immutable evidence nor guaranteed delivery to a collector.
- Revocation prevents future server retrieval. It cannot recall existing host/provider copies or guarantee garbage-collected memory has been wiped.

Reassess before adding remote transport, authentication, multi-user roots, attachments returned as bytes, persistent indexes, execution tools or external model calls.
