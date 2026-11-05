import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { gitAt, supportsMergeTree } from '../src/lib/git.js';
import { predictMergeConflicts } from '../src/lib/mergetree.js';
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

const EIGHT_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';

describe('predictMergeConflicts', () => {
  it('pins down: conflicted merge-tree exits 1 without throwing, and reports the file', async () => {
    // This is the simple-git exit-code quirk test from the spec: exit 1 with
    // empty stderr must come back as parseable stdout, not an exception.
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice version\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob version\n', 'feat: b');

    const result = await predictMergeConflicts(gitAt(repo.root), 'fleet/alice', 'fleet/bob');
    expect(result.conflictedFiles).toEqual(['src.txt']);
  });

  it('reports no conflicts for disjoint committed edits to one file', async () => {
    await commitFile(repo.root, 'many.txt', EIGHT_LINES, 'chore: seed');
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'many.txt',
      EIGHT_LINES.replace('l1\n', 'l1 alice\n'),
      'feat: top',
    );
    await commitFile(
      worktreePath(repo.root, 'bob'),
      'many.txt',
      EIGHT_LINES.replace('l8\n', 'l8 bob\n'),
      'feat: bottom',
    );

    const result = await predictMergeConflicts(gitAt(repo.root), 'fleet/alice', 'fleet/bob');
    expect(result.conflictedFiles).toEqual([]);
  });

  it('reports no conflicts for edits to different files', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'a.txt', 'a\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'b.txt', 'b\n', 'feat: b');

    const result = await predictMergeConflicts(gitAt(repo.root), 'fleet/alice', 'fleet/bob');
    expect(result.conflictedFiles).toEqual([]);
  });

  it('local git supports merge-tree (a CI canary, not a user requirement)', async () => {
    // The suite's simulation tests are only meaningful on git >= 2.38. All CI
    // images ship newer git; if this ever fails, upgrade git on the runner.
    expect(await supportsMergeTree(gitAt(repo.root))).toBe(true);
  });
});
