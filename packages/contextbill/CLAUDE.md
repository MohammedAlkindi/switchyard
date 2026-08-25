# loadline

Local-first CLI that turns coding-agent transcripts into a dollar-denominated usage
report. Zero runtime dependencies, zero network calls.

## Stack

TypeScript, strict mode, ESM, Node ≥ 18. Node built-ins only at runtime; vitest and
eslint are dev-only.

## Commands

- Install: `npm install`
- Test: `npm test`
- Lint: `npm run lint`
- Build: `npm run build`
- Run: `node dist/cli.js`

## Rules

- **No network calls, ever.** This is the product's core claim, not a nice-to-have. A
  dependency that opens a socket, a webfont, a CDN link or an analytics ping breaks it.
  The rendered report is asserted against `/https?:\/\//` in the test suite — keep that
  test passing.
- **No runtime dependencies.** `npx loadline` must stay instant and reviewable. Anything
  added to `dependencies` needs a stated reason; dev dependencies are unrestricted.
- Strict mode, zero `any`. Interfaces live in `types.ts` before their consumers.
- `cli.ts` is the only module permitted to touch the filesystem or `process`. Everything
  else is pure and testable without fixtures on disk.
- CSS in `report.ts` uses variables under `:root` — no hardcoded colors elsewhere.
- Never commit with tests failing. Never claim a check passed that did not run.

## Things that will bite you

- **`prices.json` is load-bearing.** Every dollar figure derives from it. Do not edit
  rates from memory — verify against a current published source and update `dated`. A
  wrong rate makes the whole product confidently wrong, and nothing will fail.
- **Cache-write TTL is unknowable from a transcript.** `cache_creation_input_tokens` is
  a single number with no TTL field. The 5m default is deliberate: it understates rather
  than overstates. Never "improve" this by inferring a TTL.
- **The startup-prefix figure is a model, not a billed line item.** It is capped at
  non-output spend in `aggregate.ts`, because the model can otherwise exceed what the
  session actually paid and the category shares then sum above 100%. There is a test.
- **`classify.ts` order matters.** Browser MCP tools are tested before the generic
  `mcp__` prefix. Reorder them and the largest line item on some machines silently
  disappears into "connectors".
- **The startup prefix is read from the first turn only.** On later turns the same
  tokens reappear as cache reads; counting those would multiply the figure.
- **Project slugs are machine-identifying.** A directory slug like
  `C--Users-jdoe-work-acme` decodes to the user's OS account name and directory tree.
  The report is built to be shared, so `privacy.ts` strips that by default and
  `--show-paths` opts back in. Do not render a raw `project` value anywhere without
  going through `redactProject`.
- **Never use real transcripts as test fixtures.** They contain private conversation
  data and the repo is public. `fixtures/` is hand-built and pinned to LF via
  `.gitattributes`.
- **Differential-check against a FROZEN corpus.** Live transcript directories are
  appended to by running agent sessions, so a comparison run against them produces
  spurious off-by-one deltas that look like port bugs.

## Verification bar

`scan.ts` and `classify.ts` are ports of a reference measurement script. They are
correct when, against a frozen corpus, `turns` and the median startup prefix match that
reference exactly. That check is worth more than any unit test here — keep it runnable.
