# Switchyard roadmap, 2026-11

Date: 2026-11-16. Base: `origin/main` 3d22c3c. Inputs: the landscape survey
(`research/2026-11-switchyard-landscape.md`), a read of the code and tests, and
the P3 evaluation in `scripts/p3/` (numbers below are produced by that code;
see `scripts/p3/results/`).

Ranking is by expected value per unit of effort, with release blockers and
evidence problems first. Effort: S = under a day, M = 1-3 days, L = a week or
more. "Done" items were implemented and tested on branch
`research/landscape-1116`.

## 0. Findings that change priorities

1. **Release blocker (fixed here).** `src/lib/semantic.ts` imported `typescript`
   at module top level, `check.ts` imports it, `cli.ts` imports `check.ts`, and
   `typescript` is a devDependency. A build of `origin/main` installed with
   runtime dependencies only fails every command, `fleet --version` included:
   `ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'`. 0.5.0 on npm
   predates the filter, so nothing published is broken; the next release would
   have been.
2. **The existing benchmark's cost and token figures are constants, not
   measurements.** `scripts/benchmark-harness.ts` hardcodes `arm1Usage`
   (`input: 11200 + 18500`, ...) and `arm2Usage` (`10200 + 10400`, ...), and
   the "agent" edits are scripted stub files. `scripts/benchmark-results.json`
   therefore shows identical token totals for every task (61,950 vs 43,370).
   Its `costMultiplier: 0.85` and `meanSpeedup: 0.18` must not be cited. The
   collision fields are real git operations on synthetic edits.
