import { existsSync } from 'node:fs';
import { readConfig } from '../lib/config.js';
import { FleetError } from '../lib/errors.js';
import { dim, ok, plural, warn } from '../lib/format.js';
import {
  currentBranch,
  deleteBranch,
  deleteRef,
  getMainRepoRoot,
  gitAt,
  pruneWorktrees,
  removeWorktree,
  revParseOid,
  uncommittedFiles,
  updateRef,
  verifyBranch,
} from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { runShell } from '../lib/proc.js';
import { getAgent, readState, worktreeAbsPath, writeState } from '../lib/state.js';
import {
  clearUndoRecord,
  UNDO_BRANCH_REF,
  UNDO_HEAD_REF,
  writeUndoRecord,
} from '../lib/undo.js';
import { check } from './check.js';
import { clean } from './clean.js';

export interface MergeOptions {
  /**
   * Explicitly request branch deletion after the merge. This is already the
   * default cleanup; the flag exists for symmetry with `fleet remove`.
   */
  deleteBranch?: boolean;
  /** commander maps --no-clean to clean: false. Default: full cleanup. */
  clean?: boolean;
  cwd?: string;
}

export interface MergeResult {
  branch: string;
  /** Branch the agent was merged into (the main worktree's current branch). */
  into: string;
  cleaned: boolean;
  branchDeleted: boolean;
  /** Agents swept afterwards when .fleetrc.json sets autoClean: true. */
  autoCleaned: string[];
}

/**
 * Merge an agent's branch into the main worktree's current branch, guarded by
 * a collision check, and clean up the agent on success. Never leaves the repo
 * mid-merge: a conflicted merge is aborted before the error is reported.
 */
export async function merge(name: string, options: MergeOptions = {}): Promise<MergeResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'merge', () => mergeLocked(name, options, repoRoot));
}

