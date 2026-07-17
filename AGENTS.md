# AGENTS.md

Instructions for any AI coding agent working on this repository (Switchyard — npm `@switchyardhq/switchyard`, bin `fleet`).

## Commands

```sh
npm install          # install deps (also builds via the prepare hook)
npm run build        # compile src/ -> dist/ (tsc)
npm test             # vitest, real temp git repos — no mocks
npm run lint         # eslint
npm run typecheck    # tsc --noEmit over src/ and tests/
```

All four of build, test, lint, and typecheck must pass before any commit.

## Directory structure

- `src/cli.ts` — commander entry point; maps CLI commands/flags to command functions and formats errors.
- `src/commands/` — one file per CLI command (`spawn`, `list`, `status`, `check`, `diff`, `sync`, `exec`, `merge`, `pr`, `remove`, `clean`, `watch`, `doctor`, `completion`).
- `src/lib/` — shared internals: `state.ts` (`.fleet/state.json` I/O), `config.ts` (`.fleetrc.json` defaults), `git.ts` (simple-git wrappers), `proc.ts` (child-process helpers for hooks/exec/gh), `lines.ts` (diff parsing for `check --lines`), `format.ts` (tables/colors), `errors.ts` (`FleetError`).
- `tests/` — vitest suites, one per command; `helpers.ts` builds throwaway git repos that every test runs against.
- `docs/` — `architecture.md` (design rationale, state schema, limitations), `deployment.md` (release process).
- `.github/workflows/` — CI: lint, typecheck, build, test on push/PR to `main`.

## Scope and confirmation

- Work only inside this repository. Tests and experiments run against temp repos created by `tests/helpers.ts` — never against a real repository's state.
- Ask before: adding a runtime dependency, changing the `.fleet/state.json` schema (it's a compatibility surface), publishing, or force-pushing anything.
- Branch policy: don't commit directly to `main` for multi-commit or reviewable work; use `<type>/<short-description>` branches and Conventional Commit messages.

## Dog food

This repo eats its own dog food: if you're asked to make a nontrivial change and other agents may be active on this checkout, isolate your work first — run `fleet spawn <your-name>` (build it first with `npm run build`, or `npm link` once) and work inside the printed worktree. Yes, using Switchyard to build Switchyard.
