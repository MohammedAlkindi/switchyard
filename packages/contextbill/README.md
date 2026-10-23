# contextbill

Know what your AI agents cost at API rates. Analyze Claude Code usage locally and
see where your tokens and dollars are going.

A hosted version runs at [contextbill.vercel.app](https://contextbill.vercel.app). It
parses transcripts in your browser and saves only aggregate figures and per-session
metadata (project name, start time) to your account, never message content. The source
is in [`web/`](web/).

```console
$ npx contextbill

  $14,482.81 at API rates across 72,891 turns in 571 sessions
  $11,250.61 projected per 30 days
  124,518 median tokens loaded before you type — $2,834.25 of that total

  9 long session(s) wrote no file — see the report
  15 run(s) look like they died on startup
  unpriced models excluded: <synthetic>, claude-fable-5-1
  96,785 streamed rewrite(s) collapsed — usage is counted once per message
  1,965 message(s) copied forward by a resumed session merged across 39 transcript(s) —
  $1,250.33 that would otherwise be counted twice
  3 message id(s) span 17 transcripts with no shared line id —
  nothing proves they are the same request, so they are NOT merged (about $1.25 counted twice)

  Figures are API-equivalent — what this usage would cost metered at the
  published Anthropic API rates. A subscription bills a flat fee instead.

  report -> ./contextbill-report.html
```

Those are real figures from one developer machine, not a projection: 2,424
transcripts and 1,527,997,880 bytes, measured 2026-09-09 against a frozen copy of
the corpus. The third line is the one that tends to surprise people: **19.6% of that
total was context nobody typed** — the system prompt, tool catalog, connector
definitions and instruction files that load before every session and get re-read on
every subsequent turn.

Two of those lines are corrections rather than findings, and they are printed because
a total that has been corrected should say so. The streamed-rewrite collapse counts
each assistant message once instead of once per line it was written on. The
resumed-session merge counts each request once across the whole corpus rather than
once per file it was copied into. What could not be proved a copy stays counted and
is named, which is why the last line quotes a residue rather than hiding it.

**What the dollars mean.** contextbill counts the tokens in your transcripts and
prices them at Anthropic's published first-party API rates. If you are on a
subscription you paid a flat monthly fee, so these figures are not your invoice:
they value the usage, which is what makes one session comparable to another and a
habit comparable to the habit you replaced it with. Nothing here needs an API key
to be true, and nothing here is a bill.

**Every figure is documented.** [**METHODOLOGY.md**](METHODOLOGY.md) is the full account of
how a directory of transcripts becomes a dollar total: the deduplication rule and the
measured inflation factors it corrects, how a turn is counted, how rates are looked up, what
the cache-TTL default assumes, how the startup-prefix model is built and why it is capped,
and a blunt list of [what contextbill cannot know](METHODOLOGY.md#what-this-cannot-know). It
is written so you can check the numbers rather than take them.

The CLI needs no signup, no account and no API key, and it makes no network calls.

---

## Why it exists

Per-seat billing gives you one blended number. It cannot tell you which sessions
were expensive, which produced nothing, which scheduled runs died before doing any
work, or how much of the bill is fixed overhead you could delete rather than
optimize.

That information is already on your disk, in the transcripts. contextbill reads it.

## Run it

```bash
npx contextbill
```

Or from source:

```bash
git clone https://github.com/MohammedAlkindi/contextbill.git
cd contextbill && npm install && npm run build
node dist/cli.js
```

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--root <dir>` | `~/.claude/projects` | Claude Code transcript root ([see below](#--root-and-your-working-directory)) |
| `--source <claude\|codex\|all>` | `claude` | Which agents to read ([see below](#reading-openai-codex-transcripts-too)) |
| `--codex-root <dir>` | `~/.codex/sessions` | Codex rollout root. Read only when `--source` includes codex |
| `--out <file>` | `./contextbill-report.html` | Report path |
| `--cache-ttl <5m\|1h>` | `5m` | Cache-write billing rate |
| `--plan <id>` | — | Value usage against a subscription fee, over whole months only |
| `--project <slug>` | — | Only projects whose slug contains this text |
| `--top <n>` | `20` | Rows in the most-expensive-sessions table |
| `--show-paths` | off | Show full project directory slugs |
| `--json` | — | Print JSON to stdout, write no file |
| `--statusline` | — | Print one short line, write no file ([see below](#use-it-as-a-statusline)) |
| `--scope <session\|today>` | `session` | What `--statusline` measures |
| `--limits` | — | Report subscription rate-limit windows ([see below](#see-your-rate-limit-windows)) |

### `--root` and your working directory

**Running contextbill from inside a repo does not scope it to that repo.** `--root`
always defaults to `~/.claude/projects`, so the corpus is the same wherever you run
from. The only thing that follows your working directory is where the HTML report
lands. That is deliberate — spend is worth seeing whole — but it is easy to mistake
for a bug when two directories report the same number.

To measure one project, point `--root` at its directory under `~/.claude/projects`:

```bash
npx contextbill --root ~/.claude/projects/C--Users-you-work-acme
```

contextbill notices that shape and says so, because the figure it produces then
covers one project rather than everything. Note that transcript folders are named
after the literal working directory a session started in, so work started from a
parent folder is filed under that parent, not under the repo you were editing.

### Reading OpenAI Codex transcripts too

`--source all` also reads OpenAI Codex CLI rollouts from `~/.codex/sessions`
(`--codex-root` to point elsewhere). It is a separate flag from `--root` because the
two agents keep their transcripts in different places and in different layouts.

**Codex turns are priced in dollars.** `prices.json` gained OpenAI rates on
2026-09-07, so a Codex turn is priced from a published OpenAI rate exactly as a Claude
Code turn is priced from a published Anthropic one. `datedByProvider` carries a
separate reading date per vendor, and every OpenAI entry repeats its own source URL
and reading date; a test fails if one does not.

**Only the models Codex rollouts actually name are priced**, which today means
`gpt-5.6-sol` and `gpt-5.6-terra`. `gpt-5.5` is deliberately left out: OpenAI charges
a cache-write premium on GPT-5.6 and later and none before it, and the cache-write
multiplier in `prices.json` is one global value with no per-model override, so pricing
`gpt-5.5` would assert a premium nobody charges and nothing would fail. Left out, its
tokens are counted, named in `unpriced models`, and kept out of every dollar figure.

With `--source` given the CLI prints a per-source table, so you can always see which
part of the corpus a dollar figure covers. Adding Codex never changes what your Claude
Code usage costs.

## Use it as a statusline

`--statusline` prints one line and writes nothing:

```
$0.94 API-equiv · 16 turns · 2.7M tok · session
```

When the payload carries a rate-limit window, the line carries it too:

```
$0.94 API-equiv · 16 turns · 2.7M tok · session · 7d 63% used · ~2d1h to limit (projected)
```

Add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx -y contextbill --statusline"
  }
}
```

`npx` re-resolves the package on every prompt, so install it once and point at the
binary directly if you want the fast path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "contextbill --statusline"
  }
}
```

Claude Code writes a JSON payload to the command's stdin; contextbill reads
`transcript_path` from it and prices that one transcript. Run by hand with no payload,
it falls back to the most recently modified transcript under `--root`.

**It is scoped because it has to be fast.** Claude Code runs the command on every
prompt, and a full corpus scan is not a per-prompt operation. Session scope reads one
transcript, `--scope today` reads the files modified since local midnight, and an
unscoped run reads everything — so the three differ by roughly the amount of data each
one opens, which is the only part of this that is a property of the tool rather than
of a machine.

There is no timing table, on purpose. The one published earlier did not reproduce.
[METHODOLOGY.md](METHODOLOGY.md#statusline-timing) records why it was withdrawn and how to
time a statusline run on your own machine.

`--scope today` is labelled **`active today`** in the output rather than `today`,
because it filters on file modification time: a session that started yesterday and
continued this morning is counted in full. It is a bound on today's spend, not a
measurement of it.

Two behaviours differ from every other mode, both on purpose:

- **It exits non-zero and prints nothing when it cannot answer.** Claude Code hides a
  statusline whose command fails, so a bad `--root` costs you the line rather than
  putting an error message in your prompt.
- **`API-equiv` is not droppable.** These are the dollars this usage would cost metered
  at published API rates. If you are on a subscription you paid a flat fee instead, and
  a bare dollar figure sitting in a prompt reads as a bill.

## See your rate-limit windows

`--limits` reports how much of each subscription rate-limit window is gone, when it
resets, and the pace that implies:

```
  Rate-limit windows, read from the statusline payload

  measured   42% of the 5-hour session limit used — resets in 1h58m (2026-09-09 22:43 UTC)
  projected  13.9 points/hour since that window opened; at that pace the window resets before it fills

  measured   63% of the 7-day limit used — resets in 3d10h (2026-09-13 07:44 UTC)
  projected  0.7 points/hour since that window opened
             100% around 2026-09-11 22:39 UTC — 2d1h from now, before the reset
  measured   $0.00 API-equivalent across 0 turn(s) in 0 transcript(s) touched
             since that window opened — $0.00/hour
