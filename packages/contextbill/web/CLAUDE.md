@AGENTS.md

# contextbill web

Next.js app with Supabase accounts and saved reports. Deployed at
https://contextbill.vercel.app. The repo root holds the analysis core and its own
`CLAUDE.md`; read that too.

## UNVERIFIED: nobody has run the thing this product rests on

**The browser directory picker has never been tested end to end against a real
`~/.claude/projects`.** Not in CI, not by hand, not once.

That path is the entire web product. `app/dashboard/new/page.tsx` puts
`webkitdirectory` on a file input, hands what comes back to `lib/browser-scan.ts`, and
that output becomes every number on the dashboard. There are **zero test files under
`web/`**. The core has 76 tests; this has none.

Everything downstream is verified and none of it covers this. The parser is tested
against fixtures, the pricing is anchored, RLS is proven with the anon key. All of it
assumes the browser handed us the right files in the first place, and that assumption is
the one nobody has checked.

Specifically unknown:
- Whether a directory picker on a real profile yields every `*.jsonl`, including nested
  subagent transcripts, or silently skips or truncates.
- Whether `File.text()` over hundreds of megabytes survives, or dies on memory in a tab.
- Whether the project slug arrives in the form `redactProject` expects, given the
  browser reports `webkitRelativePath` and not a filesystem path.
- Whether Safari and Firefox support the attribute well enough to matter.

Treat every dashboard figure as unconfirmed until someone runs this against a real
profile and diffs the totals against `npx contextbill` over the same directory. That diff
is the acceptance test and it has not been run. Delete this section when it has, and
record the result.

## How this connects to the core

`tsconfig.json` maps `@core/*` to `../dist/*` and `@prices` to `../prices.json`, so the
`prebuild` script runs the root build first. Both paths reach **outside** this directory,
which is why the Vercel configuration below is the way it is.

Pointing `@core/*` at `../src/*` to skip the build step does not work: the core is ESM
and imports siblings as `./types.js`, which Turbopack cannot resolve to `.ts`. Tried and
reverted.

## What may leave the browser

Transcripts are parsed client-side in `lib/browser-scan.ts`. Only aggregates are written
to Supabase. Never post a raw transcript line, a prompt, or a completion. The landing
page states this, so breaking it means changing the copy in the same commit.

Only the **publishable** Supabase key is used. The service-role key is not in this app
and must never be added; row-level security is what protects rows.

### The schema cannot hold message content, on purpose

Verified against the live database on 2026-08-26. Across all four tables every column is
a number, a boolean, a timestamp, a uuid, or a short identifier: `category`, `model`,
`session_id`, `project` (already redacted), `label` (the user's own report name),
`price_table_date`, `cache_ttl`, `unpriced_models[]`. There is **no `jsonb` column, no
`content`, no `body`, no `raw`** — nowhere a prompt or a completion could be put.

That absence is the privacy guarantee. It is not enforced by a check constraint or a
test; it is enforced by there being no column to write to. Which is exactly why it is
fragile: adding one looks like a harmless schema change and nothing anywhere fails.

The near miss to watch for: `save_report` takes `payload jsonb`. JSON **transits** the
RPC and is destructured into typed columns; it is never stored as a blob. Adding
`raw jsonb` to `reports` to "keep the original" would work on the first try, pass every
test, and quietly turn a product that cannot leak conversation content into one that
stores it.

*Reversing it:* if a column capable of holding free-form content is ever added, the
landing page and both `CLAUDE.md` files stop being true in the same commit. Change them
together or do not add the column.

### RLS, verified from outside

All four tables (`reports`, `report_categories`, `report_models`, `report_sessions`)
have RLS enabled with ownership policies. `reports` matches `user_id = auth.uid()` for
select, insert, update and delete. The three child tables match through an `EXISTS` join
back to their parent's `user_id`, for select, insert and delete; they carry no update
policy, so updates are denied by default.

No policy is permissive. There is no `using (true)` anywhere, which is the usual way an
RLS setup ends up enabled and useless.

Saving is atomic through `save_report(payload jsonb)`, which is **SECURITY INVOKER**.
That matters: the function runs as the calling user, so the same policies apply inside
it. A `SECURITY DEFINER` version would bypass RLS entirely and become the one hole in
the model, which is why it must stay INVOKER even if a future migration is easier the
other way.

Confirmed externally with the publishable key on 2026-08-26, not just read from the
catalog: unauthenticated `select` returns `[]` on all four tables, and an
unauthenticated `insert` into `reports` returns HTTP 401.

*Reversing it:* dropping a policy, or flipping the RPC to `SECURITY DEFINER`, exposes
every user's reports to every other user with the publishable key, which ships in the
browser by design. Re-run the anon-key probe after any migration touching policies or
that function.

## Vercel configuration, and why each part exists

Five deploys failed before this settled. Each setting fixes a specific one:

| Setting | Value | Without it |
| ------- | ----- | ---------- |
| Root Directory | `web` | Vercel detects the framework from the deployment root's `package.json`. At the repo root that is the CLI package: "No Next.js version detected". |
| Source files outside root | enabled | `..` is not uploaded, so `prebuild` exits 254 and `../prices.json` is missing. |
| Install command | `npm --prefix .. install` | Only the web workspace installs, the root `tsc` cannot find `@types/node`, prebuild exits 2. |
| Root `vercel.json` | must not exist | A `buildCommand` there stops Vercel using its own Next builder. The build then succeeds and the **output upload** fails. |

Two traps worth remembering:

- **`vercel build` does not run on Windows.** It needs symlinks and gets `EPERM`. Deploy
  with `vercel deploy --prod` or push to `main`; the GitHub integration is connected.
- **"Upgrade to next@v16.3.0-canary.32 or newer" is a red herring.** That message appears
  on the upload failure above. Tested against 16.4.0-canary.8 and it failed identically.
  The project runs 16.3.3 stable.

## Design system

`app/globals.css` owns every colour and every static spacing value.

- **No inline styles for static values.** They were removed once already; 31 of them are
  what made the app read as assembled rather than designed. Inline styles are for
  data-driven values only, which today means two bar widths and a progress fill.
- Colours come from `:root` tokens. Both themes are defined, including the un-stamped
  state where only `prefers-color-scheme` applies.
- Motion: use the `--ease-out` / `--t-*` tokens, never a bare `ease` or `transition: all`.
  Buttons press with `scale(.97)`. Hover rules live inside
  `@media (hover: hover) and (pointer: fine)` so a tap does not leave a stuck hover.
- **An entrance animation must never hide content by default.** The earlier version set
  `opacity: 0` and revealed on scroll with JavaScript, so any environment that blocked
  the script rendered a near-blank page. The `.enter` class is visible first and animates
  only under `@starting-style`.

## Traps

- **`InputHTMLAttributes<T>` must keep its type parameter.** It augments React's generic
  interface, and declaration merging only applies when the parameters match. ESLint
  reports `T` as unused, which is a false positive; there is a disable comment with the
  reason. Removing `<T>` breaks the type silently.
- **`AGENTS.md` here is generated by `next dev`.** Do not hand-edit it. Project knowledge
  goes in this file; the import at the top pulls the generated notes in.
- Prose rules for anything user-facing: no em dashes, active voice, no "not X, it's Y".
