# Contributing to contextbill

Issues and pull requests are welcome. This file expands on the rules in the
[README's contributing section](README.md#contributing); where the two overlap they say the
same thing, and the README is the short version.

## Getting set up

```bash
git clone https://github.com/MohammedAlkindi/contextbill.git
cd contextbill
npm install          # installs both workspaces (root and web/)
npm run build        # tsc -> dist/
node dist/cli.js     # run the CLI against your own transcripts
```

Node 18 or newer. The `engines` field is a checked claim, not a hope: CI builds on current
Node and then runs the built CLI on Node 18.

## Before opening a pull request

All three must pass, and you must have actually run them:

```bash
npm test        # vitest
npm run lint    # eslint
npm run build   # tsc
```

If something could not run in your environment, say which and why in the PR. An honest gap
costs less than a claim that turns out false.

## The five rules from the README

1. `npm test`, `npm run lint` and `npm run build` all pass.
2. New behaviour comes with a test. Do not weaken an existing test to make a suite green.
3. **Do not add a runtime dependency** to the root package without a stated reason.
   `npx contextbill` staying instant and auditable is a product property, not an
   implementation detail. `web/` may add dependencies freely; the published CLI has zero.
4. **Do not add a network call.** Zero egress is the product, and there is a test asserting
   the generated report contains no external reference.
5. Price changes in `prices.json` must come with an updated `dated` field and a source.

## Things that will fail review

These are the constraints that are load-bearing rather than stylistic. Each one exists
because breaking it produced a real, silent wrong answer.

**Never use a real transcript as a fixture.** Real transcripts contain private conversation
data and this repository is public. `fixtures/` is hand-built. If you need a new shape,
write one by hand.

**Do not re-baseline the pricing anchor.** `src/__tests__/pipeline.test.ts` asserts the
fixture corpus prices to `$0.017854` at nine decimal places, with the arithmetic worked out
line by line in the comment above it. Pricing bugs do not throw — change a rate, mishandle a
dated model id, drop fast-mode billing, or alter how the startup prefix is apportioned, and
every other test still passes while every number the product reports is wrong. That
assertion is the only thing that notices. If it goes red, find what changed in the pricing
path. When a rate genuinely changes, re-derive the expected total by hand, rewrite the
arithmetic in the comment, and say so in the commit message.

**Keep `parse.ts` free of Node built-ins.** `parse.ts` and `codex-parse.ts` import no Node
module at all. `scan.ts` owns `node:fs`, and `cli.ts` is the only module that touches the
filesystem or `process`. The web app parses transcripts in the browser through the *same*
`parseTranscript`, which is what makes one transcript produce one set of numbers on both
surfaces. Merging the two either breaks the browser build or pushes someone to write a
second parser, and two parsers drift into quietly disagreeing with no test able to catch it.
A test walks the import graph and fails if a `node:` import appears where it should not.

**Do not "improve" the cache-write TTL by inferring it.** `cache_creation_input_tokens` is a
single number with no TTL field. The 5-minute default understates rather than overstates,
which is the honest direction, and `--cache-ttl=1h` shows the other figure. See
[METHODOLOGY.md](METHODOLOGY.md#the-cache-write-ttl-assumption).

**Order matters in `classify.ts`.** Browser MCP tools are matched before the generic `mcp__`
prefix. Reorder them and the largest line item on some machines disappears into
"connectors".

**TypeScript is strict and `any` is not allowed.** Interfaces live in `src/types.ts`, defined
before their consumers.

## Changing how a number is computed

Any change to parsing, deduplication, pricing, the startup-prefix model, or category
attribution is a change to [METHODOLOGY.md](METHODOLOGY.md). Update it in the same pull
request. That document is meant to describe the code as it actually stands; if it and the
code disagree, the document is the bug.

If you are correcting an accuracy issue, the most useful PR body states the wrong number,
the right number, and how you measured the difference — a fail-before/pass-after pair beats
a paragraph.

## Updating prices

`prices.json` is load-bearing: every dollar figure derives from it, and a wrong rate makes
the product confidently wrong while nothing fails.

- Verify against Anthropic's published pricing page. Do not edit a rate from memory.
- Update `dated` in the same commit. A test fails once the table is more than 60 days old.
- A price change is a **new period** in that model's `periods` array, never an edit to an
  existing one. Editing one silently reprices history, which is the exact failure dated
  periods exist to prevent. The last period must restate the flat `input`/`output` beside
  it.
- First-party Anthropic API rates only. Bedrock and Vertex are partner-operated, priced
  separately, and deliberately not modelled.

## Commits and PRs

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(optional-scope): imperative description`, lowercase after the prefix, no trailing
period. Keep each commit a single logical change, and keep a fix and the test that proves it
in the same commit.

Small, single-purpose pull requests get reviewed faster than large ones.

## Reporting a bug

Use the [issue templates](https://github.com/MohammedAlkindi/contextbill/issues/new/choose).
For a wrong-number report, the version, the flags you passed, and the figure you expected
against the figure you got are what make it actionable. **Never paste a real transcript or a
report generated from one** — they contain private conversation data and machine-identifying
paths.

## License

By contributing you agree that your contributions are licensed under the MIT License, the
same as the rest of the project.
