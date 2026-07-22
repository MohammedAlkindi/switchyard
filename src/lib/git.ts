import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { FleetError } from './errors.js';

export function gitAt(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir });
}

/**
 * Resolve the root of the *main* repository from any directory inside it —
 * including from inside a linked worktree, so every `fleet` command works when
 * run from `.fleet/worktrees/<agent>/`.
 */
export async function getMainRepoRoot(cwd: string): Promise<string> {
  let out: string;
  try {
    out = await simpleGit({ baseDir: cwd }).raw([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]);
  } catch {
    throw new FleetError(
      `Not inside a git repository: ${cwd}\n` +
        'Switchyard manages worktrees of an existing repository. ' +
        '`cd` into one (or run `git init`) and try again.',
    );
  }
  const [toplevel, commonDir] = out
    .trim()
    .split('\n')
    .map((line) => line.trim());
  if (!toplevel) {
    throw new FleetError(`Could not resolve the repository root from ${cwd}.`);
  }
  // In a linked worktree, --show-toplevel is the worktree itself; the main
  // repo root is the parent of the shared .git directory.
  if (commonDir && path.basename(commonDir) === '.git') {
    return path.resolve(path.dirname(commonDir));
  }
  return path.resolve(toplevel);
}

export async function branchExists(git: SimpleGit, branch: string): Promise<boolean> {
  // Decide from stdout, not the exit code: quiet git commands exit non-zero
  // with empty stderr, which simple-git does not surface as an error.
  const out = await git.raw(['branch', '--list', branch, '--format=%(refname:short)']);
  return out.trim().length > 0;
}

