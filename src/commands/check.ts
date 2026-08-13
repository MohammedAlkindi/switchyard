import { existsSync } from 'node:fs';
import type { SimpleGit } from 'simple-git';
import { readConfig, resolveGuardedPath } from '../lib/config.js';
import { dim, fail, ok, plural, table, warn } from '../lib/format.js';
import { hashGuardedPath } from '../lib/guards.js';
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

/**
 * Reserved surface name for the main checkout in collision output. Parentheses
 * are invalid in agent names, so it can never shadow a real agent.
 */
export const MAIN_CHECKOUT = '(main)';

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

/** A shared file outside any worktree that moved under one or more agents. */
export interface GuardedChange {
  /** The entry exactly as written in `.fleetrc.json`. */
  path: string;
  /** Agents whose spawn-time digest no longer matches the file on disk. */
  agents: string[];
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
   * Includes a `(main)` entry when the main checkout has uncommitted edits.
   */
  agentFiles: Record<string, number>;
  /**
   * Uncommitted files in the main checkout counted as a collision surface —
   * 0 when the checkout is clean or no agents exist. Sessions editing the
   * shared checkout directly are the collisions worktrees cannot isolate.
   */
  mainFiles: number;
  /**
   * Guarded paths (`.fleetrc.json` `guardedPaths`) that changed since the
   * listed agents spawned — shared files no repository tracks, so no worktree
   * isolates them. Absent when none are configured; `[]` when all are current.
   */
  guardedChanges?: GuardedChange[];
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

  // The main checkout is a checked surface too: a session editing the shared
  // working tree directly collides with worktree agents in exactly the way
  // worktree isolation cannot prevent. Only its uncommitted work counts —
  // committed history is what bases and `fleet sync` already model.
  const mainUncommitted = new Set<string>();
  if (agents.length > 0) {
    for (const f of await uncommittedFiles(repoRoot)) {
      // .fleet/ is normally covered by .git/info/exclude; filter anyway so a
      // repo without the exclude entry never reports worktree internals.
      if (f.path === '.fleet' || f.path.startsWith('.fleet/')) continue;
      mainUncommitted.add(f.path);
    }
  }
  const surfaces = agents.length + (mainUncommitted.size > 0 ? 1 : 0);

  // Guarded paths are checked independently of the collision cross-reference:
  // they live outside every worktree, so git has no view of them at all and a
  // single agent can still be stale on one.
  const guardedChanges = collectGuardedChanges(repoRoot, agents);

  const agentsByFile = new Map<string, string[]>();
  // --lines only: file -> agent -> edited ranges (merge-base coordinates).
  const rangesByFile = new Map<string, Map<string, FileRanges>>();

  // merge-tree mode: simulation can't see uncommitted work, and can't run at
  // all when a branch is missing — both fail closed rather than silently clean.
  const uncommittedByAgent = new Map<string, Set<string>>();
  const unsimulatable = new Set<string>();
  const agentFiles: Record<string, number> = {};
  // Line ranges exist to intersect surfaces against each other; with fewer
  // than two there is nothing to intersect, so skip the diff parsing.
  const needRanges = (options.lines ?? false) && surfaces >= 2;

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

  if (mainUncommitted.size > 0) {
    agentFiles[MAIN_CHECKOUT] = mainUncommitted.size;
    uncommittedByAgent.set(MAIN_CHECKOUT, mainUncommitted);
    for (const file of mainUncommitted) {
      const touchers = agentsByFile.get(file) ?? [];
      touchers.push(MAIN_CHECKOUT);
      agentsByFile.set(file, touchers);
    }
    if (needRanges) {
      // Uncommitted main-checkout edits have no branch to diff; treat them as
      // whole-file so a line-refined check still fails closed on them.
      for (const file of mainUncommitted) {
        const perAgent = rangesByFile.get(file) ?? new Map<string, FileRanges>();
        perAgent.set(MAIN_CHECKOUT, 'whole');
        rangesByFile.set(file, perAgent);
      }
    }
  }

  if (surfaces < 2) {
    const result: CheckResult = {
      collisions: [],
      prediction,
      agentsChecked: agents.length,
      agentFiles,
      mainFiles: mainUncommitted.size,
    };
    if (options.lines) result.disjoint = [];
    if (guardedChanges) result.guardedChanges = guardedChanges;
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
      // Pairs involving the main checkout have no branch to simulate; they
      // fall through to the uncommitted verdict below.
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

  const result: CheckResult = {
    collisions,
    prediction,
    agentsChecked: agents.length,
    agentFiles,
    mainFiles: mainUncommitted.size,
  };
  if (disjoint !== undefined) result.disjoint = disjoint;
  if (cleanMerges !== undefined) result.cleanMerges = cleanMerges;
  if (guardedChanges) result.guardedChanges = guardedChanges;
  return result;
}

/**
 * Compare every configured guarded path against the digest each agent
 * recorded when it spawned. Returns undefined when the repo configures none,
 * so the field stays absent rather than an empty promise of coverage.
 *
 * Only agents that recorded a digest are considered: one spawned before the
 * path was configured has no baseline, and inventing one would report a
 * change that was never observed.
 */
function collectGuardedChanges(
  repoRoot: string,
  agents: AgentRecord[],
): GuardedChange[] | undefined {
  const entries = readConfig(repoRoot).guardedPaths;
  if (!entries || entries.length === 0) return undefined;

  const changes: GuardedChange[] = [];
  for (const entry of entries) {
    const current = hashGuardedPath(resolveGuardedPath(entry, repoRoot));
    const stale = agents
      .filter((a) => a.guarded?.[entry] !== undefined && a.guarded[entry] !== current)
      .map((a) => a.name);
    if (stale.length > 0) changes.push({ path: entry, agents: stale });
  }
  return changes;
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
  const { collisions, disjoint, cleanMerges, prediction, agentsChecked, mainFiles } = result;
  const useMergeTree = prediction === 'merge-tree';
  const guarded = result.guardedChanges ?? [];

  const guardedReport = (): string[] => {
    if (guarded.length === 0) return [];
    const lines = [
      warn(
        `${plural(guarded.length, 'guarded path')} changed outside any worktree since these agents spawned:`,
      ),
    ];
    for (const g of guarded) lines.push(`  ${g.path} (${g.agents.join(', ')})`);
    lines.push(
      dim('Shared files no repository tracks — re-read one before writing to it.'),
    );
    return lines;
  };

  if (agentsChecked < 2 && mainFiles === 0) {
    return [
      `Nothing to check: ${plural(agentsChecked, 'active agent')} ` +
        '(collisions need at least 2 surfaces).',
      ...guardedReport(),
    ].join('\n');
  }

  const surfacesLabel =
    mainFiles > 0 ? `${agentsChecked} agents + the main checkout` : `${agentsChecked} agents`;

  const out: string[] = [];
  if (collisions.length === 0) {
    out.push(ok(`No collisions across ${surfacesLabel}.`));
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
    if (collisions.some((c) => c.agents.includes(MAIN_CHECKOUT))) {
      out.push(
        dim(
          `${MAIN_CHECKOUT} is uncommitted work in the main checkout itself — ` +
            'a session is editing the shared working tree directly.',
        ),
      );
    }
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
  out.push(...guardedReport());

  return out.join('\n');
}

/**
 * Cross-reference every agent branch's changed files (committed vs base, plus
 * uncommitted edits in the worktree) and flag files touched by more than one
 * agent — the collision risks to resolve before anyone merges. Uncommitted
 * edits in the main checkout count as one more surface: the sessions that
 * bypass worktrees are the ones that need flagging most.
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
