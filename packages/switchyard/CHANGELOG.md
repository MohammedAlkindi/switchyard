# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [docs/deployment.md](docs/deployment.md) for what patch/minor/major mean for
this package.

## [Unreleased]

### Added

- In-memory AST symbol conflict filter (`src/lib/semantic.ts`). `fleet check`,
  `fleet merge` and `fleet mcp` can now flag two agents changing the same symbol
  or a symbol the other side depends on, not only the same file or line.
  It is a heuristic filter, not a proof of semantic compatibility.
- The symbol filter reads Python (`.py`) as well as TypeScript/JavaScript,
  with a dependency-free extractor (`src/lib/pysymbols.ts`).
- Multi-agent benchmark harness and an 8-task suite (`npm run benchmark`).
- P3 evaluation of the symbol filter on perturbed SWE-bench Lite traces
  (`scripts/p3/`): precision, recall and latency per detector, produced by
  code in the repo.

### Changed

- `fleet check --semantic` (and `merge --semantic`, MCP `semantic`) uses
  precise rules: a reference counts only if the other agent added or changed
  the line, resolved through an import of the provider module or in the same
  file; only changes that can break an existing caller count (an added optional
  parameter does not); constructor changes reach `Class(...)` callers; a deleted
  file deletes its symbols. The first rules stay available as
  `LEGACY_SEMANTIC` for comparison.
- Docs state the scope plainly: Switchyard detects textual collisions and, with
  the symbol filter, some semantic ones. It does not guarantee a merge is
  correct. See `docs/architecture.md`.
- Semantic checks read all blobs through one `git cat-file --batch` process
  instead of one `git show` per file.

### Fixed

- The CLI no longer imports `typescript` at startup. It is a devDependency, so
  an installed CLI would have crashed on every command, `--version` included, with
  `ERR_MODULE_NOT_FOUND`. It is now loaded on first TS/JS semantic check, with
  a clear error if it is missing. A packaging test fails if `dist/` statically
  imports anything outside the runtime dependencies.

### CortexAI gateway (`packages/cortexai`, not published)

- `POST /v1/chat/completions` accepts `"stream": true` and returns OpenAI-style
  server-sent events, ending with `data: [DONE]`. Usage is billed once the
  stream finishes.
- Streaming honours `stream_options.include_usage`: chunks carry
  `usage: null` and a final chunk with empty `choices` carries the totals.
  A mid-stream error ends with `finish_reason: "error"`, and partial output
  is billed once on error or client disconnect instead of not at all.
- Local model support (`torch`, `transformers`) is probed on first use instead
  of at import time, so importing the package no longer loads them. This also
  fixes the transformers check in `AICore`, which read a value that stayed
  `False`.

### Website

- Rebuilt the public site around a read-only fleet review: browser-local import
  of existing list/check JSON exports, per-agent conflict and validation evidence,
  filters, plan selection and Markdown handoff download. The synthetic example
  comes from real temporary Git worktrees. Reports and notes never leave the tab.
  This website release does not change the CLI or publish a new npm version.


## [0.5.0] - 2026-10-23

### Added

- `fleet validate` (and `--all`, `--json`): run a repo-configured `validate`
  command inside an agent's worktree and record the outcome on the agent's
  state entry, pinned to the exact commit and command. Staleness is derived,
  never stored — a record only ever means "this commit got this result from
  this command". Dirty worktrees are refused: a record certifies a commit.
- `fleet list` now shows a `VALIDATED` column (`passed` / `failed` / `stale` /
  `—`), and its `--json` output — and therefore the read-only MCP tools —
  carries `validation` and `validatedAt` per agent, with no change to the MCP
  tool surface.
- `fleet merge` enforces the gate when `validate` is configured: a passing
  record at the agent's tip is trusted (the command is not re-run), a failing
  record at the tip refuses immediately, and a missing or stale record is run
  and recorded on the spot. `preMerge` is unchanged and still runs at merge
  time — `validate` is the recorded, skippable gate; `preMerge` the always-run
  hook.
- `fleet dashboard` (and `--once`, `--interval`): one live pane composing the
  agent table (validation column included), per-agent touched-file counts, a
  validation tally, and the full collision report with merge-simulation
  verdicts. `--once` prints a single frame for scripts and CI logs.
- `fleet check` results (human, `--json`, and MCP) now include `agentFiles`:
  how many files each agent touched vs its base, computed for any fleet size —
  including a single agent, which previously short-circuited before gathering
  anything.
- New `.fleetrc.json` key `validate`, validated like the other hook commands
  and covered by the shipped JSON schema.

### Fixed

- Shell completions now list `init` and `undo`, which were missing from the
  generated scripts.
- State and undo records can no longer direct Git operations at worktrees
  outside `.fleet/worktrees/<agent>` (including lookalike paths, symlinks, and
  Windows junctions). Unsafe state is refused before mutation and can be
  rebuilt safely with `fleet doctor --fix`.
- State and undo records must also keep the documented `fleet/<agent>` branch
  identity. A corrupted record can no longer redirect merge, validation, or
  branch-deletion operations to an unrelated branch.
- Validation now re-checks worktree cleanliness after the configured command.
  Commands that leave tracked or untracked changes no longer create a record
  or let `fleet merge` proceed, regardless of their exit code; commands that
  commit their changes and finish clean remain supported.
- Stale-lock recovery diagnostics now go to stderr, preserving the single
  parseable stdout payload promised by mutating commands with `--json`.
- Successful merges now persist undo metadata before post-merge cleanup. If
  worktree removal, branch deletion, or the state write is interrupted,
  `fleet undo` recovers from live branch/worktree state instead of losing the
  rollback path.

### Notes

- The state file gains an optional per-agent `validation` object; the schema
  version stays 1 and files written by older versions load unchanged.
  `fleet doctor --fix` rebuilds drop the record (it is re-derivable by
  re-running `fleet validate`), consistent with rebuilds re-deriving
  `baseBranch` and `createdAt`.
- The MCP surface is still read-only: validation state flows out through the
  existing tools; nothing new is invokable by an agent.

## [0.4.0] - 2026-07-22

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
- Switchyard has a website: [switchyardhq.vercel.app](https://switchyardhq.vercel.app)
  (the `public/` directory of this repo; not part of the npm package).

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

[Unreleased]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MohammedAlkindi/Switchyard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MohammedAlkindi/Switchyard/releases/tag/v0.1.0
