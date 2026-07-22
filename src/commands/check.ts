import { existsSync } from 'node:fs';
import type { SimpleGit } from 'simple-git';
import { dim, fail, ok, plural, table } from '../lib/format.js';
import {
  branchExists,
  changedFilesVsBase,
  getMainRepoRoot,
  gitAt,
  supportsMergeTree,
  uncommittedFiles,
} from '../lib/git.js';
import { formatRanges, parseUnifiedDiff, rangesOverlap } from '../lib/lines.js';
import type { FileRanges } from '../lib/lines.js';
import { predictMergeConflicts } from '../lib/mergetree.js';
import { readState, worktreeAbsPath } from '../lib/state.js';
import type { AgentRecord } from '../lib/state.js';

export interface CheckOptions {
  /** Print machine-readable JSON instead of the table. */
  json?: boolean;
  /**
   * Line-level refinement: only count files where the agents' edited line
   * ranges actually overlap; report disjoint same-file edits separately.
   */
  lines?: boolean;
  /** Skip merge simulation entirely; flag any shared file (v0.1 behavior). */
  filesOnly?: boolean;
  cwd?: string;
}

export interface Collision {
  file: string;
  agents: string[];
  /**
   * --lines only: overlapping line ranges in merge-base coordinates, or
   * 'whole-file' when line info is unknowable (binary/untracked files, …).
   */
  overlap?: string;
  /** merge-tree mode only: why this shared file is still a collision. */
  verdict?: 'conflicts' | 'uncommitted';
}

export interface CheckResult {
  collisions: Collision[];
  /** --lines only: multi-agent files whose edits touch disjoint lines. */
  disjoint?: Collision[];
  /** merge-tree mode only: shared files whose committed changes auto-merge. */
  cleanMerges?: Collision[];
  /** Which detection semantics ran. */
  prediction: 'merge-tree' | 'files';
  agentsChecked: number;
  /**
   * Files each agent touched (committed vs base plus uncommitted), by name —
   * the raw material the collision cross-reference is computed from. Present
   * for any fleet size, including a single agent with nothing to collide with.
   */
  agentFiles: Record<string, number>;
}

/**
 * Compute the collision report without printing anything. Mirrors
 * `collectListings` in list.ts: callers that need the data rather than the
 * rendering — `--json`, and any transport where stdout is not free-form — use
 * this instead of `check()`.
 */
