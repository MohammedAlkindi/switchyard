import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from '../lib/config.js';
import { FleetError } from '../lib/errors.js';
import { bold, dim, ok, warn } from '../lib/format.js';
import { runShell } from '../lib/proc.js';
import {
  addWorktree,
  branchExists,
  currentBranch,
  ensureFleetExcluded,
  getMainRepoRoot,
  gitAt,
  verifyBranch,
} from '../lib/git.js';
import { readState, worktreesDir, writeState } from '../lib/state.js';
import type { AgentRecord } from '../lib/state.js';

export interface SpawnOptions {
  /** Base branch to spawn from. Defaults to the current branch. */
  from?: string;
  cwd?: string;
}

export interface SpawnResult {
  record: AgentRecord;
  /** Absolute path of the new worktree. */
  worktreePath: string;
  /** `copyOnSpawn` entries actually copied into the worktree. */
  copied: string[];
  /** Exit code of the `postSpawn` hook; undefined when none is configured. */
  postSpawnExitCode?: number;
}

// Names become branch names and directory names, so keep them filesystem- and
// ref-safe: no slashes, no leading dots, no whitespace.
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// Windows refuses these as file names (even with an extension), which would
// break the worktree directory. Rejected on every platform so a fleet set up
// on macOS/Linux stays usable from Windows checkouts of the same repo.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function validateAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new FleetError(
      `Invalid agent name "${name}". Use letters, digits, ".", "_" or "-" ` +
        '(max 64 chars, starting with a letter or digit).',
    );
  }
  // git check-ref-format rules the character set alone doesn't catch: catching
  // them here gives a clean error instead of a raw `git worktree add` failure.
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) {
    throw new FleetError(
      `Invalid agent name "${name}". It must form a valid branch name: ` +
        'no "..", and no trailing "." or ".lock".',
    );
  }
  if (WINDOWS_RESERVED_RE.test(name)) {
    throw new FleetError(
      `Invalid agent name "${name}". It is a reserved device name on Windows ` +
        '(CON, PRN, AUX, NUL, COM1-9, LPT1-9) and cannot be a worktree directory.',
    );
  }
}

export async function spawn(name: string, options: SpawnOptions = {}): Promise<SpawnResult> {
  validateAgentName(name);

  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  const git = gitAt(repoRoot);
  const state = readState(repoRoot);
  const branch = `fleet/${name}`;

  const existing = state.agents[name];
  if (existing) {
    throw new FleetError(
      `Agent "${name}" already exists (branch ${existing.branch}, worktree ${existing.worktreePath}).\n` +
        `Pick a different name, or remove it first with \`fleet remove ${name}\`.`,
    );
  }
  if (await branchExists(git, branch)) {
    throw new FleetError(
      `Branch "${branch}" already exists but is not tracked by Switchyard.\n` +
        `Delete it (\`git branch -d ${branch}\`) or pick a different agent name.`,
    );
  }
  const worktreeAbs = path.join(worktreesDir(repoRoot), name);
  if (existsSync(worktreeAbs)) {
    throw new FleetError(
      `Worktree directory already exists: ${worktreeAbs}\n` +
        'Remove it or pick a different agent name.',
    );
  }

  const config = readConfig(repoRoot);
  // Precedence: --from flag > .fleetrc.json defaultBase > current branch.
  let base = options.from ?? config.defaultBase;
  if (base) {
    await verifyBranch(git, base, 'Base');
  } else {
    base = (await currentBranch(git)) ?? undefined;
    if (!base) {
      throw new FleetError(
        'HEAD is detached, so there is no branch to base the agent on. ' +
          'Pass one explicitly with --from <branch>.',
      );
    }
  }

  await ensureFleetExcluded(repoRoot);
  mkdirSync(worktreesDir(repoRoot), { recursive: true });
  await addWorktree(git, worktreeAbs, branch, base);

  const record: AgentRecord = {
    name,
    branch,
    baseBranch: base,
    worktreePath: path.relative(repoRoot, worktreeAbs).split(path.sep).join('/'),
    createdAt: new Date().toISOString(),
  };
  state.agents[name] = record;
  writeState(repoRoot, state);

  console.log(ok(`Spawned agent ${bold(name)}`));
  console.log(`  branch:   ${branch} ${dim(`(from ${base})`)}`);
  console.log(`  worktree: ${worktreeAbs}`);

  // Provision the worktree: gitignored essentials first, then the hook, so
  // e.g. `postSpawn: "npm ci"` can rely on a copied .npmrc or .env.
  const copied: string[] = [];
  for (const entry of config.copyOnSpawn ?? []) {
    const source = path.join(repoRoot, entry);
    if (!existsSync(source)) {
      console.log(dim(`  copyOnSpawn: ${entry} not found in the repo root — skipped`));
      continue;
    }
    cpSync(source, path.join(worktreeAbs, entry), { recursive: true });
    copied.push(entry);
    console.log(`  copied:   ${entry}`);
  }

  let postSpawnExitCode: number | undefined;
  if (config.postSpawn) {
    console.log(dim(`  postSpawn: ${config.postSpawn}`));
    postSpawnExitCode = await runShell(config.postSpawn, worktreeAbs);
    if (postSpawnExitCode !== 0) {
      console.log(
        warn(`  postSpawn hook failed (exit ${postSpawnExitCode}) — the worktree was kept; finish setting it up manually.`),
      );
    }
  }

  console.log('');
  console.log('Point your agent at it:');
  console.log(`  cd ${worktreeAbs}`);

  return { record, worktreePath: worktreeAbs, copied, postSpawnExitCode };
}
