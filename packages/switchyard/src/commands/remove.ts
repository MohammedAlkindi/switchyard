import { existsSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { dim, ok, plural } from '../lib/format.js';
import {
  branchExists,
  deleteBranch,
  getMainRepoRoot,
  gitAt,
  isMergedInto,
  pruneWorktrees,
  removeWorktree,
  uncommittedFiles,
} from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { getAgent, readState, worktreeAbsPath, writeState } from '../lib/state.js';

export interface RemoveOptions {
  /** Discard uncommitted changes and allow deleting an unmerged branch. */
  force?: boolean;
  /** Also delete the agent's branch (kept by default so no work is lost). */
  deleteBranch?: boolean;
  cwd?: string;
}

export interface RemoveResult {
  name: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

export async function remove(name: string, options: RemoveOptions = {}): Promise<RemoveResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'remove', () => removeLocked(name, options, repoRoot));
}

async function removeLocked(
  name: string,
  options: RemoveOptions,
  repoRoot: string,
): Promise<RemoveResult> {
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const record = getAgent(state, name);
  const abs = worktreeAbsPath(repoRoot, record);
  const force = options.force ?? false;

  // Validate everything before touching anything, so a refusal leaves the
  // agent fully intact.
  if (existsSync(abs) && !force) {
    const dirty = await uncommittedFiles(abs);
    if (dirty.length > 0) {
      throw new FleetError(
        `Agent "${name}" has ${plural(dirty.length, 'uncommitted change')} in ${abs}.\n` +
          'Commit them in the worktree first, or pass --force to discard them.',
      );
    }
  }

  const branchStillExists = await branchExists(git, record.branch);
  if (options.deleteBranch && branchStillExists && !force) {
    const baseExists = await branchExists(git, record.baseBranch);
    const merged = baseExists && (await isMergedInto(git, record.branch, record.baseBranch));
    if (!merged) {
      throw new FleetError(
        `Branch "${record.branch}" is not fully merged into ${record.baseBranch}.\n` +
          'Merge it first, or pass --force to delete it anyway (this discards its commits).',
      );
    }
  }

  let worktreeRemoved = false;
  if (existsSync(abs)) {
    await removeWorktree(git, abs, force);
    worktreeRemoved = true;
  } else {
    // Directory was deleted manually; clear git's stale bookkeeping so the
    // branch is no longer considered checked out.
    await pruneWorktrees(git);
  }

  let branchDeleted = false;
  if (options.deleteBranch && branchStillExists) {
    // Merge safety was verified above (or --force was passed), so -D is safe here.
    await deleteBranch(git, record.branch, true);
    branchDeleted = true;
  }

  delete state.agents[name];
  writeState(repoRoot, state);

  console.log(ok(`Removed agent ${name}.`));
  console.log(`  worktree: ${worktreeRemoved ? 'removed' : 'already gone (pruned)'}`);
  if (branchDeleted) {
    console.log(`  branch:   ${record.branch} deleted`);
  } else if (!branchStillExists) {
    console.log(`  branch:   ${record.branch} was already deleted`);
  } else {
    console.log(`  branch:   ${record.branch} kept ${dim('(use --delete-branch to delete it)')}`);
  }

  return { name, worktreeRemoved, branchDeleted };
}
