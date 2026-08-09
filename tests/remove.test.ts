import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remove } from '../src/commands/remove.js';
import { spawn } from '../src/commands/spawn.js';
import { branchExists, gitAt } from '../src/lib/git.js';
import { readState, writeState } from '../src/lib/state.js';
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

describe('fleet remove', () => {
  it('removes a clean worktree, keeps the branch, drops the state entry', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await remove('alice', { cwd: repo.root });

    expect(result).toMatchObject({ worktreeRemoved: true, branchDeleted: false });
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(false);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeUndefined();
  });

  it('refuses to remove a dirty worktree without --force', async () => {
    await spawn('alice', { cwd: repo.root });
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'wip\n');

    await expect(remove('alice', { cwd: repo.root })).rejects.toThrow(/uncommitted change/);
    // The refusal must leave everything intact.
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('removes a dirty worktree with --force', async () => {
    await spawn('alice', { cwd: repo.root });
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'wip\n');

    const result = await remove('alice', { force: true, cwd: repo.root });
    expect(result.worktreeRemoved).toBe(true);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(false);
  });

  it('refuses a state record that points at a worktree outside .fleet/worktrees', async () => {
    await spawn('alice', { cwd: repo.root });
    const outside = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-outside`);
    await repo.git.raw(['worktree', 'move', worktreePath(repo.root, 'alice'), outside]);

    const state = readState(repo.root);
    const record = state.agents['alice'];
    if (!record) throw new Error('alice fixture missing from state');
    record.worktreePath = path.relative(repo.root, outside).split(path.sep).join('/');
    writeState(repo.root, state);

    try {
      await expect(remove('alice', { cwd: repo.root })).rejects.toThrow(/worktree path/i);
      expect(existsSync(outside)).toBe(true);
      expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    } finally {
      if (existsSync(outside)) {
        await repo.git.raw(['worktree', 'remove', '--force', outside]);
      }
    }
  });

  it('deletes a merged branch with --delete-branch', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await remove('alice', { deleteBranch: true, cwd: repo.root });

    expect(result.branchDeleted).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
  });

  it('refuses --delete-branch for unmerged work without --force', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'work.txt', 'w\n', 'feat: unmerged work');

    await expect(remove('alice', { deleteBranch: true, cwd: repo.root })).rejects.toThrow(
      /not fully merged/,
    );
    // Refusal happens before anything is touched.
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
  });

  it('deletes an unmerged branch with --delete-branch --force', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'work.txt', 'w\n', 'feat: unmerged work');

    const result = await remove('alice', { deleteBranch: true, force: true, cwd: repo.root });
    expect(result.branchDeleted).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
  });

  it('errors clearly for an unknown agent', async () => {
    await expect(remove('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });
});
