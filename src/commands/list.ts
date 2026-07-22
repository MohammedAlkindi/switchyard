import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from '../lib/config.js';
import { dim, fail, ok, relativeTime, table, warn } from '../lib/format.js';
import {
  aheadBehind,
  branchExists,
  getMainRepoRoot,
  gitAt,
  lastCommitISO,
  revParseOid,
  uncommittedFiles,
} from '../lib/git.js';
import { readState, worktreeAbsPath } from '../lib/state.js';
import type { AgentRecord } from '../lib/state.js';

export interface ListOptions {
  /** Print machine-readable JSON instead of the table. */
  json?: boolean;
  cwd?: string;
}

export interface AgentListing {
  name: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  worktreeMissing: boolean;
  /** null when the branch or base no longer exists. */
  ahead: number | null;
  behind: number | null;
  uncommitted: number;
  /** ISO timestamp: newest of last commit and uncommitted-file mtimes. */
  lastActivity: string | null;
  /**
   * The recorded `fleet validate` outcome relative to the current tip:
   * `passed`/`failed` when the record matches the tip and the configured
   * command, `stale` when either moved on, `none` when never validated.
   */
  validation: 'passed' | 'failed' | 'stale' | 'none';
  /** ISO timestamp of the last validation run, if any. */
  validatedAt: string | null;
}

/** Gather the per-agent data `fleet list` displays, without printing anything. */
export async function collectListings(options: ListOptions = {}): Promise<AgentListing[]> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const state = readState(repoRoot);
  const validateCommand = readConfig(repoRoot).validate;
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));

  // Each agent needs several independent, read-only git calls; running the
  // agents concurrently keeps `fleet list` (and every `fleet watch` frame)
  // fast as the fleet grows. Output order mirrors the sorted agents.
  return Promise.all(agents.map((record) => describeAgent(repoRoot, record, validateCommand)));
}

/** Render listings as the `fleet list` table. Shared with `fleet watch`. */
export function buildListTable(listings: AgentListing[]): string {
  const rows = listings.map((l) => [
    l.name,
    l.branch,
    l.baseBranch,
    l.ahead === null ? '?' : `+${l.ahead}/-${l.behind}`,
    l.worktreeMissing
      ? warn('worktree missing')
      : l.uncommitted === 0
        ? dim('clean')
        : warn(`${l.uncommitted} uncommitted`),
    l.validation === 'passed'
      ? ok('passed')
      : l.validation === 'failed'
        ? fail('failed')
        : l.validation === 'stale'
          ? warn('stale')
          : dim('—'),
    relativeTime(l.lastActivity),
    l.worktreePath,
  ]);
  return table(
    ['AGENT', 'BRANCH', 'BASE', '+/-', 'CHANGES', 'VALIDATED', 'LAST ACTIVITY', 'WORKTREE'],
    rows,
  );
}

export async function list(options: ListOptions = {}): Promise<AgentListing[]> {
  const listings = await collectListings(options);

  if (options.json) {
    console.log(JSON.stringify(listings, null, 2));
    return listings;
  }

  if (listings.length === 0) {
    console.log('No active agents. Run `fleet spawn <name>` to create one.');
    return [];
  }

  console.log(buildListTable(listings));
  return listings;
}

async function describeAgent(
  repoRoot: string,
  record: AgentRecord,
  validateCommand: string | undefined,
): Promise<AgentListing> {
  const git = gitAt(repoRoot);
  const abs = worktreeAbsPath(repoRoot, record);
  const worktreeMissing = !existsSync(abs);

  const branchOk = await branchExists(git, record.branch);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (branchOk && (await branchExists(git, record.baseBranch))) {
    ({ ahead, behind } = await aheadBehind(git, record.baseBranch, record.branch));
  }

  // A validation record only counts at the exact commit it certified, for the
  // command currently configured; anything else — tip moved, command changed,
  // branch gone — reads as stale rather than borrowed confidence.
  let validation: AgentListing['validation'] = 'none';
  let validatedAt: string | null = null;
  if (record.validation) {
    validatedAt = record.validation.at;
    const tip = branchOk ? await revParseOid(git, record.branch) : null;
    const commandChanged =
      validateCommand !== undefined && record.validation.command !== validateCommand;
    validation =
      tip === null || record.validation.commit !== tip || commandChanged
        ? 'stale'
        : record.validation.ok
          ? 'passed'
          : 'failed';
  }

  let uncommitted = 0;
  let lastActivity = await lastCommitISO(git, record.branch);
  if (!worktreeMissing) {
    const files = await uncommittedFiles(abs);
    uncommitted = files.length;
    // Uncommitted edits postdate the last commit; use the newest file mtime.
    let newest = lastActivity ? new Date(lastActivity).getTime() : 0;
    for (const f of files) {
      try {
        const mtime = statSync(path.join(abs, f.path)).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Deleted or renamed while we looked — skip it.
      }
    }
    if (newest > 0) lastActivity = new Date(newest).toISOString();
  }

  return {
    name: record.name,
    branch: record.branch,
    baseBranch: record.baseBranch,
    worktreePath: record.worktreePath,
    worktreeMissing,
    ahead,
    behind,
    uncommitted,
    lastActivity,
    validation,
    validatedAt,
  };
}
