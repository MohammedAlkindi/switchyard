import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { merge } from '../src/commands/merge.js';
import { spawn } from '../src/commands/spawn.js';
import { undo } from '../src/commands/undo.js';
import { branchExists, gitAt, revParseOid } from '../src/lib/git.js';
import { readState, statePath } from '../src/lib/state.js';
import { readUndoRecord, writeUndoRecord } from '../src/lib/undo.js';
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

/** spawn → commit → merge, returning the pre-merge oids for assertions. */
async function mergedAgent(): Promise<{ headBefore: string; branchTip: string }> {
  await spawn('alice', { cwd: repo.root });
  const headBefore = await revParseOid(gitAt(repo.root), 'HEAD');
  await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');
  const branchTip = await revParseOid(gitAt(repo.root), 'fleet/alice');
  await merge('alice', { cwd: repo.root });
  if (!headBefore || !branchTip) throw new Error('fixture oids unresolved');
  return { headBefore, branchTip };
}

describe('fleet undo', () => {
  it('restores branch pointer, agent branch, worktree, and state', async () => {
    const { headBefore, branchTip } = await mergedAgent();

    const result = await undo({ cwd: repo.root });

    expect(result).toEqual({
      agent: 'alice',
      into: 'main',
      restoredBranch: true,
      restoredWorktree: true,
    });
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).toBe(headBefore);
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(false);
    expect(await revParseOid(gitAt(repo.root), 'fleet/alice')).toBe(branchTip);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
    expect(readUndoRecord(repo.root)).toBeNull();
  });

  it('recovers when cleanup fails after the merge has already succeeded', async () => {
    await spawn('alice', { cwd: repo.root });
    const headBefore = await revParseOid(gitAt(repo.root), 'HEAD');
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    // A leftover temp directory makes the atomic state write fail only after
    // Git has merged and cleanup has removed the worktree and branch.
    const blockedStateTemp = `${statePath(repo.root)}.tmp`;
    mkdirSync(blockedStateTemp);

    await expect(merge('alice', { cwd: repo.root })).rejects.toThrow();
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).not.toBe(headBefore);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(false);
    expect(readUndoRecord(repo.root)).not.toBeNull();

    rmSync(blockedStateTemp, { recursive: true });
    const result = await undo({ cwd: repo.root });

    expect(result).toMatchObject({ restoredBranch: true, restoredWorktree: true });
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).toBe(headBefore);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('is single-level: a second undo refuses', async () => {
    await mergedAgent();
    await undo({ cwd: repo.root });
    await expect(undo({ cwd: repo.root })).rejects.toThrow(/Nothing to undo/);
  });

  it('handles --no-clean merges (nothing to restore but the branch pointer)', async () => {
    await spawn('alice', { cwd: repo.root });
    const headBefore = await revParseOid(gitAt(repo.root), 'HEAD');
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');
    await merge('alice', { clean: false, cwd: repo.root });

    const result = await undo({ cwd: repo.root });

    expect(result).toMatchObject({ restoredBranch: false, restoredWorktree: false });
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).toBe(headBefore);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('validates the recorded worktree path before resetting the target branch', async () => {
    await mergedAgent();
    const headAfter = await revParseOid(gitAt(repo.root), 'HEAD');
    const record = readUndoRecord(repo.root);
    if (!headAfter || !record) throw new Error('undo fixture was not recorded');
    record.agent.worktreePath = '.fleet/worktrees-archive/alice';
    writeUndoRecord(repo.root, record);

    await expect(undo({ cwd: repo.root })).rejects.toThrow(/worktree path/i);
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).toBe(headAfter);
    expect(existsSync(path.join(repo.root, '.fleet', 'worktrees-archive', 'alice'))).toBe(false);
  });

  it('validates the recorded agent branch before resetting the target branch', async () => {
    await mergedAgent();
    const headAfter = await revParseOid(gitAt(repo.root), 'HEAD');
    const record = readUndoRecord(repo.root);
    if (!headAfter || !record) throw new Error('undo fixture was not recorded');
    record.agent.branch = 'victim';
    writeUndoRecord(repo.root, record);

    await expect(undo({ cwd: repo.root })).rejects.toThrow(/agent branch/i);
    expect(await revParseOid(gitAt(repo.root), 'HEAD')).toBe(headAfter);
    expect(await branchExists(gitAt(repo.root), 'victim')).toBe(false);
  });

  it('refuses when history moved past the merge', async () => {
    await mergedAgent();
    await commitFile(repo.root, 'after.txt', 'x\n', 'feat: newer work');
    await expect(undo({ cwd: repo.root })).rejects.toThrow(/History moved since the merge/);
  });

  it('refuses on a different branch than the merge target', async () => {
    await mergedAgent();
    await gitAt(repo.root).raw(['checkout', '-b', 'other']);
    await expect(undo({ cwd: repo.root })).rejects.toThrow(/current branch is other/);
  });

  it('refuses with uncommitted tracked changes in the main worktree', async () => {
    await mergedAgent();
    writeFileSync(path.join(repo.root, 'README.md'), '# modified\n');
    await expect(undo({ cwd: repo.root })).rejects.toThrow(/uncommitted change/);
  });

  it('refuses cleanly when there is nothing to undo', async () => {
    await expect(undo({ cwd: repo.root })).rejects.toThrow(/Nothing to undo/);
  });
});
