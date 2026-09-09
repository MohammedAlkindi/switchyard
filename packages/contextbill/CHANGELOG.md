# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, a minor bump may contain breaking changes; those are listed first.

## [0.4.0] - 2026-09-10

Figures in this section come from one frozen copy of a 2,424-transcript,
1,527,997,880-byte `~/.claude/projects`, measured 2026-09-09. Freezing matters: a live
transcript directory is appended to while you read it, and the off-by-one that produces
looks exactly like a regression.

### Every total drops again: resumed copies are now merged across transcripts

A resumed session copies its parent's transcript lines into a new file, so the same
billed request sat in two transcripts and was counted twice. `parse.ts` cannot see that
— it reads one file at a time — so `aggregate.ts` now runs `mergeResumedCopies` over
every transcript in hand, before anything is priced. The CLI and the browser both reach
it through `aggregate`, so both surfaces still report the same number for the same
directory.

On the corpus above that is **$15,733.14 to $14,482.81**, a drop of $1,250.33 (7.9%),
and **75,936 turns to 72,891** (3,045 redundant copies removed across 39 transcripts).

Two messages are treated as one request only when **both `message.id` and the first line
`uuid` match**. A uuid is minted per line by whoever wrote it, so a shared one is proof
of a copy; `sessionId` is useless because it is rewritten on every copied line. Ids that
share no uuid are **not** merged — merging them would be right if they are one request's
rewrites scattered across sibling subagent files, and wrong if a gateway handed one id to
two independent sessions, and the transcripts do not distinguish those. Three such ids
exist on this corpus and stay counted twice, worth about $1.25; the CLI and the report
both name that residue.

Before comparing a new report against an old one:

- `startupPrefix`, `bytes` and the tool counters are deliberately **not** adjusted by the
  merge. Those bytes really were read back into that session's context window, and
  re-deriving a prefix from the first message a session wrote itself would read a
  mid-conversation cache read as startup context.
- Which session a shared request is attributed to is a deterministic tie-break, not a
  fact recovered from the file. It moves dollars between rows of the session and project
  tables and cannot move the total.
- Calling `parseTranscript` yourself over many files and summing gets the per-file
  rewrite collapse and **not** this correction.

### Added

- **Codex turns are priced in dollars.** `prices.json` gained OpenAI rates on 2026-09-07,
  so `--source codex` and `--source all` report dollars instead of a blank column. Only
  the models local rollouts actually name are priced — `gpt-5.6-sol` and `gpt-5.6-terra`.
  `gpt-5.5` is deliberately left unpriced: OpenAI charges a cache-write premium on
  GPT-5.6 and later and none before it, and `cacheWriteMultiplier` is a single global with
  no per-model override, so pricing it would assert a premium nobody charges. Its tokens
  are counted and named in `unpriced models` instead.
- **`datedByProvider` in `prices.json`.** The two vendors were read on different days
  (Anthropic 2026-09-03, OpenAI 2026-09-07) and one `dated` field cannot describe both.
  Every OpenAI entry repeats its own source URL and reading date; a test fails if one does
  not.
- **`--limits`**, reporting subscription rate-limit windows: how much of each is
  consumed, when it resets, and — labelled separately — the pace that implies. These are
  the only figures contextbill prints that are not derived from a transcript. Claude Code
  reads the `anthropic-ratelimit-unified-*` response headers and writes them to a
  statusLine command's stdin, so a window that is present is the vendor's own count.
  contextbill never infers one: with no readable payload it says it cannot see a window.
  There is no window at all on an API-key, Bedrock or Vertex session, nor for a subscriber
  before the first API response of the session. Writes no file; combines with `--json`.
- **A rate-limit segment on `--statusline`**, when the payload carries one:
  `$0.94 API-equiv · 16 turns · 2.7M tok · session · 7d 63% used · ~2d1h to limit (projected)`.
  Absent, the line is unchanged.

### Fixed

- **`--plan` no longer books a whole session to the month it opened in.** A session is
  now apportioned across calendar months by the timestamps its own model rows carry.
  `parse.ts` already buckets usage per model, per speed, per UTC day, and a UTC day never
  straddles a month boundary, so the split is exact rather than estimated. The old
  behaviour was worst exactly where `--plan` is read: because the break-even multiple is
  computed over **complete** months only, value dragged out of a partial month landed in a
  numerator that month is excluded from, inflating the one figure the flag exists to
  produce. Session *counts* still go whole to the start month, because a session is one
  session.
- **`--scope today` no longer reads stdin.** The rate-limit segment arrives on the
  statusline payload, and hoisting one shared read to the top of the function handed the
  cheap scope the expensive scope's failure mode — a host that leaves the pipe open. Only
  session scope reads stdin now, so the limit segment is session-scope only.

### Changed

