import { FleetError } from '../lib/errors.js';
import { dim, ok } from '../lib/format.js';
import { getMainRepoRoot, gitAt, verifyBranch } from '../lib/git.js';
import { runFile } from '../lib/proc.js';
import { getAgent, readState } from '../lib/state.js';

export interface PrOptions {
  /** PR title; gh's --fill (last commit) is used when absent. */
  title?: string;
  /** Open the PR as a draft. */
  draft?: boolean;
  /** PR base branch; defaults to the agent's recorded base. */
  base?: string;
  cwd?: string;
}

export interface PrResult {
  branch: string;
  base: string;
  pushed: boolean;
  created: boolean;
}

/**
 * Push an agent's branch to `origin` and open a pull request via the GitHub
 * CLI — the review-based alternative to a local `fleet merge`. gh is invoked
 * as an external binary, never bundled; its availability is verified before
 * anything is pushed.
 */
export async function pr(name: string, options: PrOptions = {}): Promise<PrResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const record = getAgent(state, name);
  await verifyBranch(git, record.branch, 'Agent');
  const base = options.base ?? record.baseBranch;

  const remotes = await git.getRemotes();
  if (!remotes.some((r) => r.name === 'origin')) {
    throw new FleetError(
      'No "origin" remote is configured, so there is nowhere to push the branch.\n' +
        'Add one with `git remote add origin <url>` and re-run.',
    );
  }

  // FLEET_GH exists for tests, which substitute a recording stub for the real
  // gh binary (network CLIs can't run against a throwaway repo).
  const [ghBin = 'gh', ...ghPrefix] = (process.env.FLEET_GH ?? 'gh').split(' ');
  if ((await runFile(ghBin, [...ghPrefix, '--version'], repoRoot, { quiet: true })) !== 0) {
    throw new FleetError(
      'GitHub CLI (gh) not found. Install it from https://cli.github.com, ' +
        'or push and open the PR manually:\n' +
        `  git push -u origin ${record.branch}`,
    );
  }

  await git.raw(['push', '-u', 'origin', record.branch]);
  console.log(ok(`Pushed ${record.branch} to origin.`));

  const args = [...ghPrefix, 'pr', 'create', '--head', record.branch, '--base', base];
  if (options.title) {
    args.push('--title', options.title, '--body', '');
  } else {
    args.push('--fill');
  }
  if (options.draft) args.push('--draft');

  console.log(dim(`$ ${ghBin} ${args.join(' ')}`));
  const exitCode = await runFile(ghBin, args, repoRoot);
  if (exitCode !== 0) {
    throw new FleetError(
      `gh pr create failed (exit ${exitCode}). The branch was pushed — ` +
        'you can re-run, or open the PR in the browser.',
    );
  }

  return { branch: record.branch, base, pushed: true, created: true };
}