export async function collectCheck(options: CheckOptions = {}): Promise<CheckResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  const capable = await supportsMergeTree(git);
  const useMergeTree = capable && !(options.filesOnly ?? false);
  const prediction: 'merge-tree' | 'files' = useMergeTree ? 'merge-tree' : 'files';

  const agentsByFile = new Map<string, string[]>();
  // --lines only: file -> agent -> edited ranges (merge-base coordinates).
  const rangesByFile = new Map<string, Map<string, FileRanges>>();

  // merge-tree mode: simulation can't see uncommitted work, and can't run at
  // all when a branch is missing — both fail closed rather than silently clean.
  const uncommittedByAgent = new Map<string, Set<string>>();
  const unsimulatable = new Set<string>();
  const agentFiles: Record<string, number> = {};
  // Line ranges exist to intersect agents against each other; with fewer than
  // two there is nothing to intersect, so skip the diff parsing.
  const needRanges = (options.lines ?? false) && agents.length >= 2;

  for (const record of agents) {
    const files = new Set<string>();
    const uncommitted = new Set<string>();
    if (
      (await branchExists(git, record.branch)) &&
      (await branchExists(git, record.baseBranch))
    ) {
      for (const f of await changedFilesVsBase(git, record.baseBranch, record.branch)) {
        files.add(f);
      }
    } else {
      unsimulatable.add(record.name);
    }
    const abs = worktreeAbsPath(repoRoot, record);
    if (existsSync(abs)) {
      for (const f of await uncommittedFiles(abs)) {
        files.add(f.path);
        uncommitted.add(f.path);
      }
    }
    agentFiles[record.name] = files.size;
    uncommittedByAgent.set(record.name, uncommitted);
    for (const file of files) {
      const touchers = agentsByFile.get(file) ?? [];
      touchers.push(record.name);
      agentsByFile.set(file, touchers);
    }
    if (needRanges) {
      const ranges = await collectAgentRanges(git, repoRoot, record, files);
      for (const [file, fileRanges] of ranges) {
        const perAgent = rangesByFile.get(file) ?? new Map<string, FileRanges>();
        perAgent.set(record.name, fileRanges);
        rangesByFile.set(file, perAgent);
      }
    }
  }

  if (agents.length < 2) {
    const result: CheckResult = {
      collisions: [],
      prediction,
      agentsChecked: agents.length,
      agentFiles,
    };
    if (options.lines) result.disjoint = [];
    return result;
  }

  const multiAgent = [...agentsByFile.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([file, names]) => ({ file, agents: [...names].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));

  // Merge simulation: every unordered pair of agents sharing a file gets a real
  // in-memory three-way merge, and each shared file inherits the strongest
  // verdict across the pairs that touch it (conflicts > uncommitted > clean).
  let working: Collision[] = multiAgent;
  let cleanMerges: Collision[] | undefined;
  if (useMergeTree && multiAgent.length > 0) {
    const byName = new Map(agents.map((a) => [a.name, a]));
    const pairKeys = new Set<string>();
    for (const { agents: names } of multiAgent) {
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          pairKeys.add(`${names[i]}\n${names[j]}`);
        }
      }
    }
    const conflicted = new Set<string>();
    for (const key of pairKeys) {
      const [a, b] = key.split('\n').map((n) => byName.get(n));
      if (!a || !b || unsimulatable.has(a.name) || unsimulatable.has(b.name)) continue;
      const res = await predictMergeConflicts(git, a.branch, b.branch);
      for (const f of res.conflictedFiles) conflicted.add(f);
    }
    const verdicted: Collision[] = [];
    cleanMerges = [];
    for (const c of multiAgent) {
      if (conflicted.has(c.file)) {
        verdicted.push({ ...c, verdict: 'conflicts' });
      } else if (
        c.agents.some((n) => unsimulatable.has(n) || uncommittedByAgent.get(n)?.has(c.file))
      ) {
        // Simulation can't see uncommitted work or missing branches: fail closed.
        verdicted.push({ ...c, verdict: 'uncommitted' });
      } else {
        cleanMerges.push(c);
      }
    }
    working = verdicted;
  } else if (useMergeTree) {
    cleanMerges = [];
  }

  /** Overlapping edited ranges for one file, or undefined when disjoint. */
  const lineOverlap = (file: string, names: string[]): string | undefined => {
    const perAgent = rangesByFile.get(file);
    // An agent with no parsed ranges has no net change vs merge-base.
    const entries = names.map((n) => perAgent?.get(n) ?? []);
    const overlap = rangesOverlap(entries);
    if (overlap === 'whole') return 'whole-file';
    return overlap.length > 0 ? formatRanges(overlap) : undefined;
  };

  let collisions: Collision[];
  let disjoint: Collision[] | undefined;
  if (options.lines) {
    if (useMergeTree) {
      // Verdict decides collision-ness; lines are extra context on each row.
      collisions = working.map((c) => ({ ...c, overlap: lineOverlap(c.file, c.agents) ?? '' }));
    } else {
      collisions = [];
      disjoint = [];
      for (const { file, agents: names } of working) {
        const overlap = lineOverlap(file, names);
        if (overlap !== undefined) {
          collisions.push({ file, agents: names, overlap });
        } else {
          disjoint.push({ file, agents: names });
        }
      }
    }
  } else {
    collisions = working;
  }

  const result: CheckResult = { collisions, prediction, agentsChecked: agents.length, agentFiles };
  if (disjoint !== undefined) result.disjoint = disjoint;
  if (cleanMerges !== undefined) result.cleanMerges = cleanMerges;
  return result;
}

/**
 * Render a check result as the `fleet check` human report. `capable` reports
 * whether the installed git supports merge-tree at all, which only affects the
 * hint text — it is not part of `CheckResult`, so the JSON shape is unchanged.
 */
