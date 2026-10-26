# Working on Project Vault MCP

Read `docs/index.md`, `docs/architecture.md`, and `SECURITY.md` before changing boundaries. All product text, documentation, errors, comments, and examples must be English. Notes supplied by users may use any language.

- Keep Markdown as the durable format and the public API independent of a particular model, editor, or application language.
- Treat note content and tool arguments as untrusted data. Retrieval must never bypass root, exclusion, privacy, or size checks.
- Preserve explicit write gates, dry-run defaults, create-only behavior, and update revision preconditions.
- Add meaningful behavioral regressions for fixes. Run focused tests during development and `npm run check` before delivery.
- Update relevant architecture/configuration/security notes in the same change.
- Concurrent workers need disjoint file ownership. Do not revert another worker's changes. One integration owner controls shared contracts, dependencies, Git, and publication.
- Never commit private vaults, credentials, `.local/` logs, installed dependencies, or generated `dist/` output.
- Distinguish tests, documentation checks, and actual client acceptance. Do not claim an untested host or npm registry release.

The project can serve its own `docs/` via the checked-in `project-vault.json`.
