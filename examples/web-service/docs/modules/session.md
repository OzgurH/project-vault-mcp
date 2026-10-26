---
type: module
status: proposed
---
# Session module

## Responsibility

Resolve an opaque session identifier into an authenticated principal and reject expired sessions.

## Boundary

The module depends on a session-store interface. HTTP cookie parsing belongs to the transport layer. See the [architecture](../architecture/overview.md) and [decision](../decisions/0001-server-side-sessions.md).
