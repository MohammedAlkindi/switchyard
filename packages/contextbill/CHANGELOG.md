# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, a minor bump may contain breaking changes; those are listed first.

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

[0.2.0]: https://github.com/MohammedAlkindi/contextbill/releases/tag/v0.2.0
[0.1.0]: https://github.com/MohammedAlkindi/contextbill/releases/tag/v0.1.0
