# Agents — contextbill

An npm workspace: the root is the published CLI, `web/` is the Next.js app at
https://contextbill.vercel.app. Read `CLAUDE.md` at the root and in `web/` before
editing either.

## Scope

Agents may edit source, tests, docs and the web app in this repo.

## Branch policy

- Solo iterative work commits to `main`.
- Reviewable or multi-commit work goes on a `<type>/<kebab-slug>` branch.
- No agent or tool name in any branch that can become a public PR. GitHub renders the
  head branch in the PR header.

## Requires confirmation

- Publishing to npm.
- Editing rates in `prices.json`. Verify against a current published source and update
  `dated` in the same commit.
- Adding anything to the **root** `dependencies`. That package ships with none on
  purpose. `web/` dependencies are unrestricted.
- Renaming the project. The previous name collided with a live product; see `CLAUDE.md`.
- Deleting files or rewriting pushed history.

## Never

- **Add a network call to the CLI.** Zero egress is what the CLI is sold on and a test
  asserts it. This does not apply to `web/`, which uses Supabase by design.
- **Send raw transcript content, prompts or completions to a server** from `web/`.
  Parsing happens in the browser and only aggregates are stored. The landing page says
  so.
- Add the Supabase service-role key to `web/`. Only the publishable key belongs there.
- Commit a generated `contextbill-report.html`. It describes a real machine.
- Use real transcripts as fixtures. They contain private data and this repo is public.
- Set static spacing with inline styles in `web/`. Classes live in `app/globals.css`.
- Commit failing tests, or claim a check passed that did not run.
- Add AI authorship to commit metadata: author, co-author, trailer or otherwise.
