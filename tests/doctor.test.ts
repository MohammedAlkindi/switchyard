import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctor } from '../src/commands/doctor.js';
import { merge } from '../src/commands/merge.js';
import { spawn } from '../src/commands/spawn.js';
import { branchExists, gitAt } from '../src/lib/git.js';
import { lockPath } from '../src/lib/lock.js';
import { readState, statePath, writeState } from '../src/lib/state.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
});

function checkByName(result: Awaited<ReturnType<typeof doctor>>, name: string) {
  const check = result.checks.find((c) => c.name === name);
  expect(check, `expected a "${name}" check`).toBeDefined();
  return check!;
}

describe('fleet doctor', () => {
  it('reports all healthy for a well-formed setup', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await doctor({ cwd: repo.root });

    expect(result.healthy).toBe(true);
    for (const check of result.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it('--json prints checks and health as parseable JSON', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await doctor({ json: true, cwd: repo.root });

    const printed = JSON.parse(
      vi.mocked(console.log).mock.calls.at(-1)?.[0] as string,
    ) as { checks: unknown; healthy: boolean };
    expect(printed).toEqual({ checks: result.checks, healthy: true });
  });

  it('detects a corrupted state file and rebuilds it with --fix', async () => {
    await spawn('alice', { cwd: repo.root });
    writeFileSync(statePath(repo.root), 'not json {{{');

    const broken = await doctor({ cwd: repo.root });
    expect(broken.healthy).toBe(false);
    expect(checkByName(broken, 'state-file').ok).toBe(false);

    const fixed = await doctor({ fix: true, cwd: repo.root });
    expect(checkByName(fixed, 'state-file').fixed).toBe(true);
    expect(fixed.healthy).toBe(true);

    // Rebuilt from `git worktree list`: the live agent was re-adopted.
    const state = readState(repo.root);
    expect(state.agents['alice']).toMatchObject({
      name: 'alice',
      branch: 'fleet/alice',
      worktreePath: '.fleet/worktrees/alice',
    });
  });

  it('detects an orphaned worktree and adopts it with --fix', async () => {
    await spawn('alice', { cwd: repo.root });
    // Drop the entry but leave the worktree: an orphan.
    writeState(repo.root, { version: 1, agents: {} });

    const broken = await doctor({ cwd: repo.root });
    expect(broken.healthy).toBe(false);
    expect(checkByName(broken, 'orphaned-worktrees').detail).toContain('alice');

    const fixed = await doctor({ fix: true, cwd: repo.root });
    expect(checkByName(fixed, 'orphaned-worktrees').fixed).toBe(true);
    expect(fixed.healthy).toBe(true);
    expect(readState(repo.root).agents['alice']?.branch).toBe('fleet/alice');
  });

  it('removes a non-worktree leftover directory with --fix', async () => {
    await spawn('alice', { cwd: repo.root });
    const junk = path.join(path.dirname(worktreePath(repo.root, 'alice')), 'junk');
    mkdirSync(junk, { recursive: true });
    writeFileSync(path.join(junk, 'leftover.txt'), 'x\n');

    const broken = await doctor({ cwd: repo.root });
    expect(checkByName(broken, 'orphaned-worktrees').ok).toBe(false);

    const fixed = await doctor({ fix: true, cwd: repo.root });
    expect(fixed.healthy).toBe(true);
    expect(existsSync(junk)).toBe(false);
    // The healthy agent was untouched.
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('detects a stale state entry and prunes it with --fix, keeping the branch', async () => {
    await spawn('alice', { cwd: repo.root });
    rmSync(worktreePath(repo.root, 'alice'), { recursive: true, force: true });

    const broken = await doctor({ cwd: repo.root });
    expect(broken.healthy).toBe(false);
    expect(checkByName(broken, 'stale-entries').detail).toContain('alice');

    const fixed = await doctor({ fix: true, cwd: repo.root });
    expect(checkByName(fixed, 'stale-entries').fixed).toBe(true);
    expect(fixed.healthy).toBe(true);
    expect(readState(repo.root).agents).toEqual({});
    // Pruning state never deletes branches.
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
  });
});

describe('mutation lock check', () => {
  function writeLock(pid: number): void {
    mkdirSync(path.join(repo.root, '.fleet'), { recursive: true });
    writeFileSync(
      lockPath(repo.root),
      JSON.stringify({ pid, command: 'spawn', startedAt: new Date().toISOString() }),
      'utf8',
    );
  }

  /** PID that existed and is now certainly dead: a `node -e ""` that already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) throw new Error('could not spawn a probe process');
    return child.pid;
  }

  it('reports a live lock as healthy information', async () => {
    writeLock(process.pid);
    const result = await doctor({ cwd: repo.root });
    const check = result.checks.find((c) => c.name === 'lock');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/held by live pid/);
  });

  it('flags a stale lock and --fix removes it', async () => {
    writeLock(deadPid());
    const before = await doctor({ cwd: repo.root });
    expect(before.checks.find((c) => c.name === 'lock')?.ok).toBe(false);
    expect(before.healthy).toBe(false);

    writeLock(deadPid()); // doctor without --fix must not have removed it
    const fixed = await doctor({ fix: true, cwd: repo.root });
    const check = fixed.checks.find((c) => c.name === 'lock');
    expect(check?.ok).toBe(true); // withLock's takeover already cleaned it
    expect(existsSync(lockPath(repo.root))).toBe(false);
  });

  it('reports no lock when none is held', async () => {
    const result = await doctor({ cwd: repo.root });
    expect(result.checks.find((c) => c.name === 'lock')?.detail).toBe('no mutation lock held');
  });
});

describe('conflict prediction capability', () => {
  it('reports conflict-prediction capability as information', async () => {
    const result = await doctor({ cwd: repo.root });
    const check = result.checks.find((c) => c.name === 'conflict-prediction');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/available|unavailable/);
  });
});

describe('undo record check', () => {
  it('reports no pending undo on a fresh repo', async () => {
    const result = await doctor({ cwd: repo.root });
    expect(result.checks.find((c) => c.name === 'undo-record')?.detail).toBe(
      'no pending undo record',
    );
  });

  it('reports an available undo after a merge', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');
    await merge('alice', { cwd: repo.root });

    const result = await doctor({ cwd: repo.root });
    const check = result.checks.find((c) => c.name === 'undo-record');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/fleet undo available: merge of fleet\/alice into main/);
  });
});
