import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diff } from '../src/commands/diff.js';
import { spawn } from '../src/commands/spawn.js';
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

describe('fleet diff', () => {
  it('shows the full committed diff against the recorded base', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'src.txt',
      'line1\nCHANGED\n',
      'feat: change line2',
    );

    const result = await diff('alice', { cwd: repo.root });

    expect(result.base).toBe('main');
    expect(result.branch).toBe('fleet/alice');
    expect(result.patch).toContain('diff --git');
    expect(result.patch).toContain('+CHANGED');
    expect(result.patch).toContain('-line2');
  });

  it('is empty when the agent has not committed anything', async () => {
    await spawn('alice', { cwd: repo.root });
    const result = await diff('alice', { cwd: repo.root });
    expect(result.patch.trim()).toBe('');
  });

  it('supports a --base override', async () => {
    await repo.git.checkoutLocalBranch('other');
    await commitFile(repo.root, 'other.txt', 'o\n', 'feat: other branch file');
    await repo.git.checkout('main');

    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await diff('alice', { base: 'other', cwd: repo.root });
    expect(result.base).toBe('other');
    expect(result.patch).toContain('feature.txt');
  });

  it('errors clearly when the base branch does not exist', async () => {
    await spawn('alice', { cwd: repo.root });
    await expect(diff('alice', { base: 'nope', cwd: repo.root })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('errors clearly for an unknown agent', async () => {
    await expect(diff('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });
});