export async function verifyBranch(git: SimpleGit, branch: string, label: string): Promise<void> {
  if (!(await branchExists(git, branch))) {
    throw new FleetError(`${label} branch "${branch}" does not exist in this repository.`);
  }
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(git: SimpleGit): Promise<string | null> {
  const name = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  return name === 'HEAD' ? null : name;
}

/** Fall back to main/master when an agent has no recorded base branch. */
export async function defaultBaseBranch(git: SimpleGit): Promise<string> {
  for (const candidate of ['main', 'master']) {
    if (await branchExists(git, candidate)) return candidate;
  }
  throw new FleetError(
    'Could not find a "main" or "master" branch to diff against. Pass one explicitly with --base <branch>.',
  );
}

export async function addWorktree(
  git: SimpleGit,
  worktreePath: string,
  branch: string,
  base: string,
): Promise<void> {
  await git.raw(['worktree', 'add', worktreePath, '-b', branch, base]);
}

export async function removeWorktree(
  git: SimpleGit,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git.raw(args);
}

/** Clear git's bookkeeping for worktrees whose directories were deleted manually. */
export async function pruneWorktrees(git: SimpleGit): Promise<void> {
  await git.raw(['worktree', 'prune']);
}

export async function deleteBranch(git: SimpleGit, branch: string, force: boolean): Promise<void> {
  await git.raw(['branch', force ? '-D' : '-d', branch]);
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** Commits on `branch` not on `base` (ahead) and vice versa (behind). */
export async function aheadBehind(
  git: SimpleGit,
  base: string,
  branch: string,
): Promise<AheadBehind> {
  const out = await git.raw(['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  const parts = out.trim().split(/\s+/);
  return { behind: Number(parts[0] ?? 0), ahead: Number(parts[1] ?? 0) };
}

/** Files changed by commits on `branch` since it diverged from `base` (merge-base diff). */
export async function changedFilesVsBase(
  git: SimpleGit,
  base: string,
  branch: string,
): Promise<string[]> {
  const out = await git.raw(['diff', '--name-only', `${base}...${branch}`]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface UncommittedFile {
  path: string;
  /** Two-character porcelain status, trimmed (e.g. "M", "??", "A"). */
  status: string;
}

/** Modified, staged, and untracked files in a worktree. */
export async function uncommittedFiles(worktreeDir: string): Promise<UncommittedFile[]> {
  const status = await gitAt(worktreeDir).status();
  return status.files.map((f) => ({
    path: f.path,
    status: `${f.index}${f.working_dir}`.trim(),
  }));
}

/** ISO timestamp of the last commit on `ref`, or null if the ref has no commits. */
export async function lastCommitISO(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    const out = await git.raw(['log', '-1', '--format=%cI', ref, '--']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** True when every commit on `branch` is already reachable from `base`. */
export async function isMergedInto(git: SimpleGit, branch: string, base: string): Promise<boolean> {
  // Not `merge-base --is-ancestor`: it answers via exit code with empty
  // stderr, which simple-git does not surface as an error. Count commits on
  // `branch` that `base` can't reach instead — zero means fully merged.
  const out = await git.raw(['rev-list', '--count', `${base}..${branch}`]);
  return Number(out.trim()) === 0;
}

/** OID of `ref`'s commit, or null when it doesn't resolve. */
export async function revParseOid(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    const out = await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function updateRef(git: SimpleGit, ref: string, oid: string): Promise<void> {
  await git.raw(['update-ref', ref, oid]);
}

export async function deleteRef(git: SimpleGit, ref: string): Promise<void> {
  await git.raw(['update-ref', '-d', ref]);
}

/** Create a branch at a commit without checking it out. */
export async function createBranchAt(git: SimpleGit, branch: string, oid: string): Promise<void> {
  await git.raw(['branch', branch, oid]);
}

/** Attach a worktree for an existing branch (addWorktree creates a new branch). */
export async function addWorktreeForBranch(
  git: SimpleGit,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git.raw(['worktree', 'add', worktreePath, branch]);
}

export async function resetHardTo(git: SimpleGit, oid: string): Promise<void> {
  await git.raw(['reset', '--hard', oid]);
}

export interface GitVersion {
  major: number;
  minor: number;
}

/** Parse `git version` output ("git version 2.45.1.windows.1" → 2.45). */
export function parseGitVersion(raw: string): GitVersion | null {
  const m = /git version (\d+)\.(\d+)/.exec(raw);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function atLeast(v: GitVersion, min: GitVersion): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

/** Minimum git for `merge-tree --write-tree` (real in-memory merges). */
export const MERGE_TREE_MIN: GitVersion = { major: 2, minor: 38 };

let cachedGitVersion: GitVersion | null | undefined;

/** Installed git version, cached per process (one git binary per PATH). */
export async function gitVersion(git: SimpleGit): Promise<GitVersion | null> {
  if (cachedGitVersion === undefined) {
    try {
      cachedGitVersion = parseGitVersion(await git.raw(['version']));
    } catch {
      cachedGitVersion = null;
    }
  }
  return cachedGitVersion;
}

/** Whether `fleet check` can use merge simulation on this machine. */
export async function supportsMergeTree(git: SimpleGit): Promise<boolean> {
  const v = await gitVersion(git);
  return v !== null && atLeast(v, MERGE_TREE_MIN);
}

const FLEET_EXCLUDE_ENTRY = '.fleet/';

async function fleetExcludeFile(repoRoot: string): Promise<string> {
  const commonDirRaw = await gitAt(repoRoot).raw([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return path.join(commonDirRaw.trim(), 'info', 'exclude');
}

function hasFleetEntry(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === FLEET_EXCLUDE_ENTRY);
}

/** Read-only twin of `ensureFleetExcluded`, for `fleet init --check`. */
export async function isFleetExcluded(repoRoot: string): Promise<boolean> {
  const excludeFile = await fleetExcludeFile(repoRoot);
  return existsSync(excludeFile) && hasFleetEntry(readFileSync(excludeFile, 'utf8'));
}

/**
 * Ensure `.fleet/` is ignored via `.git/info/exclude` so Switchyard never dirties
 * the repos it manages — even ones whose .gitignore doesn't mention it.
 *
 * Returns whether the entry had to be added, so callers that report what they
 * did (`fleet init`) can tell "already ignored" from "just ignored it".
 */
export async function ensureFleetExcluded(repoRoot: string): Promise<boolean> {
  const excludeFile = await fleetExcludeFile(repoRoot);
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (hasFleetEntry(current)) return false;
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(excludeFile, `${prefix}# added by fleet\n${FLEET_EXCLUDE_ENTRY}\n`, 'utf8');
  return true;
}
