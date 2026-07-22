import { existsSync } from 'node:fs';
import { CONFIG_FILE, readConfig } from '../lib/config.js';
import { FleetError } from '../lib/errors.js';
import { dim, fail, ok, plural } from '../lib/format.js';
import { getMainRepoRoot, gitAt, revParseOid, uncommittedFiles, verifyBranch } from '../lib/git.js';
import { withLock } from '../lib/lock.js';
import { runShell } from '../lib/proc.js';
import { getAgent, readState, worktreeAbsPath, writeState } from '../lib/state.js';

export interface ValidateOptions {
  json?: boolean;
  cwd?: string;
}

/** Outcome of running the configured validation command for one agent. */
export interface ValidateResult {
  name: string;
  branch: string;
  /** Branch tip the run certifies (resolved after the command, in case it committed). */
  commit: string;
  ok: boolean;
  exitCode: number;
  command: string;
}

export interface ValidateFailure {
  name: string;
  /** The FleetError message the single-agent command would have thrown. */
  error: string;
}

export interface ValidateAllResult {
  validated: ValidateResult[];
  failed: ValidateFailure[];
}

/**
 * Run the configured `validate` command inside an agent's worktree and record
 * the outcome on the agent's state entry, pinned to the branch tip. The record
 * is what `fleet list` displays and what `fleet merge` trusts — a tip that
 * already passed is not re-run at merge time — so it is only ever written for
 * a clean worktree: a dirty tree would certify content the commit doesn't have.
 *
 * A failing command is a result (recorded, reported, exit 1 at the CLI), not
 * an exception; only infrastructure problems throw.
 */
export async function validate(
  name: string,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'validate', async () => {
    const result = await validateLocked(name, options, repoRoot);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

async function validateLocked(
  name: string,
  options: ValidateOptions,
  repoRoot: string,
): Promise<ValidateResult> {
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const record = getAgent(state, name);
  const command = readConfig(repoRoot).validate;
  if (!command) {
    throw new FleetError(
      `No "validate" command configured. Add e.g. {"validate": "npm test"} to ${CONFIG_FILE}.`,
    );
  }
  await verifyBranch(git, record.branch, 'Agent');

  const abs = worktreeAbsPath(repoRoot, record);
  if (!existsSync(abs)) {
    throw new FleetError(
      `Agent "${name}" has no worktree on disk (${abs}).\n` +
        'Run `fleet doctor --fix` to reconcile state, or `fleet remove` the agent.',
    );
  }
  const dirty = await uncommittedFiles(abs);
  if (dirty.length > 0) {
    throw new FleetError(
      `Agent "${name}" has ${plural(dirty.length, 'uncommitted change')} in ${abs}.\n` +
        'A validation record certifies a commit; commit the work first, then re-run.',
    );
  }

  if (!options.json) console.log(dim(`validate ${name}: ${command}`));
  const exitCode = await runShell(command, abs);
  // Resolve the tip after the run: a validate command that commits (e.g. a
  // formatter with autofix) must be recorded against what it left behind.
  const commit = await revParseOid(git, record.branch);
  if (!commit) {
    throw new FleetError(`Could not resolve the tip of ${record.branch}; nothing was recorded.`);
  }

  const passed = exitCode === 0;
  record.validation = { commit, ok: passed, at: new Date().toISOString(), command };
  writeState(repoRoot, state);

  if (!options.json) {
    const short = commit.slice(0, 7);
    console.log(
      passed
        ? ok(`✓ ${name} passed at ${short}`)
        : fail(`✗ ${name} failed (exit ${exitCode}) at ${short}`),
    );
  }
  return { name, branch: record.branch, commit, ok: passed, exitCode, command };
}

/**
 * Validate every registered agent in one sweep. Per-agent infrastructure
 * failures — dirty worktree, missing worktree or branch — are collected so the
 * sweep reaches everyone, mirroring `fleet sync --all`; command failures land
 * in `validated` with `ok: false` like the single-agent run.
 */
export async function validateAll(options: ValidateOptions = {}): Promise<ValidateAllResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'validate', async () => {
    if (!readConfig(repoRoot).validate) {
      throw new FleetError(
        `No "validate" command configured. Add e.g. {"validate": "npm test"} to ${CONFIG_FILE}.`,
      );
    }
    const names = Object.keys(readState(repoRoot).agents).sort();
    const result: ValidateAllResult = { validated: [], failed: [] };
    if (names.length === 0) {
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log('No agents registered. Run `fleet spawn <name>` to create one.');
      return result;
    }

    for (const name of names) {
      try {
        result.validated.push(await validateLocked(name, options, repoRoot));
      } catch (err) {
        if (!(err instanceof FleetError)) throw err;
        result.failed.push({ name, error: err.message });
        if (!options.json) console.error(fail(`✗ ${name}: ${err.message}`));
      }
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const green = result.validated.filter((v) => v.ok).length;
      const red = result.validated.length - green;
      const summary =
        `${plural(result.validated.length, 'agent')} validated (${green} passed, ${red} failed)` +
        (result.failed.length > 0 ? `, ${plural(result.failed.length, 'agent')} skipped` : '');
      console.log('');
      console.log(red === 0 && result.failed.length === 0 ? ok(summary) : fail(summary));
    }
    return result;
  });
}