```

That block is a verbatim capture, not an illustration: it is what
`contextbill --limits --root fixtures/projects` printed on 2026-09-09 with a sample
payload on stdin. The local-spend row reads `$0.00` because the bundled fixture corpus
has no file modified inside the window — against a real corpus it carries the
API-equivalent figure for the transcripts touched since the window opened.

**These are the only numbers in contextbill that are not derived from a transcript,
and that is the point.** Claude Code reads the `anthropic-ratelimit-unified-*` response
headers and writes the resulting percentages to a statusline command's stdin. So a
window that is present is the vendor's own count of what is gone, not a reconstruction
of one. Everything labelled `projected` is a straight line through that count — the
pace so far, extended — and usage is bursty, so read a projection as a pace and never
as a promise.

Wire it up the same way as `--statusline`:

```json
{
  "statusLine": { "type": "command", "command": "contextbill --limits" }
}
```

**What it cannot see, stated plainly.** It never infers a window from your transcripts.
A locally inferred window cannot see usage from another machine, from the web app, or
from a session whose transcript was deleted, and it cannot see how the vendor weights a
request — which is exactly why locally inferred windows disagree with the limits people
actually hit. So:

- **No payload, no answer.** Run by hand with nothing on stdin and it says it cannot
  see a window rather than guessing one.
- **There is no window at all** on an API-key, Bedrock or Vertex session, and none for
  a subscriber until the first API response of the session.
- **The dollar figures beside a window are not what the percentage measures.** A plan
  window is weighted by rules this tool cannot see. They sit next to the official
  numbers, never as a check on them.
- **`--scope today` carries no window**, because only session scope reads stdin.

Writes no file. Combines with `--json`.

## Use it as a library

If you are building a statusline, a dashboard or a CI check, import the analysis
instead of shelling out and parsing text. Text output is a presentation choice and it
changes; these functions and their types are the stable surface.

```bash
npm install contextbill
```

```ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { aggregate, cacheWriteMultiplier, parseTranscript, priceAll, usd } from 'contextbill';
import type { PriceTable, SessionStat } from 'contextbill';

