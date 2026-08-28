# contextbill

Two packages in one npm workspace:

| Path | What it is | Ships as |
| ---- | ---------- | -------- |
| `/` (root) | The analysis core and CLI. Reads transcripts, prices them, writes an HTML report. | npm package `contextbill` |
| `web/` | Next.js app with Supabase accounts and saved reports. | https://contextbill.vercel.app |

`web/` imports the compiled core from `../dist` and the price table from
`../prices.json`. It has its own `CLAUDE.md`; read it before touching anything in there.

## The privacy model is split, and the split matters

The old version of this file said "no network calls, ever." That is still true of the
CLI and it is **not** true of the web app, which talks to Supabase. Keep the two claims
separate or the product starts lying in its own copy:

- **CLI:** no sockets at all. The shipped build imports `fs`, `os`, `path`, `url` and
  nothing else. A test asserts the generated report contains no external reference.
- **Web:** transcripts are parsed **in the browser**. Only aggregates reach the server:
  totals, per-model spend, session counts. Never send prompts, completions, file
  contents, or a raw transcript line anywhere.

Adding an upload of raw transcript content would break the claim printed on the landing
page. If that ever becomes desirable, change the page copy in the same commit.

## Commands

```bash
npm install                    # installs both workspaces
npm run build                  # root: tsc -> dist/  (web/ prebuild depends on this)
npm test                       # root: vitest
npm run lint                   # root only; web lints itself
npm run build --workspace=web  # Next build
npm run lint  --workspace=web
node dist/cli.js               # run the CLI
```

## Rules

- **The published CLI keeps zero runtime dependencies.** `npx contextbill` staying
  instant and reviewable is a product property. `web/` may add dependencies freely; the
  root may not, and `files` in package.json keeps `web/` out of the npm tarball.
- Strict mode, zero `any`. Interfaces live in `types.ts` before their consumers.
- `cli.ts` is the only core module permitted to touch the filesystem or `process`.
  Everything else is pure and testable without fixtures on disk.
- Never commit with tests failing. Never claim a check passed that did not run.

## The name

`loadline` was the original name and it is **taken**: a live Hevy workout-analytics
product on `loadline.app` and `loadline.vercel.app`, in alpha with its own hosted login.
Same word, adjacent category. Renamed 2026-08-26, before the first npm publish. Do not
reintroduce the old name anywhere, including in examples.

`contextbill` was unregistered on npm and `contextbill.dev` was unregistered when
checked on 2026-08-26. Neither has been claimed yet.

## Things that will bite you

- **`prices.json` is load-bearing.** Every dollar figure derives from it. Do not edit
  rates from memory. Verify against a current published source and update `dated` in the
  same commit. A wrong rate makes the product confidently wrong and nothing fails.
- **Cache-write TTL is unknowable from a transcript.** `cache_creation_input_tokens` is
  one number with no TTL field. The 5m default understates rather than overstates. Never
  "improve" this by inferring a TTL.
- **The startup-prefix figure is a model, not a billed line item.** `aggregate.ts` caps
  it at non-output spend, because the model can otherwise exceed what the session paid
  and category shares then sum above 100%. There is a test.
- **`classify.ts` order matters.** Browser MCP tools are matched before the generic
  `mcp__` prefix. Reorder them and the largest line item on some machines vanishes into
  "connectors".
- **The startup prefix is read from the first turn only.** On later turns those same
  tokens return as cache reads; counting them multiplies the figure.
- **Project slugs identify the machine.** `C--Users-jdoe-work-acme` decodes to an OS
  account name and directory tree. Reports are built to be shared, so `privacy.ts`
  strips it by default and `--show-paths` opts back in. Never render a raw `project`
  value without going through `redactProject`.
- **`parse.ts` must stay separate from `scan.ts`.** `scan.ts` imports `node:fs` and
  cannot be bundled for a browser. `parse.ts` imports no Node module at all, and both
  the CLI (`scan.ts`) and the web app (`web/lib/browser-scan.ts`) call into it. That is
  what makes one transcript produce one set of numbers on both surfaces.
  *Reversing it:* merging them either breaks the web build on `node:fs`, or pushes
  someone to write a second parser for the browser. Two parsers drift, and then the CLI
  and the dashboard quietly disagree about the same file, with no test that can catch it
  because each is self-consistent.
- **Never use real transcripts as fixtures.** They hold private conversation data and
  this repo is public. `fixtures/` is hand-built and pinned to LF in `.gitattributes`.