- **Every threshold in `waste.ts` was re-cut, and none was rescaled.** They were all
  written when `turns` counted transcript lines rather than billed messages. Dividing them
  by the old inflation factor would leave a threshold still derived from the bug, so each
  was given back its meaning and re-cut against the distribution that meaning talks about.
  `LONG_SESSION_TURNS` 200 to 50, `DEAD_RUN_BYTES` 4,096 to 32,768, `DEAD_RUN_TURNS` 3 to
  **2** (a `<=` filter, so it is the only one that moves down), and the length buckets
  50/200/500/1000 to 10/50/150/400.

  `DEAD_RUN_BYTES` is the one worth knowing about: 4,096 matched **zero** transcripts, so
  the "runs that died on startup" finding could never fire. It had been calibrated against
  a scheduler's `*.log` files, while `bytes` is the JSONL transcript — Claude Code writes
  injected session context into the first records, so even a run that dies on startup
  leaves roughly 15 KB.

  On the corpus above: long sessions with no file written go from 2 ($164.89) to 9
  ($293.50), the shortest of them 68 turns and the smallest worth $11.37; runs that died
  on startup go from **0 to 15**, running 14,663 to 30,047 bytes and 0 to 2 billed turns.
  The length buckets now populate every row — 309 / 106 / 86 / 54 / 16 sessions carrying
  1.3% / 7.3% / 18.6% / 37.4% / 35.4% of main-session spend — where the old bands put two
  thirds of sessions in the first row and a single session in the last.

  The dead-run finding is Claude Code transcripts only, and the code enforces that. A
  Codex rollout is a different file written by a different program and nothing has
  measured what a dead one weighs, so those transcripts are skipped rather than judged
  against a floor cut on someone else's population.

### Documentation

- **The README statusline benchmark table is gone.** It had five rows and a stated
  method, and it has now failed to reproduce twice on the machine it was measured on.
  Re-measured 2026-09-09 against the frozen corpus above: the `node -e ""` floor read
  0.09 s against a published 0.17 s, session scope on the median transcript 0.15 s
  against 0.28 s, on the largest 0.46 s against 0.67 s, and a full report 14.8 s against
  20.1 s on a corpus 17% larger. `--scope today` could not be measured at all, because a
  frozen copy contains no file modified today.

  The floor is what settles it: `node -e ""` runs no contextbill code, so a 1.9x move
  there means the published table described a machine state rather than a program. The
  re-measurement was itself taken on a busy machine, so it is an upper bound and not a
  replacement. The section now explains why the scopes differ and gives a recipe for
  measuring it on your own hardware.
- **Two sections that recorded a decision the code had already reversed were replaced,
  not amended.** `METHODOLOGY.md` and `CLAUDE.md` both stated that cross-transcript
  merging was deliberately not done, and both now say what actually runs and that the old
  reading was wrong. Leaving both readings in place would teach the next reader that
  shipped work is an oversight.
- `METHODOLOGY.md` gains sections on the waste thresholds and on rate-limit windows, and
  its deduplication figures were re-measured on the corpus above rather than carried
  forward.

## [0.3.0] - 2026-09-03

### Every total drops, by 2.43x on the corpus it was measured against

Claude Code writes each streamed assistant message into the transcript several times,
and every one of those lines repeats that message's **cumulative** usage rather than an
increment. `parse.ts` summed `message.usage` once per line, so it counted each message
as many times as it was rewritten.

Measured 2026-09-03 over 1,884 transcripts and 413,702 lines, naive and deduplicated
computed from the same text in one pass so a live append could not fake the delta:
150,662 usage-bearing lines collapse to 65,474 messages. Summing every line inflated
input 3.44x, cache writes 2.83x, cache reads 2.23x and output 2.16x, and the priced
total 2.43x — $33,671.16 against $13,855.18.

Usage is now deduplicated by `message.id`, keeping the **maximum per field** — not the
sum, and not the last line, because the rewrites are cumulative while their arrival
order is not guaranteed. A record carrying no `message.id` still counts as its own turn.

Consequences worth knowing before comparing a new report against an old one:

- `turns` now counts billed messages rather than transcript lines, so every session
  reports fewer turns and `usdPerTurn` rises.
- The startup-prefix figure changes in both directions. Its re-read multiplier
  (`turns - 1`) falls, because a rewrite is not another request; its per-session token
  count rises, because the prefix is now read from the collapsed first message instead
  of that message's first and usually partial line.
- Dead-run detection gets stricter in the right direction: a corpse whose few messages
  were rewritten past the `DEAD_RUN_TURNS` threshold used to escape the list.
- Deduplication is scoped to one transcript. A resumed session copies its parent's
  history into a new file, and those copies are **not** merged. `Report.deduplication`
  counts them and both the CLI summary and the HTML report say so.

### Added

- **`--statusline`**, printing one line and no file, for use as a Claude Code
  `statusLine` command. It reads the JSON Claude Code writes to the command's stdin and
  prices the transcript named there, falling back to the most recently modified one
  under `--root`. Two behaviours differ from every other mode on purpose: it writes no
  file, and it exits non-zero and prints nothing when it cannot answer, because a stack
  trace inside someone's prompt is worse than a missing line.
- **`--scope <session|today>`**, what `--statusline` measures. Default `session`, one
  transcript. `today` filters on file modification time, so a session that began
  yesterday and continued today is counted in full — it is labelled `active today`
  rather than `today` for that reason, and it is a bound on today's spend rather than a
  measurement of it.
