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
  that vendor's entry in `datedByProvider` in the same commit. The table carries two
  vendors: Anthropic rates read 2026-09-03, OpenAI rates read 2026-09-07. Every OpenAI
  entry repeats its own source URL and reading date in its `note`, and `prices.test.ts`
  fails if one does not.
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
- **Add a schema column that can hold free-form content** (`jsonb`, `content`, `body`,
  `raw`). No such column exists, and that absence is what makes "we cannot store your
  conversations" true. Nothing fails if you add one.
- **Make `save_report` `SECURITY DEFINER`,** or drop an RLS policy. The function is
  `SECURITY INVOKER` so the caller's policies still apply inside it. The publishable key
  ships in the browser, so RLS is the only thing separating users.
- **Merge `parse.ts` into `scan.ts`.** `scan.ts` imports `node:fs` and cannot bundle for
  a browser; `parse.ts` is Node-free and shared by the CLI and the web app. Splitting the
  parser in two lets the two surfaces report different numbers for the same transcript.
  `codex-parse.ts` and `limits.ts` are Node-free under the same rule.
- **Price `gpt-5.5` or `claude-fable-5-1`** while `cacheWriteMultiplier` and
  `cacheReadMultiplier` are single globals. Each needs a per-model multiplier that
  `cost.ts` does not yet support, so pricing either asserts a rate the vendor does not
  charge, silently. Unpriced, their tokens are counted and named.
- **Rescale a `waste.ts` threshold.** They were re-cut against measured distributions on
  2026-09-07 precisely because dividing out the old turn inflation leaves a value still
  derived from the bug. `waste-thresholds.test.ts` pins the anchors; re-cut, never
  rescale.
- **Publish a timing figure you did not measure on a quiet machine.** The README's
  statusline benchmark table was removed on 2026-09-09 after failing to reproduce twice.
  The `node -e ""` floor alone re-measured 0.09 s against a published 0.17 s, and that row
  runs no contextbill code, so the table was describing a machine state rather than a
  program. If a timing table goes back, it needs the floor measured in the same run and
  the machine's load stated.
- **Re-baseline the `$0.017854` assertion in `pipeline.test.ts` to make it pass.** It is
  a regression anchor. If it goes red, find the pricing change that caused it. (It read
  `$0.018006` until 2026-08-28, when Sonnet 5 was corrected to its actual $2/$10; the
  test comment carries that history.)
- Commit a generated `contextbill-report.html`. It describes a real machine.
- Use real transcripts as fixtures. They contain private data and this repo is public.
- Set static spacing with inline styles in `web/`. Classes live in `app/globals.css`.
- Commit failing tests, or claim a check passed that did not run.
- Add AI authorship to commit metadata: author, co-author, trailer or otherwise.
