# Methodology

How contextbill turns a directory of transcripts into a dollar figure, and what that
figure is and is not.

This document exists so the accuracy claim is checkable rather than asserted. Every
rule below is implemented in the files named beside it, and the "[What this cannot
know](#what-this-cannot-know)" section at the end is the part worth reading first if
you are deciding whether to trust a number.

---

## What the dollars mean

contextbill counts tokens recorded in your own transcripts and prices them at the
vendor's published first-party API rates — Anthropic's for Claude Code usage, OpenAI's
for Codex. **The result is API-equivalent value, not an invoice.**

If you are on a subscription you paid a flat monthly fee, and no arrangement of these
numbers changes that. What they give you is a common unit: one session against another,
one project against another, a habit against the habit it replaced. Every surface that
prints a total says so, including the statusline, which is why `API-equiv` cannot be
switched off there.

Rates are **first-party API rates only**, for both vendors. Amazon Bedrock, Google
Vertex AI and Azure OpenAI are partner-operated and priced separately; contextbill does
not model them, and a transcript produced through any of them is priced as if it had
gone to the first-party API.

The two vendors were read on different days, so `prices.json` carries a per-vendor
reading date in `datedByProvider` rather than one `dated` field that would have to be
wrong about one of them. Anthropic rates were read 2026-09-03, OpenAI rates 2026-09-07.

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

Measured 2026-09-09 over 2,424 real transcripts and 459,783 lines: **171,974
usage-bearing lines collapse to 75,196 messages.**

| Field | Inflation if you sum raw lines |
| ----- | ------------------------------ |
| input tokens | 4.98x |
| cache writes | 2.78x |
| cache reads | 2.21x |
| output tokens | 2.10x |
| **priced total** | **2.39x** ($37,655.25 naive against $15,733.14 deduplicated, same text, one pass) |

Both columns come from the same read of the same frozen corpus, so a live append
cannot fake the delta. The deduplicated column was computed by a script written
independently of `parse.ts` and lands on **$15,733.14**, which is the figure the
shipped CLI reports for that corpus before the cross-transcript merge below — the same
number to the cent, from two implementations. The factors move with corpus composition
— a corpus of long streamed sessions inflates more than one of short ones — so read
them as the size of the correction on real usage, not as a constant.

That is the first of two corrections. The second is in `aggregate.ts` and is described
in the next section but one; on the same corpus it takes the total from $15,733.14 to
**$14,482.81**.

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

### Resumed copies are merged across transcripts

**This section used to say the opposite, and that reading is now wrong.** Until
2026-09-08 the id map lived only inside a single `parseTranscript` call, a copy that a
resumed session carried into a new file stayed counted twice, and this document
described leaving it that way as a deliberate decision for want of evidence. The
evidence now exists, `aggregate.ts` calls `mergeResumedCopies` on every aggregate, and
what follows is what actually runs.

**Why the copy exists.** A resumed session copies its parent's transcript lines forward,
so the same API request — one billed event — sits in two files. `parse.ts` cannot see
that; it reads one transcript at a time. The correction has to happen where every
transcript is in hand, which is `aggregate`, and it runs before anything is priced. Both
the CLI and the browser reach it through `aggregate`, which is what keeps the two
surfaces reporting the same number for the same directory.

**What is merged, and why `message.id` alone would not be enough.** Two messages are
treated as one request only when **both** the `message.id` and the first line `uuid`
match. A uuid is minted per line by whoever wrote that line, so two files sharing one is
proof of a copy; not sharing one is proof of nothing. `sessionId` is not usable at all —
it is rewritten to the new session on every copied line.

On the frozen 2,424-transcript corpus, 1,968 message ids appear in more than one file:

| | Ids | Effect |
| - | --- | ------ |
| Shared line uuid — proved a copy, merged | 1,965 | 3,045 redundant copies removed across 39 transcripts, **$1,250.33** off the total |
| No shared uuid — not proved, **not** merged | 3 | 14 turns across 17 transcripts stay double-counted, about **$1.25** |

**Why the second row is not merged.** Two different things produce it, and the
transcripts do not say which. One message's streamed rewrites can be scattered across
sibling subagent files of a single parent session, in which case merging is right. An API
gateway can also hand one id to two genuinely independent sessions, in which case merging
under-counts real spend. Both look identical from the outside, and no field in the files
separates them. So the unproved cases stay counted, and are disclosed as a residue on the
CLI summary and in the report: an overstatement that is measured beats an understatement
that is invisible.

**What the merge deliberately does not touch, and why.**

- **`startupPrefix` stays as parsed**, even on a session whose first message this pass
  just removed. The prefix is the fixed context every turn of that session re-reads, and
  the copied first message is an honest witness of it. Re-deriving it from the first
  message the session wrote itself would read a mid-conversation cache read as startup
  context and inflate the figure by the whole parent transcript.
- **`bytes`, `toolBytes`, `connectorBytes` and the tool counters stay.** Those bytes
  really were read back into that session's context window.
- **A merged message is valued at the maximum per field of every holder**, the same rule
  the per-file collapse uses. A copy that caught one rewrite the original did not is
  still the same request, and the higher figure is the one that was billed. So the
  surviving copy is sometimes *raised*, and the removed total is reported net of those
  raises — otherwise the figure printed as "counted twice" would name dollars the total
  beside it still carries.

**Attribution between holders is arbitrary; the total is not.** A verbatim copy carries
the parent's timestamps, so parent and child usually start at the same instant and
nothing in either file says which one made the request. The message goes to the
earliest-starting holder, tie-broken by session id then project — deterministic, order
independent, identical in both readers, and a coin toss between holders all the same. It
moves dollars between rows of the most-expensive-sessions and per-project tables. It
cannot move the corpus total.

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

**Honest status of this mechanism today:** no entry in the shipped `prices.json`
carries `periods`, so `eraAssumptions` is empty on every corpus and the machinery,
though real and tested, is inert. It is documented as what happens when a rate does
change, not as something already shaping your numbers.

One half of that used to be stated more strongly than it should have been. Per-model
usage entries **do** carry a timestamp — `parse.ts` keys them by model, speed and UTC
day, and the entry carries the earliest instant in its bucket — so the moment a `periods`
array is added to a model, it starts applying. The only thing keeping this inert is the
absence of a period, and `prices.json` explains at length why none has been written: the
one candidate, Sonnet 5 moving from $3/$15 to $2/$10 on 2026-08-28, was **this table
being wrong** rather than a rate that moved. $3/$15 was never charged to anyone, and
writing it as a period would price every earlier turn 50% high with full confidence.

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

### Codex turns are priced in dollars

**This section used to say Codex dollars were left blank, and that inventing OpenAI
rates was deliberately refused.** `prices.json` gained OpenAI rates on 2026-09-07, so
that reading is out of date. What was refused was never "price Codex" — it was "guess a
rate". The rates below were read from OpenAI's own published pages, and every entry
repeats its source URL and reading date in its `note`; `prices.test.ts` fails if one
does not.

**Only the models Codex rollouts actually name are priced.** Reading every rollout under
`~/.codex/sessions` on 2026-09-07 found exactly three model ids. Two are priced:
`gpt-5.6-sol` ($4/M input, $20/M output) and `gpt-5.6-terra` ($2/M, $12/M). Pricing the
rest of the catalogue would carry unverifiable claims forever for usage nobody has.

**`gpt-5.5` is deliberately absent, and this one really is a refusal.** OpenAI charges a
1.25x cache-write premium on GPT-5.6 and later and **no** cache-write premium on models
before it, while `cacheWriteMultiplier` in `prices.json` is a single global with no
per-model override. Pricing `gpt-5.5` would therefore assert a premium OpenAI does not
charge, silently, with nothing failing. Left out, its tokens are counted, land in
`unpricedModelsSeen`, and are named above the total — loud and understated rather than
quiet and overstated. `codex.test.ts` pins that the fixture corpus stays partly unpriced
for this reason. Fixing it means giving a model entry its own optional cache multiplier,
which is the same change `claude-fable-5-1` needs.

Three further things were checked by arithmetic over the records rather than assumed,
because getting any of them backwards changes the bill silently:

- **`reasoning_output_tokens` is billed as output and is already a subset of
  `output_tokens`.** Adding it would inflate output by 8-50%.
- **`cached_input_tokens` is discounted by exactly a tenth**, which is the same figure
  `cacheReadMultiplier` already applies to Anthropic models. That agreement between two
  vendors is a coincidence, not a law, so `prices.test.ts` pins each published cached
  rate against `input x cacheReadMultiplier` and fails if OpenAI ever prints one that is
  not a tenth.
- **`cached_input_tokens` is a subset of `input_tokens`**, not a bucket beside it.

Two known understatements, recorded rather than fixed:

- **`--cache-ttl=1h` is meaningless for OpenAI** and would apply Anthropic's 2x to an
  OpenAI cache write, which nobody charges. The dollar effect today is exactly zero:
  `cache_write_input_tokens` was present on all 732 local `token_count` events and
  read 0 on every one.
- **The long-context tier is not modelled.** Prompts over 272K input tokens bill at 2x
  input and 1.5x output for the whole request. Usage is aggregated per model per UTC day
  before pricing, so per-request prompt size is gone by then. A corpus that crosses that
  threshold is under-reported. It did not fire locally: the largest single-turn input was
  228,238 tokens.

Passing `--source` makes the CLI print a per-source table, so the split between vendors
is visible at the point the total is read. Adding Codex never changes what the Claude
Code half costs.

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

## The waste heuristics, and every threshold behind them

Two findings in the report are heuristics rather than measurements, and the wording is
chosen to say so: contextbill prints **"no file written"**, never "wasted". A long
read-only research session is real work and must not be labelled otherwise on the
strength of a threshold. The numbers are offered so a person can judge.

**Every threshold in `waste.ts` was re-cut on 2026-09-07, and none of them was
rescaled.** They were all written when `turns` counted transcript lines. Once `turns`
became a count of billed messages, each constant was standing for something different
from what it said. Dividing them by the old inflation factor would have produced a
threshold still derived from the bug, so each was given back its meaning and re-cut
against the distribution that meaning talks about.

| Constant | Was | Is | What changed |
| -------- | --- | -- | ------------ |
| `LONG_SESSION_TURNS` | 200 | **50** | 200 real requests is far past the knee. P(no file written given at least N turns) is 24.1% at N=5, 6.7% at 50, 4.2% at 200 — below the knee the finding reports ordinary behaviour, far above it it reports almost nothing |
| `DEAD_RUN_BYTES` | 4,096 | **32,768** | 4,096 matched **nothing**. It was calibrated against a scheduler's `*.log` files, and `bytes` is the JSONL transcript — a different artifact. Claude Code writes injected session context into the first records, so even a run that dies on startup leaves roughly 15 KB |
| `DEAD_RUN_TURNS` | 3 | **2** | The only value here that moves *down*. It is a `<=` filter, so removing the turn inflation made it looser rather than stricter |
| Length buckets | 50/200/500/1000 | **10/50/150/400** | The old bands put two thirds of sessions in the first row and a *single* session in the last, so that row's "share" was one session's bill |

**What that changed on the frozen 2,424-transcript corpus**, measured by applying the
old thresholds to the same rows:

- **Long sessions with no file written: 2 became 9.** The old cut surfaced $164.89, the
  new one $293.50. The smallest row the new threshold admits is worth $11.37, and the
  shortest is 68 turns — so nothing trivial was let in, and seven real read-only
  sessions had been invisible.
- **Runs that died on startup: 0 became 15.** This finding could not fire at all before.
  The fifteen transcripts run 14,663 to 30,047 bytes and 0 to 2 billed turns, every one
  of them above the old 4,096-byte ceiling and therefore silently excluded.
- **The length buckets now populate every row**: 309 / 106 / 86 / 54 / 16 sessions
  carrying 1.3% / 7.3% / 18.6% / 37.4% / 35.4% of main-session spend.

The property the buckets are cut for is that **every row is populated and none is one
session wide**. It is deliberately *not* that the shares rise monotonically — that was
a fact about one corpus on one day, and it did not survive re-measurement.

**The dead-run finding is Claude Code transcripts only, and `deadRuns` enforces that.**
Every byte quoted above came from `~/.claude/projects`, and the ~15 KB floor has a cause
specific to that writer. A Codex rollout is a different file written by a different
program, and nothing has measured what a dead one weighs — the local rollouts run 1.2 MB
to 21.0 MB and contain no corpse at all, so they can neither calibrate a Codex floor nor
test one. Reporting nothing for Codex is better than reporting a guess, so those
transcripts are skipped and the output says so.

---

## Rate-limit windows

`--limits` reports subscription rate-limit windows. **These are the only figures
contextbill prints that are not derived from a transcript**, and that is the whole
reason the flag exists.

Claude Code reads the `anthropic-ratelimit-unified-*` response headers, converts each
fraction to a percentage, and writes the result to a statusline command's stdin. So a
window that is present is the vendor's own count of how much of it is gone. `limits.ts`
parses that payload and computes nothing except a straight line through it.

Everything is labelled **measured** or **projected**, and the two never mix:

- **measured** — the percentage and the reset instant, exactly as they arrived.
- **projected** — the pace implied by that percentage over the elapsed part of the
  window, and where that pace reaches 100%. The window's start is derived from its
  documented length (5 hours, 7 days), which is a documented fact rather than a
  measurement, so everything downstream of it is labelled projected. Usage is bursty.
  Read a projection as a pace, never as a promise.

### What it cannot see

- **A window that did not arrive.** With no readable payload on stdin, the answer is
  that there is no window to report. contextbill never infers one from local
  transcripts: an inferred window cannot see usage from another machine, from the web
  app, or from a session whose transcript was deleted, and it cannot see how the vendor
  weights a request. Those are exactly the reasons locally inferred windows disagree
  with the limits people actually hit.
- **Any window at all, on some accounts.** An API-key session, Bedrock and Vertex carry
  none, and a subscriber has none until the first API response of the session.
- **How the vendor weights a request.** The dollar figures printed beside a window are
  API-equivalent and are **not** the quantity the percentage measures. They sit beside
  the official numbers and are never a check on them.
- **A `spend_limit` window's length.** A gateway spend limit publishes a reset and no
  period, so no pace is projected for it. Picking a period would be the guess this
  module exists to refuse.
- **Anything, under `--scope today`.** Only session scope reads stdin, so the window
  segment is absent there by construction.

`used_percentage` may legitimately exceed 100, and a field of the wrong type drops that
one window and nothing else. No exception from this path ever escapes toward a prompt
line.

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
- **Which of two files a shared request belonged to.** A resumed session copies its
  parent's history forward, and the copy carries the parent's timestamps, so nothing in
  either file says which session made the request. The request is counted once — see
  [resumed copies](#resumed-copies-are-merged-across-transcripts) — but which session it
  is attributed to is a deterministic tie-break, not a fact recovered from the file. It
  moves dollars between session rows and never moves the total.
- **Whether two files that share a message id but no line id are the same request.**
  Three such ids exist on the corpus this was measured against. Merging them would be
  right if they are scattered rewrites of one request and wrong if a gateway handed one
  id to two independent sessions, and the transcripts do not distinguish those. They stay
  counted twice, and the residue is stated rather than hidden.
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
| Cross-transcript merge of resumed copies | `src/aggregate.ts`, `mergeResumedCopies` |
| Prefix cost model and its cap, category and connector apportionment, months, plan | `src/aggregate.ts` |
| Tool name to category, MCP server extraction | `src/classify.ts` |
| Rates, multipliers, `datedByProvider`, plan prices | `prices.json` |
| Heuristics, and every threshold behind them | `src/waste.ts` |
| Rate-limit windows and their projections | `src/limits.ts` |
| Project slug redaction | `src/privacy.ts` |

If something in this document disagrees with the code, the code is what runs and the
document is the bug. Please open an issue.
