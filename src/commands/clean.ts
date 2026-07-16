import { existsSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { dim, ok, plural } from '../lib/format.js';
import {
  branchExists,
  deleteBranch,
  getMainRepoRoot,
  gitAt,
  isMergedInto,
  lastCommitISO,
  pruneWorktrees,
  removeWorktree,
  uncommittedFiles,
} from '../lib/git.js';
import { readState, worktreeAbsPath, writeState } from '../lib/state.js';

export interface CleanOptions {
  /** List what would be cleaned without removing anything. */
  dryRun?: boolean;
  /**
   * Also remove agents with no commits for this many days and a clean
   * worktree. Their branches are kept, so the work stays recoverable.
   */
  stale?: number;
  cwd?: string;
}

export interface CleanCandidate {
  name: string;
  branch: string;
  baseBranch: string;
  reason: 'merged' | 'branch-missing' | 'stale';
}

export interface CleanResult {
  /** Agents removed (or, with --dry-run, that would be removed). */
  cleaned: CleanCandidate[];
  /** Agents kept, with the reason they were not safe to clean. */
  kept: { name: string; reason: string }[];
}

/**
 * Remove agents whose branches are fully merged into their base — worktree,
 * branch, and state entry. Never touches unmerged work or dirty worktrees.
 */
export async function clean(options: CleanOptions = {}): Promise<CleanResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  const dryRun = options.dryRun ?? false;

  if (options.stale !== undefined && (!Number.isFinite(options.stale) || options.stale <= 0)) {
    throw new FleetError('Invalid --stale. Pass a positive number of days, e.g. --stale 14.');
  }

  if (agents.length === 0) {
    console.log('Nothing to clean: no active agents.');
    return { cleaned: [], kept: [] };
  }

  const cleaned: CleanCandidate[] = [];
  const kept: { name: string; reason: string }[] = [];

  for (const record of agents) {
    const abs = worktreeAbsPath(repoRoot, record);

    if (!(await branchExists(git, record.branch))) {
      // Branch was deleted outside Switchyard; only the stale state entry is left.
      cleaned.push({
        name: record.name,
        branch: record.branch,
        baseBranch: record.baseBranch,
        reason: 'branch-missing',
      });
      if (!dryRun) {
        await pruneWorktrees(git);
        delete state.agents[record.name];
      }
      continue;
    }

    if (!(await branchExists(git, record.baseBranch))) {
      kept.push({
        name: record.name,
        reason: `base branch "${record.baseBranch}" no longer exists`,
      });
      continue;
    }

    if (!(await isMergedInto(git, record.branch, record.baseBranch))) {
      // Unmerged agents are never cleaned by default; --stale removes their
      // worktree and state entry after long inactivity, but keeps the branch
      // so the work stays recoverable.
      if (options.stale !== undefined) {
        const dirty = existsSync(abs) ? await uncommittedFiles(abs) : [];
        if (dirty.length > 0) {
          kept.push({
            name: record.name,
            reason: `stale check skipped: ${plural(dirty.length, 'uncommitted change')}`,
          });
          continue;
        }
        const last = await lastCommitISO(git, record.branch);
        const ageDays = last
          ? (Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000)
          : Number.POSITIVE_INFINITY;
        if (ageDays > options.stale) {
          cleaned.push({
            name: record.name,
            branch: record.branch,
            baseBranch: record.baseBranch,
            reason: 'stale',
          });
          if (!dryRun) {
            if (existsSync(abs)) {
              await removeWorktree(git, abs, false);
            } else {
              await pruneWorktrees(git);
            }
            delete state.agents[record.name];
          }
          continue;
        }
      }
      kept.push({ name: record.name, reason: `has unmerged commits vs ${record.baseBranch}` });
      continue;
    }

    const dirty = existsSync(abs) ? await uncommittedFiles(abs) : [];
    if (dirty.length > 0) {
      kept.push({ name: record.name, reason: plural(dirty.length, 'uncommitted change') });
      continue;
    }

    cleaned.push({
      name: record.name,
      branch: record.branch,
      baseBranch: record.baseBranch,
      reason: 'merged',
    });
    if (!dryRun) {
      if (existsSync(abs)) {
        await removeWorktree(git, abs, false);
      } else {
        await pruneWorktrees(git);
      }
      // Merged into base was verified above; -D avoids `git branch -d`'s
      // stricter merged-into-HEAD check, which depends on the current branch.
      await deleteBranch(git, record.branch, true);
      delete state.agents[record.name];
    }
  }

  if (!dryRun) {
    writeState(repoRoot, state);
  }

  const verb = dryRun ? 'Would clean' : 'Cleaned';
  if (cleaned.length === 0) {
    console.log(ok('Nothing to clean: no fully merged agents.'));
  } else {
    console.log(ok(`${verb} ${plural(cleaned.length, 'agent')}:`));
    for (const c of cleaned) {
      const why =
        c.reason === 'merged'
          ? `merged into ${c.baseBranch}`
          : c.reason === 'stale'
            ? `stale ${options.stale}+ days — worktree removed, branch kept`
            : 'branch already deleted';
      console.log(`  ${c.name} ${dim(`(${c.branch} — ${why})`)}`);
    }
  }
  for (const k of kept) {
    console.log(dim(`  kept ${k.name}: ${k.reason}`));
  }

  return { cleaned, kept };
}
