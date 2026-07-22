# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [docs/deployment.md](docs/deployment.md) for what patch/minor/major mean for
this package.

## [Unreleased]

### Added

- `fleet init --check`: verify the four onboarding artifacts without writing
  anything — read-only, lock-free, exit 1 on drift, `--json` for scripts. Wire
  it into CI so the agent-facing convention cannot silently rot after an
  upgrade. Broken `AGENTS.md` markers are reported as `broken` rather than
  thrown, so one damaged file still yields a full report.
- `fleet sync --all`: catch every registered agent up with its base in one
  sweep. Each agent gets the exact single-agent treatment (same dirty checks,
  same abort-on-conflict contract), but failures are collected and reported
  instead of thrown, so one dirty worktree or conflicting merge never strands
  the rest of the fleet. Exits 1 if any agent failed.
- `fleet init`: brings a repository into the fleet workflow in one command.
  Writes `.fleet/` into `.git/info/exclude`, a starter `.fleetrc.json` wired to
  the config schema, the Claude Code skill into `.claude/skills/switchyard/`,
  and an agent-neutral protocol block into `AGENTS.md` (created if absent).
  Idempotent — re-run after upgrading to refresh the agent-facing docs.
  `--force` overwrites an existing `.fleetrc.json`; `--json` prints the result.

### Changed

- **The shipped skill now installs itself.** 0.3.0 shipped it in the tarball and
  documented a manual `cp` into `.claude/skills/`, which meant the convention
  usually never reached the agents that needed it. `fleet init` installs it, and
  re-running refreshes it.
- Agents other than Claude Code can now learn the convention. The `AGENTS.md`
  block carries the short version for anything that reads that file — Codex,
  Cursor, and others — where previously only a Claude Code skill existed.

### Notes

- What `fleet init` overwrites is split on ownership. `.fleetrc.json` is your
  file and is never replaced without `--force`; the skill and the `AGENTS.md`
  block are package-managed and refreshed every run. In `AGENTS.md` only the
  region between `<!-- switchyard:begin -->` and `<!-- switchyard:end -->` is
  rewritten. Broken markers are an error, not a guess.
- No new runtime dependencies, and no change to `state.json` (still
  `version: 1`) — `fleet init` adds no persisted fleet state of its own.
- The MCP surface is unchanged and still read-only.

## [0.3.0] - 2026-07-19

### Added

- `fleet mcp`: serves fleet state to AI agents over the Model Context Protocol
  (stdio transport, revision `2025-11-25`). Four read-only tools — `fleet_list`,
  `fleet_status`, `fleet_check`, `fleet_lock_status` — each returning the same
  object the matching `--json` flag prints, so the CLI and the MCP surface
  cannot disagree about state. Configure a client with
  `command: "fleet", args: ["mcp"]`.
- A Claude Code skill shipped in the package at `skills/switchyard/SKILL.md`:
  work in your own worktree, check before editing rather than before merging,
  how to read each collision verdict, and that provisioning is something to ask
  a human for. Install it by copying into your repo's `.claude/skills/`.
- Pure cores for `fleet check` and `fleet status` (`collectCheck`,
  `collectStatus`, and the matching `buildCheckReport` / `buildStatusReport`
  renderers), mirroring `collectListings` / `buildListTable`. Callers that need
  the data rather than the rendering no longer have to capture stdout.

### Notes

- **The MCP surface is read-only by design.** There is no tool to spawn, merge,
  remove, or clean — agents can observe the fleet but not join it, and
  provisioning stays a human action. The server states this at handshake time
  because an agent that hunts for a spawn tool, finds none, and falls back to a
  raw `git worktree add` recreates exactly the untracked state Switchyard
  prevents.
- No new runtime dependencies; the footprint is still `commander`,
  `simple-git`, `chalk`, `cli-table3`. The MCP SDK was declined — the surface
  needed here is one handshake and two methods over newline-delimited JSON.
- No change to `state.json` (still `version: 1`) and no change to `lock.ts`.
  The server never acquires the mutation lock, which is asserted by test.

## [0.2.0] - 2026-07-19

### Added

- Inter-process mutation lock (`.fleet/lock`): concurrent `fleet` commands
  from multiple processes no longer race on `state.json` (lost-update bug).
  `fleet doctor` reports the lock; `--fix` removes dead ones.
- Merge-conflict prediction: on git >= 2.38, `fleet check` and the
  `fleet merge` gate simulate each agent pair's merge with `git merge-tree`.
  Shared files that provably merge cleanly are informational instead of
  blocking. `--files-only` restores file-level behavior.
- `fleet undo`: one-command rollback of the last `fleet merge` — resets the
  target branch and restores the agent's branch, worktree, and state entry.
  `fleet doctor` reports when an undo is available.

### Changed

- **`fleet check` semantics on git >= 2.38:** overlapping files whose
  committed changes auto-merge no longer fail the check (exit 0) or block
  `fleet merge`. On older git, v0.1 file-level behavior is unchanged. Use
  `--files-only` to force the old semantics anywhere.

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
  `@switchyardhq/switchyard` (consolidated from `@switchyardhq/git-fleet`
  before first adoption — the scope makes the project's own name available
  even though unscoped `switchyard` is taken). The installed binary is
  `fleet`.

[Unreleased]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MohammedAlkindi/Switchyard/releases/tag/v0.1.0
