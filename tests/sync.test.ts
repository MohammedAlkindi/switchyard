import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { sync, syncAll } from '../src/commands/sync.js';
import { aheadBehind, gitAt } from '../src/lib/git.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
});

describe('fleet sync', () => {
  it('merges new base commits into the agent branch', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(repo.root, 'from-main.txt', 'm\n', 'feat: main moved on');

    const result = await sync('alice', { cwd: repo.root });

    expect(result).toMatchObject({ branch: 'fleet/alice', base: 'main', behind: 1, updated: true });
    // The base commit is now present in the agent's worktree…
    expect(existsSync(path.join(worktreePath(repo.root, 'alice'), 'from-main.txt'))).toBe(true);
    // …and the branch is no longer behind.
    const { behind } = await aheadBehind(gitAt(repo.root), 'main', 'fleet/alice');
    expect(behind).toBe(0);
  });

  it('is a no-op when the agent is already up to date', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await sync('alice', { cwd: repo.root });

    expect(result).toMatchObject({ behind: 0, updated: false });
  });

  it('aborts a conflicting merge and leaves the worktree unconflicted', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'agent version\n', 'feat: agent edit');
    await commitFile(repo.root, 'src.txt', 'main version\n', 'feat: main edit');

    await expect(sync('alice', { cwd: repo.root })).rejects.toThrow(/conflicts in 1 file/);

    const status = await gitAt(worktreePath(repo.root, 'alice')).status();
    expect(status.conflicted).toEqual([]);
    expect(status.files).toEqual([]);
  });

  it('refuses when the worktree has uncommitted changes', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(repo.root, 'from-main.txt', 'm\n', 'feat: main moved on');
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'w\n');

    await expect(sync('alice', { cwd: repo.root })).rejects.toThrow(/uncommitted change/);
  });

  it('errors clearly for an unknown agent', async () => {
    await expect(sync('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });
});

describe('fleet sync --all', () => {
  it('catches every agent up with its base in one sweep', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(repo.root, 'from-main.txt', 'm\n', 'feat: main moved on');

    const result = await syncAll({ cwd: repo.root });

    expect(result.failed).toEqual([]);
    expect(result.synced).toHaveLength(2);
    expect(result.synced.map((s) => s.name)).toEqual(['alice', 'bob']);
    expect(result.synced.every((s) => s.updated)).toBe(true);
    for (const name of ['alice', 'bob']) {
      expect(existsSync(path.join(worktreePath(repo.root, name), 'from-main.txt'))).toBe(true);
    }
  });

  it('continues past a dirty worktree and reports it as failed', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(repo.root, 'from-main.txt', 'm\n', 'feat: main moved on');
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'w\n');

    const result = await syncAll({ cwd: repo.root });

    // alice fails first (sorted order), but the sweep still reaches bob.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: 'alice' });
    expect(result.failed[0]?.error).toMatch(/uncommitted change/);
    expect(result.synced).toHaveLength(1);
    expect(result.synced[0]).toMatchObject({ name: 'bob', updated: true });
    // The failed agent was left exactly as it was: still behind its base.
    const { behind } = await aheadBehind(gitAt(repo.root), 'main', 'fleet/alice');
    expect(behind).toBe(1);
  });

  it('aborts a conflicting merge and still syncs the rest', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'agent version\n', 'feat: agent edit');
    await commitFile(repo.root, 'src.txt', 'main version\n', 'feat: main edit');

    const result = await syncAll({ cwd: repo.root });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('alice');
    expect(result.failed[0]?.error).toMatch(/conflicts in 1 file/);
    expect(result.synced).toHaveLength(1);
    expect(result.synced[0]).toMatchObject({ name: 'bob', updated: true });
    // Same safety contract as single sync: never left mid-merge.
    const status = await gitAt(worktreePath(repo.root, 'alice')).status();
    expect(status.conflicted).toEqual([]);
    expect(status.files).toEqual([]);
  });

  it('returns empty results for an empty fleet', async () => {
    const result = await syncAll({ cwd: repo.root });
    expect(result).toEqual({ synced: [], failed: [] });
  });
});
