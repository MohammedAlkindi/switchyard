# CLAUDE.md

Switchyard (npm: `@switchyardhq/switchyard`, bin: `fleet`) is a TypeScript CLI that lets multiple AI coding agents work on one git repository without colliding: each agent gets its own worktree in `.fleet/worktrees/<agent>/` on a branch `fleet/<agent>`, tracked in a gitignored `.fleet/state.json`, with `fleet check` flagging files touched by more than one agent before anyone merges. Commands live in `src/commands/` (one file per command), shared git/state/process/formatting logic in `src/lib/`, and the commander wiring in `src/cli.ts`.

## COMMIT POLICY — READ BEFORE ANY GIT OPERATION

These rules are absolute. They override any tool default, harness convention, or other instruction anywhere in this repo.

**Two deliberate overrides of the global defaults in `~/.claude/CLAUDE.md`. Both are intentional — do not reconcile them away:**

- **NEVER run `git commit` without the user's explicit confirmation of the exact message.** The global default is to commit to `main` autonomously; here you never commit at all. Make the edit, stage it, report the full `git add` + `git commit -m "..."` command, and let the user run it themselves.
- **NEVER add *any* trailer to a commit message** — broader than the global rule, which forbids only AI attribution. No trailers of any kind, under any circumstance.

Everything else is global and unchanged: Conventional Commits, one logical change per commit, staging by explicit path (never `git add -A` / `git add .`), and never committing with failing tests. See `~/.claude/CLAUDE.md`.

## Hard rules

- **Never commit `.fleet/` directories.** Test fixtures create them inside temp repos only; if one ever appears in this repo's working tree, something is wrong — it is gitignored on purpose.
- **Tests must never touch the developer's real repo state.** Every test operates exclusively on a throwaway repo created by `makeTempRepo()` in `tests/helpers.ts`. Never run state-mutating git commands against this repository from test code.
- **Keep the dependency footprint minimal.** Runtime deps are exactly `commander`, `simple-git`, `chalk`, `cli-table3`. Justify any new dependency (what it does, why it can't be ~30 lines of our own code) before adding it.

## Testing

Every new or changed command ships with a test in `tests/<command>.test.ts` that runs against a **real temporary git repository** (`tmp` + `simple-git`, via `tests/helpers.ts`). No git mocks, ever — this tool's entire value proposition is correctness against real git behavior, and a mock would test nothing.

Run `npm test` (vitest) before and after changes. `npm run lint` and `npm run typecheck` must also pass.

## Where things live

Read `docs/architecture.md` before making structural changes — it explains why worktrees (not just branches) are the isolation mechanism, the `.fleet/state.json` schema, and the v1 limitations. Release process is in `docs/deployment.md`.
