import { existsSync } from 'node:fs';
import { bold, dim, ok, warn } from '../lib/format.js';
import {
  aheadBehind,
  getMainRepoRoot,
  gitAt,
  uncommittedFiles,
  verifyBranch,
} from '../lib/git.js';
import type { UncommittedFile } from '../lib/git.js';
import { getAgent, readState, worktreeAbsPath } from '../lib/state.js';
import type { AgentRecord } from '../lib/state.js';

export interface StatusOptions {
  /** Print machine-readable JSON instead of the human summary. */
  json?: boolean;
  cwd?: string;
}

export interface StatusResult {
  record: AgentRecord;
  ahead: number;
  behind: number;
  uncommitted: UncommittedFile[];
  /** Output of `git diff --stat <base>...<branch>`. */
  diffStat: string;
  worktreeMissing: boolean;
}

/**
 * Gather the per-agent data `fleet status` displays, without printing anything.
 * Mirrors `collectListings` in list.ts: callers that need the data rather than
 * the rendering — `--json`, and any transport where stdout is not free-form —
 * use this instead of `status()`.
 */
export async function collectStatus(
  name: string,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const record = getAgent(state, name);
  const abs = worktreeAbsPath(repoRoot, record);
  const worktreeMissing = !existsSync(abs);

  await verifyBranch(git, record.branch, 'Agent');
  await verifyBranch(git, record.baseBranch, 'Base');

  const { ahead, behind } = await aheadBehind(git, record.baseBranch, record.branch);
  const diffStat = (
    await git.raw(['diff', '--stat', `${record.baseBranch}...${record.branch}`])
  ).trimEnd();
  const uncommitted = worktreeMissing ? [] : await uncommittedFiles(abs);

  return { record, ahead, behind, uncommitted, diffStat, worktreeMissing };
}

/** Render a status result as the `fleet status` human summary. */
export function buildStatusReport(result: StatusResult, worktreeAbs: string): string {
  const { record, ahead, behind, uncommitted, diffStat, worktreeMissing } = result;
  const out: string[] = [];

  out.push(bold(`Agent ${record.name}`));
  out.push(`  branch:   ${record.branch}`);
  out.push(`  base:     ${record.baseBranch} (${ahead} ahead, ${behind} behind)`);
  out.push(`  worktree: ${worktreeAbs}${worktreeMissing ? ` ${warn('(missing)')}` : ''}`);
  out.push(`  created:  ${record.createdAt}`);
  out.push('');

  if (uncommitted.length > 0) {
    out.push(bold(`Uncommitted changes (${uncommitted.length}):`));
    for (const f of uncommitted) {
      out.push(`  ${warn(f.status.padEnd(2))} ${f.path}`);
    }
  } else if (!worktreeMissing) {
    out.push(ok('Working tree clean.'));
  }
  out.push('');

  if (diffStat) {
    out.push(bold(`Committed changes vs ${record.baseBranch}:`));
    out.push(diffStat);
  } else {
    out.push(dim(`No committed changes vs ${record.baseBranch} yet.`));
  }

  return out.join('\n');
}

export async function status(name: string, options: StatusOptions = {}): Promise<StatusResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const result = await collectStatus(name, { ...options, cwd: repoRoot });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(buildStatusReport(result, worktreeAbsPath(repoRoot, result.record)));
  return result;
}
