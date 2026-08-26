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
