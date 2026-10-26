# Contributing

Thanks for helping make project knowledge easier to maintain.

## Start here

Read [the architecture](docs/architecture.md), [configuration](docs/configuration.md), and [security boundary](SECURITY.md). Open an issue before a broad feature so we can agree on scope. Small, focused fixes are welcome directly as pull requests.

All project documentation, code identifiers, comments, errors, examples, and public discussion should be in English. The product supports notes written in other languages; Unicode and locale handling need behavioral tests.

## Local setup

```sh
git clone https://github.com/OzgurH/project-vault-mcp.git
cd project-vault-mcp
npm ci
npm run check
```

Use Node 22.12+; CI exercises Node 22 and 24. Keep dependencies pinned and include lockfile changes when dependencies change.

## A focused pull request

1. Reproduce a bug with a meaningful failing behavioral test.
2. Make the smallest change that fixes it.
3. Update relevant architecture/configuration/security documentation.
4. Run `npm run check`; for packaging changes also run `npm run smoke:package` and inspect `npm pack --dry-run`.
5. Describe the concrete before/after behavior, verification, and remaining limitations.

Do not commit local vaults, private notes, credentials, `.local/` logs, `node_modules/`, `dist/`, or unrelated artifacts. Use generic fixtures in temporary directories. Do not replace behavioral tests with source-string assertions or LLM review output.

## Working with agents

Give each concurrent agent disjoint file ownership. One integration owner controls shared contracts, dependencies, Git, and publication. Agents must preserve other workers' edits and report actual test evidence separately from predictions. A separate review should inspect security-sensitive path/write changes before merge.

## Publishing

Maintainers publish only reviewed commits with green local checks and platform CI. A GitHub release package contains compiled JavaScript and explicit allowed assets. npm registry publication is currently a separate milestone; do not claim an npm package is available merely because `npm pack` succeeds.
