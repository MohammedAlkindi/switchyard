# Contributing to Switchyard

Thanks for helping out. This is the short version — the full ground rules live
in [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) (AI agents follow the same
rules you do), and the design rationale lives in
[docs/architecture.md](docs/architecture.md).

## Setup

```sh
git clone https://github.com/MohammedAlkindi/Switchyard.git
cd Switchyard
npm install     # also builds dist/ via the prepare hook
npm test
```

Requires Node.js >= 18.17 and git >= 2.31.

## Before you open a PR

All four gates must pass locally (CI runs the same set):

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

Add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a
user of the CLI would notice.

## Testing rules

- Every new or changed command ships with a test in `tests/<command>.test.ts`.
- Tests run against real throwaway git repositories created by
  `tests/helpers.ts` — never against your own repository's state.
- **No git mocks, ever.** Switchyard's entire value is correctness against
  real git behavior; a mock tests nothing.

## Commits and branches

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`.
- One logical change per commit; never bundle a refactor with a behavior
  change.
- Branch from `main` as `<type>/<short-kebab-description>`, e.g.
  `feat/json-output`. Don't commit multi-commit or reviewable work directly to
  `main`.

## Dependencies

Runtime dependencies are deliberately exactly four: `commander`, `simple-git`,
`chalk`, `cli-table3`. Before adding one, open an issue justifying what it does
and why it can't be ~30 lines of our own code.

## Structural changes

Read [docs/architecture.md](docs/architecture.md) first. In particular,
`.fleet/state.json` is a compatibility surface — schema changes need discussion
(and a `version` bump with a migration path) before any code.

## Releases

Publishing is maintainer-only; the process is in
[docs/deployment.md](docs/deployment.md).
