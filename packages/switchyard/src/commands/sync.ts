import { existsSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { dim, fail, ok, plural } from '../lib/format.js';
import { aheadBehind, getMainRepoRoot, gitAt, verifyBranch } from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { getAgent, readState, worktreeAbsPath } from '../lib/state.js';

export interface SyncOptions {
  cwd?: string;
}

export interface SyncResult {
  name: string;
  branch: string;
  base: string;
  /** Commits from the base the agent was behind before this run. */
  behind: number;
  /** False when the branch was already up to date. */
  updated: boolean;
}

export interface SyncFailure {
  name: string;
  /** The FleetError message the single-agent sync would have thrown. */
  error: string;
}

export interface SyncAllResult {
  synced: SyncResult[];
  failed: SyncFailure[];
}

/**
 * Catch an agent's branch up with its base by merging the base into the
 * agent's worktree. Same safety contract as `fleet merge`: a conflicted merge
 * is aborted before the error is reported, never left half-done.
 */
export async function sync(name: string, options: SyncOptions = {}): Promise<SyncResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'sync', () => syncLocked(name, options, repoRoot));
}

/**
 * Catch every registered agent up with its base in one sweep. Each agent gets
 * the exact single-agent treatment (same dirty checks, same abort-on-conflict
 * contract), but one agent's failure never stops the rest of the fleet from
 * catching up — failures are collected and reported instead of thrown.
 */
export async function syncAll(options: SyncOptions = {}): Promise<SyncAllResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'sync', async () => {
    const state = readState(repoRoot);
    const names = Object.keys(state.agents).sort();
    const result: SyncAllResult = { synced: [], failed: [] };
    if (names.length === 0) {
      console.log('No agents registered. Run `fleet spawn <name>` to create one.');
      return result;
    }

    for (const name of names) {
      console.log(dim(`— ${name}`));
      try {
        result.synced.push(await syncLocked(name, options, repoRoot));
      } catch (err) {
        // Anything unexpected should still crash loudly; only the failures the
        // single-agent command reports as its own are collected and continued.
        if (!(err instanceof FleetError)) throw err;
        result.failed.push({ name, error: err.message });
        console.error(fail(`✗ ${name}: ${err.message}`));
      }
    }

    const caughtUp = result.synced.filter((s) => s.updated).length;
    const summary =
      `${plural(result.synced.length, 'agent')} synced` +
      ` (${caughtUp} caught up)` +
      (result.failed.length > 0 ? `, ${result.failed.length} failed` : '');
    console.log('');
    console.log(result.failed.length === 0 ? ok(summary) : fail(summary));
    return result;
  });
}

async function syncLocked(
  name: string,
  options: SyncOptions,
  repoRoot: string,
): Promise<SyncResult> {
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const record = getAgent(state, name);
  await verifyBranch(git, record.branch, 'Agent');
  await verifyBranch(git, record.baseBranch, 'Base');

  const abs = worktreeAbsPath(repoRoot, record);
  if (!existsSync(abs)) {
    throw new FleetError(
      `Agent "${name}" has no worktree on disk (${abs}).\n` +
        'Run `fleet doctor --fix` to reconcile state, or `fleet remove` the agent.',
    );
  }

  const wtGit = gitAt(abs);
  const wtStatus = await wtGit.status();
  if (wtStatus.conflicted.length > 0) {
    throw new FleetError(
      `Agent "${name}" has an unresolved merge in its worktree. Resolve or abort it first.`,
    );
  }
  if (wtStatus.files.length > 0) {
    throw new FleetError(
      `Agent "${name}" has ${plural(wtStatus.files.length, 'uncommitted change')} in ${abs}.\n` +
        'Commit them in the worktree first, then re-run `fleet sync`.',
    );
  }

  const { behind } = await aheadBehind(git, record.baseBranch, record.branch);
  if (behind === 0) {
    console.log(ok(`${record.branch} is already up to date with ${record.baseBranch}.`));
    return { name, branch: record.branch, base: record.baseBranch, behind: 0, updated: false };
  }

  try {
    await wtGit.merge([record.baseBranch]);
  } catch (err) {
    const status = await wtGit.status();
    if (status.conflicted.length > 0) {
      // Never leave the worktree mid-merge: abort before reporting.
      await wtGit.raw(['merge', '--abort']);
      throw new FleetError(
        `Merging ${record.baseBranch} into ${record.branch} conflicts in ${plural(status.conflicted.length, 'file')}:\n` +
          status.conflicted.map((f) => `  ${f}`).join('\n') +
          `\nThe merge was aborted — ${record.branch} is unchanged. Resolve manually inside ${abs} when ready.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new FleetError(`git merge failed before starting: ${message}`);
  }

  console.log(
    ok(`Merged ${record.baseBranch} into ${record.branch}`) +
      ` (caught up ${plural(behind, 'commit')}).`,
  );
  return { name, branch: record.branch, base: record.baseBranch, behind, updated: true };
}
