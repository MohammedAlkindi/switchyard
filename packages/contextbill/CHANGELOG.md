# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, a minor bump may contain breaking changes; those are listed first.

## [Unreleased]

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
