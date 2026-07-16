import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FleetError } from './errors.js';

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
    throw new FleetError(
      `Switchyard state file is corrupted: ${file}\n` +
        'Fix or delete it, then re-run. Your worktrees and branches are not affected; ' +
        'you may need to `fleet spawn` agents again to re-register them.',
    );
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
  return path.resolve(repoRoot, record.worktreePath);
}
