import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { dim, fail, ok, warn } from '../lib/format.js';
import {
  currentBranch,
  defaultBaseBranch,
  getMainRepoRoot,
  gitAt,
  pruneWorktrees,
} from '../lib/git.js';
import { readState, worktreeAbsPath, worktreesDir, writeState } from '../lib/state.js';
import type { AgentRecord, FleetState } from '../lib/state.js';

/** Minimum git version Switchyard needs (`--path-format=absolute` support). */
export const MIN_GIT = { major: 2, minor: 31 };

export interface DoctorOptions {
  /** Repair what can be repaired instead of only reporting. */
  fix?: boolean;
  /** Print machine-readable JSON instead of the human report. */
  json?: boolean;
  cwd?: string;
}

export interface DoctorCheck {
  name: 'git-version' | 'repository' | 'state-file' | 'orphaned-worktrees' | 'stale-entries';
  /** Whether the check was healthy before any fixing. */
  ok: boolean;
  detail: string;
  /** True when --fix repaired the problem this run. */
  fixed: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** True when every check is ok or was fixed. */
  healthy: boolean;
}

/**
 * Diagnose (and with --fix, repair) drift between `.fleet/state.json` and
 * reality: corrupted state, orphaned worktrees, stale entries. Repairs are
 * re-derived from actual `git worktree list` output, never guessed.
 */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const fix = options.fix ?? false;
  const checks: DoctorCheck[] = [];

  checks.push(await checkGitVersion());

  let repoRoot: string;
  try {
    repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
    checks.push({ name: 'repository', ok: true, detail: `inside a git repository (${repoRoot})`, fixed: false });
  } catch {
    checks.push({
      name: 'repository',
      ok: false,
      detail: 'not inside a git repository — run fleet from within the repo it should manage',
      fixed: false,
    });
    return finish(checks, options.json ?? false);
  }

  const git = gitAt(repoRoot);
  const worktrees = await listGitWorktrees(git);
  const fleetWorktrees = worktrees.filter(
    (w) => isUnder(w.path, worktreesDir(repoRoot)) && w.branch !== null && w.branch.startsWith('fleet/'),
  );

  // --- state file -----------------------------------------------------------
  let state: FleetState | null = null;
  let stateModified = false;
  try {
    state = readState(repoRoot);
    checks.push({
      name: 'state-file',
      ok: true,
      detail: `.fleet/state.json is valid (${Object.keys(state.agents).length} agents)`,
      fixed: false,
    });
  } catch {
    if (fix) {
      state = { version: 1, agents: {} };
      for (const w of fleetWorktrees) {
        const record = await adoptRecord(git, repoRoot, w.path, w.branch as string);
        state.agents[record.name] = record;
      }
      stateModified = true;
      checks.push({
        name: 'state-file',
        ok: false,
        detail: `.fleet/state.json was corrupted — rebuilt from \`git worktree list\` (${Object.keys(state.agents).length} agents re-adopted; base branches and timestamps are re-derived, not original)`,
        fixed: true,
      });
    } else {
      checks.push({
        name: 'state-file',
        ok: false,
        detail: '.fleet/state.json is corrupted (not valid JSON / wrong shape) — run `fleet doctor --fix` to rebuild it from `git worktree list`',
        fixed: false,
      });
    }
  }

  if (state === null) {
    // Without a readable state the remaining cross-checks are meaningless.
    checks.push({
      name: 'orphaned-worktrees',
      ok: false,
      detail: 'skipped: state file unreadable',
      fixed: false,
    });
    checks.push({
      name: 'stale-entries',
      ok: false,
      detail: 'skipped: state file unreadable',
      fixed: false,
    });
    return finish(checks, options.json ?? false);
  }

  // --- orphaned worktrees (on disk, not in state) ----------------------------
  const trackedPaths = Object.values(state.agents).map((r) => worktreeAbsPath(repoRoot, r));
  const orphanDetails: string[] = [];
  let orphanCount = 0;
  let orphansFixed = 0;
  const wtDir = worktreesDir(repoRoot);
  const entries = existsSync(wtDir) ? readdirSync(wtDir, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(wtDir, entry.name);
    if (trackedPaths.some((p) => samePath(p, abs))) continue;
    orphanCount += 1;

    const registered = worktrees.find((w) => samePath(w.path, abs));
    if (registered && registered.branch !== null && registered.branch.startsWith('fleet/')) {
      if (fix) {
        const record = await adoptRecord(git, repoRoot, abs, registered.branch);
        state.agents[record.name] = record;
        stateModified = true;
        orphansFixed += 1;
        orphanDetails.push(`${entry.name}: adopted (branch ${registered.branch})`);
      } else {
        orphanDetails.push(`${entry.name}: valid fleet worktree not in state — --fix will adopt it`);
      }
    } else if (registered) {
      // A real worktree, but not on a fleet/* branch — not Switchyard's to manage.
      orphanDetails.push(
        `${entry.name}: worktree on branch ${registered.branch ?? '(detached)'} — not a fleet/* branch; remove it yourself with \`git worktree remove\``,
      );
    } else {
      if (fix) {
        rmSync(abs, { recursive: true, force: true });
        orphansFixed += 1;
        orphanDetails.push(`${entry.name}: not a git worktree — directory removed`);
      } else {
        orphanDetails.push(`${entry.name}: not a git worktree (leftover directory) — --fix will remove it`);
      }
    }
  }
  checks.push({
    name: 'orphaned-worktrees',
    ok: orphanCount === 0,
    detail:
      orphanCount === 0
        ? 'no untracked directories in .fleet/worktrees/'
        : orphanDetails.join('; '),
    fixed: orphanCount > 0 && orphansFixed === orphanCount,
  });

  // --- stale state entries (in state, gone on disk) --------------------------
  const staleNames = Object.values(state.agents)
    .filter((r) => !existsSync(worktreeAbsPath(repoRoot, r)))
    .map((r) => r.name);
  if (staleNames.length > 0 && fix) {
    for (const name of staleNames) {
      delete state.agents[name];
    }
    await pruneWorktrees(git);
    stateModified = true;
  }
  checks.push({
    name: 'stale-entries',
    ok: staleNames.length === 0,
    detail:
      staleNames.length === 0
        ? 'every state entry has a worktree on disk'
        : `worktree directory missing for: ${staleNames.join(', ')}` +
          (fix ? ' — entries pruned (branches kept)' : ' — --fix will prune the entries (branches are kept)'),
    fixed: staleNames.length > 0 && fix,
  });

  if (fix && stateModified) {
    writeState(repoRoot, state);
  }

  return finish(checks, options.json ?? false);
}

