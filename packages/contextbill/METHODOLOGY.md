# Methodology

How contextbill turns a directory of transcripts into a dollar figure, and what that
figure is and is not.

This document exists so the accuracy claim is checkable rather than asserted. Every
rule below is implemented in the files named beside it, and the "[What this cannot
know](#what-this-cannot-know)" section at the end is the part worth reading first if
you are deciding whether to trust a number.

---

## What the dollars mean

contextbill counts tokens recorded in your own transcripts and prices them at
Anthropic's published first-party API rates. **The result is API-equivalent value, not
an invoice.**

If you are on a subscription you paid a flat monthly fee, and no arrangement of these
numbers changes that. What they give you is a common unit: one session against another,
one project against another, a habit against the habit it replaced. Every surface that
prints a total says so, including the statusline, which is why `API-equiv` cannot be
switched off there.

Rates are **Anthropic first-party API rates only**. Amazon Bedrock and Google Vertex AI
are partner-operated and priced separately; contextbill does not model them, and a
transcript produced through either is priced as if it had gone to the first-party API.

---

## What is read

`*.jsonl` files under `--root` (default `~/.claude/projects`), opened read-only.
Nothing is written back into that directory, and nothing leaves the machine.

One other tree can be read, and only on request: `--source codex` or `--source all`
also reads OpenAI Codex CLI rollouts under `--codex-root` (default
`~/.codex/sessions`), on the same read-only terms. A default run never opens it. See
[Codex rollouts](#codex-rollouts) for what those numbers mean and what is deliberately
left blank.

From each line contextbill reads token counts, the model id, the `speed` field,
timestamps, tool names, and the **byte length** of tool results. It does not read prompts
or completions into the report. A line that will not parse as JSON is skipped rather than
thrown on: transcripts are appended to by a live process, so the last line is routinely a
partial write.

A file that cannot be read at all is dropped and **named** in the output. Counting it as
an empty transcript would inflate the transcript count and hide the failure
(`scan.ts`, `scanCorpus`).

---

## Deduplication: why raw lines double-count

This is the largest single correction in the tool, and the one most likely to be missing
elsewhere.

Claude Code writes an assistant message into the transcript **several times** while it
streams. Every one of those lines restates that message's **cumulative** usage rather than
an increment. Summing `message.usage` over lines is therefore not an approximation that is
slightly high, it is a multiplication.

Measured 2026-09-03 over 1,884 real transcripts and 413,702 lines: **150,662 usage-bearing
lines collapse to 65,474 messages.**

| Field | Inflation if you sum raw lines |
| ----- | ------------------------------ |
| input tokens | 3.44x |
| cache writes | 2.83x |
| cache reads | 2.23x |
| output tokens | 2.16x |
| **priced total** | **2.43x** ($33,671.16 naive against $13,855.18 deduplicated, same text, one pass) |

Both columns come from the same read of the same frozen corpus, so a live append
cannot fake the delta, and the deduplicated total is the figure the shipped CLI
reports for that corpus. The factors move with corpus composition — a corpus of long
streamed sessions inflates more than one of short ones — so read them as the size of
the correction on real usage, not as a constant.

### The rule

`parse.ts` keys on `message.id` and keeps the **maximum per field** for each id, across
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and
`output_tokens` independently.

Three alternatives, and why each is wrong:

- **Not the sum.** That is the multiplication above.
- **Not the last line.** The rewrites are cumulative, but their arrival order is not
  guaranteed.
- **Not the first line.** The first line of a streamed message is usually a partial write
  and understates it.

Two smaller rules ride along. A rewrite may carry a `model` the first line did not, so the
model is backfilled when the recorded one is null. `speed` is sticky: if any line for a
message reports `fast`, the message is billed as fast.

A record carrying **no** `message.id` is kept as its own record and counted in
`unidentifiedUsage`. That is the safe direction: dropping it loses spend that was really
billed, while keeping a rewrite that lost its id overstates by one message.

### Deduplication is scoped to one transcript, deliberately

The id map lives inside a single `parseTranscript` call. A **resumed session copies its
parent's history into a new file**, so the same `message.id` legitimately appears in two
transcripts, and that copy is *not* merged away.

Merging across files is a different correction with different evidence behind it, and this
codebase does not have that evidence. So instead of hiding the residue, `aggregate.ts`
measures it: `Report.deduplication` reports how many message ids appear in more than one
transcript and how many files are involved, and the report and the CLI both state it. The
double-count that remains is visible rather than silent.

---

## What a turn is

**`turns` is the number of billed messages, not the number of transcript lines.** After
the collapse above, one entry exists per assistant message that carried usage (plus one
per usage record that carried no id).

Everything downstream reads it that way:

- the startup-prefix re-read multiplier in `aggregate.ts` (`turns - 1`);
- `usdPerTurn` on each session;
- the `LONG_SESSION_TURNS = 200` and `DEAD_RUN_TURNS = 3` thresholds in `waste.ts`;
- the session-length buckets that show where spend concentrates.

A streamed rewrite restates a message that was already sent. It is not another request, so
it does not re-read the fixed context. Counting lines here charged that context two to
three times over.

---

## Pricing

Every dollar figure derives from `prices.json`. Nothing is fetched, nothing is inferred
from a model name, and nothing is hardcoded in the source.

```
cost = input      / 1e6 * inputRate
     + cacheWrite / 1e6 * inputRate * cacheWriteMultiplier[ttl]
     + cacheRead  / 1e6 * inputRate * cacheReadMultiplier
     + output     / 1e6 * outputRate
```

`cacheReadMultiplier` is `0.1`. `cacheWriteMultiplier` is `1.25` at the 5-minute TTL and
`2.0` at one hour. Both are properties of the table, not constants in the code.

The table carries a **`dated`** field and a **`source`**, both cited in every report
footer, and a test fails once the table is more than 60 days old. A stale rate makes the
product confidently wrong and nothing else notices.

### Dated model ids

Transcripts record the id that was actually sent, and that includes dated snapshot
suffixes: `claude-haiku-4-5-20251001`, or Vertex-style `claude-opus-4-5@20251101`. A
direct lookup misses those, prices a real model at zero, and silently understates the
bill. `normalizeModelId` strips the `@`-version first and then a trailing `-YYYYMMDD`
before lookup.

### Fast mode

`usage.speed === "fast"` bills at a premium rate. A model entry may carry `fastInput` and
`fastOutput`; when the turn is fast and those exist, they are used, otherwise the base
rate is. Fast turns are reported as their own row (`model (fast)`) so they cannot hide
inside the standard rate.

### Dated rate periods

A model entry may carry a `periods` array so usage is priced at the rate **in force when
it happened** rather than at today's rate. Without it, a vendor price change silently
reprices history and last quarter's report changes value on a re-run.

`rateInForce` resolves four cases, each a deliberate choice:

| Situation | What is applied |
| --------- | --------------- |
| The model carries no periods | The flat rate, treated as having applied for all time |
| The usage carries no timestamp | The **latest** period, i.e. the current rate |
| The timestamp falls inside a period | That period's rate |
| The timestamp predates every period | The **earliest** known rate, flagged `assumedEarliest` |

Period order in the file is not trusted; the rate is selected by date, so a hand-edit that
lands a period out of order cannot change what anything costs. A period whose `from` will
not parse is ignored rather than guessed at.

**Honest status of this mechanism today:** no entry in the shipped `prices.json` carries
`periods`, and the per-model usage entries an aggregate is built from carry no timestamp,
so `eraAssumptions` is empty on every corpus. The machinery is real and tested; it is
currently inert. It is documented here as what happens when a rate does change, not as
something already shaping your numbers.

### Models with no rate

A model id with no entry in the table returns `null` from the pricing path. It is **not**
folded into the total as zero. Its ids are collected into `unpricedModelsSeen` and printed
by the CLI and the report, because a total that silently excludes real tokens looks
complete and is not.

---

## The cache-write TTL assumption

`cache_creation_input_tokens` is a **single number with no TTL field**. The transcript
does not record whether a write used the 5-minute or the 1-hour cache, and there is no
second signal in the file that recovers it.

contextbill does not guess. It defaults to the **5-minute** rate (1.25x) and states the
assumption in the report footer and in the CLI output.

The direction of that default matters: if your client actually used 1-hour caching, the
reported figure is an **understatement**, never an overstatement. Pass **`--cache-ttl=1h`**
to see the other figure. The report always names which one produced the numbers you are
looking at.

Inferring a TTL from turn spacing, cache-read patterns, or anything else would be a guess
wearing a measurement's clothes. It is deliberately not done.

---

## The startup-prefix model

The largest surprise in most reports is how much was paid for context nobody typed: the
system prompt, the tool catalog, connector definitions, and instruction files that load
before a session starts and are re-read on every subsequent turn.

**This figure is a model, not a billed line item.** It is labelled as such in the report,
and it is worth understanding exactly how it is built.

**Measured input.** `startupPrefix` is `cacheRead + cacheWrite + input` of the **first
collapsed record** in the transcript. Two constraints:

- **First turn only.** On later turns those same tokens return as cache reads. Counting
  them again multiplies the figure.
- **From the collapsed record, not the first line.** The first *line* of a streamed
  message is typically a partial write and understates the prefix.

Subagent transcripts are excluded: `startupPrefix` stays zero for them, and the cost model
returns zero regardless.

**Modelled cost.** One write plus one re-read for every subsequent turn:

```
prefixUsd = prefix/1e6 * rate * cacheWriteMultiplier
          + prefix/1e6 * rate * cacheReadMultiplier * (turns - 1)
```

`rate` is `dominantInputRate`: the input rate of the model with the most turns in that
session. A session can span models, but the prefix is loaded once by whichever model the
session actually ran on, and unlike a blend this is a rate that genuinely exists in the
price table.

### Why it is capped

The model can overshoot what the session actually paid. The common case is a short session
whose cache expired between turns, so the tokens were re-sent rather than re-read, or were
never cached at all.

So the figure is capped at the session's **non-output spend**, which is the most it could
possibly have been:

```
prefixUsd = min(modelled, priced.total - priced.output)
```

Without the cap the overshoot leaks into the category table and category shares sum to
more than 100%. There is a test.

The cap also makes the rest of the breakdown exact by construction: everything that is
neither fixed prefix nor generated output is treated as conversation content, and that
pool is `nonOutput - prefixUsd`, which cannot go negative.

---

## How categories and connectors are attributed

A transcript does not record how many tokens a given tool result cost. What it does record
is the tool call, the result, and the result's size. So:

1. A `tool_result` block names only `tool_use_id`, never the tool. The name lives on the
   earlier `tool_use` block, so results are attributed by carrying a pending
   `id -> name` map across lines.
2. Each result's **byte length** is added to its tool's category (`classify.ts`: browser,
   files, shell, web, subagents, connectors, other).
3. The content pool from the previous section is apportioned across categories **in
   proportion to those bytes**.

**This is an apportionment, not a per-call measurement.** Result bytes are the proxy for
context consumed, because they are the only per-tool quantity in the file. A category's
dollars are its share of content spend, and it should be read that way.

Two details worth knowing:

- **Order matters in `classify.ts`.** Browser MCP tools are matched before the generic
  `mcp__` prefix, because a browser tool *is* an MCP tool and would otherwise vanish into
  "connectors" — on some machines that is the single largest line item.
- **Per-connector attribution comes from the call itself.** Tool names arrive as
  `mcp__<server>__<tool>`, so the server is recoverable. Connector dollars are priced off
  the same content pool and the same denominator as the category rows, so the two tables
  cut the same spend along different lines and are directly comparable. A browser tool is
  counted in the `browser` category *and* under its server; that is intentional, not
  double counting of dollars into the total.
- Servers that were called but returned nothing still appear, with their call count and
  $0. A chatty connector and a silent one are different findings.

Server names are passed through unchanged. A claude.ai connector is a UUID, and guessing a
friendly name for it would be invention.

---

## Months, coverage, and plan utilization

**A session is attributed whole to the UTC month it started in.** Splitting one that
crosses midnight on the last day of a month would need per-turn timestamps the aggregator
does not carry. The approximation is stated rather than hidden.

Each month reports **coverage**: the overlap between the corpus span (oldest surviving
transcript to newest) and that calendar month. A month is `complete` only when the corpus
brackets the whole of it. Both end months of any corpus are partial, and the month in
progress always is.

Coverage is a statement about the corpus **span**, not about the transcripts inside it. A
month whose middle week was deleted still reads complete. Nothing in a transcript
directory distinguishes a quiet week from a pruned one, and a gap detector would be a
guess dressed as a measurement.

`--plan <id>` compares value against a subscription fee. Two rules keep that honest:

- **The multiple is computed over complete months only, or not at all.** Three weeks of
  corpus against a full month's fee produces a number that is wrong by whatever fraction
  is missing, and wrong in the direction that looks like modesty. With no complete month
  the ratio is `null` and the report says so.
- **A metered plan gets no multiple.** There is no flat fee to divide by, and printing
  `1.0` would invent a break-even that does not exist.

A transcript with no usable timestamp lands in `undatedUsd` rather than in a guessed
month.

---

## Codex rollouts

`--source codex` reads OpenAI Codex CLI rollouts from `~/.codex/sessions`.

### Codex tokens are counted; their dollars are blank

**`prices.json` carries Anthropic first-party rates and no OpenAI ones.** So a Codex
turn contributes its full token counts to `turns` and to every token total, and **$0**
to every dollar figure. A `--source all` total is therefore complete in tokens and
partial in dollars, and reading it as a whole-corpus cost understates by whatever the
Codex half would have cost.

This is stated rather than fixed, deliberately. Inventing OpenAI rates would price real
usage confidently and wrongly, and nothing would fail. Instead the Codex model ids land
in `unpricedModelsSeen`, and passing `--source` makes the CLI print a per-source table
whose dollar column is honestly blank for Codex — so the split is visible at the point
the total is read. Adding Codex never changes what the Claude Code half costs.

The counter in a rollout has the same shape of hazard as the streamed rewrite, wearing
a different hat:
`payload.info.total_token_usage` is a **running total for the session**, restated in full
on every `token_count` event.

The rule is to accept an event only when its cumulative total **strictly advances**, and
to take the turn's usage as the delta. Measured across the rollouts available when it was
written, summing the cumulative field was catastrophic, summing the per-turn
`last_token_usage` field was wrong on 3 of 5 files (the counter is restated verbatim when
nothing advanced), and the monotonic-gated delta was exact on all five, independently on
input, cached input, output and total.

Two field meanings were derived by arithmetic over the records rather than from
documentation, because getting either backwards changes the bill silently:
`reasoning_output_tokens` is a **subset of** `output_tokens` (adding it would inflate
output), and `cached_input_tokens` is a **subset of** `input_tokens`, not a bucket beside
it.

---

## What this cannot know

The honest list. None of these is a bug, and none of them is fixable by reading the
transcript harder.

- **Which cache TTL was used.** One number, no TTL field. Defaults to the cheaper rate, so
  the total understates rather than overstates.
- **Which connectors were loaded.** A transcript records the calls that happened, not a
  tool catalog, an `mcp_servers` block, or a system prompt. A connector that loaded, cost
  you prefix tokens on every turn, and was never called is **invisible** to the per-server
  table. The prefix figure includes its cost; the attribution cannot name it.
- **Your invoice.** These are API-equivalent dollars. A subscription bills a flat fee, and
  contextbill has no access to billing of any kind.
- **Whether two files are the same session.** A resumed session copies its parent's
  history forward, so the same message is billed once and recorded twice. Those copies are
  counted and reported, not merged.
- **What a tool result cost in tokens.** Result bytes are the proxy. Truncation,
  summarization and compaction all sit between bytes on disk and tokens in context.
- **When a session's individual turns happened.** Only the transcript's first and last
  timestamps are carried, so months are bucketed by session start.
- **Whether a quiet month was quiet or pruned.** Coverage measures the corpus span.
- **Whether a session was useful.** `waste.ts` produces hypotheses, never verdicts. It
  reports "no file written", never "wasted", because a long read-only research session is
  real work. A `Bash` call that writes a file deliberately does not count toward that
  flag: a false negative is cheap there, a false positive hides a real finding.
- **Bedrock and Vertex pricing.** Partner-operated, priced separately, not modelled.
- **What Codex usage cost.** `prices.json` holds no OpenAI rates, so `--source codex`
  and `--source all` count Codex tokens and leave their dollars blank rather than
  guessing. A mixed total covers every token and only the Anthropic dollars.
- **Anything deleted.** Only transcripts still on disk are read.

---

## How to check any of this

The claims above are meant to be verifiable, including by someone who does not trust them.

- **Run it on one file.** `parseTranscript` is exported and pure. Feed it a transcript,
  compare `turns` against the distinct `message.id` count in that file, and compare
  `usage` against a per-id maximum you compute yourself.
- **The pricing anchor.** `src/__tests__/pipeline.test.ts` asserts the fixture corpus
  prices to `$0.017854` at nine decimal places, and the comment above it works that figure
  out line by line from `prices.json`. Pricing bugs do not throw: change a rate, mishandle
  a dated model id, drop fast-mode billing, or alter how the prefix is apportioned, and
  every other test still passes while every number is wrong. That assertion is what
  notices. If it goes red, the answer is to find what changed in the pricing path, not to
  update the number until it matches.
- **The deduplication fixtures** live in their own tree (`fixtures/dedup/`) so that adding
  one cannot drag the pricing anchor with it. A test asserts the anchor corpus stays free
  of `message.id` entirely, so a stray fixture fails with a named reason rather than a
  mystery delta.
- **Differential check.** `scan.ts` and `classify.ts` are ports of a reference measurement
  script. Point both at the same **frozen** corpus and compare `turns` and the median
  startup prefix; they must agree exactly. Freeze it first. A live transcript directory is
  appended to by running sessions, and the off-by-one that produces looks exactly like a
  port bug.
- **Fixtures are hand-built.** Never a real transcript. Real ones contain private
  conversation data and this repository is public.

---

## Where each rule lives

| Rule | File |
| ---- | ---- |
| Line parsing, rewrite collapse, turn count, prefix measurement | `src/parse.ts` |
| Codex cumulative-counter gating | `src/codex-parse.ts` |
| Model id normalization, rate selection, the cost formula | `src/cost.ts` |
| Prefix cost model and its cap, category and connector apportionment, months, plan | `src/aggregate.ts` |
| Tool name to category, MCP server extraction | `src/classify.ts` |
| Rates, multipliers, `dated`, plan prices | `prices.json` |
| Heuristics and their wording | `src/waste.ts` |
| Project slug redaction | `src/privacy.ts` |

If something in this document disagrees with the code, the code is what runs and the
document is the bug. Please open an issue.
