@AGENTS.md

# contextbill web

Next.js app with Supabase accounts and saved reports. Deployed at
https://contextbill.vercel.app. The repo root holds the analysis core and its own
`CLAUDE.md`; read that too.

## The picker has been run against a real profile, and it fails on a live one

This section used to say nobody had ever run the browser picker end to end. Someone
has, and the result splits in two: the numbers are right, and the read is fragile.

**The numbers agree with the CLI — but the end-to-end run behind that has NOT been
repeated since the deduplication change, and its figures are gone.** This section used
to cite a specific pair: 947 transcripts, 775 MB, `$23,367.23` in the tab against the
CLI's `$23,367.229110`. That pair predates the streamed-rewrite correction, which
divides every total by roughly 2.4, so it is now arithmetically impossible and has been
removed rather than rescaled — scaling a measurement is inventing one.

What is actually verified today, and by what:

- **The two readers agree**, enforced on every `npm test` by
  `lib/__tests__/browser-scan.test.ts` ("produces identical aggregates from the same
  corpus"), which runs `scanFiles` and `scanCorpus` over one corpus and asserts
  `cost`, `usage`, `byModel` and `byCategory` are equal. That is the invariant the
  two-surface design rests on and it is pinned in CI, not in this file.
- **Not verified: the live-profile picker run.** Heap ceiling, the shape of a
  many-hundred-transcript directory, and the `NotReadableError` degradation below were
  observed once by hand and cannot be reproduced from a test — the directory picker
  needs a browser and a real profile. Treat the paragraphs after this one as an
  observation to re-run, not as a current measurement.

Re-running it means: open the hosted app, pick a real `~/.claude/projects`, and compare
the tab's total against `node dist/cli.js --root <same dir>` to the cent. Write the pair
and the date here when you do; do not leave a figure here that no run produced.

**The read fails on a directory that is in use.** `File.text()` rejects with
`NotReadableError` part-way through: the picker captures a handle at selection time and
the browser revalidates it at read time, and Claude Code rewrites its `.jsonl` files
while sessions run. A frozen copy of the same corpus parses cleanly. Anyone measuring
their usage has just been using Claude Code, so **the failing case is the normal one**.

`scanFiles` now scopes its error handling to a single file, retries a failed read once,
and returns an `unreadable` list alongside the stats. `app/dashboard/new/page.tsx`
states the coverage when that list is non-empty and refuses to render a report when
every file failed.

*Reversing it:* the temptation is to widen the `try` back out to the whole loop, or to
drop the `unreadable` list because nothing reads it yet. Either one returns the product
to a total that looks complete and is not. A partial total that does not say it is
partial is the failure this codebase exists to avoid; the fix is never to tell people to
close Claude Code first.

Still unmeasured: Safari and Firefox support for `webkitdirectory`.

### Tests exist under `web/` now

`lib/__tests__/browser-scan.test.ts`, run by the root `npm test` through the aliases in
the root `vitest.config.ts`. It pins the degradation above, and one thing worth more
than the rest: **`browser-scan.ts` and `scan.ts` produce identical aggregates for the
same corpus.** That is the invariant the whole two-surface design rests on, and until
that test nothing enforced it. Each reader is self-consistent, so a drift between them
would surface as the CLI and the dashboard disagreeing about one directory with every
other test still green.

`vitest.config.ts` mirrors `web/tsconfig.json`'s `@core/*` and `@prices` aliases. If
they drift, the web tests resolve a different module than the app does and stop testing
the shipped code.

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

### One theme, product-wide, and no theme switching

There is a single palette on `:root` in `app/globals.css`. There is no
`prefers-color-scheme` block, no `[data-theme]` block, and no theme toggle.
`viewport.colorScheme` in `app/layout.tsx` declares light so form controls,
scrollbars and the pre-paint canvas agree with the stylesheet.

This replaced two earlier arrangements, both wrong. The app first followed the OS
everywhere. Then the landing page alone was pinned to light by redeclaring the tokens on a
`.landing` wrapper, which was written up here as deliberate scoping. It was not a scoped
design decision, it was a seam: a visitor on a dark OS read a white marketing page, signed
in, and landed on a near-black dashboard. The screenshot that showed it side by side is
what settled the question.

*Reversing it:* reintroducing a dark palette means committing to it on every route at once,
including the signed-in pages and the OG image. Half a theme is worse than either whole one.
Anything that scopes colour to a subtree recreates exactly the seam this removed.

### Shared chrome is a component, not a copy

`app/site-chrome.tsx` exports `SiteHeader` and `SiteFooter`, used by the landing page, the
privacy policy, the terms page and the 404. They were inlined in the landing page and
nowhere else, which is how a footer link existed on one route out of four.

Both are presentational, and `signedIn` is a prop rather than a Supabase call inside the
component, so the legal pages and the 404 stay static. Only the landing page passes a real
value, because it already reads the session for its call to action.

*Reversing it:* inlining a header back into a page means the next nav item added reaches
one route, and nobody notices until a screenshot puts two routes next to each other.

### The hero ledger bars are measured, not chosen

The two bar colours are a graphic that carries the meaning, so WCAG 1.4.11 applies at
3:1, not the 4.5:1 text rule and not taste. The first pairing tried here was amber on a
green that matched the brand and measured **1.79:1 against the plate**. Half the chart
was effectively invisible, and nothing failed. `#3D8DB8` replaced it after checking
against `dataviz/scripts/validate_palette.js`: lightness band, chroma floor, CVD
separation, normal-vision floor and surface contrast all pass, and the amber/steel pair
holds ΔE 19.9 under protanopia where amber/green collapses.

*Reversing it:* if either bar colour changes, re-run the validator against the plate
colour rather than eyeballing it on a bright monitor. A bar that fails this is not a
subtle regression, it is a chart with one series missing.

### Bar geometry lives in CSS, not in the JSX

`.ledger-row:nth-child(n) .seg.work` carries the six widths. They are fixed illustration
geometry, not data, and the rule above about inline styles applies: `style={{}}` here is
reserved for values that came out of a report. The array in `page.tsx` supplies only the
row labels.

### The privacy policy is a claim about the code, not boilerplate

`app/privacy/page.tsx` states that message content is never stored, that the only cookie is
the Supabase auth session, that project names are redacted before saving, and that no
analytics or third-party scripts run. Each of those is currently true and each is checkable:
the parser is `lib/browser-scan.ts` and runs in the tab, the only path that *writes* rows is
the `save_report` RPC, and `web/package.json` has five runtime dependencies, none of which is
a tracker. There is a second write path in the sense of a mutation — the client-side delete in
`app/dashboard/[id]/delete-report.tsx` — but it only ever removes rows, so nothing about what
can be stored changes.

Three changes would make the page false without breaking a test:

- Adding any column that can hold free-form text (see the schema section above).
- Adding an analytics script, a font loaded from a third-party origin, or any embed. Note
  that `next/font` self-hosts at build time, which is why the page can say a page load does
  not report the visitor to Google. A `<link>` to a font CDN would end that.
- Sending a raw transcript line anywhere, for debugging or otherwise.

*Reversing it:* if any of those happens, edit this page in the same commit. A privacy policy
that has drifted from the code is worse than not having one, because people rely on it.

### There is no cookie banner, and that is the considered answer

The app sets one cookie, the Supabase auth session. It is strictly necessary under the
ePrivacy Directive, so it does not require consent, and no analytics or advertising cookies
exist to consent to. A banner here would train people to click Accept on a page that asks
for nothing, which is the opposite of protection. The privacy page says this in as many
words.

*Reversing it:* the moment anything non-essential is added, analytics included, a real
consent banner is required first, and it has to gate the script rather than appear beside
it.

### Per-report deletion is self-serve; account deletion is by request

This section used to say the dashboard had no delete button and that the privacy page
described deletion as by request. Both stopped being true when `app/dashboard/[id]/delete-report.tsx`
shipped, and a false line in this file is worse than a missing one: it teaches the next
session that working code is an oversight and invites it to be undone.

What is actually there:

- **One report at a time, from the dashboard.** `DeleteReport` is rendered at the bottom of
  `app/dashboard/[id]/page.tsx`. It deletes straight from the client with no RPC and no
  migration: `reports` carries an owner-scoped DELETE policy and the three child tables
  reference it `ON DELETE CASCADE`, so removing the parent removes everything under it.
- **The count is checked, not assumed.** RLS *filters* rather than rejects, so deleting a row
  you do not own succeeds and removes nothing. The component passes `{ count: 'exact' }` and
  reports "could not be deleted" on zero. Dropping that check would make a foreign id look
  like a successful deletion, which is the kind of quiet lie this product exists to avoid.
- **Confirmation is a second click, not `window.confirm`.** The armed state names the report
  and says what goes with it.
- **The whole account is still by request**, through a GitHub issue. The privacy page's
  "Your rights" section describes both halves and is currently accurate.

*Reversing it:* the privacy page is a claim about the code (see above). If the delete button
is removed, or account deletion becomes self-serve, edit `app/privacy/page.tsx` and this
section in the same commit.

Contact is a GitHub issue link rather than an email address, deliberately: publishing a
personal address on a public site is the owner's call to make, not a default to inherit.
