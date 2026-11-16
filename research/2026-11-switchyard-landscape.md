# Switchyard and cortexai: 2025-2026 research and open-source landscape

Date: 2026-11-16. Compiled by automated research from web sources (arXiv pages, GitHub repos, vendor docs). Stars and push dates were observed on 2026-11-16 unless stated. Items marked UNVERIFIED were not confirmed in code or a primary page. Several 2026 arXiv IDs are recent preprints. Spot-check on 2026-11-16: the six detector repos in section 3 (stars and push dates via the GitHub API) and arXiv 2607.04697, 2609.25396, 2603.21489, 2601.13295 and 2608.23740 (titles via the arXiv API) were re-fetched and exist as cited. The "Switchyard lacks X" statements predate this branch: the precise symbol rules in `research/2026-11-switchyard-roadmap.md` now include a signature-vs-caller check at the signature level and Python support.

## 2. Top findings

- Nearly every mainstream worktree orchestrator (claude-squad, ccmanager, worktrunk, gtr, vibe-kanban, par, uzi, Nimbalyst) isolates only and does no cross-agent conflict detection before merge; the evidence is code greps and docs per tool, see section 5 ([claude-squad](https://github.com/smtg-ai/claude-squad), [worktrunk](https://github.com/max-sixty/worktrunk)).
- A small cluster of detectors does pre-merge detection: clash (66 stars), git-parsec (16), grove (13), mergelock (0), foremerge (438); only grove and mergelock have a symbol layer, and none publishes precision/recall ([clash](https://github.com/clash-sh/clash), [grove](https://github.com/NathanDrake2406/grove), [mergelock](https://github.com/sadayamuthu/mergelock), [foremerge](https://github.com/naw103/foremerge)).
- Weave (Ataraxy-Labs, about 1.4k stars) is the closest product to Switchyard's niche: entity-level merge on tree-sitter plus a cross-file `weave_check`, advisory claims and an MCP server; its benchmarks are self-reported ([Weave](https://github.com/Ataraxy-Labs/weave)).
- Real-world base rate: on replayed three-way merges of 747 co-active AI-agent PR pairs, textual conflict was 41.7% cross-agent vs 19.8% intra-agent, and about 42% of conflicts were structural (modify/delete, add/add) ([arXiv 2607.04697](https://arxiv.org/abs/2607.04697)).
- Counter-signal: in 834 runs on 417 mined Django PR pairs only one showed combination-induced interference after grading was corrected, while constructed tasks showed 97%; a symbol-filter evaluation must justify how realistic its injected conflicts are ([arXiv 2609.25396](https://arxiv.org/abs/2609.25396)).
- The semantic-conflict literature (Borba group, Java) reports precision 0.29-0.47 and recall 0.07-0.54 for static analysis, which is the bar a reviewer will hold a name-based symbol filter to; no TypeScript/JavaScript dataset was found ([arXiv 2507.20081](https://arxiv.org/html/2507.20081), [arXiv 2510.01960](https://arxiv.org/html/2510.01960v1)).
- Two 2026 papers do prevention at write time through claims, which is the main design difference from Switchyard's detect-before-merge model: AgentRoom (file claims over MCP, [arXiv 2608.23740](https://arxiv.org/abs/2608.23740)) and ATM (pre-write admission, [arXiv 2607.00041](https://arxiv.org/abs/2607.00041)).
- For cortexai, the 2025-26 routing benchmarks say learned routers often do not beat a strong single model (RouterArena: no router exceeded GPT-5 accuracy); a rule-based router plus provider-reported usage and OpenAI-correct SSE chunks is the defensible scope ([arXiv 2510.00202v3](https://arxiv.org/html/2510.00202v3), [arXiv 2601.07206](https://arxiv.org/abs/2601.07206)).

## 3. Closest competitors to the symbol filter

Source for this section: the worktree/fleet code survey (shallow clones read 2026-11-16) and the conflict-detection notes. "Not read" means the note records no code review.

Switchyard's check as described in the task: file overlap, line intervals, `git merge-tree` simulation, TypeScript AST symbol filter (changed or deleted exported symbols referenced by another agent), recorded commit-pinned `fleet validate`, MCP server. The notes did not diff against Switchyard source, so "lacks" below rests on the task description only.

| Tool | Lang / license | Stars / last push | Detection method | Symbol-level? | Claims / locks | MCP | Notes |
|---|---|---|---|---|---|---|---|
| [clash](https://github.com/clash-sh/clash) | Rust, MIT | 66 / 2026-07-17 | Three-way tree merge via gix per worktree pair (`conflicts_with`, `check_all_conflicts`) | No (textual only) | None | Not seen; Claude Code plugin hook | `PreToolUse` on `Write\|Edit\|MultiEdit` runs `clash check`, so it checks before an agent writes. A pair whose detection errored carries an `error` field and an empty file list. |
| [git-parsec](https://github.com/erishforG/git-parsec) | Rust, MIT | 16 / 2026-09-19 | Files modified in 2+ active worktrees; `--simulate` runs `git merge-tree --write-tree --name-only --merge-base` per worktree vs `origin/<base>` and per pair | No | None | No | Ticket-to-PR workflow (Jira/GitHub/GitLab). |
| [grove](https://github.com/NathanDrake2406/grove) | Rust, Apache-2.0/MIT | 13 / 2026-07-17 | Five layers: file, hunk, symbol, dependency (one branch changes an export the other imports), schema (migrations, package deps, env config, routes); Green/Yellow/Red/Black score | Yes (tree-sitter: TS/JS, Rust, Go, Python, Java, C#) | None | UNVERIFIED | Daemon, TUI, `grove check`, GitHub Action; `merge_order.rs` suggests a merge order. |
| [mergelock](https://github.com/sadayamuthu/mergelock) | Go, Apache-2.0 | 0 / 2026-10-17 | `git merge-tree --write-tree` (git >= 2.38) plus tree-sitter (TS/JS/Python); rules `textual`, `add_add`, `modify_delete`, `signature_caller`, `duplicate_definition` | Yes | `claims` tool (semantics not read) | Yes (`check`, `claims`) | Never touches the working tree; GitHub Action; MCP Registry listing. Closest in mechanism to Switchyard. |
| [foremerge](https://github.com/naw103/foremerge) | Rust, Apache-2.0 | 438 / 2026-11-13 | Agents declare intent/scope claims (e.g. `symbol:PaymentService` Replace/Extend) into a SQLite ledger in `.git`; `declared_overlaps`, `detect_pair`, Jaccard over tokenized summaries | Declared, not derived from code | Advisory; "never locks a file or blocks an agent" | Yes (src/mcp.rs) | v0.7.0 "pre-1.0 local-first MVP"; README says "Published benchmark results do not yet exist". Deterministic, no LLM. |
| [Weave](https://github.com/Ataraxy-Labs/weave) | MIT/Apache-2.0 | about 1.4k (observation date not recorded) | Entity-level merge driver on tree-sitter (about 38 languages incl. TypeScript); `weave_check` cross-file (rename in a.py with surviving caller in b.py) | Yes (entity-level) | Advisory `weave-crdt` claims | Yes (`weave-mcp`) | Self-reported: synthetic 31 scenarios/7 languages (weave 29/29 mergeable, Mergiraf 26/29, git 15/29); replay of first 500 merge commits from 5 repos: 344 wins across 4,971 file merges, 86 regressions (git clean, weave conflicts). Not peer reviewed. |
| [CodeCRDT](https://arxiv.org/abs/2510.18893) | paper, no code link found | arXiv Oct 2025 | CRDT shared state, not a detector | No | n/a | n/a | 600 trials (6 tasks x 50 runs/mode); up to 21.1% speedup, up to 39.4% slowdown; 100% convergence, zero merge failures, but "semantic conflict rate of roughly 5-10%". |
| Rosentic, Conflux/cflx | n/a | Rosentic action 10 stars, pushed 2026-09-06 | Rosentic: GitHub Action checking PRs against all open PRs; Conflux: `git merge-tree` per a search snippet | UNVERIFIED | UNVERIFIED | UNVERIFIED | Surfaced by search only, mechanisms not read in code. UNVERIFIED. |

How Switchyard compares (inference from the notes):
- Textual `merge-tree` is the consensus baseline (clash, git-parsec, mergelock, Switchyard). Differentiation sits above it: semantic (grove, mergelock, Weave) or intent (foremerge).
- Switchyard's check is a superset of clash and git-parsec and roughly matches grove and mergelock in layers. It lacks grove's dependency and schema layers and mergelock's `signature_caller` and `duplicate_definition` rules.
- The recorded, commit-pinned test gate (`fleet validate`), `fleet undo` and PID-locked state have no counterpart in the tools surveyed (per the notes' survey, which did not read every tool exhaustively).
- None of the detectors publishes precision or recall. Efficacy claims for any detector are unmeasured.
- The notes describe Switchyard's check as a CLI/MCP read-only model; clash runs its check inside an agent hook before each write, which the notes call a stronger guarantee than before-merge.
- Weave's own third-party critique (a DEV post seen only as a search snippet, UNVERIFIED) says entity-level merge does not catch rename-vs-new-caller by default.

## 4. Papers

Most entries were read from the arXiv abstract or HTML page only. Where a figure is not on the page, it is stated as "not on page".

### 4.1 Agent coordination and conflict studies

**CAID, "Effective Strategies for Asynchronous Software Engineering Agents" (Geng & Neubig, [arXiv 2603.21489](https://arxiv.org/abs/2603.21489), v1 Mar 2026, v2 Jul 2026).**
- What it does: central manager builds a dependency graph of subtasks, one git worktree per engineer agent, merges each branch when done, verifies integration with executable tests. Ablation (per the OpenHands blog): removing worktree isolation drops performance significantly; adding agents helps only up to the width of the dependency graph.
- Numbers disagree between sources. arXiv abstract: +25.6% (PaperBench) and +14.7% (Commit0) absolute over single-agent. [OpenHands blog](https://www.openhands.dev/blog/asynchronous-software-engineering-agents): +26.7% and +14.3%. The notes suspect v1 vs v2 but did not confirm it. Quote the arXiv v2 abstract and note the discrepancy. Cost and wall-clock: neither page reports figures.
- Code: [JiayiGeng/CAID](https://github.com/JiayiGeng/CAID) (80 stars per `gh api`, last push 2026-04-02; not read).
- Versus Switchyard: same architecture (worktree per agent, branch merge, test gate). CAID's manager plans by dependency; Switchyard observes what agents touched and flags collisions. Benchmarks are Commit0/PaperBench, not SWE-bench.

**CooperBench (Khatua et al., [arXiv 2601.13295](https://arxiv.org/abs/2601.13295), Jan 2026; [code](https://github.com/cooperbench/CooperBench), 36 stars, pushed 2026-10-18).**
- 652 tasks, 12 libraries, 4 languages; two agents each implement a different feature; success needs both features to pass after merge. Merge ladder: `git merge-file`, then union merge, then a LoRA-tuned Qwen2.5-Coder-0.5B resolver.
- Pooled Solo vs Coop success counts 1039 vs 558 (retention 0.59). Scaling on 46 tasks: 68.6% (2 agents), 46.5% (3), 30.0% (4). Merge success avg, no communication: naive 8.64 / union 16.87 / LLM resolver 17.64; with communication: 10.71 / 15.97 / 17.14. A first-turn plan message: conflict rate 29.4% vs 51.5% without. Failure symptoms among failed coop runs: work overlap 33.2%, divergent architecture 29.7%, repetition 14.7%, unresponsiveness 8.7%.
- Sources differ on the headline: the abstract page says about 30% lower success for coop vs solo; an intro snippet says GPT-5 and Sonnet 4.5 get about 25% coop, about 50% below solo. Per-model figure is in Fig. 3, not read.
- Versus Switchyard: the naive/union/LLM ladder is a ready baseline set; a reviewer may ask why Switchyard is not evaluated on CooperBench.

**Xu, Subramanian, Karthik, "AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates" ([arXiv 2607.04697](https://arxiv.org/abs/2607.04697), Jul 2026).**
- Built on AIDev-pop (33,596 PRs, 2,807 repos). 40.2% of repos contain exactly-overlapping co-active agent PR pairs (79.4% of agent PRs); 53.4% of repos / 95.0% of PRs under a one-week window; only 0.5% of co-active pairs are cross-agent (122 repos).
- Replayed three-way merges on 747 unique pairs: textual conflict 41.7% cross-agent vs 19.8% intra-agent (non-overlapping 95% CIs); 84.4% of conflicted files are source code; "nearly 42%" of conflicts structural (modify/delete or add/add). Replication package [Zenodo](https://doi.org/10.5281/zenodo.21186464) (contents UNVERIFIED). Per-arm sample sizes not read.
- Versus Switchyard: textual only; supports first-class modify/delete handling. Cross-agent pairs are rare in the wild, so AIDev measures a lower bound of relevance for a one-operator, many-agents setup.

**AgenticFlict (Ogenrwot & Businge, [arXiv 2604.03551](https://arxiv.org/abs/2604.03551), accepted AIware 2026).**
- 142K+ PRs from 59K+ repos, 107K+ processed through deterministic merge simulation, 29K+ with conflicts, conflict rate 27.67%, 336K+ fine-grained conflict regions; five agents with "noticeable variation" (per-agent numbers not on abstract page). Data: [Zenodo](https://doi.org/10.5281/zenodo.19396916) (not opened).
- Versus Switchyard: ground truth for the textual layer, not a semantic detector.

**Passes Alone, Fails Together (Xia, Wu, Park, [arXiv 2609.25396](https://arxiv.org/abs/2609.25396), Sep 2026, EXPRESS 2026 workshop).**
- Runs tests on each patch alone and combined, counting only combination-induced failures. Tiers: synthetic interface changes; 417 mined Django merged-PR pairs; constructed tasks around 12 Django helpers.
- 834 runs on mined pairs: one showed interference after grading was corrected. Constructed tasks: 97% interference. A message describing the completed concurrent change recovered 82% of runs. The authors say constructed rates should not be read as real-world frequencies. No code link found.
- Versus Switchyard: the direct motivation for a symbol filter and a validate gate, and an honest warning about injected-conflict realism.

**AgentRoom (Cho & Lee, [arXiv 2608.23740](https://arxiv.org/abs/2608.23740), v1 Aug 2026, v2 Nov 2026, accepted NeurIPS 2026).**
- CRDT-merged shared filesystem with file-level claim, status and broadcast exposed as MCP tools. Claims "coordination, not parallelism or CRDT-merge, is the key design choice." 5 frontier coding CLIs, 4 backend tasks, plus Python DevBench and Rust+axum checks. Abstract page gave no exact numbers, cost or code link. A search snippet says parallel-merge did worse than a single agent (UNVERIFIED beyond that).
- Versus Switchyard: near-identical MCP surface, but claims prevent at write time (pessimistic), Switchyard detects before merge (optimistic).

**STORM, "Multi-agent Collaboration with State Management" (Liu et al., [arXiv 2605.20563](https://arxiv.org/abs/2605.20563), May 2026).**
- Mediates access to the shared codebase; conflicts detected and resolved at write time; argues per-agent worktrees defer to costly post-hoc merge. +18.7 on Commit0-Lite and +1.4 on PaperBench vs a git-worktree baseline; 87.6 (Commit0) and 78.2 (PaperBench) combined with single-agent runs; cost "comparable or better", no figures. A search snippet mentions disjoint primary file sets and a direct-conflict vs stale-dependency distinction; not confirmed in the fetched abstract (UNVERIFIED).
- Versus Switchyard: an explicit worktree baseline; "stale dependency" is the class a symbol filter targets.

**ATM, CID-Brokered Pre-Write Admission (Eagl Huang, [arXiv 2607.00041](https://arxiv.org/abs/2607.00041), Jun 2026; code [AI-Atomic-Framework](https://github.com/eaglhuang/AI-Atomic-Framework) v0.9.0-alpha.1).**
- Atoms (functions, class methods, qualified symbols, JSON keys), seven-layer gate with verdicts parallel-safe / needs-physical-split / SERIAL / blocked; neutral steward with base-hash CAS. Evaluation: 12-scenario design matrix, ATM-AdmissionBench v0.2 (20 scenarios, 42 mode-level comparisons), 3 archived same-file field cases, 3-week external-adopter study; no head-to-head benchmark; does not guarantee semantic correctness. Single-author preprint, weak evidence. Notes read only the first about 100K of 218K characters.

**AIDev (Li, Zhang, Hassan, [arXiv 2602.09185](https://arxiv.org/abs/2602.09185), Feb 2026).** 932,791 agent PRs, 116,211 repos, 72,189 developers; Codex, Devin, Copilot, Cursor, Claude Code; curated AIDev-pop 33,596 PRs / 2,807 repos (>100 stars). Natural corpus for a replay evaluation. Per-agent merge rates quoted by an aggregator (Human 76.8%, Codex 64%, Devin 49%, Copilot 35%, Cursor 51.4%, Claude Code 52.5%) are UNVERIFIED ([Emergent Mind](https://www.emergentmind.com/topics/aidev-dataset)).

**Best-of-N (different parallelism, no merge conflicts).** CodeMonkeys ([arXiv 2501.14723](https://arxiv.org/html/2501.14723v1)): 69.8% coverage, 57.4% resolved on SWE-bench Verified at roughly $2,300, random selection 45.8% (relayed by search summary, UNVERIFIED against paper text). Trae Agent ([arXiv 2507.23370](https://arxiv.org/html/2507.23370v1)), Agentic Rubrics, SWE-Master, PhoenixRepair, R2E-Gym verifier: listings only, UNVERIFIED. CAID, STORM and AgentRoom pages report no dollar or wall-clock figures.

**A blog claim not to cite.** A secondary post ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)) gives "33,596 PRs ... content conflicts 57.6%, add/add 15.1%". It could not be opened (ECONNRESET) in one note, and another note says its 41.7% vs 19.8% figure matches the paper while its other claims were not checked. The 57.6% and 15.1% figures are UNVERIFIED.

### 4.2 Semantic-conflict detection

All Borba-group datasets are Java. No TypeScript/JavaScript dataset was found.

- **Barbosa et al., unit-test generation with LLMs ([arXiv 2507.06762](https://arxiv.org/abs/2507.06762), Jul 2025).** Code Llama 70B test generator added to SMAT. 79 scenarios from 29 Java projects (29 with semantic conflicts, 50 without). Union of 8 configurations found 5 conflicts; Differential EvoSuite 6, EvoSuite 5 (1 FP), Randoop 2; 0% false positives for the LLM approach; the notes' derived recall is about 17% (5/29), not stated by the authors. Generation took 6h05m-27h45m per configuration, 132h32min combined, about 21x less efficient than EvoSuite; compile rate 6.82-12.04%. Page text read was Portuguese (v2). Too slow for a pre-merge gate.
- **Barbosa et al., pointer analysis ([arXiv 2507.20081](https://arxiv.org/html/2507.20081), Jul 2025).** MergeDataset 99 labeled units (54 scenarios, 32 Java systems). On 93 units: no pointer analysis precision 0.47 / recall 0.28 / F1 0.35 / accuracy 0.68 (TP 8, FP 9, TN 55, FN 21); with pointer analysis precision 0.29 / recall 0.07 / F1 0.11 / accuracy 0.66. Timeouts on RefDataset: 35 without vs 2 with. Mean runtime MergeDataset 6.47 s (PA) vs 38.81 s (noPA), not significant (p=0.603). Lesson in the notes: the more precise analysis cut recall.
- **RefFilter (Lira, Borba et al., [arXiv 2510.01960](https://arxiv.org/html/2510.01960v1), Oct 2025).** Removes alerts caused by behavior-preserving refactorings. 99-scenario benchmark: baseline precision 0.319 / recall 0.536 / F1 0.400 (TP 15, FP 32, FN 13, TN 39); with filter 0.389 / 0.500 / 0.438 (TP 14, FP 22, FN 14, TN 49); false positives down "nearly 32%". Filter runtime median 9.1 s, mean 168 s (excludes the analysis itself). Renames are the likely false-positive source for a Switchyard symbol filter.
- **Santos et al., "Comparing static analyses for improved semantic conflict detection" (Automated Software Engineering 33(2), DOI 10.1007/s10515-025-00580-y; [author page](https://www.cin.ufpe.br/~mbo2/publications/ase2025/)).** 32 real projects, manually labeled; claims the combination beats earlier methods. Exact figures not read (PDF unparseable). Precursor [arXiv 2310.04269](https://arxiv.org/html/2310.04269) not read.
- **Shen, Gulzar, He, Meng, TOSEM 32(2) 2023 ([VT page](https://vtechworks.lib.vt.edu/handle/10919/112057)).** 208 Java repos, 538 conflicts inspected; textual, build and test conflicts. Older baseline.
- **Bucond** (static build-conflict detector, Java): 100% precision and 88-100% recall per a search snippet only ([NSF PAR](https://par.nsf.gov/biblio/10429739-detecting-build-conflicts-software-merge-for-java-programs-via-static-analysis)); paper not opened, UNVERIFIED. Closest classical analogue to the symbol filter.
- **Latency.** No peer-reviewed latency benchmark for TypeScript pre-merge impact gates was found. TypeScript tools (pr-impact, blast-radius, Ripple, code-impact-mcp) report no latency. Reference points: Java static interference 7.3-38.8 s mean per unit; RefFilter median 9.1 s; LastMerge 80.2% of scenarios under 3 s under a conservative assumption.

### 4.3 Structured merge

- **LastMerge (Duarte, Borba, Cavalcanti, [arXiv 2507.19687](https://arxiv.org/abs/2507.19687v1), Jul 2025).** Language-agnostic structured merge via tree-sitter (per search result, not the abstract). 5,229 Java scenarios (13,675 mutually modified files). Added FPs/FNs: LastMerge 130/85 vs jDime 153/29; Mergiraf 290/62 vs Spork 150/107. Abstract: 15% fewer FPs than jDime; Mergiraf 42% fewer FNs than Spork. Order-of-magnitude speedups; 80.2% of scenarios integrated under 3 s under a conservative 10x Java-to-Rust penalty assumption.
- **Mergiraf** ([Codeberg](https://codeberg.org/mergiraf/mergiraf), GPLv3, tree-sitter, many languages incl. TypeScript). Repo and README not opened; the fetched page does not mention AI agents; no evidence found of agent tools integrating it. GPL means shell out only, never link (the notes' recommendation).
- **Weave:** see section 3.
- Older baselines, not opened, details UNVERIFIED: jDime, Spork, IntelliMerge, Sesame; semistructured merge with syntactic separators ([arXiv 2407.18888](https://arxiv.org/html/2407.18888v1), not read).
- Both Mergiraf and Weave operate per file during merge. Neither is described as reporting "agent B's file references agent A's deleted symbol", which is the Switchyard niche (inference).

### 4.4 LLM merge-resolution benchmarks

These evaluate resolution, not prediction. They are useful for methodology pitfalls.

- **Merge-Bench (Schesch & Ernst, [arXiv 2605.25890](https://arxiv.org/abs/2605.25890), May 2026; ICPR 2026 per UW page).** 7,938 conflict hunks, 1,439 repos, ground truth the developer-committed resolution, hunks capped at 20 lines / 512 tokens (leaderboard summary). Best models resolve under 60%.
- **SWE-Git-Bench (Zhang et al., [NeurIPS 2026 poster page](https://neurips.cc/virtual/2026/poster/139812), listed as Dec 2026, which is after this document's date; code [zwpride/SWE-Git-Bench](https://github.com/zwpride/SWE-Git-Bench) not opened).** 135 conflicts / 185 file examples / 23 repos from real two-parent merges in SWE-bench-family pools; 36 LLM endpoints: best whole-file exact match 26.5%, oracle union 41.6%; human audit: 40 of 80 high-similarity non-exact outputs likely unsafe.
- **ConGra ([arXiv 2409.14121](https://arxiv.org/abs/2409.14121), 2024).** 44,948 conflicts; later criticized because "correct" means any similarity metric above 80%.
- **GitGoodBench** (JetBrains, REALM 2025; [ACL preview](https://preview.aclanthology.org/corrections-2025-08/2025.realm-1.19.pdf), not read in full) and **ConflictBench** (VT thesis, May 2025, 180 Java scenarios, [VT](https://vtechworks.lib.vt.edu/items/b334adc4-e7f4-4740-89f3-31009149bec5), snippet only).
- MergeBERT, MergeGen, Gmerge, sMerge: not opened, UNVERIFIED.
- No dataset built by perturbing SWE-bench tasks to create semantic conflicts was found, and no 2025-2026 LLM prediction (not resolution) paper was found.

## 5. Worktree fleet orchestrators

Stars and push dates from `gh api repos/<r>` on 2026-11-16; code read from shallow clones; closed-source tools from docs. Detectors are in section 3.

| Tool | Lang | Stars / last push | Isolation | Pre-merge conflict detection | Setup-cost handling | Merge workflow | MCP |
|---|---|---|---|---|---|---|---|
| [claude-squad](https://github.com/smtg-ai/claude-squad) | Go | 8,819 / 2026-11-13 | worktree + tmux | none found (grep of session/) | none | commit+push branch, checkout/pause | no |
| [Nimbalyst](https://github.com/Nimbalyst/nimbalyst) (ex-[Crystal](https://github.com/stravu/crystal)) | TS | Crystal 3,128 / 2026-02-26, README "Deprecated: February 2026"; Nimbalyst pushed 2026-11-15 | worktree | none found | UNVERIFIED | AI-drafted commits, git UI | has packages/cli; MCP not stated |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Rust + TS | 28,709 / 2026-11-15; README "sunsetting" (reasons UNVERIFIED) | worktree | none; post-hoc only (`detect_conflict_op`, `get_conflicted_files`, `abort_conflicts`) | `setup_script`, `copy_files`, `dev_server_script`, `cleanup_script` | PR/merge, abort conflicts | yes (kanban task server) |
| [container-use](https://github.com/dagger/container-use) | Go | 4,094 / 2026-11-14 | Dagger container + branch `container-use/<id>` | none found (only `merge-base --is-ancestor`) | container env | `git merge --no-ff --autostash` or `--squash` | yes (core, `container-use stdio`) |
| [uzi](https://github.com/devflowinc/uzi) | Go | 584 / 2025-06-04 (stale over 5 months) | worktree + tmux | none in README | `devCommand` with `$PORT`, `portRange: 3000-3010` | checkpoint/merge | no |
| [ccmanager](https://github.com/kbwo/ccmanager) | TS | 1,279 / 2026-10-27 | worktree + PTY | none found | `.worktreeinclude`, hooks, session copy, devcontainer | merge worktree in UI | no |
| [worktrunk](https://github.com/max-sixty/worktrunk) | Rust | 12,567 / 2026-11-16 | worktree | none; rebase errors only | hooks (pre/post-commit, pre/post-merge, post-start), `hash_port`, `wt step copy-ignored` (copy-on-write on APFS/btrfs/XFS) | `wt merge` squash/rebase | not found (UNVERIFIED) |
| [git-worktree-runner](https://github.com/coderabbitai/git-worktree-runner) (gtr) | Shell | 1,816 / 2026-11-10 | worktree | none | `gtr.copy.include`, `gtr.hook.postCreate`, trust gating of hooks | PR helper | no |
| [par](https://github.com/coplane/par) | Python | 142 / 2026-02-19 | worktree + tmux | none | none | manual | no |
| [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) | Shell/Py | 923 / 2026-09-21 | single shared directory (per README) | none; prompt-followed lock files in `/coordination/agent_locks/` | stack setup scripts | n/a | no |
| [Sculptor](https://github.com/imbue-ai/sculptor) | Python | 246 / 2026-11-16 | "isolated copy of your code"; research preview | README does not describe one (UNVERIFIED beyond README) | UNVERIFIED | merge back to main | UNVERIFIED |
| [GitButler](https://github.com/gitbutlerapp/gitbutler) | Rust | 21,967 / 2026-11-16 | virtual branches in one working dir | n/a; hunk-dependency tracking (crate list only read) | none | native | yes (`but mcp serve`) |
| [OpenHands](https://github.com/OpenHands/OpenHands) | TS | 93,597 / 2026-11-16 | parallel-run behavior not investigated | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Claude Code built-in worktrees ([doc](https://code.claude.com/docs/en/worktrees.md)) | n/a | docs | `.claude/worktrees/<name>`, branch `worktree-<name>` | none | `.worktreeinclude`, `WorktreeCreate`/`WorktreeRemove` hooks; `worktree.baseRef` fresh/head | none built in | n/a |
| Claude Code agent teams ([doc](https://code.claude.com/docs/en/agent-teams.md)) | n/a | experimental | shared task list, mailbox | none; advice only ("each teammate owns a different set of files") | n/a | n/a | n/a |
| Cursor ([doc](https://cursor.com/docs/configuration/worktrees)) | n/a | docs | worktree | none documented | `.cursor/worktrees.json`; `worktreeMaxCount` default 25 | `/apply-worktree`; `/best-of-n` compares, no merge | n/a |
| Conductor ([docs](https://www.conductor.build/docs/)) | n/a | closed source | workspace per task; whether git worktrees is UNVERIFIED | UNVERIFIED | UNVERIFIED | review diff, PR, merge, archive | UNVERIFIED |

Not researched, UNVERIFIED: Codex cloud best-of-N, Jules, Amp.

Features that recur across these tools and that the notes say Switchyard lacks (based on the task description, not a source diff): setup hooks, copy lists and port allocation; pre-write hook integration; intent or scope claims; merge-order suggestion (grove); stale-worktree cleanup caps (Cursor `worktreeMaxCount`, Claude's sweep); PR creation.

Observations: the commodity worktree managers sit at 1k-28k stars while detectors sit under 70 stars (foremerge, 438, is the exception), so demand in the survey is in orchestration UX, not detection (stars are a weak proxy). UI-first products are the churn zone (Crystal deprecated, Vibe Kanban sunsetting).

## 6. cortexai: routing research, gateways, streaming-spec checklist

The cortexai code was not read for these notes. Comparisons use only the task description: small Python FastAPI OpenAI-compatible gateway, SSE streaming, Anthropic/OpenAI/local-transformers providers, `len(text)//4` token estimates, no router.

### 6.1 Routing research

- **RouteLLM** (LMSYS; [arXiv 2406.18665](https://arxiv.org/abs/2406.18665)): routers trained on preference data choose a strong or weak model; abstract claims cost savings "over 2 times in certain cases" with no quality loss. Per-router numbers not read. The note's search summary says ICLR 2025 (UNVERIFIED).
- **RouterArena** (Rice, ICLR 2026; [arXiv 2510.00202v3](https://arxiv.org/html/2510.00202v3)): 12 routers, about 8,400 queries, 23 datasets. GPT-5 74.0% at $14.02 per 1k queries; Azure-Router 68.1% at $0.54; vLLM-SR 67.3% at $1.67; CARROT 67.2% at $2.06; MIRT-BERT 66.9% at $0.15. vLLM-SR and CARROT cut cost roughly 35% vs each router's best model with under 2% accuracy loss. No router exceeded GPT-5 accuracy. Hard queries: MIRT-BERT 7.1%, CARROT 9.0% vs GPT-5 27.5%. Robustness "uniformly low". vLLM-SR and RouteLLM were slow because they call the OpenAI embedding API; others under 100 ms on an A100.
- **LLMRouterBench** ([arXiv 2601.07206](https://arxiv.org/abs/2601.07206), Jan 2026): over 400K instances, 21 datasets, 33 models, 10 baselines. Many routers perform similarly; several recent ones, including commercial ones, do not reliably beat a simple baseline.
- **Arch-Router** (Katanemo, [arXiv 2506.16655](https://arxiv.org/abs/2506.16655)): 1.5B model maps a query to a user-written preference (domain or action) then to a model; no numbers on the abstract page.
- **Local plus cloud.** Token-level (ACL 2025 demo, [arXiv 2504.07878](https://arxiv.org/html/2504.07878v1)): routing 7% of tokens to the LLM gave over 60% accuracy improvement and over 80% cost reduction on CommonsenseQA (search summary, not read in paper). Protocol-level (Narayan et al., ICML 2025, [listing](https://mlanthology.org/icml/2025/narayan2025icml-costefficient)): 30.4x cloud cost reduction, 87% of frontier performance (search-summary numbers). Confidence-driven routing ([arXiv 2502.11021](https://arxiv.org/html/2502.11021v1)): savings not retrieved. ConsRoute ([arXiv 2603.21237](https://arxiv.org/pdf/2603.21237)): at least 95% of cloud performance, nearly 40% lower latency and cost (search summary only).
- **Coding-agent routing (2026, search summaries, not read in full, UNVERIFIED numbers):** SWE-Router ([alphaxiv 2607.00053](https://www.alphaxiv.org/abs/2607.00053)); TwinRouterBench ([arXiv 2605.18859](https://arxiv.org/abs/2605.18859)), where a single-template LLM router predicts "high" for only 7 of 147 verified-high steps; Triage ([arXiv 2604.07494](https://arxiv.org/html/2604.07494)).
- **Vendor claim, not independent:** Not Diamond Code, 39% cost cut on Poly-SWE-Bench Verified ([blog](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)).
- Not fetched, UNVERIFIED: FrugalGPT, Hybrid LLM, AutoMix, RouterBench, GraphRouter, MixLLM, RouterEval.

Comparison with cortexai (no router): independent benchmarks do not show learned routers beating a strong single model, so having no router is a defensible position. See adoption items in section 8.

### 6.2 Gateways and serving servers

| Project | Routing / failover | Streaming and usage behavior | Source |
|---|---|---|---|
| LiteLLM Router | strategies `simple-shuffle` (default), `usage-based-routing-v2`, `latency-based-routing`, `least-busy`, `cost-based-routing`, custom; `order`, then `fallbacks`; `context_window_fallbacks`; `enable_pre_call_checks`; `max_fallbacks` default 5; cooldown default 5 s, 429 cools immediately, over 50% failures in a minute trips cooldown, 401/404/408 also cool down | `MidStreamFallbackError` carries `generated_content` so a fallback model continues (mirror commit and search summary; reported open issues UNVERIFIED); `REPEATED_STREAMING_CHUNK_LIMIT` default 100 | [routing docs](https://docs.litellm.ai/docs/routing), [stream docs](https://docs.litellm.ai/docs/completion/stream) |
| OpenRouter | provider routing | SSE comment keepalives (`: OPENROUTER PROCESSING`); usage in the last chunk before `[DONE]`; pre-commit errors are HTTP errors (400/401/402/429/502/503); post-commit errors are an SSE chunk with top-level `error` and `finish_reason: "error"` after HTTP 200 | [streaming docs](https://openrouter.ai/docs/api-reference/streaming) |
| llama.cpp server | none | usage and timings in the final chunk (differs from OpenAI); later change (#16052) emits usage only when `stream_options.include_usage` is set; whether tool-call streams always end with usage: not confirmed | [issue 15443](https://github.com/ggml-org/llama.cpp/issues/15443) |
| vLLM | none | docs page read did not cover `include_usage` or `continuous_usage_stats`; `parallel_tool_calls=false` returns zero or one tool call; `user` ignored | [docs](https://docs.vllm.ai/en/latest/serving/online_serving/) |
| llama-swap | routes on the request `model` field; swaps processes; `matrix` keeps several loaded; per-model `ttl` | sets `X-Accel-Buffering: no`; `/metrics`, `/running`, `/health`; proxies `v1/messages/count_tokens` | [README](https://github.com/mostlygeek/llama-swap) |
| vLLM Semantic Router | embedding-based router | RouterArena lists it as slow due to embedding API calls | [arXiv 2510.00202v3](https://arxiv.org/html/2510.00202v3) |

Not read, UNVERIFIED: Portkey, Helicone, Kong, Envoy AI Gateway, Ollama OpenAI endpoint, SGLang, LocalAI, API7 AISIX (mid-stream fallback, [docs](https://docs.api7.ai/ai-gateway/routing/mid-stream-fallback)). LiteLLM source for stream usage was not read, only docs and snippets.

Gaps versus LiteLLM/OpenRouter, per the notes' inference: retry/cooldown/fallback across providers, context-window pre-check, mid-stream error chunk format, SSE keepalive comments, local-model residency control.

### 6.3 Streaming-spec checklist

The official OpenAI API reference returned 403 and the openai-python types fetch failed (ECONNRESET), so items marked secondary rest on community posts and other providers' docs.

1. Format: SSE `data:` lines ending with `data: [DONE]` (confirmed in secondary sources).
2. Usage chunk: only when `stream_options.include_usage` is true; one extra chunk before `[DONE]` with `usage` totals and `choices` always `[]`; all other chunks carry `usage: null`; finish_reason is on the second-to-last chunk; an interrupted stream may never deliver the usage chunk ([OpenAI community post](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156), [LiteLLM usage docs](https://docs.litellm.ai/docs/completion/usage)).
3. First chunk carries `delta: {role: "assistant"}`: UNVERIFIED (general practice, official text not retrieved).
4. `finish_reason: "length"` for token-limit stops; `"error"` is an OpenRouter extension, not core OpenAI.
5. Error after the first byte: a chunk with top-level `error` and `finish_reason: "error"`, then `[DONE]` (OpenRouter pattern). Error before the first byte: a normal HTTP error status or silent fallback.
6. Keepalive: comment lines starting with `:` during slow local warmup; clients must tolerate them.
7. Client disconnect is the cancellation signal; cancel the upstream request and finalize billing. Server-side disconnect handling in FastAPI/Starlette (e.g. `request.is_disconnected()`) was not read.
8. Anthropic adapter: usage arrives in `message_delta` before `message_stop` (per OpenRouter's description of the Messages API); translate it into the OpenAI usage chunk.
9. Test with the official `openai` Python client with and without `stream_options` (inference: it is the strictest consumer).

### 6.4 Token counting

- Anthropic `POST /v1/messages/count_tokens`: free, rate limits 5,000 / 10,000 / 20,000 RPM for Start / Build / Scale tiers, returns an estimate that may include system-added tokens that are not billed; docs say Claude 4.7 and later use a newer tokenizer producing about 30 percent more tokens for the same text ([docs](https://platform.claude.com/docs/en/build-with-claude/token-counting)).
- No measured accuracy for `len//4` was found. Secondary blogs conflict: tiktoken 10-30% below Anthropic's billed count in one, 20-50% error for Claude in another; code and structured text show the largest gaps ([markaicode](https://markaicode.com/vs/tiktoken-vs-anthropic/), [dev.to](https://dev.to/gabrielanhaia/tokenizer-quirks-claude-gpt-and-gemini-dont-count-the-same-text-the-same-way-1522)). Not verified independently.
- tiktoken and HF tokenizer docs, and OpenAI and Gemini count endpoints, were not checked.

## 7. Related work a preprint reviewer will expect

"Verified" here means the notes read the arXiv abstract or HTML page or the project README/code; it does not mean full-paper review. "Unverified" means search snippet, listing, or background knowledge only.

**Agent conflict studies and coordination**
- Verified (abstract/HTML): CooperBench 2601.13295; Xu et al. 2607.04697; AgenticFlict 2604.03551; Passes Alone, Fails Together 2609.25396; CAID 2603.21489; STORM 2605.20563; AgentRoom 2608.23740; AIDev 2602.09185; CodeCRDT 2510.18893.
- Partly verified: ATM 2607.00041 (first about 100K of 218K characters read).
- Unverified: other AIDev-based studies (2607.21832, 2605.22534, 2602.00164); multi-vocal review 2604.16321. Surveys cited by title only: He, Treude, Lo (TOSEM 2025, 2404.04834); Guo et al. 2510.09721; Tang & Runkler 2601.09822.

**Semantic-conflict detection (Borba group and others)**
- Verified (abstract/HTML): 2507.06762 (SMAT with LLM tests); 2507.20081 (pointer analysis); 2510.01960 (RefFilter).
- Partly verified: Santos et al., Automated Software Engineering 33(2) (exact figures not read); Shen et al., TOSEM 2023 (VT page only).
- Unverified: Bucond (snippet only); ICSE 2024 precursor 2310.04269 (not read).
- Canonical baselines cited from background knowledge only, venue metadata UNVERIFIED: Crystal (Brun, Holmes, Ernst, Notkin, FSE 2011); SafeMerge (Sousa, Dillig, Lahiri, OOPSLA 2018); Palantir (Sarma, Redmiles, van der Hoek, TSE 2012); WeCode (Guimaraes & Silva, ICSE 2012); original SMAT (Da Silva, Borba et al., 2020). A later Crystal-related reference ([ar5iv 2102.11307](https://ar5iv.labs.arxiv.org/html/2102.11307), "Are We There Yet?") appeared in a search result.

**Structured merge**
- Verified (abstract/HTML): LastMerge 2507.19687. Page-level only: Mergiraf (Codeberg), Weave (README).
- Unverified: jDime (Apel et al. ASE 2012; Leßenich et al. ASE 2015), Spork (Larsen et al., EMSE 2022), IntelliMerge (Shen et al., OOPSLA 2019), semistructured merge 2407.18888, Sesame.

**LLM merge resolution**
- Verified (abstract/page): Merge-Bench 2605.25890; SWE-Git-Bench (NeurIPS 2026 page); ConGra 2409.14121.
- Partly verified: GitGoodBench (REALM 2025, not read in full); ConflictBench (snippet only).
- Unverified: MergeBERT (Svyatkovskiy et al., 2022), MergeGen, Gmerge, sMerge.

**Parallel agents, best-of-N and routing**
- Verified (abstract/HTML): CodeMonkeys 2501.14723 (figures via search summary); RouteLLM 2406.18665; RouterArena 2510.00202v3; LLMRouterBench 2601.07206; Arch-Router 2506.16655.
- Unverified (summary or listing only): Trae Agent 2507.23370; Agentic Rubrics 2601.04171; SWE-Master 2602.03411; PhoenixRepair 2607.18859; R2E-Gym verifier 2504.07164; Dockerless verifier (EMNLP 2026); SWE-Router; TwinRouterBench; Triage; ConsRoute; confidence routing 2502.11021; token-level and protocol-level local+cloud papers; FrugalGPT, Hybrid LLM, AutoMix, RouterBench, GraphRouter, MixLLM, RouterEval.

**Tools**
- Verified in code or README: clash, git-parsec, grove, mergelock, foremerge, claude-squad, vibe-kanban, container-use, worktrunk, ccmanager, gtr, uzi, par, agent_farm, Sculptor (README only), GitButler (crate list only), Claude Code and Cursor (docs).
- Unverified: Rosentic, Conflux/cflx, Conductor internals, OpenHands parallel runs, Nimbalyst conflict handling.

## 8. What to adopt, ranked

Each item is tied to its source. Ranking follows the notes' value-over-cost inferences, then the evaluation items. These are the notes' recommendations, not tested results.

Switchyard

1. Pre-write hook running `fleet check` for Claude Code (clash `PreToolUse` on `Write|Edit|MultiEdit`). Source: [clash hooks.json](https://github.com/clash-sh/clash/blob/main/plugins/clash/hooks/hooks.json). The notes rank this top for value/cost.
2. Keep "unknown" distinct from "clean". Source: clash reports detection errors with an `error` field and an empty file list ([conflict.rs](https://github.com/clash-sh/clash/blob/main/src/worktree/conflict.rs)).
3. Add `signature_caller` and `duplicate_definition` rules on top of the existing TS-AST filter. Source: [mergelock rules](https://github.com/sadayamuthu/mergelock/tree/main/internal/rules).
4. Refactoring-aware suppression of rename false positives. Source: RefFilter, precision 0.319 to 0.389, false positives down nearly 32% on Java ([arXiv 2510.01960](https://arxiv.org/html/2510.01960v1)). Expect different numbers on TypeScript.
5. Report both a precision-oriented and a recall-oriented mode. Source: Santos et al. (Automated Software Engineering 33(2)); the Borba results show higher precision of analysis cut recall (0.28 to 0.07).
6. Per-spawn setup: a `.worktreeinclude`-style copy list, a post-create hook behind a trust gate, and a deterministic per-agent port variable (hash of agent name). Sources: [Claude Code worktrees doc](https://code.claude.com/docs/en/worktrees.md), [gtr](https://github.com/coderabbitai/git-worktree-runner) trust model, [worktrunk](https://github.com/max-sixty/worktrunk) `hash_port`. Compare against `packages/switchyard` first; the notes did not read what Switchyard does today.
7. Advisory scope or file claims in `.fleet/state.json` that `fleet check` consumes, non-blocking, optionally with a first-turn plan message. Sources: [foremerge](https://github.com/naw103/foremerge), [AgentRoom](https://arxiv.org/abs/2608.23740), CooperBench plan-message correlation (conflict rate 29.4% vs 51.5%, [arXiv 2601.13295](https://arxiv.org/html/2601.13295)). Avoid hard locks (foremerge: a crashed agent would stall the fleet).
8. Grove's dependency and schema layers, and merge-order suggestion. Source: [grove](https://github.com/NathanDrake2406/grove).
9. Notify an agent of a merged change that touches symbols it uses. Source: Passes Alone (a completed-change message recovered 82% of constructed-task runs, [arXiv 2609.25396](https://arxiv.org/abs/2609.25396)); the figure is from constructed tasks only.
10. Optional speculative typecheck or build tier as an oracle. Source: Crystal-style speculative merge (background reference, UNVERIFIED metadata).
11. Use Mergiraf for resolution by shelling out; do not link (GPLv3). Source: [Codeberg](https://codeberg.org/mergiraf/mergiraf). Notes found no evidence of agent tools integrating it.
12. Cap agents at the dependency-graph width. Source: CAID (OpenHands blog).
13. Stale-worktree cleanup that spares dirty trees, plus a worktree lock while an agent runs. Sources: Claude Code worktrees doc, Cursor `worktreeMaxCount`.

Avoid (per the notes): hard file locks; LLM-judged conflicts (foremerge's stance; the SMAT LLM-test approach took 132h32min combined, [arXiv 2507.06762](https://arxiv.org/abs/2507.06762)); symlinked dependencies (Cursor docs); hooks from repo config without a trust step; heavy desktop UI scope.

Evaluation (what the notes say a reviewer will want)

14. Ground truth by `tsc` or test failure after a clean `git merge-tree`; report precision, recall and F1 for the symbol filter alone, `merge-tree` alone and the union; latency p50 and p95. No TypeScript latency or dataset exists in the literature, so Switchyard must publish its own.
15. Datasets: replay AIDev/AgenticFlict pairs; build same-snapshot agent-patch pairs; consider CooperBench and the Passes Alone "stale" benchmark rather than only perturbed SWE-bench Lite. Explain why injected conflicts are realistic, given 1 interference in 834 mined runs.
16. Baselines: plain `git merge-tree`; Mergiraf; Weave `weave_check`; a same-file-touched heuristic (Palantir/WeCode style); a name-based import-graph filter; CooperBench's naive/union/LLM ladder; test-after-merge.
17. Wording: say "we found no" prior measurement of symbol-contract breakage on agent PRs, not "there is none".
18. Report tokens, dollars and wall-clock for N agents vs one; the notes found no coordination paper reporting them.

cortexai

19. Provider-reported usage as the billing source of truth; `len//4` only as a labeled pre-flight estimate; HF tokenizer for local models; tiktoken for OpenAI-family estimates; `count_tokens` for Claude only when a decision hinges on it. Source: [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/token-counting).
20. Emit the usage chunk only when `stream_options.include_usage` is set (`choices: []`, `usage: null` elsewhere). Sources: [OpenAI community post](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156), [llama.cpp issue 15443](https://github.com/ggml-org/llama.cpp/issues/15443).
21. Mid-stream failure: after first byte, error chunk with `finish_reason: "error"` then `[DONE]`; before first byte, fall back silently. Skip LiteLLM-style mid-stream continuation initially. Sources: [OpenRouter docs](https://openrouter.ai/docs/api-reference/streaming), LiteLLM.
22. On client disconnect, cancel upstream and bill from received usage, else from emitted text marked estimated.
23. A cooldown map (5 s default; trip on 429/401/408 and over 50% failure rate), about 30 lines per the notes. Source: [LiteLLM routing docs](https://docs.litellm.ai/docs/routing).
24. Rule-based routing before any learned router: route by task type, context length, privacy flag, with a virtual `auto` model name; escalate local to cloud on a confidence signal; bias default to the strong model; log per-request model, tokens and outcome. Sources: Arch-Router, RouterArena, LLMRouterBench, llama-swap.
25. SSE keepalive comments during local-model warmup; local router only (RouterArena: embedding-API routers add latency).

## 9. Unverified / could not open

Could not open or fetch:
- OpenAI official API reference (403); openai-python types file (ECONNRESET).
- codex.danielvaughan.com agent-PR conflict post (ECONNRESET); its 57.6% content-conflict and 15.1% add/add figures are UNVERIFIED and not to be cited.
- Vibe Kanban sunset announcement (SSL error); reasons and date UNVERIFIED.
- Santos et al. ASE-journal PDF (unparseable); exact figures not obtained.
- `stravu/nimbalyst` (404); code read under Nimbalyst/nimbalyst.
- Zenodo packages for 2604.03551 and 2607.04697; online appendices for 2507.20081, 2510.01960, 2507.19687 (anonymous.4open.science).

Opened as abstract only, details thin:
- CAID code internals; STORM file-set mechanics (snippet only); AgentRoom numbers and code; Passes Alone code link; CodeCRDT code link; CooperBench per-model Fig. 3; per-arm sample sizes in 2607.04697; ATM beyond about 100K of 218K characters.

Conflicts between sources (not resolved):
- CAID: arXiv abstract +25.6% PaperBench / +14.7% Commit0 vs OpenHands blog +26.7% / +14.3%.
- CooperBench: abstract page about 30% lower coop success vs intro snippet about 25% coop and about 50% below solo.
- Blog vs paper: 57.6% / 15.1% conflict figures not in the 2607.04697 abstract.
- Token estimation blogs: tiktoken 10-30% below billed vs 20-50% error for Claude.
- Date oddity: SWE-Git-Bench is listed as a Dec 2026 NeurIPS poster, after this document's date; taken as recorded in the notes, not checked.

Never investigated or search-snippet only:
- Tools: Rosentic, Conflux/cflx, Conductor internals, Codex cloud best-of-N, Jules, Amp, OpenHands parallel runs, Nimbalyst conflict handling, GitButler beyond the crate list, Sculptor beyond README, grove MCP, worktrunk MCP.
- Weave: star count has no observation date in the notes; benchmarks are self-reported; the third-party critique is a snippet.
- Mergiraf: no agent integration evidence found; repo not opened.
- Routing and gateways: all items in sections 6.1 and 6.2 marked UNVERIFIED; per-router RouteLLM numbers; Portkey, Helicone, Kong, Envoy AI Gateway, Ollama, SGLang, LocalAI; vLLM `continuous_usage_stats`; LiteLLM stream source.
- Latency: no peer-reviewed TypeScript pre-merge latency benchmark found.
- Switchyard-side claims: "lacks" statements rest on the task description; the notes did not diff against `packages/switchyard` or read cortexai code.
- Stars are a weak proxy for adoption; no usage data was gathered.
