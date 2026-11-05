import { existsSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { dim, fail, warn } from '../lib/format.js';
import { getMainRepoRoot } from '../lib/git.js';
import { runShell, shellJoin } from '../lib/proc.js';
import { getAgent, readState, worktreeAbsPath } from '../lib/state.js';
import type { AgentRecord } from '../lib/state.js';

export interface ExecOptions {
  /** Run the command in every agent's worktree instead of one. */
  all?: boolean;
  cwd?: string;
}

export interface ExecOutcome {
  name: string;
  /** null when the agent was skipped (worktree missing under --all). */
  exitCode: number | null;
  skipped?: 'worktree-missing';
}

export interface ExecResult {
  command: string;
  outcomes: ExecOutcome[];
  /** True when every targeted agent ran the command and exited 0. */
  ok: boolean;
}

/**
 * Run a shell command inside an agent's worktree (or every worktree with
 * --all) without cd'ing there — `fleet exec claude -- npm test`. Under --all
 * the runs are sequential so their output doesn't interleave.
 */
export async function exec(
  agentName: string | undefined,
  cmdTokens: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const state = readState(repoRoot);

  if (cmdTokens.length === 0) {
    throw new FleetError('No command given. Usage: fleet exec <agent> -- <command...>');
  }
  let targets: AgentRecord[];
  if (options.all) {
    targets = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  } else {
    if (!agentName) {
      throw new FleetError('Pass an agent name (or --all to run in every worktree).');
    }
    targets = [getAgent(state, agentName)];
  }

  const command = shellJoin(cmdTokens);
  if (targets.length === 0) {
    console.log('No active agents. Run `fleet spawn <name>` to create one.');
    return { command, outcomes: [], ok: true };
  }

  const outcomes: ExecOutcome[] = [];
  for (const record of targets) {
    const abs = worktreeAbsPath(repoRoot, record);
    if (!existsSync(abs)) {
      if (!options.all) {
        throw new FleetError(
          `Agent "${record.name}" has no worktree on disk (${abs}).\n` +
            'Run `fleet doctor --fix` to reconcile state, or `fleet remove` the agent.',
        );
      }
      console.log(warn(`[${record.name}] skipped: worktree missing`));
      outcomes.push({ name: record.name, exitCode: null, skipped: 'worktree-missing' });
      continue;
    }
    console.log(dim(`[${record.name}] $ ${command}`));
    const exitCode = await runShell(command, abs);
    outcomes.push({ name: record.name, exitCode });
    if (exitCode !== 0) {
      console.log(fail(`[${record.name}] exited ${exitCode}`));
    }
  }

  return { command, outcomes, ok: outcomes.every((o) => o.exitCode === 0) };
}
