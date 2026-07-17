# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [docs/deployment.md](docs/deployment.md) for what patch/minor/major mean for
this package.

## [Unreleased]

## [0.1.0] - 2026-07-17

### Added

- Initial `fleet` CLI: one isolated git worktree per AI coding agent
  (`.fleet/worktrees/<agent>/` on branch `fleet/<agent>`), tracked in a
  gitignored `.fleet/state.json`.
- Commands: `spawn`, `list`, `status`, `check`, `diff`, `merge`, `remove`,
  `clean`, `watch`, `doctor`, `completion`.
- File-level collision detection across agents: `fleet check` exits 1 when any
  file is touched by more than one agent (CI-friendly), and `fleet merge`
  refuses to merge a colliding agent.
- Safe merge semantics: a conflicting merge is aborted (`git merge --abort`),
  never left half-done.
- Optional `.fleetrc.json` per-repo config: `defaultBase`, `watchInterval`,
  `autoClean` (precedence: CLI flag > config file > built-in default).
- `fleet doctor --fix` state repair: rebuilds `state.json` from
  `git worktree list`, adopts orphaned worktrees, prunes stale entries.
- `fleet sync <agent>`: merge the agent's base branch into its branch inside
  the worktree, with the same abort-on-conflict guarantee as `fleet merge`.
- `fleet exec <agent> -- <cmd>`: run a shell command inside an agent's
  worktree without cd'ing; `--all` fans out over every worktree sequentially
  and exits 1 if any run fails.
- `fleet pr <agent>`: push the agent's branch to `origin` and open a pull
  request via the GitHub CLI (`--title`, `--base`, `--draft`).
- `--json` on `list`, `status`, `check`, and `doctor` for scripts, CI gates,
  and agents consuming Switchyard state directly.
- `fleet check --lines`: opt-in line-range collision refinement — same-file
  edits on disjoint lines are reported separately instead of blocking.
- `fleet clean --stale <days>`: also remove agents idle for that long (clean
  worktrees only; their branches are kept so the work stays recoverable).
- Worktree provisioning in `.fleetrc.json`: `copyOnSpawn` (files copied into
  every new worktree), `postSpawn` (setup command, e.g. `npm ci`), and
  `preMerge` (gate command, e.g. `npm test` — non-zero aborts `fleet merge`).
- `.fleetrc.json` accepts an editor `$schema` key, and the package ships
  `schema/fleetrc.schema.json` for it (autocomplete and validation).
- `fleet spawn` validates agent names up front: names that are invalid as git
  refs or reserved on Windows are rejected with a clear error.

### Changed

- Project name is **Switchyard**; it publishes to npm as
  `@switchyardhq/git-fleet` (unscoped `git-fleet` is blocked by npm's
  punctuation-similarity rule — `gitfleet` already exists). The installed
  binary is `fleet`.

[Unreleased]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MohammedAlkindi/Switchyard/releases/tag/v0.1.0
