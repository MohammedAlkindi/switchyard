import { FleetError } from './errors.js';
import { plural } from './format.js';
import { uncommittedFiles } from './git.js';

/**
 * A validation result can certify a commit only if the command left no
 * uncommitted content behind. Commands that commit their changes remain valid:
 * callers resolve the new branch tip after this check.
 */
export async function assertValidationResultClean(name: string, worktree: string): Promise<void> {
  const dirty = await uncommittedFiles(worktree);
  if (dirty.length === 0) return;
  throw new FleetError(
    `Validation command left ${plural(dirty.length, 'uncommitted change')} in ${worktree}.\n` +
      `Nothing was recorded for "${name}"; commit or discard those changes, then re-run validation.`,
  );
}