function finish(checks: DoctorCheck[], json: boolean): DoctorResult {
  const healthy = checks.every((c) => c.ok || c.fixed);
  if (json) {
    console.log(JSON.stringify({ checks, healthy }, null, 2));
    return { checks, healthy };
  }
  for (const c of checks) {
    const mark = c.ok ? ok('ok    ') : c.fixed ? warn('fixed ') : fail('fail  ');
    console.log(`${mark} ${c.name.padEnd(20)} ${c.detail}`);
  }
  console.log('');
  if (healthy) {
    console.log(ok('No problems found.') + (checks.some((c) => c.fixed) ? dim(' (after fixes)') : ''));
  } else {
    console.log(fail('Problems found.') + dim(' Re-run with --fix to repair what can be repaired.'));
  }
  return { checks, healthy };
}

async function checkGitVersion(): Promise<DoctorCheck> {
  const version = await simpleGit().version();
  if (!version.installed) {
    return { name: 'git-version', ok: false, detail: 'git is not installed or not on PATH', fixed: false };
  }
  const okVersion =
    version.major > MIN_GIT.major ||
    (version.major === MIN_GIT.major && version.minor >= MIN_GIT.minor);
  return {
    name: 'git-version',
    ok: okVersion,
    detail: okVersion
      ? `git ${version.major}.${version.minor} (minimum ${MIN_GIT.major}.${MIN_GIT.minor})`
      : `git ${version.major}.${version.minor} is older than the required ${MIN_GIT.major}.${MIN_GIT.minor} — upgrade git`,
    fixed: false,
  };
}

interface GitWorktree {
  path: string;
  branch: string | null;
}

/** Parse `git worktree list --porcelain` into path/branch pairs. */
async function listGitWorktrees(git: SimpleGit): Promise<GitWorktree[]> {
  const out = await git.raw(['worktree', 'list', '--porcelain']);
  const result: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      if (current) result.push(current);
      current = { path: path.resolve(trimmed.slice('worktree '.length)), branch: null };
    } else if (trimmed.startsWith('branch refs/heads/') && current) {
      current.branch = trimmed.slice('branch refs/heads/'.length);
    } else if (trimmed === '' && current) {
      result.push(current);
      current = null;
    }
  }
  if (current) result.push(current);
  return result;
}

/** Build a state record for an existing worktree found via `git worktree list`. */
async function adoptRecord(
  git: SimpleGit,
  repoRoot: string,
  worktreeAbs: string,
  branch: string,
): Promise<AgentRecord> {
  return {
    name: path.basename(worktreeAbs),
    branch,
    baseBranch: await fallbackBase(git),
    worktreePath: path.relative(repoRoot, worktreeAbs).split(path.sep).join('/'),
    createdAt: new Date().toISOString(),
  };
}

/** Best guess at a base branch when the original one is unknowable. */
async function fallbackBase(git: SimpleGit): Promise<string> {
  try {
    return await defaultBaseBranch(git);
  } catch {
    return (await currentBranch(git)) ?? 'main';
  }
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
