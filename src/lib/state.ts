import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { FleetError } from './errors.js';

/**
 * Result of the last `fleet validate` run for an agent, pinned to a commit.
 * Staleness is never stored — readers compare `commit` against the live branch
 * tip (and `command` against the configured one), so the record cannot claim
 * more than "this exact commit got this exact result".
 */
export interface ValidationRecord {
  /** Branch tip the run certifies. */
  commit: string;
  ok: boolean;
  /** ISO 8601 timestamp of the run. */
  at: string;
  /** The command that ran, so changing the configured command invalidates the record. */
  command: string;
}

/** One Switchyard-managed agent: a branch plus the worktree it is checked out in. */
export interface AgentRecord {
  name: string;
  /** Branch the agent works on, always `fleet/<name>`. */
  branch: string;
  /** Branch the agent was spawned from; used as the diff/merge base. */
  baseBranch: string;
  /** Worktree location relative to the repo root, with forward slashes. */
  worktreePath: string;
  /** ISO 8601 timestamp of when the agent was spawned. */
  createdAt: string;
  /** Last `fleet validate` outcome; absent until the agent is first validated. */
  validation?: ValidationRecord;
}

/** Shape of `.fleet/state.json` — the source of truth for all Switchyard commands. */
export interface FleetState {
  version: 1;
  agents: Record<string, AgentRecord>;
}

export function fleetDir(repoRoot: string): string {
  return path.join(repoRoot, '.fleet');
}

export function statePath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), 'state.json');
}

export function worktreesDir(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), 'worktrees');
}

function corruptedState(file: string, detail?: string): FleetError {
  return new FleetError(
    `Switchyard state file is corrupted: ${file}` +
      (detail ? `\n${detail}` : '') +
      '\nRun `fleet doctor --fix` to rebuild it from registered worktrees. ' +
      'Your worktrees and branches are not modified by this refusal.',
  );
}

export function readState(repoRoot: string): FleetState {
  const file = statePath(repoRoot);
  if (!existsSync(file)) {
    return { version: 1, agents: {} };
  }
  // Strip a UTF-8 BOM: Windows editors add one and JSON.parse rejects it.
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as FleetState).agents !== 'object' ||
    (parsed as FleetState).agents === null
  ) {
    throw corruptedState(file);
  }

  for (const [key, value] of Object.entries((parsed as FleetState).agents)) {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as AgentRecord).name !== 'string' ||
      typeof (value as AgentRecord).worktreePath !== 'string' ||
      (value as AgentRecord).name !== key
    ) {
      throw corruptedState(file, `Agent record "${key}" has an invalid name or worktree path.`);
    }
    try {
      worktreeAbsPath(repoRoot, value as AgentRecord);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw corruptedState(file, detail);
    }
  }
  return parsed as FleetState;
}

export function writeState(repoRoot: string, state: FleetState): void {
  mkdirSync(fleetDir(repoRoot), { recursive: true });
  const file = statePath(repoRoot);
  // Write-then-rename so a crash mid-write never leaves a half-written state file.
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmpFile, file);
}

/** Look up an agent by name, with a helpful error listing known agents. */
export function getAgent(state: FleetState, name: string): AgentRecord {
  const record = state.agents[name];
  if (!record) {
    const known = Object.keys(state.agents).sort();
    const hint =
      known.length > 0
        ? `Known agents: ${known.join(', ')}.`
        : 'No agents are registered. Run `fleet spawn <name>` to create one.';
    throw new FleetError(`No agent named "${name}". ${hint}`);
  }
  return record;
}

export function worktreeAbsPath(repoRoot: string, record: AgentRecord): string {
  const managedRoot = path.resolve(worktreesDir(repoRoot));
  const candidate = path.resolve(repoRoot, record.worktreePath);
  const relative = path.relative(managedRoot, candidate);
  const directChild =
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep);

  if (!directChild || relative !== record.name) {
    const expected = path.join('.fleet', 'worktrees', record.name).split(path.sep).join('/');
    throw new FleetError(
      `Unsafe worktree path for agent "${record.name}": "${record.worktreePath}".\n` +
        `Expected "${expected}"; refusing to access a path outside the agent's managed worktree.`,
    );
  }

  // Lexical containment also has to survive filesystem indirection. A symlink
  // or Windows junction at either the managed root or agent directory must not
  // redirect a destructive Git command outside the repository.
  if (existsSync(managedRoot) && existsSync(candidate)) {
    try {
      const repoReal = realpathSync.native(repoRoot);
      const managedReal = realpathSync.native(managedRoot);
      const candidateReal = realpathSync.native(candidate);
      const expectedManagedReal = path.join(repoReal, '.fleet', 'worktrees');
      const expectedCandidateReal = path.join(managedReal, record.name);
      const samePath = (left: string, right: string): boolean =>
        process.platform === 'win32'
          ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
          : path.resolve(left) === path.resolve(right);
      if (
        !samePath(managedReal, expectedManagedReal) ||
        !samePath(candidateReal, expectedCandidateReal)
      ) {
        throw new FleetError(
          `Unsafe worktree path for agent "${record.name}": "${record.worktreePath}" resolves outside .fleet/worktrees.`,
        );
      }
    } catch (err) {
      // A concurrent manual deletion can race this diagnostic. Let the caller
      // handle the now-missing worktree as it did before; every other failure
      // (including the explicit containment error above) is safety-relevant.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  return candidate;
}
