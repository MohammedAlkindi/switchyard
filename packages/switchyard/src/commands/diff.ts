import { FleetError } from '../lib/errors.js';
import { dim } from '../lib/format.js';
import { branchExists, defaultBaseBranch, getMainRepoRoot, gitAt, verifyBranch } from '../lib/git.js';
import { readState } from '../lib/state.js';

export interface DiffOptions {
  /** Override the diff base. Defaults to the branch the agent was spawned from. */
  base?: string;
  cwd?: string;
}

export interface DiffResult {
  branch: string;
  base: string;
  /** Full patch of `git diff <base>...<branch>`. Empty string when there are no commits. */
  patch: string;
}

export async function diff(name: string, options: DiffOptions = {}): Promise<DiffResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);

  // Also works for fleet/* branches that exist but aren't in state (e.g. the
  // state file was deleted): fall back to main/master as the base.
  const record = state.agents[name];
  const branch = record?.branch ?? `fleet/${name}`;
  if (!(await branchExists(git, branch))) {
    if (record) {
      throw new FleetError(
        `Agent "${name}" is tracked but its branch "${branch}" no longer exists.\n` +
          `Run \`fleet remove ${name}\` to clean up the stale entry.`,
      );
    }
    throw new FleetError(
      `No agent named "${name}" and no branch "${branch}" exists. ` +
        'Run `fleet list` to see active agents.',
    );
  }

  const base = options.base ?? record?.baseBranch ?? (await defaultBaseBranch(git));
  await verifyBranch(git, base, 'Base');

  const args = ['diff'];
  if (process.stdout.isTTY) args.push('--color=always');
  args.push(`${base}...${branch}`);
  const patch = await git.raw(args);

  if (patch.trim().length === 0) {
    console.log(dim(`No committed changes on ${branch} vs ${base}.`));
  } else {
    console.log(patch.trimEnd());
  }

  return { branch, base, patch };
}