async function mergeLocked(
  name: string,
  options: MergeOptions,
  repoRoot: string,
): Promise<MergeResult> {
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const config = readConfig(repoRoot);
  const record = getAgent(state, name);
  await verifyBranch(git, record.branch, 'Agent');

  const doClean = options.clean ?? true;
  if (options.deleteBranch && !doClean) {
    throw new FleetError('--delete-branch and --no-clean contradict each other; pick one.');
  }

  const into = await currentBranch(git);
  if (!into) {
    throw new FleetError(
      'HEAD is detached in the main worktree. Check out the branch you want to merge into first.',
    );
  }

  const mainStatus = await git.status();
  if (mainStatus.conflicted.length > 0) {
    throw new FleetError(
      `The main worktree already has an unresolved merge (${plural(
        mainStatus.conflicted.length,
        'conflicted file',
      )}). Resolve or abort it first.`,
    );
  }

  // Collision gate: refuse while another still-active agent touches the same
  // files. Reuses `fleet check` (which prints its table) rather than a second
  // implementation of the cross-reference.
  if (Object.keys(state.agents).length >= 2) {
    const { collisions } = await check({ cwd: repoRoot });
    const blocking = collisions.filter((c) => c.agents.includes(name));
    if (blocking.length > 0) {
      const lines = blocking
        .map((c) => `  ${c.file} (${c.agents.filter((a) => a !== name).join(', ')})`)
        .join('\n');
      throw new FleetError(
        `Refusing to merge "${name}": ${plural(blocking.length, 'file is', 'files are')} also touched by other active agents:\n` +
          `${lines}\n` +
          'Merge or remove those agents first (or resolve the overlap), then re-run.',
      );
    }
  }

  // Validation gate: with a `validate` command configured, the agent's tip
  // must hold a passing record. A missing or stale record is run here (and
  // recorded, so `fleet list` shows the outcome either way); a failing record
  // at the tip refuses without re-running — same commit, same command, same
  // answer. Runs before preMerge so the skippable, recorded gate fails first.
  if (config.validate) {
    const hookDir = worktreeAbsPath(repoRoot, record);
    const tip = await revParseOid(git, record.branch);
    if (!tip) {
      throw new FleetError(`Could not resolve the tip of ${record.branch}; refusing to merge.`);
    }
    const rec = record.validation;
    const current = rec && rec.commit === tip && rec.command === config.validate ? rec : undefined;
    if (current?.ok) {
      console.log(dim(`validate: ${record.branch} already passed at ${tip.slice(0, 7)} — not re-run`));
    } else if (current) {
      throw new FleetError(
        `Validation failed at the tip of ${record.branch} (recorded ${current.at}).\n` +
          `Fix the branch and re-run \`fleet validate ${name}\`. The merge was not started — ${into} is unchanged.`,
      );
    } else {
      if (!existsSync(hookDir)) {
        throw new FleetError(
          `Cannot validate "${name}": no passing record for the current tip and no worktree to run in (${hookDir}).\n` +
            'Restore the worktree (`fleet doctor --fix`) and run `fleet validate` first.',
        );
      }
      const dirtyFiles = await uncommittedFiles(hookDir);
      if (dirtyFiles.length > 0) {
        throw new FleetError(
          `Cannot validate "${name}": ${plural(dirtyFiles.length, 'uncommitted change')} in ${hookDir}.\n` +
            'A validation record certifies a commit; commit the work first, then re-run.',
        );
      }
      console.log(dim(`validate: ${config.validate}`));
      const exitCode = await runShell(config.validate, hookDir);
      // Re-resolve in case the command itself committed (e.g. an autofixer).
      const certified = (await revParseOid(git, record.branch)) ?? tip;
      record.validation = {
        commit: certified,
        ok: exitCode === 0,
        at: new Date().toISOString(),
        command: config.validate,
      };
      writeState(repoRoot, state);
      if (exitCode !== 0) {
        throw new FleetError(
          `validate failed (exit ${exitCode}): ${config.validate}\n` +
            `The merge was not started — ${into} is unchanged.`,
        );
      }
    }
  }

  // preMerge hook: e.g. "npm test" in the agent's worktree. Runs after the
  // collision gate and before the merge starts, so a failure aborts cleanly.
  if (config.preMerge) {
    const hookDir = worktreeAbsPath(repoRoot, record);
    if (existsSync(hookDir)) {
      console.log(dim(`preMerge: ${config.preMerge}`));
      const exitCode = await runShell(config.preMerge, hookDir);
      if (exitCode !== 0) {
        throw new FleetError(
          `preMerge hook failed (exit ${exitCode}): ${config.preMerge}\n` +
            `The merge was not started — ${into} is unchanged.`,
        );
      }
    } else {
      console.log(warn(`preMerge hook skipped: worktree missing (${hookDir})`));
    }
  }

  // Record the pre-merge world for `fleet undo`: refs now (GC-safe even after
  // the branch is deleted), the JSON record only after success — undo must
  // never be able to act on a failed merge. Any merge attempt invalidates a
  // previous undo record, since these refs are single-slot.
  const headBefore = await revParseOid(git, 'HEAD');
  const branchTip = await revParseOid(git, record.branch);
  if (!headBefore || !branchTip) {
    throw new FleetError(
      'Could not resolve HEAD or the agent branch; refusing to merge without undo state.',
    );
  }
  clearUndoRecord(repoRoot);
  await updateRef(git, UNDO_HEAD_REF, headBefore);
  await updateRef(git, UNDO_BRANCH_REF, branchTip);

  try {
    await git.merge([record.branch]);
  } catch (err) {
    const status = await git.status();
    if (status.conflicted.length > 0) {
      await deleteRef(git, UNDO_HEAD_REF);
      await deleteRef(git, UNDO_BRANCH_REF);
      // Never leave the repo mid-merge: abort before reporting.
      await git.raw(['merge', '--abort']);
      throw new FleetError(
        `Merging ${record.branch} into ${into} conflicts in ${plural(status.conflicted.length, 'file')}:\n` +
          status.conflicted.map((f) => `  ${f}`).join('\n') +
          `\nThe merge was aborted — ${into} is unchanged. Resolve manually with \`git merge ${record.branch}\` when ready.`,
      );
    }
    await deleteRef(git, UNDO_HEAD_REF);
    await deleteRef(git, UNDO_BRANCH_REF);
    const message = err instanceof Error ? err.message : String(err);
    throw new FleetError(`git merge failed before starting: ${message}`);
  }

  console.log(ok(`Merged ${record.branch} into ${into}.`));

  let cleaned = false;
  let branchDeleted = false;
  if (!doClean) {
    console.log(
      dim(`  --no-clean: worktree and ${record.branch} kept. Run \`fleet remove ${name} --delete-branch\` later.`),
    );
  } else {
    const abs = worktreeAbsPath(repoRoot, record);
    const dirty = existsSync(abs) ? await uncommittedFiles(abs) : [];
    if (dirty.length > 0) {
      // The merge itself succeeded; don't fail it, and never discard work.
      console.log(
        warn(`  worktree kept: ${plural(dirty.length, 'uncommitted change')} in ${abs}`),
      );
      console.log(
        dim(`  commit them, or run \`fleet remove ${name} --force\` to discard; ${record.branch} kept.`),
      );
    } else {
      if (existsSync(abs)) {
        await removeWorktree(git, abs, false);
      } else {
        await pruneWorktrees(git);
      }
      // Safe force-delete: the branch was just merged into `into`.
      await deleteBranch(git, record.branch, true);
      delete state.agents[name];
      writeState(repoRoot, state);
      cleaned = true;
      branchDeleted = true;
      console.log(`  removed worktree and deleted ${record.branch}`);
    }
  }

  const headAfter = (await revParseOid(git, 'HEAD')) ?? headBefore;
  writeUndoRecord(repoRoot, {
    version: 1,
    agent: record,
    into,
    headBefore,
    branchTip,
    headAfter,
    cleaned,
    branchDeleted,
    mergedAt: new Date().toISOString(),
  });

  let autoCleaned: string[] = [];
  if (config.autoClean && doClean) {
    const swept = await clean({ cwd: repoRoot });
    autoCleaned = swept.cleaned.map((c) => c.name);
  }

  return { branch: record.branch, into, cleaned, branchDeleted, autoCleaned };
}
