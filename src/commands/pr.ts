import { FleetError } from '../lib/errors.js';
import { dim, ok } from '../lib/format.js';
import { branchExists, getMainRepoRoot, gitAt, revParseOid, verifyBranch } from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { runFile } from '../lib/proc.js';
import { getAgent, readState, writeState } from '../lib/state.js';

export interface PrOptions {
  /** PR title; gh's --fill (last commit) is used when absent. */
  title?: string;
  /** Open the PR as a draft. */
  draft?: boolean;
  /** PR base branch; defaults to the agent's recorded base. */
  base?: string;
  /** Branch name to publish as; overrides the derived task-based name. */
  head?: string;
  cwd?: string;
}

export interface PrResult {
  branch: string;
  /** Branch name pushed to origin — the head ref GitHub shows in the PR header. */
  publicBranch: string;
  base: string;
  pushed: boolean;
  created: boolean;
}

const MAX_SLUG = 48;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_SLUG) return slug;
  const cut = slug.slice(0, MAX_SLUG + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, MAX_SLUG)).replace(/-+$/g, '');
}

/**
 * Public branch name for a PR, derived from the task — the branch's first
 * commit subject — never from the agent. GitHub renders the head ref in the
 * PR header as `owner:branch`, so a `fleet/<agent>` ref would publicly
 * announce which AI tool wrote the change on every PR opened from a fork.
 */
export function derivePublicBranch(firstSubject: string | undefined, tipOid: string): string {
  const fallback = `pr-${tipOid.slice(0, 7)}`;
  const subject = firstSubject?.trim() ?? '';
  if (subject === '') return fallback;
  const conventional = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i.exec(subject);
  const slug = conventional
    ? slugify(`${conventional[2] ?? ''} ${conventional[3] ?? ''}`)
    : slugify(subject);
  if (slug === '') return fallback;
  return conventional ? `${conventional[1]!.toLowerCase()}/${slug}` : slug;
}

// A pragmatic subset of git check-ref-format: enough to fail fast with a clear
// message instead of a raw git error mid-push.
const HEAD_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validatePublicBranch(name: string): void {
  if (
    !HEAD_RE.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    throw new FleetError(
      `Invalid --head branch name "${name}". Use letters, digits, ".", "_", "-" and "/" ` +
        '(no "..", no trailing "/", "." or ".lock").',
    );
  }
}

/**
 * Push an agent's branch to `origin` and open a pull request via the GitHub
 * CLI — the review-based alternative to a local `fleet merge`. gh is invoked
 * as an external binary, never bundled; its availability is verified before
 * anything is pushed.
 *
 * The branch is published under a task-derived name (`--head` to override),
 * not its local `fleet/<agent>` name: the head ref is public in the PR header.
 * The chosen name is recorded on the agent so re-runs update the same ref.
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

  if (options.head) validatePublicBranch(options.head);
  let publicBranch = options.head ?? record.prBranch;
  if (!publicBranch) {
    const tip = await revParseOid(git, record.branch);
    if (!tip) {
      throw new FleetError(`Could not resolve the tip of ${record.branch}; nothing to push.`);
    }
    const subjects = (await branchExists(git, record.baseBranch))
      ? await git.raw(['log', '--reverse', '--format=%s', `${record.baseBranch}..${record.branch}`])
      : '';
    const first = subjects.split('\n').find((line) => line.trim() !== '');
    publicBranch = derivePublicBranch(first, tip);
  }

  // FLEET_GH exists for tests, which substitute a recording stub for the real
  // gh binary (network CLIs can't run against a throwaway repo).
  const [ghBin = 'gh', ...ghPrefix] = (process.env.FLEET_GH ?? 'gh').split(' ');
  if ((await runFile(ghBin, [...ghPrefix, '--version'], repoRoot, { quiet: true })) !== 0) {
    throw new FleetError(
      'GitHub CLI (gh) not found. Install it from https://cli.github.com, ' +
        'or push and open the PR manually:\n' +
        `  git push -u origin ${record.branch}:refs/heads/${publicBranch}`,
    );
  }

  await git.raw(['push', '-u', 'origin', `${record.branch}:refs/heads/${publicBranch}`]);
  console.log(ok(`Pushed ${record.branch} to origin as ${publicBranch}.`));

  // Persist before gh runs: if PR creation fails and is retried, the retry
  // must update the same public ref rather than derive a new one.
  if (record.prBranch !== publicBranch) {
    await withLock(repoRoot, 'pr', async () => {
      const fresh = readState(repoRoot);
      getAgent(fresh, name).prBranch = publicBranch;
      writeState(repoRoot, fresh);
    });
  }

  const args = [...ghPrefix, 'pr', 'create', '--head', publicBranch, '--base', base];
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

  return { branch: record.branch, publicBranch, base, pushed: true, created: true };
}