- **Differential-check against a FROZEN corpus.** Live transcript directories are
  appended to by running sessions, so comparing against them produces off-by-one deltas
  that look exactly like a port bug and are not one.

## Workspace install: the versions that must match

Root and `web/` must declare the same `@types/node` and `typescript`. When they drifted,
npm could not hoist, `next` stayed in `web/node_modules` while `eslint-config-next`
hoisted to the root, and linting the web app died with a module-not-found on
`next/dist/compiled/babel/eslint-parser`.

`eslint` deliberately does **not** match. `eslint-config-next` 16 pins to ESLint 9, and
`eslint-plugin-react` calls an API that ESLint 10 removed. Root runs ESLint 10, `web/`
runs 9, and each lints itself. Root config ignores `web/**` and `.vercel/**`.

## Verification bar

`scan.ts` and `classify.ts` are ports of a reference measurement script
(`~/.claude/scripts/usage-audit.js`). They are correct when, against a frozen corpus,
`turns` and the median startup prefix match that reference **exactly**. That check is
worth more than any unit test here. Keep it runnable.

### `$0.018006` is a regression anchor, not a sample value

`src/__tests__/pipeline.test.ts` asserts the fixture corpus prices to `0.018006` at nine
decimal places, and the comment above it works the figure out line by line from
`prices.json`.

It is there to fail. Pricing bugs do not throw: change a rate, mis-handle a dated model
id, drop fast-mode billing, or alter how the startup prefix is apportioned, and every
test still passes while every number the product reports is wrong. This assertion is the
only thing that notices.

*Reversing it:* if it ever goes red, the answer is to find what changed in the pricing
path, not to update the number until it matches. Re-baselining the anchor deletes the
one check that distinguishes a deliberate pricing change from a silent regression. When
a rate genuinely changes, re-derive the expected total by hand, rewrite the arithmetic
in the comment, and say so in the commit message.

## Where this knowledge lives

Everything above sits in `CLAUDE.md` / `AGENTS.md` rather than a separate
`ARCHITECTURE.md`, deliberately.

These files load automatically for both Claude and Codex when work starts in this repo.
An `ARCHITECTURE.md` does not. Most of what is written here is not description, it is a
constraint someone is about to violate: the `parse.ts` split, the missing content column,
the pricing anchor. A constraint that is only discoverable by choosing to open a file is
a constraint that gets broken by whoever did not open it, and every entry here exists
because something already went wrong once.

The cost is real and accepted: these files are read on every session in this repo, so
they stay ordered by what bites hardest and get pruned when an entry stops being true.
If the design rationale ever grows past what is worth loading every time, split the
narrative into `docs/` and leave the constraints here.

## Releasing

`v0.1.0` reached npm with no tag, no GitHub Release and no test run behind it. Both tags
were reconstructed afterwards from the publish timestamp. Do not repeat that: the
procedure below exists so a published version always has a commit, a changelog entry and
a green run behind it.

1. Gate: build, lint, the full suite, and `npm audit`.
2. Bump with `npm version <x.y.z> --no-git-tag-version` (never hand-edit the version), and
   add the `CHANGELOG.md` section in the same commit.
3. Commit `chore(release): vX.Y.Z`, push, then tag **on main** with an annotated tag whose
   message is Conventional-Commits shaped. `commit-guard.js` validates annotated-tag
   message text as if it were a commit subject and will otherwise block it. That is a
   false positive on a tag; fix the subject rather than bypassing the hook.
4. Create the GitHub Release bound to that exact tag, with the changelog section as its
   notes. Verify the tag rather than letting the tool mint one off the wrong commit.
5. Publishing then happens in `.github/workflows/release.yml`, triggered by that release.

**Never publish to the registry by hand.** Two reasons, both load-bearing. The workflow
adds provenance, which a local publish cannot. And `prepublishOnly` runs the test suite,
which **cannot start on the maintainer's own machine** — Smart App Control blocks the
unsigned native binding vitest loads, so a local publish either fails at the gate or gets
forced past it with `--ignore-scripts`, which also skips the build that produces `dist/`.

Publishing needs `NPM_TOKEN` in repository secrets. npm trusted publishing via OIDC would
remove the secret entirely and is the better end state.

**The engines field is a checked claim, not a hope.** CI builds on current node and then
runs the built CLI on node 18, asserting the fixture corpus still prices to `$0.017854`.
Running the *suite* on 18 tests the wrong thing: vitest imports `styleText` from
`node:util`, which arrived in node 20, so it fails there while the CLI — which imports
only `fs`, `os`, `path` and `url` — is fine.
