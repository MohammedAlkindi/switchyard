import { existsSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { dim, ok, plural } from '../lib/format.js';
import {
  addWorktreeForBranch,
  branchExists,
  createBranchAt,
  currentBranch,
  deleteRef,
  getMainRepoRoot,
  gitAt,
  resetHardTo,
  revParseOid,
  uncommittedFiles,
} from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { readState, worktreeAbsPath, writeState } from '../lib/state.js';
import { clearUndoRecord, readUndoRecord, UNDO_BRANCH_REF, UNDO_HEAD_REF } from '../lib/undo.js';

export interface UndoOptions {
  cwd?: string;
}

export interface UndoResult {
  agent: string;
  into: string;
  restoredBranch: boolean;
  restoredWorktree: boolean;
}

/**
 * Roll back the last `fleet merge`: reset the target branch to its pre-merge
 * commit, recreate the agent's branch and worktree if the merge cleaned them
 * up, and restore the state entry. Single level — a newer merge overwrites
 * the record. Every precondition is checked before anything is touched.
 */
export async function undo(options: UndoOptions = {}): Promise<UndoResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'undo', () => undoLocked(repoRoot));
}

async function undoLocked(repoRoot: string): Promise<UndoResult> {
  const git = gitAt(repoRoot);
  const record = readUndoRecord(repoRoot);
  if (!record) {
    throw new FleetError('Nothing to undo: no fleet merge has been recorded.');
  }

  const undoHead = await revParseOid(git, UNDO_HEAD_REF);
  const undoBranch = await revParseOid(git, UNDO_BRANCH_REF);
  if (undoHead !== record.headBefore || undoBranch !== record.branchTip) {
    throw new FleetError(
      'Undo refs are missing or do not match the recorded merge — refusing to guess.\n' +
        'Delete .fleet/undo.json to discard the record.',
    );
  }

  const branch = await currentBranch(git);
  if (branch !== record.into) {
    throw new FleetError(
      `The merge went into "${record.into}" but the current branch is ${branch ?? '(detached HEAD)'}.\n` +
        `Check out ${record.into} first, then re-run fleet undo.`,
    );
  }

  const head = await revParseOid(git, 'HEAD');
  if (head !== record.headAfter) {
    throw new FleetError(
      'History moved since the merge: HEAD is no longer the recorded post-merge commit.\n' +
        'Undo would discard newer work — refusing. Revert manually if you still need to.',
    );
  }

  // Untracked files are untouched by reset --hard; only tracked changes block.
  const dirty = (await uncommittedFiles(repoRoot)).filter((f) => f.status !== '??');
  if (dirty.length > 0) {
    throw new FleetError(
      `The main worktree has ${plural(dirty.length, 'uncommitted change')}. ` +
        'Commit or stash them first, then re-run fleet undo.',
    );
  }

  await resetHardTo(git, record.headBefore);

  let restoredBranch = false;
  if (record.branchDeleted && !(await branchExists(git, record.agent.branch))) {
    await createBranchAt(git, record.agent.branch, record.branchTip);
    restoredBranch = true;
  }

  let restoredWorktree = false;
  const abs = worktreeAbsPath(repoRoot, record.agent);
  if (record.cleaned && !existsSync(abs)) {
    await addWorktreeForBranch(git, abs, record.agent.branch);
    restoredWorktree = true;
  }

  const state = readState(repoRoot);
  state.agents[record.agent.name] = record.agent;
  writeState(repoRoot, state);

  await deleteRef(git, UNDO_HEAD_REF);
  await deleteRef(git, UNDO_BRANCH_REF);
  clearUndoRecord(repoRoot);

  console.log(ok(`Undid the merge of ${record.agent.branch} into ${record.into}.`));
  console.log(`  ${record.into} reset to ${record.headBefore.slice(0, 12)}`);
  if (restoredBranch) console.log(`  branch ${record.agent.branch} restored`);
  if (restoredWorktree) console.log(`  worktree restored at ${abs}`);
  console.log(dim('  single-level: the undo record is now cleared'));

  return {
    agent: record.agent.name,
    into: record.into,
    restoredBranch,
    restoredWorktree,
  };
}