// The price table ships with the package. `createRequire` rather than an import
// attribute, because `import ... with { type: 'json' }` needs node 20.10+ and
// contextbill supports 18.
const table = createRequire(import.meta.url)('contextbill/prices.json') as PriceTable;

const text = readFileSync('/path/to/session.jsonl', 'utf8');
const stat: SessionStat = parseTranscript(text, {
  id: 'session-a',
  project: 'my-project',
  isSubagent: false,
  bytes: text.length,
});

console.log(stat.turns, usd(priceAll(stat.byModel, table, '5m').cost.total));

// Many transcripts at once: the whole report the HTML is rendered from.
const report = aggregate([stat], {
  table,
  ttl: '5m',
  cacheWriteMult: cacheWriteMultiplier(table, '5m'),
  topN: 20,
});
```

| Export | What it does |
| ------ | ------------ |
| `parseTranscript(text, opts)` | Claude Code transcript text → one `SessionStat` |
| `parseCodexRollout(text, opts)` | The same for an OpenAI Codex CLI rollout |
| `priceAll(entries, table, ttl)` | Per-model usage → dollars, plus what it *could not* price |
| `priceModelUsage(entry, table, ttl)` | One model's usage → dollars, or `null` if unpriced |
| `cacheWriteMultiplier(table, ttl)` | The 5m/1h cache-write rate multiplier |
| `aggregate(stats, opts)` | Many `SessionStat`s → the full `Report` |
| `monthlyProjection(report)` | The 30-day projection |
| `planUtilization(report, plans, id)` | Value against a subscription's monthly fee |
| `classify(toolName)` | Tool name → spend category |
| `redactProject(slug, home)` | Strips the OS username out of a project slug |
| `renderReport(report)` | `Report` → the self-contained HTML string |
| `usd(n)` | The dollar formatting the CLI uses |

Every interface these accept or return — `SessionStat`, `Report`, `PriceTable`,
`CostBreakdown`, `RawUsage` and the rest — is exported as a type from the same entry.

**Nothing reachable from the library entry point touches the filesystem**, so it
bundles for a browser. Reading transcripts off disk is your half of the job, which
keeps the parser identical on both surfaces — this repo's own web app parses in the
browser through the same `parseTranscript`. `scan.ts`, which owns `node:fs`, is
deliberately not exported; a test walks the import graph and fails if a `node:` import
ever appears in it.

Two things worth knowing before you trust a number:

- **`priceAll` returns `unpriced`.** A model with no entry in the price table
  contributes zero dollars and real tokens. Surface that or your totals quietly
  under-report — contextbill's own output names the model ids rather than folding them
  in.
- **Deduplication happens in two places, and only one of them is `parseTranscript`.**
  A streamed assistant message is written to the transcript several times, each
  restating that message's *cumulative* usage, so `parseTranscript` keeps the maximum
  per field per `message.id`. Summing raw lines inflated the priced total by 2.39x on
  the corpus this was measured against. The second correction is in `aggregate`: a
  resumed session copies its parent's history into a new file, so the same request sits
  in two transcripts, and `aggregate` merges those copies across the whole corpus.
  Calling `parseTranscript` on many files and adding the results yourself gets the
  first correction and not the second — on this corpus that is a further $1,250.33, or
  7.9% of the pre-merge total.

## What the report contains

One self-contained HTML file with no external references:

- **Cost by category** — shell, file reads, browser automation, connectors, model
  output, and fixed startup overhead, in dollars.
- **The startup prefix** — your median pre-input token load and what re-reading it
  across every turn of every session is worth at API rates.
- **Sessions that wrote no file** — long runs that never produced an artifact.
  Offered as a prompt to go look, not as a verdict; read-only research is real work,
  and a `Bash` command that writes a file does not count toward the flag.
- **Runs that died on startup** — a scheduled agent that exits before working is
  indistinguishable from one that never fired. Transcript size separates them.
- **Cost by project** — what each directory you work from actually costs. The rows
  sum to the total exactly, so a project's share is a real share and not a
  re-estimate. Use `--project <slug>` to report on one of them alone.
- **Per-model spend** — including fast-mode turns at their own rate.
- **Token classes** — input, cache writes, cache reads, output.

## How it compares

Other tools read the same transcripts — `ccusage` and Claude Code Usage Monitor are the ones
I am aware of, and Claude Code ships a built-in `/cost`. I have not audited any of them, so
this section makes no claim about what they do or how they do it. A comparison table written
by one project about its alternatives is marketing, not evidence.

What contextbill commits to instead:

- **Accuracy you can check.** [METHODOLOGY.md](METHODOLOGY.md) states every rule with the file
  that implements it. The suite pins an exact end-to-end dollar figure worked out by hand from
  `prices.json`, so a pricing regression fails loudly. `scan.ts` and `classify.ts` can be
  differential-checked against the unpublished reference script they were ported from. The
  streamed-rewrite correction is stated with its measured factors, not asserted: across 2,424
  transcripts and 459,783 lines, 171,974 usage-bearing lines collapse to 75,196 messages, and
  the priced total moves from $37,655.25 to $15,733.14 on the same text in one pass.
- **Per-MCP-connector attribution.** Tool names arrive as `mcp__<server>__<tool>`, so spend is
  attributable per connector, priced off the same content pool and the same denominator as the
  category rows. Servers that were called and returned nothing still appear with their call
  count — a chatty connector and a silent one are different findings. The
  [limits of that attribution](METHODOLOGY.md#how-categories-and-connectors-are-attributed)
  are documented too: it is an apportionment by result bytes, and a connector that loaded but
  was never called cannot be seen.
- **Plan utilization.** `--plan <id>` values usage against a subscription fee, over complete
  months only, and returns nothing rather than a multiple when no month is complete. A metered
  plan gets no multiple at all, because there is no flat fee to divide by.

Questions worth putting to any usage tool, this one included. The answers are what separate
them:

1. Does it collapse streamed message rewrites, and by which rule — sum, last line, or maximum
   per field?
2. What does it do when a resumed session copies its parent's history into a new file?
3. Does it price last quarter's usage at last quarter's rates or at today's?
4. Where do its rates come from, and do they carry the date they were read?
5. What does it assume about cache-write TTL, which no transcript records, and which direction
   does that assumption err in?
6. Does it call the result an invoice?

## What data it accesses

Transcript files, opened read-only. Nothing is written back into any directory it
reads.

| Read | When | Default |
| ---- | ---- | ------- |
| `*.jsonl` under `--root` | always, unless `--source codex` | `~/.claude/projects` |
| Codex CLI rollouts under `--codex-root` | only when `--source` is `codex` or `all` | `~/.codex/sessions` |

**The Codex tree is opt-in and is read only when you ask for it.** A default run
(`--source claude`) never opens `~/.codex/sessions` or any path outside `--root`.

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

The short version. [METHODOLOGY.md](METHODOLOGY.md) is the long one, including the
deduplication rule, dated rate periods, the category and connector apportionment, and what
none of it can know.

Every dollar figure derives from `prices.json`, which carries the date it was
compiled and is cited in every report footer. It holds **first-party rates from two
vendors** — Anthropic's for Claude Code usage and OpenAI's for Codex — each with its
own reading date under `datedByProvider`, because the two were read on different days
and a single `dated` field would have to lie about one of them.

First-party only, in both cases. Amazon Bedrock, Google Vertex AI and Azure OpenAI are
partner-operated and priced separately; contextbill does not model them, and a
transcript produced through any of them is priced as if it had gone to the first-party
API.

Three details that are easy to get wrong, and how contextbill handles them:

- **Dated model ids.** Transcripts record the id actually sent, including snapshots
  like `claude-haiku-4-5-20251001`. A direct table lookup misses those and prices a
  real model at zero. The suffix is stripped before lookup.
- **Fast mode.** `usage.speed === "fast"` bills at roughly double. Ignoring it
  understates every fast session.
- **Cache-write TTL is not recorded in transcripts.** Writes bill at 1.25× at the
  5-minute TTL and 2× at one hour, and the transcript carries a single number with no
  TTL field. contextbill cannot infer it and does not guess: it defaults to the cheaper
  rate — so it understates rather than overstates — names the assumption in the report
  footer, and offers `--cache-ttl=1h` to see the other figure.

Models with no entry in the price table are counted and reported separately rather
than folded into the total as free.

The startup-prefix figure is a **model**, not a billed line item: prefix tokens priced
across observed turns, capped at non-output spend. It is labelled as such in the
report.

## Architecture

Zero runtime dependencies, Node built-ins only. Only `cli.ts` and `scan.ts` touch the
disk. Every other module is pure, so the logic is testable without fixtures on disk and
the parsers run unchanged in the browser.

| File | Purpose |
| ---- | ------- |
| `src/types.ts` | Shared interfaces, defined before consumers |
| `src/scan.ts` | Walks the transcript directories and reads each file. The only module besides `cli.ts` that imports `node:fs` |
| `src/parse.ts` | One Claude Code transcript → per-session token and tool stats. Shared with the web app |
| `src/codex-parse.ts` | The same for an OpenAI Codex CLI rollout |
| `src/limits.ts` | Rate-limit windows from the statusline payload, and their projections |
| `src/classify.ts` | Tool name → spend category |
| `src/cost.ts` | Token counts + price table → dollars |
| `src/aggregate.ts` | Session stats → whole-corpus report |
| `src/waste.ts` | Waste and fleet-health heuristics |
| `src/privacy.ts` | Strips machine-identifying path data |
| `src/report.ts` | Report → self-contained HTML |
| `src/safe-path.ts` | Same-origin check for login redirect targets, used by the web app |
| `src/index.ts` | The published library entry. Re-exports the pure modules only |
| `src/cli.ts` | Arg parsing, stdin, and writing the report |

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
themselves. That script is the maintainer's own and is not published in this repository.
Point both at the same **frozen** corpus and compare `turns` and the
median startup prefix — they must agree exactly. Freeze it first: running against a
live transcript directory produces off-by-one differences whenever another agent
session appends a turn mid-comparison, which looks exactly like a port bug and is not
one.

## Environment variables

None. contextbill needs no API key, no account and no configuration, because it never
calls an API. If a future version ever requires a credential, that will be a breaking
change announced in the changelog.

## Contributing

Issues and pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the full guide —
setup, the constraints that will fail review, and how to update prices. The short version,
before opening one:

1. `npm test`, `npm run lint` and `npm run build` all pass.
2. New behaviour comes with a test. Do not weaken an existing test to make a suite green.
3. **Do not add a runtime dependency** without a stated reason — `npx contextbill` staying
   instant and auditable is a product property, not an implementation detail.
4. **Do not add a network call.** Zero egress is the product; there is a test asserting
   it.
5. Price changes in `prices.json` must come with an updated `dated` field and a source.
6. A change to how any number is computed is a change to [METHODOLOGY.md](METHODOLOGY.md).
   Update it in the same pull request.

## License

MIT © 2026 Mohammed Alkindi