- **`--source <claude|codex|all>`** and **`--codex-root <dir>`**, reading OpenAI Codex
  CLI rollouts alongside Claude Code transcripts. Opt-in, and the Codex tree is never
  opened on a default run. `prices.json` carries no OpenAI rates, so **Codex tokens are
  counted and their dollars are left blank** rather than guessed at; passing `--source`
  prints a per-source table so you can see which half of the corpus the dollar figure
  covers. Adding Codex never changes what your Claude Code usage costs.
- **`--plan <id>`**, valuing usage against a subscription fee. The break-even multiple
  is computed over **whole calendar months only** and is `null` when the corpus contains
  none, because a partial month charged against a full fee reports a multiple that is
  too low. A metered plan gets no multiple at all — there is no flat fee to divide by.
  An unknown id lists the supported ones instead of silently reporting nothing.
- **`src/index.ts`, a published library entry point.** Import the analysis instead of
  shelling out and parsing text: `parseTranscript`, `parseCodexRollout`, `priceAll`,
  `aggregate`, `classify`, `renderReport`, `usd` and the rest, with every interface
  they accept or return exported as a type from the same entry. Nothing reachable from
  it touches the filesystem, so it bundles for a browser; `scan.ts`, which owns
  `node:fs`, is deliberately not exported and a test walks the import graph to keep it
  that way.

## [0.2.1] - 2026-08-28

0.2.0 was tagged but never reached npm, so this is the first 0.2.x you can install.

### Fixed

- The CLI did nothing at all when run from an installed copy on macOS or Linux
  (`274b949`). npm installs `bin` as a symlink, so `argv[1]` was the link under
  `node_modules/.bin` while `import.meta.url` was the resolved file. The entry-point
  guard compared the two unresolved, concluded it was being imported rather than run,
  and returned without printing anything -- exit code 0, no output, nothing to search
  for. Both sides are resolved through `realpath` now. Windows was never affected: its
  `.cmd` and `.ps1` shims pass the real `dist/cli.js` path as `argv[1]`, not their own.

## [0.2.0] - 2026-08-28

### Every dollar figure changed meaning, and one of them changed value

Two things in this release alter numbers you may already have written down.

- **Claude Sonnet 5 was priced 50% too high.** The table carried $3/$15 per MTok on the
  reasoning that $2/$10 was introductory pricing expiring 2026-08-31. Anthropic's pricing
  page states that increase was cancelled and $2/$10 is the standard price. Any earlier
  report with Sonnet 5 usage in it overstates that usage; re-run to get a correct figure.
- **Figures are now labelled API-equivalent.** No arithmetic changed for this one. The
  rates always were Anthropic's first-party API rates, so on a subscription the total is
  what the usage would cost if metered, not what anyone was charged. Every surface says
  so now instead of saying "what your agents actually cost".

### Added

- Cost by project, in the report and as `--project <slug>` to scope a run to one of them
  (`5d5b7e9`). Rows sum to the total exactly.
- Per-connector cost attribution: what each MCP server cost and how many calls it made
  (`c861f6d`). It can only see servers that were called — a transcript records no tool
  catalog — and the report says so rather than reading as a complete list.
- A delete button on every saved report in the hosted app (`5f19e22`).
- `prices.json` now prices four retired models, so transcripts mentioning them are
  counted instead of dropping out of the total (`ad99ef6`).

### Fixed

- The hosted app threw `NotReadableError` and lost the whole run when pointed at a
  transcript directory that was being written to — which is the normal case, since
  anyone measuring their usage has just been using Claude Code (`113902a`). Reads are now
  per-file with one retry, and coverage is reported when files are skipped.
- `--root` pointed at a single project directory silently misreported: every project
  resolved to `unknown` and subagents were counted as sessions. The session depth is now
  derived from the corpus, and the CLI says when it has read one project rather than
  everything (`66c1bc2`).
- A transcript the CLI could not read was counted as one containing no usage, inflating
  `transcriptCount` while hiding the failure. It is now excluded and named on stderr
  (`0ba5347`).

### Changed (breaking for library consumers)

The CLI and its output are unaffected; these matter only if you import the package.

- `SessionStat` gains two required fields, `connectorBytes` and `connectorCalls`. Code
  that constructs one by hand must supply them.
- `Report` gains `byProject` and `byConnector`.
- `scanCorpus` returns an additional `unreadable` array. `scanAll` is unchanged.
- `scanFile` takes two new optional parameters (`sessionDepth`, `onUnreadable`) and keeps
  its previous behaviour when they are omitted.
- `UnreadableFile` is exported from the core types; the web reader re-exports it.

## [0.1.0] - 2026-08-26

Initial release. CLI with zero runtime dependencies that reads Claude Code transcripts,
prices them, and writes a self-contained HTML report, plus the hosted app.

[0.2.1]: https://github.com/MohammedAlkindi/contextbill/releases/tag/v0.2.1
[0.2.0]: https://github.com/MohammedAlkindi/contextbill/releases/tag/v0.2.0
[0.1.0]: https://github.com/MohammedAlkindi/contextbill/releases/tag/v0.1.0
