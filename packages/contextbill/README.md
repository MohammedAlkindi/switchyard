# loadline

Know what your AI agents actually cost. Analyze Claude Code usage locally and see
where your tokens and dollars are going.

```console
$ npx loadline

  $22,297 across 82,767 turns in 376 sessions
  $22,759 projected per 30 days
  81,586 median tokens loaded before you type — $4,062 paid for that alone

  2 long session(s) wrote no file — see the report

  report -> ./loadline-report.html
```

Those are real figures from one developer machine, not a projection. The third line
is the one that tends to surprise people: **18.2% of that bill was context nobody
typed** — the system prompt, tool catalog, connector definitions and instruction
files that load before every session and get re-read on every subsequent turn.

No signup. No account. No API key. No network calls.

---

## Why it exists

Per-seat billing gives you one blended number. It cannot tell you which sessions
were expensive, which produced nothing, which scheduled runs died before doing any
work, or how much of the bill is fixed overhead you could delete rather than
optimize.

That information is already on your disk, in the transcripts. loadline reads it.

## Run it

```bash
npx loadline
```

Or from source:

```bash
git clone https://github.com/MohammedAlkindi/loadline.git
cd loadline && npm install && npm run build
node dist/cli.js
```

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--root <dir>` | `~/.claude/projects` | Transcript root |
| `--out <file>` | `./loadline-report.html` | Report path |
| `--cache-ttl <5m\|1h>` | `5m` | Cache-write billing rate |
| `--top <n>` | `20` | Rows in the most-expensive-sessions table |
| `--show-paths` | off | Show full project directory slugs |
| `--json` | — | Print JSON to stdout, write no file |

## What the report contains

One self-contained HTML file with no external references:

- **Cost by category** — shell, file reads, browser automation, connectors, model
  output, and fixed startup overhead, in dollars.
- **The startup prefix** — your median pre-input token load and what you paid to
  re-read it across every turn of every session.
- **Sessions that wrote no file** — long runs that never produced an artifact.
  Offered as a prompt to go look, not as a verdict; read-only research is real work,
  and a `Bash` command that writes a file does not count toward the flag.
- **Runs that died on startup** — a scheduled agent that exits before working is
  indistinguishable from one that never fired. Transcript size separates them.
- **Per-model spend** — including fast-mode turns at their own rate.
- **Token classes** — input, cache writes, cache reads, output.

## What data it accesses

Only `*.jsonl` transcript files under `--root` (default `~/.claude/projects`),
opened read-only. Nothing is written back into that directory.

From each transcript it reads token counts, model ids, timestamps, tool names, and
the byte size of tool results. **It does not read conversation content into the
report.**

## Does anything leave your machine?

No. The shipped build imports four Node built-ins — `fs`, `os`, `path`, `url` — and
nothing else. There is no HTTP client, no socket, no telemetry, and there are zero
runtime dependencies. A test asserts the generated report contains no external
reference; the report renders offline with system fonts.

Two related protections:

- **Project paths are redacted by default.** Transcript folders are named after the
  literal working directory (`C:\Users\jdoe\work\acme` becomes
  `C--Users-jdoe-work-acme`), which encodes your OS account name and directory tree.
  Since the report is built to be shared, that is stripped to `work-acme`.
  `--show-paths` is an explicit opt-in.
- **Generated reports are gitignored,** so one cannot be committed by accident.

## How billing is calculated

Every dollar figure derives from `prices.json`, which carries the date it was
compiled and is cited in every report footer. Anthropic first-party API rates only —
Amazon Bedrock and Google Vertex AI are partner-operated, priced separately, and not
modelled.

Three details that are easy to get wrong, and how loadline handles them:

- **Dated model ids.** Transcripts record the id actually sent, including snapshots
  like `claude-haiku-4-5-20251001`. A direct table lookup misses those and prices a
  real model at zero. The suffix is stripped before lookup.
- **Fast mode.** `usage.speed === "fast"` bills at roughly double. Ignoring it
  understates every fast session.
- **Cache-write TTL is not recorded in transcripts.** Writes bill at 1.25× at the
  5-minute TTL and 2× at one hour, and the transcript carries a single number with no
  TTL field. loadline cannot infer it and does not guess: it defaults to the cheaper
  rate — so it understates rather than overstates — names the assumption in the report
  footer, and offers `--cache-ttl=1h` to see the other figure.

Models with no entry in the price table are counted and reported separately rather
than folded into the total as free.

The startup-prefix figure is a **model**, not a billed line item: prefix tokens priced
across observed turns, capped at non-output spend. It is labelled as such in the
report.

## Architecture

Zero runtime dependencies, Node built-ins only. Every module is pure except
`cli.ts`, so the logic is testable without touching a disk.

| File | Purpose |
| ---- | ------- |
| `src/types.ts` | Shared interfaces, defined before consumers |
| `src/scan.ts` | Walks transcripts, extracts per-session token and tool stats |
| `src/classify.ts` | Tool name → spend category |
| `src/cost.ts` | Token counts + price table → dollars |
| `src/aggregate.ts` | Session stats → whole-corpus report |
| `src/waste.ts` | Waste and fleet-health heuristics |
| `src/privacy.ts` | Strips machine-identifying path data |
| `src/report.ts` | Report → self-contained HTML |
| `src/cli.ts` | Arg parsing and file I/O. The only impure module |

## Tests

```bash
npm test        # vitest
npm run lint    # eslint
npm run build   # tsc
```

Tests run against hand-built fixture transcripts in `fixtures/` — never real ones,
which contain private data. The suite pins an exact end-to-end dollar total that is
worked by hand in a comment, so a pricing regression fails loudly rather than drifting.

**Differential check.** `scan.ts` and `classify.ts` are ports of a reference
measurement script, so they can be validated against it rather than only against
themselves. Point both at the same **frozen** corpus and compare `turns` and the
median startup prefix — they must agree exactly. Freeze it first: running against a
live transcript directory produces off-by-one differences whenever another agent
session appends a turn mid-comparison, which looks exactly like a port bug and is not
one.

## Environment variables

None. loadline needs no API key, no account and no configuration, because it never
calls an API. If a future version ever requires a credential, that will be a breaking
change announced in the changelog.

## Contributing

Issues and pull requests welcome. Before opening one:

1. `npm test`, `npm run lint` and `npm run build` all pass.
2. New behaviour comes with a test. Do not weaken an existing test to make a suite green.
3. **Do not add a runtime dependency** without a stated reason — `npx loadline` staying
   instant and auditable is a product property, not an implementation detail.
4. **Do not add a network call.** Zero egress is the product; there is a test asserting
   it.
5. Price changes in `prices.json` must come with an updated `dated` field and a source.

## License

MIT © 2026 Mohammed Alkindi
