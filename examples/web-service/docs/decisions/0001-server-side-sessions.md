---
type: adr
status: proposed
---
# ADR 0001: Server-side sessions

## Context

The fictional service needs revocable sessions and a clear expiration policy.

## Decision

Store session state behind an adapter and use an opaque client identifier.

## Consequences

Revocation is straightforward, while availability and latency depend on the session store. The [session module](../modules/session.md) owns policy; adapters own persistence.
