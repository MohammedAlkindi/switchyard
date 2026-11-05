import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clean } from '../src/commands/clean.js';
import { spawn } from '../src/commands/spawn.js';
import { branchExists, gitAt } from '../src/lib/git.js';
import { readState } from '../src/lib/state.js';
import { commitFile, commitFileAt, makeTempRepo, worktreePath } from './helpers.js';
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

describe('fleet clean', () => {
  it('removes an agent with no commits of its own (trivially merged)', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await clean({ cwd: repo.root });

    expect(result.cleaned.map((c) => c.name)).toEqual(['alice']);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(false);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
    expect(readState(repo.root).agents).toEqual({});
  });

  it('removes an agent after its branch is merged into base', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');
    await repo.git.merge(['fleet/alice']);

    const result = await clean({ cwd: repo.root });

    expect(result.cleaned.map((c) => c.name)).toEqual(['alice']);
    expect(result.cleaned[0]?.reason).toBe('merged');
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
  });

  it('keeps agents with unmerged commits', async () => {
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'bob'), 'wip.txt', 'w\n', 'feat: unmerged');

    const result = await clean({ cwd: repo.root });

    expect(result.cleaned).toEqual([]);
    expect(result.kept).toEqual([{ name: 'bob', reason: 'has unmerged commits vs main' }]);
    expect(await branchExists(gitAt(repo.root), 'fleet/bob')).toBe(true);
    expect(readState(repo.root).agents['bob']).toBeDefined();
  });

  it('keeps agents with uncommitted changes', async () => {
    await spawn('carol', { cwd: repo.root });
    writeFileSync(path.join(worktreePath(repo.root, 'carol'), 'wip.txt'), 'w\n');

    const result = await clean({ cwd: repo.root });

    expect(result.cleaned).toEqual([]);
    expect(result.kept[0]?.name).toBe('carol');
    expect(result.kept[0]?.reason).toMatch(/uncommitted change/);
    expect(existsSync(worktreePath(repo.root, 'carol'))).toBe(true);
  });

  it('--dry-run lists candidates without removing anything', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await clean({ dryRun: true, cwd: repo.root });

    expect(result.cleaned.map((c) => c.name)).toEqual(['alice']);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });
});

describe('fleet clean --stale', () => {
  /** Commit unmerged work with a 2020 date so the agent reads as long idle. */
  async function commitOld(agent: string): Promise<void> {
    await commitFileAt(
      worktreePath(repo.root, agent),
      'old-work.txt',
      'o\n',
      'feat: long-forgotten work',
      '2020-01-01T00:00:00+00:00',
    );
  }

  it('removes a long-idle unmerged agent but keeps its branch', async () => {
    await spawn('dave', { cwd: repo.root });
    await commitOld('dave');

    const result = await clean({ stale: 30, cwd: repo.root });

    expect(result.cleaned).toEqual([
      { name: 'dave', branch: 'fleet/dave', baseBranch: 'main', reason: 'stale' },
    ]);
    expect(existsSync(worktreePath(repo.root, 'dave'))).toBe(false);
    // The branch survives, so the unmerged work stays recoverable.
    expect(await branchExists(gitAt(repo.root), 'fleet/dave')).toBe(true);
    expect(readState(repo.root).agents['dave']).toBeUndefined();
  });

  it('keeps recently active unmerged agents', async () => {
    await spawn('erin', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'erin'), 'fresh.txt', 'f\n', 'feat: fresh work');

    const result = await clean({ stale: 30, cwd: repo.root });

    expect(result.cleaned).toEqual([]);
    expect(result.kept[0]?.reason).toMatch(/unmerged commits/);
  });

  it('never removes a stale agent with uncommitted changes', async () => {
    await spawn('frank', { cwd: repo.root });
    await commitOld('frank');
    writeFileSync(path.join(worktreePath(repo.root, 'frank'), 'wip.txt'), 'w\n');

    const result = await clean({ stale: 30, cwd: repo.root });

    expect(result.cleaned).toEqual([]);
    expect(result.kept[0]?.reason).toMatch(/uncommitted change/);
    expect(existsSync(worktreePath(repo.root, 'frank'))).toBe(true);
  });

  it('rejects a non-positive --stale value', async () => {
    await expect(clean({ stale: -1, cwd: repo.root })).rejects.toThrow(/Invalid --stale/);
  });
});
