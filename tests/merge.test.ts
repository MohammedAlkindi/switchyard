import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { merge } from '../src/commands/merge.js';
import { spawn } from '../src/commands/spawn.js';
import { branchExists, gitAt } from '../src/lib/git.js';
import { readState } from '../src/lib/state.js';
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

function readNormalized(file: string): string {
  return readFileSync(path.join(repo.root, file), 'utf8').replace(/\r\n/g, '\n');
}

describe('fleet merge', () => {
  it('merges into the current branch and cleans up the agent', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await merge('alice', { cwd: repo.root });

    expect(result).toMatchObject({
      branch: 'fleet/alice',
      into: 'main',
      cleaned: true,
      branchDeleted: true,
    });
    // The work landed on main…
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(true);
    // …and the agent is fully gone: worktree, branch, state entry.
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(false);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(false);
    expect(readState(repo.root).agents).toEqual({});
  });

  it('keeps everything with --no-clean', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await merge('alice', { clean: false, cwd: repo.root });

    expect(result).toMatchObject({ cleaned: false, branchDeleted: false });
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(true);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('refuses when another active agent touches the same file', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: alice edit');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: bob edit');

    await expect(merge('alice', { cwd: repo.root })).rejects.toThrow(/Refusing to merge/);

    // Nothing happened: main unchanged, both agents intact. (Normalize line
    // endings: git may rewrite the file with CRLF on Windows checkouts.)
    expect(readNormalized('src.txt')).toBe('line1\nline2\n');
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
    expect(readState(repo.root).agents['bob']).toBeDefined();
  });

  it('merges when the shared file merges cleanly (verdict-based gate)', async () => {
    const EIGHT_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
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

    // v0.1 refused this; with verdicts the committed sides provably auto-merge.
    const result = await merge('alice', { cwd: repo.root });
    expect(result.cleaned).toBe(true);
    expect(readState(repo.root).agents['bob']).toBeDefined();
  });

  it('still refuses when the other agent has uncommitted edits to the shared file', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: a');
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'src.txt'), 'bob uncommitted\n');

    await expect(merge('alice', { cwd: repo.root })).rejects.toThrow(/Refusing to merge/);
  });

  it('aborts a conflicting merge and leaves the repo unconflicted', async () => {
    await spawn('alice', { cwd: repo.root });
    // Both sides change the same line: guaranteed conflict, no collision
    // (main is not an agent, so the check gate does not block it).
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'agent version\n', 'feat: agent edit');
    await commitFile(repo.root, 'src.txt', 'main version\n', 'feat: main edit');

    await expect(merge('alice', { cwd: repo.root })).rejects.toThrow(/conflicts in 1 file/);

    // The merge was aborted: no conflict markers, main's content restored,
    // agent untouched, nothing half-merged.
    const status = await gitAt(repo.root).status();
    expect(status.conflicted).toEqual([]);
    expect(readNormalized('src.txt')).toBe('main version\n');
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('keeps a dirty worktree after a successful merge instead of discarding work', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'uncommitted\n');

    const result = await merge('alice', { cwd: repo.root });

    // Merge succeeded but cleanup was skipped to protect the uncommitted file.
    expect(result).toMatchObject({ cleaned: false, branchDeleted: false });
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(true);
    expect(existsSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'))).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('sweeps other merged agents afterwards when autoClean is set', async () => {
    writeFileSync(path.join(repo.root, '.fleetrc.json'), '{ "autoClean": true }');
    await spawn('alice', { cwd: repo.root });
    await spawn('idle', { cwd: repo.root }); // no commits: trivially merged
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await merge('alice', { cwd: repo.root });

    expect(result.autoCleaned).toEqual(['idle']);
    expect(readState(repo.root).agents).toEqual({});
  });

  it('errors clearly for an unknown agent', async () => {
    await expect(merge('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });

  it('a failing preMerge hook aborts before the merge starts', async () => {
    const script = path.join(repo.root, 'failing-hook.cjs');
    writeFileSync(script, 'process.exit(1);\n');
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      JSON.stringify({ preMerge: `node ${script}` }),
    );
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    await expect(merge('alice', { cwd: repo.root })).rejects.toThrow(
      /preMerge hook failed \(exit 1\)/,
    );

    // Nothing was merged and the agent is intact.
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(false);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });

  it('a passing preMerge hook runs in the worktree and the merge proceeds', async () => {
    const marker = path.join(repo.root, 'hook-ran.txt');
    const script = path.join(repo.root, 'passing-hook.cjs');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok');\n`);
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      JSON.stringify({ preMerge: `node ${script}` }),
    );
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await merge('alice', { cwd: repo.root });

    expect(existsSync(marker)).toBe(true);
    expect(result.cleaned).toBe(true);
    expect(existsSync(path.join(repo.root, 'feature.txt'))).toBe(true);
  });
});
