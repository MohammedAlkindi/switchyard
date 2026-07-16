<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Switchyard logo" width="140">
  </picture>
</p>

# Switchyard

> One repo, many AI coding agents, zero collisions — Switchyard's `fleet` CLI gives every agent an isolated git worktree, with collision detection before you merge.

[![license](https://img.shields.io/github/license/MohammedAlkindi/Switchyard)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/MohammedAlkindi/Switchyard/ci.yml?branch=main&label=CI)](https://github.com/MohammedAlkindi/Switchyard/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-80%25-green)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/MohammedAlkindi/Switchyard/pulls)

<!-- Restore once the package is published to npm (they render "package not found" until then):
[![npm version](https://img.shields.io/npm/v/git-fleet)](https://www.npmjs.com/package/git-fleet)
[![npm downloads](https://img.shields.io/npm/dm/git-fleet)](https://www.npmjs.com/package/git-fleet)
-->

<!-- The coverage badge is a static number: re-run `npm run test:coverage` and update it
     when it drifts. Replace with a Codecov (or similar) badge once coverage upload is
     wired into CI. -->


<p align="center">
  <img src="assets/demo.gif" alt="30-second demo: fleet spawn isolates two agents, fleet list shows the whole fleet, fleet check catches the collision before anyone merges" width="830">
</p>

<p align="center">
  <sub><code>fleet spawn</code> two agents · <code>fleet list</code> the whole fleet · <code>fleet check</code> catches the collision before anyone merges · <a href="assets/demo.mp4">full-quality mp4</a></sub>
</p>

<!-- The demo is rendered from demo.tape with vhs (see the comments at the top of that
     file), producing assets/demo.mp4. The inline GIF is converted from it with:
       ffmpeg -i assets/demo.mp4 -vf "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 assets/demo.gif
     (GitHub only inline-plays mp4s uploaded via its web editor, not committed files —
     a committed GIF is the reliable way to get a moving demo on the README.) -->

Two AI coding agents on one checkout ends badly. This project exists because Codex silently ran a `git reset` on `main` mid-merge while Claude Code was mid-task on the same files — the merge state vanished and neither agent noticed. The failure mode isn't exotic: two agents, one working tree, no isolation. Switchyard (published as `git-fleet`; the installed command is `fleet`) gives each agent its own git worktree and branch, tracks them centrally, and flags collisions between agents before anyone merges.

## What it looks like

*(The same flow as the [demo video](assets/demo.mp4), in skimmable, copy-pasteable form.)*

```console
$ fleet spawn claude
Spawned agent claude
  branch:   fleet/claude (from main)
  worktree: ~/project/.fleet/worktrees/claude

Point your agent at it:
  cd ~/project/.fleet/worktrees/claude

$ fleet list
┌────────┬──────────────┬──────┬───────┬───────────────┬───────────────┬──────────────────────────┐
│ AGENT  │ BRANCH       │ BASE │ +/-   │ CHANGES       │ LAST ACTIVITY │ WORKTREE                 │
├────────┼──────────────┼──────┼───────┼───────────────┼───────────────┼──────────────────────────┤
│ claude │ fleet/claude │ main │ +3/-0 │ clean         │ 12m ago       │ .fleet/worktrees/claude  │
│ codex  │ fleet/codex  │ main │ +1/-2 │ 4 uncommitted │ just now      │ .fleet/worktrees/codex   │
└────────┴──────────────┴──────┴───────┴───────────────┴───────────────┴──────────────────────────┘

$ fleet check
1 collision risk detected:
┌───────────────────┬───────────────┐
│ FILE              │ AGENTS        │
├───────────────────┼───────────────┤
│ src/api/routes.ts │ claude, codex │
└───────────────────┴───────────────┘
These files are touched by more than one agent (committed or uncommitted). Coordinate before merging.
```

## Installation

```sh
npm install -g git-fleet
```

Requires Node.js >= 18.17 and git >= 2.31. The installed command is `fleet`.

## Quickstart

```sh
cd your-repo
fleet spawn claude              # isolated worktree on branch fleet/claude
cd .fleet/worktrees/claude      # point your agent here and let it work
fleet check                     # any files also touched by other agents?
fleet sync claude               # base moved on? catch the branch up
fleet exec claude -- npm test   # run commands in the worktree without cd'ing
fleet diff claude               # review the branch before merging
fleet merge claude              # merge into your current branch + clean up the agent
fleet pr claude                 # …or push it and open a PR via gh instead
```

## Commands

| Command | Description | Key flags |
| --- | --- | --- |
| `fleet spawn <agent>` | Create a worktree in `.fleet/worktrees/<agent>/` on a new branch `fleet/<agent>`, then provision it (`copyOnSpawn` / `postSpawn` below) | `--from <branch>` base branch (default: current branch) |
| `fleet list` | All active agents: branch, base, ahead/behind, uncommitted count, last activity | `--json` machine-readable output |
| `fleet status <agent>` | One agent in detail: uncommitted files, diff stat vs base, ahead/behind | `--json` machine-readable output |
| `fleet check` | Table of files touched by more than one agent — collision risks before merging. Exits 1 if any are found (CI-friendly) | `--lines` only count overlapping line ranges, `--json` machine-readable output |
| `fleet diff <agent>` | Full diff of the agent's branch against its base | `--base <branch>` diff against a different branch |
| `fleet sync <agent>` | Merge the agent's base branch into its branch, catching it up. A conflicting merge is aborted — never left half-done | — |
| `fleet exec <agent> -- <cmd>` | Run a shell command inside the agent's worktree (e.g. `fleet exec claude -- npm test`) | `--all` run in every worktree sequentially; exits 1 if any run fails |
| `fleet merge <agent>` | Check for collisions, run the `preMerge` hook, merge the agent's branch into the current branch, then remove the worktree and branch. A conflicting merge is aborted — never left half-done | `--no-clean` keep the worktree and branch, `--delete-branch` explicit form of the default cleanup |
| `fleet pr <agent>` | Push the agent's branch to `origin` and open a pull request with the [GitHub CLI](https://cli.github.com) — the review-based alternative to a local merge | `--title <t>`, `--base <branch>`, `--draft` |
| `fleet remove <agent>` | Remove the worktree; refuses if there are uncommitted changes | `--force` discard changes, `--delete-branch` also delete the branch |
| `fleet clean` | Remove agents whose branches are fully merged into their base | `--dry-run` list only, `--stale <days>` also remove long-idle agents (clean worktrees only; their branches are kept) |
| `fleet watch` | `fleet list`, re-rendered live until Ctrl+C | `--interval <seconds>` refresh rate (default 3) |
| `fleet doctor` | Diagnose git version, state file validity, orphaned worktrees, and stale entries. Exits 1 if problems remain | `--fix` repair: rebuild state from `git worktree list`, adopt/remove orphans, prune stale entries; `--json` machine-readable output |
| `fleet completion <shell>` | Print a completion script for `bash`, `zsh`, or `fish` (agent names are a snapshot from generation time) | — |

All commands work from the main checkout **or** from inside any agent worktree.

### Scripting and CI

`list`, `status`, `check`, and `doctor` all take `--json` for machine-readable output, so agents and CI can consume Switchyard state directly — e.g. a merge gate:

```sh
fleet check --json || exit 1                  # exit code alone is enough for CI
fleet list --json | jq -r '.[].name'          # enumerate active agents
```

`fleet check --lines` refines collision detection from files to line ranges: two agents editing disjoint parts of one file are reported separately instead of blocking. Ranges are computed against each pair's merge base — exact when both agents share a base, a documented heuristic otherwise (see [docs/architecture.md](docs/architecture.md)).

## Configuration

An optional `.fleetrc.json` at the repo root sets per-repo defaults. Precedence everywhere: CLI flag > `.fleetrc.json` > built-in default.

```json
{
  "defaultBase": "main",
  "watchInterval": 3,
  "autoClean": false,
  "copyOnSpawn": [".env"],
  "postSpawn": "npm ci",
  "preMerge": "npm test"
}
```

- `defaultBase` — base branch for `fleet spawn` when `--from` is not passed (built-in default: the current branch).
- `watchInterval` — refresh interval for `fleet watch`, in seconds (built-in default: 3).
- `autoClean` — when `true`, every successful `fleet merge` also runs a `fleet clean` sweep for other fully merged agents (built-in default: `false`).
- `copyOnSpawn` — repo-root-relative files/directories copied into every new worktree by `fleet spawn`. Worktrees don't carry gitignored files, so a fresh one has no `.env` or local config — this fixes that. Missing entries are skipped with a note.
- `postSpawn` — shell command run inside the new worktree after `fleet spawn` (e.g. `npm ci`), so the worktree is ready to work in. A failing hook is reported but the worktree is kept.
- `preMerge` — shell command run inside the agent's worktree before `fleet merge` starts (e.g. `npm test`). A non-zero exit aborts the merge before anything is touched.

A malformed config file is a hard error with the offending key named; a missing one is fine.

## How it works

`fleet spawn` runs `git worktree add` under the hood: each agent gets a real, separate directory with its own checkout of a dedicated `fleet/<agent>` branch, so one agent's `git reset` physically cannot touch another agent's files. A single gitignored `.fleet/state.json` in the main repo maps each agent to its branch, base, and worktree, and `fleet check` uses it to diff every agent branch against its base (`git diff base...branch`, plus uncommitted edits) and cross-reference the changed files. Switchyard also adds `.fleet/` to `.git/info/exclude` automatically, so it never dirties the repos it manages. Design rationale and limitations live in [docs/architecture.md](docs/architecture.md).

## Contributing

PRs are welcome. Clone, `npm install`, `npm test` — every command is tested against real throwaway git repositories, and any change to a command must come with such a test (no git mocks; see [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) for the ground rules). Commits follow [Conventional Commits](https://www.conventionalcommits.org/). Read [docs/architecture.md](docs/architecture.md) before structural changes, and [docs/deployment.md](docs/deployment.md) for the release process.

## License

MIT © Mohammed Alkindi — see [LICENSE](LICENSE).