3. **Real fix patches rarely change interfaces.** Across the 300 SWE-bench Lite
   gold patches, 8 change the header of a public callable in the patched file,
   and for the generated stale caller only 1 of those 8 breaks. Without injected
   mutations the positive class is 2 cases out of 806. This matches the
   "Passes Alone, Fails Together" finding (1 interference in 834 mined Django
   runs, [arXiv 2609.25396](https://arxiv.org/abs/2609.25396)): interface
   conflicts between concurrent fixes are rare, so precision on benign pairs
   matters more than recall on injected ones.
4. **The closest open-source competitors already ship symbol rules.** mergelock
   (`signature_caller`, `modify_delete`, MCP) and grove (symbol + dependency
   layers) do what the filter does, on tree-sitter, without published
   precision/recall. A preprint's contribution has to be the measurement and
   the precise rules, not the existence of a symbol filter.

## 1. P3 results (symbol filter on perturbed SWE-bench Lite)

Setup (details and threats to validity in `scripts/p3/README.md`): 300
SWE-bench Lite instances, 292 with at least one public callable in the patched
file. Agent A = gold patch, or gold patch + one signature mutation; agent B = a
synthetic concurrent edit written against the base. Labels come from an
independent oracle (CPython `ast` + `inspect.Signature.bind` of B's call
against A's post-merge signature). Every case runs on a real temporary git
repository. 1,682 cases, 412 labelled conflicts.

Accuracy, all 1,682 cases (`scripts/p3/results/p3-summary.md`; 4 concurrent
shards, so latency there is inflated):

| Detector | TP | FP | TN | FN | Precision [95% CI] | Recall [95% CI] | F1 | FPR |
|---|---:|---:|---:|---:|---|---|---:|---:|
| file overlap | 206 | 258 | 1012 | 206 | 0.444 [0.399, 0.489] | 0.500 [0.452, 0.548] | 0.470 | 0.203 |
| `git merge-tree` | 0 | 0 | 1270 | 412 | — | 0.000 [0.000, 0.009] | — | 0.000 |
| symbol filter, legacy (as in 3d22c3c) | 225 | 381 | 889 | 187 | 0.371 [0.334, 0.410] | 0.546 [0.498, 0.594] | 0.442 | 0.300 |
| **symbol filter, precise (this branch)** | 412 | 176 | 1094 | 0 | **0.701** [0.662, 0.736] | **1.000** [0.991, 1.000] | **0.824** | 0.139 |
| precise without added-lines rule | 412 | 178 | 1092 | 0 | 0.698 | 1.000 | 0.822 | 0.140 |
| precise with name (not import) resolution | 412 | 178 | 1092 | 0 | 0.698 | 1.000 | 0.822 | 0.140 |
| precise with any-change (not breaking-only) | 412 | 485 | 785 | 0 | 0.459 | 1.000 | 0.629 | 0.382 |
| `merge-tree` + precise (the `--semantic` gate) | 412 | 176 | 1094 | 0 | 0.701 | 1.000 | 0.824 | 0.139 |

Latency, sequential run on the first 40 instances, 251 cases
(`scripts/p3/results/p3-latency-summary.md`; Windows 11, git 2.53, shared
laptop with other sessions running), per agent pair, ms:

| Detector | mean | p50 | p95 |
|---|---:|---:|---:|
| `git merge-tree` | 204.6 | 157.2 | 348.4 |
| symbol filter, legacy (per-file `git show`) | 1139.0 | 972.2 | 1680.1 |
| symbol filter, precise, per-file `git show` | 1137.0 | 926.1 | 1997.2 |
| **symbol filter, precise, one `git cat-file --batch`** | 566.4 | 458.4 | 984.0 |

On that subset precise scores precision 0.756 [0.653, 0.836], recall 1.000, and
legacy scores 0.397 and 0.500, the same direction as the full run.

What the numbers say, and do not say:

- Precision rose from 0.371 to 0.701 and recall from 0.546 to 1.000 on the same
  cases. The ablations attribute almost all of the precision gain to the
  breaking-only rule (485 false positives with any-change, 176 without). On
  this data, import resolution and the added-lines rule each remove only 2
  false positives. Their value is in situations the synthetic B edits rarely
  create: an untouched pre-existing caller, and a same-named local function.
  Unit tests cover both cases (`tests/semantic-precise.test.ts`).
- Legacy's misses are intra-file changes (it checks only one direction and
  compares dotted method names against bare identifiers) and constructors.
- Recall of 1.000 is an upper bound. B's callers are simple, directly imported
  and in a new file, so the filter's resolution never meets re-exports,
  aliases or dynamic access. Do not quote it as recall on real agent edits.
- All but 2 of the 176 remaining false positives are signature changes that
  break some callers but not the generated one:
  - 128 positional callers survive a parameter rename;
  - 26 come from a keyword-only move;
  - 20 come from removal of an optional parameter the caller did not pass.

  A call-site-aware rule would remove these (plan item 2), but this benchmark
  could not measure it fairly: the oracle does exactly that check.
- `git merge-tree` scores 0 by construction (A and B never touch the same
  lines). The table shows what textual simulation cannot see, not that it is
  useless.
- Latency: batching blob reads halves p50 (926 to 458 ms). What remains is
  mostly four git process spawns (merge-base, two diffs, cat-file) on Windows.
  The 150 ms target in the research brief's Q4 is not met. Plan item 3 says how
  it could be.

## 2. Ranked plan

| # | Item | Value | Effort | Measure | Status |
|---|---|---|---|---|---|
| 1 | Load `typescript` lazily; packaging test that fails on any static import outside runtime deps | Unblocks the next release: every command crashed on a runtime-only install | S | Packed install, runtime deps only: `fleet --version` fails before, prints `0.5.0` after; test in `tests/package.test.ts` | **Done** |
| 2 | Precise symbol rules (breaking-only, import resolution, added/changed lines, constructors, both directions intra-file, file deletion) | Gate users stop seeing compatible extensions as conflicts | M | P3: precision 0.371 to 0.701, recall 0.546 to 1.000, FPR 0.300 to 0.139 | **Done** |
| 3 | Python support in the filter (dependency-free extractor) | Covers the language of SWE-bench and most agent benchmarks | M | P3 runs on it; 21 unit tests | **Done** |
| 4 | Batched blob reads (`git cat-file --batch`) | Halves `--semantic` latency | S | P3 latency p50 926 to 458 ms, p95 1997 to 984 ms | **Done** |
| 5 | P3 evaluation harness, results committed, reproducible from a cache | The preprint's core table; any later change to the filter is measured | M | `scripts/p3/` regenerates both summaries | **Done** |
| 6 | cortexai: `stream_options.include_usage` chunk; `finish_reason: "error"` on mid-stream failure; bill partial output once on error or disconnect | OpenAI SDK clients get usage; no unbilled tokens | S | 2 new tests fail before, pass after; 73 pytest pass | **Done** |
| 7 | Replace the hardcoded token/cost constants in `scripts/benchmark-harness.ts` with real agent runs priced by contextbill from transcripts, or delete the cost columns | Removes an indefensible number from anything a reviewer reads | M | Token totals differ per task and trace back to transcript files | Open, top priority before any write-up |
| 8 | Call-site-aware tier: read the consumer's actual call arguments (positional count, keywords) and flag only calls that no longer bind | Removes the 174 "breaking but survived" false positives; mergelock's `signature_caller` rule | M | Must be measured on organic pairs, not P3 (the P3 oracle is the same check); expect FPR down on P3, report it as an upper bound | Open |
| 9 | Organic evaluation: replay co-active agent PR pairs (AIDev / AgenticFlict / the 747-pair set of arXiv 2607.04697) and the "Passes Alone" stale-caller benchmark; ground truth = test or `tsc` failure after a clean merge | Answers the reviewer's first question (are injected conflicts realistic?) | L | Precision/recall with CIs per detector on mined pairs; report base rate | Open |
| 10 | TypeScript evaluation set (no public one exists per the survey): mine TS repos' PR pairs, ground truth `tsc --noEmit` after `merge-tree` | The CLI's default language has unit tests but no measurement | L | Same table as P3 for TS | Open |
| 11 | Long-lived semantic index: parse each blob once per OID across all pairs of a `fleet check` (K agents means K(K-1)/2 pairs today), single `git` process per check | Gets K = 10 checks under a few seconds; the brief's 150 ms per pair needs process reuse | M | P3 latency and a K = 2..15 scaling curve | Open |
| 12 | Pre-write hook: run `fleet check --semantic` from a Claude Code `PreToolUse` hook on Write/Edit (clash's design) | Moves detection from merge time to edit time | S | Count of conflicts caught before commit in a fleet run | Open |
| 13 | Advisory symbol claims in `.fleet/state.json`, exposed over MCP, consumed by `check` | CooperBench: a first-turn plan message goes with a 29.4% vs 51.5% conflict rate | M | Conflict rate with and without claims on CooperBench-style tasks | Open |
| 14 | Report "unknown" separately from "clean" when the filter cannot parse or resolve (unparseable file, bare specifier, re-export) | Stops silence being read as safety (clash's `error` field) | S | Count of unknown verdicts on P3 / organic sets | Open |
| 15 | Notify the other agent when a merged change touches symbols it references | "Passes Alone": a completed-change message recovered 82% of constructed-task runs | M | Recovery rate on the same constructed tasks | Open |
| 16 | Optional `typescript` peer dependency (`peerDependenciesMeta.optional`) so `npm ls` documents it | Discoverability; no runtime dependency added | S | `npm i` of the package installs no typescript; `--semantic` error text names the fix | Open |
| 17 | cortexai: rule router with fallbacks and a cooldown map (LiteLLM-style, ~30 lines), provider-reported usage as billing source, tokenizer-based estimates labelled as estimates | Correct bills and fewer failed requests; learned routers are not justified yet (RouterArena) | M | Billing diff vs provider usage on recorded calls; retry success rate | Open |

## 3. Not recommended

- Hard file locks between agents: a crashed agent stalls the fleet (foremerge's
  stated reason for staying advisory). Advisory claims only.
- LLM-judged conflict prediction in the gate: SMAT's LLM test generation took
  hours per configuration ([arXiv 2507.06762](https://arxiv.org/abs/2507.06762));
  a pre-merge gate needs seconds.
- A learned router for cortexai before a rule router exists: RouterArena found
  no router above GPT-5's accuracy, and LLMRouterBench found several routers do
  not beat a simple baseline.
- Linking Mergiraf (GPLv3) into an MIT CLI. Shell out if ever needed.
- Citing `scripts/benchmark-results.json` cost or speedup figures (finding 2).
