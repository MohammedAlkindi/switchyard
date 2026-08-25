# Agents — loadline

## Scope

Agents may edit source, tests, docs and the landing page in this repo.

## Branch policy

- Solo iterative work commits to `main`.
- Reviewable or multi-commit work goes on a `<type>/<kebab-slug>` branch.
- No agent or tool name in any branch that can become a public PR — GitHub renders the
  head branch in the PR header.

## Requires confirmation

- Publishing to npm.
- Editing rates in `prices.json` (verify against a current published source first, and
  update `dated` in the same commit).
- Adding anything to `dependencies` — this project ships with none on purpose.
- Deleting files or rewriting pushed history.

## Never

- Add a network call, remote asset, webfont or analytics ping. Zero egress is the
  product; there is a test asserting it and that test is not negotiable.
- Commit a generated `loadline-report.html`. It describes a real machine.
- Use real transcripts as fixtures. They contain private data and this repo is public.
- Commit failing tests, or claim a check passed that did not run.
- Add AI authorship to commit metadata — author, co-author, trailer or otherwise.
