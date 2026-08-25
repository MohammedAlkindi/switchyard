# loadline

**What your coding agents actually cost.** One command, no signup, nothing leaves your machine.

The *load line* is the mark on a ship's hull showing how heavily it may safely be
loaded. This tells you how heavily loaded your context is, and what you are paying
to carry it.

```bash
npx loadline
```

## What it does

`loadline` reads Claude Code transcripts from disk and writes a single self-contained
HTML report showing what they cost in dollars, where the money went, and which sessions
are worth a second look. It opens no sockets — not to Anthropic, not to a telemetry
endpoint, not to a CDN for a webfont.

It answers four questions a per-seat billing dashboard cannot:

1. **Where does the money actually go?** Cost split across shell, file reads, browser
   automation, connectors, model output, and fixed overhead.
2. **What do you pay before you type?** Every session loads a system prompt, tool
   catalog, connector definitions and instruction files first. That block is written to
   cache once and re-read on *every subsequent turn*, so a 500-turn session pays for it
   500 times. It is usually a double-digit percentage of the bill and it shrinks by
   deleting things, not by working differently.
3. **Which long sessions produced nothing?** Sessions that ran hundreds of turns without
   writing a file. Offered as a prompt to go look, never as a verdict — read-only
   research is legitimate work.
4. **Which scheduled runs died on startup?** A run that exits before doing anything is
   indistinguishable from one that never fired; the task reports success either way.
   Transcript size is the only signal that separates them after the fact.

```
  $X,XXX across 82,119 turns in 376 sessions
  $X,XXX projected per 30 days
  81,586 median tokens loaded before you type — $XXX paid for that alone

  2 long session(s) wrote no file — see the report
  report -> ./loadline-report.html
```

## Architecture

Zero runtime dependencies — Node built-ins only. `npx` is instant and there is no
supply-chain surface for a security team to review.

Every module is pure except `cli.ts`, so the logic is testable without touching a disk.

| File | Purpose |
| ---- | ------- |
| `src/types.ts` | Every shared interface, defined before its consumers |
| `src/scan.ts` | Walks `*.jsonl` transcripts, extracts per-session token and tool stats |
| `src/classify.ts` | Tool name → spend category |
| `src/cost.ts` | Token counts + price table → dollars |
| `src/aggregate.ts` | Session stats → a whole-corpus report |
| `src/waste.ts` | The waste and fleet-health heuristics |
| `src/report.ts` | Report → self-contained HTML |
| `src/cli.ts` | Arg parsing and file I/O. The only impure module |
| `prices.json` | Dated, per-model price table |

### Two things a naive version gets wrong

**Dated model ids.** Transcripts record the model id that was actually sent, and that
includes dated snapshots like `claude-haiku-4-5-20251001`. A direct table lookup misses
those and silently prices a real model at zero. `normalizeModelId` strips the suffix.

**Fast mode.** `usage.speed === "fast"` bills at roughly double the standard rate.
Ignoring it understates every fast session.

### Assumptions, stated rather than hidden

Cache writes bill at a multiple of the base input rate — 1.25× at the 5-minute TTL, 2×
at 1 hour. **Transcripts do not record which TTL was used**, so `loadline` cannot infer
it and does not guess. It defaults to the 5-minute rate because that understates rather
than overstates, and the report names the assumption. Re-run with `--cache-ttl=1h` to
see the other figure.

Prices come from `prices.json`, which carries the date it was compiled and is cited in
every report footer. Anthropic first-party API rates only; Amazon Bedrock and Google
Vertex AI are partner-operated, priced separately, and not modelled. Models with no rate
in the table are counted and reported separately rather than folded in as free.

## Setup

```bash
git clone https://github.com/MohammedAlkindi/loadline.git
cd loadline
npm install
npm run build
node dist/cli.js --help
```

### Options

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--root <dir>` | `~/.claude/projects` | Transcript root |
| `--out <file>` | `./loadline-report.html` | Report path |
| `--cache-ttl <5m\|1h>` | `5m` | Cache-write billing rate |
| `--top <n>` | `20` | Rows in the most-expensive-sessions table |
| `--json` | — | Print JSON to stdout, write no file |

## Environment variables

**None.** `loadline` needs no API key, no account and no configuration, because it never
calls an API. It reads local files and writes one local file. If a future version ever
needs a credential, that will be a breaking change announced in the changelog.

## Tests

```bash
npm test
```

Unit tests run against hand-built fixture transcripts committed under `fixtures/` —
never against real ones, which contain private data. The suite pins an exact
end-to-end dollar total that is worked by hand in a comment, so a pricing regression
fails loudly instead of drifting.

### Differential check against a reference engine

`scan.ts` and `classify.ts` are ports, so they can be checked against the implementation
they came from rather than only against themselves. Point both at the same frozen corpus
and compare — `turns` and the median startup prefix must agree exactly:

```bash
node dist/cli.js --root <frozen>/.claude/projects --json
```

Freeze the corpus first. Running both against a live transcript directory produces
off-by-one differences whenever another agent session appends a turn between the two
invocations — which looks exactly like a port bug and is not one.

## License

MIT © 2026 Mohammed Alkindi