export function buildCheckReport(
  result: CheckResult,
  opts: { lines?: boolean; capable: boolean },
): string {
  const { collisions, disjoint, cleanMerges, prediction, agentsChecked } = result;
  const useMergeTree = prediction === 'merge-tree';

  if (agentsChecked < 2) {
    return (
      `Nothing to check: ${plural(agentsChecked, 'active agent')} ` +
      '(collisions need at least 2).'
    );
  }

  const out: string[] = [];
  if (collisions.length === 0) {
    out.push(ok(`No collisions across ${agentsChecked} agents.`));
  } else {
    out.push(fail(`${plural(collisions.length, 'collision risk')} detected:`));
    const headers = ['FILE', 'AGENTS'];
    if (opts.lines) headers.push('LINES');
    if (useMergeTree) headers.push('VERDICT');
    out.push(
      table(
        headers,
        collisions.map((c) => {
          const row = [c.file, c.agents.join(', ')];
          if (opts.lines) row.push(c.overlap ?? '');
          if (useMergeTree) {
            row.push(c.verdict === 'conflicts' ? 'will conflict' : 'uncommitted edits');
          }
          return row;
        }),
      ),
    );
    out.push(
      dim(
        useMergeTree
          ? "Verdicts from git merge-tree simulation of each agent pair's committed work; uncommitted edits can't be simulated and stay blocking."
          : opts.lines
            ? 'Line ranges are relative to the merge base — exact when the agents share a base, a heuristic otherwise.'
            : 'These files are touched by more than one agent (committed or uncommitted). ' +
              'Coordinate before merging.' +
              (opts.capable ? '' : ' (file-level only: git < 2.38 lacks merge-tree)'),
      ),
    );
  }
  if (cleanMerges && cleanMerges.length > 0) {
    out.push(
      dim(
        `${plural(cleanMerges.length, 'shared file')} whose committed changes merge cleanly (not counted):`,
      ),
    );
    for (const c of cleanMerges) out.push(dim(`  ${c.file} (${c.agents.join(', ')})`));
  }
  if (disjoint && disjoint.length > 0) {
    out.push(
      dim(
        `${plural(disjoint.length, 'shared file')} with disjoint line edits (not counted as collisions):`,
      ),
    );
    for (const d of disjoint) {
      out.push(dim(`  ${d.file} (${d.agents.join(', ')})`));
    }
  }

  return out.join('\n');
}

/**
 * Cross-reference every agent branch's changed files (committed vs base, plus
 * uncommitted edits in the worktree) and flag files touched by more than one
 * agent — the collision risks to resolve before anyone merges.
 */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const result = await collectCheck({ ...options, cwd: repoRoot });

  if (options.json ?? false) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const capable = await supportsMergeTree(gitAt(repoRoot));
  console.log(buildCheckReport(result, { lines: options.lines, capable }));
  return result;
}

/**
 * Edited line ranges for every file an agent touched, in merge-base
 * coordinates: one `git diff -U0 <merge-base>` run inside the worktree covers
 * committed and uncommitted work at once; untracked files (and anything else
 * whose lines can't be resolved) are marked 'whole'.
 */
async function collectAgentRanges(
  git: SimpleGit,
  repoRoot: string,
  record: AgentRecord,
  files: Set<string>,
): Promise<Map<string, FileRanges>> {
  const abs = worktreeAbsPath(repoRoot, record);
  const worktreeExists = existsSync(abs);
  const branchesExist =
    (await branchExists(git, record.branch)) && (await branchExists(git, record.baseBranch));

  if (!branchesExist) {
    // No merge base to anchor line numbers to — fall back to whole-file.
    return new Map([...files].map((f) => [f, 'whole' as const]));
  }

  const mergeBase = (await git.raw(['merge-base', record.baseBranch, record.branch])).trim();
  const diffText = worktreeExists
    ? await gitAt(abs).raw(['diff', '-U0', '--no-color', mergeBase])
    : await git.raw(['diff', '-U0', '--no-color', mergeBase, record.branch]);
  const ranges = parseUnifiedDiff(diffText);

  if (worktreeExists) {
    for (const f of await uncommittedFiles(abs)) {
      // Untracked files never appear in `git diff`; both agents adding the
      // same new file is a real collision, so mark them whole-file.
      if (f.status === '??') ranges.set(f.path, 'whole');
    }
  }
  return ranges;
}
