---
type: architecture
status: proposed
---
# Architecture overview

This fictional service separates its HTTP boundary, session module, and storage adapter.

## Request flow

The HTTP boundary validates the request, then delegates session checks to the [session module](../modules/session.md). Storage access stays behind an adapter.

## Decisions

The proposed [server-side session decision](../decisions/0001-server-side-sessions.md) records the reasoning and tradeoffs. These notes are examples, not evidence of a deployed system.
